import "dotenv/config";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { query, pool } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

// ── Input schema (JSONL — una guida per riga) ─────────────────────────────────

export const guideRecordSchema = z.object({
  game_id: z.number().int().positive(),
  trophy_id: z.number().int().positive().nullable().optional(),
  title: z.string().min(1).max(500),
  slug: z.string().max(300).optional(),
  content: z.string().min(10),
  language: z.string().default("en"),
  guide_type: z
    .enum(["trophy", "walkthrough", "collectible", "challenge", "platinum"])
    .nullable()
    .optional(),
  source: z.string().default("chatbot"),
  quality_score: z.number().min(0).max(1).default(0),
  verified: z.boolean().default(false),
  confidence_level: z
    .enum(["verified", "harvested", "generated", "unverified"])
    .default("generated"),
  topic: z.string().nullable().optional(),
});

export type GuideRecord = z.infer<typeof guideRecordSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Inlined per evitare import di guide.cache.ts (porta dentro Redis).
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function buildSlug(record: GuideRecord): string {
  if (record.slug) return record.slug;
  return `${slugify(record.title)}-g${record.game_id}`;
}

// ── DB helper (ON CONFLICT per idempotenza) ───────────────────────────────────

export async function insertGuideOrSkip(
  record: GuideRecord,
  slug: string,
): Promise<{ inserted: boolean; id?: number }> {
  const res = await query<{ id: number }>(
    `-- Bulk seed: inserisce guida con ON CONFLICT per idempotenza su slug.
     INSERT INTO guides (
       game_id, trophy_id, title, slug, content, language,
       guide_type, source, quality_score, verified,
       confidence_level, topic, embedding_pending
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [
      record.game_id,
      record.trophy_id ?? null,
      record.title,
      slug,
      record.content,
      record.language,
      record.guide_type ?? null,
      record.source,
      record.quality_score,
      record.verified,
      record.confidence_level,
      record.topic ?? null,
      true, // embedding_pending: la guida sarà accodata per embedding
    ],
  );
  return res.rows[0] ? { inserted: true, id: res.rows[0].id } : { inserted: false };
}

// ── Seed batch ────────────────────────────────────────────────────────────────

export interface SeedStats {
  total: number;
  inserted: number;
  skipped: number;
  failed: number;
}

export async function seedBatch(records: GuideRecord[], dryRun: boolean): Promise<SeedStats> {
  const stats: SeedStats = { total: records.length, inserted: 0, skipped: 0, failed: 0 };
  for (const record of records) {
    const slug = buildSlug(record);
    if (dryRun) {
      stats.inserted++;
      continue;
    }
    try {
      const result = await insertGuideOrSkip(record, slug);
      if (result.inserted) stats.inserted++;
      else stats.skipped++;
    } catch (err) {
      logger.error({ err, slug }, "bulk-seed: inserimento fallito");
      stats.failed++;
    }
  }
  return stats;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

export interface CliArgs {
  file: string;
  batchSize: number;
  delayMs: number;
  dryRun: boolean;
  resume: boolean;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  function getFlag(flag: string): string | undefined {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
  }
  const file = getFlag("--file");
  if (!file) {
    logger.error(
      "Utilizzo: tsx src/scripts/bulk-seed.ts --file <path.jsonl> " +
        "[--batch-size N] [--delay-ms N] [--dry-run] [--resume]",
    );
    process.exit(1);
  }
  return {
    file: resolve(file),
    batchSize: parseInt(getFlag("--batch-size") ?? "50", 10),
    delayMs: parseInt(getFlag("--delay-ms") ?? "0", 10),
    dryRun: argv.includes("--dry-run"),
    resume: argv.includes("--resume"),
  };
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

interface Checkpoint {
  file: string;
  processedLines: number;
}

export function readCheckpoint(inputPath: string): Checkpoint | null {
  const cp = `${inputPath}.checkpoint.json`;
  if (!existsSync(cp)) return null;
  try {
    return JSON.parse(readFileSync(cp, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

export function writeCheckpoint(inputPath: string, processedLines: number): void {
  const cp = `${inputPath}.checkpoint.json`;
  writeFileSync(cp, JSON.stringify({ file: inputPath, processedLines }), "utf8");
}

export function clearCheckpoint(inputPath: string): void {
  const cp = `${inputPath}.checkpoint.json`;
  if (existsSync(cp)) unlinkSync(cp);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const { file, batchSize, delayMs, dryRun, resume } = parseArgs();

  let skipLines = 0;
  if (resume) {
    const cp = readCheckpoint(file);
    if (cp?.file === file) {
      skipLines = cp.processedLines;
      logger.info({ skipLines }, "bulk-seed: riprendendo da checkpoint");
    }
  }
  if (dryRun) logger.info("bulk-seed: DRY RUN — nessun dato verrà scritto");

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let lineNum = 0;
  let batch: GuideRecord[] = [];
  const total: SeedStats = { total: 0, inserted: 0, skipped: 0, failed: 0 };

  for await (const line of rl) {
    lineNum++;
    if (lineNum <= skipLines || !line.trim()) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      logger.warn({ line: lineNum }, "bulk-seed: JSON non valido, riga saltata");
      continue;
    }

    const parsed = guideRecordSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ line: lineNum, errors: parsed.error.issues }, "bulk-seed: validazione fallita");
      total.failed++;
      total.total++;
      continue;
    }

    batch.push(parsed.data);

    if (batch.length >= batchSize) {
      const s = await seedBatch(batch, dryRun);
      total.inserted += s.inserted;
      total.skipped += s.skipped;
      total.failed += s.failed;
      total.total += s.total;
      logger.info({ processedLines: lineNum, ...total }, "bulk-seed: batch");
      if (!dryRun) writeCheckpoint(file, lineNum);
      batch = [];
      if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }

  if (batch.length > 0) {
    const s = await seedBatch(batch, dryRun);
    total.inserted += s.inserted;
    total.skipped += s.skipped;
    total.failed += s.failed;
    total.total += s.total;
  }

  logger.info(total, "bulk-seed: completato");
  if (!dryRun) clearCheckpoint(file);
}

// Esegue main solo quando invocato direttamente (non in import per test).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let exitCode = 0;
  main()
    .catch((err) => {
      logger.error({ err }, "bulk-seed: errore fatale");
      exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
      process.exit(exitCode);
    });
}
