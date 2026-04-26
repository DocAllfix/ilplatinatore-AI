import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Clock, Swords, BookOpen, Edit2, Save, X } from "lucide-react";
import { gameStats as gameStatsApi } from "@/api/stubs";

const STAT_ICONS = {
  totalPlaytime: { icon: Clock, color: "text-cyan-400", label: "Ore giocate" },
  bossesFelled: { icon: Swords, color: "text-rose-400", label: "Boss sconfitti" },
  currentLevel: { icon: Zap, color: "text-amber-400", label: "Livello attuale" },
  questsCompleted: { icon: BookOpen, color: "text-green-400", label: "Quest completate" },
};

export default function GameStatsPanel({ gameSlug, gameName, onStatsUpdate }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  const fetchStats = async () => {
    setLoading(true);
    const existing = await gameStatsApi.filter({ gameSlug });
    if (existing.length > 0) {
      setStats(existing[0]);
      setEditForm(existing[0]);
    } else {
      const newStats = {
        gameSlug,
        gameName,
        totalPlaytime: 0,
        bossesFelled: 0,
        currentLevel: 1,
        questsCompleted: 0,
        progressionPercentage: 0,
      };
      const created = await gameStatsApi.create(newStats);
      setStats(created);
      setEditForm(created);
    }
    setLoading(false);
  };

  const handleSave = async () => {
    const updated = await gameStatsApi.update(stats.id, editForm);
    setStats(updated);
    setEditing(false);
    onStatsUpdate?.();
  };

  if (!stats && !loading) {
    return (
      <button
        onClick={fetchStats}
        className="w-full text-sm text-primary hover:underline"
      >
        Carica statistiche
      </button>
    );
  }

  if (loading) {
    return <div className="text-xs text-muted-foreground">Caricamento...</div>;
  }

  return (
    <div className="space-y-2">
      {/* Stats Grid */}
      {!editing && (
        <div className="grid grid-cols-2 gap-2">
          {["totalPlaytime", "bossesFelled", "currentLevel", "questsCompleted"].map((key) => {
            const Icon = STAT_ICONS[key]?.icon;
            return (
              <div key={key} className="bg-white/2 border border-white/5 rounded-lg p-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  {Icon && <Icon className={`w-3.5 h-3.5 ${STAT_ICONS[key].color}`} />}
                  <span className="text-xs text-muted-foreground">{STAT_ICONS[key].label}</span>
                </div>
                <div className="text-lg font-bold text-foreground">
                  {stats[key]}
                  {key === "totalPlaytime" && <span className="text-xs text-muted-foreground ml-0.5">h</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Progress Bar */}
      {!editing && (
        <div className="bg-white/2 border border-white/5 rounded-lg p-2.5">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Completamento</span>
            <span className="font-bold text-primary">{stats.progressionPercentage}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={{ width: 0 }}
              animate={{ width: `${stats.progressionPercentage}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </div>
      )}

      {/* Edit Form */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-white/2 border border-primary/20 rounded-lg p-3 space-y-2.5 overflow-hidden"
          >
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Ore giocate</label>
              <input
                type="number"
                value={editForm.totalPlaytime || 0}
                onChange={(e) => setEditForm({ ...editForm, totalPlaytime: Number(e.target.value) })}
                className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Boss sconfitti</label>
              <input
                type="number"
                value={editForm.bossesFelled || 0}
                onChange={(e) => setEditForm({ ...editForm, bossesFelled: Number(e.target.value) })}
                className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Livello attuale</label>
              <input
                type="number"
                value={editForm.currentLevel || 1}
                onChange={(e) => setEditForm({ ...editForm, currentLevel: Number(e.target.value) })}
                className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Quest completate</label>
              <input
                type="number"
                value={editForm.questsCompleted || 0}
                onChange={(e) => setEditForm({ ...editForm, questsCompleted: Number(e.target.value) })}
                className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">Completamento (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                value={editForm.progressionPercentage || 0}
                onChange={(e) => setEditForm({ ...editForm, progressionPercentage: Math.min(100, Number(e.target.value)) })}
                className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-sm text-foreground"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleSave}
                className="flex-1 flex items-center justify-center gap-1 bg-primary text-primary-foreground px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                <Save className="w-3 h-3" /> Salva
              </button>
              <button
                onClick={() => setEditing(false)}
                className="flex-1 flex items-center justify-center gap-1 bg-muted text-foreground px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-muted/80 transition-colors"
              >
                <X className="w-3 h-3" /> Annulla
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Button */}
      {!editing && (
        <button
          onClick={() => setEditing(true)}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 px-3 py-2 rounded-lg transition-all"
        >
          <Edit2 className="w-3 h-3" /> Modifica statistiche
        </button>
      )}
    </div>
  );
}