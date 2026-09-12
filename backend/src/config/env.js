/**
 * Central configuration.
 *
 * Every secret lives in .env (never in source control — see .env.example for the
 * shape). This module is the ONLY place that reads process.env, so the rest of the
 * codebase depends on a typed, validated object instead of scattered env lookups.
 *
 * Design note: nothing here throws. TruthSource is built to degrade gracefully —
 * a missing Firecrawl key should disable URL scraping, not take the whole server
 * down. Callers check the `features` flags before using an optional integration.
 */

require('dotenv').config();

const path = require('path');

const config = {
  // ---- Server ----------------------------------------------------------
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  // Comma-separated list of allowed browser origins. '*' allows everything,
  // which is the sane default for a local hackathon demo + a browser extension
  // (extensions send an origin of chrome-extension://<id>).
  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((o) => o.trim()),

  // ---- AI (Groq) -------------------------------------------------------
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    // Text reasoning model: claim extraction + verdict generation.
    textModel: process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b',
    // Vision model: reads claims out of screenshots and video frames.
    visionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
    // Speech-to-text for the video pipeline.
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  },

  // ---- Evidence retrieval ---------------------------------------------
  tavily: {
    apiKey: process.env.TAVILY_API_KEY,
    maxResults: Number(process.env.TAVILY_MAX_RESULTS) || 5,
    // Hard timeout so a hanging search can never hang a user request.
    timeoutMs: Number(process.env.TAVILY_TIMEOUT_MS) || 15000,
  },

  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY,
  },

  // ---- Persistence -----------------------------------------------------
  database: {
    // Either a full connection string...
    url: process.env.DATABASE_URL,
    // ...or discrete parts, whichever the user finds easier.
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    name: process.env.PGDATABASE || 'truthsource',
    ssl: process.env.PGSSL === 'true',
  },

  // ---- Uploads ---------------------------------------------------------
  uploads: {
    dir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'),
    maxImageBytes: Number(process.env.MAX_IMAGE_BYTES) || 10 * 1024 * 1024, // 10 MB
    maxVideoBytes: Number(process.env.MAX_VIDEO_BYTES) || 200 * 1024 * 1024, // 200 MB
  },

  // ---- Video pipeline --------------------------------------------------
  video: {
    // Audio is transcribed in fixed-length chunks so verdicts can stream back
    // progressively instead of the user staring at a spinner for 10 minutes.
    // This chunked design is also what makes a future LIVE-stream mode possible:
    // swap the "read chunk from a file" source for "read chunk from a live feed"
    // and the rest of the pipeline is unchanged.
    chunkSeconds: Number(process.env.VIDEO_CHUNK_SECONDS) || 120,
  },

  // ---- Telegram --------------------------------------------------------
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    // The bot talks to the same HTTP API the web app uses — one pipeline, many surfaces.
    apiBaseUrl: process.env.TRUTHSOURCE_API_URL || 'http://localhost:3000',
  },
};

/**
 * Feature flags derived from which credentials are actually present.
 * Routes consult these to return a helpful 503 ("Firecrawl not configured")
 * instead of an opaque crash.
 */
config.features = {
  groq: Boolean(config.groq.apiKey),
  tavily: Boolean(config.tavily.apiKey),
  firecrawl: Boolean(config.firecrawl.apiKey),
  database: Boolean(config.database.url || config.database.password !== undefined),
};

module.exports = config;
