import React from "react";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, User, Trophy, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Progress } from "@/components/ui/progress";

export default function ChatSidebar({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  guidesUsed = 2,
  guidesLimit = 5,
}) {
  return (
    <div className="flex flex-col h-full">
      {/* User info */}
      <div className="p-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/20 flex items-center justify-center">
            <User className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Ospite</p>
            <p className="text-xs text-muted-foreground">Piano Free</p>
          </div>
        </div>
      </div>

      {/* New chat button */}
      <div className="p-3">
        <Button
          onClick={onNewChat}
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl gap-2"
        >
          <Plus className="w-4 h-4" />
          Nuova Chat
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-1">
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => onSelectSession(session.id)}
            className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all ${
              currentSessionId === session.id
                ? "bg-primary/10 text-foreground border border-primary/20"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{session.title || "Nuova conversazione"}</span>
            </div>
            {session.gameDetected && (
              <div className="mt-1 ml-5.5 text-xs text-muted-foreground truncate">
                🎮 {session.gameDetected}
              </div>
            )}
          </button>
        ))}

        {sessions.length === 0 && (
          <div className="text-center py-8">
            <Trophy className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">Nessuna conversazione</p>
          </div>
        )}
      </div>

      {/* Guide counter + upgrade */}
      <div className="p-4 border-t border-white/5 space-y-3">
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">Guide rimanenti oggi</span>
            <span className="text-foreground font-mono">{guidesLimit - guidesUsed}/{guidesLimit}</span>
          </div>
          <Progress value={(guidesUsed / guidesLimit) * 100} className="h-1.5 bg-muted" />
        </div>
        <Link to="/prezzi">
          <Button
            variant="outline"
            size="sm"
            className="w-full border-primary/20 text-primary hover:bg-primary/10 rounded-xl gap-2"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            Passa a Pro
          </Button>
        </Link>
      </div>
    </div>
  );
}