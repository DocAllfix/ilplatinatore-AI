import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import { AnimatePresence } from "framer-motion";
import RatingWidget from "./RatingWidget";
import GuideRenderer from "./GuideRenderer";
import ErrorReportModal from "./ErrorReportModal";
import { AlertTriangle } from "lucide-react";
import { useGamificationContext } from "../../context/GamificationContext";

export default function ChatMessageBubble({ message, sessionId }) {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const { trackRating } = useGamificationContext();
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="bg-primary/20 border border-primary/20 rounded-2xl rounded-br-md px-4 py-3 max-w-[85%] lg:max-w-[70%]">
          <p className="text-sm text-foreground leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="bg-card border border-primary/30 rounded-2xl rounded-bl-md px-5 py-4 max-w-[90%] lg:max-w-[75%]">
        {message.guide ? (
          <GuideRenderer guide={message.guide} />
        ) : (
          <ReactMarkdown
            className="text-sm prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={{
              h1: ({ children }) => <h1 className="text-lg font-bold text-foreground mt-4 mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-base font-bold text-foreground mt-3 mb-2">{children}</h2>,
              h3: ({ children }) => <h3 className="text-sm font-bold text-foreground mt-2 mb-1">{children}</h3>,
              p: ({ children }) => <p className="text-sm text-muted-foreground leading-relaxed my-1.5">{children}</p>,
              strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
              ul: ({ children }) => <ul className="my-2 space-y-1 ml-1">{children}</ul>,
              ol: ({ children }) => <ol className="my-2 space-y-1 ml-1 list-decimal list-inside">{children}</ol>,
              li: ({ children }) => <li className="text-sm text-muted-foreground flex gap-2"><span className="text-secondary shrink-0">•</span><span>{children}</span></li>,
              a: ({ children, ...props }) => (
                <a {...props} className="text-secondary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-primary/30 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>
              ),
              code: ({ children }) => (
                <code className="px-1.5 py-0.5 rounded bg-white/5 text-secondary text-xs font-mono">{children}</code>
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        )}

        <RatingWidget messageId={message.id} sessionId={sessionId} onRated={trackRating} />

        <div className="mt-3 pt-3 border-t border-white/5">
          <button
            onClick={() => setShowErrorModal(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-amber-400 transition-colors"
          >
            <AlertTriangle className="w-3 h-3" />
            Segnala errore in questa guida
          </button>
        </div>

        <AnimatePresence>
          {showErrorModal && (
            <ErrorReportModal onClose={() => setShowErrorModal(false)} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}