import Document from '../models/Document';
import { AuthUser } from './accessScope';
import { buildDocumentFilter } from './accessScope';
import { inferDocumentTypeFromFilename } from './documentStorage';
import { createExperienceLetterFromResume } from './experienceLetterGenerationService';
import { createOfferLetterFromResume, HR_AGENT, OfferPayload } from './offerLetterGenerationService';
import { getOfferLetterPrefill, getAiDocument, resolveAiOrganizationId } from './aiServiceClient';
import { requireAllowedAgent } from './planService';

type ResumeRow = Awaited<ReturnType<typeof listTopResumesForUser>>[number];

export type HrChatCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type HrChatActionResult = {
    handled: boolean;
    answer?: string;
    citations?: HrChatCitation[];
};

function pdfPreviewPath(documentId: string): string {
    return `/documents/${documentId}`;
}

/** Chat link text: "Joining letter — Sharjeel Ahmed" (matches what the user asked to generate). */
function letterDocLink(kindLabel: string, personName: string, documentId: string): string {
    const name = personName.replace(/\s+/g, ' ').trim() || 'Candidate';
    const kind = kindLabel.replace(/\s+/g, ' ').trim();
    return `[${kind} — ${name}](${pdfPreviewPath(documentId)})`;
}

function personLabelFromResume(r: {
    originalFilename: string;
    candidateName?: string | null;
}): string {
    if (r.candidateName?.trim()) return r.candidateName.trim();
    const base = r.originalFilename.replace(/\.[^.]+$/, '');
    const cleaned = base
        .replace(/\b(resume|cv|curriculum|vitae|biodata)\b/gi, ' ')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || base;
}

function parseTopLimit(question: string, defaultLimit = 10): number {
    const q = question.toLowerCase();
    const m = q.match(/top\s+(\d{1,2})/);
    if (m) return Math.max(1, Math.min(25, Number(m[1])));
    if (/\btop\s+ten\b/.test(q)) return 10;
    if (/\btop\s+five\b/.test(q)) return 5;
    return defaultLimit;
}

function hasExplicitTopN(question: string): boolean {
    return /\btop\s+(\d{1,2}|ten|five)\b/i.test(question);
}

function normalizePersonQuery(s: string): string {
    return s
        .toLowerCase()
        .replace(/\.(pdf|docx?)$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nameMatchesResume(query: string, filename: string, candidateName?: string | null): boolean {
    const q = normalizePersonQuery(query);
    if (!q || q.length < 2) return false;
    const hay = normalizePersonQuery(`${candidateName || ''} ${filename}`);
    if (hay.includes(q)) return true;
    const qTokens = q.split(' ').filter((t) => t.length > 1);
    if (qTokens.length >= 2 && qTokens.every((t) => hay.includes(t))) return true;
    if (qTokens.length === 1 && qTokens[0].length >= 3 && hay.includes(qTokens[0])) return true;
    return false;
}

/** Person named in chat (not "top N"). */
function parseCandidateNameFromMessage(question: string): string | null {
    if (hasExplicitTopN(question)) return null;
    const q = question.trim();

    const patterns = [
        /(?:offer\s*letters?|offers?|experience\s*letters?)\s+for\s+(?!top\b)([^,\n]+?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|\s+join(?:ing)?\b|\s+from\b|\s+to\b|$)/i,
        /(?:generate|create|make|draft)\s+(?:an?\s+)?(?:offer|experience)\s+(?:letter\s+)?for\s+(?!top\b)([^,\n]+?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|$)/i,
        /\bfor\s+(?:candidate\s+)?(?!top\b)([A-Za-z][A-Za-z\s.'-]{1,70}?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|\s+join(?:ing)?\b|\s+from\b|\s+to\b|$)/i,
    ];

    for (const re of patterns) {
        const m = q.match(re);
        const raw = m?.[1]?.trim();
        if (!raw) continue;
        const cleaned = raw
            .replace(/\b(company|title|salary|joining|monthly|annual)\b.*$/i, '')
            .trim();
        if (!cleaned || /^top\s*\d*$/i.test(cleaned)) continue;
        if (cleaned.length >= 2) return cleaned;
    }

    const quoted = q.match(/["']([^"']{2,80})["']/);
    if (quoted?.[1]?.trim()) return quoted[1].trim();

    return null;
}

async function enrichResumeCandidateNames(
    user: AuthUser,
    resumes: ResumeRow[]
): Promise<Array<ResumeRow & { candidateName?: string | null }>> {
    const orgId = resolveAiOrganizationId(user);
    const out: Array<ResumeRow & { candidateName?: string | null }> = [];
    await Promise.all(
        resumes.map(async (r) => {
            let candidateName: string | null = null;
            if (r.pythonDocumentId) {
                try {
                    const pre = await getOfferLetterPrefill(r.pythonDocumentId, orgId);
                    candidateName = pre?.prefill?.candidate_name?.trim() || null;
                } catch {
                    candidateName = null;
                }
            }
            out.push({ ...r, candidateName });
        })
    );
    return out.sort(
        (a, b) =>
            resumes.findIndex((x) => x.documentId === a.documentId) -
            resumes.findIndex((x) => x.documentId === b.documentId)
    );
}

type ResolveTargetsResult =
    | { ok: true; resumes: ResumeRow[]; note?: string }
    | { ok: false; message: string };

/** Letter generation: one named/scoped CV — not default top-3 unless user says "top N". */
async function resolveLetterTargets(params: {
    user: AuthUser;
    question: string;
    scopedIds?: string[];
    pool: ResumeRow[];
}): Promise<ResolveTargetsResult> {
    const { user, question, scopedIds, pool } = params;
    if (!pool.length) {
        return { ok: false, message: 'No processed resumes found in scope.' };
    }

    if (hasExplicitTopN(question)) {
        const n = parseTopLimit(question, 3);
        return {
            ok: true,
            resumes: pool.slice(0, n),
            note: `top **${Math.min(n, pool.length)}** by CV score`,
        };
    }

    if (scopedIds?.length === 1) {
        const one = pool.find((r) => r.documentId === scopedIds[0]);
        if (one) {
            return {
                ok: true,
                resumes: [one],
                note: `**${one.originalFilename}** (only resume in Document scope)`,
            };
        }
    }

    const named = parseCandidateNameFromMessage(question);
    if (named) {
        const enriched = await enrichResumeCandidateNames(user, pool);
        const matched = enriched.filter((r) => nameMatchesResume(named, r.originalFilename, r.candidateName));
        if (matched.length === 1) {
            const label = matched[0].candidateName || matched[0].originalFilename;
            return {
                ok: true,
                resumes: [matched[0]],
                note: `**${label}** (matched from your message)`,
            };
        }
        if (matched.length > 1) {
            const lines = matched.map(
                (r, i) => `${i + 1}. **${r.candidateName || r.originalFilename}** (${r.originalFilename})`
            );
            return {
                ok: false,
                message: [
                    `Several resumes match **${named}**. Select one CV in **Document scope** or be more specific:`,
                    '',
                    ...lines,
                ].join('\n'),
            };
        }
        return {
            ok: false,
            message: `No resume in scope matches **${named}**. Select that person's CV in **Document scope**, then ask again.`,
        };
    }

    if (pool.length === 1) {
        return {
            ok: true,
            resumes: [pool[0]],
            note: `**${pool[0].originalFilename}**`,
        };
    }

    if (scopedIds && scopedIds.length > 1) {
        return {
            ok: false,
            message: [
                `**${scopedIds.length}** resumes are in scope. I generate letters for **one person at a time**. Either:`,
                '- Select **only that candidate CV** in Document scope, or',
                '- Say their name: `Generate experience letter for Ahmed Khan. Company … title … from YYYY-MM-DD to YYYY-MM-DD`',
                '',
                'To generate for several people at once, say explicitly: `Generate experience letters for top 3. …`',
            ].join('\n'),
        };
    }

    return {
        ok: false,
        message: [
            'Name the candidate or narrow **Document scope** to one CV.',
            '',
            'Example:',
            '`Generate experience letter for Sara Ali. Company Visibility Bots, title Software Engineer, from 2024-01-01 to 2026-08-01`',
            '',
            'Or for an offer: `Generate offer letter for Sara Ali. Company … title … salary PKR … joining …`',
            '',
            'Bulk by score: `Generate experience letters for top 3. Company … title … from … to …`',
        ].join('\n'),
    };
}

function isResumeLike(doc: { classification?: string | null; originalFilename?: string }): boolean {
    const c = String(doc.classification || '').toLowerCase();
    if (c === 'resume' || c === 'cv') return true;
    if (c === 'offer_letter' || c === 'experience_letter' || c === 'transcript') return false;
    const inferred = inferDocumentTypeFromFilename(doc.originalFilename || '');
    if (inferred === 'resume') return true;
    return /\b(cv|cvs|resume|curriculum|biodata)\b/i.test(doc.originalFilename || '');
}

async function resolveCvScoreForResume(
    user: AuthUser,
    doc: { documentId: string; metadata?: Record<string, unknown>; pythonDocumentId?: string | null }
): Promise<number> {
    const fromMeta = Number((doc.metadata as { cvScore?: number })?.cvScore);
    if (Number.isFinite(fromMeta)) return fromMeta;
    if (!doc.pythonDocumentId) return NaN;
    try {
        const orgId = resolveAiOrganizationId(user);
        const ai = await getAiDocument(doc.pythonDocumentId, orgId);
        let raw: unknown = ai?.cv_score;
        // Fallback: resume skill stores top-level cv_score in extractions (not only cv_evaluation).
        if (raw == null || raw === '') {
            const { getDocumentExtractions } = await import('./aiServiceClient');
            let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
            if (!extractions?.length && orgId) {
                extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
            }
            for (const ext of extractions || []) {
                const data = (ext.extracted_data || {}) as Record<string, unknown>;
                if (data.cv_score != null) {
                    raw = data.cv_score;
                    break;
                }
                const ev = data.cv_evaluation;
                if (ev && typeof ev === 'object') {
                    const overall = (ev as Record<string, unknown>).overall_score;
                    if (overall != null) {
                        raw = overall;
                        break;
                    }
                }
            }
        }
        if (raw == null || raw === '') return NaN;
        const score = Number(raw);
        if (!Number.isFinite(score)) return NaN;
        await Document.updateOne({ documentId: doc.documentId }, { $set: { 'metadata.cvScore': score } });
        return score;
    } catch {
        return NaN;
    }
}

export async function listTopResumesForUser(
    user: AuthUser,
    limit: number,
    documentIds?: string[]
): Promise<
    Array<{
        documentId: string;
        originalFilename: string;
        cvScore: number;
        pythonDocumentId?: string | null;
    }>
> {
    const filter = await buildDocumentFilter(user, {});
    const query: Record<string, unknown> = {
        ...filter,
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
    };
    if (documentIds?.length) {
        query.documentId = { $in: documentIds };
    }
    const docs = await Document.find(query)
        .select('documentId originalFilename classification metadata pythonDocumentId')
        .lean();

    const resumes = docs.filter((d) => isResumeLike(d));
    const withScores = await Promise.all(
        resumes.map(async (d) => {
            const cvScore = await resolveCvScoreForResume(user, d);
            return { doc: d, cvScore };
        })
    );
    withScores.sort((a, b) => {
        const sa = Number.isFinite(a.cvScore) ? a.cvScore : -1;
        const sb = Number.isFinite(b.cvScore) ? b.cvScore : -1;
        return sb - sa;
    });

    return withScores.slice(0, limit).map(({ doc: d, cvScore }) => ({
        documentId: d.documentId,
        originalFilename: d.originalFilename,
        cvScore,
        pythonDocumentId: d.pythonDocumentId,
    }));
}

function parseOfferFromMessage(question: string): OfferPayload {
    const q = question;
    const lower = q.toLowerCase();

    let company_name = 'Visibility Bots';
    const companyMatch = q.match(/company\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+title|\s+join|\s+for\s+top|$)/i);
    if (companyMatch?.[1]?.trim()) company_name = companyMatch[1].trim();
    else if (/visibility\s*bots/i.test(q)) company_name = 'Visibility Bots';

    let job_title = '';
    const titleMatch =
        q.match(/(?:job\s+title|title|role|position)\s*[:\s]+["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+join|$)/i) ||
        q.match(/\bas\s+(?:an?\s+)?["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+join|$)/i);
    if (titleMatch?.[1]?.trim()) job_title = titleMatch[1].trim();

    let offered_salary: number | null = null;
    const salaryMatch = lower.match(/(?:salary|pay|compensation)\s*[:\s]*(?:pkr|rs\.?)?\s*([\d,]+)/i);
    if (salaryMatch) {
        offered_salary = Number(salaryMatch[1].replace(/,/g, ''));
    } else {
        const numMatch = lower.match(/\b(pkr|rs\.?)\s*([\d,]+)/i) || lower.match(/\b([\d,]{4,})\b/);
        if (numMatch) {
            const raw = numMatch[numMatch.length - 1].replace(/,/g, '');
            offered_salary = Number(raw);
        }
    }

    let joining_date = '';
    const joinMatch = q.match(/(?:join(?:ing)?|start)\s*(?:date|on)?\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (joinMatch) joining_date = joinMatch[1];

    let offer_valid_until = '';
    const validMatch = q.match(/(?:valid\s+until|offer\s+valid)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (validMatch) offer_valid_until = validMatch[1];

    let currency = 'PKR';
    if (/\busd\b/i.test(q)) currency = 'USD';

    return {
        company_name,
        job_title: job_title || undefined,
        offered_salary,
        currency,
        pay_frequency: /monthly/i.test(q) ? 'Monthly' : 'Annual',
        joining_date: joining_date || undefined,
        offer_valid_until: offer_valid_until || undefined,
        probation_period: '3 months',
    };
}

function parseExperienceFromMessage(question: string): Record<string, unknown> {
    const q = question;
    let company_name = 'Company';
    const companyMatch = q.match(/company\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+title|\s+from|\s+to|$)/i);
    if (companyMatch?.[1]?.trim()) company_name = companyMatch[1].trim();

    let job_title = '';
    const titleMatch = q.match(/(?:title|role|position|as)\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+from|\s+to|$)/i);
    if (titleMatch?.[1]?.trim()) job_title = titleMatch[1].trim();

    let employment_from = '';
    const fromMatch = q.match(/(?:from|started|join(?:ed)?)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (fromMatch) employment_from = fromMatch[1];

    let employment_to = '';
    const toMatch = q.match(/(?:to|until|ended)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (toMatch) employment_to = toMatch[1];

    return {
        company_name,
        job_title: job_title || undefined,
        employment_from: employment_from || undefined,
        employment_to: employment_to || undefined,
        letter_date: new Date().toISOString().slice(0, 10),
    };
}

type HrCommand = 'list' | 'generate_offer' | 'generate_experience' | null;

function detectHrCommand(question: string, phase3Agent?: string): HrCommand {
    const q = question.toLowerCase();
    const hrContext =
        phase3Agent === HR_AGENT ||
        /\b(hr\s+agent|offer\s+letter|experience\s+letter|candidates?|resumes?|cvs?)\b/i.test(question);

    if (!hrContext) return null;

    const wantsExperience =
        /\b(generate|create|make|draft)\b.*\b(experience\s*letters?|employment\s+certificate)\b/.test(q) ||
        /\b(experience\s*letters?|employment\s+certificate)\b.*\b(generate|create|make|draft|for)\b/.test(q) ||
        (phase3Agent === HR_AGENT &&
            /\b(experience\s*letters?|employment\s+certificate)\b/.test(q) &&
            /\bfor\b/.test(q) &&
            !/\brelieving\s+letter\b/.test(q));

    const wantsOffer =
        !wantsExperience &&
        (/\b(generate|create|make|draft)\b.*\b(offer\s*letters?|offers?)\b/.test(q) ||
            /\b(offer\s*letters?|offers?)\b.*\b(generate|create|make|draft|for)\b/.test(q) ||
            (phase3Agent === HR_AGENT &&
                /\boffer\s*letters?\b/.test(q) &&
                /\bfor\b/.test(q) &&
                !/\bexperience\b/.test(q)));

    const wantsList =
        /\b(list|show|give|top|best|rank|shortlist)\b/.test(q) &&
        /\b(resumes?|cvs?|candidates?)\b/.test(q) &&
        !wantsOffer &&
        !wantsExperience;

    if (wantsExperience) return 'generate_experience';
    if (wantsOffer) return 'generate_offer';
    if (wantsList) return 'list';
    if (/\btop\s+\d+\b/.test(q) && /\b(candidate|resume|cv)\b/.test(q) && !wantsOffer && !wantsExperience) {
        return 'list';
    }
    return null;
}

export async function tryHrChatCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrChatActionResult> {
    const cmd = detectHrCommand(params.question, params.phase3Agent);
    if (!cmd) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) {
            return {
                handled: true,
                answer: check.message,
            };
        }
    }

    const scopedIds =
        params.documentIds?.length && params.documentIds.filter(Boolean).length
            ? params.documentIds.filter(Boolean)
            : undefined;

    const scopeNote = scopedIds?.length
        ? ` (from **${scopedIds.length}** resume(s) in chat scope)`
        : '';

    const pool = await listTopResumesForUser(
        params.user,
        scopedIds?.length ? Math.max(scopedIds.length, 50) : 50,
        scopedIds
    );

    if (!pool.length) {
        return {
            handled: true,
            answer:
                `No processed resumes found${scopeNote}. Upload CVs, wait until **ready** (with CV scores), select them in **Document scope** if needed, then try again.`,
        };
    }

    const listLimit = parseTopLimit(params.question, 10);
    const top = pool.slice(0, listLimit);

    if (cmd === 'list') {
        const scoredCount = top.filter((r) => Number.isFinite(r.cvScore)).length;
        const title =
            scoredCount > 0
                ? `Here are the top ${top.length} resumes${scopeNote} by CV score:`
                : `Here are ${top.length} resume(s)${scopeNote}. Scores aren’t ready yet — open a CV and wait for processing:`;
        const lines = top.map((r, i) => {
            const score = Number.isFinite(r.cvScore) ? `${r.cvScore}/100` : 'pending';
            return `${i + 1}. **${r.originalFilename}** — ${scoredCount > 0 ? score : 'pending'}`;
        });
        return {
            handled: true,
            answer: [
                title,
                '',
                ...lines,
                '',
                'Want a chart, an offer letter, or an experience letter for someone? Say their name or select one CV in scope.',
            ].join('\n'),
            citations: top.map((r) => ({
                documentId: r.documentId,
                filename: r.originalFilename,
                score: Number.isFinite(r.cvScore) ? r.cvScore / 100 : undefined,
                documentType: 'resume',
                phase3Agent: HR_AGENT,
            })),
        };
    }

    if (cmd === 'generate_experience') {
        const resolved = await resolveLetterTargets({
            user: params.user,
            question: params.question,
            scopedIds,
            pool,
        });
        if (!resolved.ok) {
            return { handled: true, answer: resolved.message };
        }
        const letterTargets = resolved.resumes;
        const targetNote = resolved.note ? ` for ${resolved.note}` : '';

        const exp = parseExperienceFromMessage(params.question);

        // Prefill missing title/dates from the first resume's extraction so a simple
        // "Generate experience letter" click actually produces a PDF.
        if ((!exp.job_title || !exp.employment_from || !exp.employment_to) && letterTargets[0]?.pythonDocumentId) {
            try {
                const { getExperienceLetterPrefill, resolveAiOrganizationId } = await import(
                    './aiServiceClient'
                );
                const orgId = resolveAiOrganizationId(params.user);
                const pre = await getExperienceLetterPrefill(letterTargets[0].pythonDocumentId, orgId);
                const p = pre?.prefill || {};
                if (!exp.job_title && p.job_title) exp.job_title = p.job_title;
                if (!exp.company_name || exp.company_name === 'Company') {
                    // keep message company if user set one
                }
                // Dates are often absent on resumes — use safe defaults when user omitted them
            } catch {
                /* ignore prefill errors; fall through to prompts */
            }
        }

        if (!exp.job_title) exp.job_title = 'Employee';
        if (!exp.employment_from) {
            // Default: 1 year ago → today if user didn't specify (still generates a usable letter)
            const to = new Date();
            const from = new Date();
            from.setFullYear(from.getFullYear() - 1);
            exp.employment_from = from.toISOString().slice(0, 10);
            if (!exp.employment_to) exp.employment_to = to.toISOString().slice(0, 10);
        }
        if (!exp.employment_to) {
            exp.employment_to = new Date().toISOString().slice(0, 10);
        }

        const results: string[] = [];
        const citations: HrChatCitation[] = [];
        let ok = 0;
        let fail = 0;

        for (const r of letterTargets) {
            try {
                const { letterDoc } = await createExperienceLetterFromResume(params.user, r.documentId, {
                    ...exp,
                    employee_name: undefined,
                });
                ok += 1;
                const person = personLabelFromResume(r as { originalFilename: string; candidateName?: string | null });
                results.push(`- ${letterDocLink('Experience letter', person, letterDoc.documentId)}`);
                citations.push({
                    documentId: letterDoc.documentId,
                    filename: `Experience letter — ${person}.pdf`,
                    documentType: 'experience_letter',
                    phase3Agent: HR_AGENT,
                });
            } catch (e: any) {
                fail += 1;
                results.push(`- Failed for **${r.originalFilename}**: ${e?.message || e}`);
            }
        }

        return {
            handled: true,
            answer: [
                `**Experience letter generation complete** (${ok} created${fail ? `, ${fail} failed` : ''})${targetNote}${scopeNote}.`,
                '',
                ...results,
                '',
                'Use the links above to preview and print each PDF.',
                '',
                '_Tip: add `title …, from YYYY-MM-DD to YYYY-MM-DD` for exact employment dates._',
            ].join('\n'),
            citations,
        };
    }

    const resolved = await resolveLetterTargets({
        user: params.user,
        question: params.question,
        scopedIds,
        pool,
    });
    if (!resolved.ok) {
        return { handled: true, answer: resolved.message };
    }
    const letterTargets = resolved.resumes;
    const targetNote = resolved.note ? ` for ${resolved.note}` : '';

    const offer = parseOfferFromMessage(params.question);
    const missing: string[] = [];
    if (!offer.job_title) missing.push('job title (e.g. title AI Engineer Intern)');
    if (offer.offered_salary == null || Number.isNaN(Number(offer.offered_salary))) {
        missing.push('salary (e.g. salary PKR 80000 monthly)');
    }
    if (!offer.joining_date) missing.push('joining date (e.g. joining 2026-09-01)');

    if (missing.length) {
        return {
            handled: true,
            answer: [
                `I can generate an offer letter${targetNote}${scopeNote}, but I need:`,
                ...missing.map((m) => `- ${m}`),
                '',
                'Example:',
                '`Generate offer letter for Ahmed Khan. Company Visibility Bots, title AI Engineer Intern, salary PKR 80000 monthly, joining 2026-09-01`',
            ].join('\n'),
        };
    }

    const results: string[] = [];
    const citations: HrChatCitation[] = [];
    let ok = 0;
    let fail = 0;

    for (const r of letterTargets) {
        try {
            const { offerDoc } = await createOfferLetterFromResume(params.user, r.documentId, {
                ...offer,
                candidate_name: undefined,
            });
            ok += 1;
            const person = personLabelFromResume(r as { originalFilename: string; candidateName?: string | null });
            results.push(`- ${letterDocLink('Offer letter', person, offerDoc.documentId)}`);
            citations.push({
                documentId: offerDoc.documentId,
                filename: `Offer letter — ${person}.pdf`,
                documentType: 'offer_letter',
                phase3Agent: HR_AGENT,
            });
        } catch (e: any) {
            fail += 1;
            results.push(`- Failed for **${r.originalFilename}**: ${e?.message || e}`);
        }
    }

    return {
        handled: true,
        answer: [
            `**Offer letter generation complete** (${ok} created${fail ? `, ${fail} failed` : ''})${targetNote}${scopeNote}.`,
            '',
            ...results,
            '',
            'Use the links above to preview and print each PDF.',
        ].join('\n'),
        citations,
    };
}
