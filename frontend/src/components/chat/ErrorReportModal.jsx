import React, { useState } from "react";
import { motion } from "framer-motion";
import { X, AlertTriangle, Send, CheckCircle } from "lucide-react";

export default function ErrorReportModal({ onClose }) {
  const [type, setType] = useState("");
  const [description, setDescription] = useState("");
  const [sent, setSent] = useState(false);

  const types = [
    "Informazione errata",
    "Passaggio mancante",
    "Trofeo buggato non segnalato",
    "Guida obsoleta",
    "Altro",
  ];

  const handleSubmit = (e) => {
    e.preventDefault();
    setSent(true);
    setTimeout(onClose, 1800);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="w-full max-w-md rounded-2xl border border-white/10 p-6 shadow-2xl"
        style={{ background: "hsl(var(--card))" }}
        onClick={(e) => e.stopPropagation()}
      >
        {sent ? (
          <div className="flex flex-col items-center py-6 gap-3">
            <CheckCircle className="w-10 h-10 text-green-400" />
            <p className="text-sm font-semibold text-foreground">Segnalazione inviata, grazie!</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-foreground">Segnala un errore</span>
              </div>
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Tipo di problema</label>
                <div className="flex flex-wrap gap-2">
                  {types.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                        type === t
                          ? "border-primary/50 bg-primary/15 text-primary"
                          : "border-white/10 text-muted-foreground hover:border-white/20 hover:text-foreground"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-2 block">Descrizione</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Descrivi l'errore in dettaglio..."
                  rows={3}
                  className="w-full bg-muted/50 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-primary/30"
                />
              </div>

              <button
                type="submit"
                disabled={!type && !description}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground text-sm font-medium transition-all"
              >
                <Send className="w-3.5 h-3.5" />
                Invia segnalazione
              </button>
            </form>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}