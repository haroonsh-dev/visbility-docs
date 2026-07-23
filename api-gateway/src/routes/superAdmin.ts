import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
    createAdmin,
    deleteAdmin,
    listAdmins,
    listAllDocuments,
    listAllTeams,
    listOrganizations,
    updateAdmin,
    updateAdminStatus,
} from '../controllers/superAdminController';

const router = Router();

router.use(authenticate);
router.use(authorize('superAdmin'));

router.get('/admins', listAdmins);
router.post('/admins', createAdmin);
router.patch('/admins/:userId/status', updateAdminStatus);
router.put('/admins/:userId', updateAdmin);
router.delete('/admins/:userId', deleteAdmin);
router.get('/organizations', listOrganizations);
router.get('/documents', listAllDocuments);
router.get('/teams', listAllTeams);

export default router;
