/**
 * globalSetup / globalTeardown per i test di integrazione.
 * Gira nel processo principale di Vitest (NON nei worker) — le test.env
 * del vitest.integration.config.ts non sono disponibili qui; le credenziali
 * sono hardcodate e devono corrispondere al docker-compose locale.
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

const ADMIN_URL =
  "postgresql://platinatore:dev_password_2026@localhost:5432/platinatore_db";
const TEST_DB = "platinatore_test";
const TEST_DB_URL = `postgresql://platinatore:dev_password_2026@localhost:5432/${TEST_DB}`;

async function terminateTestDbConnections(adminClient: pg.Client): Promise<void> {
  await adminClient.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
}

export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  // Drop residual DB from a previous failed run, then create fresh.
  await terminateTestDbConnections(admin);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB} OWNER platinatore`);
  await admin.end();

  // Apply all migrations in order.
  const migrationClient = new pg.Client({ connectionString: TEST_DB_URL });
  await migrationClient.connect();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    try {
      await migrationClient.query(sql);
    } catch (err) {
      await migrationClient.end();
      throw new Error(
        `Migration ${file} fallita: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await migrationClient.end();
  console.log(
    `[integration-setup] platinatore_test pronto con ${files.length} migration`,
  );
}

export async function teardown(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await terminateTestDbConnections(admin);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
  console.log("[integration-teardown] platinatore_test eliminato");
}
