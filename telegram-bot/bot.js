#!/usr/bin/env node
/**
 * TruthLens Telegram bot.
 *
 * ── Why this is a separate process that talks HTTP ───────────────────────
 * The bot does NOT import the pipeline directly. It calls the same public API
 * the web app uses. That is a deliberate architectural choice:
 *
 *   - one implementation of the fact-checking logic, so a fix to the reasoning
 *     lands on every surface at once;
 *   - the bot can run on a different machine (or be turned off entirely)
 *     without touching the API;
 *   - the API contract gets exercised by a real second consumer, which is how
 *     you find out your own interface is awkward.
 *
 * Run it with:  npm run bot
 *
 * Send it a message, a link, a photo or a text document and it replies with a
 * formatted verdict per claim.
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('../backend/src/config/env');
const { createLogger } = require('../backend/src/utils/logger');

const log = createLogger('telegram');

if (!config.telegram.token) {
  console.error(
    '\nTELEGRAM_BOT_TOKEN is not set.\n\n' +
      'Get one by messaging @BotFather on Telegram (/newbot), then add it to .env:\n' +
      '  TELEGRAM_BOT_TOKEN=123456:ABC-your-token\n',
  );
  process.exit(1);
}

const API = config.telegram.apiBaseUrl;

// Long polling keeps setup to zero: no public URL, no webhook, no tunnel.
const bot = new TelegramBot(config.telegram.token, { polling: true });

// --------------------------------------------------------------------------
//  Formatting
// --------------------------------------------------------------------------

const VERDICT_EMOJI = {
  TRUE: '✅',
  FALSE: '❌',
  MISLEADING: '⚠️',
  UNVERIFIABLE: '❔',
};

/**
 * Escape the characters Telegram's MarkdownV2 parser treats as syntax.
 * Missing one of these makes the whole message fail to send, so the list is
 * exhaustive and applied to every piece of user/model text we interpolate.
 */
function escapeMd(text = '') {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** A visual confidence bar — Telegram has no progress widget, so we draw one. */
function confidenceBar(confidence) {
  const filled = Math.round(confidence / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/** Render one claim's verdict as a MarkdownV2 message block. */
function formatResult(result, index) {
  const emoji = VERDICT_EMOJI[result.verdict] || '❔';

  const lines = [
    `${emoji} *${escapeMd(result.verdict)}* · ${escapeMd(String(result.confidence))}%`,
    `\`${confidenceBar(result.confidence)}\``,
    '',
    `*Claim ${index + 1}:* ${escapeMd(result.claim)}`,
    '',
    `_${escapeMd(result.reasoning)}_`,
  ];

  if (result.sources?.length > 0) {
    lines.push('', '*Sources:*');
    // Cap at 3: a chat message with eight links is unreadable on a phone.
    for (const source of result.sources.slice(0, 3)) {
      lines.push(`• [${escapeMd(source.domain)}](${source.url})`);
    }
  }

  return lines.join('\n');
}

/** The one-line headline sent before the individual verdicts. */
function formatSummary(summary) {
  const parts = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${VERDICT_EMOJI[verdict]} ${count}`)
    .join('  ');

  return `📊 *${summary.total}* claim${summary.total === 1 ? '' : 's'} checked   ${parts}`;
}

// --------------------------------------------------------------------------
//  Core: run the pipeline over some text and reply
// --------------------------------------------------------------------------

async function analyzeAndReply(chatId, text) {
  // "typing…" is the only progress affordance Telegram gives us, and analysis
  // takes several seconds, so keep it alive rather than firing it once.
  const typing = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const { data } = await axios.post(
      `${API}/api/analyze`,
      { text, surface: 'telegram' },
      { timeout: 180000 }, // fact-checking several claims is genuinely slow
    );

    if (!data.results || data.results.length === 0) {
      await bot.sendMessage(
        chatId,
        "I couldn't find any verifiable factual claims in that. Try something that states a fact — a statistic, a date, an event, or an attribution.",
      );
      return;
    }

    await bot.sendMessage(chatId, formatSummary(data.summary), { parse_mode: 'MarkdownV2' });

    // One message per claim: each verdict is independently forwardable, which is
    // how debunks actually spread in group chats.
    for (let i = 0; i < data.results.length; i += 1) {
      await bot.sendMessage(chatId, formatResult(data.results[i], i), {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });
    }
  } catch (error) {
    log.error('Analysis request failed', error.message);

    const message =
      error.response?.data?.error ||
      (error.code === 'ECONNREFUSED'
        ? `I can't reach the TruthLens API at ${API}. Is the backend running?`
        : 'Something went wrong while checking that. Please try again.');

    await bot.sendMessage(chatId, `⚠️ ${message}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

// --------------------------------------------------------------------------
//  Commands
// --------------------------------------------------------------------------

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      '*TruthLens* — fact\\-check anything, right here in chat\\.',
      '',
      'Send me:',
      '• any *text* or forwarded message',
      '• a *link* to an article',
      '• a *screenshot* of a post',
      '',
      "I break it into individual claims, search the live web for real evidence, and reply with a verdict and sources for each one\\. I never answer from memory — every verdict is grounded in something you can click and check\\.",
      '',
      'Try: `The Great Wall of China is visible from space\\.`',
    ].join('\n'),
    { parse_mode: 'MarkdownV2' },
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Send me text, a link, or a screenshot and I will fact-check it.\n\n/start — what I do\n/help — this message',
  );
});

// --------------------------------------------------------------------------
//  Message handlers
// --------------------------------------------------------------------------

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Commands are handled by onText above; don't double-process them.
  if (msg.text?.startsWith('/')) return;

  // ---- Photos: download, then hand to the image endpoint ----
  if (msg.photo) {
    try {
      bot.sendChatAction(chatId, 'typing').catch(() => {});

      // Telegram sends several resolutions; the last is the largest, which is
      // what the vision model needs to read small text reliably.
      const largest = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(largest.file_id);

      const image = await axios.get(fileLink, { responseType: 'arraybuffer', timeout: 30000 });

      const form = new FormData();
      form.append('image', new Blob([image.data], { type: 'image/jpeg' }), 'screenshot.jpg');

      const { data } = await axios.post(`${API}/api/analyze-image`, form, { timeout: 180000 });

      if (!data.results?.length) {
        await bot.sendMessage(chatId, "I read that image but couldn't find any checkable factual claims in it.");
        return;
      }

      await bot.sendMessage(chatId, formatSummary(data.summary), { parse_mode: 'MarkdownV2' });
      for (let i = 0; i < data.results.length; i += 1) {
        await bot.sendMessage(chatId, formatResult(data.results[i], i), {
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        });
      }
    } catch (error) {
      log.error('Image analysis failed', error.message);
      await bot
        .sendMessage(chatId, `⚠️ ${error.response?.data?.error || "I couldn't read that image. Try sending it as text."}`)
        .catch(() => {});
    }
    return;
  }

  // ---- Plain-text documents: read the contents and check them ----
  if (msg.document) {
    const isText = /^(text\/|application\/json)/.test(msg.document.mime_type || '');
    if (!isText) {
      await bot.sendMessage(chatId, 'I can read text documents, images and links. That file type is not supported yet.');
      return;
    }
    try {
      const fileLink = await bot.getFileLink(msg.document.file_id);
      const { data: contents } = await axios.get(fileLink, { timeout: 30000, responseType: 'text' });
      await analyzeAndReply(chatId, String(contents).slice(0, 12000));
    } catch (error) {
      log.error('Document analysis failed', error.message);
      await bot.sendMessage(chatId, "⚠️ I couldn't read that document.").catch(() => {});
    }
    return;
  }

  // ---- Text and links ----
  const text = msg.text || msg.caption;
  if (!text) return;

  if (text.trim().length < 10) {
    await bot.sendMessage(chatId, 'Send me a bit more — a full claim, a paragraph, or a link.');
    return;
  }

  await analyzeAndReply(chatId, text.trim());
});

// --------------------------------------------------------------------------
//  Resilience
// --------------------------------------------------------------------------

// A polling error (network blip, Telegram hiccup) must be logged, never fatal:
// the library retries on its own, and crashing would take the bot offline.
bot.on('polling_error', (error) => {
  log.warn('Polling error', error.message);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', reason instanceof Error ? reason.message : reason);
});

log.info(`TruthLens Telegram bot is running. Talking to the API at ${API}`);
log.info('Message your bot on Telegram to try it.');
