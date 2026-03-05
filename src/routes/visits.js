import { Router } from 'express';
import * as visitsController from '../controllers/visitsController.js';

const router = Router();

// GET  /api/visits/followups    – all scheduled follow-ups (must be before /:leadId)
router.get('/followups', visitsController.getFollowups);

// GET  /api/visits/:leadId      – visits for a specific lead
router.get('/:leadId', visitsController.getVisits);

// POST /api/visits              – log a new visit
router.post('/', visitsController.createVisit);

// PATCH /api/visits/:id         – update a visit
router.patch('/:id', visitsController.updateVisit);

// DELETE /api/visits/:id        – remove a visit
router.delete('/:id', visitsController.deleteVisit);

export default router;
