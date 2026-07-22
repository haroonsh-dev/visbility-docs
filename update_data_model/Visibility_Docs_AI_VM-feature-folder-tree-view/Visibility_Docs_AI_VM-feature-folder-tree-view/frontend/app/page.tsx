"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/AuthContext";

const API = "http://127.0.0.1:8000";

function authFetch(token: string, url: string, opts?: RequestInit) {
  return fetch(url, {
    ...opts,
    headers: { ...opts?.headers, Authorization: `Bearer ${token}` },
  });
}

/* ───────────── helpers ───────────── */

function timeAgo(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function statusColor(s: string) {
  const m: Record<string, string> = {
    processed: "badge-success", processing: "badge-info",
    failed: "badge-error", uploaded: "badge-ghost",
    classified: "badge-primary", ocr_done: "badge-warning",
    embedded: "badge-accent", extracting: "badge-warning",
    queued: "badge-ghost",
  };
  return m[s] || "badge-ghost";
}

function typeColor(t: string) {
  const m: Record<string, string> = {
    invoice: "badge-secondary", contract: "badge-primary",
    report: "badge-accent", resume: "badge-info",
    cv: "badge-info", transcript: "badge-accent",
    other: "badge-ghost",
  };
  return m[t] || "badge-ghost";
}

const NavItem = ({ icon, label, active, onClick }: any) => (
  <button onClick={onClick}
    className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl transition-all duration-200
      ${active ? "bg-white/10 text-white shadow-sm" : "text-white/60 hover:text-white hover:bg-white/5"}`}>
    <span className="text-lg">{icon}</span>
    <span className="font-medium text-sm">{label}</span>
  </button>
);

const TypingDots = () => (
  <div className="flex gap-1.5 items-center px-1">
    {[1, 2, 3].map(i => <span key={i} className="w-2 h-2 rounded-full bg-indigo-400 bounce-dot" />)}
  </div>
);

const AGENT_OPTIONS = [
  { value: "", label: "All Agents" },
  { value: "finance_agent", label: "💰 Finance Agent" },
  { value: "procurement_agent", label: "📦 Procurement Agent" },
  { value: "hr_agent", label: "👨‍💼 HR Agent" },
  { value: "legal_agent", label: "⚖️ Legal Agent" },
  { value: "compliance_agent", label: "✅ Compliance Agent" },
  { value: "other_agent", label: "❓ Other Agent" },
];

/* ───────────── main page ───────────── */
export default function Home() {
  const router = useRouter();
  const { orgId, token, loading, user, logout } = useAuth();
  const [tab, setTab] = useState<"chat" | "docs" | "search">("chat");
  const [toast, setToast] = useState("");
  const [selectedChatDocs, setSelectedChatDocs] = useState<any[]>([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [sendingReport, setSendingReport] = useState(false);
  const [gotoDoc, setGotoDoc] = useState<any | null>(null);

  const showToast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); }, []);

  const sendReport = async () => {
    setSendingReport(true);
    try {
      const r = await authFetch(token, `${API}/api/v1/reports/email?organization_id=${orgId}&phase3_agent=${agentFilter}`, { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        showToast(`📧 Report sent to ${data.sent_to}`);
      } else {
        const err = await r.json().catch(() => ({}));
        showToast(`❌ ${err.detail || "Failed to send report"}`);
      }
    } catch {
      showToast("❌ Network error sending report");
    } finally {
      setSendingReport(false);
    }
  };

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  if (loading) return <div className="h-screen flex items-center justify-center bg-gradient-surface"><div className="spinner-sm" /></div>;
  if (!user) return null;

  return (
    <div className="h-screen flex flex-col bg-gradient-surface">
      {/* ── header ── */}
      <header className="shrink-0 glass border-b border-slate-200/50 z-30">
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gradient tracking-tight">Visibility Docs AI</h1>
              <p className="text-[11px] text-slate-400 -mt-0.5">Enterprise Document Intelligence</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex gap-1 p-1 bg-slate-100/80 rounded-xl">
              <button onClick={() => setTab("chat")}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${tab === "chat" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                💬 Chat
              </button>
              <button onClick={() => setTab("docs")}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${tab === "docs" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                📄 Documents
              </button>
              <button onClick={() => setTab("search")}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${tab === "search" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                🔍 Search
              </button>
            </div>
            <button onClick={sendReport} disabled={sendingReport}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-all disabled:opacity-50">
              {sendingReport ? "⏳ Sending..." : "📧 Email Report"}
            </button>
            <div className="flex items-center gap-3 pl-4 border-l border-slate-200">
              <span className="text-xs text-slate-400 hidden sm:block">{user?.email}</span>
              <button onClick={async () => { await logout(); router.push("/login"); }}
                className="p-2 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all"
                title="Logout">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {tab === "search" ? (
          <SearchSection showToast={showToast} orgId={orgId} token={token}
            onOpenDoc={(doc: any) => { setGotoDoc(doc); setTab("docs"); }} />
        ) : tab === "docs" ? (
          <AllDocumentsPage showToast={showToast} orgId={orgId} token={token}
            gotoDoc={gotoDoc} clearGotoDoc={() => setGotoDoc(null)}
            agentFilter={agentFilter} setAgentFilter={setAgentFilter} />
        ) : (
          <ChatSection showToast={showToast} selectedDocs={selectedChatDocs} setSelectedDocs={setSelectedChatDocs}
            orgId={orgId} token={token} agentFilter={agentFilter} />
        )}
      </div>

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 glass px-6 py-3 rounded-2xl shadow-2xl slide-up">
          <p className="text-sm font-medium text-slate-800">{toast}</p>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════
   DOCUMENTS
   ════════════════════════════════════════ */
function loadSeen(): Set<string> { try { const r = localStorage.getItem("sc"); return new Set(r ? JSON.parse(r) : []); } catch { return new Set(); } }
function saveSeen(id: string) { try { const r = localStorage.getItem("sc"); const a: string[] = r ? JSON.parse(r) : []; if (!a.includes(id)) { a.push(id); localStorage.setItem("sc", JSON.stringify(a)); } } catch {} }

function AllDocumentsPage({ showToast, orgId, token, gotoDoc, clearGotoDoc, agentFilter, setAgentFilter }: any) {
  const [docs, setDocs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [classifyQueue, setClassifyQueue] = useState<any[]>([]);
  const classifyQueueRef = useRef<any[]>([]);
  const seen = useRef<Set<string>>(loadSeen());
  const prevDocsRef = useRef<any[]>([]);

  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, []);

  useEffect(() => {
    if (gotoDoc) {
      setSelected(gotoDoc);
      clearGotoDoc();
    }
  }, [gotoDoc]);

  async function load() {
    try {
      const r = await authFetch(token, `${API}/api/v1/documents?q=&limit=200&organization_id=${orgId}`);
      const d = await r.json();
      const newDocs: any[] = d?.documents || d || [];

      const prev = prevDocsRef.current;
      const added: any[] = [];
      if (prev.length > 0) {
        for (const nd of newDocs) {
          if ((nd.status === "classified" || nd.status === "processed" || nd.status === "embedded") &&
              !seen.current.has(nd.id) && nd.document_type) {
            const old = prev.find((p: any) => p.id === nd.id);
            const prevStatus = old?.status || "";
            if (prevStatus !== nd.status && prevStatus !== "") {
              seen.current.add(nd.id); saveSeen(nd.id);
              added.push(nd);
            }
          }
        }
      } else {
        for (const nd of newDocs) {
          if ((nd.status === "classified" || nd.status === "processed" || nd.status === "embedded") &&
              !seen.current.has(nd.id) && nd.document_type) {
            seen.current.add(nd.id); saveSeen(nd.id);
            added.push(nd);
          }
        }
      }
      if (added.length > 0) {
        setTimeout(() => {
          classifyQueueRef.current = [...classifyQueueRef.current, ...added];
          setClassifyQueue([...classifyQueueRef.current]);
        }, 800);
      }

      prevDocsRef.current = newDocs;
      setDocs(newDocs);
    } catch { }
  }

  const handleDeleteDoc = async (doc: any) => {
    if (!confirm("Delete this document?")) return;
    await authFetch(token, `${API}/api/v1/documents/${doc.id}?organization_id=${orgId}`, { method: "DELETE" });
    showToast("Document deleted");
    if (selected?.id === doc.id) setSelected(null);
    load();
  };

  const nextInQueue = () => {
    classifyQueueRef.current.shift();
    setClassifyQueue([...classifyQueueRef.current]);
  };

  const handleTypeChange = async (docId: string, docType: string, phase3Agent: string) => {
    try {
      await authFetch(token, `${API}/api/v1/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_type: docType, phase3_agent: phase3Agent, organization_id: orgId }),
      });
      setDocs(prev => prev.map(d => d.id === docId ? { ...d, document_type: docType, phase3_agent: phase3Agent } : d));
      nextInQueue();
      showToast(`Type: ${DOC_TYPE_LABELS[docType] || docType} → ${agentLabel(phase3Agent)} ✅`);
    } catch {
      showToast("Failed to update document settings");
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      <FolderTree docs={docs} orgId={orgId} token={token}
        onSelectDoc={(d: any) => setSelected(d)} selectedDocId={selected?.id}
        onDeleteDoc={handleDeleteDoc}
        onUpload={() => { load(); showToast("Document uploaded successfully ✨"); }}
        agentFilter={agentFilter} onAgentFilter={setAgentFilter} />

      {/* detail panel */}
      <div className="flex-1 overflow-y-auto bg-gradient-surface p-6">
        {selected ? <DocDetail doc={selected} showToast={showToast} onDelete={() => { setSelected(null); load(); }} /> : (
          <div className="h-full flex items-center justify-center text-slate-300">
            <div className="text-center">
              <p className="text-5xl mb-4">📋</p>
              <p className="text-lg font-medium">Select a document from the folder to view details</p>
            </div>
          </div>
        )}
      </div>

      {/* classification popup queue */}
      {classifyQueue.length > 0 && (
        <ClassifyPopup
          key={classifyQueue[0].id}
          doc={classifyQueue[0]}
          queueLen={classifyQueue.length}
          onConfirm={handleTypeChange}
          onDismiss={() => nextInQueue()}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════
   FOLDER TREE PANEL (agent → type → files)
   Embedded in the Documents page, left of the doc list.
   ════════════════════════════════════════ */
function FolderTree({ docs, orgId, token, onSelectDoc, selectedDocId, onDeleteDoc, onUpload, agentFilter, onAgentFilter }: any) {
  const [search, setSearch] = useState("");

  const getDocAgent = (d: any) => d.phase3_agent || DOC_TYPE_TO_AGENT[d.document_type] || "other_agent";

  const q = search.trim().toLowerCase();
  const tree: Record<string, Record<string, any[]>> = {};
  for (const d of docs) {
    if (q && !((d.title || "").toLowerCase().includes(q))) continue;
    const agent = getDocAgent(d);
    if (agentFilter && agent !== agentFilter) continue;
    const type = d.document_type || "unclassified";
    (tree[agent] ||= {})[type] ||= [];
    tree[agent][type].push(d);
  }

  const agentOrder = AGENT_OPTIONS.filter(o => o.value).map(o => o.value);
  const visibleAgents = agentOrder.filter(a => tree[a] && Object.keys(tree[a]).length > 0);

  return (
    <div className="w-[320px] shrink-0 flex flex-col border-r border-slate-200/50 bg-white">
      <div className="p-3 border-b border-slate-200/50 space-y-2">
        <p className="text-sm font-bold text-slate-800">📁 Folders</p>
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400 transition-all"
            placeholder="Search files..." />
        </div>
        <div className="relative">
          <select value={agentFilter || ""} onChange={e => onAgentFilter?.(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs appearance-none cursor-pointer outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400 transition-all text-slate-600">
            {AGENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
        <UploadBox onUpload={onUpload} />
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {visibleAgents.length === 0 && (
          <p className="text-center text-xs text-slate-400 py-8">No documents</p>
        )}
        {visibleAgents.map(agent => {
          const types = Object.keys(tree[agent]).sort((a, b) => {
            if (a === "unclassified") return 1;
            if (b === "unclassified") return -1;
            return a.localeCompare(b);
          });
          const total = types.reduce((s, t) => s + tree[agent][t].length, 0);
          return (
            <details key={agent} className="rounded-lg border border-slate-200 overflow-hidden bg-white">
              <summary className="px-3 py-2 cursor-pointer hover:bg-slate-50 transition-colors flex items-center gap-2 text-sm font-semibold text-slate-800">
                <span>{agentLabel(agent)}</span>
                <span className="badge badge-xs bg-slate-100 text-slate-500 border-0">{total}</span>
              </summary>
              <div className="px-2 pb-2 space-y-1">
                {types.map(type => (
                  <details key={type} className="rounded-md bg-slate-50/60 border border-slate-100 overflow-hidden">
                    <summary className="px-2.5 py-1.5 cursor-pointer hover:bg-slate-100 transition-colors flex items-center gap-2 text-xs font-medium text-slate-700">
                      <span>📂 {DOC_TYPE_LABELS[type] || type}</span>
                      <span className="badge badge-xs bg-white text-slate-500 border-0">{tree[agent][type].length}</span>
                    </summary>
                    <div className="px-2 pb-1.5 space-y-0.5">
                      {tree[agent][type]
                        .slice()
                        .sort((a: any, b: any) => (a.title || "").localeCompare(b.title || ""))
                        .map((d: any) => (
                          <div key={d.id} className="flex items-center gap-1 group">
                            <button onClick={() => onSelectDoc?.(d)}
                              className={`flex-1 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md hover:bg-white border transition-all ${selectedDocId === d.id ? "border-indigo-300 bg-indigo-50/70" : "border-transparent hover:border-slate-200"}`}>
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="text-slate-400 group-hover:text-indigo-500 text-xs">📄</span>
                                <span className="text-xs text-slate-700 truncate">{d.title || d.original_file_url || "Untitled"}</span>
                              </span>
                              <span className="flex items-center gap-1 shrink-0">
                                <span className={`badge badge-xs ${statusColor(d.status)}`}>{d.status}</span>
                              </span>
                            </button>
                            <button onClick={() => onDeleteDoc?.(d)} className="p-1.5 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100" title="Delete document">
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   CHAT FOLDER TREE (selection-enabled)
   agent → type → file, with per-folder checkboxes
   so the user can select a whole folder or one file.
   ════════════════════════════════════════ */
function ChatFolderTree({ docs, selectedDocs, onToggleDoc, onToggleFolder, searchQuery, orgId, token }: any) {
  const selectedIds = new Set((selectedDocs || []).map((d: any) => d.id));
  const getDocAgent = (d: any) => d.phase3_agent || DOC_TYPE_TO_AGENT[d.document_type] || "other_agent";

  const q = (searchQuery || "").trim().toLowerCase();
  const tree: Record<string, Record<string, any[]>> = {};
  for (const d of docs) {
    if (q && !((d.title || "").toLowerCase().includes(q))) continue;
    const agent = getDocAgent(d);
    const type = d.document_type || "unclassified";
    (tree[agent] ||= {})[type] ||= [];
    tree[agent][type].push(d);
  }

  const agentOrder = AGENT_OPTIONS.filter(o => o.value).map(o => o.value);
  const visibleAgents = agentOrder.filter(a => tree[a] && Object.keys(tree[a]).length > 0);

  const folderState = (arr: any[]) => {
    const c = arr.filter((d: any) => selectedIds.has(d.id)).length;
    return { checked: arr.length > 0 && c === arr.length, indeterminate: c > 0 && c < arr.length };
  };

  return (
    <div className="space-y-1.5">
      {visibleAgents.length === 0 && (
        <p className="text-center text-xs text-slate-400 py-6">No documents</p>
      )}
      {visibleAgents.map(agent => {
        const types = Object.keys(tree[agent]).sort((a, b) => {
          if (a === "unclassified") return 1;
          if (b === "unclassified") return -1;
          return a.localeCompare(b);
        });
        const agentDocs = types.flatMap(t => tree[agent][t]);
        const ag = folderState(agentDocs);
        return (
          <details key={agent} className="rounded-lg border border-slate-200 overflow-hidden bg-white">
            <summary className="px-2 py-2 cursor-pointer hover:bg-slate-50 transition-colors flex items-center gap-2 text-sm font-semibold text-slate-800">
              <input type="checkbox" checked={ag.checked}
                ref={(el: any) => { if (el) el.indeterminate = ag.indeterminate; }}
                onChange={() => onToggleFolder(agentDocs)}
                onClick={e => e.stopPropagation()}
                className="checkbox checkbox-xs rounded border-slate-300 [--chkbg:#6366f1] shrink-0" />
              <span>{agentLabel(agent)}</span>
              <span className="badge badge-xs bg-slate-100 text-slate-500 border-0 ml-auto">{agentDocs.length}</span>
            </summary>
            <div className="px-2 pb-2 space-y-1">
              {types.map(type => {
                const typeDocs = tree[agent][type];
                const ty = folderState(typeDocs);
                return (
                  <details key={type} className="rounded-md bg-slate-50/60 border border-slate-100 overflow-hidden">
                    <summary className="px-2 py-1.5 cursor-pointer hover:bg-slate-100 transition-colors flex items-center gap-2 text-xs font-medium text-slate-700">
                      <input type="checkbox" checked={ty.checked}
                        ref={(el: any) => { if (el) el.indeterminate = ty.indeterminate; }}
                        onChange={() => onToggleFolder(typeDocs)}
                        onClick={e => e.stopPropagation()}
                        className="checkbox checkbox-xs rounded border-slate-300 [--chkbg:#6366f1] shrink-0" />
                      <span>📂 {DOC_TYPE_LABELS[type] || type}</span>
                      <span className="badge badge-xs bg-white text-slate-500 border-0 ml-auto">{typeDocs.length}</span>
                    </summary>
                    <div className="px-2 pb-1.5 space-y-0.5">
                      {typeDocs
                        .slice()
                        .sort((a: any, b: any) => (a.title || "").localeCompare(b.title || ""))
                        .map((d: any) => {
                          const sel = selectedIds.has(d.id);
                          return (
                            <div key={d.id}
                              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-all
                                ${sel ? "border-indigo-300 bg-indigo-50/60" : "border-transparent hover:bg-white hover:border-slate-200"}`}>
                              <input type="checkbox" checked={sel}
                                onChange={() => onToggleDoc(d.id)}
                                className="checkbox checkbox-xs rounded border-slate-300 [--chkbg:#6366f1] shrink-0" />
                              <label onClick={() => onToggleDoc(d.id)}
                                className="text-xs text-slate-700 truncate flex-1 cursor-pointer">{d.title || d.original_file_url || "Untitled"}</label>
                              <a href={`${API}/api/v1/documents/${d.id}/file?organization_id=${orgId}`} target="_blank"
                                className="text-slate-300 hover:text-indigo-500 shrink-0 transition-colors" title="Open file">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            </div>
                          );
                        })}
                    </div>
                  </details>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/* ─────── doc type → agent mapping ─────── */
const DOC_TYPE_TO_AGENT: Record<string, string> = {
  invoice: "finance_agent",
  financial_statement: "finance_agent",
  purchase_order: "procurement_agent",
  quotation: "procurement_agent",
  hr_document: "hr_agent",
  resume: "hr_agent",
  transcript: "hr_agent",
  contract: "legal_agent",
  sop: "compliance_agent",
  audit_report: "compliance_agent",
  quality_report: "compliance_agent",
  certificate: "compliance_agent",
  maintenance_report: "compliance_agent",
  engineering_drawing: "compliance_agent",
  other: "other_agent",
};

const DOC_TYPE_LABELS: Record<string, string> = {
  invoice: "Invoice",
  financial_statement: "Financial Statement",
  purchase_order: "Purchase Order",
  quotation: "Quotation",
  hr_document: "HR Document",
  resume: "Resume",
  transcript: "Transcript",
  contract: "Contract",
  sop: "SOP",
  audit_report: "Audit Report",
  quality_report: "Quality Report",
  certificate: "Certificate",
  maintenance_report: "Maintenance Report",
  engineering_drawing: "Engineering Drawing",
  other: "Other",
  unclassified: "Unclassified",
};

function agentLabel(a: string) {
  const m: Record<string, string> = {
    finance_agent: "💰 Finance Agent",
    procurement_agent: "📦 Procurement Agent",
    hr_agent: "👨‍💼 HR Agent",
    legal_agent: "⚖️ Legal Agent",
    compliance_agent: "✅ Compliance Agent",
    other_agent: "❓ Other Agent",
  };
  return m[a] || a;
}

/* ─────── Classification Popup ─────── */
function ClassifyPopup({ doc, queueLen = 1, onConfirm, onDismiss }: any) {
  const docTypeOptions = DOC_TYPE_OPTIONS.filter(o => o.value);
  const [docType, setDocType] = useState(doc.document_type || "other");
  const agent = DOC_TYPE_TO_AGENT[docType] || "other_agent";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm fade-in" onClick={onDismiss}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 mx-4 border border-slate-200 slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-lg text-slate-800">Classification Result</h3>
              {queueLen > 1 && (
                <span className="badge badge-sm bg-indigo-100 text-indigo-700 border-0 font-semibold">1 of {queueLen}</span>
              )}
            </div>
            <p className="text-sm text-slate-500 truncate max-w-[300px]">{doc.title || "Untitled"}</p>
          </div>
        </div>

        <div className="mb-4">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Document Type</label>
          <div className="relative">
            <select value={docType} onChange={e => setDocType(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm appearance-none cursor-pointer outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400 transition-all">
              {docTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-4 mb-4 border border-indigo-100">
          <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wider mb-1">Folder / Agent</p>
          <p className="text-lg font-bold text-slate-800">{agentLabel(agent)}</p>
        </div>

        <div className="flex gap-3">
          <button onClick={() => onDismiss()}
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-all">
            Dismiss
          </button>
          <button onClick={() => onConfirm(doc.id, docType, agent)}
            className="flex-1 px-4 py-2.5 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition-all shadow-md shadow-indigo-200">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────── Upload Box ─────── */
function UploadBox({ onUpload }: any) {
  const { orgId, token } = useAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const pendingIds = useRef<Set<string>>(new Set());

  const addFiles = (list: FileList) => {
    setFiles(prev => [...prev, ...Array.from(list)].slice(0, 5));
  };

  const upload = async () => {
    if (!files.length) return;
    setUploading(true);
    const ids: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const fd = new FormData();
      fd.append("file", files[i]);
      fd.append("organization_id", orgId);
      try {
        const r = await authFetch(token, `${API}/api/v1/documents/upload`, { method: "POST", body: fd });
        const data = await r.json();
        if (data?.id) ids.push(data.id);
      } catch { }
    }
    ids.forEach(id => pendingIds.current.add(id));
    onUpload?.();

    const poll = setInterval(async () => {
      try {
        const r = await authFetch(token, `${API}/api/v1/documents?q=&limit=200&organization_id=${orgId}`);
        const d = await r.json();
        const allDocs: any[] = d?.documents || d || [];
        const done: string[] = [];
        for (const id of Array.from(pendingIds.current)) {
          const doc = allDocs.find((x: any) => x.id === id);
          if (doc && (doc.status === "processed" || doc.status === "failed" || doc.status === "error")) {
            done.push(id);
          }
        }
        done.forEach(id => pendingIds.current.delete(id));
        if (pendingIds.current.size === 0) {
          clearInterval(poll);
          setUploading(false);
          setFiles([]);
        }
      } catch { }
    }, 3000);
  };

  return (
    <div className="px-3 pb-3">
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        onClick={() => ref.current?.click()}
        className={`relative cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition-all duration-200
          ${drag ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30"}`}>
        <input ref={ref} type="file" hidden multiple accept=".pdf,.jpg,.jpeg,.png,.tiff,.tif,.bmp,.webp,.docx,.xlsx,.pptx,.txt"
          onChange={e => e.target.files && addFiles(e.target.files)} />
        <div className="flex flex-col items-center gap-1.5">
          <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="text-xs font-medium text-slate-600">
            {drag ? "Drop here" : "Drop files or click to upload"}
          </p>
          <p className="text-[10px] text-slate-400">PDF, Images, Office docs</p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {files.map((f, i) => (
            <div key={i} className="relative flex items-center justify-between px-3 py-2 bg-white rounded-lg border border-slate-200 text-xs overflow-hidden">
              <span className="truncate text-slate-700 font-medium">{f.name}</span>
              <span className="text-slate-400 shrink-0 ml-2">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
              {uploading && (
                <div className="absolute inset-0 bg-white/80 flex items-center justify-center rounded-lg">
                  <div className="spinner-sm" />
                </div>
              )}
            </div>
          ))}
          <button onClick={upload} disabled={uploading}
            className="btn btn-primary btn-sm w-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white border-0 shadow-lg shadow-indigo-500/20 hover:shadow-xl hover:shadow-indigo-500/30 transition-all">
            {uploading ? <><div className="spinner-sm inline-block mr-1.5" /> Uploading...</> : `Upload ${files.length} file${files.length > 1 ? "s" : ""}`}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────── Doc Detail ─────── */
function DocDetail({ doc, showToast, onDelete }: any) {
  const { orgId, token } = useAuth();
  const [similar, setSimilar] = useState<any[]>([]);
  const [images, setImages] = useState<any[]>([]);
  const [descFileUrl, setDescFileUrl] = useState("");
  const [cvData, setCvData] = useState<any>(null);
  const [reclassifying, setReclassifying] = useState(false);

  useEffect(() => {
    authFetch(token, `${API}/api/v1/search/similar/${doc.id}?organization_id=${orgId}`)
      .then(r => r.json()).then(d => setSimilar(d?.results || d || [])).catch(() => {});
    authFetch(token, `${API}/api/v1/documents/${doc.id}/images?organization_id=${orgId}`)
      .then(r => r.json()).then(d => { setImages(d?.images || []); setDescFileUrl(d?.descriptions_file || ""); }).catch(() => {});
    if (doc.document_type === "resume") {
      authFetch(token, `${API}/api/v1/documents/${doc.id}?organization_id=${orgId}`)
        .then(r => r.json()).then(d => setCvData(d?.cv_extraction_data || null)).catch(() => {});
    }
  }, [doc.id]);

  const del = async () => {
    if (!confirm("Delete this document?")) return;
    await authFetch(token, `${API}/api/v1/documents/${doc.id}?organization_id=${orgId}`, { method: "DELETE" });
    showToast("Document deleted");
    onDelete?.();
  };

  const reclassify = async () => {
    setReclassifying(true);
    try {
      const r = await authFetch(token, `${API}/api/v1/documents/${doc.id}/classify?organization_id=${orgId}`, { method: "POST" });
      if (r.ok) {
        showToast("Reclassification complete ✅");
        onDelete?.();
      } else {
        const err = await r.json().catch(() => ({}));
        showToast(`❌ ${err.detail || "Reclassification failed"}`);
      }
    } catch {
      showToast("❌ Network error during reclassification");
    } finally {
      setReclassifying(false);
    }
  };

  return (
    <div className="max-w-2xl slide-up">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">{doc.title || "Untitled"}</h2>
          <div className="flex gap-2 mt-2">
            <span className={`badge ${typeColor(doc.document_type)}`}>{doc.document_type || "unknown"}</span>
            <span className={`badge ${statusColor(doc.status)}`}>{doc.status}</span>
          </div>
        </div>
        <button onClick={del} className="btn btn-ghost btn-sm text-red-400 hover:bg-red-50 hover:text-red-500">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        {[
          ["File", doc.original_file_url?.split("/").pop() || "—"],
          ["Pages", doc.page_count ?? "—"],
          ["Size", doc.file_size ? `${(doc.file_size / 1024).toFixed(0)} KB` : "—"],
          ["Created", doc.created_at ? new Date(doc.created_at).toLocaleDateString() : "—"],
        ].map(([l, v]) => (
          <div key={l} className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{l}</p>
            <p className="text-sm font-semibold text-slate-700 mt-1 truncate">{v}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-6">
        {doc.original_file_url && (
          <a href={`${API}/api/v1/documents/${doc.id}/file?organization_id=${orgId}`} target="_blank"
            className="btn btn-outline btn-sm border-slate-300 text-slate-600 hover:bg-slate-100">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Open File
          </a>
        )}
        <button onClick={reclassify} disabled={reclassifying}
          className="btn btn-ghost btn-sm text-indigo-500 hover:bg-indigo-50">
          {reclassifying ? <><span className="loading loading-spinner loading-xs mr-1" /> Reclassifying...</> : (
            <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg> Reclassify with AI</>
          )}
        </button>
      </div>

      {doc.raw_text && (
        <details className="bg-white rounded-xl border border-slate-200 mb-6 overflow-hidden">
          <summary className="px-4 py-3 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            OCR Preview ({doc.raw_text.length.toLocaleString()} chars)
            {descFileUrl && (
              <a href={`${API}${descFileUrl}`} target="_blank" onClick={e => e.stopPropagation()}
                className="ml-3 text-xs text-blue-500 hover:text-blue-700 underline">
                Download All Descriptions
              </a>
            )}
          </summary>
          <div className="max-h-96 overflow-y-auto p-4 bg-slate-50 text-xs text-slate-600 font-mono leading-relaxed whitespace-pre-wrap">
            {doc.raw_text.slice(0, 10000)}
          </div>
        </details>
      )}

      {images.length > 0 && (
        <details className="bg-white rounded-xl border border-slate-200 mb-6 overflow-hidden">
          <summary className="px-4 py-3 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
            Image Previews ({images.length})
          </summary>
          <div className="divide-y divide-slate-100">
            {images.map((img: any, i: number) => (
              <div key={i} className="p-4">
                <p className="text-xs font-medium text-slate-400 mb-1">Page {img.page}</p>
                {img.image_path && (
                  <img src={`${API}/api/v1/documents/image/${img.image_path}`} alt={`Page ${img.page}`}
                    className="max-h-48 rounded-lg border border-slate-200 mb-2 object-contain bg-slate-50" />
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {doc.document_type === "resume" && cvData && (
        <details className="bg-white rounded-xl border border-slate-200 mb-6 overflow-hidden" open>
          <summary className="px-4 py-3 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
            CV Evaluation
            {doc.cv_score != null && (
              <span className={`ml-auto badge ${doc.cv_score >= 70 ? "badge-success" : doc.cv_score >= 40 ? "badge-warning" : "badge-error"}`}>
                Score: {doc.cv_score}/100
              </span>
            )}
          </summary>
          <div className="p-4 space-y-3">
            {["skills_score", "experience_score", "education_score", "completeness_score"].map((key) => {
              const val = cvData[key];
              if (val == null) return null;
              const pct = Math.min(100, Math.max(0, Number(val)));
              return (
                <div key={key}>
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span className="capitalize">{key.replace(/_score$/, "")} Score</span>
                    <span>{pct}/100</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500"}`}
                      style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}

            {cvData.strengths?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-1">Strengths</p>
                <div className="flex flex-wrap gap-1.5">
                  {cvData.strengths.map((s: string, i: number) => (
                    <span key={i} className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs border border-emerald-200">{s}</span>
                  ))}
                </div>
              </div>
            )}

            {cvData.areas_for_improvement?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-1">Areas for Improvement</p>
                <div className="flex flex-wrap gap-1.5">
                  {cvData.areas_for_improvement.map((a: string, i: number) => (
                    <span key={i} className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 text-xs border border-amber-200">{a}</span>
                  ))}
                </div>
              </div>
            )}

            {cvData.recommendation && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-1">Recommendation</p>
                <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 border border-slate-200">{cvData.recommendation}</p>
              </div>
            )}

            {cvData.evaluation_summary && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-1">Evaluation Summary</p>
                <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 border border-slate-200">{cvData.evaluation_summary}</p>
              </div>
            )}
          </div>
        </details>
      )}

      {similar.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Similar Documents</h3>
          <div className="space-y-2">
            {similar.slice(0, 5).map((s: any, i: number) => (
              <div key={i} className="flex items-center justify-between bg-white rounded-xl border border-slate-200 px-4 py-3">
                <span className="text-sm text-slate-700 truncate">{s.document_title || s.document_id?.slice(0, 12)}</span>
                <span className="text-xs text-slate-400 ml-2">{(s.score * 100).toFixed(0)}% match</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════
   CHAT SECTION
   ════════════════════════════════════════ */
function ChatSection({ showToast, selectedDocs, setSelectedDocs, orgId, token, agentFilter }: any) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgsContainerRef = useRef<HTMLDivElement>(null);

  /* ── "ask about this" (select a response excerpt → follow-up) ── */
  const [focusedExcerpt, setFocusedExcerpt] = useState("");
  const [selPopover, setSelPopover] = useState<{ text: string; x: number; y: number } | null>(null);

  const isInsideAssistant = (node: Node | null): boolean => {
    while (node) {
      if ((node as HTMLElement).dataset?.role === "assistant") return true;
      node = node.parentNode;
    }
    return false;
  };

  const handleSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setSelPopover(null); return; }
    const text = sel.toString().trim();
    if (!text) { setSelPopover(null); return; }
    // Allow selection only when BOTH ends are inside an assistant message
    // (handles right-to-left backward selections)
    if (!isInsideAssistant(sel.anchorNode) || !isInsideAssistant(sel.focusNode)) {
      setSelPopover(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelPopover({ text, x: rect.left + rect.width / 2, y: rect.top - 8 });
  };

  const startExcerptQuestion = () => {
    if (!selPopover) return;
    setFocusedExcerpt(selPopover.text);
    setSelPopover(null);
    window.getSelection()?.removeAllRanges();
    inputRef.current?.focus();
  };

  // Dismiss the popover when scrolling or clicking outside the messages area
  useEffect(() => {
    if (!selPopover) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (t && (t as HTMLElement).closest && (t as HTMLElement).closest("[data-popover-btn]")) return;
      if (msgsContainerRef.current && !msgsContainerRef.current.contains(t)) {
        setSelPopover(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selPopover]);

  /* ── left panel state ── */
  const [searchQuery, setSearchQuery] = useState("");
  const [panelFilter, setPanelFilter] = useState<"all" | "docs" | "chat">("all");
  const [allDocs, setAllDocs] = useState<any[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  useEffect(() => {
    loadDocs();
    const i = setInterval(loadDocs, 7000);
    return () => clearInterval(i);
  }, []);

  async function loadDocs() {
    try {
      const r = await authFetch(token, `${API}/api/v1/documents?q=&limit=200&organization_id=${orgId}`);
      const d = await r.json();
      setAllDocs(d?.documents || d || []);
    } catch {} finally { setDocsLoading(false); }
  }

  const getDocAgent = (d: any) =>
    d.phase3_agent || DOC_TYPE_TO_AGENT[d.document_type] || "other_agent";

  const filteredDocs = allDocs.filter((d: any) => {
    const matchSearch = !searchQuery || (d.title || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchAgent = !agentFilter || getDocAgent(d) === agentFilter;
    return matchSearch && matchAgent;
  }).sort((a: any, b: any) => {
    const aResume = a.document_type === "resume" && a.cv_score != null;
    const bResume = b.document_type === "resume" && b.cv_score != null;
    if (aResume && bResume) return (b.cv_score || 0) - (a.cv_score || 0);
    if (aResume) return -1;
    if (bResume) return 1;
    return 0;
  });

  const filteredSessions = sessions.filter((s: any) =>
    !searchQuery || (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sessionsRefresh = useCallback(() => {
    authFetch(token, `${API}/api/v1/chat/sessions?organization_id=${orgId}`)
      .then(r => r.json()).then(d => setSessions(d?.sessions || d || [])).catch(() => {});
  }, []);

  useEffect(() => { sessionsRefresh(); }, []);

  const loadSession = useCallback(async (sid: string) => {
    try {
      const r = await authFetch(token, `${API}/api/v1/chat/sessions/${sid}?organization_id=${orgId}`);
      const d = await r.json();
      const msgs = d?.messages || [];
      setMessages(msgs.map((m: any) => ({ role: m.role, content: m.content })));
      setActiveSessionId(sid);
      const storedIds: string[] = d?.document_ids || [];
      if (storedIds.length > 0) {
        const dr = await authFetch(token, `${API}/api/v1/documents?q=&limit=200&organization_id=${orgId}`);
        const dd = await dr.json();
        const allDocsList: any[] = dd?.documents || dd || [];
        setSelectedDocs(allDocsList.filter((x: any) => storedIds.includes(x.id)));
      } else {
        setSelectedDocs([]);
      }
    } catch { }
  }, []);

  const newSession = () => {
    setMessages([]);
    setActiveSessionId(null);
    setSources([]);
    setSelectedDocs([]);
  };

  const deleteSession = async (sid: string) => {
    await authFetch(token, `${API}/api/v1/chat/sessions/${sid}?organization_id=${orgId}`, { method: "DELETE" });
    setSessions(prev => prev.filter(s => s.id !== sid));
    if (activeSessionId === sid) newSession();
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs((prev: any[]) =>
      prev.find((d: any) => d.id === id) ? prev.filter((d: any) => d.id !== id) : [...prev, allDocs.find((d: any) => d.id === id)]
    );
  };

  // Select (or deselect) every document inside a folder. If all are already
  // selected the whole folder is removed; otherwise the whole folder is added.
  const toggleFolder = (docsInFolder: any[]) => {
    if (!docsInFolder || docsInFolder.length === 0) return;
    setSelectedDocs((prev: any[]) => {
      const selSet = new Set(prev.map((d: any) => d.id));
      const allSelected = docsInFolder.every((d: any) => selSet.has(d.id));
      if (allSelected) {
        const removeSet = new Set(docsInFolder.map((d: any) => d.id));
        return prev.filter((d: any) => !removeSet.has(d.id));
      }
      const merged = [...prev];
      for (const d of docsInFolder) if (!selSet.has(d.id)) merged.push(d);
      return merged;
    });
  };

  const renderAnswerWithLinks = (text: string, msgSources: any[]) => {
    const nameMap = new Map<string, any>();
    msgSources.forEach(s => {
      const name = (s.display_name || s.document_title || "").toLowerCase();
      if (name) nameMap.set(name, s);
    });
    const refRe = /\[([^\]]+?)\s+page\s+(\d+)\]/gi;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = refRe.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
      const filename = match[1];
      const page = match[2];
      const source = nameMap.get(filename.toLowerCase());
      if (source) {
        parts.push(
          <a key={match.index}
            href={`${API}/api/v1/documents/${source.document_id}/file?organization_id=${orgId}&page=${page}`}
            target="_blank"
            className="text-indigo-600 underline hover:text-indigo-800 font-medium"
          >{filename} p.{page}</a>
        );
      } else {
        parts.push(match[0]);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts.length > 0 ? parts : text;
  };

  const send = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setQuestion("");
    setMessages(prev => [...prev, { role: "user", content: q }]);
    setLoading(true);
    setSources([]);

    try {
      const docIds = selectedDocs.map((d: any) => d.id);
      const body: any = { question: q, organization_id: orgId, document_ids: docIds, phase3_agent: agentFilter || undefined };
      if (activeSessionId) body.session_id = activeSessionId;
      if (focusedExcerpt) body.selected_text = focusedExcerpt;

      const r = await authFetch(token, `${API}/api/v1/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();

      setMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
      if (data.session_id) setActiveSessionId(data.session_id);
      if (data.sources) setSources(data.sources);
      setFocusedExcerpt("");

      sessionsRefresh();
    } catch { setMessages(prev => [...prev, { role: "assistant", content: "⚠️ Connection error. Please check the backend." }]); }
    finally { setLoading(false); }
  };

  const SWITCH_OPTIONS = [
    { value: "all" as const, label: "All" },
    { value: "docs" as const, label: "Documents" },
    { value: "chat" as const, label: "Chat" },
  ];

  const showSessionsList = panelFilter === "all" || panelFilter === "chat";
  const showDocsList = panelFilter === "all" || panelFilter === "docs";

  return (
    <div className="flex-1 flex overflow-hidden bg-white">
      {/* ── left panel: docs + sessions ── */}
      <div className="w-[380px] shrink-0 flex flex-col border-r border-slate-200/50 bg-white">
        {/* search */}
        <div className="p-3 pb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400 transition-all"
                placeholder="Search documents & chat..." />
            </div>
          </div>
          {/* segmented control */}
          <div className="flex gap-1 mt-2 p-0.5 bg-slate-100/80 rounded-lg">
            {SWITCH_OPTIONS.map(o => (
              <button key={o.value} onClick={() => setPanelFilter(o.value)}
                className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-all
                  ${panelFilter === o.value ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          {/* docs section: folder tree (agent → type → file) */}
          {showDocsList && (
            <>
              {docsLoading && [...Array(2)].map((_, i) => (
                <div key={`s-${i}`} className="h-14 rounded-xl bg-slate-100 animate-pulse" />
              ))}
              {!docsLoading && filteredDocs.length > 0 && (
                <ChatFolderTree
                  docs={filteredDocs}
                  selectedDocs={selectedDocs}
                  onToggleDoc={toggleDoc}
                  onToggleFolder={toggleFolder}
                  searchQuery={searchQuery}
                  orgId={orgId}
                  token={token}
                />
              )}
              {!docsLoading && filteredDocs.length === 0 && (
                <div className="text-center py-8 text-slate-400">
                  <p className="text-2xl mb-1">📄</p>
                  <p className="text-xs font-medium">No documents</p>
                </div>
              )}
            </>
          )}

          {/* sessions section */}
          {showSessionsList && (
            <>
              {panelFilter === "all" && filteredSessions.length > 0 && filteredDocs.length > 0 && (
                <div className="border-t border-slate-100 pt-2 mt-1" />
              )}
              {panelFilter === "all" && filteredSessions.length > 0 && (
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-1 pt-1 pb-0.5">Chat History</p>
              )}
              {filteredSessions.map((s: any) => (
                <div key={s.id}
                  className={`group flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all
                    ${activeSessionId === s.id ? "border-indigo-200 bg-indigo-50/50" : "border-slate-200 bg-white hover:border-slate-300"}`}
                  onClick={() => loadSession(s.id)}>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-700 truncate">{s.title || "New Chat"}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{timeAgo(s.updated_at || s.created_at)}</p>
                  </div>
                  <button onClick={e => { e.stopPropagation(); deleteSession(s.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-50 rounded-lg transition-all shrink-0">
                    <svg className="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
              {panelFilter === "chat" && filteredSessions.length === 0 && !docsLoading && (
                <div className="text-center py-8 text-slate-400">
                  <p className="text-2xl mb-1">💬</p>
                  <p className="text-xs font-medium">No chat sessions</p>
                </div>
              )}
            </>
          )}

        </div>
      </div>

      {/* ── right panel: chat ── */}
      <div className="flex-1 flex flex-col bg-white">
        {/* header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg gradient-primary flex items-center justify-center shadow-md">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-slate-700">Chat</span>
          </div>
          <button onClick={newSession}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-xs font-semibold hover:shadow-md transition-all active:scale-95">
            + New Chat
          </button>
        </div>

        {/* selected docs chips */}
        {selectedDocs.length > 0 && (
          <div className="shrink-0 flex items-center gap-2 px-5 py-2 bg-indigo-50/40 border-b border-indigo-100/50 overflow-x-auto">
            <span className="text-[11px] font-semibold text-indigo-500 uppercase tracking-wider shrink-0">Context:</span>
            {selectedDocs.map((d: any) => (
              <span key={d.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-indigo-200 text-xs font-medium text-indigo-700 shadow-sm whitespace-nowrap shrink-0">
                {d.title || d.id.slice(0, 8)}
                <button onClick={() => {
                  setSelectedDocs((prev: any[]) => prev.filter((x: any) => x.id !== d.id));
                }} className="hover:text-red-500 transition-colors">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
            <button onClick={() => setSelectedDocs([])} className="text-[11px] text-slate-400 hover:text-red-400 shrink-0 transition-colors">
              Clear
            </button>
          </div>
        )}

        {/* messages */}
        <div ref={msgsContainerRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4" onMouseUp={handleSelection} onScroll={() => setSelPopover(null)}>
          {messages.length === 0 && !loading && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/20">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <h3 className="text-xl font-bold text-slate-700 mb-2">How can I help you?</h3>
                <p className="text-sm text-slate-400 leading-relaxed">
                  Select documents from the left panel and ask questions about them.
                </p>
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const isLastAssistant = m.role === "assistant" && i === messages.length - 1;
            return (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} message-appear`}>
              <div className={`max-w-[75%] ${m.role === "user" ? "order-1" : "order-1"}`}>
                {m.role === "user" ? (
                  <div className="px-4 py-3 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-lg shadow-indigo-500/20">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-xl gradient-primary flex items-center justify-center shadow-md shrink-0 mt-0.5">
                      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                      </svg>
                    </div>
                    <div className="px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200/60 shadow-sm" data-role="assistant">
                      <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap">{renderAnswerWithLinks(m.content, isLastAssistant ? sources : [])}</p>
                      {isLastAssistant && sources.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-200/60 space-y-1.5">
                          {sources.map((s: any, si: number) => (
                            <a key={si}
                              href={`${API}/api/v1/documents/${s.document_id}/file?organization_id=${orgId}&page=${s.page_number || 0}`}
                              target="_blank"
                              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all no-underline group">
                              <span className="flex-1 text-xs font-medium text-slate-700 group-hover:text-indigo-700 truncate">
                                {s.document_title || s.document_id?.slice(0, 8)}
                              </span>
                              <span className="text-[10px] text-slate-400 shrink-0">
                                {s.page_number ? `p.${s.page_number}` : `${(s.score * 100).toFixed(0)}%`}
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}

          {loading && (
            <div className="flex justify-start message-appear">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl gradient-primary flex items-center justify-center shadow-md shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                </div>
                <div className="px-5 py-3.5 rounded-2xl bg-slate-50 border border-slate-200/60 shadow-sm">
                  <TypingDots />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* focused excerpt chip ("ask about this") */}
        {focusedExcerpt && (
          <div className="shrink-0 px-5 pt-2">
            <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200">
              <svg className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider mb-0.5">Asking about this selection</div>
                <div className="text-xs text-amber-800 line-clamp-2 italic">“{focusedExcerpt}”</div>
              </div>
              <button onClick={() => setFocusedExcerpt("")} className="shrink-0 text-amber-500 hover:text-red-500 transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* selection popover for "ask about this" */}
        {selPopover && (
          <button data-popover-btn
            onClick={startExcerptQuestion}
            style={{ position: "fixed", left: selPopover.x, top: selPopover.y, transform: "translate(-50%, -100%)" }}
            className="z-50 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium shadow-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
            Ask about this
          </button>
        )}

        {/* input */}
        <div className="shrink-0 px-5 py-3 border-t border-slate-100">
          <div className="flex items-center gap-2 bg-slate-50 rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400/30 focus-within:border-indigo-400 transition-all">
            <input ref={inputRef} value={question} onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
              className="flex-1 bg-transparent px-4 py-3 text-sm outline-none text-slate-700 placeholder:text-slate-400"
              placeholder="Ask a question about your documents..."
              disabled={loading} />
            <button onClick={send} disabled={loading || !question.trim()}
              className="mr-1.5 p-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-indigo-500/30 active:scale-95">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   SEARCH SECTION
   ════════════════════════════════════════ */
const DOC_TYPE_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "invoice", label: "Invoice" },
  { value: "purchase_order", label: "Purchase Order" },
  { value: "contract", label: "Contract" },
  { value: "quotation", label: "Quotation" },
  { value: "hr_document", label: "HR Document" },
  { value: "audit_report", label: "Audit Report" },
  { value: "quality_report", label: "Quality Report" },
  { value: "certificate", label: "Certificate" },
  { value: "maintenance_report", label: "Maintenance Report" },
  { value: "financial_statement", label: "Financial Statement" },
  { value: "engineering_drawing", label: "Engineering Drawing" },
  { value: "sop", label: "SOP" },
  { value: "resume", label: "Resume" },
  { value: "transcript", label: "Transcript" },
  { value: "other", label: "Other" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "processed", label: "Processed" },
  { value: "failed", label: "Failed" },
  { value: "processing", label: "Processing" },
  { value: "uploaded", label: "Uploaded" },
  { value: "classified", label: "Classified" },
  { value: "extracted", label: "Extracted" },
];

function SearchSection({ showToast, orgId, token, onOpenDoc }: any) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searched, setSearched] = useState(false);
  const [docType, setDocType] = useState("");
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  /* ── chat state ── */
  const [messages, setMessages] = useState<any[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [sources, setSources] = useState<any[]>([]);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const [selectedChatDocIds, setSelectedChatDocIds] = useState<string[]>([]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, chatLoading]);

  /* ── upload polling ── */
  const [allDocs, setAllDocs] = useState<any[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  useEffect(() => {
    loadDocs();
    const i = setInterval(loadDocs, 5000);
    return () => clearInterval(i);
  }, []);

  async function loadDocs() {
    try {
      const r = await authFetch(token, `${API}/api/v1/documents?q=&limit=200&organization_id=${orgId}`);
      const d = await r.json();
      setAllDocs(d?.documents || d || []);
    } catch {} finally { setDocsLoading(false); }
  }

  const docs = allDocs.filter((d: any) => {
    if (d.status !== "processed" && d.status !== "failed" && d.status !== "error" && d.status !== "processing") return false;
    return true;
  });

  /* ── search ── */
  const doSearch = async (newOffset = 0) => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setSearched(true);
    try {
      const params = new URLSearchParams({
        query: q,
        organization_id: orgId,
        limit: "20",
        offset: String(newOffset),
      });
      if (docType) params.set("document_type", docType);
      if (agent) params.set("phase3_agent", agent);
      if (status) params.set("status", status);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);

      const r = await authFetch(token, `${API}/api/v1/search?${params.toString()}`);
      const d = await r.json();
      const items: any[] = d?.results || d || [];
      if (newOffset === 0) {
        setResults(items);
      } else {
        setResults(prev => [...prev, ...items]);
      }
      setTotal(d?.total || items.length);
      setOffset(newOffset);
    } catch {
      showToast("Search failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setResults([]);
    setOffset(0);
    doSearch(0);
  };

  const loadMore = () => {
    doSearch(offset + 20);
  };

  const renderAnswerWithLinks = (text: string, msgSources: any[]) => {
    const nameMap = new Map<string, any>();
    msgSources.forEach(s => {
      const name = (s.display_name || s.document_title || "").toLowerCase();
      if (name) nameMap.set(name, s);
    });
    const refRe = /\[([^\]]+?)\s+page\s+(\d+)\]/gi;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = refRe.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
      const filename = match[1];
      const page = match[2];
      const source = nameMap.get(filename.toLowerCase());
      if (source) {
        parts.push(
          <a key={match.index}
            href={`${API}/api/v1/documents/${source.document_id}/file?organization_id=${orgId}&page=${page}`}
            target="_blank"
            className="text-indigo-600 underline hover:text-indigo-800 font-medium"
          >{filename} p.{page}</a>
        );
      } else {
        parts.push(match[0]);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts.length > 0 ? parts : text;
  };

  /* ── chat send ── */
  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading) return;
    setChatInput("");
    setMessages(prev => [...prev, { role: "user", content: q }]);
    setChatLoading(true);
    setSources([]);
    try {
      const body: any = {
        question: q,
        organization_id: orgId,
        document_ids: selectedChatDocIds.length > 0 ? selectedChatDocIds : [],
        document_type: docType || undefined,
        phase3_agent: agent || undefined,
        status: status || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      };
      Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
      const r = await authFetch(token, `${API}/api/v1/chat${selectedChatDocIds.length > 0 ? "" : "/all"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      setMessages(prev => [...prev, { role: "assistant", content: data.answer }]);
      if (data.sources) setSources(data.sources);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "⚠️ Connection error" }]);
    } finally {
      setChatLoading(false);
    }
  };

  const toggleDocForChat = (id: string) => {
    setSelectedChatDocIds(prev => prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id]);
  };

  const displayedItems = searched ? results : docs;

  return (
    <div className="flex-1 flex overflow-hidden bg-white">
      {/* ── left panel: docs / search results ── */}
      <div className="w-[420px] shrink-0 flex flex-col border-r border-slate-200/50 bg-white">
        {/* search bar */}
        <div className="p-3 pb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400 transition-all"
                placeholder="Search documents..." />
            </div>
            <button onClick={handleSearch} disabled={loading || !query.trim()}
              className="px-3 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-xs font-semibold disabled:opacity-40 transition-all hover:shadow-md active:scale-95">
              {loading ? <div className="spinner-sm" /> : "Go"}
            </button>
          </div>
          {/* filter row */}
          <div className="flex gap-1.5 mt-1.5">
            <div className="relative flex-1">
              <select value={docType} onChange={e => setDocType(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10px] appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-indigo-400/30 focus:border-indigo-400 text-slate-600 pr-6">
                {DOC_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <svg className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <div className="relative flex-1">
              <select value={agent} onChange={e => setAgent(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10px] appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-indigo-400/30 focus:border-indigo-400 text-slate-600 pr-6">
                <option value="">All Agents</option>
                {AGENT_OPTIONS.filter((o: any) => o.value).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <svg className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <div className="relative flex-1">
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[10px] appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-indigo-400/30 focus:border-indigo-400 text-slate-600 pr-6">
                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <svg className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>

        {/* doc / result list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
          {docsLoading && [...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-slate-100 animate-pulse" />
          ))}
          {!docsLoading && !searched && docs.length === 0 && (
            <div className="text-center py-10 text-slate-400">
              <p className="text-3xl mb-1">📄</p>
              <p className="text-xs font-medium">No documents</p>
            </div>
          )}
          {searched && !loading && results.length === 0 && (
            <div className="text-center py-10 text-slate-400">
              <p className="text-3xl mb-1">🔍</p>
              <p className="text-xs font-medium">No results</p>
            </div>
          )}
          {Array.isArray(displayedItems) && displayedItems.map((item: any, i: number) => {
            const isSearchResult = searched && item.score !== undefined;
            const doc = isSearchResult ? allDocs.find((d: any) => d.id === item.document_id) : item;
            const isSelected = selectedChatDocIds.includes(isSearchResult ? item.document_id : item.id);
            return (
              <div key={isSearchResult ? `r-${i}` : item.id}
                className={`p-3 rounded-xl border transition-all duration-200 cursor-pointer
                  ${isSelected ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200 bg-white hover:border-slate-300"}
                  ${isSearchResult ? "hover:border-indigo-300" : ""}`}
                onClick={() => {
                  if (isSearchResult) onOpenDoc(item);
                }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <input type="checkbox" checked={isSelected}
                        onChange={() => toggleDocForChat(isSearchResult ? item.document_id : item.id)}
                        className="checkbox checkbox-xs rounded border-slate-300 [--chkbg:#6366f1] shrink-0"
                        onClick={e => e.stopPropagation()} />
                      <p className="font-semibold text-xs text-slate-800 truncate">
                        {doc?.title || item.document_title || item.title || "Untitled"}
                      </p>
                    </div>
                    <div className="flex gap-1 mt-1 ml-5">
                      <span className={`badge badge-xs ${typeColor(doc?.document_type || item.document_type)}`}>
                        {doc?.document_type || item.document_type || "unknown"}
                      </span>
                      {isSearchResult && (
                        <span className={`badge badge-xs ${(item.score || 0) > 0.7 ? "badge-success" : (item.score || 0) > 0.4 ? "badge-warning" : "badge-ghost"}`}>
                          {(item.score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {isSearchResult && item.chunk_text && (
                      <p className="text-[10px] text-slate-400 mt-1 ml-5 leading-relaxed line-clamp-2">
                        {item.chunk_text.slice(0, 150)}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {searched && results.length > 0 && results.length < total && (
            <button onClick={loadMore} disabled={loading}
              className="w-full text-center py-2 text-xs text-slate-400 hover:text-indigo-500 transition-colors">
              {loading ? "Loading..." : `Load More (${results.length}/${total})`}
            </button>
          )}
        </div>
      </div>

      {/* ── right panel: chat ── */}
      <div className="flex-1 flex flex-col bg-white">
        {/* chat header */}
        <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-b border-slate-100">
          <div className="w-7 h-7 rounded-lg gradient-primary flex items-center justify-center shadow-md">
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-slate-700">Ask about documents</span>
          {selectedChatDocIds.length > 0 && (
            <span className="text-[10px] text-indigo-500 font-medium ml-auto">{selectedChatDocIds.length} doc{selectedChatDocIds.length > 1 ? "s" : ""} selected</span>
          )}
        </div>

        {/* messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.length === 0 && !chatLoading && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-sm">
                <div className="w-12 h-12 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-3 shadow-lg shadow-indigo-500/20">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                </div>
                <h3 className="text-base font-bold text-slate-700 mb-1">Ask anything</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Select documents from the left panel with checkboxes, then ask questions. Search to find specific content.
                </p>
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const isLastAssistant = m.role === "assistant" && i === messages.length - 1;
            return (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} message-appear`}>
              <div className={`max-w-[80%] ${m.role === "user" ? "" : ""}`}>
                {m.role === "user" ? (
                  <div className="px-3.5 py-2.5 rounded-2xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-md">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="w-7 h-7 rounded-xl gradient-primary flex items-center justify-center shadow-md shrink-0 mt-0.5">
                      <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                      </svg>
                    </div>
                    <div className="px-3.5 py-2.5 rounded-2xl bg-slate-50 border border-slate-200/60 shadow-sm">
                      <p className="text-sm leading-relaxed text-slate-700 whitespace-pre-wrap">{renderAnswerWithLinks(m.content, isLastAssistant ? sources : [])}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}
          {chatLoading && (
            <div className="flex justify-start message-appear">
              <div className="flex items-start gap-2">
                <div className="w-7 h-7 rounded-xl gradient-primary flex items-center justify-center shadow-md shrink-0">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                </div>
                <div className="px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200/60 shadow-sm">
                  <TypingDots />
                </div>
              </div>
            </div>
          )}
          <div ref={chatBottomRef} />
        </div>

        {/* sources */}
        {sources.length > 0 && (
          <div className="shrink-0 px-5 py-1.5 border-t border-slate-100 bg-slate-50/50">
            <details className="group">
              <summary className="text-[10px] font-medium text-slate-400 cursor-pointer hover:text-slate-600 transition-colors list-none flex items-center gap-1">
                <svg className="w-2.5 h-2.5 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {sources.length} source{sources.length > 1 ? "s" : ""}
              </summary>
              <div className="flex flex-col gap-1.5 mt-1">
                {sources.map((s: any, i: number) => (
                  <a key={i}
                    href={`${API}/api/v1/documents/${s.document_id}/file?organization_id=${orgId}&page=${s.page_number || 0}`}
                    target="_blank"
                    className="block p-2.5 rounded-xl bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300 hover:bg-indigo-50/30 transition-all no-underline group"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="shrink-0 w-7 h-7 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-500 group-hover:bg-red-100 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-slate-700 group-hover:text-indigo-700 truncate">
                          {s.document_title?.slice(0, 20) || s.document_id?.slice(0, 8)}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {s.document_type && (
                            <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-wider">
                              {s.document_type}
                            </span>
                          )}
                          <span className="text-[9px] text-slate-400">·</span>
                          <span className="text-[9px] font-medium text-indigo-500">
                            {s.page_number ? `p.${s.page_number}` : `${(s.score * 100).toFixed(0)}%`}
                          </span>
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </details>
          </div>
        )}

        {/* chat input */}
        <div className="shrink-0 px-4 py-2.5 border-t border-slate-100">
          <div className="flex items-center gap-2 bg-slate-50 rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400/30 focus-within:border-indigo-400 transition-all">
            <input value={chatInput} onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendChat()}
              className="flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none text-slate-700 placeholder:text-slate-400"
              placeholder="Ask a question..." disabled={chatLoading} />
            <button onClick={sendChat} disabled={chatLoading || !chatInput.trim()}
              className="mr-1 p-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-md active:scale-95">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
