import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { authenticateAgentApi } from '../middleware/agentApiAuth';
import { agentApiOptionalMultipart } from '../middleware/agentApiUpload';
import { PERMISSIONS } from '../types/permissions';
import {
    askAgentViaApi,
    deleteDocumentViaAgentApi,
    getAgentApiStatus,
    getDocumentViaAgentApi,
    processViaAgentApi,
    revokeAgentApiToken,
    rotateAgentApiToken,
    uploadDocumentViaAgentApi,
} from '../controllers/agentApiController';

/** Public Agent API — Bearer / X-Agent-Key token auth. */
export const agentApiPublicRouter = Router();

agentApiPublicRouter.post(
    '/:agentId/process',
    authenticateAgentApi,
    agentApiOptionalMultipart,
    processViaAgentApi
);
agentApiPublicRouter.post(
    '/:agentId/documents',
    authenticateAgentApi,
    agentApiOptionalMultipart,
    uploadDocumentViaAgentApi
);
agentApiPublicRouter.get(
    '/:agentId/documents/:documentId',
    authenticateAgentApi,
    getDocumentViaAgentApi
);
agentApiPublicRouter.delete(
    '/:agentId/documents/:documentId',
    authenticateAgentApi,
    deleteDocumentViaAgentApi
);
agentApiPublicRouter.post(
    '/:agentId/ask',
    authenticateAgentApi,
    agentApiOptionalMultipart,
    askAgentViaApi
);
agentApiPublicRouter.get('/:agentId/ask', (_req, res) => {
    res.status(405).json({
        success: false,
        message: 'Method not allowed. Use POST with JSON body { "message": "..." }.',
    });
});
agentApiPublicRouter.get('/:agentId/process', (_req, res) => {
    res.status(405).json({
        success: false,
        message:
            'Method not allowed. Use POST with multipart file, or JSON { "fileName", "fileBase64", "message" }.',
    });
});

/** Admin: Agent API token management. */
export const agentApiAdminRouter = Router();
agentApiAdminRouter.use(authenticate, requirePermission(PERMISSIONS.PAGE_SETTINGS));
agentApiAdminRouter.get('/token', getAgentApiStatus);
agentApiAdminRouter.post('/token/rotate', rotateAgentApiToken);
agentApiAdminRouter.delete('/token', revokeAgentApiToken);

export default agentApiPublicRouter;
