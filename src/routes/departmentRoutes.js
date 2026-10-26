import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
} from '../controllers/departmentController.js';

const router = Router();
router.use(authenticate);

router.get('/', listDepartments);
router.post('/', requireRole('HR_ADMIN'), createDepartment);
router.put('/:id', requireRole('HR_ADMIN'), updateDepartment);
router.delete('/:id', requireRole('HR_ADMIN'), deleteDepartment);

export default router;