import { useState, useEffect } from "react";

const KEY = "platinatore_favorites";

export function useFavorites() {
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(favorites));
  }, [favorites]);

  const isFav = (id) => favorites.some((f) => f.id === id);

  const toggleFav = (item) => {
    setFavorites((prev) =>
      prev.some((f) => f.id === item.id)
        ? prev.filter((f) => f.id !== item.id)
        : [{ ...item, savedAt: new Date().toISOString() }, ...prev]
    );
  };

  return { favorites, isFav, toggleFav };
}