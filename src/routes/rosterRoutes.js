import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  listRoster, myRoster, availableEmployees, createRoster,colleagueRoster, updateRoster, deleteRoster,
} from '../controllers/rosterController.js';

const router = Router();
router.use(authenticate);

// Order matters: fixed paths before '/:id'
router.get('/mine', myRoster);
router.get('/available', requireRole('SUPERVISOR'), availableEmployees);
router.get('/', requireRole('SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'), listRoster);

router.post('/', requireRole('SUPERVISOR'), createRoster);
router.put('/:id', requireRole('SUPERVISOR'), updateRoster);
router.delete('/:id', requireRole('SUPERVISOR'), deleteRoster);
router.get('/colleague/:empId', colleagueRoster);

export default router;