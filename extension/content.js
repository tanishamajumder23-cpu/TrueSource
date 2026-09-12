/**
 * TruthSource extension — content script.
 *
 * Renders the inline verdict panel that appears when the user right-clicks a
 * selection and picks "Fact-check with TruthSource".
 *
 * Two defensive decisions worth noting:
 *
 *  1. SHADOW DOM. The panel is mounted inside a shadow root so the host page's
 *     CSS cannot leak in and wreck our layout (and ours cannot leak out and
 *     wreck theirs). Injecting a bare div into an arbitrary site is a reliable
 *     way to produce a broken-looking widget.
 *
 *  2. NO innerHTML WITH REMOTE TEXT. Claims, reasoning and titles come from a
 *     model reading web content — never trusted input. Everything is inserted
 *     with textContent / createElement, so no page can be XSS'd through us.
 */

const PANEL_ID = 'truthsource-panel-host';

const VERDICT_STYLE = {
  TRUE: { label: 'True', color: '#22c55e', icon: '✓' },
  FALSE: { label: 'False', color: '#ef4444', icon: '✕' },
  MISLEADING: { label: 'Misleading', color: '#f59e0b', icon: '!' },
  UNVERIFIABLE: { label: 'Unverifiable', color: '#94a3b8', icon: '?' },
};

/** Create (or reuse) the shadow-DOM host and return its root. */
function getPanelRoot() {
  let host = document.getElementById(PANEL_ID);

  if (!host) {
    host = document.createElement('div');
    host.id = PANEL_ID;
    // The host itself carries only positioning; everything visual lives inside
    // the shadow root. !important guards against aggressive page resets.
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'vs-panel';
    shadow.appendChild(panel);
  }

  return host.shadowRoot.querySelector('.vs-panel');
}

function removePanel() {
  document.getElementById(PANEL_ID)?.remove();
}

/** Panel header with the title and a close button. */
function buildHeader(panel, subtitle) {
  const header = document.createElement('div');
  header.className = 'vs-header';

  const title = document.createElement('div');
  title.className = 'vs-title';
  title.textContent = 'TruthSource';

  const close = document.createElement('button');
  close.className = 'vs-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', removePanel);

  header.append(title, close);
  panel.appendChild(header);

  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'vs-subtitle';
    sub.textContent = subtitle;
    panel.appendChild(sub);
  }
}

/** Loading state: shown the instant the menu item is clicked. */
function renderLoading(query) {
  const panel = getPanelRoot();
  panel.replaceChildren();

  buildHeader(panel, `Checking: "${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"`);

  const body = document.createElement('div');
  body.className = 'vs-body';

  const loading = document.createElement('div');
  loading.className = 'vs-loading';

  const spinner = document.createElement('span');
  spinner.className = 'vs-spinner';

  const label = document.createElement('span');
  label.textContent = 'Retrieving live evidence…';

  loading.append(spinner, label);
  body.appendChild(loading);
  panel.appendChild(body);
}

/** One verdict card inside the panel. */
function buildCard(result) {
  const style = VERDICT_STYLE[result.verdict] || VERDICT_STYLE.UNVERIFIABLE;

  const card = document.createElement('div');
  card.className = 'vs-card';
  card.style.setProperty('--accent', style.color);

  const top = document.createElement('div');
  top.className = 'vs-card-top';

  const badge = document.createElement('span');
  badge.className = 'vs-badge';
  badge.textContent = `${style.icon} ${style.label}`;

  const confidence = document.createElement('span');
  confidence.className = 'vs-confidence';
  confidence.textContent = `${result.confidence}% confidence`;

  top.append(badge, confidence);

  const claim = document.createElement('div');
  claim.className = 'vs-claim';
  claim.textContent = result.claim;

  const reasoning = document.createElement('div');
  reasoning.className = 'vs-reasoning';
  reasoning.textContent = result.reasoning;

  card.append(top, claim, reasoning);

  if (result.sources?.length) {
    const sources = document.createElement('div');
    sources.className = 'vs-sources';

    for (const source of result.sources.slice(0, 4)) {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'vs-source';
      link.textContent = source.domain;
      sources.appendChild(link);
    }

    card.appendChild(sources);
  }

  return card;
}

function renderResults({ results, summary }) {
  const panel = getPanelRoot();
  panel.replaceChildren();

  const subtitle =
    results.length === 0
      ? 'No verifiable claims found in that selection.'
      : `${summary?.total ?? results.length} claim${results.length === 1 ? '' : 's'} checked`;

  buildHeader(panel, subtitle);

  const body = document.createElement('div');
  body.className = 'vs-body';

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'vs-empty';
    empty.textContent =
      'That text was mostly opinion or commentary. Try selecting something that states a fact — a statistic, a date, or an event.';
    body.appendChild(empty);
  } else {
    for (const result of results) body.appendChild(buildCard(result));
  }

  panel.appendChild(body);
}

function renderError(message) {
  const panel = getPanelRoot();
  panel.replaceChildren();
  buildHeader(panel, null);

  const body = document.createElement('div');
  body.className = 'vs-body';

  const error = document.createElement('div');
  error.className = 'vs-error';
  error.textContent = message;

  body.appendChild(error);
  panel.appendChild(body);
}

// --------------------------------------------------------------------------
//  Message handling
// --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case 'TRUTHSOURCE_LOADING':
      renderLoading(message.query);
      break;
    case 'TRUTHSOURCE_RESULTS':
      renderResults(message);
      break;
    case 'TRUTHSOURCE_ERROR':
      renderError(message.message);
      break;
    case 'TRUTHSOURCE_GET_PAGE_TEXT':
      // The popup asks for the readable text of the page. Answering from the
      // content script means we get the rendered DOM, including anything the
      // site loaded with JavaScript.
      return Promise.resolve({ text: extractPageText() });
    default:
      break;
  }
  return undefined;
});

/**
 * Pull the article text out of the current page.
 *
 * A deliberately simple readability heuristic: prefer semantic containers, fall
 * back to body, and strip the elements that are never article content. Good
 * enough to feed a claim extractor, and it avoids bundling a parser library.
 */
function extractPageText() {
  const container =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body;

  // Clone so removing nodes never mutates the page the user is reading.
  const clone = container.cloneNode(true);
  clone
    .querySelectorAll('script, style, nav, header, footer, aside, form, noscript, iframe, svg')
    .forEach((node) => node.remove());

  return (clone.innerText || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000); // matches the backend's own input cap
}

// Escape closes the panel — the shortcut people reach for reflexively.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') removePanel();
});

// --------------------------------------------------------------------------
//  Panel styles (scoped inside the shadow root)
// --------------------------------------------------------------------------

const PANEL_CSS = `
  :host { all: initial; }

  .vs-panel {
    position: fixed;
    top: 16px;
    right: 16px;
    width: 380px;
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    background: #14161b;
    color: #e8eaef;
    border: 1px solid #23262e;
    border-radius: 14px;
    box-shadow: 0 24px 60px -20px rgba(0,0,0,0.75);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.55;
    overflow: hidden;
    animation: vs-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes vs-in {
    from { opacity: 0; transform: translateY(-8px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  .vs-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid #23262e; flex-shrink: 0;
  }
  .vs-title { font-weight: 700; letter-spacing: -0.02em; font-size: 14px; }
  .vs-close {
    background: none; border: none; color: #6f7684; cursor: pointer;
    font-size: 14px; padding: 2px 6px; border-radius: 6px; line-height: 1;
  }
  .vs-close:hover { background: #191c22; color: #e8eaef; }

  .vs-subtitle {
    padding: 10px 14px; font-size: 12px; color: #a4abb8;
    border-bottom: 1px solid #23262e; background: #0e1014; flex-shrink: 0;
  }

  .vs-body { padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }

  .vs-loading { display: flex; align-items: center; gap: 10px; padding: 20px 8px; color: #a4abb8; }
  .vs-spinner {
    width: 14px; height: 14px; border: 2px solid #31353f; border-top-color: #6366f1;
    border-radius: 50%; animation: vs-spin 700ms linear infinite; flex-shrink: 0;
  }
  @keyframes vs-spin { to { transform: rotate(360deg); } }

  .vs-card {
    border: 1px solid #23262e; border-left: 3px solid var(--accent);
    border-radius: 10px; padding: 12px; background: #101216;
  }
  .vs-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .vs-badge {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 2px 8px;
  }
  .vs-confidence { font-size: 11px; color: #6f7684; }
  .vs-claim { font-weight: 600; margin-bottom: 6px; }
  .vs-reasoning { color: #a4abb8; font-size: 12px; }

  .vs-sources { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .vs-source {
    font-size: 11px; color: #818cf8; text-decoration: none;
    border: 1px solid #23262e; border-radius: 6px; padding: 2px 7px; background: #14161b;
  }
  .vs-source:hover { border-color: #6366f1; text-decoration: underline; }

  .vs-empty, .vs-error { padding: 14px 8px; color: #a4abb8; font-size: 12px; }
  .vs-error { color: #fca5a5; }
`;
