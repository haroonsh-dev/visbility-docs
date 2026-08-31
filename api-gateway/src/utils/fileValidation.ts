const ALLOWED_EXTENSIONS = new Set([
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.docx',
    '.doc',
    '.xlsx',
    '.pptx',
    '.txt',
    '.html',
    '.htm',
    '.pages', // Apple Pages — extract via embedded Preview.pdf when possible
    '.rtf',
    '.odt',
]);

const ALLOWED_MIME_PREFIXES = [
    'application/pdf',
    'image/',
    'text/plain',
    'text/html',
    'text/rtf',
    'application/rtf',
    'application/vnd.openxmlformats-officedocument',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.apple.pages',
    'application/x-iwork-pages-sffpages',
    'application/vnd.oasis.opendocument.text',
    'application/zip', // .pages is often reported as zip
];

export function getExtension(filename: string): string {
    const idx = filename.lastIndexOf('.');
    if (idx === -1) return '';
    return filename.slice(idx).toLowerCase();
}

export function isAllowedFile(filename: string, mimeType?: string): { ok: boolean; reason?: string } {
    const ext = getExtension(filename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return {
            ok: false,
            reason: `File type not allowed: ${ext || 'unknown'}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
        };
    }
    if (mimeType) {
        const mimeOk = ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p) || mimeType === p);
        if (!mimeOk && mimeType !== 'application/octet-stream') {
            return { ok: false, reason: `MIME type not allowed: ${mimeType}` };
        }
    }
    return { ok: true };
}

export function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export const ALLOWED_EXTENSIONS_LIST = [...ALLOWED_EXTENSIONS];
