import React, { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { BarChart2 } from "lucide-react";

export default function XPBar({ level, nextLevel, xp, streak, xpGain, newBadge }) {
  const [xpOpen, setXpOpen] = useState(false);
  const xpRef = useRef(null);

  const progress = nextLevel
    ? Math.round(((xp - level.min) / (nextLevel.min - level.min)) * 100)
    : 100;

  return (
    <div className="relative" ref={xpRef}>
      <AnimatePresence>
        {xpGain && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="absolute left-1/2 -translate-x-1/2 -top-8 bg-primary text-primary-foreground text-xs font-bold px-2 py-1 rounded-lg shadow-lg whitespace-nowrap z-50 pointer-events-none"
          >
            +{xpGain.amount} XP · {xpGain.reason}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {newBadge && !xpGain && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="absolute left-1/2 -translate-x-1/2 -top-8 bg-amber-500 text-white text-xs font-bold px-2 py-1 rounded-lg shadow-lg whitespace-nowrap z-50 pointer-events-none"
          >
            🏅 {newBadge.name}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setXpOpen((v) => !v)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-primary/30 bg-primary/8 hover:bg-primary/15 hover:border-primary/60 transition-all group"
      >
        {streak.count >= 2 && (
          <span className="text-xs font-bold text-amber-400">🔥{streak.count}</span>
        )}
        <span className="text-sm">{level.icon}</span>
        <div className="hidden sm:flex flex-col gap-0.5 w-[72px]">
          <div className="flex justify-between">
            <span className="text-[10px] text-muted-foreground leading-none group-hover:text-foreground transition-colors">{level.name}</span>
            <span className="text-[10px] font-mono text-primary leading-none">{xp} XP</span>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </div>
      </motion.button>

      <AnimatePresence>
        {xpOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            className="absolute left-0 top-10 w-52 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{level.icon}</span>
                <div>
                  <p className="text-sm font-bold text-foreground">{level.name}</p>
                  <p className="text-xs text-primary font-mono">{xp} XP</p>
                </div>
              </div>
              {nextLevel && (
                <div className="mt-2">
                  <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                    <span>Prossimo: {nextLevel.name}</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}
            </div>
            <div className="py-1">
              <Link
                to="/profilo"
                onClick={() => setXpOpen(false)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <BarChart2 className="w-4 h-4 text-muted-foreground" />
                Le mie statistiche
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}