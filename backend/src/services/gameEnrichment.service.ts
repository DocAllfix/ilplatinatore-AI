/**
 * GameEnrichment Service — risolve o crea il gioco mancante per una bozza.
 *
 * Chiamato da ingestApprovedDraft() quando draft.game_id === null.
 * Tre path in ordine di preferenza:
 *   1. Riusa gioco esistente in DB (pg_trgm similarity > 0.8)
 *   2. Crea gioco da dati IGDB (ricco: cover, piattaforme, igdb_id)
 *   3. Fallback minimal (solo title + slug, senza enrichment)
 *
 * Dopo la creazione, aggiorna draft.game_id via GuideDraftsModel.linkGame().
 * Opzionalmente triggera on-demand harvest per i trofei del nuovo gioco.
 */

import { GamesModel, type GameRow } from "@/models/games.model.js";
import { GuideDraftsModel } from "@/models/guideDrafts.model.js";
import { IgdbClient } from "@/services/igdb.client.js";
import { OnDemandHarvestService } from "@/services/onDemandHarvest.service.js";
import { slugify } from "@/services/guide.cache.js";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

export interface GameEnrichmentResult {
  game: GameRow;
  source: "existing" | "igdb" | "minimal";
}

/**
 * Cerca o crea il gioco indicato nel gameTitle, poi lo collega alla bozza.
 *
 * @param draftId  UUID della bozza da aggiornare
 * @param gameTitle  Titolo del gioco da cercare (da search_metadata.gameTitle)
 */
export async function resolveOrCreateGame(
  draftId: string,
  gameTitle: string,
): Promise<GameEnrichmentResult> {
  const cleanTitle = gameTitle.trim();
  if (!cleanTitle) throw new Error("resolveOrCreateGame: gameTitle vuoto");

  // ── 1. Cerca nel DB esistente ───────────────────────────────────────────
  const dbResults = await GamesModel.searchWithScores(cleanTitle, 1);
  if (dbResults.length > 0 && dbResults[0]!.similarity > 0.8) {
    const game = dbResults[0]!.game;
    await _linkGame(draftId, game.id, "existing");
    return { game, source: "existing" };
  }

  // ── 2. Cerca su IGDB ────────────────────────────────────────────────────
  const igdbResults = await IgdbClient.searchByTitle(cleanTitle, 3);
  if (igdbResults.length > 0) {
    const best = igdbResults[0]!;

    // Controlla se igdb_id già esiste (race condition tra admin concorrenti).
    const existing = await GamesModel.findByIgdbId(best.igdb_id);
    if (existing) {
      await _linkGame(draftId, existing.id, "igdb");
      return { game: existing, source: "igdb" };
    }

    const game = await GamesModel.create({
      title:        best.title,
      slug:         best.slug || _safeSlug(best.title),
      platform:     best.platforms,
      release_date: best.release_date,
      genre:        best.genre,
      cover_url:    best.cover_url,
      igdb_id:      best.igdb_id,
      auto_created: true,
    });

    logger.info(
      { draftId, gameId: game.id, igdb_id: best.igdb_id, title: game.title },
      "gameEnrichment: gioco creato da IGDB",
    );

    await _linkGame(draftId, game.id, "igdb");
    _triggerHarvestIfEnabled(cleanTitle, game.id);
    return { game, source: "igdb" };
  }

  // ── 3. Fallback minimal ─────────────────────────────────────────────────
  const slug = _safeSlug(cleanTitle);
  const game = await GamesModel.create({
    title:        cleanTitle,
    slug,
    auto_created: true,
  });

  logger.warn(
    { draftId, gameId: game.id, title: cleanTitle },
    "gameEnrichment: gioco creato con dati minimi (IGDB non trovato)",
  );

  await _linkGame(draftId, game.id, "minimal");
  return { game, source: "minimal" };
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function _linkGame(
  draftId: string,
  gameId: number,
  source: string,
): Promise<void> {
  const linked = await GuideDraftsModel.linkGame(draftId, gameId);
  if (!linked) {
    // La bozza aveva già un game_id (collegato manualmente nel frattempo).
    // Non è un errore — loggiamo e proseguiamo.
    logger.info(
      { draftId, gameId, source },
      "gameEnrichment: bozza già collegata (linkGame no-op)",
    );
  }
}

function _safeSlug(title: string): string {
  const base = slugify(title);
  // Se slugify produce stringa vuota (titolo non-ASCII), usiamo suffix timestamp.
  return base || `game-${Date.now().toString(36).slice(-6)}`;
}

function _triggerHarvestIfEnabled(gameTitle: string, gameId: number): void {
  if (!env.ON_DEMAND_HARVEST_ENABLED) return;
  OnDemandHarvestService.triggerHarvest(gameTitle, null, gameId).catch((err) => {
    logger.warn({ err, gameId }, "gameEnrichment: harvest trigger fallito (non-fatal)");
  });
}
