import "dotenv/config";

/**
 * T4.2 — Load test script (Node nativo, zero dependencies extra).
 *
 * Simula carico realistico: N utenti virtuali × M lingue × T durata,
 * misura latency p50/p95/p99 + throughput + error rate.
 *
 * Esecuzione:
 *   npm run load-test                   # default: 50 utenti × 5 min
 *   npm run load-test -- --users 100 --duration-min 30 --rps 5
 *
 * Args:
 *   --target           URL base (default: http://localhost:3000)
 *   --users            Concurrent virtual users (default: 50)
 *   --duration-min     Durata in minuti (default: 5)
 *   --rps              Request per second per utente (default: 1)
 *   --endpoint         Path API (default: /api/guide)
 *   --warmup-sec       Warmup secondi senza misurare (default: 10)
 */

const QUERIES_BY_LANG: Record<string, string[]> = {
  en: [
    "how do i get the platinum trophy in elden ring",
    "where can i find the legendary weapon in this game",
    "best build for the dlc final boss",
  ],
  it: [
    "come ottengo il trofeo di platino in elden ring",
    "dove trovo la spada leggendaria nella zona iniziale",
    "guida per sconfiggere malenia",
  ],
  es: [
    "cómo conseguir el trofeo de platino en elden ring",
    "dónde encontrar las armas legendarias",
  ],
  fr: [
    "comment obtenir le trophée de platine dans elden ring",
    "où trouver l'épée légendaire",
  ],
  de: [
    "wie bekomme ich die platintrophäe in elden ring",
    "wo finde ich die legendäre waffe",
  ],
  pt: [
    "como conseguir o troféu de platina em elden ring",
  ],
  ja: [
    "エルデンリングのプラチナトロフィーの取り方を教えて",
  ],
  zh: [
    "艾尔登法环白金奖杯怎么获得指南",
  ],
  ru: [
    "как получить платиновый трофей в elden ring",
  ],
};

interface Args {
  target: string;
  users: number;
  durationMin: number;
  rps: number;
  endpoint: string;
  warmupSec: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
  };
  return {
    target: get("--target", "http://localhost:3000"),
    users: parseInt(get("--users", "50"), 10),
    durationMin: parseFloat(get("--duration-min", "5")),
    rps: parseFloat(get("--rps", "1")),
    endpoint: get("--endpoint", "/api/guide"),
    warmupSec: parseInt(get("--warmup-sec", "10"), 10),
  };
}

interface Sample {
  ts: number;
  ms: number;
  status: number;
  err?: string;
  lang: string;
}

const ALL_LANGS = Object.keys(QUERIES_BY_LANG);

function randomQuery(): { query: string; lang: string } {
  const lang = ALL_LANGS[Math.floor(Math.random() * ALL_LANGS.length)]!;
  const queries = QUERIES_BY_LANG[lang]!;
  const query = queries[Math.floor(Math.random() * queries.length)]!;
  return { query, lang };
}

async function runUser(
  userId: number,
  args: Args,
  endTs: number,
  samples: Sample[],
  isWarmup: () => boolean,
): Promise<void> {
  const intervalMs = 1000 / args.rps;
  while (Date.now() < endTs) {
    const { query, lang } = randomQuery();
    const start = Date.now();
    let status = 0;
    let err: string | undefined;
    try {
      const res = await fetch(`${args.target}${args.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, language: lang }),
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      // consuma il body per liberare la connessione (importante per keep-alive)
      await res.text();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      status = 0;
    }
    const ms = Date.now() - start;
    if (!isWarmup()) {
      samples.push({
        ts: start,
        ms,
        status,
        ...(err && { err }),
        lang,
      });
    }
    // Sleep per il prossimo invio dell'utente
    const delay = Math.max(0, intervalMs - ms);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function reportResults(samples: Sample[], args: Args, totalDurationSec: number): void {
  const total = samples.length;
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500);
  const fourxx = samples.filter((s) => s.status >= 400 && s.status < 500);
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400);
  const latencies = ok.map((s) => s.ms).sort((a, b) => a - b);

  const errorRate = total > 0 ? (errors.length / total) * 100 : 0;

  // Per-lang breakdown
  const byLang = new Map<string, { count: number; ok: number; ms: number[] }>();
  for (const s of samples) {
    const e = byLang.get(s.lang) ?? { count: 0, ok: 0, ms: [] };
    e.count++;
    if (s.status >= 200 && s.status < 400) {
      e.ok++;
      e.ms.push(s.ms);
    }
    byLang.set(s.lang, e);
  }

  /* eslint-disable no-console */
  console.log("\n=== T4.2 LOAD TEST RESULTS ===");
  console.log(`Target:        ${args.target}${args.endpoint}`);
  console.log(`Users:         ${args.users} concurrent`);
  console.log(`Duration:      ${totalDurationSec}s (warmup excluded)`);
  console.log(`RPS per user:  ${args.rps}`);
  console.log("");
  console.log(`Total samples:   ${total}`);
  console.log(`OK (2xx/3xx):    ${ok.length}`);
  console.log(`Client err 4xx:  ${fourxx.length}`);
  console.log(`Server err/timeout: ${errors.length}`);
  console.log(`Error rate:      ${errorRate.toFixed(2)}%`);
  console.log(`Throughput:      ${(total / totalDurationSec).toFixed(2)} req/s`);
  console.log("");
  console.log("Latency (OK only):");
  console.log(`  p50:  ${percentile(latencies, 50)} ms`);
  console.log(`  p90:  ${percentile(latencies, 90)} ms`);
  console.log(`  p95:  ${percentile(latencies, 95)} ms`);
  console.log(`  p99:  ${percentile(latencies, 99)} ms`);
  console.log(`  max:  ${latencies[latencies.length - 1] ?? 0} ms`);
  console.log("");
  console.log("Per-language breakdown:");
  for (const [lang, e] of byLang.entries()) {
    const langLat = e.ms.sort((a, b) => a - b);
    console.log(
      `  [${lang}] count=${e.count} ok=${e.ok} p95=${percentile(langLat, 95)}ms`,
    );
  }
  console.log("");

  // Pre-Beta thresholds (audit T4.2 "Definition of Done"):
  //   p95 < 3000ms, error rate < 0.5%
  const p95 = percentile(latencies, 95);
  const passing = p95 < 3000 && errorRate < 0.5;
  console.log("Pre-Beta thresholds: p95 < 3000ms AND error rate < 0.5%");
  console.log(`  Status: ${passing ? "✅ PASS" : "❌ FAIL"}`);
  if (!passing) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  /* eslint-disable-next-line no-console */
  console.log(
    `Starting load test: ${args.users} users × ${args.durationMin}min × ${args.rps} req/s/user → target ${args.target}${args.endpoint}`,
  );
  /* eslint-disable-next-line no-console */
  console.log(`Warmup: ${args.warmupSec}s (samples discarded)`);

  const startTs = Date.now();
  const warmupEndTs = startTs + args.warmupSec * 1000;
  const endTs = warmupEndTs + args.durationMin * 60 * 1000;
  const samples: Sample[] = [];
  const isWarmup = (): boolean => Date.now() < warmupEndTs;

  const userPromises = Array.from({ length: args.users }, (_, i) =>
    runUser(i, args, endTs, samples, isWarmup),
  );
  await Promise.all(userPromises);

  const totalDurationSec = (Date.now() - warmupEndTs) / 1000;
  reportResults(samples, args, totalDurationSec);
}

main().catch((err) => {
  /* eslint-disable-next-line no-console */
  console.error("Load test crashed:", err);
  process.exit(1);
});
