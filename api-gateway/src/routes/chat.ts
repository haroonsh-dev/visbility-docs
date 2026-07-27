import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    chatWithDocuments,
    deleteChatSessionHandler,
    getChatSessionHandler,
    listChatModelsHandler,
    listChatSessionsHandler,
} from '../controllers/chatController';

const router = Router();

router.get('/sessions', authenticate, listChatSessionsHandler);
router.get('/models', authenticate, listChatModelsHandler);
router.get('/sessions/:id', authenticate, getChatSessionHandler);
router.delete('/sessions/:id', authenticate, deleteChatSessionHandler);
router.post('/', authenticate, chatWithDocuments);

export default router;
