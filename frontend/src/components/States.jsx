import { AlertIcon, DatabaseIcon, SearchIcon, ShieldCheckIcon } from './Icons';
import { VERDICT_META } from '../lib/verdicts';

/**
 * Loading, empty and error states.
 *
 * A screen that shows nothing is a bug. Every path through the app — before you
 * type, while you wait, when nothing was found, when the network died — has a
 * designed state here.
 */

/** One shimmering placeholder, shaped like the verdict card it will become. */
export function SkeletonCard({ index = 0 }) {
  return (
    <div className="skeleton-card" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="skeleton-card__body">
        <div className="skeleton" style={{ width: 96, height: 22, borderRadius: 999 }} />
        <div className="skeleton" style={{ width: '92%', height: 18 }} />
        <div className="skeleton" style={{ width: '70%', height: 14 }} />
        <div className="skeleton" style={{ width: '84%', height: 14 }} />
      </div>
      <div className="skeleton" style={{ width: 58, height: 58, borderRadius: '50%', flexShrink: 0 }} />
    </div>
  );
}

/**
 * The first thing a new user sees. It does two jobs: explain the RAG idea in one
 * line, and remove the blank-page problem with clickable examples that are
 * genuinely interesting to run.
 */
export function EmptyState({ onPickExample }) {
  const examples = [
    'The Great Wall of China is visible from space with the naked eye.',
    'Bananas are berries, but strawberries are not.',
    'Humans only use 10% of their brains.',
    'The Amazon rainforest produces 20% of the world’s oxygen.',
  ];

  return (
    <div className="state-card">
      <div className="state-card__icon">
        <ShieldCheckIcon width={22} height={22} />
      </div>
      <h3 className="state-card__title">Nothing checked yet</h3>
      <p className="state-card__body">
        Paste a claim, drop in an article link, upload a screenshot or a video. TruthSource breaks it into individual
        claims, searches the live web for real evidence, and gives each one a verdict you can trace back to a source.
      </p>

      <div className="examples" style={{ justifyContent: 'center' }}>
        {examples.map((example) => (
          <button type="button" key={example} className="example-chip" onClick={() => onPickExample(example)}>
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Shown when the pipeline ran fine but found nothing worth checking. */
export function NoClaimsState({ onReset }) {
  return (
    <div className="state-card">
      <div className="state-card__icon">
        <SearchIcon width={22} height={22} />
      </div>
      <h3 className="state-card__title">No verifiable claims found</h3>
      <p className="state-card__body">
        That input was mostly opinion, prediction or commentary — none of which can be checked against evidence.
        Try something that states a fact: a statistic, a date, an event, or an attribution.
      </p>
      <button type="button" className="btn btn--ghost" onClick={onReset}>
        Try something else
      </button>
    </div>
  );
}

/** Any hard failure: network down, API key missing, page unscrapeable. */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="state-card state-card--error" role="alert">
      <div className="state-card__icon">
        <AlertIcon />
      </div>
      <h3 className="state-card__title">Something went wrong</h3>
      <p className="state-card__body">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** History with no database behind it — explain, don't just show nothing. */
export function NoDatabaseState({ message }) {
  return (
    <div className="state-card">
      <div className="state-card__icon">
        <DatabaseIcon />
      </div>
      <h3 className="state-card__title">History needs PostgreSQL</h3>
      <p className="state-card__body">
        {message || 'History is unavailable because PostgreSQL is not connected.'} Fact-checking works perfectly
        without it — only the saved record of past analyses is affected. Run <code>npm run db:migrate</code> once
        Postgres is running to enable it.
      </p>
    </div>
  );
}

/** Aggregate strip above a set of results. */
export function SummaryStrip({ summary }) {
  if (!summary || summary.total === 0) return null;

  return (
    <div className="summary">
      <div>
        <div className="summary__label">Claims checked</div>
        <div className="summary__value">{summary.total}</div>
      </div>

      {summary.trustScore !== null && (
        <div>
          <div className="summary__label">Held up</div>
          <div className="summary__value">{summary.trustScore}%</div>
        </div>
      )}

      <div className="summary__counts">
        {Object.entries(summary.counts)
          .filter(([, count]) => count > 0)
          .map(([verdict, count]) => (
            <span className="count-pill" key={verdict}>
              <span className="count-pill__dot" style={{ background: VERDICT_META[verdict].color }} />
              {count} {VERDICT_META[verdict].label}
            </span>
          ))}
      </div>
    </div>
  );
}

/** The live "what is happening right now" line under the input. */
export function StatusTicker({ message }) {
  if (!message) return null;
  return (
    <div className="status-ticker" role="status" aria-live="polite">
      <span className="status-ticker__dot" />
      {/* Keying on the message restarts the slide-in each time the stage changes. */}
      <span className="status-ticker__text" key={message}>
        {message}
      </span>
    </div>
  );
}
