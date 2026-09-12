/**
 * STAGE 2 of the RAG pipeline: RETRIEVAL. This is the heart of the product.
 *
 * ── Why retrieval at all? ────────────────────────────────────────────────
 * The naive way to build a fact-checker is to ask an LLM "is this true?". That
 * approach is fundamentally broken for two reasons:
 *
 *   1. HALLUCINATION — a model asked to recall facts will confidently invent
 *      statistics, citations and URLs that do not exist.
 *   2. STALE KNOWLEDGE — a model's weights were frozen months or years ago. Ask
 *      it who leads a company, or what a stock price is, and it answers with the
 *      world as it was during training.
 *
 * Retrieval-Augmented Generation fixes both. We fetch REAL, CURRENT documents
 * from the live web first, and in stage 3 the model is allowed to reason ONLY
 * over those documents. The model stops being a knowledge base and becomes what
 * it is actually good at: a reading-comprehension engine. Every verdict is
 * therefore traceable to a source the user can click and check themselves.
 *
 * ── Why a chain of search providers? ─────────────────────────────────────
 * Tavily is purpose-built for RAG: it returns clean, ranked, pre-extracted
 * snippets rather than raw HTML, which is exactly what we want to feed a model.
 * But it is a keyed, rate-limited, paid service — and a demo that dies because
 * one API quota ran out is a demo that fails on stage.
 *
 * So retrieval is a CHAIN of independent providers, tried in order until one
 * yields evidence:
 *
 *   1. TAVILY        — primary. Keyed, paid, best-quality ranked snippets.
 *   2. DUCKDUCKGO    — keyless web search via duck-duck-scrape. Covers a Tavily
 *                      outage or exhausted quota. Being an unofficial scraper it
 *                      is itself sometimes rate-limited, which is exactly why
 *                      there is a third tier.
 *   3. WIKIPEDIA API — keyless, officially supported, effectively never down.
 *                      Narrower coverage than a web search, but for the
 *                      encyclopedic claims that dominate fact-checking it
 *                      returns genuine, citable evidence.
 *
 * If all three fail we return an EMPTY ARRAY rather than throwing — a claim with
 * no evidence correctly becomes UNVERIFIABLE downstream, which is an honest
 * answer, not a crash.
 */

const axios = require('axios');
const DDG = require('duck-duck-scrape');
const config = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('evidence');

/**
 * @typedef {Object} EvidenceItem
 * @property {string} title
 * @property {string} content  - the extracted snippet the model will reason over
 * @property {string} url
 * @property {number} score    - relevance 0-1 (Tavily's own score, or a synthetic
 *                               rank-based score for the fallbacks)
 * @property {'tavily'|'duckduckgo'|'wikipedia'} provider
 */

/** Strip HTML tags DuckDuckGo embeds in its descriptions (<b>term</b>). */
function stripHtml(text = '') {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * PRIMARY provider — Tavily.
 * Throws on failure so the caller can decide to fall back.
 */
async function searchTavily(claim) {
  if (!config.features.tavily) {
    throw new Error('Tavily API key not configured');
  }

  const response = await axios.post(
    'https://api.tavily.com/search',
    {
      query: claim,
      max_results: config.tavily.maxResults,
      // "advanced" asks Tavily to do deeper content extraction — worth the extra
      // latency because snippet quality directly determines verdict quality.
      search_depth: 'advanced',
      include_answer: false, // we want raw evidence, not someone else's conclusion
    },
    {
      headers: {
        // Tavily's current API authenticates via bearer token. (The older
        // body-parameter style is deprecated.)
        Authorization: `Bearer ${config.tavily.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: config.tavily.timeoutMs,
    },
  );

  const results = response.data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Tavily returned no results');
  }

  return results.map((r) => ({
    title: r.title || 'Untitled source',
    content: r.content || '',
    url: r.url,
    score: typeof r.score === 'number' ? r.score : 0.5,
    provider: 'tavily',
  }));
}

/**
 * FALLBACK provider — DuckDuckGo via duck-duck-scrape.
 * No API key, no quota. Snippets are shorter than Tavily's, but a short real
 * snippet is still infinitely better than a hallucinated fact.
 */
async function searchDuckDuckGo(claim) {
  const response = await DDG.search(claim, { safeSearch: DDG.SafeSearchType.MODERATE });

  if (response.noResults || !Array.isArray(response.results)) {
    throw new Error('DuckDuckGo returned no results');
  }

  return response.results.slice(0, config.tavily.maxResults).map((r, index) => ({
    title: r.title || 'Untitled source',
    content: stripHtml(r.description || r.rawDescription || ''),
    url: r.url,
    // DuckDuckGo gives no relevance score, so we synthesise one from rank:
    // 1st result -> 0.9, decaying by 0.1 per position, floored at 0.3.
    score: Math.max(0.3, 0.9 - index * 0.1),
    provider: 'duckduckgo',
  }));
}

/**
 * SECOND FALLBACK — the Wikipedia API.
 *
 * Officially supported, keyless and rate-limit-friendly, so it is the tier that
 * makes "the app never goes down because one dependency ran out" actually true.
 * We search for relevant articles, then pull each article's lead section as the
 * evidence snippet.
 */
async function searchWikipedia(claim) {
  const common = {
    timeout: 10000,
    // Wikipedia asks API clients to identify themselves.
    headers: { 'User-Agent': 'TruthSource/2.0 (fact-checking research project)' },
  };

  // Step 1: which articles are relevant to this claim?
  const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
    params: {
      action: 'query',
      format: 'json',
      list: 'search',
      srsearch: claim,
      srlimit: Math.min(config.tavily.maxResults, 5),
    },
    ...common,
  });

  const hits = searchResponse.data?.query?.search || [];
  if (hits.length === 0) throw new Error('Wikipedia returned no results');

  // Step 2: fetch the lead extract + canonical URL for those articles in one call.
  const titles = hits.map((h) => h.title).join('|');
  const extractResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
    params: {
      action: 'query',
      format: 'json',
      prop: 'extracts|info',
      exintro: 1,
      explaintext: 1,
      inprop: 'url',
      titles,
    },
    ...common,
  });

  const pages = Object.values(extractResponse.data?.query?.pages || {});

  return pages
    .filter((p) => p.extract)
    .map((p, index) => ({
      title: `${p.title} (Wikipedia)`,
      content: p.extract.slice(0, 1500),
      url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      score: Math.max(0.3, 0.8 - index * 0.1),
      provider: 'wikipedia',
    }));
}

/**
 * Retrieve evidence for a single claim.
 *
 * Contract: this function NEVER throws. Downstream code can always assume it
 * receives an array (possibly empty). That guarantee is what lets the analysis
 * loop keep going when one claim's search misbehaves.
 *
 * @param {string} claim
 * @returns {Promise<EvidenceItem[]>}
 */
async function getEvidence(claim) {
  if (!claim || typeof claim !== 'string') return [];

  // --- Attempt 1: Tavily (RAG-optimised, ranked, clean) ---
  try {
    const results = await searchTavily(claim);
    log.info(`Tavily returned ${results.length} source(s)`, { claim: claim.slice(0, 60) });
    return results;
  } catch (error) {
    const status = error.response?.status;
    log.warn(`Tavily failed${status ? ` (HTTP ${status})` : ''}, falling back to DuckDuckGo`, error.message);
  }

  // --- Attempt 2: DuckDuckGo (keyless web search) ---
  try {
    const results = await searchDuckDuckGo(claim);
    if (results.length > 0) {
      log.info(`DuckDuckGo fallback returned ${results.length} source(s)`, { claim: claim.slice(0, 60) });
      return results;
    }
  } catch (error) {
    // duck-duck-scrape is an unofficial scraper, so DDG's bot detection trips it
    // on some networks. Expected — that is what tier 3 is for.
    log.warn('DuckDuckGo fallback failed, falling back to Wikipedia', error.message);
  }

  // --- Attempt 3: Wikipedia (official, keyless, highly available) ---
  try {
    const results = await searchWikipedia(claim);
    if (results.length > 0) {
      log.info(`Wikipedia fallback returned ${results.length} source(s)`, { claim: claim.slice(0, 60) });
      return results;
    }
  } catch (error) {
    log.error('All evidence providers failed — returning empty evidence', error.message);
  }

  // --- Everything failed: degrade honestly ---
  // An empty array is not a silent failure. The verdict stage sees "no evidence"
  // and returns UNVERIFIABLE with a reasoning string that says exactly that.
  return [];
}

module.exports = { getEvidence, searchTavily, searchDuckDuckGo, searchWikipedia };
