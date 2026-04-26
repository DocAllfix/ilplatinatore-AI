import React, { useState } from "react";
import { Map, MessageSquare, ExternalLink } from "lucide-react";
import { motion } from "framer-motion";

export default function ObjectiveCard({ objective, gameName, onChat }) {
  const [showMap, setShowMap] = useState(false);

  // Determina il tipo di obiettivo
  const isCollectible = objective.type === "collectible" || objective.type === "map";
  const isGuide = objective.type === "guide";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      <p className="text-xs text-muted-foreground leading-relaxed">{objective.desc}</p>

      {isCollectible && (
        <>
          {showMap ? (
            <div className="bg-muted/30 rounded-lg p-4 flex items-center justify-center h-48">
              <div className="text-center">
                <Map className="w-8 h-8 text-primary/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Mappa interattiva di {gameName}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">{objective.mapLabel}</p>
              </div>
            </div>
          ) : null}
          <button
            onClick={() => setShowMap(!showMap)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20 hover:bg-primary/15 text-xs text-primary font-medium transition-all"
          >
            <Map className="w-3.5 h-3.5" />
            {showMap ? "Nascondi mappa" : "Visualizza mappa"}
          </button>
        </>
      )}

      {isGuide && (
        <div className="flex gap-2">
          <button
            onClick={onChat}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-primary/10 border border-primary/20 hover:bg-primary/15 text-xs text-primary font-medium transition-all"
          >
            <MessageSquare className="w-3 h-3" />
            Approfondisci
          </button>
          <a
            href={objective.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-muted/40 border border-border hover:border-primary/30 hover:bg-muted/60 text-xs text-muted-foreground hover:text-foreground font-medium transition-all"
          >
            <ExternalLink className="w-3 h-3" />
            Leggi sul sito
          </a>
        </div>
      )}
    </motion.div>
  );
}