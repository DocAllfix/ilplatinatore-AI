import React, { useState, useRef, useEffect } from "react";
import { MessageCircle, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function TrophyHelpPopover({ trophyName, gameName }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleChat = (e) => {
    e.stopPropagation();
    const query = `Come ottengo il trofeo "${trophyName}" in ${gameName}?`;
    localStorage.setItem("platinatore_prefill", query);
    navigate("/");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs italic text-primary/60 hover:text-primary transition-colors whitespace-nowrap"
      >
        Serve un aiuto?
      </button>

      {open && (
        <div className="absolute right-0 top-7 z-50 bg-card border border-border rounded-xl shadow-xl p-3 w-56 space-y-2">
          <button
            onClick={handleChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-all"
          >
            <MessageCircle className="w-3.5 h-3.5 shrink-0" />
            Chiedi all'AI
          </button>
          <a
            href={`https://www.ilplatinatore.it`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground text-xs font-medium transition-all"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            Vai su ilplatinatore.it
          </a>
        </div>
      )}
    </div>
  );
}