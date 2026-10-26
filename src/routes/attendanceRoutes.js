import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  currentShift, clockIn, clockOut, manualEntry, listAttendance,myAttendance
} from '../controllers/attendanceController.js';

const router = Router();
router.use(authenticate);

router.get('/current', currentShift);
router.post('/clock-in', clockIn);
router.post('/clock-out', clockOut);

router.get('/', requireRole('SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'), listAttendance);
router.put('/manual', requireRole('SUPERVISOR'), manualEntry);
router.get('/mine', myAttendance);

export default router;