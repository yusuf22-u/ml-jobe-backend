import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { listShifts, createShift, updateShift } from '../controllers/shiftController.js';

const router = Router();
router.use(authenticate);
router.get('/', listShifts);
router.post('/', requireRole('SUPERVISOR'), createShift);
router.put('/:id', requireRole('SUPERVISOR'), updateShift);
export default router;