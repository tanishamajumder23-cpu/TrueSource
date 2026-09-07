import { useEffect, useState } from 'react';
import { getHistory, getStats } from '../lib/api';
import { VerdictCard } from './VerdictCard';
import { ErrorState, NoDatabaseState, SkeletonCard } from './States';
import { relativeTime } from '../lib/verdicts';
import { ChevronDownIcon } from './Icons';

/**
 * Past analyses, read back from PostgreSQL.
 *
 * Collapsed by default: the list is for scanning ("what have I checked?"), and
 * expanding one replays its full verdict cards. Using a native <details> means
 * the open/close behaviour, keyboard support and find-in-page all work without
 * a line of JavaScript.
 */
export function HistoryView() {
  const [state, setState] = useState({ loading: true, error: null, available: false, analyses: [] });
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Stats are a nice-to-have, so a failure there must not blank the list.
        const [history, statsPayload] = await Promise.all([getHistory({ limit: 25 }), getStats().catch(() => null)]);
        if (cancelled) return;
        setState({ loading: false, error: null, available: history.available, analyses: history.analyses, message: history.message });
        setStats(statsPayload?.stats ?? null);
      } catch (error) {
        if (!cancelled) setState({ loading: false, error: error.message, available: false, analyses: [] });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <div className="stack">
        {[0, 1, 2].map((i) => (
          <SkeletonCard key={i} index={i} />
        ))}
      </div>
    );
  }

  if (state.error) return <ErrorState message={state.error} />;
  if (!state.available) return <NoDatabaseState message={state.message} />;

  if (state.analyses.length === 0) {
    return (
      <div className="state-card">
        <h3 className="state-card__title">No history yet</h3>
        <p className="state-card__body">Analyses you run will be saved here automatically.</p>
      </div>
    );
  }

  return (
    <>
      {stats && (
        <div className="stats-grid">
          <div className="stat-tile">
            <div className="stat-tile__value">{stats.totalAnalyses}</div>
            <div className="stat-tile__label">Analyses</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__value">{stats.totalClaims}</div>
            <div className="stat-tile__label">Claims checked</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__value" style={{ color: 'var(--verdict-true)' }}>
              {stats.trueCount}
            </div>
            <div className="stat-tile__label">True</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile__value" style={{ color: 'var(--verdict-false)' }}>
              {stats.falseCount}
            </div>
            <div className="stat-tile__label">False</div>
          </div>
        </div>
      )}

      <div className="history-list">
        {state.analyses.map((analysis, index) => (
          <details className="history-item" key={analysis.id} style={{ '--delay': `${Math.min(index, 10) * 40}ms` }}>
            <summary className="history-item__summary">
              <span className="history-item__type">{analysis.inputType}</span>
              <span className="history-item__text">{analysis.submittedContent}</span>
              <span className="history-item__meta">
                {analysis.results?.length || 0} claim{analysis.results?.length === 1 ? '' : 's'} ·{' '}
                {relativeTime(analysis.createdAt)}
              </span>
              <ChevronDownIcon />
            </summary>

            <div className="history-item__body">
              {(analysis.results || []).map((result, resultIndex) => (
                <VerdictCard
                  key={`${analysis.id}-${resultIndex}`}
                  index={resultIndex}
                  // History rows come back with the same field names the live
                  // pipeline emits, so the same card renders both.
                  result={{
                    claim: result.claim,
                    verdict: result.verdict || 'UNVERIFIABLE',
                    confidence: result.confidence ?? 0,
                    reasoning: result.reasoning || '',
                    sources: result.sources || [],
                    evidenceProvider: result.evidenceProvider,
                    timestamp: result.timestamp,
                  }}
                />
              ))}
            </div>
          </details>
        ))}
      </div>
    </>
  );
}
