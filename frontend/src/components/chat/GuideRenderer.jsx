import React, { useState, useRef, useEffect } from "react";
import { useGamificationContext } from "../../context/GamificationContext";
import { CheckCircle2, Search, ExternalLink, MessageCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

// Game-specific step icons
const GAME_ICONS = {
  "Elden Ring": "🔮",
  "God of War Ragnarök": "🪓",
  "Bloodborne": "🩸",
  "Marvel's Spider-Man 2": "🕷️",
  "Horizon Forbidden West": "🏹",
  "Final Fantasy XVI": "⚡",
  "Ghost of Tsushima": "⛩️",
  "Persona 5 Royal": "🃏",
  "Cyberpunk 2077": "🔧",
  "The Witcher 3: Wild Hunt": "⚔️",
};

function getGameIcon(gameName) {
  return GAME_ICONS[gameName] || "🎯";
}

// Popover for 🔍 links — shows two options: read on site or ask AI
function AskAIPopover({ label, query, onAskAI }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const siteUrl = `https://www.ilplatinatore.it/?s=${encodeURIComponent(query)}`;

  return (
    <span ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 mx-0.5 px-2 py-0.5 rounded-md bg-primary/15 border border-primary/30 text-primary text-xs font-medium hover:bg-primary/25 transition-all"
      >
        <Search className="w-3 h-3 shrink-0" />
        {label}
      </button>

      {open && (
        <span
          className="absolute left-0 top-7 z-50 flex flex-col gap-1 bg-card border border-border rounded-xl shadow-xl p-2 w-56"
          style={{ minWidth: 200 }}
        >
          <a
            href={siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground text-xs font-medium transition-all"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            Leggi su ilplatinatore.it
          </a>
          <button
            onClick={() => { onAskAI(query); setOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-all"
          >
            <MessageCircle className="w-3.5 h-3.5 shrink-0" />
            Approfondisci con l'AI
          </button>
        </span>
      )}
    </span>
  );
}

// Inline renderer that handles 🔍[text](ask-ai://...) and regular links
function GuideText({ text, onAskAI }) {
  const navigate = useNavigate();

  const parts = [];
  const regex = /\[([^\]]*)\]\((ask-ai:\/\/([^)]*)|https?:\/\/[^)]*)\)/g;
  let last = 0;
  let m;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", content: text.slice(last, m.index) });

    const label = m[1];
    const href = m[2];
    const isAskAI = href.startsWith("ask-ai://");
    const query = isAskAI ? decodeURIComponent(href.replace("ask-ai://", "")) : null;

    parts.push({ type: "link", label, href, isAskAI, query });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", content: text.slice(last) });

  const handleAskAI = (query) => {
    localStorage.setItem("platinatore_prefill", query);
    navigate("/");
    setTimeout(() => window.dispatchEvent(new Event("platinatore_prefill")), 100);
  };

  return (
    <span>
      {parts.map((p, i) => {
        if (p.type === "text") {
          // Split by \n to handle newlines in plain text segments
          return p.content.split("\n").map((line, j, arr) => (
            <React.Fragment key={`${i}-${j}`}>
              <RichInlineText text={line} />
              {j < arr.length - 1 && <br />}
            </React.Fragment>
          ));
        }
        if (p.isAskAI) {
          return (
            <AskAIPopover key={i} label={p.label.replace(/^🔍\s*/, "")} query={p.query} onAskAI={handleAskAI} />
          );
        }
        return (
          <a
            key={i}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-secondary hover:underline"
          >
            {p.label}
          </a>
        );
      })}
    </span>
  );
}

// Bold text support inside plain segments
function RichInlineText({ text }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="text-foreground font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  );
}

export default function GuideRenderer({ guide }) {
  const [checkedSteps, setCheckedSteps] = useState({});
  const { trackStep } = useGamificationContext();
  const checkedCount = Object.values(checkedSteps).filter(Boolean).length;
  const percent = guide.steps.length > 0 ? Math.round((checkedCount / guide.steps.length) * 100) : 0;
  const gameIcon = getGameIcon(guide.game);

  const toggle = (i) => {
    const wasDone = checkedSteps[i];
    if (!wasDone) trackStep();
    setCheckedSteps((prev) => ({ ...prev, [i]: !prev[i] }));
  };

  return (
    <div className="space-y-5">
      {/* Header info */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{guide.icon || gameIcon}</span>
          <h2 className="text-sm font-bold text-foreground">Guida al Trofeo — {guide.game}</h2>
        </div>
        <ul className="space-y-1">
          <li className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/60">🎮</span>
            <span><strong className="text-foreground">Gioco:</strong> {guide.game}</span>
          </li>
          <li className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/60">⚡</span>
            <span><strong className="text-foreground">Difficoltà:</strong> {guide.difficulty}</span>
          </li>
          <li className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/60">⏱️</span>
            <span><strong className="text-foreground">Tempo stimato:</strong> {guide.time}</span>
          </li>
        </ul>
      </div>

      {/* Steps */}
      <div>
        {/* Progress */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-muted-foreground">Avanzamento</span>
          <span className="text-xs font-mono font-bold" style={{ color: percent === 100 ? "hsl(160 63% 36%)" : "hsl(var(--primary))" }}>
            {percent}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted mb-4 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${percent}%`,
              background: percent === 100 ? "hsl(160 63% 36%)" : "linear-gradient(90deg, hsl(var(--primary)), hsl(var(--secondary)))",
            }}
          />
        </div>

        <div className="space-y-3">
          {guide.steps.map((step, i) => {
            const done = checkedSteps[i];
            return (
              <div
                key={i}
                className={`rounded-xl border transition-all ${done ? "border-green-500/20 bg-green-500/5 opacity-70" : "border-white/8 bg-white/2"}`}
              >
                {/* Step header — clickable to toggle */}
                <button
                  onClick={() => toggle(i)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left"
                >
                  <div className="shrink-0">
                    {done ? (
                      <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shadow-[0_0_8px_2px_rgba(16,185,129,0.4)]">
                        <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3">
                          <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-primary/40 flex items-center justify-center text-xs">
                        {gameIcon}
                      </div>
                    )}
                  </div>
                  <span className={`text-xs font-semibold flex-1 ${done ? "line-through text-muted-foreground/50" : "text-foreground"}`}>
                    Passo {i + 1}: {step.title}
                  </span>
                </button>

                {/* Step body */}
                {!done && (
                  <div className="px-4 pb-4 text-xs text-muted-foreground leading-relaxed">
                    <GuideText text={step.content} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {percent === 100 && (
          <div className="mt-3 flex items-center justify-center gap-2 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            <span className="text-xs font-semibold text-green-400">Obiettivo completato! 🏆</span>
          </div>
        )}
      </div>

      {/* Tips */}
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span>💡</span>
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Consigli Utili</h3>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          <GuideText text={guide.tips} />
        </p>
      </div>

      {/* Sources as icon links */}
      <div>
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">📚 Fonti</h3>
        <div className="flex flex-wrap gap-2">
          {guide.sources.map((source, i) => (
            <a
              key={i}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.name}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/8 bg-white/3 hover:border-primary/30 hover:bg-primary/5 transition-all text-xs text-muted-foreground hover:text-foreground"
            >
              <span>{source.icon}</span>
              <span>{source.name}</span>
              <ExternalLink className="w-3 h-3 opacity-50" />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}