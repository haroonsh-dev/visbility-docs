"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { useTheme } from "@/context/ColorContext";
import { apiFetchBlob, apiRequest } from "@/lib/apiClient";
import { canPreviewMime, getDocumentDownloadUrl } from "@/lib/documents";
import { useParams } from "next/navigation";

function DocumentPreviewContent() {
    const params = useParams();
    const id = params?.id as string;
    const { theme } = useTheme();
    const colors = theme.colors;
    const [doc, setDoc] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    useEffect(() => {
        if (!id) return;
        apiRequest(`/docs/documents/${id}`)
            .then((data) => setDoc(data?.data?.document))
            .catch((e) => setError(e.message));
    }, [id]);

    useEffect(() => {
        if (!id || !doc || !canPreviewMime(doc.mimeType)) {
            setPreviewBlobUrl(null);
            return;
        }

        let active = true;
        let objectUrl: string | null = null;
        setPreviewLoading(true);
        setError(null);

        apiFetchBlob(`/docs/documents/${id}/preview`)
            .then((blob) => {
                if (!active) return;
                objectUrl = URL.createObjectURL(blob);
                setPreviewBlobUrl(objectUrl);
            })
            .catch((e) => {
                if (!active) return;
                setPreviewBlobUrl(null);
                setError(e.message || "Could not load preview. Is the API server running?");
            })
            .finally(() => {
                if (active) setPreviewLoading(false);
            });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [id, doc]);

    const downloadUrl = id ? getDocumentDownloadUrl(id) : "";
    const canPreview = doc && canPreviewMime(doc.mimeType);

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4">
            <Link href="/documents" className={`inline-flex items-center gap-2 text-sm ${colors.textMuted} hover:text-[var(--accent)]`}>
                <ArrowLeft size={14} /> Back to library
            </Link>

            {error && <div className="text-red-300 text-sm">{error}</div>}
            {!doc && !error && <div className={colors.textMuted}>Loading preview…</div>}

            {doc && (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h1 className={`text-lg sm:text-xl font-bold break-all ${colors.textPrimary}`}>{doc.originalFilename}</h1>
                            <p className={`text-sm ${colors.textMuted}`}>{doc.mimeType} · {doc.status}</p>
                        </div>
                        <a href={downloadUrl} className="btn-secondary rounded-xl px-4 py-2.5 text-sm flex items-center gap-2">
                            <Download size={14} /> Download
                        </a>
                    </div>

                    <div className="surface-card overflow-hidden min-h-[60vh]">
                        {canPreview ? (
                            previewLoading ? (
                                <div className={`p-12 text-center ${colors.textMuted}`}>Loading preview…</div>
                            ) : previewBlobUrl ? (
                                doc.mimeType === "application/pdf" ? (
                                    <iframe src={previewBlobUrl} className="w-full h-[70vh] border-0 bg-white" title="PDF preview" />
                                ) : (
                                    <div className="p-4 flex justify-center">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={previewBlobUrl} alt={doc.originalFilename} className="max-h-[70vh] max-w-full object-contain" />
                                    </div>
                                )
                            ) : (
                                <div className={`p-12 text-center ${colors.textMuted}`}>
                                    <p>Preview could not be loaded.</p>
                                    <a href={downloadUrl} className="btn-gradient inline-flex mt-4 rounded-xl px-4 py-2 text-sm">Download file</a>
                                </div>
                            )
                        ) : (
                            <div className={`p-12 text-center ${colors.textMuted}`}>
                                <p>Preview not available for this file type.</p>
                                <a href={downloadUrl} className="btn-gradient inline-flex mt-4 rounded-xl px-4 py-2 text-sm">Download file</a>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default function DocumentPreviewPage() {
    return (
        <DocumentPreviewContent />
    );
}
