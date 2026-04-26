import React, { createContext, useContext } from "react";
import { useGamification } from "../hooks/useGamification";

const GamificationContext = createContext(null);

export function GamificationProvider({ children }) {
  const gamification = useGamification();
  return (
    <GamificationContext.Provider value={gamification}>
      {children}
    </GamificationContext.Provider>
  );
}

export function useGamificationContext() {
  return useContext(GamificationContext);
}