import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Trophy, Target, BookOpen, Star, ArrowLeft, Circle, Heart, Clock, Zap, Search, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { useFavorites } from "../hooks/useFavorites";
import TrophyHelpPopover from "../components/games/TrophyHelpPopover";
import GameStatsPanel from "../components/games/GameStatsPanel";
import ObjectiveCard from "../components/games/ObjectiveCard";

const gamesData = [
  {
    slug: "elden-ring",
    name: "Elden Ring",
    cover: "https://images.unsplash.com/photo-1614680376573-df3480f0c6ff?w=400&h=220&fit=crop",
    trophies: [
      { name: "Elden Lord", desc: "Ottieni il finale principale", type: "platinum", difficulty: 5, time: "~100h" },
      { name: "Semidio caduto", desc: "Sconfiggi Godrick the Grafted", type: "gold", difficulty: 3, time: "~15min" },
      { name: "Cercatore di stelle", desc: "Completa la questline di Ranni", type: "gold", difficulty: 4, time: "~6h" },
      { name: "Cacciatore di draghi", desc: "Sconfiggi Placidusax il Drago", type: "silver", difficulty: 4, time: "~30min" },
    ],
    objectives: [
      { title: "Sconfiggi tutti i boss principali", desc: "Sfida i 20+ boss del gioco", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Visita tutte le aree sotterranee", desc: "Scopri le catacombe e i dungeon", type: "map", mapLabel: "15 location sotterranee nascoste" },
      { title: "Raccogli le 9 armi leggendarie", desc: "Trova tutte le armi uniche", type: "map", mapLabel: "9 weapon locations" },
      { title: "Ottieni tutte le sorcellerie leggendarie", desc: "Magie e incantesimi rari", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Massimizza una build meta per PvP", desc: "Setup ottimale per il combattimento", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Sblocca tutti gli accessi segreti", desc: "Muri illusori e nascondigli", type: "map", mapLabel: "Secret wall locations" },
    ],
  },
  {
    slug: "god-of-war-ragnarok",
    name: "God of War Ragnarök",
    cover: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400&h=220&fit=crop",
    trophies: [
      { name: "Father and Son", desc: "Completa l'avventura principale", type: "platinum", difficulty: 4, time: "~40h" },
      { name: "Sigrun's Apprentice", desc: "Sconfiggi una valchiria", type: "gold", difficulty: 4, time: "~20min" },
      { name: "Collector", desc: "Ottieni tutti i set di armatura", type: "silver", difficulty: 3, time: "~5h" },
    ],
    objectives: [
      { title: "Esplora tutti i 9 regni", desc: "Visita ogni area del mondo", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Sconfiggi tutti i 12 Berserker", desc: "Boss opzionali estremamente difficili", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Trova tutti i 48 Corvi di Odino", desc: "Collezionabili sparsi nel mondo", type: "map", mapLabel: "48 raven locations" },
      { title: "Completa tutti i Percorsi del Destino", desc: "Side quest importanti", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Sblocca tutte le abilità di Kratos", desc: "Potenziamenti completi", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Raccogli tutte le reliquie", desc: "Equipaggiamento raro e potente", type: "map", mapLabel: "Relic locations" },
    ],
  },
  {
    slug: "bloodborne",
    name: "Bloodborne",
    cover: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=400&h=220&fit=crop",
    trophies: [
      { name: "Yharnam Sunrise", desc: "Ottieni il finale dell'alba", type: "platinum", difficulty: 5, time: "~60h" },
      { name: "The Paleblood Hunt", desc: "Ottieni il finale nascosto", type: "gold", difficulty: 5, time: "~3h" },
      { name: "Lumenwood Kin", desc: "Ottieni il finale delle stelle", type: "gold", difficulty: 4, time: "~2h" },
    ],
    objectives: [
      { title: "Completa tutti e 3 i finali", desc: "Ottieni i tre ending", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Sconfiggi tutti i boss dei Chalice Dungeon", desc: "Dungeon procedurali", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Ottieni tutte le armi da caccia", desc: "Weapons leggendarie e rare", type: "map", mapLabel: "Weapon locations" },
      { title: "Completa le questline dei 5 NPC principali", desc: "Evita glitch e perdite", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
      { title: "Raccogli tutti gli oggetti DLC", desc: "The Old Hunters equipment", type: "map", mapLabel: "DLC item locations" },
      { title: "Sblocca i 3 percorsi segreti", desc: "Aree nascoste del gioco", type: "guide", siteUrl: "https://www.ilplatinatore.it" },
    ],
  },
];

const trophyColors = { platinum: "text-purple-400", gold: "text-amber-400", silver: "text-slate-400" };
const trophyBg = { platinum: "bg-card border-primary/40", gold: "bg-card border-primary/40", silver: "bg-card border-primary/40" };
const trophyEmoji = { platinum: "🏆", gold: "🥇", silver: "🥈" };

function DifficultyDots({ level }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((d) => (
        <div key={d} className={`w-1.5 h-1.5 rounded-full ${d <= level ? "bg-primary" : "bg-muted"}`} />
      ))}
    </div>
  );
}

function CheckIcon({ done }) {
  if (!done) return (
    <Circle className="w-5 h-5 text-muted-foreground/30 shrink-0" />
  );
  return (
    <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center shrink-0 shadow-[0_0_8px_2px_rgba(16,185,129,0.5)]">
      <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3">
        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function TargetIcon({ done }) {
  if (!done) return (
    <Circle className="w-5 h-5 text-muted-foreground/30 shrink-0" />
  );
  return (
    <div className="w-5 h-5 flex items-center justify-center shrink-0">
      <div className="w-5 h-5 rounded-full border-2 border-primary flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-primary" />
      </div>
    </div>
  );
}

export default function Games() {
  const [selectedGame, setSelectedGame] = useState(null);
  const [checkedTrophies, setCheckedTrophies] = useState({});
  const [checkedObjectives, setCheckedObjectives] = useState({});
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { favorites, isFav, toggleFav } = useFavorites();

  const game = gamesData.find((g) => g.slug === selectedGame);

  const toggleTrophy = (key) => setCheckedTrophies((p) => ({ ...p, [key]: !p[key] }));
  const toggleObjective = (key) => setCheckedObjectives((p) => ({ ...p, [key]: !p[key] }));

  if (game) {
    const trophyPercent = Math.round(
      (Object.keys(checkedTrophies).filter((k) => k.startsWith(game.slug) && checkedTrophies[k]).length / game.trophies.length) * 100
    );
    const completedObjectives = Object.keys(checkedObjectives).filter((k) => k.startsWith(game.slug) && checkedObjectives[k]).length;
    const objPercent = Math.round((completedObjectives / game.objectives.length) * 100);

    const gameFavId = `game-${game.slug}`;

    const handleObjectiveChat = (obj) => {
      localStorage.setItem("platinatore_prefill", `${obj.title} in ${game.name}`);
      window.location.href = "/";
    };

    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => setSelectedGame(null)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Tutti i giochi
            </button>
            <button
              onClick={() => toggleFav({ id: gameFavId, type: "game", name: game.name, slug: game.slug })}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all ${
                isFav(gameFavId)
                  ? "border-rose-500/40 text-rose-400 bg-rose-500/10"
                  : "border-border text-muted-foreground hover:text-rose-400 hover:border-rose-500/30"
              }`}
            >
              <Heart className={`w-3.5 h-3.5 ${isFav(gameFavId) ? "fill-rose-400" : ""}`} />
              {isFav(gameFavId) ? "Nei preferiti" : "Aggiungi ai preferiti"}
            </button>
          </div>

          <div className="rounded-2xl overflow-hidden border border-white/5 mb-6">
            <img src={game.cover} alt={game.name} className="w-full h-40 object-cover" />
            <div className="p-5">
              <h1 className="text-2xl font-bold text-foreground">{game.name}</h1>
            </div>
          </div>

          {/* Summary Dashboard */}
          <section className="mb-8">
            <div className="bg-card border border-primary/20 rounded-2xl overflow-hidden">
              <button
                onClick={() => setDashboardOpen(!dashboardOpen)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/10 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">📊</span>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Riepilogo Progressi</h2>
                </div>
                <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${dashboardOpen ? "rotate-180" : ""}`} />
              </button>
              {dashboardOpen && <div className="px-5 pt-4 pb-6 space-y-4 border-t border-border/50">
                {/* Trophies progress */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <Trophy className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-xs font-medium text-foreground">Trofei</span>
                    </div>
                    <span className="text-xs font-mono text-amber-400">
                      {Object.keys(checkedTrophies).filter((k) => k.startsWith(game.slug) && checkedTrophies[k]).length}/{game.trophies.length}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400 transition-all duration-500" style={{ width: `${trophyPercent}%` }} />
                  </div>
                  <p className="text-right text-xs text-muted-foreground mt-1">{trophyPercent}%</p>
                </div>

                {/* Objectives progress */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <Target className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-xs font-medium text-foreground">Obiettivi</span>
                    </div>
                    <span className="text-xs font-mono text-red-400">
                      {completedObjectives}/{game.objectives.length}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-red-400 transition-all duration-500" style={{ width: `${objPercent}%` }} />
                  </div>
                  <p className="text-right text-xs text-muted-foreground mt-1">{objPercent}%</p>
                </div>

                {/* Overall progress */}
                {(() => {
                  const overallPercent = Math.round((trophyPercent + objPercent) / 2);
                  return (
                    <div className="pt-2 border-t border-border">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <Star className="w-3.5 h-3.5 text-primary" />
                          <span className="text-xs font-semibold text-foreground">Completamento totale</span>
                        </div>
                        <span className="text-xs font-mono font-bold text-primary">{overallPercent}%</span>
                      </div>
                      <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-primary to-secondary transition-all duration-500" style={{ width: `${overallPercent}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>}
            </div>
          </section>

          {/* Trophies */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Trophy className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Trofei</h2>
              </div>
              <span className="text-xs font-mono text-primary">{trophyPercent}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted mb-4 overflow-hidden">
              <div className="h-full rounded-full bg-amber-400 transition-all duration-500" style={{ width: `${trophyPercent}%` }} />
            </div>
            <div className="space-y-2">
              {game.trophies.map((t, i) => {
                const key = `${game.slug}-t-${i}`;
                const done = checkedTrophies[key];
                const trophyFavId = `trophy-${game.slug}-${i}`;
                return (
                  <div key={key} className={`rounded-xl border ${trophyBg[t.type]} ${done ? "opacity-60" : ""}`}>
                    <div className="flex items-start gap-3 px-4 py-3">
                      {/* Check button */}
                      <button onClick={() => toggleTrophy(key)} className="mt-0.5 shrink-0">
                        <CheckIcon done={done} />
                      </button>

                      {/* Trophy info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-base">{trophyEmoji[t.type]}</span>
                          <p className={`text-sm font-semibold ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>{t.name}</p>
                          <button
                            onClick={() => toggleFav({ id: trophyFavId, type: "trophy", name: t.name, gameName: game.name, trophyType: t.type })}
                            className={`ml-auto shrink-0 ${isFav(trophyFavId) ? "text-rose-400" : "text-muted-foreground/30 hover:text-rose-300"} transition-colors`}
                          >
                            <Heart className={`w-3.5 h-3.5 ${isFav(trophyFavId) ? "fill-rose-400" : ""}`} />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{t.desc}</p>
                        <div className="flex items-center gap-4 mt-2">
                          <div className="flex items-center gap-1.5">
                            <Zap className="w-3 h-3 text-primary/60" />
                            <DifficultyDots level={t.difficulty} />
                          </div>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground/60">
                            <Clock className="w-3 h-3" />
                            <span>{t.time}</span>
                          </div>
                        </div>
                      </div>

                      {/* Help popover */}
                      <TrophyHelpPopover trophyName={t.name} gameName={game.name} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Statistics */}
          <section className="mb-6">
           <div className="flex items-center gap-2 mb-3">
             <Zap className="w-4 h-4 text-cyan-400" />
             <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Statistiche personali</h2>
           </div>
           <div className="bg-card border border-primary/20 rounded-xl p-5">
             <GameStatsPanel gameSlug={game.slug} gameName={game.name} />
           </div>
          </section>

          {/* Objectives & Guides */}
          <section>
           <div className="flex items-center justify-between mb-3">
             <div className="flex items-center gap-2">
               <Target className="w-4 h-4 text-red-400" />
               <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Obiettivi e Guide</h2>
             </div>
             <span className="text-xs font-mono text-primary">{objPercent}%</span>
           </div>
           <div className="h-1.5 rounded-full bg-muted mb-4 overflow-hidden">
             <div className="h-full rounded-full bg-red-400 transition-all duration-500" style={{ width: `${objPercent}%` }} />
           </div>
           <div className="space-y-3">
             {game.objectives.map((obj, i) => {
               const key = `${game.slug}-o-${i}`;
               const done = checkedObjectives[key];
               return (
                 <div key={key} className={`rounded-xl border border-primary/40 bg-card transition-opacity ${done ? "opacity-60" : ""}`}>
                   <button
                     onClick={() => toggleObjective(key)}
                     className="w-full flex items-center gap-3 px-4 pt-3 pb-2 text-left hover:bg-muted/10 transition-all"
                   >
                     <TargetIcon done={done} />
                     <span className={`flex-1 text-sm font-semibold transition-colors ${done ? "line-through text-muted-foreground/40" : "text-foreground"}`}>{obj.title}</span>
                   </button>
                   <div className="px-4 pb-3">
                     <ObjectiveCard
                       objective={obj}
                       gameName={game.name}
                       onChat={() => handleObjectiveChat(obj)}
                     />
                   </div>
                 </div>
               );
             })}
           </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Torna alla chat
        </Link>
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-foreground">🎮 Giochi nel database</h1>
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground/50 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca..."
              className="pl-8 pr-3 py-1.5 bg-card border border-primary/20 rounded-lg text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors w-36 focus:w-48"
              style={{ transition: "width 0.2s" }}
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mb-8">Seleziona un gioco per vedere trofei, obiettivi e approfondimenti.</p>

        {favorites.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
              <Heart className="w-3.5 h-3.5 text-rose-400 fill-rose-400" /> Preferiti
            </h2>
            <div className="flex flex-wrap gap-2">
              {favorites.map((f) => (
                <button key={f.id}
                  onClick={() => f.type === "game" && setSelectedGame(f.slug)}
                  className="px-3 py-1.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300 hover:bg-rose-500/20 transition-all flex items-center gap-1.5"
                >
                  {f.type === "game" ? "🎮" : "🏆"} {f.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {gamesData.filter((g) => g.name.toLowerCase().includes(search.toLowerCase())).map((g, i) => (
            <motion.button
              key={g.slug}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              onClick={() => setSelectedGame(g.slug)}
              className="bg-card border border-primary/30 rounded-2xl overflow-hidden text-left hover:border-primary/60 transition-all group"
            >
              <img src={g.cover} alt={g.name} className="w-full h-32 object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
              <div className="p-4">
                <h3 className="font-semibold text-foreground text-sm">{g.name}</h3>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Trophy className="w-3 h-3 text-amber-400" />{g.trophies.length} trofei</span>
                  <span className="flex items-center gap-1"><Target className="w-3 h-3 text-red-400" />{g.objectives.length} obiettivi</span>
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}