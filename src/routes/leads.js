import { Router } from 'express';
import * as leadsController from '../controllers/leadsController.js';

const router = Router();

// GET  /api/leads       – fetch all leads (with CRM fields)
router.get('/', leadsController.getLeads);

// PATCH /api/leads/:id  – update met status and/or notes for a lead
router.patch('/:id', leadsController.updateLead);

export default router;
