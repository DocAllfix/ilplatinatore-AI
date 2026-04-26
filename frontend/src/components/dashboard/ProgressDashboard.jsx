import React, { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";
import { Clock, Gamepad2, TrendingUp } from "lucide-react";
import { gameStats as gameStatsApi } from "@/api/stubs";
import { useFavorites } from "../../hooks/useFavorites";
import { motion } from "framer-motion";

export default function ProgressDashboard() {
  const { favorites } = useFavorites();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadStats = async () => {
      const gameFavs = favorites.filter((f) => f.type === "game");
      if (gameFavs.length === 0) {
        setStats({
          totalGames: 0,
          totalPlaytime: 0,
          averageCompletion: 0,
          chartData: [],
        });
        setLoading(false);
        return;
      }

      const gameStats = await Promise.all(
        gameFavs.map((g) => gameStatsApi.filter({ gameSlug: g.slug }))
      );

      const flatStats = gameStats
        .flat()
        .filter((s) => s !== undefined && s !== null);

      if (flatStats.length === 0) {
        setStats({
          totalGames: gameFavs.length,
          totalPlaytime: 0,
          averageCompletion: 0,
          chartData: [],
        });
        setLoading(false);
        return;
      }

      const totalPlaytime = flatStats.reduce((sum, s) => sum + (s.totalPlaytime || 0), 0);
      const averageCompletion = Math.round(
        flatStats.reduce((sum, s) => sum + (s.progressionPercentage || 0), 0) / flatStats.length
      );
      const completed = flatStats.filter((s) => (s.progressionPercentage || 0) === 100).length;

      const chartData = [
        { name: "Completati", value: completed, color: "#00b894" },
        {
          name: "In corso",
          value: flatStats.length - completed,
          color: "#ff7675",
        },
      ];

      setStats({
        totalGames: flatStats.length,
        totalPlaytime,
        averageCompletion,
        chartData,
      });
      setLoading(false);
    };

    loadStats();
  }, [favorites]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!stats || stats.totalGames === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-card border border-primary/20 rounded-2xl p-6 mb-6"
    >
      <div className="flex items-center gap-2 mb-5">
        <TrendingUp className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">
          Progressi Globali
        </h2>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {/* Stat cards */}
        <div className="bg-white/2 border border-white/5 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Gamepad2 className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground">Giochi tracciati</span>
          </div>
          <div className="text-2xl font-bold font-mono text-foreground">
            {stats.totalGames}
          </div>
        </div>

        <div className="bg-white/2 border border-white/5 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-cyan-400" />
            <span className="text-xs text-muted-foreground">Ore totali</span>
          </div>
          <div className="text-2xl font-bold font-mono text-foreground">
            {Math.round(stats.totalPlaytime)}
            <span className="text-xs text-muted-foreground ml-1">h</span>
          </div>
        </div>

        <div className="bg-white/2 border border-white/5 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-green-400" />
            <span className="text-xs text-muted-foreground">Completamento medio</span>
          </div>
          <div className="text-2xl font-bold font-mono text-foreground">
            {stats.averageCompletion}
            <span className="text-xs text-muted-foreground ml-1">%</span>
          </div>
        </div>
      </div>

      {/* Pie chart */}
      {stats.chartData.length > 0 && (
        <div className="flex flex-col items-center">
          <p className="text-xs text-muted-foreground mb-4">Distribuzione completamento</p>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={stats.chartData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                paddingAngle={2}
                dataKey="value"
              >
                {stats.chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "0.5rem",
                }}
                labelStyle={{ color: "hsl(var(--foreground))" }}
              />
              <Legend
                wrapperStyle={{ paddingTop: "1rem" }}
                iconType="circle"
                formatter={(value, entry) => (
                  <span style={{ color: "hsl(var(--muted-foreground))" }}>
                    {value} ({entry.payload.value})
                  </span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}