import { afterEach, vi } from "vitest";
import RedisMock from "ioredis-mock";

/**
 * Setup globale Vitest — zero-dep (no Postgres, no Redis running, no Internet).
 *
 * 1) Sostituzione globale di `ioredis` con `ioredis-mock`:
 *    tutti i `new Redis(url, opts)` ritornano un'istanza Map-based in-memory.
 *    I test che preferiscono mockare direttamente `@/config/redis.js` (la maggior
 *    parte dei test unitari esistenti) sovrascrivono questo fallback.
 *
 * 2) Env variabili: già popolate in vitest.config.ts — qui NON duplichiamo.
 *
 * 3) Reset timer fake tra i test (i test che usano vi.useFakeTimers non devono
 *    contaminare i successivi).
 *
 * NIENTE migrations / DB reali / nock.disableNetConnect globale — quelle
 * regole vivono nei singoli integration test (cartella tests/integration/,
 * gated da env RUN_INTEGRATION=1, NON girano in `npm test`).
 */

vi.mock("ioredis", async () => {
  // Replichiamo l'interfaccia a default + named Redis usata da @/config/redis.ts
  // (`RedisModule.default ?? RedisModule`). ioredis-mock espone un singolo
  // costruttore; mappiamo entrambi i path su quello.
  return {
    default: RedisMock,
    Redis: RedisMock,
  };
});

afterEach(() => {
  // Reset idempotente: se un test ha attivato fake timers, rilasciali.
  vi.useRealTimers();
});
