import { Router } from 'express';
import leadsRouter  from './leads.js';
import scrapeRouter from './scrape.js';
import nearbyRouter from './nearby.js';
import visitsRouter from './visits.js';

const router = Router();

router.use('/leads',  leadsRouter);
router.use('/scrape', scrapeRouter);
router.use('/nearby', nearbyRouter);
router.use('/visits', visitsRouter);

export default router;
