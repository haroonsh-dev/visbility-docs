import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    addDepartmentMember,
    createDepartment,
    createOrgRole,
    deleteDepartment,
    deleteOrgRole,
    getDepartmentMemberDetail,
    getDepartmentOverview,
    listDepartmentSubordinates,
    listDepartments,
    listOrgRoles,
    removeDepartmentMember,
    updateDepartment,
    updateOrgRole,
} from '../controllers/departmentController';

const router = Router();

router.use(authenticate);

router.get('/roles', listOrgRoles);
router.post('/roles', createOrgRole);
router.patch('/roles/:id', updateOrgRole);
router.delete('/roles/:id', deleteOrgRole);

router.get('/', listDepartments);
router.post('/', createDepartment);
router.get('/:id/overview', getDepartmentOverview);
router.get('/:id/subordinates', listDepartmentSubordinates);
router.get('/:id/members/:userId', getDepartmentMemberDetail);
router.patch('/:id', updateDepartment);
router.delete('/:id', deleteDepartment);
router.post('/:id/members', addDepartmentMember);
router.delete('/:id/members/:userId', removeDepartmentMember);

export default router;
