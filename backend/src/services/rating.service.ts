import { redis } from "@/config/redis.js";
import { logger } from "@/utils/logger.js";
import { RatingsModel } from "@/models/ratings.model.js";
import { GuidesModel } from "@/models/guides.model.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

/**
 * Fase 17 — Rating + promozione guide.
 *   submitRating        → upsert voto (user o session) + trigger promozione
 *   checkAndPromoteGuide → decisione su live stats + REFRESH view throttled
 *   getGuideRatings     → lettura live da guide_ratings (no view stale)
 *
 * Design (post-smoke-test):
 *   Decisione promozione e GET pubblico leggono via RatingsModel.getLiveStats
 *   (COUNT/AVG diretto con idx_ratings_guide, <1ms). La materialized view
 *   `guide_rating_summary` + REFRESH throttled (SET NX EX 60s) restano per
 *   consumer batch/dashboard futuri — idempotenti, costo trascurabile.
 *
 *   Throttle atomico via SET NX EX: il primo thread vince, gli altri skippano
 *   il REFRESH anche sotto burst concorrente (verificato live con 5 paralleli).
 */

const REFRESH_THROTTLE_SECONDS = 60;
const PROMOTE_MIN_RATINGS = 3;
const PROMOTE_MIN_AVG = 3.5;
const LOW_RATING_THRESHOLD = 2.5;

export interface SubmitRatingInput {
  guideId: number;
  userId?: number | null;
  sessionId?: string | null;
  stars: number;
  suggestion?: string;
  language?: string;
}

export interface PublicRatingSummary {
  avgStars: number;
  totalRatings: number;
  totalSuggestions: number;
}

export const RatingService = {
  async submitRating(input: SubmitRatingInput): Promise<{ promoted: boolean }> {
    // ── Validazione input ────────────────────────────────────────────────
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw new ValidationError("stars deve essere un intero tra 1 e 5");
    }
    if (input.userId == null && !input.sessionId) {
      throw new ValidationError("userId o sessionId richiesto per votare");
    }

    const guide = await GuidesModel.findById(input.guideId);
    if (!guide) throw new NotFoundError(`Guida ${input.guideId} non esiste`);

    // ── Upsert voto (branch user vs anonymous) ───────────────────────────
    try {
      if (input.userId != null) {
        await RatingsModel.createUserRating({
          guide_id: input.guideId,
          user_id: input.userId,
          stars: input.stars,
          suggestion: input.suggestion ?? null,
          language: input.language ?? null,
        });
      } else {
        await RatingsModel.createSessionRating({
          guide_id: input.guideId,
          session_id: input.sessionId as string,
          stars: input.stars,
          suggestion: input.suggestion ?? null,
          language: input.language ?? null,
        });
      }
    } catch (err) {
      logger.error(
        { err, guideId: input.guideId },
        "RatingService.submitRating: upsert rating fallito",
      );
      throw err;
    }

    // ── Trigger promozione (non-fatal: errori loggati, non bloccano) ─────
    let promoted = false;
    try {
      promoted = await RatingService.checkAndPromoteGuide(input.guideId);
    } catch (err) {
      logger.error(
        { err, guideId: input.guideId },
        "RatingService.submitRating: checkAndPromoteGuide fallito (non-fatal)",
      );
    }
    return { promoted };
  },

  async checkAndPromoteGuide(guideId: number): Promise<boolean> {
    // ── Throttle REFRESH MATERIALIZED VIEW (max 1/min per guideId) ───────
    // Lock atomico via SET NX EX: vince il primo thread, gli altri saltano
    // il REFRESH anche sotto burst concorrente (single-replica o future N).
    // Se il lock è già tenuto, la view può essere stale fino a 60s: il voto
    // appena inserito sarà visibile al prossimo ciclo di REFRESH oltre finestra.
    const flagKey = `rating_refresh_last:${guideId}`;
    try {
      const locked = await redis.set(
        flagKey,
        "1",
        "EX",
        REFRESH_THROTTLE_SECONDS,
        "NX",
      );
      if (locked === "OK") {
        await RatingsModel.refreshSummary();
      }
    } catch (err) {
      logger.warn(
        { err, guideId },
        "RatingService.checkAndPromoteGuide: refresh throttle fallito (non-fatal)",
      );
    }

    // ── Fetch live stats + stato guida ───────────────────────────────────
    // getLiveStats: dati freschi dal table (no view stale), sempre ritorna
    // una row (total_ratings=0 se nessun voto). Le soglie gestiscono il caso 0.
    const summary = await RatingsModel.getLiveStats(guideId);
    const guide = await GuidesModel.findById(guideId);
    if (!guide) return false;

    // ── Soglia promozione (avg≥3.5 · ratings≥3 · non già verified) ───────
    if (
      summary.avg_stars >= PROMOTE_MIN_AVG &&
      summary.total_ratings >= PROMOTE_MIN_RATINGS &&
      !guide.verified
    ) {
      await GuidesModel.markAsVerified(guideId);
      logger.info(
        { guideId, avgStars: summary.avg_stars, totalRatings: summary.total_ratings },
        `Guida ${guideId} promossa a verificata (avg: ${summary.avg_stars}, ratings: ${summary.total_ratings})`,
      );
      return true;
    }

    // ── Soglia low-quality (avg<2.5 · ratings≥3) → warning log ───────────
    // Flag needs_regeneration in metadata JSONB: rimandato (model non ha
    // updateMetadata generico, aggiungere in Fase 17.1 se richiesto).
    if (
      summary.avg_stars < LOW_RATING_THRESHOLD &&
      summary.total_ratings >= PROMOTE_MIN_RATINGS
    ) {
      logger.warn(
        { guideId, avgStars: summary.avg_stars, totalRatings: summary.total_ratings },
        `Guida ${guideId} ha rating basso (${summary.avg_stars}) — considerare rigenerazione`,
      );
    }

    return false;
  },

  async getGuideRatings(guideId: number): Promise<PublicRatingSummary> {
    const guide = await GuidesModel.findById(guideId);
    if (!guide) throw new NotFoundError(`Guida ${guideId} non esiste`);

    // Live stats: il client vede il proprio voto riflesso immediatamente
    // (niente attesa della finestra di 60s del REFRESH).
    const summary = await RatingsModel.getLiveStats(guideId);
    return {
      avgStars: summary.avg_stars,
      totalRatings: summary.total_ratings,
      totalSuggestions: summary.total_suggestions,
    };
  },
};
