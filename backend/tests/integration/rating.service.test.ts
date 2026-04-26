/**
 * Test di integrazione per RatingService — database + Redis reali.
 * Copre: submitRating (user/session), upsert deduplication, auto-promozione,
 * getGuideRatings, errori (guida assente, stars invalide).
 *
 * Prerequisiti: docker-compose con postgres + redis avviati,
 * `platinatore_test` creato dalla globalSetup in setup.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { RatingService } from "@/services/rating.service.js";
import { pool, query } from "@/config/database.js";
import { redis } from "@/config/redis.js";
import { NotFoundError, ValidationError } from "@/utils/errors.js";

// ── Seed ─────────────────────────────────────────────────────────────────────

let gameId: number;
let guideId: number;
let sessionId: string;

beforeAll(async () => {
  // Inserisce un gioco di test.
  const gameRes = await query<{ id: number }>(
    `INSERT INTO games (title, slug)
     VALUES ('Test Game Integration', 'test-game-integration-${Date.now()}')
     RETURNING id`,
  );
  gameId = gameRes.rows[0]!.id;

  // Inserisce una guida di test.
  const guideRes = await query<{ id: number }>(
    `INSERT INTO guides (game_id, title, slug, content, language, source)
     VALUES ($1, 'Guida Test', $2, 'Contenuto guida di test.', 'it', 'chatbot')
     RETURNING id`,
    [gameId, `guida-test-${Date.now()}`],
  );
  guideId = guideRes.rows[0]!.id;

  // Crea una sessione anonima di test.
  const sessionRes = await query<{ id: string }>(
    `INSERT INTO sessions DEFAULT VALUES RETURNING id`,
  );
  sessionId = sessionRes.rows[0]!.id;
});

afterAll(async () => {
  // Elimina i dati di test in ordine inverso (FK constraints).
  await query(`DELETE FROM guide_ratings WHERE guide_id = $1`, [guideId]);
  await query(`DELETE FROM guides WHERE id = $1`, [guideId]);
  await query(`DELETE FROM games WHERE id = $1`, [gameId]);
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  await pool.end();
  await redis.quit();
});

// Pulisce i voti prima di ogni test per avere uno stato noto.
beforeEach(async () => {
  await query(`DELETE FROM guide_ratings WHERE guide_id = $1`, [guideId]);
  // Reset verified → false per i test di promozione.
  await query(`UPDATE guides SET verified = false WHERE id = $1`, [guideId]);
  // Rimuovi eventuali throttle keys Redis del test.
  await redis.del(`rating_refresh_last:${guideId}`);
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("RatingService.submitRating — sessione anonima", () => {
  it("aggiunge un voto e restituisce { promoted: false } sotto soglia", async () => {
    const result = await RatingService.submitRating({
      guideId,
      sessionId,
      stars: 4,
    });
    expect(result.promoted).toBe(false);

    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalRatings).toBe(1);
    expect(stats.avgStars).toBeCloseTo(4);
  });

  it("upsert: rivotare aggiorna le stelle senza creare duplicati", async () => {
    await RatingService.submitRating({ guideId, sessionId, stars: 2 });
    await RatingService.submitRating({ guideId, sessionId, stars: 5 });

    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalRatings).toBe(1);
    expect(stats.avgStars).toBeCloseTo(5);
  });
});

describe("RatingService.submitRating — utente autenticato", () => {
  let userId: number;

  beforeAll(async () => {
    // Crea un utente di test tramite query diretta (evita argon2 slow hash).
    const res = await query<{ id: number }>(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ('rating-test@integration.test', 'not-used-hash', 'RatingTester')
       RETURNING id`,
    );
    userId = res.rows[0]!.id;
  });

  afterAll(async () => {
    // Delete ratings first (FK guide_ratings.user_id → users.id).
    await query(`DELETE FROM guide_ratings WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it("registra un voto utente autentico", async () => {
    const result = await RatingService.submitRating({
      guideId,
      userId,
      stars: 3,
    });
    expect(result.promoted).toBe(false);

    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalRatings).toBe(1);
    expect(stats.avgStars).toBeCloseTo(3);
  });

  it("upsert user: rivotare aggiorna senza duplicati", async () => {
    await RatingService.submitRating({ guideId, userId, stars: 1 });
    await RatingService.submitRating({ guideId, userId, stars: 5 });

    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalRatings).toBe(1);
    expect(stats.avgStars).toBeCloseTo(5);
  });
});

describe("RatingService.submitRating — promozione automatica", () => {
  it("promuove la guida a verified quando avg≥3.5 con ≥3 voti", async () => {
    // Crea 3 sessioni aggiuntive per simulare 3 votanti distinti.
    const s = await Promise.all([
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
    ]);
    const [s1, s2, s3] = s.map((r) => r.rows[0]!.id);

    try {
      await RatingService.submitRating({ guideId, sessionId: s1, stars: 4 });
      await RatingService.submitRating({ guideId, sessionId: s2, stars: 4 });
      const last = await RatingService.submitRating({
        guideId,
        sessionId: s3,
        stars: 4,
      });

      expect(last.promoted).toBe(true);

      // Verifica il flag nel DB.
      const res = await query<{ verified: boolean }>(
        `SELECT verified FROM guides WHERE id = $1`,
        [guideId],
      );
      expect(res.rows[0]!.verified).toBe(true);
    } finally {
      // Elimina prima i voti (FK guide_ratings → sessions), poi le sessioni.
      await query(`DELETE FROM guide_ratings WHERE session_id = ANY($1)`, [
        [s1, s2, s3],
      ]);
      await query(`DELETE FROM sessions WHERE id = ANY($1)`, [[s1, s2, s3]]);
    }
  });

  it("NON promuove se avg < 3.5 anche con ≥3 voti", async () => {
    const s = await Promise.all([
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
      query<{ id: string }>(`INSERT INTO sessions DEFAULT VALUES RETURNING id`),
    ]);
    const [s1, s2, s3] = s.map((r) => r.rows[0]!.id);

    try {
      await RatingService.submitRating({ guideId, sessionId: s1, stars: 2 });
      await RatingService.submitRating({ guideId, sessionId: s2, stars: 2 });
      const last = await RatingService.submitRating({
        guideId,
        sessionId: s3,
        stars: 2,
      });

      expect(last.promoted).toBe(false);

      const res = await query<{ verified: boolean }>(
        `SELECT verified FROM guides WHERE id = $1`,
        [guideId],
      );
      expect(res.rows[0]!.verified).toBe(false);
    } finally {
      // Elimina prima i voti (FK guide_ratings → sessions), poi le sessioni.
      await query(`DELETE FROM guide_ratings WHERE session_id = ANY($1)`, [
        [s1, s2, s3],
      ]);
      await query(`DELETE FROM sessions WHERE id = ANY($1)`, [[s1, s2, s3]]);
    }
  });
});

describe("RatingService — validazione errori", () => {
  it("lancia ValidationError se stars è fuori range (0, 6)", async () => {
    await expect(
      RatingService.submitRating({ guideId, sessionId, stars: 0 }),
    ).rejects.toThrow(ValidationError);

    await expect(
      RatingService.submitRating({ guideId, sessionId, stars: 6 }),
    ).rejects.toThrow(ValidationError);
  });

  it("lancia ValidationError se mancano sia userId che sessionId", async () => {
    await expect(
      RatingService.submitRating({ guideId, stars: 3 }),
    ).rejects.toThrow(ValidationError);
  });

  it("lancia NotFoundError se la guida non esiste", async () => {
    await expect(
      RatingService.submitRating({ guideId: 999999, sessionId, stars: 3 }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("RatingService.getGuideRatings", () => {
  it("restituisce totalRatings=0 e avgStars=0 se nessun voto presente", async () => {
    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalRatings).toBe(0);
    expect(stats.avgStars).toBe(0);
    expect(stats.totalSuggestions).toBe(0);
  });

  it("conta i suggerimenti correttamente", async () => {
    await RatingService.submitRating({
      guideId,
      sessionId,
      stars: 4,
      suggestion: "Ottima guida!",
    });

    const stats = await RatingService.getGuideRatings(guideId);
    expect(stats.totalSuggestions).toBe(1);
  });

  it("lancia NotFoundError se la guida non esiste", async () => {
    await expect(
      RatingService.getGuideRatings(999999),
    ).rejects.toThrow(NotFoundError);
  });
});
