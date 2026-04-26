import React from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Check, Crown, Sparkles } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const tiers = [
  {
    name: "Free",
    price: "0€",
    period: "per sempre",
    features: ["5 guide al giorno", "Giochi più popolari", "Italiano e Inglese", "Guide base"],
    cta: "Inizia Gratis",
    ctaLink: "/chat",
    borderClass: "border-white/5",
    buttonClass: "border-white/10 text-foreground hover:bg-white/5",
    variant: "outline",
  },
  {
    name: "Pro Gamer",
    price: "4,99€",
    period: "/mese",
    popular: true,
    features: [
      "Guide illimitate",
      "Tutti i giochi",
      "Tutte le lingue",
      "Guide dettagliate step-by-step",
      "Nessuna pubblicità",
      "Risposta prioritaria",
    ],
    cta: "Inizia la Prova Gratuita",
    ctaLink: "/chat",
    borderClass: "border-primary/40 pulse-border",
    buttonClass: "bg-primary hover:bg-primary/90 text-primary-foreground glow-purple",
    variant: "default",
  },
  {
    name: "Platinum",
    price: "9,99€",
    period: "/mese",
    features: [
      "Tutto di Pro +",
      "Guide pre-lancio esclusive",
      "Alert nuovi giochi",
      "Roadmap personalizzate al Platino",
      "Accesso API",
      "Supporto prioritario",
    ],
    cta: "Diventa Platinum",
    ctaLink: "/chat",
    borderClass: "border-amber-500/30",
    buttonClass: "border-amber-500/30 text-foreground hover:bg-amber-500/10",
    variant: "outline",
    gold: true,
  },
];

const faqs = [
  {
    q: "Posso cancellare in qualsiasi momento?",
    a: "Assolutamente sì! Puoi cancellare il tuo abbonamento in qualsiasi momento dalla pagina del profilo. Non ci sono vincoli o penali.",
  },
  {
    q: "Come funziona la prova gratuita?",
    a: "La prova gratuita ti dà accesso a tutte le funzionalità Pro per 7 giorni. Non ti verrà addebitato nulla fino alla fine del periodo di prova.",
  },
  {
    q: "In quali lingue sono disponibili le guide?",
    a: "Le guide sono disponibili in Italiano, Inglese, Spagnolo, Francese, Tedesco e Portoghese. Stiamo lavorando per aggiungere altre lingue.",
  },
  {
    q: "Le guide sono accurate?",
    a: "Le nostre guide vengono generate a partire da un database di guide verificate dalla community e integrate con fonti online affidabili. Ogni guida include un sistema di rating per migliorare continuamente la qualità.",
  },
  {
    q: "Posso usare il tool senza registrarmi?",
    a: "Sì! Puoi utilizzare fino a 3 guide al giorno senza registrazione. Registrandoti gratis ottieni fino a 5 guide al giorno.",
  },
  {
    q: "Come posso contattare il supporto?",
    a: "Puoi contattarci tramite il nostro server Discord o scrivendo a supporto@ilplatinatore.it. I membri Platinum hanno accesso al supporto prioritario.",
  },
];

export default function Pricing() {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-12 lg:py-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground">
            Piani e Prezzi
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-lg mx-auto">
            Scegli il piano perfetto per il tuo stile di gioco. Upgrade o downgrade in qualsiasi momento.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-6 lg:gap-8 items-start mb-24">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className={`glass-card rounded-2xl p-8 relative ${tier.borderClass} ${
                tier.popular ? "glow-purple lg:scale-105" : ""
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary rounded-full text-xs font-semibold text-primary-foreground flex items-center gap-1">
                  <Crown className="w-3 h-3" /> Più Popolare
                </div>
              )}
              {tier.gold && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-amber-500/20 border border-amber-500/30 rounded-full text-xs font-semibold text-amber-400 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Premium
                </div>
              )}

              <div className="mb-8">
                <h3 className="text-lg font-bold text-foreground">{tier.name}</h3>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-5xl font-bold text-foreground">{tier.price}</span>
                  <span className="text-sm text-muted-foreground">{tier.period}</span>
                </div>
              </div>

              <ul className="space-y-3 mb-8">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm">
                    <Check className="w-4 h-4 text-secondary mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link to={tier.ctaLink}>
                <Button className={`w-full rounded-xl py-6 text-base ${tier.buttonClass}`} variant={tier.variant}>
                  {tier.cta}
                </Button>
              </Link>
            </motion.div>
          ))}
        </div>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-foreground text-center mb-8">
            Domande Frequenti
          </h2>
          <Accordion type="single" collapsible className="space-y-3">
            {faqs.map((faq, i) => (
              <AccordionItem
                key={i}
                value={`faq-${i}`}
                className="glass-card rounded-xl border-white/5 px-6"
              >
                <AccordionTrigger className="text-sm font-medium text-foreground hover:no-underline py-4">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground pb-4 leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </motion.div>
  );
}