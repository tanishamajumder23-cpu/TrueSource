import { ConfidenceMeter } from './ConfidenceMeter';
import { ClockIcon, ExternalIcon, SearchIcon } from './Icons';
import { PROVIDER_LABEL, faviconUrl, metaFor } from '../lib/verdicts';

/**
 * A single fact-check result — the centrepiece of the whole product.
 *
 * Everything here is in service of one goal: make the verdict scannable in half
 * a second, and make it *checkable* in five. Hence the coloured spine and badge
 * (instant), the claim in large type (what was checked), the reasoning (why),
 * and real clickable sources with their domains (how you verify us).
 *
 * Showing which retrieval provider supplied the evidence is a deliberate honesty
 * signal: the user can see whether this came from the primary search index or a
 * fallback, and weigh it accordingly.
 */
export function VerdictCard({ result, index = 0 }) {
  const meta = metaFor(result.verdict);

  return (
    <article
      className="verdict-card"
      // Stagger the entrance so a burst of streamed results cascades.
      style={{
        '--delay': `${Math.min(index, 8) * 60}ms`,
        '--accent': meta.color,
        '--accent-bg': meta.bg,
        '--accent-border': meta.border,
      }}
    >
      <header className="verdict-card__top">
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="badge">
            <span aria-hidden="true">{meta.icon}</span>
            {meta.label}
          </span>

          {/* Video results carry the moment the claim was spoken. */}
          {result.timestamp && (
            <span className="timestamp-chip" title="Where this was said in the video">
              <ClockIcon />
              {result.timestamp}
            </span>
          )}
        </div>

        <ConfidenceMeter value={result.confidence} color={meta.color} />
      </header>

      <h3 className="claim-text">{result.claim}</h3>
      <p className="reasoning">{result.reasoning}</p>

      {result.sources?.length > 0 ? (
        <div className="sources">
          <div className="sources__label">
            <SearchIcon width={13} height={13} />
            Evidence
            <span className="provider-tag">
              via {PROVIDER_LABEL[result.evidenceProvider] || PROVIDER_LABEL.unknown}
            </span>
          </div>

          <ul className="source-list">
            {result.sources.map((source) => (
              <li key={source.url}>
                <a
                  className="source-link"
                  href={source.url}
                  // noopener/noreferrer: never hand a third-party page a handle
                  // on our window.
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    className="source-link__favicon"
                    src={faviconUrl(source.domain)}
                    alt=""
                    loading="lazy"
                    // A blocked favicon should leave a neutral square, not a
                    // broken-image glyph.
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                  <span className="source-link__title">{source.title}</span>
                  <span className="source-link__domain">{source.domain}</span>
                  <ExternalIcon />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="sources">
          <div className="sources__label">No evidence could be retrieved for this claim</div>
        </div>
      )}
    </article>
  );
}
