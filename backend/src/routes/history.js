/**
 * History routes.
 *
 * Both endpoints answer successfully even when Postgres is unavailable: they
 * return `available: false` with an empty list so the UI can show a friendly
 * "history needs a database" panel instead of an error toast.
 */

const express = require('express');
const { getHistory, getStats } = require('../db/analysisRepository');
const { createLogger } = require('../utils/logger');

const log = createLogger('history');
const router = express.Router();

// GET /api/history?limit=20&offset=0
router.get('/history', async (req, res) => {
  // Clamp pagination inputs so a hand-crafted request cannot ask for everything.
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const { available, analyses } = await getHistory({ limit, offset });
    return res.json({
      available,
      analyses,
      // A hint the frontend renders verbatim, so the reason is never a mystery.
      message: available ? undefined : 'History is unavailable because PostgreSQL is not connected.',
    });
  } catch (error) {
    log.error('Failed to load history', error.message);
    return res.status(500).json({ available: false, analyses: [], error: 'Could not load history.' });
  }
});

// GET /api/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    return res.json({ available: Boolean(stats), stats: stats || null });
  } catch (error) {
    log.error('Failed to load stats', error.message);
    return res.status(500).json({ available: false, stats: null });
  }
});

module.exports = router;
