import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

const STEPS = [
  { icon: "🔍", title: "Cerca guide", desc: "+5 XP per ogni guida generata" },
  { icon: "✅", title: "Completa i passi", desc: "+5 XP per ogni passo spuntato" },
  { icon: "⭐", title: "Valuta le guide", desc: "+15 XP per ogni valutazione" },
  { icon: "🔥", title: "Mantieni lo streak", desc: "Bonus XP ogni giorno consecutivo" },
];

export default function GamificationPopup() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem("plat_gamif_popup_seen")) return;
    const t = setTimeout(() => setVisible(true), 10000);
    return () => clearTimeout(t);
  }, []);

  const dismiss = () => {
    localStorage.setItem("plat_gamif_popup_seen", "1");
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-[60]"
            onClick={dismiss}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] w-[calc(100%-2rem)] max-w-sm"
          >
            <div className="bg-card border border-border rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
              {/* Header */}
              <div className="relative px-5 pt-5 pb-4 border-b border-border">
                <button onClick={dismiss} className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all">
                  <X className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center text-xl">💎</div>
                  <div>
                    <h2 className="text-base font-bold text-foreground">Diventa un Platinatore!</h2>
                    <p className="text-xs text-muted-foreground">Guadagna XP e scala i livelli</p>
                  </div>
                </div>
              </div>

              {/* Steps */}
              <div className="px-5 py-4 space-y-3 overflow-y-auto">
                <p className="text-xs text-muted-foreground mb-1">Segui questi step per salire di livello:</p>
                {STEPS.map((s) => (
                  <div key={s.title} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-muted/60 border border-border">
                    <span className="text-lg shrink-0">{s.icon}</span>
                    <div>
                      <p className="text-xs font-semibold text-foreground">{s.title}</p>
                      <p className="text-xs text-muted-foreground">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Levels preview */}
              <div className="px-5 pb-2">
                <div className="flex items-center justify-between px-3 py-2 rounded-xl border border-primary/20 bg-primary/5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>🌱 Novizio</span>
                    <ChevronRight className="w-3 h-3" />
                    <span>⚔️ Cacciatore</span>
                    <ChevronRight className="w-3 h-3" />
                    <span>💎 Master</span>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-border flex flex-col gap-2 shrink-0">
                <button
                  onClick={dismiss}
                  className="w-full text-center text-sm font-bold bg-primary text-primary-foreground py-3 rounded-xl hover:bg-primary/90 transition-all"
                >
                  💀 Ok, shit — here we go again!
                </button>
                <Link
                  to="/profilo"
                  onClick={dismiss}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                >
                  Vedi il mio profilo →
                </Link>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}