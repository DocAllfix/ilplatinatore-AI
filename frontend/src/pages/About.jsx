import React from "react";
import { motion } from "framer-motion";
import { ExternalLink, Database, Search, Brain, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function About() {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-12 lg:py-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground">Chi Siamo</h1>
          <div className="mt-2 h-1 w-16 bg-gradient-to-r from-primary to-secondary rounded-full" />
        </div>

        {/* Main text */}
        <div className="glass-card rounded-2xl p-8 lg:p-10 mb-8">
          <p className="text-base text-muted-foreground leading-relaxed mb-6">
            <strong className="text-foreground">Il Platinatore AI</strong> è nato dalla passione per il gaming e dalla frustrazione di cercare guide affidabili per trofei e achievement. Siamo il team dietro{" "}
            <a
              href="https://ilplatinatore.it"
              target="_blank"
              rel="noopener noreferrer"
              className="text-secondary hover:underline"
            >
              ilplatinatore.it
            </a>
            , uno dei siti italiani di riferimento per guide ai videogiochi, e abbiamo creato questo assistente AI per rendere l'esperienza ancora più veloce e personalizzata.
          </p>
          <p className="text-base text-muted-foreground leading-relaxed">
            Dopo anni passati a scrivere guide manuali, abbiamo capito che l'AI poteva aiutarci a raggiungere ogni gamer nel mondo, in qualsiasi lingua, con risposte immediate e sempre aggiornate. Così è nato Il Platinatore AI.
          </p>
        </div>

        {/* How AI works */}
        <h2 className="text-2xl font-bold text-foreground mb-6">Come Funziona il Nostro AI</h2>

        <div className="grid sm:grid-cols-3 gap-4 mb-12">
          {[
            {
              icon: Database,
              title: "Database Verificato",
              description: "Oltre 500 guide scritte e verificate dalla nostra community di trophy hunters esperti.",
            },
            {
              icon: Search,
              title: "Ricerca Web",
              description: "L'AI cerca nelle migliori fonti online per integrare le informazioni del database con dati aggiornati.",
            },
            {
              icon: Brain,
              title: "Generazione AI",
              description: "L'intelligenza artificiale combina tutte le fonti per creare una guida personalizzata e strutturata.",
            },
          ].map((step) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="glass-card rounded-2xl p-6"
            >
              <step.icon className="w-8 h-8 text-primary mb-4" />
              <h3 className="text-sm font-bold text-foreground mb-2">{step.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{step.description}</p>
            </motion.div>
          ))}
        </div>

        {/* CTA */}
        <div className="glass-card rounded-2xl p-8 text-center">
          <h3 className="text-xl font-bold text-foreground mb-3">Unisciti alla Community</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            Entra nel nostro server Discord per parlare con altri trophy hunters, suggerire nuove funzionalità e rimanere aggiornato.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a href="https://ilplatinatore.it" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" className="gap-2 border-white/10 text-foreground hover:bg-white/5">
                <ExternalLink className="w-4 h-4" />
                ilplatinatore.it
              </Button>
            </a>
            <Button className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground">
              <MessageCircle className="w-4 h-4" />
              Discord
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}