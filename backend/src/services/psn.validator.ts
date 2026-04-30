import { logger } from "@/utils/logger.js";
import { TrophyLookupService } from "@/services/trophyLookup.service.js";

/**
 * T3.5 — KF-4 PSN cross-check.
 * Post-processing del content LLM per validare i psn_trophy_id citati.
 * Se il modello ha "allucinato" un id che non esiste nella tabella trophies,
 * il caller riceve la lista degli unverified e può flaggarli in UI.
 *
 * Pattern PSN noto:
 *   - psn_trophy_id: typically alphanumeric (4-50 chars), no spaces.
 *   - Il prompt builder istruisce il LLM a riportare letteralmente nel formato
 *     "psn_trophy_id: <value>" o citarlo come token alfanumerico.
 *
 * Strategia regex (conservativa per evitare false positive):
 *   - "psn_trophy_id: <token>" → cattura <token> alfanumerico fino a whitespace/punteggiatura
 *   - "NPWR\d{4,5}_\d+" → identificativo communication_id (filtrato via blacklist)
 */

// psn_trophy_id può essere alfanumerico/underscore/hash. Lunghezza tipica 8-40.
// Lookahead negativo `(?![A-Za-z0-9_\-])`: rifiuta token che proseguono oltre i
// 64 char (anti-truncation: meglio nessun match che un id parziale che porta
// a falso positivo nel lookup DB).
const PSN_TROPHY_ID_PATTERN =
  /\bpsn_trophy_id\s*[:=]\s*["'`]?([A-Za-z0-9_\-]{4,64})(?![A-Za-z0-9_\-])["'`]?/gi;

// communication_id è un identificativo del titolo gioco (NPWR12345_00), non trofeo.
// Lo escludiamo dalla validazione perché non è in trophies.psn_trophy_id.
const COMMUNICATION_ID_PATTERN = /^NPWR\d{4,6}_\d{2,4}$/;

/**
 * Estrae tutti i psn_trophy_id citati nel content. Distinct + filtrati.
 * Ritorna lista vuota se nessuno. Errore parsing → empty (no throw).
 */
export function extractPsnTrophyIds(content: string): string[] {
  if (!content) return [];
  const found = new Set<string>();
  try {
    let m: RegExpExecArray | null;
    PSN_TROPHY_ID_PATTERN.lastIndex = 0; // reset stateful regex
    while ((m = PSN_TROPHY_ID_PATTERN.exec(content)) !== null) {
      const token = m[1];
      if (!token) continue;
      // Skip communication_id format (NPWR12345_00) — non è un trophy id valido.
      if (COMMUNICATION_ID_PATTERN.test(token)) continue;
      // Skip palesi falsi positivi (placeholder, esempi)
      if (/^(none|null|undefined|example|tbd|n\/?a)$/i.test(token)) continue;
      found.add(token);
    }
  } catch (err) {
    logger.warn({ err }, "psn.validator: regex extraction failed");
  }
  return Array.from(found);
}

export interface PsnValidationResult {
  /** Tutti gli id estratti dal content (post-filter). */
  citedIds: string[];
  /** Subset di citedIds che NON esistono in tabella trophies (allucinazioni). */
  unverifiedIds: string[];
}

/**
 * Estrae + valida in un solo passo. Pensato come post-processing nell'orchestrator
 * dopo lo STEP 5 LLM. Se ritorna unverifiedIds non vuoto, l'UI può flaggarli.
 *
 * Fail-open: errore DB → unverifiedIds=[] (no falsi positivi su flag rosso).
 */
export async function validatePsnTrophyIdsInContent(
  content: string,
): Promise<PsnValidationResult> {
  const citedIds = extractPsnTrophyIds(content);
  if (citedIds.length === 0) {
    return { citedIds: [], unverifiedIds: [] };
  }
  const unverifiedIds = await TrophyLookupService.findUnverifiedPsnIds(citedIds);
  if (unverifiedIds.length > 0) {
    logger.warn(
      { citedCount: citedIds.length, unverifiedCount: unverifiedIds.length, sample: unverifiedIds.slice(0, 3) },
      "psn.validator: identificativi LLM non presenti in trophies (possibile hallucination)",
    );
  }
  return { citedIds, unverifiedIds };
}
