import { useState, useEffect } from "react";

const KEY = "platinatore_search_history";
const MAX = 30;

export function useSearchHistory() {
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(history));
  }, [history]);

  const addToHistory = (query) => {
    if (!query?.trim()) return;
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.query !== query);
      return [{ query, date: new Date().toISOString() }, ...filtered].slice(0, MAX);
    });
  };

  const removeFromHistory = (query) => {
    setHistory((prev) => prev.filter((h) => h.query !== query));
  };

  const clearHistory = () => setHistory([]);

  return { history, addToHistory, removeFromHistory, clearHistory };
}