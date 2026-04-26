import React from "react";
import { motion } from "framer-motion";
import HeroSection from "../components/landing/HeroSection";
import HowItWorks from "../components/landing/HowItWorks";
import StatsSection from "../components/landing/StatsSection";
import PricingPreview from "../components/landing/PricingPreview";

export default function Landing() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <HeroSection />
      <HowItWorks />
      <StatsSection />
      <PricingPreview />
    </motion.div>
  );
}