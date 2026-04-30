import { redis } from "@/config/redis.js";
import { logger } from "@/utils/logger.js";

/**
 * T3.1 — KF-1 Conversational Memory.
 *
 * Storage: Redis con TTL 1h. Niente DB persistence per questa Fase 24:
 *   - veloce, no schema migration
 *   - GDPR-friendly (TTL forza rotation)
 *   - acceptable trade-off: turn vecchi >1h non sono ricostruibili
 *
 * Cap aggressivo: max 5 turn precedenti per controllare token Gemini.
 * Cross-game contamination: se la game_id del nuovo turn != del precedente,
 * il caller può chiamare clear() per resettare.
 *
 * Chiave Redis: "conv:<sessionId|userId>" — il caller passa l'identifier
 * più stabile disponibile (userId se loggato, sessionId altrimenti).
 *
 * Formato:
 *   list di stringhe JSON, ognuna {role, text, gameId?, ts}
 *   Stored come JSON array, non Redis LIST: serializzazione semplice + TTL atomic.
 */

const PREFIX = "conv:";
const TTL_SECONDS = 60 * 60; // 1h
const MAX_TURNS = 5;
// Cap per messaggio: una guida lunga troncata a 800 chars per non gonfiare il
// token budget della prossima chiamata. Il caller può salvare la versione
// completa altrove (DB) se serve audit.
const MAX_MESSAGE_CHARS = 800;

export type ConvRole = "user" | "assistant";

export interface ConvTurn {
  role: ConvRole;
  text: string;
  /** game_id detected nel turn (per reset cross-game). null se non normalizzato. */
  gameId: number | null;
  /** epoch ms del turn. */
  ts: number;
}

export interface ConversationContext {
  /** Turn precedenti (escluso quello corrente) — già trimmati a MAX_TURNS. */
  previousTurns: ConvTurn[];
  /** True se il turn corrente cambia gameId rispetto all'ultimo memorizzato. */
  resetSuggested: boolean;
}

function key(identifier: string): string {
  return `${PREFIX}${identifier}`;
}

function trimMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS) + "…";
}

/**
 * Recupera il contesto conversazionale per l'identifier.
 * Fail-open: errore Redis → previousTurns=[].
 */
export async function getConversation(
  identifier: string,
  currentGameId: number | null,
): Promise<ConversationContext> {
  if (!identifier) return { previousTurns: [], resetSuggested: false };
  const k = key(identifier);
  try {
    const raw = await redis.get(k);
    if (!raw) return { previousTurns: [], resetSuggested: false };
    const turns = JSON.parse(raw) as ConvTurn[];
    if (!Array.isArray(turns)) return { previousTurns: [], resetSuggested: false };

    // Cross-game contamination check: se l'ultimo turn era su un game diverso
    // dal corrente, il caller dovrebbe resettare per evitare confusione.
    const lastWithGame = [...turns].reverse().find((t) => t.gameId !== null);
    const resetSuggested =
      currentGameId !== null &&
      lastWithGame !== undefined &&
      lastWithGame.gameId !== null &&
      lastWithGame.gameId !== currentGameId;

    return { previousTurns: turns.slice(-MAX_TURNS), resetSuggested };
  } catch (err) {
    logger.warn({ err, identifier }, "conversation.memory.get: errore Redis (fail-open)");
    return { previousTurns: [], resetSuggested: false };
  }
}

/**
 * Aggiunge un turn alla memoria. Idempotency non garantita (ogni call append).
 * Trim automatico a MAX_TURNS.
 * Fail-open: errore Redis → log warn, no throw.
 */
export async function appendTurn(
  identifier: string,
  role: ConvRole,
  text: string,
  gameId: number | null,
): Promise<void> {
  if (!identifier || !text.trim()) return;
  const k = key(identifier);
  const turn: ConvTurn = {
    role,
    text: trimMessage(text),
    gameId,
    ts: Date.now(),
  };
  try {
    const raw = await redis.get(k);
    const existing: ConvTurn[] =
      raw && (() => {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? (parsed as ConvTurn[]) : [];
        } catch {
          return [];
        }
      })() || [];

    const updated = [...existing, turn].slice(-MAX_TURNS * 2); // tieni 10 per safety, esposto solo 5 in get
    await redis.setex(k, TTL_SECONDS, JSON.stringify(updated));
  } catch (err) {
    logger.warn({ err, identifier }, "conversation.memory.appendTurn: errore Redis (fail-open)");
  }
}

/**
 * Reset esplicito della memoria per l'identifier.
 * Usato quando l'utente cambia argomento radicalmente (frontend "nuova chat")
 * oppure il caller rileva cross-game contamination via resetSuggested.
 */
export async function clearConversation(identifier: string): Promise<void> {
  if (!identifier) return;
  try {
    await redis.del(key(identifier));
  } catch (err) {
    logger.warn({ err, identifier }, "conversation.memory.clear: errore Redis");
  }
}

// Esposto per test
export const __memory = {
  PREFIX,
  TTL_SECONDS,
  MAX_TURNS,
  MAX_MESSAGE_CHARS,
};
