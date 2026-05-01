import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowLeft,
  Send,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/api/client";
import { useAuth } from "@/hooks/useAuth";

/**
 * D — Admin HITL Drafts page.
 *
 * Permette agli admin (tier=platinum) di:
 *   - Vedere bozze pending_approval con paginazione
 *   - Vedere stats per status (dashboard counts)
 *   - Aprire una bozza, leggere il content
 *   - Revise (manda al LLM con feedback), Approve, Reject, Ingest (publish)
 *
 * Backend endpoints (cablati Sprint 1-4):
 *   GET  /api/draft/stats
 *   GET  /api/draft/pending?limit=N&offset=N
 *   GET  /api/draft/:id
 *   POST /api/draft/:id/revise   {feedback}
 *   POST /api/draft/:id/approve
 *   POST /api/draft/:id/reject   {reason?}
 *   POST /api/draft/:id/ingest
 */

const STATUS_COLORS = {
  draft: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  revision: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  pending_approval: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  rejected: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  published: "bg-primary/10 text-primary border-primary/20",
  failed: "bg-rose-600/10 text-rose-500 border-rose-600/20",
};

function StatCard({ label, value, color }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${color}`}>
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-bold mt-1">{value ?? 0}</div>
    </div>
  );
}

export default function AdminDrafts() {
  const { user } = useAuth();
  const isAdmin = user?.tier === "platinum";

  const [stats, setStats] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState("");

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [statsRes, pendingRes] = await Promise.all([
        api.get("/api/draft/stats"),
        api.get("/api/draft/pending?limit=50&offset=0"),
      ]);
      setStats(statsRes?.data ?? null);
      setDrafts(pendingRes?.data ?? []);
    } catch (err) {
      setError(err?.data?.error || err.message || "Errore caricamento bozze");
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openDraft = async (draftId) => {
    setSelected(null);
    setError(null);
    try {
      const res = await api.get(`/api/draft/${encodeURIComponent(draftId)}`);
      setSelected(res?.data ?? null);
    } catch (err) {
      setError(err?.data?.error || err.message || "Errore apertura bozza");
    }
  };

  const closeDraft = () => {
    setSelected(null);
    setFeedback("");
  };

  const action = async (kind) => {
    if (!selected) return;
    setActionLoading(true);
    setError(null);
    try {
      const id = encodeURIComponent(selected.id);
      switch (kind) {
        case "revise":
          if (!feedback.trim()) {
            setError("Feedback obbligatorio per la revisione.");
            setActionLoading(false);
            return;
          }
          await api.post(`/api/draft/${id}/revise`, { feedback: feedback.trim() });
          break;
        case "approve":
          await api.post(`/api/draft/${id}/approve`);
          break;
        case "reject":
          await api.post(`/api/draft/${id}/reject`, {});
          break;
        case "ingest":
          await api.post(`/api/draft/${id}/ingest`);
          break;
        default:
          break;
      }
      // Reload after action
      await refresh();
      // Re-open selected to fetch new state (or close if published/rejected)
      if (kind === "approve" || kind === "revise") {
        await openDraft(selected.id);
      } else {
        closeDraft();
      }
    } catch (err) {
      setError(err?.data?.error || err.message || `Errore azione ${kind}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <ShieldCheck className="w-10 h-10 mx-auto mb-4 text-amber-400" />
          <h1 className="text-lg font-bold text-foreground mb-2">Accesso negato</h1>
          <p className="text-sm text-muted-foreground mb-4">
            Questa area è riservata agli admin (tier=platinum).
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Torna alla chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link
              to="/"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 mb-2"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Indietro
            </Link>
            <h1 className="text-xl font-bold text-foreground">HITL Bozze admin</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Revisione, approvazione e ingestion delle bozze AI-generated.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl border border-primary/20 text-foreground hover:bg-primary/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="Pending" value={stats.pending_approval} color={STATUS_COLORS.pending_approval} />
            <StatCard label="In revision" value={stats.revision} color={STATUS_COLORS.revision} />
            <StatCard label="Approved" value={stats.approved} color={STATUS_COLORS.approved} />
            <StatCard label="Published" value={stats.published} color={STATUS_COLORS.published} />
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Drafts list */}
        <div className="bg-card border border-primary/20 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-primary/10 text-sm font-medium text-foreground">
            Bozze in attesa di approvazione ({drafts.length})
          </div>
          {drafts.length === 0 && !loading && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              Nessuna bozza in coda. Bel lavoro!
            </div>
          )}
          {drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => openDraft(d.id)}
              className="w-full flex items-start gap-3 px-4 py-3 border-b border-white/5 hover:bg-primary/5 transition-colors text-left"
            >
              <FileText className="w-4 h-4 mt-1 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {d.title ?? d.original_query ?? `draft #${d.id.slice(0, 8)}`}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {d.guide_type ?? "?"} · {d.language ?? "?"} · iter{" "}
                  {d.iteration_count ?? 0} · {new Date(d.created_at).toLocaleString("it-IT")}
                </div>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${STATUS_COLORS[d.status]}`}>
                {d.status}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Modal: draft detail */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur flex items-center justify-center p-4"
            onClick={closeDraft}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card border border-primary/30 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            >
              <div className="px-5 py-3 border-b border-primary/20 flex items-center justify-between shrink-0">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-foreground truncate">
                    {selected.title ?? selected.original_query ?? "Draft"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selected.guide_type ?? "?"} · {selected.language} · iter{" "}
                    {selected.iteration_count ?? 0}
                  </div>
                </div>
                <button
                  onClick={closeDraft}
                  className="text-muted-foreground hover:text-foreground text-sm px-2 py-1"
                >
                  ✕
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <pre className="whitespace-pre-wrap text-xs text-foreground font-mono">
                  {selected.content}
                </pre>
                {selected.sources_json?.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-white/5">
                    <div className="text-xs text-muted-foreground mb-2">Fonti</div>
                    <ul className="text-xs space-y-1">
                      {selected.sources_json.map((s, i) => (
                        <li key={i}>
                          [{i + 1}]{" "}
                          {s.url ? (
                            <a href={s.url} className="text-secondary hover:underline" target="_blank" rel="noopener noreferrer">
                              {s.domain ?? s.url}
                            </a>
                          ) : (
                            s.domain ?? `#${i}`
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-primary/20 space-y-3 shrink-0">
                {selected.status === "pending_approval" && (
                  <>
                    <textarea
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="Feedback per la revisione (opzionale, richiesto solo per Revise)"
                      className="w-full text-xs bg-muted border border-border rounded-lg px-3 py-2 text-foreground resize-none"
                      rows={2}
                    />
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => action("revise")}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Revise
                      </button>
                      <button
                        onClick={() => action("approve")}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => action("reject")}
                        disabled={actionLoading}
                        className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  </>
                )}
                {selected.status === "approved" && (
                  <button
                    onClick={() => action("ingest")}
                    disabled={actionLoading}
                    className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" /> Ingest in guides (publish)
                  </button>
                )}
                {!["pending_approval", "approved"].includes(selected.status) && (
                  <p className="text-xs text-muted-foreground text-center">
                    Bozza in stato <strong>{selected.status}</strong> — nessuna azione disponibile.
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
