import React, { useState } from "react";
import { ArrowUp } from "lucide-react";

export default function ChatInput({ onSend, disabled }) {
  const [text, setText] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-card border border-primary/40 rounded-2xl flex items-end gap-2 p-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Chiedi un trofeo, una sfida o un segreto di qualsiasi gioco..."
            rows={1}
            disabled={disabled}
            className="flex-1 bg-transparent border-0 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none px-3 py-2.5 max-h-32"
            style={{ minHeight: '40px' }}
          />
          <button
            type="submit"
            disabled={!text.trim() || disabled}
            className="shrink-0 w-10 h-10 rounded-xl bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground text-primary-foreground flex items-center justify-center transition-colors"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <p className="text-center text-xs text-muted-foreground/50 mt-2">
          Il Platinatore AI può commettere errori. Verifica sempre le informazioni importanti.
        </p>
      </div>
    </form>
  );
}