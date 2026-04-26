import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";


export default function TrophyWelcome({ onSend }) {
  const [phase, setPhase] = useState("loading"); // loading → done

  useEffect(() => {
    const t = setTimeout(() => setPhase("done"), 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="text-center py-16">
      {/* Trophy icon with glow */}
      <div className="flex justify-center mb-6">
        <div className="relative flex items-center justify-center">
          {/* Glow ring — stays pulsing after load */}
          <AnimatePresence>
            {phase === "done" && (
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }}
                transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                className="absolute rounded-full"
                style={{
                  width: 90,
                  height: 90,
                  background:
                    "radial-gradient(circle, rgba(108,92,231,0.45) 0%, rgba(108,92,231,0.1) 60%, transparent 80%)",
                  filter: "blur(8px)",
                }}
              />
            )}
          </AnimatePresence>

          {/* Trophy icon */}
          <motion.div
            initial={{ scale: 0.4, opacity: 0 }}
            animate={
              phase === "loading"
                ? { scale: 0.4, opacity: 0 }
                : {
                    scale: 1,
                    opacity: 1,
                    filter: [
                      "drop-shadow(0 0 0px rgba(108,92,231,0))",
                      "drop-shadow(0 0 18px rgba(253,203,110,0.9))",
                      "drop-shadow(0 0 10px rgba(253,203,110,0.5))",
                    ],
                  }
            }
            transition={
              phase === "done"
                ? {
                    scale: { type: "spring", stiffness: 260, damping: 18, duration: 0.5 },
                    opacity: { duration: 0.35 },
                    filter: { duration: 1.2, ease: "easeOut" },
                  }
                : {}
            }
            style={{ fontSize: 72, lineHeight: 1 }}
          >
            🏆
          </motion.div>
        </div>
      </div>

      {phase === "done" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <h2 className="text-xl font-bold text-primary mb-2">Benvenuto su Il Platinatore AI</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-8">
            Chiedi qualsiasi trofeo, achievement o sfida di qualsiasi videogioco. Ti genererò una guida personalizzata in pochi secondi.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {[
              "Come ottengo il platino di Elden Ring?",
              "Trofei nascosti di God of War",
              "Guida completa Bloodborne",
            ].map((q) => (
              <button
                key={q}
                onClick={() => onSend(q)}
                className="px-4 py-2 bg-card border border-primary/40 rounded-xl text-xs text-foreground hover:border-primary transition-all"
              >
                {q}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}