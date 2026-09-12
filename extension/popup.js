/**
 * TruthSource extension — popup.
 *
 * "Fact-check this page": grab the readable text from the active tab, hand it
 * to the background worker (which owns API access), and render the verdicts.
 *
 * As in the content script, every piece of model-produced text is inserted with
 * textContent rather than innerHTML. The popup runs with extension privileges,
 * so an injection here would be considerably worse than one on a page.
 */

const VERDICT_STYLE = {
  TRUE: { label: 'True', color: '#22c55e', icon: '✓' },
  FALSE: { label: 'False', color: '#ef4444', icon: '✕' },
  MISLEADING: { label: 'Misleading', color: '#f59e0b', icon: '!' },
  UNVERIFIABLE: { label: 'Unverifiable', color: '#94a3b8', icon: '?' },
};

const els = {
  checkPage: document.getElementById('check-page'),
  status: document.getElementById('status'),
  summary: document.getElementById('summary'),
  results: document.getElementById('results'),
  settingsToggle: document.getElementById('settings-toggle'),
  settings: document.getElementById('settings'),
  apiUrl: document.getElementById('api-url'),
  saveSettings: document.getElementById('save-settings'),
};

// --------------------------------------------------------------------------
//  Status region — one element, four states, never blank
// --------------------------------------------------------------------------

function setStatus(message, { loading = false, error = false } = {}) {
  els.status.replaceChildren();

  if (!message) {
    els.status.hidden = true;
    return;
  }

  els.status.hidden = false;
  els.status.className = `status${error ? ' status--error' : ''}`;

  if (loading) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    els.status.appendChild(spinner);
  }

  els.status.appendChild(document.createTextNode(message));
}

// --------------------------------------------------------------------------
//  Rendering
// --------------------------------------------------------------------------

function renderSummary(summary) {
  els.summary.replaceChildren();

  if (!summary || summary.total === 0) {
    els.summary.hidden = true;
    return;
  }

  els.summary.hidden = false;

  const total = document.createElement('span');
  total.className = 'pill';
  total.textContent = `${summary.total} claim${summary.total === 1 ? '' : 's'}`;
  els.summary.appendChild(total);

  for (const [verdict, count] of Object.entries(summary.counts)) {
    if (count === 0) continue;
    const style = VERDICT_STYLE[verdict];
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.style.color = style.color;
    pill.style.borderColor = style.color;
    pill.textContent = `${style.icon} ${count} ${style.label}`;
    els.summary.appendChild(pill);
  }
}

function renderResults(results) {
  els.results.replaceChildren();

  results.forEach((result, index) => {
    const style = VERDICT_STYLE[result.verdict] || VERDICT_STYLE.UNVERIFIABLE;

    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--accent', style.color);
    // Stagger so a batch of results cascades in rather than snapping.
    card.style.setProperty('--delay', `${Math.min(index, 8) * 50}ms`);

    const top = document.createElement('div');
    top.className = 'card__top';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${style.icon} ${style.label}`;

    const confidence = document.createElement('span');
    confidence.className = 'confidence';
    confidence.textContent = `${result.confidence}%`;

    top.append(badge, confidence);

    const claim = document.createElement('div');
    claim.className = 'claim';
    claim.textContent = result.claim;

    const reasoning = document.createElement('div');
    reasoning.className = 'reasoning';
    reasoning.textContent = result.reasoning;

    card.append(top, claim, reasoning);

    if (result.sources?.length) {
      const sources = document.createElement('div');
      sources.className = 'sources';
      for (const source of result.sources.slice(0, 4)) {
        const link = document.createElement('a');
        link.className = 'source';
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.domain;
        sources.appendChild(link);
      }
      card.appendChild(sources);
    }

    els.results.appendChild(card);
  });
}

// --------------------------------------------------------------------------
//  Actions
// --------------------------------------------------------------------------

els.checkPage.addEventListener('click', async () => {
  els.checkPage.disabled = true;
  els.results.replaceChildren();
  renderSummary(null);
  setStatus('Reading the page…', { loading: true });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');

    // Ask the content script for the page text. On chrome:// pages, the Web
    // Store, and PDFs no content script exists, so this throws — and that is
    // exactly the case we want to explain rather than fail silently on.
    let pageText;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'TRUTHSOURCE_GET_PAGE_TEXT' });
      pageText = response?.text;
    } catch {
      throw new Error('This page cannot be read (browser pages and the Web Store are off-limits).');
    }

    if (!pageText || pageText.length < 100) {
      throw new Error('There is not enough readable text on this page to check.');
    }

    setStatus('Extracting claims and retrieving evidence…', { loading: true });

    const response = await chrome.runtime.sendMessage({ type: 'TRUTHSOURCE_ANALYZE', text: pageText });

    if (!response?.ok) throw new Error(response?.error || 'Analysis failed.');

    if (!response.results.length) {
      setStatus('No verifiable factual claims were found on this page.');
      return;
    }

    setStatus(null);
    renderSummary(response.summary);
    renderResults(response.results);
  } catch (error) {
    setStatus(error.message, { error: true });
  } finally {
    els.checkPage.disabled = false;
  }
});

// ---- Settings ----

els.settingsToggle.addEventListener('click', () => {
  els.settings.hidden = !els.settings.hidden;
});

els.saveSettings.addEventListener('click', async () => {
  const value = els.apiUrl.value.trim().replace(/\/$/, '');
  await chrome.storage.sync.set({ apiUrl: value || 'http://localhost:3000' });
  els.settings.hidden = true;
  setStatus('API URL saved.');
  setTimeout(() => setStatus(null), 1800);
});

// Prefill the settings field with whatever is currently configured.
chrome.runtime.sendMessage({ type: 'TRUTHSOURCE_GET_API_URL' }).then((response) => {
  if (response?.apiUrl) els.apiUrl.value = response.apiUrl;
});
