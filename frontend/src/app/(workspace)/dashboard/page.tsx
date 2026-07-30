"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
    Activity,
    ArrowRight,
    Building2,
    Crown,
    Download,
    FileText,
    MessageSquare,
    RefreshCw,
    ShieldCheck,
} from "lucide-react";
import DashboardStats from "@/components/DashboardStats";
import DashboardCharts from "@/components/DashboardCharts";
import DashboardInsights from "@/components/DashboardInsights";
import { Badge, PageHeader } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { downloadDashboardReport } from "@/lib/dashboardExport";
import { usePermissions } from "@/context/PermissionsContext";
import { getStoredUser } from "@/lib/authSession";

type DashboardData = {
    stats: { total: number; processed: number; processing: number; failed: number };
    trendData: { date: string; uploads: number }[];
    departmentData: { name: string; count: number }[];
    statusData: { name: string; count: number }[];
    allDocs: any[];
    recentActivity: any[];
    departmentNames: Record<string, string>;
};

type TeamIdentity = {
    fullName?: string;
    department?: {
        departmentId: string;
        name: string;
        slug?: string;
        allowedDocumentTypes?: string[];
    } | null;
    orgRole?: {
        roleId: string;
        name: string;
        isLeader?: boolean;
        rank?: number;
    } | null;
};

const stagger = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};
const fadeUp = {
    hidden: { opacity: 1, y: 0 },
    show: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
    },
};

function DashboardContent() {
    const { role, ready, canAccessPage } = usePermissions();
    const storedUser = getStoredUser<{ userId?: string; fullName?: string }>();
    const isAdminView = role === "admin" || role === "superAdmin";
    const [data, setData] = useState<DashboardData>({
        stats: { total: 0, processed: 0, processing: 0, failed: 0 },
        trendData: [],
        departmentData: [],
        statusData: [],
        allDocs: [],
        recentActivity: [],
        departmentNames: {},
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [teamIdentity, setTeamIdentity] = useState<TeamIdentity | null>(null);

    const buildData = useCallback((
        docs: any[],
        departmentNames: Record<string, string>,
        recentActivity: any[]
    ) => {
        const total = docs.length;
        const processed = docs.filter((d: any) =>
            ["ready", "processed", "completed", "done"].includes((d.status || "").toLowerCase())
        ).length;
        const processing = docs.filter((d: any) =>
            ["processing", "uploaded", "queued"].includes((d.status || "").toLowerCase())
        ).length;
        const failed = docs.filter((d: any) => {
            const s = (d.status || "").toLowerCase();
            return s === "failed" || s.includes("fail") || s.includes("error");
        }).length;

        const uploadCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            if (d.createdAt) {
                const date = new Date(d.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                });
                uploadCounts[date] = (uploadCounts[date] || 0) + 1;
            }
        });
        const trendData = Object.entries(uploadCounts)
            .map(([date, uploads]) => ({ date, uploads }))
            .slice(-14);

        const deptCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            const id = d.departmentId || "Unassigned";
            const label = id === "Unassigned" ? id : departmentNames[id] || id;
            deptCounts[label] = (deptCounts[label] || 0) + 1;
        });
        const departmentData = Object.entries(deptCounts)
            .map(([name, count]) => ({
                name: name.length > 18 ? `${name.slice(0, 16)}…` : name,
                count,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        const other = Math.max(0, total - processed - processing - failed);
        const statusData = [
            { name: "Ready", count: processed },
            { name: "Processing", count: processing },
            { name: "Failed", count: failed },
            { name: "Other", count: other },
        ];

        setData({
            stats: { total, processed, processing, failed },
            trendData,
            departmentData,
            statusData,
            allDocs: docs,
            recentActivity,
            departmentNames,
        });
    }, []);

    const loadDashboard = useCallback(async () => {
        if (!ready) return;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({
                page: "1",
                limit: "500",
                sortBy: "createdAt",
                sortOrder: "desc",
            });
            if (!isAdminView && storedUser?.userId) {
                params.set("uploadedBy", storedUser.userId);
            }
            const activityParams = new URLSearchParams({ page: "1", limit: "8" });
            if (!isAdminView && storedUser?.userId) {
                activityParams.set("actorUserId", storedUser.userId);
            }

            const [docsRes, deptRes, activityRes, meRes] = await Promise.all([
                apiRequest(`/docs/documents?${params}`),
                isAdminView ? apiRequest(`/docs/departments`).catch(() => null) : Promise.resolve(null),
                apiRequest(`/docs/activity?${activityParams}`).catch(() => null),
                !isAdminView ? apiRequest("/auth/me").catch(() => null) : Promise.resolve(null),
            ]);
            const docs = docsRes?.data?.documents || [];
            const departments = deptRes?.data?.departments || deptRes?.data || [];
            const recentActivity = activityRes?.data?.logs || [];
            if (!isAdminView) {
                const freshUser = meRes?.data?.user;
                setTeamIdentity(
                    freshUser
                        ? {
                              fullName: freshUser.fullName,
                              department: freshUser.department || null,
                              orgRole: freshUser.orgRole || null,
                          }
                        : null
                );
            } else {
                setTeamIdentity(null);
            }
            const departmentNames: Record<string, string> = {};
            if (Array.isArray(departments)) {
                for (const d of departments) {
                    const id = d.departmentId || d.id;
                    const name = d.name || d.departmentName;
                    if (id && name) departmentNames[id] = name;
                }
            }
            buildData(docs, departmentNames, recentActivity);
        } catch (e: any) {
            setError(e.message || "Failed to load dashboard");
        } finally {
            setLoading(false);
        }
    }, [ready, isAdminView, storedUser?.userId, buildData]);

    useEffect(() => {
        loadDashboard();
    }, [loadDashboard]);

    const exportFullReport = () => {
        if (!data.allDocs.length) return;
        downloadDashboardReport(data.allDocs, {
            title: "Visibility Docs — Full Dashboard Report",
            departmentNames: data.departmentNames,
            filename: `visibility-dashboard-full_${new Date().toISOString().slice(0, 10)}.xls`,
        });
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
            <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
            >
                <PageHeader
                    title="Dashboard"
                    subtitle={
                        isAdminView
                            ? "Organization-wide document intelligence and workspace activity."
                            : `Your documents, processing progress, and recent activity${storedUser?.fullName ? `, ${storedUser.fullName}` : ""}.`
                    }
                    actions={
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={exportFullReport}
                                disabled={!data.allDocs.length}
                                className="btn-gradient rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40"
                                title="Export full Excel report with file list and stats"
                            >
                                <Download size={14} /> Export report
                            </button>
                            <button
                                type="button"
                                onClick={loadDashboard}
                                className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"
                            >
                                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />{" "}
                                Refresh
                            </button>
                        </div>
                    }
                />
            </motion.div>

            {error && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-rose-200 bg-gradient-to-r from-rose-50 to-red-50 text-rose-700 px-5 py-4 text-sm flex items-center gap-3"
                >
                    <div className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                        <span className="text-rose-600 text-lg">⚠</span>
                    </div>
                    {error}
                </motion.div>
            )}

            {!isAdminView && ready && !loading && (
                <motion.section
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05, duration: 0.4 }}
                    className={`surface-card overflow-hidden ${
                        teamIdentity?.department ? "" : "border-amber-200"
                    }`}
                >
                    {teamIdentity?.department ? (
                        <div className="relative p-5 sm:p-6">
                            <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-teal-500 to-cyan-500" />
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
                                <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white flex items-center justify-center shrink-0 shadow-lg shadow-teal-500/20">
                                    <Building2 size={24} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-teal-600">
                                            Your department
                                        </p>
                                        {teamIdentity.orgRole?.isLeader && (
                                            <Badge variant="warning">
                                                <Crown size={10} /> Department leader
                                            </Badge>
                                        )}
                                    </div>
                                    <h2 className="text-xl font-bold text-slate-800 truncate">
                                        {teamIdentity.department.name}
                                    </h2>
                                    <div className="flex flex-wrap items-center gap-2 mt-2">
                                        <Badge variant="accent">
                                            <ShieldCheck size={10} />
                                            {teamIdentity.orgRole?.name || "Team member"}
                                        </Badge>
                                        {typeof teamIdentity.orgRole?.rank === "number" && (
                                            <Badge variant="default">
                                                Rank {teamIdentity.orgRole.rank}
                                            </Badge>
                                        )}
                                        {!!teamIdentity.department.allowedDocumentTypes?.length && (
                                            <span className="text-[11px] text-slate-500">
                                                {teamIdentity.department.allowedDocumentTypes.length} allowed
                                                document type
                                                {teamIdentity.department.allowedDocumentTypes.length === 1
                                                    ? ""
                                                    : "s"}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500 mt-2">
                                        This dashboard shows your own uploads and activity within the{" "}
                                        {teamIdentity.department.name} department.
                                    </p>
                                </div>
                                {canAccessPage("departments") && (
                                    <Link
                                        href={`/departments/${teamIdentity.department.departmentId}`}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 shrink-0"
                                    >
                                        Open department <ArrowRight size={14} />
                                    </Link>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 bg-amber-50/70">
                            <div className="h-12 w-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                                <Building2 size={21} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 className="text-base font-bold text-amber-900">
                                    No department assigned
                                </h2>
                                <p className="text-xs text-amber-700 mt-1">
                                    Ask your organization admin to assign your department and role.
                                    Your personal document dashboard is still available below.
                                </p>
                            </div>
                        </div>
                    )}
                </motion.section>
            )}

            <DashboardStats stats={data.stats} />

            <DashboardCharts
                trendData={data.trendData}
                departmentData={data.departmentData}
                statusData={data.statusData}
                loading={loading}
                allDocs={data.allDocs}
                departmentNames={data.departmentNames}
                isAdminView={isAdminView}
            />

            <DashboardInsights
                documents={data.allDocs}
                activity={data.recentActivity}
                loading={loading}
                isAdminView={isAdminView}
            />

            <motion.div variants={stagger} initial="hidden" animate="show">
                <h3 className="text-sm font-bold text-slate-800 mb-4">Quick Actions</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[
                        {
                            href: "/documents",
                            icon: FileText,
                            title: "Documents",
                            desc: "Upload, manage, and search files",
                            gradient: "from-teal-500 to-cyan-500",
                            shadow: "shadow-teal-500/20",
                            allow: true,
                        },
                        {
                            href: "/chat",
                            icon: MessageSquare,
                            title: "AI Chat",
                            desc: "Chat with your documents using AI",
                            gradient: "from-cyan-500 to-blue-500",
                            shadow: "shadow-cyan-500/20",
                            allow: canAccessPage("chat"),
                        },
                        {
                            href: "/activity",
                            icon: Activity,
                            title: "Activity",
                            desc: "View recent actions and logs",
                            gradient: "from-violet-500 to-purple-500",
                            shadow: "shadow-violet-500/20",
                            allow: canAccessPage("activity"),
                        },
                    ].filter((item) => item.allow).map((item) => (
                        <motion.div key={item.href} variants={fadeUp}>
                            <Link href={item.href} className="action-card group block h-full">
                                <div
                                    className={`w-12 h-12 rounded-xl bg-gradient-to-br ${item.gradient} flex items-center justify-center shrink-0 shadow-lg ${item.shadow} group-hover:scale-110 transition-transform duration-300`}
                                >
                                    <item.icon size={22} className="text-white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-slate-800 group-hover:text-teal-600 transition-colors">
                                        {item.title}
                                    </p>
                                    <p className="text-xs text-slate-500 mt-0.5">{item.desc}</p>
                                </div>
                                <ArrowRight
                                    size={16}
                                    className="text-slate-300 group-hover:text-teal-500 group-hover:translate-x-1 transition-all shrink-0"
                                />
                            </Link>
                        </motion.div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
}

export default function DashboardPage() {
    return <DashboardContent />;
}
