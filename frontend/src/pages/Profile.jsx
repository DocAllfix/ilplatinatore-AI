import React, { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Star, Calendar, Settings, LogOut, Bell, Globe, CheckCircle2, Lock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { listGuideRatings } from "@/api/stubs";
import { useQuery } from "@tanstack/react-query";
import { useGamificationContext } from "../context/GamificationContext";

const TABS = ["Panoramica", "Badge", "Missioni", "Statistiche"];

export default function Profile() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState("Panoramica");

  const {
    xp, level, nextLevel, LEVELS,
    totalSearches, totalSteps, totalRatings,
    unlockedBadges, allBadges,
    streak, missions,
  } = useGamificationContext();

  const { data: ratings = [] } = useQuery({
    queryKey: ["my-ratings"],
    queryFn: () => listGuideRatings({ limit: 20 }),
  });

  const xpInLevel = xp - level.min;
  const xpNeeded = nextLevel ? nextLevel.min - level.min : 1;
  const progress = nextLevel ? Math.round((xpInLevel / xpNeeded) * 100) : 100;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-2xl mx-auto px-4 py-8">
        {/* Back */}
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Torna alla chat
        </Link>

        {/* Hero card */}
        <div className="bg-card border border-primary/20 rounded-2xl p-6 mb-5">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl bg-primary/20 flex items-center justify-center text-2xl">
              {level.icon}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-foreground">{user?.full_name || "Cacciatore"}</h2>
              <p className="text-xs text-muted-foreground">{user?.email || "—"}</p>
              <div className="flex items-center gap-2 mt-1">
                <Badge className="bg-primary/20 text-primary border-0 text-xs">{level.icon} {level.name}</Badge>
                {streak.count >= 2 && (
                  <span className="text-xs font-bold text-amber-400">🔥 Streak {streak.count}gg</span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-mono font-bold text-primary">{xp}</div>
              <div className="text-xs text-muted-foreground">XP totali</div>
            </div>
          </div>
          {/* XP bar */}
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>{level.name}</span>
              {nextLevel && <span>{nextLevel.name} ({nextLevel.min - xp} XP mancanti)</span>}
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground/50 mt-1">
              <span>{xpInLevel} / {xpNeeded} XP</span>
              <span>{progress}%</span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-muted rounded-xl p-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 text-xs py-2 rounded-lg font-medium transition-all ${
                tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* --- PANORAMICA --- */}
        {tab === "Panoramica" && (
          <div className="space-y-4">
            {/* Quick stats */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { icon: "🔍", label: "Ricerche", value: totalSearches },
                { icon: "✅", label: "Passi", value: totalSteps },
                { icon: "⭐", label: "Valutazioni", value: totalRatings },
              ].map((s) => (
                <div key={s.label} className="bg-card border border-border rounded-xl p-3 text-center">
                  <div className="text-lg mb-1">{s.icon}</div>
                  <div className="text-xl font-bold font-mono text-foreground">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Badge preview */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-foreground">🏅 Badge Sbloccati</h3>
                <button onClick={() => setTab("Badge")} className="text-xs text-primary hover:underline">Vedi tutti</button>
              </div>
              {unlockedBadges.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">Nessun badge ancora. Inizia a cercare!</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {unlockedBadges.slice(0, 6).map((b) => (
                    <div key={b.id} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300">
                      <span>{b.icon}</span>{b.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Missions preview */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-foreground">🎯 Missioni Settimanali</h3>
                <button onClick={() => setTab("Missioni")} className="text-xs text-primary hover:underline">Tutte</button>
              </div>
              <div className="space-y-2">
                {missions.items.slice(0, 3).map((m) => {
                  const done = m.progress >= m.target;
                  return (
                    <div key={m.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${done ? "border-green-500/20 bg-green-500/5" : "border-border bg-muted/40"}`}>
                      <span>{m.icon}</span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-medium ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>{m.text}</p>
                        <div className="h-1 rounded-full bg-muted mt-1 overflow-hidden">
                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (m.progress / m.target) * 100)}%` }} />
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{m.progress}/{m.target}</span>
                      {done && <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent ratings */}
            {ratings.length > 0 && (
              <div className="bg-card border border-border rounded-2xl p-5">
                <h3 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
                  <Star className="w-4 h-4 text-amber-400" /> Valutazioni Recenti
                </h3>
                <div className="space-y-2">
                  {ratings.slice(0, 3).map((r) => (
                    <div key={r.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                      <div className="flex gap-0.5">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <Star key={n} className={`w-3.5 h-3.5 ${n <= r.stars ? "fill-amber-400 text-amber-400" : "text-muted-foreground/20"}`} />
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">{new Date(r.created_date).toLocaleDateString("it-IT")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Settings */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-foreground mb-4 flex items-center gap-2"><Settings className="w-4 h-4" /> Impostazioni</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3"><Globe className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-foreground">Lingua</span></div>
                  <span className="text-sm text-muted-foreground">Italiano</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3"><Bell className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-foreground">Notifiche email</span></div>
                  <Switch />
                </div>
              </div>
            </div>

            <Button variant="outline" onClick={async () => { await logout(); window.location.href = "/"; }} className="border-destructive/20 text-destructive hover:bg-destructive/10 gap-2 w-full">
              <LogOut className="w-4 h-4" /> Esci dall'account
            </Button>
          </div>
        )}

        {/* --- BADGE --- */}
        {tab === "Badge" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground mb-3">{unlockedBadges.length} / {allBadges.length} badge sbloccati</p>
            {allBadges.map((b) => {
              const unlocked = unlockedBadges.find((u) => u.id === b.id);
              return (
                <div key={b.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  unlocked ? "bg-amber-500/8 border-amber-500/25" : "bg-muted/30 border-border opacity-60"
                }`}>
                  <span className="text-xl">{unlocked ? b.icon : "🔒"}</span>
                  <div className="flex-1">
                    <p className={`text-sm font-semibold ${unlocked ? "text-foreground" : "text-muted-foreground"}`}>{b.name}</p>
                    <p className="text-xs text-muted-foreground">{b.desc}</p>
                  </div>
                  {unlocked && (
                    <div className="text-right shrink-0">
                      <CheckCircle2 className="w-4 h-4 text-green-400 mb-0.5" />
                      <p className="text-xs text-muted-foreground/60">{new Date(unlocked.date).toLocaleDateString("it-IT")}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* --- MISSIONI --- */}
        {tab === "Missioni" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground mb-2">Missioni della settimana — si resettano ogni lunedì</p>
            {missions.items.map((m) => {
              const done = m.progress >= m.target;
              const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
              return (
                <div key={m.id} className={`bg-card border rounded-xl p-4 ${done ? "border-green-500/25" : "border-border"}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-xl">{m.icon}</span>
                    <div className="flex-1">
                      <p className={`text-sm font-semibold mb-1 ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>{m.text}</p>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-1.5">
                        <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{m.progress} / {m.target}</span>
                        <span className="font-semibold text-primary">+{m.xp} XP</span>
                      </div>
                    </div>
                    {done && <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* --- STATISTICHE --- */}
        {tab === "Statistiche" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { icon: "🔍", label: "Totale Ricerche", value: totalSearches, color: "text-primary" },
                { icon: "✅", label: "Passi Completati", value: totalSteps, color: "text-green-400" },
                { icon: "⭐", label: "Valutazioni Date", value: totalRatings, color: "text-amber-400" },
                { icon: "🔥", label: "Streak Corrente", value: `${streak.count}gg`, color: "text-orange-400" },
                { icon: "💎", label: "XP Totali", value: xp, color: "text-primary" },
                { icon: "🏅", label: "Badge Sbloccati", value: `${unlockedBadges.length}/${allBadges.length}`, color: "text-amber-400" },
              ].map((s) => (
                <div key={s.label} className="bg-card border border-border rounded-xl p-4">
                  <div className="text-xl mb-2">{s.icon}</div>
                  <div className={`text-2xl font-bold font-mono ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Level path */}
            <div className="bg-card border border-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-foreground mb-4">🎖️ Percorso Livelli</h3>
              <div className="space-y-3">
                {LEVELS.map((l) => {
                  const reached = xp >= l.min;
                  const current = level.name === l.name;
                  return (
                    <div key={l.name} className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-all ${
                      current ? "bg-primary/10 border-primary/30" : reached ? "bg-green-500/5 border-green-500/15" : "border-transparent opacity-40"
                    }`}>
                      <span className="text-lg">{l.icon}</span>
                      <div className="flex-1">
                        <p className="text-xs font-semibold text-foreground">{l.name}</p>
                        <p className="text-xs text-muted-foreground">{l.min} XP{l.max !== Infinity ? ` — ${l.max} XP` : "+"}</p>
                      </div>
                      {current && <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full font-bold">Attuale</span>}
                      {reached && !current && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                      {!reached && <Lock className="w-4 h-4 text-muted-foreground/40" />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Member since */}
            {user?.created_date && (
              <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
                <Calendar className="w-5 h-5 text-secondary" />
                <div>
                  <p className="text-xs text-muted-foreground">Membro dal</p>
                  <p className="text-sm font-semibold text-foreground">
                    {new Date(user.created_date).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}