import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Star, Send } from "lucide-react";
import { createGuideRating } from "@/api/stubs";
import { toast } from "sonner";

export default function RatingWidget({ messageId, sessionId, guideId, onRated }) {
  const [stars, setStars] = useState(0);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [suggestion, setSuggestion] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (stars === 0) return;
    setSubmitting(true);
    try {
      await createGuideRating({
        guideId,
        messageId,
        sessionId,
        stars,
        suggestion: suggestion.trim() || undefined,
        language: "it",
      });
      setSubmitted(true);
      toast.success("Grazie per il tuo feedback!");
      onRated?.();
    } catch (e) {
      toast.error("Errore nell'invio del feedback");
    }
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div className="mt-4 pt-4 border-t border-white/5">
        <div className="flex items-center gap-2 text-sm text-platinum-success">
          <Star className="w-4 h-4 fill-current" />
          <span>Grazie per il tuo feedback!</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/5 space-y-3">
      <p className="text-xs text-muted-foreground">Quanto è stata utile questa guida?</p>
      
      {/* Stars */}
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onMouseEnter={() => setHoveredStar(n)}
            onMouseLeave={() => setHoveredStar(0)}
            onClick={() => setStars(n)}
            className="p-1 transition-transform hover:scale-110"
          >
            <Star
              className={`w-5 h-5 transition-colors ${
                n <= (hoveredStar || stars)
                  ? "fill-platinum-gold text-platinum-gold"
                  : "text-muted-foreground/30"
              }`}
            />
          </button>
        ))}
      </div>

      {/* Suggestion input (appears after selecting stars) */}
      {stars > 0 && (
        <div className="space-y-2">
          <input
            type="text"
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            placeholder="Cosa potremmo migliorare? (opzionale)"
            className="w-full bg-white/5 border border-white/5 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-primary/20 text-primary hover:bg-primary/30 rounded-lg gap-2"
          >
            <Send className="w-3 h-3" />
            {submitting ? "Invio..." : "Invia Feedback"}
          </Button>
        </div>
      )}
    </div>
  );
}