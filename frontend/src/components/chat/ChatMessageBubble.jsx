import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import { AnimatePresence, motion } from "framer-motion";
import RatingWidget from "./RatingWidget";
import GuideRenderer from "./GuideRenderer";
import ErrorReportModal from "./ErrorReportModal";
import { AlertTriangle, Brain, Search, Pencil, ShieldAlert, Star } from "lucide-react";
import { useGamificationContext } from "../../context/GamificationContext";

const STAGE_META = {
  understanding: { icon: Brain, label: "Sto interpretando la tua richiesta…" },
  searching: { icon: Search, label: "Sto cercando nelle fonti…" },
  writing: { icon: Pencil, label: "Sto scrivendo la guida…" },
};

function StageIndicator({ stage }) {
  if (!stage?.phase) return null;
  const meta = STAGE_META[stage.phase];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 mb-3 text-xs text-muted-foreground"
    >
      <Icon className="w-3.5 h-3.5 text-primary animate-pulse" />
      <span>{meta.label}</span>
    </motion.div>
  );
}

function DisambiguationChips({ disambiguation, onPick, originalQuery }) {
  if (!disambiguation?.candidates?.length) return null;
  const chosen = disambiguation.chosen?.id;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mb-3 p-3 rounded-xl bg-amber-400/5 border border-amber-400/20"
    >
      <p className="text-xs text-amber-400 mb-2 font-medium">
        Più giochi corrispondono — quale intendevi?
      </p>
      <div className="flex flex-wrap gap-2">
        {disambiguation.candidates.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick?.(c.id, originalQuery)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              chosen === c.id
                ? "bg-primary/20 border-primary text-foreground"
                : "bg-white/5 border-white/10 text-muted-foreground hover:bg-primary/10 hover:border-primary/30 hover:text-foreground"
            }`}
            title={`similarity: ${c.similarity?.toFixed(2)}`}
          >
            {c.title}
            {chosen === c.id && <span className="ml-1 text-primary">✓</span>}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function QualityBanner({ qualityScore, routeToHitl }) {
  if (qualityScore == null) return null;
  if (!routeToHitl && qualityScore >= 80) return null; // alta qualità, nessun banner
  const isLow = routeToHitl;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`mb-3 p-2.5 rounded-lg border text-xs flex items-center gap-2 ${
        isLow
          ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
          : "bg-blue-500/10 border-blue-500/20 text-blue-300"
      }`}
    >
      <Star className="w-3.5 h-3.5 shrink-0" />
      <span>
        {isLow
          ? `Qualità ${qualityScore}/100 — questa risposta è stata segnalata per revisione umana.`
          : `Qualità ${qualityScore}/100`}
      </span>
    </motion.div>
  );
}

function UnverifiedPsnAlert({ unverifiedPsnIds }) {
  if (!unverifiedPsnIds?.length) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mt-3 p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs"
    >
      <div className="flex items-start gap-2 text-rose-300">
        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium mb-1">
            Identificativi PSN non verificati ({unverifiedPsnIds.length})
          </p>
          <p className="text-rose-300/70">
            La AI potrebbe aver inventato questi codici. Verifica prima di
            usarli:{" "}
            <code className="text-rose-200">{unverifiedPsnIds.slice(0, 3).join(", ")}</code>
            {unverifiedPsnIds.length > 3 && "…"}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function SourcesList({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-white/5">
      <p className="text-xs text-muted-foreground/80 mb-1.5">Fonti</p>
      <ol className="text-xs space-y-1">
        {sources.map((s, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="text-secondary font-mono shrink-0">[{s.index ?? i + 1}]</span>
            {s.url ? (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-secondary hover:underline truncate"
                title={s.url}
              >
                {s.domain ?? s.url}
              </a>
            ) : (
              <span className="text-muted-foreground truncate">
                {s.title ?? `Guide #${s.guideId ?? "?"}`}
              </span>
            )}
            {s.verified && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                verified
              </span>
            )}
            {s.reliability != null && !s.verified && (
              <span className="text-[10px] text-muted-foreground/60">
                {Math.round(s.reliability * 100)}%
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function ChatMessageBubble({ message, sessionId, onPickGameCandidate }) {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const { trackRating } = useGamificationContext();
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="bg-primary/20 border border-primary/20 rounded-2xl rounded-br-md px-4 py-3 max-w-[85%] lg:max-w-[70%]">
          <p className="text-sm text-foreground leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="bg-card border border-primary/30 rounded-2xl rounded-bl-md px-5 py-4 max-w-[90%] lg:max-w-[75%]">
        {/* T3.4 stage indicator (ephemeral, scompare quando arriva done) */}
        {!message.finished && <StageIndicator stage={message.stage} />}

        {/* T3.2 disambiguation chip */}
        <DisambiguationChips
          disambiguation={message.disambiguation}
          onPick={onPickGameCandidate}
          originalQuery={message.originalQuery}
        />

        {/* T4.1 quality score banner */}
        <QualityBanner
          qualityScore={message.qualityScore}
          routeToHitl={message.routeToHitl}
        />

        {/* Content body */}
        {message.guide ? (
          <GuideRenderer guide={message.guide} />
        ) : (
          <ReactMarkdown
            className="text-sm prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={{
              h1: ({ children }) => <h1 className="text-lg font-bold text-foreground mt-4 mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-base font-bold text-foreground mt-3 mb-2">{children}</h2>,
              h3: ({ children }) => <h3 className="text-sm font-bold text-foreground mt-2 mb-1">{children}</h3>,
              p: ({ children }) => <p className="text-sm text-muted-foreground leading-relaxed my-1.5">{children}</p>,
              strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
              ul: ({ children }) => <ul className="my-2 space-y-1 ml-1">{children}</ul>,
              ol: ({ children }) => <ol className="my-2 space-y-1 ml-1 list-decimal list-inside">{children}</ol>,
              li: ({ children }) => <li className="text-sm text-muted-foreground flex gap-2"><span className="text-secondary shrink-0">•</span><span>{children}</span></li>,
              a: ({ children, ...props }) => (
                <a {...props} className="text-secondary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-primary/30 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>
              ),
              code: ({ children }) => (
                <code className="px-1.5 py-0.5 rounded bg-white/5 text-secondary text-xs font-mono">{children}</code>
              ),
            }}
          >
            {message.content || ""}
          </ReactMarkdown>
        )}

        {/* T3.3 inline citations source list */}
        <SourcesList sources={message.sources} />

        {/* T3.5 PSN flag rosso */}
        <UnverifiedPsnAlert unverifiedPsnIds={message.unverifiedPsnIds} />

        <RatingWidget messageId={message.id} sessionId={sessionId} onRated={trackRating} />

        <div className="mt-3 pt-3 border-t border-white/5">
          <button
            onClick={() => setShowErrorModal(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-amber-400 transition-colors"
          >
            <AlertTriangle className="w-3 h-3" />
            Segnala errore in questa guida
          </button>
        </div>

        <AnimatePresence>
          {showErrorModal && (
            <ErrorReportModal onClose={() => setShowErrorModal(false)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
