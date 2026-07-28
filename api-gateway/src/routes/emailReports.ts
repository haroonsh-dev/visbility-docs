import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
    getEmailReportConfig,
    saveEmailReportConfig,
    sendEmailReportNow,
} from '../controllers/emailReportsController';

const router = Router();

router.use(authenticate, authorize('admin'));
router.get('/', getEmailReportConfig);
router.put('/', saveEmailReportConfig);
router.post('/send-now', sendEmailReportNow);

export default router;
