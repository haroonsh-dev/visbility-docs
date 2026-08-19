import { Request, Response, NextFunction } from 'express';
import {
    listCandidatesForOutreach,
    previewOutreachEmail,
    saveCandidateEmailOverride,
    sendCandidateOutreachEmails,
    type OutreachTemplateId,
} from '../services/hrCandidateEmailService';
import { requireAllowedAgent } from '../services/planService';
import { HR_AGENT } from '../services/offerLetterGenerationService';
import { isEmailConfigured } from '../services/emailService';

export const listHrCandidatesOutreach = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
        const minScore = req.query.minScore != null ? Number(req.query.minScore) : undefined;
        const documentIds = req.query.documentIds
            ? String(req.query.documentIds)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;

        const candidates = await listCandidatesForOutreach(req.user!, {
            limit,
            minScore: Number.isFinite(minScore) ? minScore : undefined,
            documentIds,
        });

        return res.json({
            success: true,
            data: {
                candidates,
                emailConfigured: isEmailConfigured(),
                withEmail: candidates.filter((c) => c.email).length,
            },
        });
    } catch (e) {
        next(e);
    }
};

export const sendHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const {
            documentIds,
            template,
            subject,
            bodyHtml,
            senderName,
            companyName,
            interviewDetails,
            emailOverrides,
        } = req.body || {};

        if (!Array.isArray(documentIds) || !documentIds.length) {
            return res.status(400).json({ success: false, message: 'documentIds array is required' });
        }

        const allowedTemplates: OutreachTemplateId[] = [
            'interview_invite',
            'screening_next_steps',
            'rejection',
            'custom',
        ];
        const tpl = allowedTemplates.includes(template) ? template : 'interview_invite';

        const result = await sendCandidateOutreachEmails(
            req.user!,
            {
                documentIds,
                template: tpl,
                subject,
                bodyHtml,
                senderName,
                companyName,
                interviewDetails,
                emailOverrides:
                    emailOverrides && typeof emailOverrides === 'object'
                        ? (emailOverrides as Record<string, string>)
                        : undefined,
            },
            req
        );

        return res.json({ success: true, data: result });
    } catch (e) {
        next(e);
    }
};

export const patchHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const documentId = String(req.params.documentId || '').trim();
        const email = String(req.body?.email || '').trim();
        if (!documentId) {
            return res.status(400).json({ success: false, message: 'documentId is required' });
        }
        const result = await saveCandidateEmailOverride(req.user!, documentId, email);
        return res.json({ success: true, data: result });
    } catch (e) {
        next(e);
    }
};

export const previewHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const {
            documentId,
            template,
            senderName,
            companyName,
            interviewDetails,
            emailOverride,
        } = req.body || {};

        if (!documentId) {
            return res.status(400).json({ success: false, message: 'documentId is required' });
        }

        const allowedTemplates: OutreachTemplateId[] = [
            'interview_invite',
            'screening_next_steps',
            'rejection',
            'custom',
        ];
        const tpl = allowedTemplates.includes(template) ? template : 'interview_invite';

        const preview = await previewOutreachEmail(req.user!, {
            documentId: String(documentId),
            template: tpl,
            senderName,
            companyName,
            interviewDetails,
            emailOverride,
        });

        return res.json({ success: true, data: preview });
    } catch (e) {
        next(e);
    }
};
