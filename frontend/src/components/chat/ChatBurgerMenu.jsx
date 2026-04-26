import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Plus, MessageSquare, Trophy, BookOpen, ExternalLink, ChevronRight, ChevronDown, History, Heart, Trash2 } from "lucide-react";
import { useFavorites } from "../../hooks/useFavorites";
import { useSearchHistory } from "../../hooks/useSearchHistory";

const popularGuides = [
  {
    id: 1,
    title: "Guida al Platino — Elden Ring",
    game: "Elden Ring",
    difficulty: "⭐⭐⭐⭐",
    time: "80-100h",
    siteUrl: "https://www.ilplatinatore.it",
    content: `## 🏆 Platino Elden Ring\n\n**Difficoltà:** 4/5 | **Tempo stimato:** 80-100 ore\n\n### Passaggi principali\n\n1. **Completa la storia principale** — Sconfiggi tutti i boss obbligatori e raggiungi uno dei finali.\n2. **Sconfiggi tutti i boss opzionali** — Inclusi Malenia, Mohg, e i semidei nascosti.\n3. **Raccogli tutte le armi leggendarie** — 9 armi sparse per il mondo.\n4. **Ottieni tutte le magie leggendarie** — Incantesimi, Preghiere e Sorcellerie.\n5. **Visita tutte le aree** — Esplora ogni dungeon e catacombe.\n\n### Consigli\n- Usa la guida interattiva per non perdere nulla al primo giro\n- Il trofeo \"Age of Stars\" richiede la questline di Ranni\n- Alcuni trofei sono missabili: salva spesso`,
  },
  {
    id: 2,
    title: "Guida al Platino — God of War Ragnarök",
    game: "God of War Ragnarök",
    difficulty: "⭐⭐⭐",
    time: "50-60h",
    siteUrl: "https://www.ilplatinatore.it",
    content: `## 🏆 Platino God of War Ragnarök\n\n**Difficoltà:** 3/5 | **Tempo stimato:** 50-60 ore\n\n### Passaggi principali\n\n1. **Completa la storia** — Segui l'avventura di Kratos e Atreus fino alla fine.\n2. **Esplora tutti i Regni** — Visita ogni area accessibile nei 9 regni.\n3. **Completa i Percorsi del Destino** — Le side quest più importanti.\n4. **Sconfiggi tutti i Berserker** — 12 boss opzionali molto difficili.\n5. **Trova tutti i Corvi di Odino** — 48 corvi nascosti nel mondo.\n\n### Consigli\n- Gioca su qualsiasi difficoltà, puoi cambiarla in qualsiasi momento\n- I Berserker sono la sfida più difficile del gioco\n- Non perdere il Percorso del Destino di Freya`,
  },
  {
    id: 3,
    title: "Guida al Platino — Bloodborne",
    game: "Bloodborne",
    difficulty: "⭐⭐⭐⭐⭐",
    time: "40-50h",
    siteUrl: "https://www.ilplatinatore.it",
    content: `## 🏆 Platino Bloodborne\n\n**Difficoltà:** 5/5 | **Tempo stimato:** 40-50 ore\n\n### Passaggi principali\n\n1. **Ottieni tutti e 3 i finali** — Richiede almeno 3 run (o use dei save backup).\n2. **Completa tutte le questline dei NPC** — Molto facile sbagliare o perdere.\n3. **Ottieni tutte le armi della Caccia** — Inclusi i trick weapons DLC.\n4. **Sblocca tutti i Calici del Sangue** — Scendi fino al fondo dei Chalice Dungeon.\n5. **Sconfiggi tutti i boss** — Incluso il Pthumerian Ihyll Chalice boss.\n\n### Consigli\n- I finali si ottengono al Sogno del Cacciatore\n- Non uccidere i NPC prima di completare le loro quest\n- Il DLC The Old Hunters è obbligatorio per alcune armi`,
  },
  {
    id: 4,
    title: "Guida al Platino — The Last of Us Part I",
    game: "The Last of Us Part I",
    difficulty: "⭐⭐⭐",
    time: "25-30h",
    siteUrl: "https://www.ilplatinatore.it",
    content: `## 🏆 Platino The Last of Us Part I\n\n**Difficoltà:** 3/5 | **Tempo stimato:** 25-30 ore\n\n### Passaggi principali\n\n1. **Completa il gioco su Grounded** — La difficoltà più alta, missabili molti trofei.\n2. **Trova tutti i collezionabili** — Fumetti, artefatti, ciondoli.\n3. **Massimizza tutte le armi** — Potenzia ogni arma al massimo.\n4. **Completa tutte le conversazioni opzionali** — Ascolta tutti i dialoghi.\n\n### Consigli\n- Grounded Mode disabilita l'HUD, preparati bene\n- Usa il capitolo select per i collezionabili mancanti\n- La difficoltà non influenza altri trofei`,
  },
];

export default function ChatBurgerMenu({ sessions, currentSessionId, onNewChat, onSelectSession, onSendFromHistory, onRenameSession }) {
  const [open, setOpen] = useState(false);
  const [pastChatsOpen, setPastChatsOpen] = useState(true);
  const [guidesOpen, setGuidesOpen] = useState(false);
  const [selectedGuide, setSelectedGuide] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favsOpen, setFavsOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const { favorites, toggleFav } = useFavorites();
  const { history, removeFromHistory, clearHistory } = useSearchHistory();

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  return (
    <>
      {/* Burger button */}
      <button
        onClick={() => setOpen(true)}
        className="w-9 h-9 flex flex-col items-center justify-center gap-1.5 rounded-xl hover:bg-white/5 transition-colors"
      >
        <span className="w-5 h-0.5 bg-foreground/70 rounded-full" />
        <span className="w-5 h-0.5 bg-foreground/70 rounded-full" />
        <span className="w-3.5 h-0.5 bg-foreground/70 rounded-full self-start ml-[5px]" />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-40"
              onClick={() => { setOpen(false); setSelectedGuide(null); }}
            />

            {/* Drawer */}
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed top-0 left-0 h-full w-80 z-50 flex flex-col bg-card border-r border-border"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold text-foreground">🎮 Il Platinatore</span>
                </div>
                <button
                  onClick={() => { setOpen(false); setSelectedGuide(null); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto">

                {/* New chat */}
                <div className="px-4 pt-4 pb-2">
                  <button
                    onClick={() => { onNewChat(); setOpen(false); setSelectedGuide(null); }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/10 border border-primary/20 hover:bg-primary/15 transition-all text-sm font-medium text-primary"
                  >
                    <Plus className="w-4 h-4 shrink-0" />
                    Nuova Chat
                  </button>
                </div>

                {/* Current chat */}
                {currentSession && (
                  <div className="px-4 py-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Chat in corso</p>
                    {editingName ? (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/8 border border-primary/15">
                        <input
                          type="text"
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              onRenameSession(currentSessionId, newName);
                              setEditingName(false);
                            } else if (e.key === "Escape") {
                              setEditingName(false);
                            }
                          }}
                          className="flex-1 bg-transparent text-sm text-foreground outline-none border-b border-primary/30 focus:border-primary/60 transition-colors"
                          autoFocus
                        />
                        <button
                          onClick={() => {
                            onRenameSession(currentSessionId, newName);
                            setEditingName(false);
                          }}
                          className="text-primary hover:text-primary/80 transition-colors"
                        >
                          ✓
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/8 border border-primary/15 group">
                        <div className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                        <span className="text-sm text-foreground truncate flex-1">{currentSession.title}</span>
                        <button
                          onClick={() => {
                            setNewName(currentSession.title);
                            setEditingName(true);
                          }}
                          className="text-muted-foreground/60 hover:text-primary transition-all text-xs px-2 py-1"
                        >
                          ✎
                        </button>
                      </div>
                    )}
                  </div>
                )}



                {/* Search history */}
                <div className="px-4 py-2">
                  <button
                    onClick={() => setHistoryOpen(!historyOpen)}
                    className="w-full flex items-center justify-between px-1 py-1.5 mb-1"
                  >
                    <div className="flex items-center gap-2">
                      <History className="w-3.5 h-3.5 text-secondary" />
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cronologia</p>
                    </div>
                    <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${historyOpen ? "rotate-180" : ""}`} />
                  </button>
                  <AnimatePresence>
                    {historyOpen && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        {history.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-3 py-2">Nessuna ricerca recente</p>
                        ) : (
                          <>
                            <div className="space-y-1 max-h-48 overflow-y-auto">
                              {history.map((h) => (
                                <div key={h.query} className="flex items-center gap-2 group">
                                  <button
                                    onClick={() => { onSendFromHistory?.(h.query); setOpen(false); }}
                                    className="flex-1 text-left px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted truncate transition-all"
                                  >{h.query}</button>
                                  <button onClick={() => removeFromHistory(h.query)} className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-rose-400 transition-all pr-1">
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <button onClick={clearHistory} className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground/40 hover:text-rose-400 transition-colors px-3">
                              <Trash2 className="w-3 h-3" /> Cancella cronologia
                            </button>
                          </>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Favorites */}
                {favorites.length > 0 && (
                  <div className="px-4 py-2">
                    <button
                      onClick={() => setFavsOpen(!favsOpen)}
                      className="w-full flex items-center justify-between px-1 py-1.5 mb-1"
                    >
                      <div className="flex items-center gap-2">
                        <Heart className="w-3.5 h-3.5 text-rose-400 fill-rose-400" />
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Preferiti</p>
                      </div>
                      <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${favsOpen ? "rotate-180" : ""}`} />
                    </button>
                    <AnimatePresence>
                      {favsOpen && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden space-y-1">
                          {favorites.map((f) => (
                            <div key={f.id} className="flex items-center gap-2 group">
                              <div className="flex-1 px-3 py-2 rounded-lg bg-rose-500/5 border border-rose-500/10 text-xs text-rose-300 truncate">
                                {f.type === "game" ? "🎮" : "🏆"} {f.name}
                                {f.gameName && <span className="text-muted-foreground/50 ml-1">— {f.gameName}</span>}
                              </div>
                              <button onClick={() => toggleFav(f)} className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-rose-400 transition-all">
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                <div className="mx-4 my-1 border-t border-border" />

                {/* Popular guides */}
                <div className="px-4 py-2">
                  <button
                    onClick={() => { setGuidesOpen(!guidesOpen); setSelectedGuide(null); }}
                    className="w-full flex items-center justify-between px-1 py-1.5 mb-1"
                  >
                    <div className="flex items-center gap-2">
                      <Trophy className="w-3.5 h-3.5 text-amber-400" />
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Guide più lette</p>
                    </div>
                    <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${guidesOpen ? "rotate-180" : ""}`} />
                  </button>

                  <AnimatePresence>
                  {guidesOpen && !selectedGuide && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden space-y-1"
                    >
                      {popularGuides.map((guide) => (
                        <div key={guide.id} className="rounded-xl border border-border overflow-hidden">
                          <div className="flex items-start gap-3 px-3 py-3">
                            <BookOpen className="w-3.5 h-3.5 text-secondary shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground font-medium truncate">{guide.game}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-xs text-muted-foreground">{guide.difficulty}</span>
                                <span className="text-xs text-muted-foreground/50">·</span>
                                <span className="text-xs text-muted-foreground">{guide.time}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex border-t border-border">
                            <button
                              onClick={() => { onSendFromHistory?.(guide.title); setOpen(false); setSelectedGuide(null); }}
                              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-primary hover:bg-primary/10 transition-colors font-medium"
                            >
                              <MessageSquare className="w-3 h-3" />
                              Leggi in chat
                            </button>
                            <div className="w-px bg-border" />
                            <a
                              href={guide.siteUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                              Sito web
                            </a>
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  )}
                  </AnimatePresence>

                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-border">
                <p className="text-xs text-muted-foreground/40 text-center">Il Platinatore AI · Powered by AI</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}