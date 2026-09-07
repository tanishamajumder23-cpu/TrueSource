/**
 * URL ingestion: article -> clean markdown.
 *
 * When a user pastes a news link we cannot feed raw HTML to the model -- it is
 * 95% navigation, cookie banners, ads and scripts, which both blows the context
 * window and drowns the actual claims in noise.
 *
 * Firecrawl renders the page (including JS-heavy sites) and returns clean
 * markdown, which is exactly the signal-dense input the claim extractor wants.
 *
 * As with everything else in Veristate, failure is expected and handled: a
 * paywalled, blocked or dead URL produces a clear, user-facing error rather than
 * an unhandled rejection.
 */

const FirecrawlModule = require('@mendable/firecrawl-js');
const config = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('scraper');

// The SDK has shifted its export shape between major versions; resolve whichever
// constructor this installation exposes so an npm upgrade cannot break startup.
const FirecrawlCtor = FirecrawlModule.Firecrawl || FirecrawlModule.default || FirecrawlModule;

// Lazily constructed so a missing key never crashes the process at import time.
let client = null;
function getClient() {
  if (!config.features.firecrawl) return null;
  if (!client) client = new FirecrawlCtor({ apiKey: config.firecrawl.apiKey });
  return client;
}

/**
 * Is this string a bare URL the user wants us to fetch?
 * Deliberately strict: it must be the WHOLE input, not a URL mentioned inside a
 * sentence (in that case the user wants the sentence fact-checked, not the page).
 */
function isUrl(text) {
  if (typeof text !== 'string') return false;
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

/** Pretty domain for display, e.g. "https://www.bbc.co.uk/news/x" -> "bbc.co.uk". */
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Fetch an article and return its clean markdown.
 *
 * @param {string} url
 * @returns {Promise<{ markdown: string, title: string, url: string }>}
 * @throws {Error} with a `code` of SCRAPER_DISABLED or SCRAPE_FAILED
 */
async function scrapeArticle(url) {
  const firecrawl = getClient();

  if (!firecrawl) {
    const error = new Error(
      'URL scraping is not configured on this server (FIRECRAWL_API_KEY is missing). Paste the article text directly instead.',
    );
    error.code = 'SCRAPER_DISABLED';
    throw error;
  }

  log.info(`Scraping ${domainOf(url)}`);

  let doc;
  try {
    // v4 API. Older installs only expose scrapeUrl, so fall back to it.
    doc =
      typeof firecrawl.scrape === 'function'
        ? await firecrawl.scrape(url, { formats: ['markdown'] })
        : await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
  } catch (error) {
    log.error(`Firecrawl request failed for ${url}`, error.message);
    const wrapped = new Error(
      `Could not read that page (${domainOf(url)}). It may be paywalled, blocked, or offline. Try pasting the text instead.`,
    );
    wrapped.code = 'SCRAPE_FAILED';
    throw wrapped;
  }

  // Firecrawl has used both a flat and a { data: ... } envelope across versions.
  const payload = doc?.data || doc;
  const markdown = payload?.markdown;

  if (!markdown || markdown.trim().length < 50) {
    const error = new Error(
      `That page returned almost no readable text (${domainOf(url)}). It may be a video, a paywall, or a login screen.`,
    );
    error.code = 'SCRAPE_EMPTY';
    throw error;
  }

  log.info(`Scraped ${markdown.length} characters from ${domainOf(url)}`);

  return {
    markdown,
    title: payload?.metadata?.title || domainOf(url),
    url,
  };
}

module.exports = { scrapeArticle, isUrl, domainOf };
