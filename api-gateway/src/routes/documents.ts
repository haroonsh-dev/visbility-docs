import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    bulkDeleteDocuments,
    deleteDocument,
    getDocument,
    getDocumentImages,
    getDocumentIntelligence,
    getDocumentProcessing,
    getDocumentSimilar,
    listAllDocumentIntelligence,
    listDocuments,
    streamDocument,
    reprocessDocument,
    streamDocumentAiFile,
    updateDocumentAiSettings,
    uploadDocument,
    uploadDocumentsBulk,
} from '../controllers/documentsController';
import {
    listDocumentShares,
    shareDocument,
    unshareDocument,
} from '../controllers/departmentController';

const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

router.use(authenticate);
router.get('/', listDocuments);
router.get('/intelligence/all', listAllDocumentIntelligence);
router.post('/bulk', upload.array('files', 20), uploadDocumentsBulk);
router.post('/bulk-delete', bulkDeleteDocuments);
router.post('/:id/reprocess', reprocessDocument);
router.post('/:id/process', reprocessDocument);
router.post('/:id/share', shareDocument);
router.delete('/:id/share', unshareDocument);
router.get('/:id/shares', listDocumentShares);
router.get('/:id/preview', streamDocument('inline'));
router.get('/:id/download', streamDocument('attachment'));
router.get('/:id/images', getDocumentImages);
router.get('/:id/similar', getDocumentSimilar);
router.get('/:id/ai-file', streamDocumentAiFile);
router.get('/:id/intelligence', getDocumentIntelligence);
router.get('/:id/processing', getDocumentProcessing);
router.patch('/:id/ai-settings', updateDocumentAiSettings);
router.get('/:id', getDocument);
router.post('/', upload.single('file'), uploadDocument);
router.delete('/:id', deleteDocument);

export default router;
