import pg from "pg";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Errore imprevisto sul pool PostgreSQL idle client");
});

/**
 * Wrapper per query singole.
 * Logga la query (troncata a 200 char), il tempo di esecuzione e eventuali errori.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = performance.now();
  try {
    const result = await pool.query<T>(text, params);
    const durationMs = Math.round(performance.now() - start);
    logger.debug(
      { query: text.slice(0, 200), rows: result.rowCount, durationMs },
      "Query eseguita in %dms",
      durationMs,
    );
    return result;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    logger.error(
      { query: text.slice(0, 200), durationMs, err },
      "Query fallita dopo %dms",
      durationMs,
    );
    throw err;
  }
}

/**
 * Ottiene un client dal pool per transazioni multi-statement.
 * IMPORTANTE: chiamare sempre client.release() nel finally.
 */
export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/**
 * Verifica che la connessione al database funzioni.
 */
export async function testConnection(): Promise<void> {
  const result = await query<{ now: Date }>("SELECT NOW() AS now");
  logger.info(
    { serverTime: result.rows[0]?.now },
    "Connessione PostgreSQL (via PgBouncer) OK",
  );
}

export { pool };
