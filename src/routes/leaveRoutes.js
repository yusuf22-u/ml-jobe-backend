import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  submitLeave, leaveBalance, myLeave, listLeave, cancelLeave, reviewLeave,
} from '../controllers/leaveController.js';

const router = Router();
router.use(authenticate);

router.get('/balance', leaveBalance);
router.get('/mine', myLeave);
router.post('/', submitLeave);
router.delete('/:id', cancelLeave);

router.get('/', requireRole('SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'), listLeave);
router.put('/:id/review', requireRole('SUPERVISOR', 'PLANT_MANAGER'), reviewLeave);

export default router;