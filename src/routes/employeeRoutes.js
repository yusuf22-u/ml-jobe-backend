import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  listEmployees, getEmployee,listColleagues, createEmployee,resetPassword, updateEmployee, deactivateEmployee,
} from '../controllers/employeeController.js';

const router = Router();
router.use(authenticate);

// Supervisors need to read employees to build rosters
router.get('/', requireRole('HR_ADMIN', 'SUPERVISOR', 'PLANT_MANAGER'), listEmployees);
router.get('/:id', requireRole('HR_ADMIN', 'SUPERVISOR', 'PLANT_MANAGER'), getEmployee);

router.post('/', requireRole('HR_ADMIN'), createEmployee);
router.put('/:id', requireRole('HR_ADMIN'), updateEmployee);
router.delete('/:id', requireRole('HR_ADMIN'), deactivateEmployee);
router.put('/:id/password', requireRole('HR_ADMIN'), resetPassword);
router.get('/colleagues', listColleagues);

export default router;