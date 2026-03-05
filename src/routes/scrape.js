import { Router } from 'express';
import * as scrapeController from '../controllers/scrapeController.js';

const router = Router();

// POST /api/scrape/start   – kick off a background scrape job
router.post('/start', scrapeController.startScrape);

// GET  /api/scrape/status  – poll job state (running, lines, done, error)
router.get('/status', scrapeController.getStatus);

export default router;
