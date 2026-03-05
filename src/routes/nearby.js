import { Router } from 'express';
import * as nearbyController from '../controllers/nearbyController.js';

const router = Router();

// POST /api/nearby – filter leads by driving distance from an origin address
router.post('/', nearbyController.filterNearby);

export default router;
