/**
 * Veristate API server.
 *
 * Composition root: wires middleware, routes and the database together and
 * starts listening. All real work lives in services/; this file is deliberately
 * boring and easy to read top to bottom.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const config = require('./config/env');
const { initDatabase, isAvailable, closeDatabase } = require('./db/pool');
const analyzeRoutes = require('./routes/analyze');
const historyRoutes = require('./routes/history');
const { createLogger } = require('./utils/logger');

const log = createLogger('server');
const app = express();

// --------------------------------------------------------------------------
//  Middleware
// --------------------------------------------------------------------------

app.use(
  cors({
    // '*' (the default) keeps local dev and the browser extension frictionless.
    // Set CORS_ORIGINS in .env to lock this down for a real deployment.
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  }),
);

// Scraped articles and extension page-text can be large, so raise the default 100kb.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Lightweight request log: one line in, one line out with the duration.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// --------------------------------------------------------------------------
//  Routes
// --------------------------------------------------------------------------

/**
 * Health check. Reports which integrations are actually configured, which makes
 * "why isn't X working?" a one-request question during a demo.
 */
app.get('/', (req, res) => {
  res.json({
    name: 'Veristate API',
    status: 'ok',
    version: '2.0.0',
    time: new Date().toISOString(),
    features: {
      ai: config.features.groq,
      evidenceTavily: config.features.tavily,
      evidenceFallbackDuckDuckGo: true, // keyless: always available
      urlScraping: config.features.firecrawl,
      database: isAvailable(),
    },
  });
});

app.use('/api', analyzeRoutes);
app.use('/api', historyRoutes);

// --------------------------------------------------------------------------
//  Error handling
// --------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// Express recognises an error handler by its four-argument signature.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  // Turn multer's terse codes into messages a user can act on.
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large. Images are limited to 10 MB and videos to 200 MB.'
        : `Upload failed: ${error.message}`;
    return res.status(413).json({ error: message });
  }

  if (error.code === 'BAD_FILE_TYPE') {
    return res.status(415).json({ error: error.message });
  }

  log.error('Unhandled error', error.stack || error.message);

  // If a stream is already in flight the headers are gone; just end it.
  if (res.headersSent) return res.end();

  return res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

// --------------------------------------------------------------------------
//  Startup
// --------------------------------------------------------------------------

async function start() {
  // Connect to Postgres first so the health check reports the truth. This never
  // throws: an unreachable database downgrades to no-persistence mode.
  await initDatabase();

  const server = app.listen(config.port, () => {
    log.info(`Veristate API listening on http://localhost:${config.port}`);
    if (!config.features.groq) log.warn('GROQ_API_KEY missing - analysis will fail until it is set.');
    if (!config.features.tavily) log.warn('TAVILY_API_KEY missing - evidence retrieval will use DuckDuckGo only.');
    if (!config.features.firecrawl) log.warn('FIRECRAWL_API_KEY missing - URL scraping is disabled.');
  });

  // A crash in async code should not leave the process in a zombie state, but
  // neither should it kill an in-flight demo. Log loudly and keep serving.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : reason);
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received - shutting down.`);
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only auto-start when run directly, so tests can import the app.
if (require.main === module) start();

module.exports = { app, start };
