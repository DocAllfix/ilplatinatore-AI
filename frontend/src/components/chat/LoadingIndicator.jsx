import React, { useState, useEffect } from "react";

const loadingMessages = [
  "Cerco nel database...",
  "Analizzo le fonti online...",
  "Genero la tua guida personalizzata...",
];

export default function LoadingIndicator() {
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setMsgIndex((prev) => (prev + 1) % loadingMessages.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex justify-start">
      <div className="bg-card border border-primary/30 rounded-2xl rounded-bl-md px-5 py-4 max-w-[80%]">
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-sm text-muted-foreground animate-pulse">
            {loadingMessages[msgIndex]}
          </span>
        </div>
      </div>
    </div>
  );
}