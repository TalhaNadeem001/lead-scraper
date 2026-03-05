import * as leadsService from '../services/leadsService.js';

/**
 * GET /api/leads
 * Returns all leads with merged CRM fields (met, notes).
 */
export async function getLeads(req, res) {
  try {
    const leads = await leadsService.getAllLeads();
    res.json(leads);
  } catch (err) {
    console.error('getLeads error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * PATCH /api/leads/:id
 * Body: { met?: boolean, notes?: string }
 * Updates CRM-managed fields for a single lead.
 */
export async function updateLead(req, res) {
  try {
    const { id } = req.params;
    const { met, notes } = req.body;

    if (!id) return res.status(400).json({ error: 'id required' });

    await leadsService.updateCRM(id, { met, notes });
    res.json({ ok: true });
  } catch (err) {
    console.error('updateLead error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
