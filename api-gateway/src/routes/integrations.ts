import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    listIntegrations,
    saveIntegration,
    testIntegration,
    deleteIntegration,
    rotateIngestKey,
    ingestViaIntegration,
} from '../controllers/integrationsController';

const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

/** Public ingest — no JWT; uses X-Integration-Key */
router.post('/ingest', upload.single('file'), ingestViaIntegration);

router.use(authenticate);
router.get('/', listIntegrations);
router.post('/', saveIntegration);
router.post('/:id/test', testIntegration);
router.post('/:id/rotate-key', rotateIngestKey);
router.delete('/:id', deleteIntegration);

export default router;
