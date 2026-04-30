/**
 * Template dispatcher per il prompt LLM in base al guide_type.
 *
 * Taxonomy fissata da migration 004 (CHECK constraint):
 *   trophy | walkthrough | collectible | challenge | platinum
 *
 * La `topic` column (migration 024) è usata per granularità intra-type
 * (es. guide_type=collectible, topic='armi' → "guida raccolta armi").
 *
 * T1.4 — i18n native: il template è generato nella lingua target (HEADERS_I18N),
 * NON traduciamo a valle. Il LLM riceve istruzione esplicita "Output language: X"
 * + header strutturali nella lingua target. Questo elimina il problema legacy
 * dell'output bilingue parassita (header IT + corpo EN).
 *
 * Lingue supportate Tier 1: it, en, es, fr, de, pt, ja, zh, ru.
 * Lingue non whitelistate → fallback EN (coerente con detectLanguage).
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
  /** Lingua di risposta attesa (ISO-639-1). Default 'en' se non whitelisted. */
  language: string;
  /** Solo per guide_type='trophy' — metadati PSN per anchor anti-allucinazione. */
  psnAnchor?: PsnAnchor;
  /**
   * Solo per guide_type='trophy' — nome + descrizione ufficiali Sony (EN canonico).
   * Iniettati come primo blocco del USER prompt per ridurre allucinazione su
   * identità trofeo. Lingua EN perché è il dato canonico Sony.
   */
  psnOfficial?: PsnOfficial;
  /** Query originale utente — preservata per contesto conversazionale. */
  userQuery: string;
  /**
   * T3.1 — KF-1 Conversational Memory. Turn precedenti (max 5) iniettati nel
   * SYSTEM come "Conversation history:". Permette multi-turn natural ("aggiungi
   * più dettagli", "e per il trofeo successivo?"). Opzionale: se assente, il
   * comportamento è identico al pre-T3.1.
   */
  previousTurns?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Etichetta template applicato — loggata per osservabilità. */
  templateId: string;
}

// ── i18n: header e label native per Tier 1 ─────────────────────────────────

interface I18nLabels {
  // System core
  intro: string;
  rule_context_only: string;
  rule_no_information: string;
  rule_psn_literal: string;
  rule_no_cheats: string;
  rule_markdown: string;
  rule_sources: string;
  // Common labels
  task: string;
  output_language: string;
  context_verified: string;
  context_scraping: string;
  context_empty: string;
  user_question: string;
  // Headers
  h_requirements: string;
  h_steps: string;
  h_tips: string;
  h_sources: string;
  h_overview: string;
  h_walkthrough: string;
  h_walkthrough_split: string;
  h_walkthrough_numbered: string;
  h_drops: string;
  h_collectible_total: string;
  h_collectible_locations: string;
  h_collectible_grouped: string;
  h_collectible_landmarks: string;
  h_missables: string;
  h_objective: string;
  h_preparation: string;
  h_strategy: string;
  h_strategy_chronological: string;
  h_avoid_errors: string;
  h_difficulty: string;
  h_playthroughs: string;
  h_phase1: string;
  h_phase2: string;
  h_hardest: string;
  // Source line
  source_label: string;
  // Trophy-specific
  trophy_official_name: string;
  trophy_official_detail: string;
  psn_anchor_intro: string;
  psn_rarity: string;
}

const LABELS_EN: I18nLabels = {
  intro: 'You are "Il Platinatore AI", a specialist assistant for video game guides.',
  rule_context_only: "Answer ONLY based on the provided CONTEXT. If the context does not contain the answer, explicitly state \"I don't have enough information for this guide.\" and DO NOT invent steps, trophy IDs, or unlocks.",
  rule_no_information: "I don't have enough information for this guide.",
  rule_psn_literal: "If the context cites PSN identifiers (psn_trophy_id, psn_communication_id), report them LITERALLY without modification.",
  rule_no_cheats: "Do not reference cheats, save editors, exploits that trivialize the experience, or practices that violate PlayStation/Xbox/Steam ToS.",
  rule_markdown: "Output in valid Markdown: titles (##), numbered lists for steps, bold on key names.",
  rule_sources: 'Cite sources at the end as "Sources:" list when context shows headers "--- SOURCE N: ... ---".',
  task: "TASK",
  output_language: "Output language",
  context_verified: "CONTEXT (verified sources)",
  context_scraping: "CONTEXT (live scraping — variable reliability)",
  context_empty: "CONTEXT: (empty — no sources available)",
  user_question: "USER QUESTION",
  h_requirements: "Requirements",
  h_steps: "Steps",
  h_tips: "Tips",
  h_sources: "Sources",
  h_overview: "Overview",
  h_walkthrough: "Detailed walkthrough",
  h_walkthrough_split: "Split by chapters/areas if the context exposes them.",
  h_walkthrough_numbered: "Number critical actions.",
  h_drops: "Items / relevant drops",
  h_collectible_total: "Total count and types",
  h_collectible_locations: "Locations",
  h_collectible_grouped: "Group by area/chapter.",
  h_collectible_landmarks: "For each item indicate coordinates/landmarks if present in context.",
  h_missables: "Missables (if any)",
  h_objective: "Objective",
  h_preparation: "Preparation (recommended build/equip)",
  h_strategy: "Strategy",
  h_strategy_chronological: "Actions in chronological order.",
  h_avoid_errors: "Errors to avoid",
  h_difficulty: "Difficulty and estimated hours",
  h_playthroughs: "Recommended playthroughs",
  h_phase1: "Phase 1 (story) — automatic trophies",
  h_phase2: "Phase 2 (cleanup) — missable, collectible, difficulty",
  h_hardest: "Hardest trophies",
  source_label: "SOURCE",
  trophy_official_name: "OFFICIAL TROPHY NAME (Sony)",
  trophy_official_detail: "OFFICIAL DESCRIPTION",
  psn_anchor_intro: "OFFICIAL PSN IDENTIFIERS (report literally in the response):",
  psn_rarity: "rarity",
};

const LABELS_IT: I18nLabels = {
  intro: 'Sei "Il Platinatore AI", assistente specialistico per guide videoludiche.',
  rule_context_only: "Rispondi SOLO in base al CONTESTO fornito. Se il contesto non contiene la risposta, dichiara esplicitamente \"Non ho informazioni sufficienti per questa guida.\" e NON inventare passaggi, identificativi trofei o sblocchi.",
  rule_no_information: "Non ho informazioni sufficienti per questa guida.",
  rule_psn_literal: "Se il contesto cita identificativi PSN (psn_trophy_id, psn_communication_id), riportali LETTERALMENTE senza modificarli.",
  rule_no_cheats: "Non fare riferimento a cheat, save editor, exploit banalizzanti, o pratiche che violino i ToS PlayStation/Xbox/Steam.",
  rule_markdown: "Output in Markdown valido: titoli (##), liste numerate per step, grassetto sui nomi chiave.",
  rule_sources: 'Cita le fonti in fondo come lista "Fonti:" quando il contesto mostra header "--- FONTE N: ... ---".',
  task: "COMPITO",
  output_language: "Lingua di output",
  context_verified: "CONTESTO (fonti verificate)",
  context_scraping: "CONTESTO (scraping live — affidabilità variabile)",
  context_empty: "CONTESTO: (vuoto — nessuna fonte disponibile)",
  user_question: "DOMANDA UTENTE",
  h_requirements: "Requisiti",
  h_steps: "Passaggi",
  h_tips: "Suggerimenti",
  h_sources: "Fonti",
  h_overview: "Panoramica",
  h_walkthrough: "Walkthrough dettagliata",
  h_walkthrough_split: "Dividi per capitoli/aree se il contesto li espone.",
  h_walkthrough_numbered: "Numera le azioni critiche.",
  h_drops: "Oggetti/Drop rilevanti",
  h_collectible_total: "Numero totale e tipologia",
  h_collectible_locations: "Posizioni",
  h_collectible_grouped: "Raggruppa per area/capitolo.",
  h_collectible_landmarks: "Per ogni oggetto indica coordinate/landmark se presenti nel contesto.",
  h_missables: "Missable (se presenti)",
  h_objective: "Obiettivo",
  h_preparation: "Preparazione (build/equip consigliato)",
  h_strategy: "Strategia",
  h_strategy_chronological: "Azioni in ordine cronologico.",
  h_avoid_errors: "Errori da evitare",
  h_difficulty: "Difficoltà e ore stimate",
  h_playthroughs: "Playthrough consigliati",
  h_phase1: "Fase 1 (storia) — trofei automatici",
  h_phase2: "Fase 2 (cleanup) — missable, collectible, difficoltà",
  h_hardest: "Trofei più ostici",
  source_label: "FONTE",
  trophy_official_name: "NOME UFFICIALE TROFEO (Sony)",
  trophy_official_detail: "DESCRIZIONE UFFICIALE",
  psn_anchor_intro: "IDENTIFICATIVI PSN UFFICIALI (riporta letteralmente nella risposta):",
  psn_rarity: "rarità",
};

const LABELS_ES: I18nLabels = {
  intro: 'Eres "Il Platinatore AI", asistente especializado para guías de videojuegos.',
  rule_context_only: "Responde SÓLO basándote en el CONTEXTO proporcionado. Si el contexto no contiene la respuesta, declara explícitamente \"No tengo información suficiente para esta guía.\" y NO inventes pasos, IDs de trofeos o desbloqueos.",
  rule_no_information: "No tengo información suficiente para esta guía.",
  rule_psn_literal: "Si el contexto cita identificadores PSN (psn_trophy_id, psn_communication_id), reproducírlos LITERALMENTE sin modificarlos.",
  rule_no_cheats: "No hagas referencia a cheats, save editors, exploits que trivialicen el juego, ni prácticas que violen los ToS de PlayStation/Xbox/Steam.",
  rule_markdown: "Salida en Markdown válido: títulos (##), listas numeradas para pasos, negrita en nombres clave.",
  rule_sources: 'Cita las fuentes al final como lista "Fuentes:" cuando el contexto muestra encabezados "--- FUENTE N: ... ---".',
  task: "TAREA",
  output_language: "Idioma de salida",
  context_verified: "CONTEXTO (fuentes verificadas)",
  context_scraping: "CONTEXTO (scraping en vivo — fiabilidad variable)",
  context_empty: "CONTEXTO: (vacío — sin fuentes disponibles)",
  user_question: "PREGUNTA DEL USUARIO",
  h_requirements: "Requisitos",
  h_steps: "Pasos",
  h_tips: "Consejos",
  h_sources: "Fuentes",
  h_overview: "Resumen",
  h_walkthrough: "Guía detallada",
  h_walkthrough_split: "Divide por capítulos/zonas si el contexto los expone.",
  h_walkthrough_numbered: "Numera las acciones críticas.",
  h_drops: "Objetos / drops relevantes",
  h_collectible_total: "Cantidad total y tipos",
  h_collectible_locations: "Ubicaciones",
  h_collectible_grouped: "Agrupa por zona/capítulo.",
  h_collectible_landmarks: "Para cada objeto indica coordenadas/referencias si están en el contexto.",
  h_missables: "Perdibles (si los hay)",
  h_objective: "Objetivo",
  h_preparation: "Preparación (build/equipo recomendado)",
  h_strategy: "Estrategia",
  h_strategy_chronological: "Acciones en orden cronológico.",
  h_avoid_errors: "Errores a evitar",
  h_difficulty: "Dificultad y horas estimadas",
  h_playthroughs: "Playthroughs recomendados",
  h_phase1: "Fase 1 (historia) — trofeos automáticos",
  h_phase2: "Fase 2 (limpieza) — perdibles, coleccionables, dificultad",
  h_hardest: "Trofeos más difíciles",
  source_label: "FUENTE",
  trophy_official_name: "NOMBRE OFICIAL DEL TROFEO (Sony)",
  trophy_official_detail: "DESCRIPCIÓN OFICIAL",
  psn_anchor_intro: "IDENTIFICADORES PSN OFICIALES (reproduce literalmente en la respuesta):",
  psn_rarity: "rareza",
};

const LABELS_FR: I18nLabels = {
  intro: 'Tu es "Il Platinatore AI", assistant spécialisé pour les guides de jeux vidéo.',
  rule_context_only: "Réponds UNIQUEMENT sur la base du CONTEXTE fourni. Si le contexte ne contient pas la réponse, déclare explicitement \"Je n'ai pas assez d'informations pour ce guide.\" et NE PAS inventer d'étapes, d'IDs de trophées ou de déblocages.",
  rule_no_information: "Je n'ai pas assez d'informations pour ce guide.",
  rule_psn_literal: "Si le contexte cite des identifiants PSN (psn_trophy_id, psn_communication_id), reproduis-les LITTÉRALEMENT sans les modifier.",
  rule_no_cheats: "Ne fais pas référence aux cheats, save editors, exploits trivialisants, ni à des pratiques qui violent les ToS PlayStation/Xbox/Steam.",
  rule_markdown: "Sortie en Markdown valide : titres (##), listes numérotées pour les étapes, gras sur les noms clés.",
  rule_sources: 'Cite les sources à la fin comme liste "Sources:" quand le contexte montre des en-têtes "--- SOURCE N: ... ---".',
  task: "TÂCHE",
  output_language: "Langue de sortie",
  context_verified: "CONTEXTE (sources vérifiées)",
  context_scraping: "CONTEXTE (scraping en direct — fiabilité variable)",
  context_empty: "CONTEXTE : (vide — aucune source disponible)",
  user_question: "QUESTION UTILISATEUR",
  h_requirements: "Prérequis",
  h_steps: "Étapes",
  h_tips: "Conseils",
  h_sources: "Sources",
  h_overview: "Aperçu",
  h_walkthrough: "Guide détaillé",
  h_walkthrough_split: "Divise par chapitres/zones si le contexte les expose.",
  h_walkthrough_numbered: "Numérote les actions critiques.",
  h_drops: "Objets / drops pertinents",
  h_collectible_total: "Nombre total et types",
  h_collectible_locations: "Emplacements",
  h_collectible_grouped: "Regroupe par zone/chapitre.",
  h_collectible_landmarks: "Pour chaque objet indique coordonnées/repères si présents dans le contexte.",
  h_missables: "Manquables (s'il y en a)",
  h_objective: "Objectif",
  h_preparation: "Préparation (build/équipement recommandé)",
  h_strategy: "Stratégie",
  h_strategy_chronological: "Actions par ordre chronologique.",
  h_avoid_errors: "Erreurs à éviter",
  h_difficulty: "Difficulté et heures estimées",
  h_playthroughs: "Playthroughs recommandés",
  h_phase1: "Phase 1 (histoire) — trophées automatiques",
  h_phase2: "Phase 2 (cleanup) — manquables, collectibles, difficulté",
  h_hardest: "Trophées les plus difficiles",
  source_label: "SOURCE",
  trophy_official_name: "NOM OFFICIEL DU TROPHÉE (Sony)",
  trophy_official_detail: "DESCRIPTION OFFICIELLE",
  psn_anchor_intro: "IDENTIFIANTS PSN OFFICIELS (reproduis littéralement dans la réponse):",
  psn_rarity: "rareté",
};

const LABELS_DE: I18nLabels = {
  intro: 'Du bist "Il Platinatore AI", ein spezialisierter Assistent für Videospielguides.',
  rule_context_only: "Antworte AUSSCHLIESSLICH basierend auf dem bereitgestellten KONTEXT. Wenn der Kontext keine Antwort enthält, gib explizit \"Ich habe nicht genug Informationen für diese Anleitung.\" an und ERFINDE KEINE Schritte, Trophäen-IDs oder Freischaltungen.",
  rule_no_information: "Ich habe nicht genug Informationen für diese Anleitung.",
  rule_psn_literal: "Wenn der Kontext PSN-Identifikatoren (psn_trophy_id, psn_communication_id) zitiert, gib sie WÖRTLICH ohne Änderung wieder.",
  rule_no_cheats: "Verweise nicht auf Cheats, Save Editors, trivialisierende Exploits oder Praktiken, die die PlayStation/Xbox/Steam ToS verletzen.",
  rule_markdown: "Ausgabe in gültigem Markdown: Titel (##), nummerierte Listen für Schritte, fett auf Schlüsselnamen.",
  rule_sources: 'Zitiere Quellen am Ende als "Quellen:"-Liste wenn der Kontext Header "--- QUELLE N: ... ---" zeigt.',
  task: "AUFGABE",
  output_language: "Ausgabesprache",
  context_verified: "KONTEXT (verifizierte Quellen)",
  context_scraping: "KONTEXT (Live-Scraping — variable Zuverlässigkeit)",
  context_empty: "KONTEXT: (leer — keine Quellen verfügbar)",
  user_question: "BENUTZERFRAGE",
  h_requirements: "Voraussetzungen",
  h_steps: "Schritte",
  h_tips: "Tipps",
  h_sources: "Quellen",
  h_overview: "Übersicht",
  h_walkthrough: "Detaillierter Walkthrough",
  h_walkthrough_split: "Teile nach Kapiteln/Bereichen wenn der Kontext sie zeigt.",
  h_walkthrough_numbered: "Nummeriere kritische Aktionen.",
  h_drops: "Gegenstände / relevante Drops",
  h_collectible_total: "Gesamtanzahl und Typen",
  h_collectible_locations: "Orte",
  h_collectible_grouped: "Gruppiere nach Bereich/Kapitel.",
  h_collectible_landmarks: "Gib für jedes Element Koordinaten/Wahrzeichen an wenn im Kontext vorhanden.",
  h_missables: "Verpassbar (falls vorhanden)",
  h_objective: "Ziel",
  h_preparation: "Vorbereitung (empfohlener Build/Ausrüstung)",
  h_strategy: "Strategie",
  h_strategy_chronological: "Aktionen in chronologischer Reihenfolge.",
  h_avoid_errors: "Zu vermeidende Fehler",
  h_difficulty: "Schwierigkeit und geschätzte Stunden",
  h_playthroughs: "Empfohlene Playthroughs",
  h_phase1: "Phase 1 (Story) — automatische Trophäen",
  h_phase2: "Phase 2 (Cleanup) — Missables, Collectibles, Schwierigkeit",
  h_hardest: "Schwierigste Trophäen",
  source_label: "QUELLE",
  trophy_official_name: "OFFIZIELLER TROPHÄENNAME (Sony)",
  trophy_official_detail: "OFFIZIELLE BESCHREIBUNG",
  psn_anchor_intro: "OFFIZIELLE PSN-IDENTIFIKATOREN (wörtlich in der Antwort wiedergeben):",
  psn_rarity: "Seltenheit",
};

const LABELS_PT: I18nLabels = {
  intro: 'Você é "Il Platinatore AI", assistente especializado para guias de videogames.',
  rule_context_only: "Responda APENAS com base no CONTEXTO fornecido. Se o contexto não contém a resposta, declare explicitamente \"Não tenho informações suficientes para este guia.\" e NÃO invente passos, IDs de troféus ou desbloqueios.",
  rule_no_information: "Não tenho informações suficientes para este guia.",
  rule_psn_literal: "Se o contexto cita identificadores PSN (psn_trophy_id, psn_communication_id), reproduza-os LITERALMENTE sem modificá-los.",
  rule_no_cheats: "Não faça referência a cheats, save editors, exploits trivializantes, nem práticas que violem os ToS de PlayStation/Xbox/Steam.",
  rule_markdown: "Saída em Markdown válido: títulos (##), listas numeradas para passos, negrito em nomes-chave.",
  rule_sources: 'Cite fontes ao final como lista "Fontes:" quando o contexto mostra cabeçalhos "--- FONTE N: ... ---".',
  task: "TAREFA",
  output_language: "Idioma de saída",
  context_verified: "CONTEXTO (fontes verificadas)",
  context_scraping: "CONTEXTO (scraping ao vivo — confiabilidade variável)",
  context_empty: "CONTEXTO: (vazio — nenhuma fonte disponível)",
  user_question: "PERGUNTA DO USUÁRIO",
  h_requirements: "Requisitos",
  h_steps: "Passos",
  h_tips: "Dicas",
  h_sources: "Fontes",
  h_overview: "Visão geral",
  h_walkthrough: "Guia detalhado",
  h_walkthrough_split: "Divida por capítulos/áreas se o contexto os expõe.",
  h_walkthrough_numbered: "Numere as ações críticas.",
  h_drops: "Itens / drops relevantes",
  h_collectible_total: "Quantidade total e tipos",
  h_collectible_locations: "Localizações",
  h_collectible_grouped: "Agrupe por área/capítulo.",
  h_collectible_landmarks: "Para cada item indique coordenadas/marcos se presentes no contexto.",
  h_missables: "Missables (se houver)",
  h_objective: "Objetivo",
  h_preparation: "Preparação (build/equipamento recomendado)",
  h_strategy: "Estratégia",
  h_strategy_chronological: "Ações em ordem cronológica.",
  h_avoid_errors: "Erros a evitar",
  h_difficulty: "Dificuldade e horas estimadas",
  h_playthroughs: "Playthroughs recomendados",
  h_phase1: "Fase 1 (história) — troféus automáticos",
  h_phase2: "Fase 2 (limpeza) — missables, colecionáveis, dificuldade",
  h_hardest: "Troféus mais difíceis",
  source_label: "FONTE",
  trophy_official_name: "NOME OFICIAL DO TROFÉU (Sony)",
  trophy_official_detail: "DESCRIÇÃO OFICIAL",
  psn_anchor_intro: "IDENTIFICADORES PSN OFICIAIS (reproduza literalmente na resposta):",
  psn_rarity: "raridade",
};

const LABELS_JA: I18nLabels = {
  intro: 'あなたは「Il Platinatore AI」、ビデオゲーム攻略ガイドの専門アシスタントです。',
  rule_context_only: "提供された「コンテキスト」のみに基づいて回答してください。コンテキストに答えがない場合は、明示的に「このガイドに十分な情報がありません。」と述べ、手順、トロフィーID、アンロックを発明しないでください。",
  rule_no_information: "このガイドに十分な情報がありません。",
  rule_psn_literal: "コンテキストがPSN識別子（psn_trophy_id、psn_communication_id）を引用する場合は、変更せずに文字通り再現してください。",
  rule_no_cheats: "チート、セーブエディター、ゲームを単純化するエクスプロイト、またはPlayStation/Xbox/Steam ToSに違反する行為を参照しないでください。",
  rule_markdown: "有効なMarkdownで出力：タイトル（##）、ステップの番号付きリスト、キー名は太字。",
  rule_sources: 'コンテキストにヘッダー「--- 出典 N: ... ---」が表示されている場合、最後に「出典:」リストとして引用してください。',
  task: "タスク",
  output_language: "出力言語",
  context_verified: "コンテキスト（検証済みソース）",
  context_scraping: "コンテキスト（ライブスクレイピング — 信頼性は可変）",
  context_empty: "コンテキスト：（空 — 利用可能なソースなし）",
  user_question: "ユーザーの質問",
  h_requirements: "要件",
  h_steps: "手順",
  h_tips: "ヒント",
  h_sources: "出典",
  h_overview: "概要",
  h_walkthrough: "詳細な攻略",
  h_walkthrough_split: "コンテキストが提示する場合、章/エリアごとに分割してください。",
  h_walkthrough_numbered: "重要なアクションには番号を付けてください。",
  h_drops: "アイテム / 関連ドロップ",
  h_collectible_total: "総数とタイプ",
  h_collectible_locations: "場所",
  h_collectible_grouped: "エリア/章ごとにグループ化してください。",
  h_collectible_landmarks: "各アイテムについて、コンテキストに座標/ランドマークが存在する場合は記載してください。",
  h_missables: "ミッサブル（ある場合）",
  h_objective: "目的",
  h_preparation: "準備（推奨ビルド/装備）",
  h_strategy: "戦略",
  h_strategy_chronological: "時系列順のアクション。",
  h_avoid_errors: "回避すべきエラー",
  h_difficulty: "難易度と推定時間",
  h_playthroughs: "推奨プレイスルー",
  h_phase1: "フェーズ1（ストーリー） — 自動トロフィー",
  h_phase2: "フェーズ2（クリーンアップ） — ミッサブル、コレクティブル、難易度",
  h_hardest: "最も難しいトロフィー",
  source_label: "出典",
  trophy_official_name: "公式トロフィー名（Sony）",
  trophy_official_detail: "公式説明",
  psn_anchor_intro: "公式PSN識別子（応答で文字通り報告してください）：",
  psn_rarity: "レアリティ",
};

const LABELS_ZH: I18nLabels = {
  intro: '你是"Il Platinatore AI"，电子游戏攻略指南专业助手。',
  rule_context_only: "仅基于提供的「上下文」回答。如果上下文不包含答案，明确声明「我没有足够的信息来回答这个指南。」，不要编造步骤、奖杯ID或解锁。",
  rule_no_information: "我没有足够的信息来回答这个指南。",
  rule_psn_literal: "如果上下文引用PSN标识符（psn_trophy_id、psn_communication_id），原样转载不要修改。",
  rule_no_cheats: "不要引用作弊、存档编辑器、简化游戏的漏洞，或违反PlayStation/Xbox/Steam ToS的做法。",
  rule_markdown: "以有效的Markdown输出：标题（##）、步骤编号列表、关键名称加粗。",
  rule_sources: '当上下文显示标题「--- 来源 N: ... ---」时，在末尾以「来源：」列表引用源。',
  task: "任务",
  output_language: "输出语言",
  context_verified: "上下文（已验证来源）",
  context_scraping: "上下文（实时抓取 — 可靠性可变）",
  context_empty: "上下文：（空 — 没有可用来源）",
  user_question: "用户问题",
  h_requirements: "要求",
  h_steps: "步骤",
  h_tips: "提示",
  h_sources: "来源",
  h_overview: "概述",
  h_walkthrough: "详细攻略",
  h_walkthrough_split: "如果上下文显示，按章节/区域划分。",
  h_walkthrough_numbered: "对关键动作编号。",
  h_drops: "物品/相关掉落",
  h_collectible_total: "总数量和类型",
  h_collectible_locations: "位置",
  h_collectible_grouped: "按区域/章节分组。",
  h_collectible_landmarks: "如果上下文中有坐标/地标，为每个项目指出。",
  h_missables: "可错过的（如有）",
  h_objective: "目标",
  h_preparation: "准备（推荐配装/装备）",
  h_strategy: "策略",
  h_strategy_chronological: "按时间顺序的行动。",
  h_avoid_errors: "要避免的错误",
  h_difficulty: "难度和预估时间",
  h_playthroughs: "推荐通关",
  h_phase1: "阶段1（剧情） — 自动奖杯",
  h_phase2: "阶段2（清理） — 可错过、收藏品、难度",
  h_hardest: "最难的奖杯",
  source_label: "来源",
  trophy_official_name: "奖杯官方名称（Sony）",
  trophy_official_detail: "官方描述",
  psn_anchor_intro: "官方PSN标识符（在响应中原样报告）：",
  psn_rarity: "稀有度",
};

const LABELS_RU: I18nLabels = {
  intro: 'Ты "Il Platinatore AI", специализированный ассистент для игровых руководств.',
  rule_context_only: "Отвечай ТОЛЬКО на основе предоставленного КОНТЕКСТА. Если контекст не содержит ответа, явно укажи \"У меня недостаточно информации для этого руководства.\" и НЕ выдумывай шаги, ID трофеев или разблокировки.",
  rule_no_information: "У меня недостаточно информации для этого руководства.",
  rule_psn_literal: "Если контекст цитирует PSN идентификаторы (psn_trophy_id, psn_communication_id), воспроизводи их БУКВАЛЬНО без изменений.",
  rule_no_cheats: "Не ссылайся на читы, редакторы сохранений, эксплойты упрощающие игру, или практики нарушающие ToS PlayStation/Xbox/Steam.",
  rule_markdown: "Вывод в валидном Markdown: заголовки (##), нумерованные списки для шагов, жирный для ключевых названий.",
  rule_sources: 'Цитируй источники в конце как список "Источники:" когда контекст показывает заголовки "--- ИСТОЧНИК N: ... ---".',
  task: "ЗАДАЧА",
  output_language: "Язык вывода",
  context_verified: "КОНТЕКСТ (проверенные источники)",
  context_scraping: "КОНТЕКСТ (живой скрапинг — переменная надёжность)",
  context_empty: "КОНТЕКСТ: (пусто — источники недоступны)",
  user_question: "ВОПРОС ПОЛЬЗОВАТЕЛЯ",
  h_requirements: "Требования",
  h_steps: "Шаги",
  h_tips: "Советы",
  h_sources: "Источники",
  h_overview: "Обзор",
  h_walkthrough: "Детальное прохождение",
  h_walkthrough_split: "Раздели по главам/областям если контекст их показывает.",
  h_walkthrough_numbered: "Пронумеруй критические действия.",
  h_drops: "Предметы / релевантные дропы",
  h_collectible_total: "Общее количество и типы",
  h_collectible_locations: "Локации",
  h_collectible_grouped: "Группируй по области/главе.",
  h_collectible_landmarks: "Для каждого предмета укажи координаты/ориентиры если присутствуют в контексте.",
  h_missables: "Пропускаемые (если есть)",
  h_objective: "Цель",
  h_preparation: "Подготовка (рекомендуемый билд/экипировка)",
  h_strategy: "Стратегия",
  h_strategy_chronological: "Действия в хронологическом порядке.",
  h_avoid_errors: "Ошибки которых избегать",
  h_difficulty: "Сложность и оценочные часы",
  h_playthroughs: "Рекомендуемые прохождения",
  h_phase1: "Фаза 1 (сюжет) — автоматические трофеи",
  h_phase2: "Фаза 2 (зачистка) — пропускаемые, коллекционные, сложность",
  h_hardest: "Самые трудные трофеи",
  source_label: "ИСТОЧНИК",
  trophy_official_name: "ОФИЦИАЛЬНОЕ НАЗВАНИЕ ТРОФЕЯ (Sony)",
  trophy_official_detail: "ОФИЦИАЛЬНОЕ ОПИСАНИЕ",
  psn_anchor_intro: "ОФИЦИАЛЬНЫЕ PSN ИДЕНТИФИКАТОРЫ (воспроизведи буквально в ответе):",
  psn_rarity: "редкость",
};

const HEADERS_I18N: Record<string, I18nLabels> = {
  en: LABELS_EN,
  it: LABELS_IT,
  es: LABELS_ES,
  fr: LABELS_FR,
  de: LABELS_DE,
  pt: LABELS_PT,
  ja: LABELS_JA,
  zh: LABELS_ZH,
  ru: LABELS_RU,
};

/** Risolve i label per la lingua. Fallback EN per lingue non Tier 1. */
function getLabels(language: string): I18nLabels {
  return HEADERS_I18N[language] ?? LABELS_EN;
}

/** Mappa ISO-639-1 → nome leggibile per istruzione "Output language: X" al LLM. */
const LANG_NAME_FOR_LLM: Record<string, string> = {
  en: "English",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ja: "Japanese",
  zh: "Chinese (Simplified)",
  ru: "Russian",
};

function llmLanguageName(language: string): string {
  return LANG_NAME_FOR_LLM[language] ?? "English";
}

// ── Builder ─────────────────────────────────────────────────────────────────

// T3.3 — KF-2 Inline citations rule. Aggiunto come 6° rule nel SYSTEM_CORE
// per istruire il LLM a taggare ogni claim con [N] referente alla FONTE N.
// Universal English (LLM-side) per uniformità di interpretazione cross-lingua.
const RULE_INLINE_CITATIONS =
  "Tag every factual claim or step with inline citations like [1], [2] referring to the corresponding '--- SOURCE N: ... ---' header in the CONTEXT. If a claim cannot be attributed to any source, leave it untagged. Multiple citations: [1][2].";

function buildSystemCore(
  L: I18nLabels,
  previousTurns?: PromptContext["previousTurns"],
): string {
  const history = formatConversationHistory(previousTurns);
  return `${L.intro}

REGOLE INVARIANTI / INVARIANT RULES:
1. ${L.rule_context_only}
2. ${L.rule_psn_literal}
3. ${L.rule_no_cheats}
4. ${L.rule_markdown}
5. ${L.rule_sources}
6. ${RULE_INLINE_CITATIONS}${history}`;
}

function formatPsnAnchor(a: PsnAnchor | undefined, L: I18nLabels): string {
  if (!a) return "";
  const parts: string[] = [];
  if (a.psn_trophy_id) parts.push(`psn_trophy_id: ${a.psn_trophy_id}`);
  if (a.psn_communication_id) parts.push(`psn_communication_id: ${a.psn_communication_id}`);
  if (a.rarity_source) parts.push(`${L.psn_rarity}: ${a.rarity_source}`);
  if (parts.length === 0) return "";
  return `\n\n${L.psn_anchor_intro}\n- ${parts.join("\n- ")}`;
}

function formatPsnOfficial(o: PsnOfficial | undefined, L: I18nLabels): string {
  if (!o?.officialName) return "";
  const lines = [`${L.trophy_official_name}: ${o.officialName}`];
  if (o.officialDetail) lines.push(`${L.trophy_official_detail}: ${o.officialDetail}`);
  return `${lines.join("\n")}\n\n`;
}

function assembleUserContext(ctx: PromptContext, L: I18nLabels): string {
  const primary = ctx.ragContext.trim();
  const fallback = ctx.scrapingContext?.trim() ?? "";
  if (primary) return `${L.context_verified}:\n\n${primary}`;
  if (fallback) return `${L.context_scraping}:\n\n${fallback}`;
  return L.context_empty;
}

/**
 * T3.1 — formatta i turn precedenti come "Conversation history:" prepended
 * al SYSTEM. Universal English (LLM-side) per uniformità cross-lingua —
 * il modello capisce comunque, e centralizza la struttura.
 */
function formatConversationHistory(
  previousTurns: PromptContext["previousTurns"],
): string {
  if (!previousTurns || previousTurns.length === 0) return "";
  const lines = previousTurns.map((t) => {
    const tag = t.role === "user" ? "User" : "Assistant";
    return `${tag}: ${t.text}`;
  });
  return `\n\nConversation history (latest first ${previousTurns.length} turns):\n${lines.join("\n\n")}`;
}

// ── Template per guide_type ─────────────────────────────────────────────────

function buildTrophy(ctx: PromptContext): BuiltPrompt {
  const L = getLabels(ctx.language);
  const langName = llmLanguageName(ctx.language);
  const anchor = formatPsnAnchor(ctx.psnAnchor, L);
  const official = formatPsnOfficial(ctx.psnOfficial, L);
  const system = `${buildSystemCore(L, ctx.previousTurns)}

${L.task}: produce a guide for the trophy "${ctx.targetName}" of the game "${ctx.gameTitle}".
${L.output_language}: ${langName}.
Required structure:
  ## ${L.h_requirements}
  ## ${L.h_steps}
  1. ...
  ## ${L.h_tips}
  ## ${L.h_sources}${anchor}`;
  const user = `${official}${assembleUserContext(ctx, L)}

${L.user_question}: ${ctx.userQuery}`;
  return { system, user, templateId: "trophy" };
}

function buildWalkthrough(ctx: PromptContext): BuiltPrompt {
  const L = getLabels(ctx.language);
  const langName = llmLanguageName(ctx.language);
  const system = `${buildSystemCore(L, ctx.previousTurns)}

${L.task}: produce a walkthrough for "${ctx.targetName}" in "${ctx.gameTitle}".
${L.output_language}: ${langName}.
Required structure:
  ## ${L.h_overview}
  ## ${L.h_walkthrough}
  - ${L.h_walkthrough_split}
  - ${L.h_walkthrough_numbered}
  ## ${L.h_drops}
  ## ${L.h_sources}`;
  const user = `${assembleUserContext(ctx, L)}

${L.user_question}: ${ctx.userQuery}`;
  return { system, user, templateId: "walkthrough" };
}

function buildCollectible(ctx: PromptContext): BuiltPrompt {
  const L = getLabels(ctx.language);
  const langName = llmLanguageName(ctx.language);
  const system = `${buildSystemCore(L, ctx.previousTurns)}

${L.task}: collectible guide "${ctx.targetName}" in "${ctx.gameTitle}".
${L.output_language}: ${langName}.
Required structure:
  ## ${L.h_collectible_total}
  ## ${L.h_collectible_locations}
  - ${L.h_collectible_grouped}
  - ${L.h_collectible_landmarks}
  ## ${L.h_missables}
  ## ${L.h_sources}`;
  const user = `${assembleUserContext(ctx, L)}

${L.user_question}: ${ctx.userQuery}`;
  return { system, user, templateId: "collectible" };
}

function buildChallenge(ctx: PromptContext): BuiltPrompt {
  const L = getLabels(ctx.language);
  const langName = llmLanguageName(ctx.language);
  const system = `${buildSystemCore(L, ctx.previousTurns)}

${L.task}: explain how to complete the challenge "${ctx.targetName}" in "${ctx.gameTitle}".
${L.output_language}: ${langName}.
Required structure:
  ## ${L.h_objective}
  ## ${L.h_preparation}
  ## ${L.h_strategy}
  1. ${L.h_strategy_chronological}
  ## ${L.h_avoid_errors}
  ## ${L.h_sources}`;
  const user = `${assembleUserContext(ctx, L)}

${L.user_question}: ${ctx.userQuery}`;
  return { system, user, templateId: "challenge" };
}

function buildPlatinum(ctx: PromptContext): BuiltPrompt {
  const L = getLabels(ctx.language);
  const langName = llmLanguageName(ctx.language);
  const system = `${buildSystemCore(L, ctx.previousTurns)}

${L.task}: produce the platinum roadmap for "${ctx.gameTitle}".
${L.output_language}: ${langName}.
Required structure:
  ## ${L.h_difficulty}
  ## ${L.h_playthroughs}
  ## ${L.h_phase1}
  ## ${L.h_phase2}
  ## ${L.h_hardest}
  ## ${L.h_sources}`;
  const user = `${assembleUserContext(ctx, L)}

${L.user_question}: ${ctx.userQuery}`;
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
 * Sanitizza la query utente prima di iniettarla nel prompt LLM.
 * Previene: newline injection, HTML, pattern classici di prompt injection.
 * Non lancia mai — le query che non passano la validazione Zod non arrivano qui.
 */
export function sanitizeUserQuery(query: string): string {
  let q = query;
  // HTML/XML tags
  q = q.replace(/<[^>]{0,200}>/g, "");
  // Normalizza newline e tab a spazio (previene iniezione di blocchi SYSTEM/USER)
  q = q.replace(/[\r\n\t]+/g, " ");
  // Caratteri di controllo
  q = q.replace(/[\x00-\x1f\x7f]/g, "");
  // Pattern di prompt injection classici
  q = q.replace(
    /\b(ignore\s+(all\s+)?previous\s+instructions?|you\s+are\s+now|act\s+as\b|new\s+system\s+prompt|forget\s+(all\s+)?instructions?|system\s*:)/gi,
    " ",
  );
  return q.replace(/\s{2,}/g, " ").trim().slice(0, 500);
}

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
  const safeCtx: PromptContext = { ...ctx, userQuery: sanitizeUserQuery(ctx.userQuery) };
  return builder(safeCtx);
}

/** Esposto per test. */
export const __i18n = { HEADERS_I18N, getLabels, llmLanguageName };
