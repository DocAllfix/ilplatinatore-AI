import React, { useState, useEffect } from "react";

import { Outlet } from "react-router-dom";
import { Link } from "react-router-dom";
import { Sun, Moon, Gamepad2, Users } from "lucide-react";
import NotificationBell from "../layout/NotificationBell";
import XPBar from "../gamification/XPBar";
import { useGamificationContext } from "../../context/GamificationContext";
import ProfileButton from "../layout/ProfileButton";

export default function ChatLayout() {
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const { level, nextLevel, xp, streak, xpGain, newBadge } = useGamificationContext();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      <header className="h-12 flex items-center justify-between px-5 border-b border-border shrink-0" style={{ background: "hsl(var(--card))" }}>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-bold text-foreground tracking-tight">
            🎮 <span className="text-primary">Il Platinatore</span> AI
          </Link>
          <XPBar level={level} nextLevel={nextLevel} xp={xp} streak={streak} xpGain={xpGain} newBadge={newBadge} />
        </div>
        <div className="flex items-center gap-1">
          <Link to="/giochi"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <Gamepad2 className="w-3.5 h-3.5" />
            Giochi
          </Link>
          <Link to="/community"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <Users className="w-3.5 h-3.5" />
            Community
          </Link>

          <button
            onClick={toggleTheme}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all ml-1"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <NotificationBell />
          <ProfileButton />

        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}