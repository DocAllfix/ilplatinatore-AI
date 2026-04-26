import { useState, useEffect, useCallback } from "react";

const LEVELS = [
  { name: "Cacciatore Novizio", icon: "🌱", min: 0, max: 99 },
  { name: "Cacciatore", icon: "⚔️", min: 100, max: 299 },
  { name: "Esperto", icon: "🔥", min: 300, max: 699 },
  { name: "Leggenda", icon: "💜", min: 700, max: 1499 },
  { name: "Platino Master", icon: "💎", min: 1500, max: Infinity },
];

const ALL_BADGES = [
  { id: "first_search", name: "Prima Caccia", icon: "🥇", desc: "Prima guida generata" },
  { id: "step_5", name: "Primo Passo", icon: "👣", desc: "5 passi completati" },
  { id: "step_20", name: "Determinato", icon: "💪", desc: "20 passi completati" },
  { id: "step_50", name: "Instancabile", icon: "🏃", desc: "50 passi completati" },
  { id: "streak_3", name: "Costante", icon: "🔥", desc: "3 giorni di fila" },
  { id: "streak_7", name: "Settimanale", icon: "🗓️", desc: "7 giorni di fila" },
  { id: "streak_30", name: "Leggendario", icon: "⚡", desc: "30 giorni di fila" },
  { id: "searches_10", name: "Esploratore", icon: "🔭", desc: "10 guide richieste" },
  { id: "searches_50", name: "Enciclopedico", icon: "🧠", desc: "50 guide richieste" },
  { id: "level_hunter", name: "Cacciatore", icon: "⚔️", desc: "Raggiunto livello Cacciatore" },
  { id: "level_expert", name: "Esperto", icon: "🔥", desc: "Raggiunto livello Esperto" },
  { id: "level_legend", name: "Leggenda", icon: "💜", desc: "Raggiunto livello Leggenda" },
  { id: "level_platinum", name: "Platino Master", icon: "💎", desc: "Raggiunto livello Platino Master" },
  { id: "rater", name: "Critico", icon: "⭐", desc: "Prima valutazione data" },
  { id: "night_hunter", name: "Cacciatore Notturno", icon: "🌙", desc: "Ricerca fatta dopo mezzanotte" },
];

function getWeekKey() {
  const now = new Date();
  const year = now.getFullYear();
  const week = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 604800000);
  return `${year}-W${week}`;
}

function generateWeeklyMissions(weekKey) {
  return [
    { id: `${weekKey}-m1`, text: "Cerca guide per 3 giochi diversi", target: 3, progress: 0, xp: 50, icon: "🎮" },
    { id: `${weekKey}-m2`, text: "Completa 10 passi nelle guide", target: 10, progress: 0, xp: 40, icon: "✅" },
    { id: `${weekKey}-m3`, text: "Effettua 5 ricerche in chat", target: 5, progress: 0, xp: 30, icon: "💬" },
    { id: `${weekKey}-m4`, text: "Dai una valutazione a una guida", target: 1, progress: 0, xp: 25, icon: "⭐" },
  ];
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

export function useGamification() {
  const [xp, setXp] = useState(() => load("plat_xp", 0));
  const [totalSearches, setTotalSearches] = useState(() => load("plat_searches", 0));
  const [totalSteps, setTotalSteps] = useState(() => load("plat_steps", 0));
  const [totalRatings, setTotalRatings] = useState(() => load("plat_ratings", 0));
  const [unlockedBadges, setUnlockedBadges] = useState(() => load("plat_badges", []));
  const [streak, setStreak] = useState(() => load("plat_streak", { count: 0, lastDate: null }));
  const [missions, setMissions] = useState(() => {
    const weekKey = getWeekKey();
    const saved = load("plat_missions", null);
    if (saved && saved.weekKey === weekKey) return saved;
    return { weekKey, items: generateWeeklyMissions(weekKey) };
  });
  const [xpGain, setXpGain] = useState(null); // {amount, reason} for toast
  const [newBadge, setNewBadge] = useState(null);

  const getLevel = (xpVal) => LEVELS.slice().reverse().find((l) => xpVal >= l.min) || LEVELS[0];
  const level = getLevel(xp);
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];

  const unlockBadge = useCallback((id) => {
    setUnlockedBadges((prev) => {
      if (prev.find((b) => b.id === id)) return prev;
      const badge = ALL_BADGES.find((b) => b.id === id);
      if (!badge) return prev;
      const entry = { ...badge, date: new Date().toISOString() };
      const next = [...prev, entry];
      save("plat_badges", next);
      setNewBadge(entry);
      setTimeout(() => setNewBadge(null), 4000);
      return next;
    });
  }, []);

  const addXP = useCallback((amount, reason) => {
    setXp((prev) => {
      const next = prev + amount;
      save("plat_xp", next);
      // Check level-up badges
      const newLevel = LEVELS.slice().reverse().find((l) => next >= l.min);
      if (newLevel?.id !== getLevel(prev)?.id) {
        if (next >= 100) setTimeout(() => unlockBadge("level_hunter"), 100);
        if (next >= 300) setTimeout(() => unlockBadge("level_expert"), 100);
        if (next >= 700) setTimeout(() => unlockBadge("level_legend"), 100);
        if (next >= 1500) setTimeout(() => unlockBadge("level_platinum"), 100);
      }
      return next;
    });
    setXpGain({ amount, reason });
    setTimeout(() => setXpGain(null), 2500);
  }, [unlockBadge]);

  const trackSearch = useCallback((query) => {
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 5) unlockBadge("night_hunter");

    setTotalSearches((prev) => {
      const next = prev + 1;
      save("plat_searches", next);
      if (next === 1) { addXP(10, "Prima ricerca!"); unlockBadge("first_search"); }
      else addXP(5, "Nuova guida");
      if (next === 10) unlockBadge("searches_10");
      if (next === 50) unlockBadge("searches_50");
      return next;
    });

    // Update mission: searches
    setMissions((prev) => {
      const items = prev.items.map((m) =>
        m.id.endsWith("-m3") && m.progress < m.target ? { ...m, progress: m.progress + 1 } : m
      );
      const next = { ...prev, items };
      save("plat_missions", next);
      return next;
    });

    // Streak
    const today = new Date().toDateString();
    setStreak((prev) => {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      let count = prev.lastDate === today ? prev.count
        : prev.lastDate === yesterday ? prev.count + 1 : 1;
      const next = { count, lastDate: today };
      save("plat_streak", next);
      if (count >= 3) unlockBadge("streak_3");
      if (count >= 7) { unlockBadge("streak_7"); addXP(20, `🔥 Streak ${count} giorni!`); }
      if (count >= 30) unlockBadge("streak_30");
      return next;
    });
  }, [addXP, unlockBadge]);

  const trackStep = useCallback(() => {
    addXP(5, "Passo completato");
    setTotalSteps((prev) => {
      const next = prev + 1;
      save("plat_steps", next);
      if (next === 5) unlockBadge("step_5");
      if (next === 20) unlockBadge("step_20");
      if (next === 50) unlockBadge("step_50");
      return next;
    });
    setMissions((prev) => {
      const items = prev.items.map((m) =>
        m.id.endsWith("-m2") && m.progress < m.target ? { ...m, progress: m.progress + 1 } : m
      );
      const next = { ...prev, items };
      save("plat_missions", next);
      return next;
    });
  }, [addXP, unlockBadge]);

  const trackRating = useCallback(() => {
    addXP(15, "Guida valutata");
    setTotalRatings((prev) => {
      const next = prev + 1;
      save("plat_ratings", next);
      if (next === 1) unlockBadge("rater");
      return next;
    });
    setMissions((prev) => {
      const items = prev.items.map((m) =>
        m.id.endsWith("-m4") && m.progress < m.target ? { ...m, progress: m.progress + 1 } : m
      );
      const next = { ...prev, items };
      save("plat_missions", next);
      return next;
    });
  }, [addXP, unlockBadge]);

  return {
    xp, level, nextLevel, LEVELS,
    totalSearches, totalSteps, totalRatings,
    unlockedBadges, allBadges: ALL_BADGES,
    streak, missions,
    xpGain, newBadge,
    addXP, trackSearch, trackStep, trackRating,
  };
}