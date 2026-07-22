"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { FileText, MessageSquare, Activity, RefreshCw, ArrowRight } from "lucide-react";
import DashboardStats from "@/components/DashboardStats";
import DashboardCharts from "@/components/DashboardCharts";
import { PageHeader } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";

type DashboardData = {
    stats: { total: number; processed: number; processing: number; failed: number };
    trendData: { date: string; uploads: number }[];
    departmentData: { name: string; count: number }[];
    allDocs: any[];
};

const stagger = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};
const fadeUp = {
    hidden: { opacity: 1, y: 0 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

function DashboardContent() {
    const [data, setData] = useState<DashboardData>({
        stats: { total: 0, processed: 0, processing: 0, failed: 0 },
        trendData: [], departmentData: [], allDocs: [],
    });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const buildData = useCallback((docs: any[]) => {
        const total = docs.length;
        const processed = docs.filter((d: any) => ["ready", "processed", "completed", "done"].includes((d.status || "").toLowerCase())).length;
        const processing = docs.filter((d: any) => ["processing", "uploaded", "queued"].includes((d.status || "").toLowerCase())).length;
        const failed = docs.filter((d: any) => { const s = (d.status || "").toLowerCase(); return s === "failed" || s.includes("fail") || s.includes("error"); }).length;

        const uploadCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            if (d.createdAt) {
                const date = new Date(d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                uploadCounts[date] = (uploadCounts[date] || 0) + 1;
            }
        });
        const trendData = Object.entries(uploadCounts).map(([date, uploads]) => ({ date, uploads })).slice(-14);

        const deptCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            const dept = d.departmentId || "Unassigned";
            deptCounts[dept] = (deptCounts[dept] || 0) + 1;
        });
        const departmentData = Object.entries(deptCounts)
            .map(([name, count]) => ({ name: name.slice(0, 12), count }))
            .sort((a, b) => b.count - a.count).slice(0, 8);

        setData({ stats: { total, processed, processing, failed }, trendData, departmentData, allDocs: docs });
    }, []);

    const loadDashboard = async () => {
        setLoading(true); setError(null);
        try {
            const params = new URLSearchParams({ page: "1", limit: "100", sortBy: "createdAt", sortOrder: "desc" });
            const res = await apiRequest(`/docs/documents?${params}`);
            const docs = res?.data?.documents || [];
            buildData(docs);
        } catch (e: any) {
            setError(e.message || "Failed to load dashboard");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadDashboard(); }, []);

    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title="Dashboard" subtitle="Overview of your document intelligence workspace."
                    actions={<button type="button" onClick={loadDashboard} className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>}
                />
            </motion.div>

            {error && (
                <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-rose-200 bg-gradient-to-r from-rose-50 to-red-50 text-rose-700 px-5 py-4 text-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0"><span className="text-rose-600 text-lg">⚠</span></div>
                    {error}
                </motion.div>
            )}

            <DashboardStats stats={data.stats} />

            <DashboardCharts
                trendData={data.trendData}
                departmentData={data.departmentData}
                loading={loading}
                allDocs={data.allDocs}
            />

            <motion.div variants={stagger} initial="hidden" animate="show">
                <h3 className="text-sm font-bold text-slate-800 mb-4">Quick Actions</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[
                        { href: "/documents", icon: FileText, title: "Documents", desc: "Upload, manage, and search files", gradient: "from-teal-500 to-cyan-500", shadow: "shadow-teal-500/20" },
                        { href: "/chat", icon: MessageSquare, title: "AI Chat", desc: "Chat with your documents using AI", gradient: "from-cyan-500 to-blue-500", shadow: "shadow-cyan-500/20" },
                        { href: "/activity", icon: Activity, title: "Activity", desc: "View recent actions and logs", gradient: "from-violet-500 to-purple-500", shadow: "shadow-violet-500/20" },
                    ].map((item) => (
                        <motion.div key={item.href} variants={fadeUp}>
                            <Link href={item.href} className="action-card group block h-full">
                                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${item.gradient} flex items-center justify-center shrink-0 shadow-lg ${item.shadow} group-hover:scale-110 transition-transform duration-300`}>
                                    <item.icon size={22} className="text-white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-slate-800 group-hover:text-teal-600 transition-colors">{item.title}</p>
                                    <p className="text-xs text-slate-500 mt-0.5">{item.desc}</p>
                                </div>
                                <ArrowRight size={16} className="text-slate-300 group-hover:text-teal-500 group-hover:translate-x-1 transition-all shrink-0" />
                            </Link>
                        </motion.div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
}

export default function DashboardPage() {
    return (
        <DashboardContent />
    );
}
