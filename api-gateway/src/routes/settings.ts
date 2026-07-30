import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    listApiKeys,
    saveApiKey,
    toggleApiKey,
    deleteApiKey,
    getProviderConfig,
    setPrimaryProvider,
} from '../controllers/settingsController';

const router = Router();

router.use(authenticate);
router.get('/api-keys', listApiKeys);
router.post('/api-keys', saveApiKey);
router.post('/api-keys/primary', setPrimaryProvider);
router.patch('/api-keys/:keyId/toggle', toggleApiKey);
router.delete('/api-keys/:keyId', deleteApiKey);
router.get('/providers', getProviderConfig);

export default router;
