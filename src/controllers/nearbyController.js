import * as leadsService  from '../services/leadsService.js';
import * as nearbyService from '../services/nearbyService.js';

/**
 * POST /api/nearby
 * Body: { origin: string, max_minutes?: number }
 * Returns all leads within max_minutes driving time of origin,
 * sorted by drive time ascending, each enriched with a drive_minutes field.
 */
export async function filterNearby(req, res) {
  try {
    const { origin, max_minutes = 30 } = req.body;

    if (!origin?.trim()) {
      return res.status(400).json({ error: 'origin is required' });
    }

    const apiKey = process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'GOOGLE_MAPS_KEY is not set in environment' });
    }

    const leads   = await leadsService.getAllLeads();
    const results = await nearbyService.filterByDistance(
      leads,
      origin.trim(),
      parseInt(max_minutes, 10) || 30,
      apiKey,
    );

    res.json(results);
  } catch (err) {
    console.error('filterNearby error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
