/**
 * TruthSource extension — background service worker (Manifest V3).
 *
 * Two responsibilities:
 *   1. Own the right-click "Fact-check selection" menu item.
 *   2. Be the ONLY thing that talks to the TruthSource API.
 *
 * Point 2 matters. A content script runs in the page's origin, so its fetches
 * are subject to that page's CORS policy and its Content-Security-Policy — on a
 * strict site the request would simply be blocked. The service worker has the
 * extension's own host permissions instead, so requests always go through. The
 * content script therefore asks the worker to fetch on its behalf via message
 * passing.
 *
 * MV3 service workers are ephemeral: Chrome tears them down when idle and
 * restarts them on the next event. Nothing here holds state between events for
 * that reason — anything that must persist goes in chrome.storage.
 */

const DEFAULT_API_URL = 'http://localhost:3000';

/** Read the configured API URL (the popup lets the user change it). */
async function getApiUrl() {
  try {
    const { apiUrl } = await chrome.storage.sync.get('apiUrl');
    return apiUrl || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

// --------------------------------------------------------------------------
//  Context menu
// --------------------------------------------------------------------------

// onInstalled is the correct place to register menus: re-registering on every
// worker wake-up would throw a duplicate-id error.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'truthsource-check-selection',
    title: 'Fact-check "%s" with TruthSource',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'truthsource-check-selection' || !tab?.id) return;

  const text = (info.selectionText || '').trim();
  if (text.length < 10) {
    notifyTab(tab.id, { type: 'TRUTHSOURCE_ERROR', message: 'Select a bit more text — at least a full sentence.' });
    return;
  }

  // Show the panel immediately in its loading state, then fill it in. Waiting
  // for the API before showing anything would look like the click did nothing.
  notifyTab(tab.id, { type: 'TRUTHSOURCE_LOADING', query: text });

  try {
    const results = await analyze(text);
    notifyTab(tab.id, { type: 'TRUTHSOURCE_RESULTS', ...results });
  } catch (error) {
    notifyTab(tab.id, { type: 'TRUTHSOURCE_ERROR', message: error.message });
  }
});

/**
 * Send a message to a tab's content script.
 *
 * This can legitimately fail — chrome:// pages, the Web Store, and PDFs never
 * receive content scripts — so the rejection is swallowed rather than logged as
 * an error the user can do nothing about.
 */
function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// --------------------------------------------------------------------------
//  API calls (proxied on behalf of the popup and content script)
// --------------------------------------------------------------------------

/**
 * Run the analysis pipeline over some text.
 * Uses the one-shot endpoint rather than the SSE stream: the popup is a small
 * surface and a single response keeps the extension code simple.
 */
async function analyze(text) {
  const apiUrl = await getApiUrl();

  let response;
  try {
    response = await fetch(`${apiUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, surface: 'extension' }),
    });
  } catch {
    throw new Error(`Can't reach TruthSource at ${apiUrl}. Is the backend running?`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);

  return { results: payload.results || [], summary: payload.summary || null };
}

// --------------------------------------------------------------------------
//  Message router
// --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TRUTHSOURCE_ANALYZE') {
    analyze(message.text)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    // Returning true keeps the message channel open for the async sendResponse.
    // Without it the popup would receive undefined immediately.
    return true;
  }

  if (message?.type === 'TRUTHSOURCE_GET_API_URL') {
    getApiUrl().then((apiUrl) => sendResponse({ apiUrl }));
    return true;
  }

  return false;
});
