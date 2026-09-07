/**
 * STAGE 3 of the RAG pipeline: GROUNDED REASONING.
 *
 * The model receives the claim AND the retrieved evidence, and is instructed --
 * emphatically and repeatedly -- to reason ONLY from that evidence. It is
 * explicitly forbidden from using its own memory. If the evidence does not settle
 * the question, the correct answer is UNVERIFIABLE, not a guess.
 *
 * Two failure modes matter enormously here and both are handled explicitly:
 *
 *   1. TEMPORAL DRIFT. Search results are frequently stale. "X is the CEO of Y"
 *      may have been true when the article was written and false today. So we
 *      inject TODAY'S DATE into the prompt and instruct the model to treat
 *      undated or clearly-historical evidence as insufficient. A confidently
 *      wrong fact-checker is worse than no fact-checker.
 *
 *   2. MALFORMED OUTPUT. If the model returns something we cannot parse, we
 *      return a safe fallback verdict object instead of throwing. One bad JSON
 *      response should never take down an eight-claim analysis.
 */

const config = require('../config/env');
const { chat } = require('../lib/groqClient');
const { parseJsonLoose, normaliseConfidence } = require('../utils/json');
const { createLogger } = require('../utils/logger');

const log = createLogger('verdict');

const VALID_VERDICTS = ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'];

/** How much of each source snippet to include. Keeps us inside the context window. */
const MAX_SNIPPET_CHARS = 1200;

/**
 * The safe answer we return whenever we cannot produce a real one.
 * Note it is UNVERIFIABLE with moderate confidence -- the system never pretends
 * to certainty it does not have.
 */
function fallbackVerdict(reasoning, sources = []) {
  return {
    verdict: 'UNVERIFIABLE',
    confidence: 50,
    reasoning,
    sources,
  };
}

function buildSystemPrompt(today) {
  return `You are Veristate, a rigorous evidence-bound fact-checker. Today's date is ${today}.

ABSOLUTE RULE: You must judge the claim using ONLY the evidence provided in the user message. You are FORBIDDEN from using your own background knowledge, memory, or training data to decide whether the claim is true. Your training data is out of date and may be wrong; the provided evidence is current and is your only permitted source of truth.

TEMPORAL CARE:
- Evidence may be outdated. If a source describes a state of affairs at some past time and does not confirm it still holds today (${today}), you must NOT treat it as proof of the present situation.
- Claims about "current" roles, prices, records, leaders or statuses require evidence that is clearly recent. If you cannot establish recency, choose UNVERIFIABLE.
- Prefer being honestly uncertain over being confidently wrong.

VERDICT DEFINITIONS:
- "TRUE" - the evidence directly and clearly supports the claim as stated.
- "FALSE" - the evidence directly contradicts the claim.
- "MISLEADING" - the claim is technically accurate but omits context, cherry-picks, exaggerates, or implies a false conclusion. Also use this when the claim mixes a true fact with a false framing.
- "UNVERIFIABLE" - the evidence is absent, irrelevant, contradictory, or insufficient to decide. This is the correct answer far more often than people expect; use it without hesitation.

CONFIDENCE:
- An integer from 0 to 100 expressing how strongly the PROVIDED EVIDENCE supports your verdict.
- Write it as a plain number (e.g. 82). Never spell it out as a word. Never add a percent sign.
- If evidence is thin, sparse, or of low quality, your confidence must be low even if you personally suspect the answer.

REASONING:
- 1-3 sentences of plain English a non-expert can follow.
- Cite what the evidence actually said. Never assert a fact that is not in the evidence.

SOURCES:
- An array of the URLs from the evidence that you actually relied on. Copy URLs verbatim. Never invent a URL.

OUTPUT FORMAT - respond with ONLY this JSON object, no markdown fences, no prose:
{"verdict":"TRUE|FALSE|MISLEADING|UNVERIFIABLE","confidence":<integer 0-100>,"reasoning":"<1-3 sentences>","sources":["<url>"]}`;
}

/** Render the retrieved evidence array into the numbered text block the model reads. */
function formatEvidence(evidence) {
  return evidence
    .map((e, i) => {
      const snippet = (e.content || '').slice(0, MAX_SNIPPET_CHARS);
      const score = typeof e.score === 'number' ? e.score.toFixed(2) : 'n/a';
      return `--- SOURCE ${i + 1} ---\nTitle: ${e.title}\nURL: ${e.url}\nRelevance: ${score}\nExcerpt: ${snippet}`;
    })
    .join('\n\n');
}

/**
 * Produce a grounded verdict for one claim.
 *
 * Contract: NEVER throws. Always resolves to a well-formed verdict object.
 *
 * @param {string} claim
 * @param {Array<{title:string,content:string,url:string,score:number}>} evidence
 * @returns {Promise<{verdict:string, confidence:number, reasoning:string, sources:string[]}>}
 */
async function getVerdict(claim, evidence) {
  // Short-circuit: with zero evidence there is nothing to reason over. Calling
  // the model here would invite exactly the memory-based guessing that RAG
  // exists to prevent -- so we do not call it at all.
  if (!Array.isArray(evidence) || evidence.length === 0) {
    log.warn('No evidence available; returning UNVERIFIABLE without calling the model');
    return fallbackVerdict(
      'No supporting evidence could be retrieved from the web for this claim, so it cannot be verified either way.',
    );
  }

  const today = new Date().toISOString().split('T')[0];
  const knownUrls = new Set(evidence.map((e) => e.url));

  let raw;
  try {
    raw = await chat({
      messages: [
        { role: 'system', content: buildSystemPrompt(today) },
        {
          role: 'user',
          content: `CLAIM TO VERIFY:\n"${claim}"\n\nEVIDENCE (your only permitted source of truth):\n\n${formatEvidence(evidence)}`,
        },
      ],
      model: config.groq.textModel,
      temperature: 0,
      label: 'getVerdict',
    });
  } catch (error) {
    log.error('Groq call failed during verdict generation', error.message);
    // Degrade, do not crash: the user still gets the claim and its real sources.
    return fallbackVerdict(
      'The reasoning service was temporarily unavailable, so this claim could not be evaluated. The retrieved sources are listed below for manual review.',
      evidence.map((e) => e.url),
    );
  }

  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') {
    log.warn('Unparseable verdict JSON; using safe fallback', String(raw).slice(0, 200));
    return fallbackVerdict(
      'The analysis produced a malformed response, so no reliable verdict could be formed for this claim.',
      evidence.map((e) => e.url),
    );
  }

  // --- Validate and normalise every field defensively ---

  const verdict = VALID_VERDICTS.includes(String(parsed.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'UNVERIFIABLE';

  const confidence = normaliseConfidence(parsed.confidence);

  const reasoning =
    typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : 'No reasoning was provided for this verdict.';

  // Anti-hallucination guard: discard any URL the model produced that was not in
  // the evidence we actually retrieved. A fact-checker that cites a fabricated
  // source is worse than useless, so we only ever surface URLs we really fetched.
  const modelSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  let sources = modelSources.filter((u) => typeof u === 'string' && knownUrls.has(u));
  if (sources.length === 0) {
    // The model cited nothing usable -- fall back to showing all retrieved
    // sources so the user always has something to click through and check.
    sources = evidence.map((e) => e.url);
  }

  return { verdict, confidence, reasoning, sources };
}

module.exports = { getVerdict, VALID_VERDICTS, fallbackVerdict };
