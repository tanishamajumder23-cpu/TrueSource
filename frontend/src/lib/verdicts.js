/**
 * Verdict presentation metadata.
 *
 * Kept in one place so the badge, the card spine, the confidence ring and the
 * summary pills can never drift out of sync with each other.
 *
 * Note that every verdict carries a `label` and an `icon` in addition to a
 * colour. Colour alone is not an accessible signal.
 */

export const VERDICT_META = {
  TRUE: {
    label: 'True',
    icon: '✓',
    color: 'var(--verdict-true)',
    bg: 'var(--verdict-true-bg)',
    border: 'var(--verdict-true-border)',
    description: 'Supported by the retrieved evidence.',
  },
  FALSE: {
    label: 'False',
    icon: '✕',
    color: 'var(--verdict-false)',
    bg: 'var(--verdict-false-bg)',
    border: 'var(--verdict-false-border)',
    description: 'Contradicted by the retrieved evidence.',
  },
  MISLEADING: {
    label: 'Misleading',
    icon: '!',
    color: 'var(--verdict-misleading)',
    bg: 'var(--verdict-misleading-bg)',
    border: 'var(--verdict-misleading-border)',
    description: 'Technically accurate but missing important context.',
  },
  UNVERIFIABLE: {
    label: 'Unverifiable',
    icon: '?',
    color: 'var(--verdict-unverifiable)',
    bg: 'var(--verdict-unverifiable-bg)',
    border: 'var(--verdict-unverifiable-border)',
    description: 'The evidence was insufficient to decide either way.',
  },
};

/** Always returns a meta object, even for an unexpected verdict string. */
export function metaFor(verdict) {
  return VERDICT_META[verdict] || VERDICT_META.UNVERIFIABLE;
}

/** Human label for how a source was found. */
export const PROVIDER_LABEL = {
  tavily: 'Tavily',
  duckduckgo: 'DuckDuckGo (fallback)',
  wikipedia: 'Wikipedia (fallback)',
  none: 'no provider',
  unknown: 'source',
};

/** Google's favicon service, so each source row carries its site's icon. */
export function faviconUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

/** "2 hours ago" style relative time for the history list. */
export function relativeTime(isoString) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['month', 2592000],
    ['year', 31536000],
  ];

  let label = 'year';
  let size = 31536000;
  for (let i = 0; i < units.length; i += 1) {
    const [unitLabel, unitSize] = units[i];
    const next = units[i + 1];
    if (!next || seconds < next[1]) {
      label = unitLabel;
      size = unitSize;
      break;
    }
  }

  const value = Math.floor(seconds / size);
  return `${value} ${label}${value === 1 ? '' : 's'} ago`;
}
