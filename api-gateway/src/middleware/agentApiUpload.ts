import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Request, Response, NextFunction } from 'express';

const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

export const agentApiUpload = multer({
    dest: tmpDir,
    limits: { fileSize: 50 * 1024 * 1024 },
});

const UPLOAD_HINT = {
    multipart: {
        contentType: 'multipart/form-data',
        fields: { file: 'binary file', message: 'optional string' },
    },
    json: {
        contentType: 'application/json',
        example: {
            fileName: 'invoice.pdf',
            fileBase64: '<base64-encoded-file>',
            message: 'Extract key fields as JSON',
            waitSeconds: 90,
        },
    },
    fileUrl: {
        contentType: 'application/json',
        example: {
            fileUrl: 'https://example.com/path/invoice.pdf',
            message: 'Extract key fields as JSON',
        },
    },
};

function readRawBodyAsJson(req: Request): Promise<void> {
    return new Promise((resolve) => {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
            const keys = Object.keys(req.body);
            if (keys.length > 0) {
                resolve();
                return;
            }
        }
        if ((req as any).readableEnded || (req as any).complete) {
            resolve();
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object') req.body = parsed;
                } catch {
                    /* leave body */
                }
            }
            resolve();
        });
        req.on('error', () => resolve());
    });
}

/**
 * Parse multipart when Content-Type includes a boundary.
 * If multipart is declared without a boundary, fall through to JSON body parsing.
 * Accepts any file field name (file, document, upload, …).
 */
export function agentApiOptionalMultipart(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const ct = String(req.headers['content-type'] || '');
    const ctLower = ct.toLowerCase();
    const isMultipart = ctLower.includes('multipart/form-data');
    const hasBoundary = /boundary\s*=/i.test(ct);

    if (isMultipart && !hasBoundary) {
        void readRawBodyAsJson(req).then(() => next());
        return;
    }

    if (!isMultipart) {
        return next();
    }

    agentApiUpload.any()(req, res, (err: any) => {
        if (err) {
            const msg = String(err?.message || err || '');
            if (/boundary/i.test(msg)) {
                void readRawBodyAsJson(req).then(() => next());
                return;
            }
            if (err?.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({
                    success: false,
                    message: 'File too large (max 50MB)',
                });
            }
            if (Array.isArray(req.files) && req.files.length > 0) {
                req.file = req.files[0] as Express.Multer.File;
                return next();
            }
            return res.status(400).json({
                success: false,
                code: 'UPLOAD_ERROR',
                message:
                    msg === 'Unexpected field'
                        ? 'Unexpected multipart field. Send the file as field "file", or use JSON fileBase64 + fileName.'
                        : msg || 'Upload failed',
                hint: UPLOAD_HINT,
            });
        }

        const files = req.files as Express.Multer.File[] | undefined;
        if (files && files.length > 0) {
            const preferred =
                files.find((f) =>
                    ['file', 'document', 'upload', 'attachment', 'pdf', 'image'].includes(
                        String(f.fieldname || '').toLowerCase()
                    )
                ) || files[0];
            req.file = preferred;
        }
        return next();
    });
}

function guessMime(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.gif': 'image/gif',
        '.txt': 'text/plain',
        '.pages': 'application/vnd.apple.pages',
        '.rtf': 'application/rtf',
        '.odt': 'application/vnd.oasis.opendocument.text',
        '.doc': 'application/msword',
        '.docx':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] || 'application/octet-stream';
}

/** Resolve upload from multipart, JSON fileBase64, or fileUrl. */
export async function resolveAgentApiUploadFile(
    req: Request
): Promise<{ file: Express.Multer.File; cleanupPath?: string } | { error: string; hint?: unknown }> {
    if (req.file) {
        return { file: req.file };
    }

    const body = req.body || {};
    const fileName = String(body.fileName || body.filename || body.name || '').trim();
    let b64 = String(body.fileBase64 || body.base64 || '').trim();
    if (!b64 && typeof body.file === 'string' && body.file.length > 200) {
        b64 = body.file.trim();
    }
    const fileUrl = String(body.fileUrl || body.url || '').trim();

    if (b64) {
        const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(b64);
        let mime = guessMime(fileName || 'upload.bin');
        if (dataUrl) {
            mime = dataUrl[1] || mime;
            b64 = dataUrl[2];
        }
        if (!fileName && !dataUrl) {
            return {
                error: 'fileName is required with fileBase64',
                hint: UPLOAD_HINT,
            };
        }
        let buf: Buffer;
        try {
            buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
        } catch {
            return { error: 'fileBase64 is invalid', hint: UPLOAD_HINT };
        }
        if (!buf.length) {
            return { error: 'fileBase64 is empty or invalid', hint: UPLOAD_HINT };
        }
        const name = fileName || `upload.${mime.includes('pdf') ? 'pdf' : 'bin'}`;
        const dest = path.join(
            tmpDir,
            `agentapi_${Date.now()}_${name.replace(/[^\w.\-]+/g, '_')}`
        );
        fs.writeFileSync(dest, buf);
        const file = {
            fieldname: 'file',
            originalname: name,
            encoding: '7bit',
            mimetype: mime,
            size: buf.length,
            destination: tmpDir,
            filename: path.basename(dest),
            path: dest,
            buffer: buf,
        } as Express.Multer.File;
        return { file, cleanupPath: dest };
    }

    if (fileUrl) {
        if (!/^https?:\/\//i.test(fileUrl)) {
            return { error: 'fileUrl must start with http:// or https://' };
        }
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 60_000);
        try {
            const resp = await fetch(fileUrl, { signal: ac.signal });
            if (!resp.ok) {
                return { error: `Failed to download fileUrl (${resp.status})` };
            }
            const arr = Buffer.from(await resp.arrayBuffer());
            const urlName =
                fileName ||
                path.basename(new URL(fileUrl).pathname) ||
                'download.bin';
            const mime =
                resp.headers.get('content-type')?.split(';')[0]?.trim() ||
                guessMime(urlName);
            const dest = path.join(
                tmpDir,
                `agentapi_${Date.now()}_${urlName.replace(/[^\w.\-]+/g, '_')}`
            );
            fs.writeFileSync(dest, arr);
            const file = {
                fieldname: 'file',
                originalname: urlName,
                encoding: '7bit',
                mimetype: mime,
                size: arr.length,
                destination: tmpDir,
                filename: path.basename(dest),
                path: dest,
                buffer: arr,
            } as Express.Multer.File;
            return { file, cleanupPath: dest };
        } catch (e: any) {
            return { error: e?.message || 'fileUrl download failed' };
        } finally {
            clearTimeout(t);
        }
    }

    return {
        error:
            'No file received. Send multipart field "file", or JSON { "fileName", "fileBase64" }, or { "fileUrl" }. For chat-only, send { "message" } to /ask.',
        hint: UPLOAD_HINT,
    };
}

export { UPLOAD_HINT };
/** @deprecated use UPLOAD_HINT */
export const MULTIPART_HINT = UPLOAD_HINT;
