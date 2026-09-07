/**
 * Robust JSON extraction from LLM output.
 *
 * Even with "respond ONLY with JSON" instructions, language models occasionally
 * wrap their answer in ```json fences or add a sentence of preamble. Rather than
 * letting JSON.parse throw (and take a request down with it), we:
 *   1. strip markdown code fences,
 *   2. try a straight parse,
 *   3. fall back to slicing out the outermost {...} or [...] block,
 *   4. return null so the caller can apply a safe domain-specific fallback.
 *
 * Returning null instead of throwing is intentional: at every call site there is
 * a sensible degraded answer (an UNVERIFIABLE verdict, an empty claim list), and
 * a degraded answer beats a 500.
 */

/** Remove ```json ... ``` / ``` ... ``` fences an LLM may have added. */
function stripCodeFences(text) {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * Parse LLM output into JSON.
 * @param {string} raw - the model's raw message content
 * @returns {any|null} parsed value, or null if nothing JSON-shaped was found
 */
function parseJsonLoose(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const cleaned = stripCodeFences(raw);

  // Happy path: the model obeyed and returned pure JSON.
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to salvage attempt */
  }

  // Salvage: find the first '{' or '[' and the matching last '}' or ']'.
  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const candidates = [];

  if (firstArray !== -1) candidates.push([firstArray, cleaned.lastIndexOf(']')]);
  if (firstObject !== -1) candidates.push([firstObject, cleaned.lastIndexOf('}')]);

  // Prefer whichever bracket appeared first in the string.
  candidates.sort((a, b) => a[0] - b[0]);

  for (const [start, end] of candidates) {
    if (start === -1 || end === -1 || end <= start) continue;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/**
 * Coerce a confidence value into a plain integer 0-100.
 * Models sometimes return "82%", "0.82", or the word "eighty-two"; we normalise
 * everything we reasonably can and fall back to a neutral 50.
 */
function normaliseConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // A model returning 0.82 almost certainly means 82%.
    const scaled = value > 0 && value <= 1 ? value * 100 : value;
    return Math.max(0, Math.min(100, Math.round(scaled)));
  }
  if (typeof value === 'string') {
    const match = value.match(/\d+(\.\d+)?/);
    if (match) return normaliseConfidence(Number(match[0]));
  }
  return 50; // neutral: "we genuinely don't know how sure we are"
}

module.exports = { parseJsonLoose, stripCodeFences, normaliseConfidence };
