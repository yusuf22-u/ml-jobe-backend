import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { requestSwap, mySwaps, listSwaps, cancelSwap, reviewSwap } from '../controllers/swapController.js';

const router = Router();
router.use(authenticate);

router.get('/mine', mySwaps);
router.post('/', requestSwap);
router.delete('/:id', cancelSwap);

router.get('/', requireRole('SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'), listSwaps);
router.put('/:id/review', requireRole('SUPERVISOR', 'PLANT_MANAGER'), reviewSwap);

export default router;