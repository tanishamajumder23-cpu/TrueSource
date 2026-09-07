/**
 * The Veristate pipeline -- the single place where the RAG flow is assembled.
 *
 *      text / url / image / video
 *                 |
 *        [1] extractClaims        (decompose into atomic assertions)
 *                 |
 *        for each claim:
 *          [2] getEvidence        (RETRIEVE real, live web documents)
 *          [3] getVerdict         (reason ONLY over what was retrieved)
 *                 |
 *          structured verdict + clickable sources
 *
 * Every ingestion surface -- the web app, the Telegram bot, the browser
 * extension -- funnels into this exact function. One pipeline, many front doors:
 * a fix to the reasoning benefits all three at once.
 *
 * Claims are processed with bounded concurrency. Sequential would be needlessly
 * slow for an eight-claim article; unbounded would hammer the search API into a
 * rate limit and trigger the fallback path unnecessarily.
 */

const { extractClaims } = require('./claimExtractor');
const { getEvidence } = require('./evidence');
const { getVerdict } = require('./verdict');
const { domainOf } = require('./scraper');
const { createLogger } = require('../utils/logger');

const log = createLogger('pipeline');

/** How many claims to check at once. Tuned for Tavily's free-tier rate limits. */
const CONCURRENCY = 3;

/**
 * Attach display metadata (title, domain) to the URLs a verdict cited, by
 * matching them back against the evidence we actually retrieved.
 */
function enrichSources(sourceUrls, evidence) {
  return sourceUrls.map((url) => {
    const match = evidence.find((e) => e.url === url);
    return {
      url,
      title: match?.title || domainOf(url),
      domain: domainOf(url),
      provider: match?.provider || 'unknown',
    };
  });
}

/**
 * Run retrieval + reasoning for ONE claim.
 * Never throws: a failure becomes an UNVERIFIABLE result so the batch survives.
 *
 * @param {string} claim
 * @param {object} [meta] - extra fields to merge into the result (e.g. video timestamp)
 */
async function checkClaim(claim, meta = {}) {
  try {
    // [2] RETRIEVE. Real documents from the live web -- never the model's memory.
    const evidence = await getEvidence(claim);

    // [3] REASON, strictly over what step 2 returned.
    const verdict = await getVerdict(claim, evidence);

    return {
      claim,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      reasoning: verdict.reasoning,
      sources: enrichSources(verdict.sources, evidence),
      evidenceCount: evidence.length,
      // Which provider answered tells the user (and the demo audience) whether
      // the Tavily -> DuckDuckGo fallback kicked in.
      evidenceProvider: evidence[0]?.provider || 'none',
      ...meta,
    };
  } catch (error) {
    log.error('Unexpected failure while checking a claim', error.message);
    return {
      claim,
      verdict: 'UNVERIFIABLE',
      confidence: 0,
      reasoning: 'An unexpected error occurred while checking this claim.',
      sources: [],
      evidenceCount: 0,
      evidenceProvider: 'none',
      ...meta,
    };
  }
}

/**
 * Check a list of claims with bounded concurrency, emitting each result the
 * moment it is ready.
 *
 * Results are pushed to `onResult` out of order (whichever finishes first) but
 * the returned array is restored to the original claim order, so a streaming
 * consumer gets speed and a batch consumer gets determinism.
 *
 * @param {string[]} claims
 * @param {{ onResult?: (result:object, index:number) => void, meta?: (i:number)=>object }} options
 * @returns {Promise<object[]>}
 */
async function checkClaims(claims, options = {}) {
  const { onResult, meta } = options;
  const results = new Array(claims.length);
  let cursor = 0;

  async function worker() {
    while (cursor < claims.length) {
      const index = cursor;
      cursor += 1;
      const result = await checkClaim(claims[index], meta ? meta(index) : {});
      results[index] = result;
      if (onResult) {
        try {
          onResult(result, index);
        } catch (error) {
          // A broken consumer (e.g. a closed SSE socket) must not abort analysis.
          log.warn('onResult consumer threw; continuing', error.message);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claims.length) }, worker));
  return results;
}

/**
 * Full pipeline for a block of text: decompose, then check every claim.
 *
 * @param {string} text
 * @param {{ onClaims?: (claims:string[])=>void, onResult?: Function, meta?: Function }} options
 * @returns {Promise<{ claims: string[], results: object[] }>}
 */
async function analyzeText(text, options = {}) {
  // [1] DECOMPOSE.
  const claims = await extractClaims(text);

  if (options.onClaims) options.onClaims(claims);

  if (claims.length === 0) {
    log.info('No verifiable claims found in input');
    return { claims: [], results: [] };
  }

  const results = await checkClaims(claims, options);
  return { claims, results };
}

/**
 * Aggregate a set of results into the headline numbers the UI shows at the top
 * of a report.
 */
function summarise(results) {
  const counts = { TRUE: 0, FALSE: 0, MISLEADING: 0, UNVERIFIABLE: 0 };
  for (const r of results) {
    if (counts[r.verdict] !== undefined) counts[r.verdict] += 1;
  }

  const decided = counts.TRUE + counts.FALSE + counts.MISLEADING;

  return {
    total: results.length,
    counts,
    // A single "how trustworthy was this overall" figure: the share of decided
    // claims that checked out as true. Null when nothing could be decided, so
    // the UI can say "inconclusive" rather than show a misleading 0%.
    trustScore: decided > 0 ? Math.round((counts.TRUE / decided) * 100) : null,
  };
}

module.exports = { analyzeText, checkClaim, checkClaims, summarise, enrichSources };
