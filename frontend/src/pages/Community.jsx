import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Gamepad2, Bug, Star, MessageSquare, Send, CheckCircle2 } from "lucide-react";
import { motion } from "framer-motion";
import ProgressDashboard from "../components/dashboard/ProgressDashboard";

const categories = [
  { id: "suggest_game", icon: Gamepad2, label: "Consiglia un gioco", color: "text-primary", bg: "bg-primary/10 border-primary/30", placeholder: "Es. Baldur's Gate 3 — mancano guide dettagliate per i trofei di classe..." },
  { id: "bugged_trophy", icon: Bug, label: "Segnala trofeo buggato", color: "text-primary", bg: "bg-primary/10 border-primary/30", placeholder: "Es. In Elden Ring il trofeo 'Armamenti leggendari' non si sblocca se..." },
  { id: "feedback", icon: Star, label: "Feedback sulla guida", color: "text-primary", bg: "bg-primary/10 border-primary/30", placeholder: "Cosa vorresti migliorare nelle guide generate dall'AI?" },
  { id: "other", icon: MessageSquare, label: "Altro", color: "text-primary", bg: "bg-primary/10 border-primary/30", placeholder: "Scrivi la tua richiesta o suggerimento..." },
];

export default function Community() {
  const [selected, setSelected] = useState(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setSent(true);
    setTimeout(() => { setSent(false); setText(""); setSelected(null); }, 3000);
  };

  const cat = categories.find((c) => c.id === selected);

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col bg-background">
      <div className="flex-1 overflow-y-auto max-w-2xl mx-auto w-full px-4 py-8">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Torna alla chat
        </Link>

        <h1 className="text-2xl font-bold text-foreground mb-2">💬 Community</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Aiutaci a migliorare Il Platinatore AI. Segnala trofei buggati, consiglia nuovi giochi o lascia un feedback.
        </p>

        <div className="mb-6 p-4 rounded-xl border border-secondary/20 bg-secondary/5">
          <p className="text-sm text-secondary">💡 Aggiungi un videogioco ai preferiti per tenere sotto controllo i tuoi progressi!</p>
        </div>



        {sent ? (
           <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center py-16 gap-3"
          >
            <CheckCircle2 className="w-12 h-12 text-green-400" />
            <p className="text-lg font-semibold text-foreground">Grazie per il tuo contributo!</p>
            <p className="text-sm text-muted-foreground">Il team lo esaminerà al più presto.</p>
          </motion.div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-3 mb-6">
              {categories.map((c, i) => (
                <motion.button
                  key={c.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.07 }}
                  onClick={() => setSelected(selected === c.id ? null : c.id)}
                  className={`flex items-center gap-3 px-4 py-4 rounded-2xl border text-left transition-all ${
                    selected === c.id ? c.bg : "bg-card border-primary/20 hover:border-primary/40"
                  }`}
                >
                  <c.icon className={`w-5 h-5 shrink-0 text-primary`} />
                  <span className={`text-sm font-medium ${selected === c.id ? "text-foreground" : "text-muted-foreground"}`}>{c.label}</span>
                </motion.button>
              ))}
            </div>

            {selected && (
              <motion.form
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                onSubmit={handleSubmit}
                className="space-y-4"
              >
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={cat?.placeholder}
                  rows={5}
                  className="w-full bg-muted/40 border border-white/10 rounded-2xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/40 resize-none focus:outline-none focus:border-primary/30 transition-colors"
                />
                <button
                  type="submit"
                  disabled={!text.trim()}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground text-sm font-semibold transition-all"
                >
                  <Send className="w-4 h-4" />
                  Invia
                </button>
              </motion.form>
            )}
          </>
        )}

        {!sent && (
          <>
            <hr className="my-8 border-border" />
            <ProgressDashboard />
          </>
        )}
      </div>
    </div>
  );
}