import React from "react";
import { motion } from "framer-motion";
import { Target, Search, ClipboardList } from "lucide-react";

const steps = [
  {
    icon: Target,
    emoji: "🎯",
    title: "Chiedi",
    description: "Scrivi il nome del gioco e del trofeo che cerchi. In qualsiasi lingua.",
  },
  {
    icon: Search,
    emoji: "🔍",
    title: "Cerchiamo",
    description: "L'AI cerca nel nostro database di guide verificate e nelle migliori fonti online.",
  },
  {
    icon: ClipboardList,
    emoji: "📋",
    title: "Ricevi",
    description: "Guida strutturata, step-by-step, personalizzata. In pochi secondi.",
  },
];

export default function HowItWorks() {
  return (
    <section id="come-funziona" className="py-24 lg:py-32 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground">Come Funziona</h2>
          <p className="mt-4 text-muted-foreground max-w-md mx-auto">
            Tre semplici passaggi per ottenere la tua guida perfetta
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 lg:gap-8">
          {steps.map((step, i) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15 }}
              className="glass-card rounded-2xl p-8 text-center group hover:border-primary/20 transition-all duration-300"
            >
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform duration-300">
                <span className="text-3xl">{step.emoji}</span>
              </div>
              <div className="text-xs font-mono text-muted-foreground mb-2">STEP {i + 1}</div>
              <h3 className="text-xl font-bold text-foreground mb-3">{step.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}