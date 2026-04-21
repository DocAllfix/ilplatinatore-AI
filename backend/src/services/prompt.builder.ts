/**
 * Template dispatcher per il prompt LLM in base al guide_type.
 *
 * Taxonomy fissata da migration 004 (CHECK constraint):
 *   trophy | walkthrough | collectible | challenge | platinum
 *
 * La `topic` column (migration 024) è usata per granularità intra-type
 * (es. guide_type=collectible, topic='armi' → "guida raccolta armi").
 *
 * DECISIONI (vedi memory project_fase16_decisions.md):
 * - Output italiano SOLO qui (il DB è in inglese: harvester rule #1 del memory).
 *   La traduzione EN → IT per utenti in IT avviene a valle in llm.service.translateGuide.
 *   Questo builder produce un prompt CHE CHIEDE ALL'LLM DI RISPONDERE IN language.
 * - PSN anchor: solo per guide_type='trophy' con psn_trophy_id noto;
 *   previene deriva allucinata su identificativi trofei.
 */

export type GuideType =
  | "trophy"
  | "walkthrough"
  | "collectible"
  | "challenge"
  | "platinum";

export interface PsnAnchor {
  psn_trophy_id: string | null;
  psn_communication_id: string | null;
  rarity_source: string | null;
}

export interface PsnOfficial {
  /** Nome ufficiale Sony (EN canonico). Si assume NON-null quando il blocco è presente. */
  officialName: string;
  /** Descrizione ufficiale Sony (EN canonico). NULL se il fetcher PSN non l'ha popolata. */
  officialDetail: string | null;
}

export interface PromptContext {
  /** Testo già assemblato da RAG (assembleContext) — vuoto se fallback scraping. */
  ragContext: string;
  /** Testo assemblato da ScrapingService (scraper) — usato solo se ragContext è vuoto. */
  scrapingContext?: string;
  /** Titolo gioco in originale (en) — anche se l'utente scrive IT. */
  gameTitle: string;
  /** Nome/identifier del trofeo, topic o argomento specifico. */
  targetName: string;
  /** Tipo di guida — dispatcha il template. */
  guideType: GuideType;
  /** Lingua di risposta attesa. */
  language: string;
  /** Solo per guide_type='trophy' — metadati PSN per anchor anti-allucinazione. */
  psnAnchor?: PsnAnchor;
  /**
   * Solo per guide_type='trophy' — nome + descrizione ufficiali Sony (EN canonico).
   * Iniettati come primo blocco del USER prompt per ridurre allucinazione su
   * identità trofeo. Lingua EN perché il LLM risponde in EN + traduzione POST.
   */
  psnOfficial?: PsnOfficial;
  /** Query originale utente — preservata per contesto conversazionale. */
  userQuery: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Etichetta template applicato — loggata per osservabilità. */
  templateId: string;
}

// ── Fence condiviso: regole che valgono per ogni template. ─────────────────
const SYSTEM_CORE = `Sei "Il Platinatore AI", assistente specialistico per guide videoludiche.

REGOLE INVARIANTI:
1. Rispondi SOLO in base al CONTESTO fornito. Se il contesto non contiene la risposta, dichiara esplicitamente "Non ho informazioni sufficienti per questa guida." e NON inventare passaggi, identificativi trofei o sblocchi.
2. Se il contesto cita identificativi PSN (psn_trophy_id, psn_communication_id), riportali LETTERALMENTE senza modificarli.
3. Non fare riferimento a cheat, save editor, exploit banalizzanti, o pratiche che violino i ToS PlayStation/Xbox/Steam.
4. Output in Markdown valido: titoli (##), liste numerate per step, grassetto sui nomi chiave.
5. Cita le fonti in fondo come lista "Fonti:" quando il contesto mostra header "--- FONTE N: ... ---".`;

function formatPsnAnchor(a: PsnAnchor | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.psn_trophy_id) parts.push(`psn_trophy_id: ${a.psn_trophy_id}`);
  if (a.psn_communication_id) parts.push(`psn_communication_id: ${a.psn_communication_id}`);
  if (a.rarity_source) parts.push(`rarità: ${a.rarity_source}`);
  if (parts.length === 0) return "";
  return `\n\nIDENTIFICATIVI PSN UFFICIALI (riporta letteralmente nella risposta):\n- ${parts.join("\n- ")}`;
}

/**
 * Blocco autoritativo Sony (nome + descrizione) prepended al USER prompt prima
 * del CONTESTO. Emesso SOLO per guide_type='trophy' con psnOfficial presente.
 * In EN canonico perché il LLM risponde in EN e traduciamo a valle.
 */
function formatPsnOfficial(o: PsnOfficial | undefined): string {
  if (!o?.officialName) return "";
  const lines = [`NOME UFFICIALE TROFEO (Sony): ${o.officialName}`];
  if (o.officialDetail) lines.push(`DESCRIZIONE UFFICIALE: ${o.officialDetail}`);
  return `${lines.join("\n")}\n\n`;
}

function assembleUserContext(ctx: PromptContext): string {
  const primary = ctx.ragContext.trim();
  const fallback = ctx.scrapingContext?.trim() ?? "";
  if (primary) return `CONTESTO (fonti verificate):\n\n${primary}`;
  if (fallback) return `CONTESTO (scraping live — affidabilità variabile):\n\n${fallback}`;
  return "CONTESTO: (vuoto — nessuna fonte disponibile)";
}

// ── Template per guide_type ─────────────────────────────────────────────────

function buildTrophy(ctx: PromptContext): BuiltPrompt {
  const anchor = formatPsnAnchor(ctx.psnAnchor);
  const official = formatPsnOfficial(ctx.psnOfficial);
  const system = `${SYSTEM_CORE}

COMPITO: produci la guida per il trofeo "${ctx.targetName}" del gioco "${ctx.gameTitle}".
Rispondi in lingua: ${ctx.language}.
Struttura richiesta:
  ## Requisiti
  ## Passaggi
  1. ...
  ## Suggerimenti
  ## Fonti${anchor}`;
  const user = `${official}${assembleUserContext(ctx)}

DOMANDA UTENTE: ${ctx.userQuery}`;
  return { system, user, templateId: "trophy" };
}

function buildWalkthrough(ctx: PromptContext): BuiltPrompt {
  const system = `${SYSTEM_CORE}

COMPITO: produci una walkthrough (guida passo-passo) per "${ctx.targetName}" in "${ctx.gameTitle}".
Rispondi in lingua: ${ctx.language}.
Struttura richiesta:
  ## Panoramica
  ## Walkthrough dettagliata
  - Dividi per capitoli/aree se il contesto li espone.
  - Numera le azioni critiche.
  ## Oggetti/Drop rilevanti
  ## Fonti`;
  const user = `${assembleUserContext(ctx)}

DOMANDA UTENTE: ${ctx.userQuery}`;
  return { system, user, templateId: "walkthrough" };
}

function buildCollectible(ctx: PromptContext): BuiltPrompt {
  const system = `${SYSTEM_CORE}

COMPITO: guida alla raccolta di collectible "${ctx.targetName}" in "${ctx.gameTitle}".
Rispondi in lingua: ${ctx.language}.
Struttura richiesta:
  ## Numero totale e tipologia
  ## Posizioni
  - Raggruppa per area/capitolo.
  - Per ogni oggetto indica coordinate/landmark se presenti nel contesto.
  ## Missable (se presenti)
  ## Fonti`;
  const user = `${assembleUserContext(ctx)}

DOMANDA UTENTE: ${ctx.userQuery}`;
  return { system, user, templateId: "collectible" };
}

function buildChallenge(ctx: PromptContext): BuiltPrompt {
  const system = `${SYSTEM_CORE}

COMPITO: spiega come completare la sfida "${ctx.targetName}" in "${ctx.gameTitle}".
Rispondi in lingua: ${ctx.language}.
Struttura richiesta:
  ## Obiettivo
  ## Preparazione (build/equip consigliato)
  ## Strategia
  1. Azioni in ordine cronologico.
  ## Errori da evitare
  ## Fonti`;
  const user = `${assembleUserContext(ctx)}

DOMANDA UTENTE: ${ctx.userQuery}`;
  return { system, user, templateId: "challenge" };
}

function buildPlatinum(ctx: PromptContext): BuiltPrompt {
  const system = `${SYSTEM_CORE}

COMPITO: produci la roadmap al platino di "${ctx.gameTitle}".
Rispondi in lingua: ${ctx.language}.
Struttura richiesta:
  ## Difficoltà e ore stimate
  ## Playthrough consigliati
  ## Fase 1 (storia) — trofei automatici
  ## Fase 2 (cleanup) — missable, collectible, difficoltà
  ## Trofei più ostici
  ## Fonti`;
  const user = `${assembleUserContext(ctx)}

DOMANDA UTENTE: ${ctx.userQuery}`;
  return { system, user, templateId: "platinum" };
}

const BUILDERS: Record<GuideType, (ctx: PromptContext) => BuiltPrompt> = {
  trophy: buildTrophy,
  walkthrough: buildWalkthrough,
  collectible: buildCollectible,
  challenge: buildChallenge,
  platinum: buildPlatinum,
};

/**
 * Dispatcher principale. L'aggiunta di un sesto guide_type richiede:
 *   1. relax del CHECK constraint in migration dedicata
 *   2. aggiunta case qui + template
 * Senza questi due passaggi, l'INSERT post-generazione fallirebbe.
 */
export function buildPrompt(ctx: PromptContext): BuiltPrompt {
  const builder = BUILDERS[ctx.guideType];
  if (!builder) {
    throw new Error(`prompt.builder: guide_type non supportato: ${ctx.guideType}`);
  }
  return builder(ctx);
}
