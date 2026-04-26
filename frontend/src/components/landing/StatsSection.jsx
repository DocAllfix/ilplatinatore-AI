import React from "react";
import { motion } from "framer-motion";

const stats = [
  { value: "500+", label: "Guide nel Database" },
  { value: "50+", label: "Giochi Coperti" },
  { value: "6+", label: "Lingue Supportate" },
  { value: "<10s", label: "Tempo di Risposta" },
];

export default function StatsSection() {
  return (
    <section className="py-20 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="glass-card rounded-2xl p-6 lg:p-8 text-center"
            >
              <div className="text-3xl lg:text-4xl font-bold font-mono bg-gradient-to-br from-primary to-secondary bg-clip-text text-transparent">
                {stat.value}
              </div>
              <div className="mt-2 text-xs lg:text-sm text-muted-foreground">{stat.label}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}