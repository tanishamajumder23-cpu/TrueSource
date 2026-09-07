/**
 * Shared Groq client + a thin retry wrapper.
 *
 * One authenticated client is reused across the whole process (creating a new
 * one per request would be wasteful and would lose keep-alive connections).
 *
 * `withRetry` exists because rate limits (429) and transient 5xx responses are
 * normal at hackathon-demo traffic levels. We retry with exponential backoff on
 * *retryable* errors only — a 401 (bad key) will never succeed on retry, so we
 * fail fast there instead of burning ten seconds.
 */

const Groq = require('groq-sdk');
const config = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('groq');

if (!config.features.groq) {
  log.warn('GROQ_API_KEY is not set — AI features will return graceful errors.');
}

// The SDK tolerates an undefined key at construction time; calls will fail with
// a clear auth error which our error handling surfaces to the user.
const groq = new Groq({ apiKey: config.groq.apiKey });

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

function isRetryable(error) {
  const status = error?.status || error?.response?.status;
  if (status && RETRYABLE_STATUSES.has(status)) return true;
  // Network-level hiccups have no HTTP status at all.
  const code = error?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async Groq call, retrying transient failures with exponential backoff.
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseDelayMs?: number, label?: string }} options
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, { attempts = 3, baseDelayMs = 600, label = 'call' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log.warn(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms`, error.message);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Convenience wrapper: a chat completion with sane defaults + retry. */
async function chat({ messages, model = config.groq.textModel, temperature = 0.1, label = 'chat', responseFormat }) {
  const response = await withRetry(
    () =>
      groq.chat.completions.create({
        messages,
        model,
        // Low temperature: fact-checking wants determinism, not creativity.
        temperature,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    { label },
  );

  return response.choices?.[0]?.message?.content ?? '';
}

module.exports = { groq, chat, withRetry, isRetryable };
