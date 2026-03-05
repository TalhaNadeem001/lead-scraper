import * as visitsService from '../services/visitsService.js';

/** GET /api/visits/followups — all scheduled follow-ups across all leads */
export async function getFollowups(req, res) {
  try {
    const followups = await visitsService.getAllFollowups();
    res.json(followups);
  } catch (err) {
    console.error('getFollowups error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/** GET /api/visits/:leadId — all visits for one lead */
export async function getVisits(req, res) {
  try {
    const visits = await visitsService.getVisitsForLead(req.params.leadId);
    res.json(visits);
  } catch (err) {
    console.error('getVisits error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/** POST /api/visits — log a new visit */
export async function createVisit(req, res) {
  try {
    const { leadId, visitedAt, type, notes, outcome, followupAt } = req.body;
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });

    const visit = await visitsService.createVisit({ leadId, visitedAt, type, notes, outcome, followupAt });
    res.status(201).json(visit);
  } catch (err) {
    console.error('createVisit error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/** PATCH /api/visits/:id — update a visit */
export async function updateVisit(req, res) {
  try {
    const visit = await visitsService.updateVisit(req.params.id, req.body);
    if (!visit) return res.status(404).json({ error: 'visit not found' });
    res.json(visit);
  } catch (err) {
    console.error('updateVisit error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/** DELETE /api/visits/:id — remove a visit */
export async function deleteVisit(req, res) {
  try {
    await visitsService.deleteVisit(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteVisit error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
