/**
 * STAGE 1 of the RAG pipeline: decomposition.
 *
 * Real-world content ("The vaccine was approved in 2019 and the CEO resigned
 * last week") bundles several independent assertions together. Fact-checking the
 * paragraph as a single unit produces mush — one true half and one false half
 * average out into a useless "MISLEADING".
 *
 * So before we retrieve anything, we split the input into atomic, independently
 * checkable claims. Each claim then gets its OWN evidence retrieval and its OWN
 * verdict, which is what makes the final output specific and actionable.
 *
 * Note what this stage does NOT do: it never judges truth. It is pure
 * decomposition. Truth only enters the system in stage 3, and only from
 * retrieved evidence.
 */

const config = require('../config/env');
const { chat } = require('../lib/groqClient');
const { parseJsonLoose } = require('../utils/json');
const { createLogger } = require('../utils/logger');

const log = createLogger('claims');

// Guard rails: a scraped article can be enormous, and a 40-claim result would
// take minutes to check and cost a fortune in search calls.
const MAX_INPUT_CHARS = 12000;
const MAX_CLAIMS = 8;

const SYSTEM_PROMPT = `You are a claim extraction engine for a fact-checking system.

Your job is to split the user's text into distinct, atomic, VERIFIABLE factual claims.

Rules:
- A claim must be objectively checkable against public evidence (statistics, events, dates, attributions, scientific statements).
- EXCLUDE opinions, predictions about the future, value judgements, questions, and rhetorical flourishes.
- Each claim must be SELF-CONTAINED: resolve pronouns and vague references using the surrounding context, so the claim makes sense on its own with no other text.
- Do not merge two assertions into one claim. Do not split a single assertion into fragments.
- Preserve the original meaning faithfully. Never add facts that are not in the text.
- Return at most ${MAX_CLAIMS} claims, prioritising the most consequential ones.
- If the text contains no verifiable factual claims, return an empty array.

Respond with ONLY a JSON array of strings. No markdown, no prose, no explanation.
Example valid response: ["The Eiffel Tower was completed in 1889.", "Paris has a population of over 10 million."]`;

/**
 * Extract atomic factual claims from a block of text.
 *
 * @param {string} text - raw user text, or the markdown of a scraped article
 * @returns {Promise<string[]>} claims (possibly empty — never null, never throws
 *   for model-formatting reasons)
 */
async function extractClaims(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    log.warn('Input too short to contain claims');
    return [];
  }

  // Truncate rather than reject: analysing the first 12k characters of a long
  // article is far more useful to the user than an error message.
  const input = text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n\n[...truncated]` : text;

  let raw;
  try {
    raw = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Text to analyse:\n"""\n${input}\n"""` },
      ],
      model: config.groq.textModel,
      temperature: 0,
      label: 'extractClaims',
    });
  } catch (error) {
    // The AI provider is unreachable. Surface this to the route so the user gets
    // a clear "AI service unavailable" message rather than "no claims found".
    log.error('Groq call failed during claim extraction', error.message);
    const wrapped = new Error('Claim extraction failed: the AI service is unavailable.');
    wrapped.code = 'AI_UNAVAILABLE';
    throw wrapped;
  }

  const parsed = parseJsonLoose(raw);

  // Accept both the requested shape (["a","b"]) and the common model deviation
  // ({ "claims": ["a","b"] }) — being liberal in what we accept costs nothing.
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.claims) ? parsed.claims : null;

  if (!list) {
    log.warn('Could not parse claim list from model output', raw.slice(0, 200));
    return [];
  }

  const claims = list
    .filter((c) => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 8) // drop fragments like "yes" or "N/A"
    .slice(0, MAX_CLAIMS);

  log.info(`Extracted ${claims.length} claim(s)`);
  return claims;
}

module.exports = { extractClaims, MAX_CLAIMS };
