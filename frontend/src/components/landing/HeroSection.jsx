import React from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";

export default function HeroSection({ heroImage }) {
  return (
    <section className="relative overflow-hidden min-h-[90vh] flex items-center">
      {/* Background glow effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-secondary/8 rounded-full blur-[100px]" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Text content */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 mb-6">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
              <span className="text-xs font-medium text-primary">Powered by AI</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
              <span className="text-foreground">Chiedi qualsiasi trofeo.</span>
              <br />
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                Ricevi la guida perfetta.
              </span>
            </h1>

            <p className="mt-6 text-lg text-muted-foreground leading-relaxed max-w-xl">
              L'assistente AI che genera guide personalizzate per trofei, achievement e sfide di qualsiasi videogioco, nella tua lingua, in pochi secondi.
            </p>

            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              <Link to="/chat">
                <Button
                  size="lg"
                  className="bg-primary hover:bg-primary/90 text-primary-foreground glow-purple-strong text-base px-8 py-6 rounded-xl gap-2 w-full sm:w-auto"
                >
                  Prova Gratis — Nessuna registrazione
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <a href="#come-funziona">
                <Button
                  variant="ghost"
                  size="lg"
                  className="text-muted-foreground hover:text-foreground text-base px-8 py-6 rounded-xl gap-2 w-full sm:w-auto"
                >
                  Scopri come funziona
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </a>
            </div>
          </motion.div>

          {/* Chat mockup */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="relative"
          >
            <div className="glass-card rounded-2xl p-5 glow-purple">
              {/* Chat header */}
              <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/5">
                <div className="w-3 h-3 rounded-full bg-primary animate-pulse-glow" />
                <span className="text-sm font-medium text-foreground">Il Platinatore AI</span>
                <span className="ml-auto text-xs text-muted-foreground">Elden Ring</span>
              </div>

              {/* Mock messages */}
              <div className="space-y-4">
                {/* User message */}
                <div className="flex justify-end">
                  <div className="bg-primary/20 border border-primary/20 rounded-2xl rounded-br-md px-4 py-3 max-w-[85%]">
                    <p className="text-sm text-foreground">Come ottenere il platino di Elden Ring?</p>
                  </div>
                </div>

                {/* AI response */}
                <div className="flex justify-start">
                  <div className="glass-card-bright rounded-2xl rounded-bl-md px-4 py-4 max-w-[90%] space-y-3">
                    <p className="text-sm font-semibold text-foreground">🏆 Guida al Platino — Elden Ring</p>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span>⭐ Difficoltà: 4/5</span>
                      <span>⏱️ ~80-100 ore</span>
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">📋 <span className="text-foreground font-medium">42 trofei</span> totali da ottenere</p>
                      <p className="text-xs text-muted-foreground">1. Completa la storia principale...</p>
                      <p className="text-xs text-muted-foreground">2. Sconfiggi tutti i boss opzionali...</p>
                      <p className="text-xs text-muted-foreground">3. Raccogli tutte le armi leggendarie...</p>
                    </div>
                    <div className="pt-2 border-t border-white/5">
                      <p className="text-xs text-secondary">Continua a leggere per i dettagli...</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Floating decoration */}
            <div className="absolute -top-6 -right-6 w-24 h-24 bg-primary/20 rounded-full blur-[60px] animate-float" />
            <div className="absolute -bottom-4 -left-4 w-20 h-20 bg-secondary/15 rounded-full blur-[50px] animate-float" style={{ animationDelay: '3s' }} />
          </motion.div>
        </div>
      </div>
    </section>
  );
}