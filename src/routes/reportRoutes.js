import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  staffingReport, attendanceSummary, missingAttendance, requestsSummary,
} from '../controllers/reportController.js';

const router = Router();
router.use(authenticate, requireRole('SUPERVISOR', 'HR_ADMIN', 'PLANT_MANAGER'));

router.get('/staffing', staffingReport);
router.get('/attendance-summary', attendanceSummary);
router.get('/missing-attendance', missingAttendance);
router.get('/requests-summary', requestsSummary);

export default router;