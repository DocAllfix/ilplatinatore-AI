import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, CheckCircle2, AlertTriangle, Clock } from "lucide-react";

/**
 * Fase 25 — On-Demand Live Harvesting indicator.
 *
 * Visibile durante il flusso live harvest quando RAG fallisce e flag backend
 * `ON_DEMAND_HARVEST_ENABLED=true`. Renderizza un mini-banner che riflette le
 * 4 fasi: started -> processing -> completed | timeout | failed.
 *
 * Props:
 *   onDemand: null | { phase: 'started'|'completed'|'timeout'|'failed',
 *                       requestId, guideId?, message? }
 */
export default function OnDemandIndicator({ onDemand }) {
  if (!onDemand?.phase) return null;

  const config = {
    started: {
      Icon: Search,
      label: "Sto cercando guide aggiornate dal web…",
      iconClass: "animate-pulse text-amber-400",
      borderClass: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    },
    completed: {
      Icon: CheckCircle2,
      label: "Guida nuova trovata e aggiunta al database!",
      iconClass: "text-emerald-400",
      borderClass: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    },
    timeout: {
      Icon: Clock,
      label: "Ricerca live lenta — uso le fonti che ho.",
      iconClass: "text-slate-400",
      borderClass: "bg-slate-500/10 border-slate-500/30 text-slate-300",
    },
    failed: {
      Icon: AlertTriangle,
      label: "Ricerca live non riuscita — uso le fonti che ho.",
      iconClass: "text-rose-400",
      borderClass: "bg-rose-500/10 border-rose-500/30 text-rose-300",
    },
  };
  const c = config[onDemand.phase];
  if (!c) return null;
  const { Icon, label, iconClass, borderClass } = c;

  return (
    <AnimatePresence>
      <motion.div
        key={onDemand.phase}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className={`mb-3 p-2.5 rounded-lg border text-xs flex items-center gap-2 ${borderClass}`}
      >
        <Icon className={`w-3.5 h-3.5 shrink-0 ${iconClass}`} />
        <span>{label}</span>
        {onDemand.requestId && (
          <span className="ml-auto text-[10px] opacity-50 font-mono">
            req#{onDemand.requestId}
          </span>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
