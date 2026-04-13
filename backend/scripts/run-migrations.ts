import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import pino from "pino";

const { Client } = pg;

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  ...(process.env.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Migration runner — connessione DIRETTA a PostgreSQL (porta 5432), NON via PgBouncer.
 * Le DDL non funzionano bene con transaction pooling di PgBouncer.
 *
 * Eseguire DENTRO la rete Docker:
 *   docker compose exec api npx tsx scripts/run-migrations.ts
 */
async function runMigrations(): Promise<void> {
  const directUrl = process.env.POSTGRES_DIRECT_URL;
  if (!directUrl) {
    logger.fatal("POSTGRES_DIRECT_URL non impostata. Impossibile eseguire migrazioni.");
    process.exit(1);
  }

  const client = new Client({ connectionString: directUrl });

  try {
    await client.connect();
    logger.info("Connesso a PostgreSQL (porta diretta 5432) per migrazioni");

    // Crea tabella _migrations se non esiste
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Legge migrazioni già eseguite
    const { rows: executed } = await client.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY id",
    );
    const executedNames = new Set(executed.map((r) => r.name));

    // Legge file .sql dalla cartella migrations/ in ordine numerico
    const migrationsDir = path.resolve(__dirname, "..", "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedCount = 0;

    for (const file of files) {
      if (executedNames.has(file)) {
        logger.debug({ migration: file }, "Migrazione già eseguita, skip");
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      logger.info({ migration: file }, "Esecuzione migrazione...");

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO _migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        appliedCount++;
        logger.info({ migration: file }, "Migrazione completata con successo");
      } catch (err) {
        await client.query("ROLLBACK");
        logger.fatal(
          { migration: file, err },
          "Migrazione fallita — rollback eseguito. Interruzione.",
        );
        process.exit(1);
      }
    }

    if (appliedCount === 0) {
      logger.info("Nessuna nuova migrazione da applicare");
    } else {
      logger.info(
        { count: appliedCount },
        "Migrazioni completate: %d applicate",
        appliedCount,
      );
    }
  } finally {
    await client.end();
    logger.info("Connessione diretta PostgreSQL chiusa");
  }
}

runMigrations().catch((err) => {
  logger.fatal({ err }, "Errore fatale nel migration runner");
  process.exit(1);
});
