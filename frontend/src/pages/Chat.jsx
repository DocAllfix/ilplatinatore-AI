import React, { useState, useRef, useEffect } from "react";
import ChatBurgerMenu from "../components/chat/ChatBurgerMenu";
import { useSearchHistory } from "../hooks/useSearchHistory";
import ChatMessageBubble from "../components/chat/ChatMessageBubble";
import LoadingIndicator from "../components/chat/LoadingIndicator";
import ChatInput from "../components/chat/ChatInput";
import TrophyWelcome from "../components/chat/TrophyWelcome";
import { useGamificationContext } from "../context/GamificationContext";
import { api } from "@/api/client";
import { PencilIcon } from "lucide-react";

export default function Chat() {
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [messages, setMessages] = useState({});
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [guidesUsed, setGuidesUsed] = useState(0);
  const [editingInTopbar, setEditingInTopbar] = useState(false);
  const [editValue, setEditValue] = useState("");
  const { history, addToHistory } = useSearchHistory();
  const { trackSearch } = useGamificationContext();
  const scrollRef = useRef(null);

  const currentMessages = messages[currentSessionId] || [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentMessages, loading]);

  const createSession = () => {
    const id = "session_" + Date.now();
    const newSession = { id, title: "Nuova conversazione", gameDetected: null };
    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(id);
    setMessages((prev) => ({ ...prev, [id]: [] }));
    setSidebarOpen(false);
    return id;
  };

  const renameSession = (id, newTitle) => {
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title: newTitle } : s));
  };

  // Handle prefill from Games page or GuideRenderer popover
  useEffect(() => {
    const checkPrefill = () => {
      const prefill = localStorage.getItem("platinatore_prefill");
      if (prefill) {
        localStorage.removeItem("platinatore_prefill");
        handleSend(prefill);
      }
    };
    checkPrefill();
    window.addEventListener("platinatore_prefill", checkPrefill);
    return () => window.removeEventListener("platinatore_prefill", checkPrefill);
  }, []);

  const handleSend = async (text) => {
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = createSession();
    }

    addToHistory(text);
    trackSearch(text);
    const userMsg = { id: "msg_" + Date.now(), role: "user", content: text };
    setMessages((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), userMsg],
    }));

    // Update session title from first message
    if ((messages[sessionId] || []).length === 0) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, title: text.slice(0, 50) + (text.length > 50 ? "..." : "") }
            : s
        )
      );
    }

    setLoading(true);

    const aiId = "msg_" + Date.now();
    // La bolla AI viene aggiunta al primo chunk — finché non arriva niente
    // mostriamo solo il LoadingIndicator. Questo evita la bolla vuota sovrapposta.
    let bubbleAdded = false;

    try {
      await api.guideStream(
        text,
        "it",
        (chunk) => {
          if (!bubbleAdded) {
            bubbleAdded = true;
            setLoading(false);
            setMessages((prev) => ({
              ...prev,
              [sessionId]: [
                ...(prev[sessionId] || []),
                { id: aiId, role: "assistant", content: chunk },
              ],
            }));
          } else {
            setMessages((prev) => {
              const msgs = prev[sessionId] || [];
              return {
                ...prev,
                [sessionId]: msgs.map((m) =>
                  m.id === aiId ? { ...m, content: m.content + chunk } : m
                ),
              };
            });
          }
        },
        () => {
          // Garantisce setLoading(false) anche se onChunk non è mai stato chiamato
          setLoading(false);
          setGuidesUsed((prev) => prev + 1);
        },
      );
    } catch (err) {
      const errText = err?.data?.error || "Errore nella generazione della guida. Riprova.";
      if (bubbleAdded) {
        setMessages((prev) => {
          const msgs = prev[sessionId] || [];
          return {
            ...prev,
            [sessionId]: msgs.map((m) =>
              m.id === aiId ? { ...m, content: errText } : m
            ),
          };
        });
      } else {
        setMessages((prev) => ({
          ...prev,
          [sessionId]: [
            ...(prev[sessionId] || []),
            { id: aiId, role: "assistant", content: errText },
          ],
        }));
      }
      setLoading(false);
    }
  };

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 shrink-0">
        <ChatBurgerMenu
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewChat={createSession}
          onSelectSession={(id) => setCurrentSessionId(id)}
          searchHistory={history}
          onSendFromHistory={(q) => handleSend(q)}
          onRenameSession={renameSession}
        />
        {editingInTopbar && currentSessionId ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameSession(currentSessionId, editValue);
                  setEditingInTopbar(false);
                } else if (e.key === "Escape") {
                  setEditingInTopbar(false);
                }
              }}
              className="text-sm font-medium bg-transparent border-b border-primary/50 text-foreground outline-none flex-1 focus:border-primary transition-colors"
              autoFocus
            />
            <button
              onClick={() => {
                renameSession(currentSessionId, editValue);
                setEditingInTopbar(false);
              }}
              className="text-primary hover:text-primary/80 transition-colors text-xs px-2"
            >
              ✓
            </button>
          </div>
        ) : (
          <>
            <span className="text-sm font-medium text-muted-foreground truncate">
              {currentSessionId
                ? sessions.find((s) => s.id === currentSessionId)?.title || "Chat"
                : "🎮 Il Platinatore AI"}
            </span>
            {currentSessionId && (
              <button
                onClick={() => {
                  const current = sessions.find((s) => s.id === currentSessionId);
                  setEditValue(current?.title || "");
                  setEditingInTopbar(true);
                }}
                className="text-muted-foreground/60 hover:text-primary transition-colors p-1"
              >
                <PencilIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
        <button
          onClick={createSession}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors px-3 py-1.5 rounded-lg hover:bg-primary/10"
        >
          + Nuova
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {currentMessages.length === 0 && !loading && (
            <TrophyWelcome onSend={handleSend} />
          )}

          {currentMessages.map((msg) => (
            <ChatMessageBubble key={msg.id} message={msg} sessionId={currentSessionId} />
          ))}

          {loading && <LoadingIndicator />}
        </div>
      </div>

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={loading} />
    </div>
  );
}