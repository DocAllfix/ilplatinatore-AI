import React, { useState, useMemo } from "react";
import { CheckCircle2, Circle } from "lucide-react";

function parseSteps(content) {
  const lines = content.split("\n");
  const steps = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\.\s+\*{0,2}(.+?)\*{0,2}$/);
    if (match) {
      steps.push(match[2].trim());
    }
  }
  return steps;
}

export default function GuideChecklist({ content }) {
  const steps = useMemo(() => parseSteps(content), [content]);
  const [checked, setChecked] = useState({});

  if (steps.length < 2) return null;

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const percent = Math.round((checkedCount / steps.length) * 100);

  const toggle = (i) => setChecked((prev) => ({ ...prev, [i]: !prev[i] }));

  return (
    <div className="mt-4 pt-4 border-t border-white/5">
      {/* Progress bar */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground font-semibold">Avanzamento</span>
        <span
          className="text-xs font-mono font-bold"
          style={{ color: percent === 100 ? "hsl(160 63% 36%)" : "hsl(var(--primary))" }}
        >
          {percent}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted mb-4 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${percent}%`,
            background: percent === 100
              ? "hsl(160 63% 36%)"
              : "linear-gradient(90deg, hsl(var(--primary)), hsl(var(--secondary)))",
          }}
        />
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {steps.map((step, i) => (
          <button
            key={i}
            onClick={() => toggle(i)}
            className="w-full flex items-start gap-3 text-left group"
          >
            {checked[i] ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-400" />
            ) : (
              <Circle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
            )}
            <span
              className={`text-xs leading-relaxed transition-colors ${
                checked[i] ? "line-through text-muted-foreground/40" : "text-muted-foreground group-hover:text-foreground"
              }`}
            >
              {i + 1}. {step}
            </span>
          </button>
        ))}
      </div>

      {percent === 100 && (
        <div className="mt-3 flex items-center justify-center gap-2 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-xs font-semibold text-green-400">Obiettivo completato! 🏆</span>
        </div>
      )}
    </div>
  );
}