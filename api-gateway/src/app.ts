import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import documentsRoutes from './routes/documents';
import chatRoutes from './routes/chat';
import searchRoutes from './routes/search';
import healthRoutes from './routes/health';
import teamRoutes from './routes/team';
import superAdminRoutes from './routes/superAdmin';
import activityRoutes from './routes/activity';
import groqRoutes from './routes/groq';
import departmentRoutes from './routes/departments';
import settingsRoutes from './routes/settings';
import { errorHandler, notFound } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';
import { listAllDocumentIntelligence, reprocessDocument } from './controllers/documentsController';

dotenv.config();

const app: Express = express();
app.disable('etag');

app.use(
    cors({
        origin: process.env.FRONTEND_URL
            ? process.env.FRONTEND_URL.split(',').map((url) => url.trim())
            : '*',
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        exposedHeaders: ['set-cookie'],
    })
);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

app.get('/', (_req, res) => {
    res.json({
        name: 'Visibility Docs AI API',
        version: '1.0.0',
        docs: '/api/health',
    });
});

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.get('/api/docs/documents/intelligence/all', authenticate, listAllDocumentIntelligence);
app.post('/api/docs/documents/:id/reprocess', authenticate, reprocessDocument);
app.post('/api/docs/documents/:id/process', authenticate, reprocessDocument);
// Namespaced for easy merge into Visibility Live app.ts as one mount
app.use('/api/docs/documents', documentsRoutes);
app.use('/api/docs/chat', chatRoutes);
app.use('/api/docs/search', searchRoutes);
app.use('/api/docs/team', teamRoutes);
app.use('/api/docs/activity', activityRoutes);
app.use('/api/docs/groq', groqRoutes);
app.use('/api/docs/departments', departmentRoutes);
app.use('/api/docs/settings', settingsRoutes);
app.use('/api/docs/super-admin', superAdminRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
