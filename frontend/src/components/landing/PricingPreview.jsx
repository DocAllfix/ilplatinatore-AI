import React from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Check, Crown } from "lucide-react";
import { motion } from "framer-motion";

const tiers = [
  {
    name: "Free",
    price: "0€",
    period: "per sempre",
    features: ["5 guide al giorno", "Giochi più popolari", "Italiano e Inglese", "Guide base"],
    cta: "Inizia Gratis",
    style: "border-white/5",
    buttonVariant: "outline",
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
    style: "border-primary/40 pulse-border",
    buttonVariant: "default",
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
    style: "border-amber-500/30",
    buttonVariant: "outline",
  },
];

export default function PricingPreview() {
  return (
    <section className="py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground">Piani e Prezzi</h2>
          <p className="mt-4 text-muted-foreground">Scegli il piano perfetto per il tuo stile di gioco</p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 lg:gap-8 items-start">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className={`glass-card rounded-2xl p-8 relative ${tier.style} ${
                tier.popular ? "glow-purple lg:scale-105" : ""
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary rounded-full text-xs font-semibold text-primary-foreground flex items-center gap-1">
                  <Crown className="w-3 h-3" /> Più Popolare
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-lg font-bold text-foreground">{tier.name}</h3>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-foreground">{tier.price}</span>
                  <span className="text-sm text-muted-foreground">{tier.period}</span>
                </div>
              </div>

              <ul className="space-y-3 mb-8">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm">
                    <Check className="w-4 h-4 text-secondary mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link to={tier.popular ? "/chat" : "/prezzi"}>
                <Button
                  className={`w-full rounded-xl py-5 ${
                    tier.popular
                      ? "bg-primary hover:bg-primary/90 text-primary-foreground glow-purple"
                      : tier.name === "Platinum"
                      ? "border-amber-500/30 text-foreground hover:bg-amber-500/10"
                      : "border-white/10 text-foreground hover:bg-white/5"
                  }`}
                  variant={tier.buttonVariant}
                >
                  {tier.cta}
                </Button>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}