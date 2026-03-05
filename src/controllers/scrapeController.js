import * as scrapeService from '../services/scrapeService.js';

/**
 * POST /api/scrape/start
 * Body: { location: string, limit?: number, min_score?: number, reset?: boolean }
 * Starts a background scrape job. Returns 409 if one is already running.
 */
export async function startScrape(req, res) {
  try {
    const { location, limit = 20, min_score = 6, reset = false } = req.body;

    if (!location?.trim()) {
      return res.status(400).json({ error: 'location is required' });
    }

    await scrapeService.startScrape({
      location: location.trim(),
      limit:    Math.max(1, Math.min(parseInt(limit, 10)     || 20,  100)),
      minScore: Math.max(1, Math.min(parseInt(min_score, 10) || 6,   10)),
      reset:    Boolean(reset),
    });

    res.json({ ok: true });
  } catch (err) {
    const status = err.message.includes('already in progress') ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
}

/**
 * GET /api/scrape/status
 * Returns current scrape state: { running, lines, done, error }
 */
export function getStatus(req, res) {
  res.json(scrapeService.scrapeState);
}
