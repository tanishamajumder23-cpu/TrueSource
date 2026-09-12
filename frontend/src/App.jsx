import { useCallback, useState } from 'react';
import { InputPanel } from './components/InputPanel';
import { VerdictCard } from './components/VerdictCard';
import { HistoryView } from './components/HistoryView';
import {
  EmptyState,
  ErrorState,
  NoClaimsState,
  SkeletonCard,
  StatusTicker,
  SummaryStrip,
} from './components/States';
import { ChevronDownIcon, HistoryIcon, MoonIcon, ShieldCheckIcon, SunIcon } from './components/Icons';
import { useAnalysis } from './hooks/useAnalysis';
import { useTheme } from './hooks/useTheme';

/**
 * TruthSource — application shell.
 *
 * Two views (Check / History), four input modes, one streaming result feed.
 * All analysis state lives in the useAnalysis hook; this component is layout
 * and wiring only.
 */
export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [view, setView] = useState('check');
  const [mode, setMode] = useState('text');

  // Each input mode keeps its own value, so switching tabs never loses work.
  const [values, setValues] = useState({ text: '', url: '', imageFile: null, videoFile: null });

  const analysis = useAnalysis();
  const { status, results, claims, summary, isRunning } = analysis;

  const updateValue = useCallback((key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    switch (mode) {
      case 'text':
        analysis.runText(values.text.trim());
        break;
      case 'url':
        analysis.runText(values.url.trim());
        break;
      case 'image':
        if (values.imageFile) analysis.runImage(values.imageFile);
        break;
      case 'video':
        if (values.videoFile) analysis.runVideo(values.videoFile);
        break;
      default:
        break;
    }
  }, [analysis, mode, values]);

  /** Clicking an example fills the textarea and runs it immediately. */
  const handleExample = useCallback(
    (example) => {
      setMode('text');
      updateValue('text', example);
      analysis.runText(example);
    },
    [analysis, updateValue],
  );

  // While claims are known but their verdicts are still streaming, show one
  // skeleton per outstanding claim. The user can see exactly how much is left.
  const pendingCount = Math.max(0, claims.length - results.length);
  const showEmptyState = status === 'idle' && results.length === 0;
  const showNoClaims = status === 'done' && claims.length === 0 && !analysis.error;

  return (
    <div className="app">
      <div className="app__glow" aria-hidden="true" />

      {/* ---------------------------------------------------------------- */}
      <header className="header">
        <div className="container header__inner">
          <div className="brand">
            <span className="brand__mark">
              <ShieldCheckIcon width={16} height={16} color="#fff" style={{ color: '#fff' }} />
            </span>
            TruthSource
          </div>

          <div className="header__actions">
            <div className="segmented" role="tablist" aria-label="View">
              <button
                type="button"
                role="tab"
                className="segmented__item"
                aria-selected={view === 'check'}
                onClick={() => setView('check')}
              >
                Check
              </button>
              <button
                type="button"
                role="tab"
                className="segmented__item"
                aria-selected={view === 'history'}
                onClick={() => setView('history')}
              >
                <HistoryIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                History
              </button>
            </div>

            <button
              type="button"
              className="icon-button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      <main className="container">
        {view === 'check' ? (
          <>
            <section className="hero">
              <span className="hero__eyebrow">
                <span className="hero__eyebrow-dot" />
                Grounded in live web evidence
              </span>
              <h1 className="hero__title">
                Fact-check <em>anything</em>.
              </h1>
              <p className="hero__tagline">
                Text, links, screenshots or video — TruthSource splits it into individual claims, retrieves real
                evidence from the web, and shows you the verdict behind every one.
              </p>
            </section>

            <InputPanel
              mode={mode}
              onModeChange={setMode}
              values={values}
              onChange={updateValue}
              onSubmit={handleSubmit}
              onCancel={analysis.cancel}
              isRunning={isRunning}
              uploadProgress={analysis.uploadProgress}
            />

            <StatusTicker message={analysis.statusMessage} />

            {/* What we read out of a screenshot, shown for transparency. */}
            {analysis.extractedText && (
              <details className="disclosure" style={{ marginTop: 'var(--space-5)' }}>
                <summary className="disclosure__summary">
                  Text read from your image
                  <ChevronDownIcon className="disclosure__chevron" />
                </summary>
                <div className="disclosure__content">{analysis.extractedText}</div>
              </details>
            )}

            {/* Live transcript, growing chunk by chunk as the video is processed. */}
            {analysis.transcript.length > 0 && (
              <details className="disclosure" style={{ marginTop: 'var(--space-5)' }} open>
                <summary className="disclosure__summary">
                  Transcript · {analysis.transcript.length} segment
                  {analysis.transcript.length === 1 ? '' : 's'} processed
                  <ChevronDownIcon className="disclosure__chevron" />
                </summary>
                <div className="disclosure__content">
                  {analysis.transcript.map((chunk) => (
                    <div className="transcript-line" key={chunk.index}>
                      <span className="transcript-line__time">{chunk.timestamp}</span>
                      <span>{chunk.text}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {analysis.error && (
              <div style={{ marginTop: 'var(--space-5)' }}>
                <ErrorState message={analysis.error} onRetry={handleSubmit} />
              </div>
            )}

            {(results.length > 0 || pendingCount > 0) && (
              <>
                <div className="results__heading">
                  <h2>Results</h2>
                  {analysis.articleTitle && (
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                      {analysis.articleTitle}
                    </span>
                  )}
                </div>

                {summary && <SummaryStrip summary={summary} />}

                <div className="results">
                  {results.map((result, index) => (
                    <VerdictCard key={`${result.claim}-${index}`} result={result} index={index} />
                  ))}

                  {/* One placeholder per claim still being checked. */}
                  {Array.from({ length: pendingCount }).map((_, index) => (
                    <SkeletonCard key={`skeleton-${index}`} index={index} />
                  ))}
                </div>
              </>
            )}

            {showNoClaims && (
              <div style={{ marginTop: 'var(--space-5)' }}>
                <NoClaimsState onReset={analysis.reset} />
              </div>
            )}

            {showEmptyState && !analysis.error && (
              <div style={{ marginTop: 'var(--space-6)' }}>
                <EmptyState onPickExample={handleExample} />
              </div>
            )}
          </>
        ) : (
          <>
            <section className="hero" style={{ paddingBottom: 'var(--space-5)' }}>
              <h1 className="hero__title" style={{ fontSize: 'var(--text-2xl)' }}>
                History
              </h1>
              <p className="hero__tagline" style={{ fontSize: 'var(--text-base)' }}>
                Every analysis you have run, stored in PostgreSQL and replayable in full.
              </p>
            </section>
            <HistoryView />
          </>
        )}
      </main>

      {/* ---------------------------------------------------------------- */}
      <footer className="footer">
        <div className="container footer__inner">
          <span>TruthSource · verdicts are grounded in retrieved evidence, never model memory.</span>
          <span className="footer__pipeline">
            <span className="footer__step">extract</span>→<span className="footer__step">retrieve</span>→
            <span className="footer__step">reason</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
