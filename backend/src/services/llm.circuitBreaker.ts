import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

/**
 * Circuit breaker stateful a 3 stati per proteggere chiamate LLM esterne.
 *
 *   CLOSED     → richieste passano; contiamo gli errori consecutivi.
 *   OPEN       → richieste falliscono immediate per LLM_CIRCUIT_OPEN_MS ms.
 *   HALF_OPEN  → dopo il cooldown, LA PROSSIMA richiesta è un probe:
 *                  - successo → CLOSED (reset)
 *                  - fallimento → OPEN (nuovo cooldown)
 *
 * NON distribuito: lo stato vive in memoria del processo. Con replica singola
 * (vedi CLAUDE.md §Rate Limiting BullMQ — UNA replica) è safe. Con N>1 ogni
 * replica ha il proprio breaker — pattern accettabile perché l'effetto è
 * "fail fast locale" e la richiesta successiva può finire su replica sana.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(public readonly remainingMs: number) {
    super(`Circuit breaker OPEN: retry in ${remainingMs}ms`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  name: string;
  errorThreshold?: number;
  openMs?: number;
  /** Timer source iniettabile — solo per test. */
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveErrors = 0;
  private openedAt = 0;
  private readonly name: string;
  private readonly errorThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.errorThreshold = opts.errorThreshold ?? env.LLM_CIRCUIT_ERROR_THRESHOLD;
    this.openMs = opts.openMs ?? env.LLM_CIRCUIT_OPEN_MS;
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    // Transizione passiva OPEN → HALF_OPEN se il cooldown è scaduto.
    // Evita di rimanere bloccati se nessuno chiama execute() per un po'.
    if (this.state === "OPEN" && this.now() - this.openedAt >= this.openMs) {
      this.state = "HALF_OPEN";
      logger.info({ breaker: this.name }, "circuit: OPEN → HALF_OPEN (cooldown scaduto)");
    }
    return this.state;
  }

  /**
   * Esegue fn sotto protezione del breaker.
   * @throws CircuitOpenError se lo stato è OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "OPEN") {
      const remaining = this.openMs - (this.now() - this.openedAt);
      throw new CircuitOpenError(remaining);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      logger.info({ breaker: this.name }, "circuit: HALF_OPEN → CLOSED (probe OK)");
    }
    this.state = "CLOSED";
    this.consecutiveErrors = 0;
  }

  private recordFailure(): void {
    if (this.state === "HALF_OPEN") {
      this.trip("probe fallito in HALF_OPEN");
      return;
    }
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= this.errorThreshold) {
      this.trip(`${this.consecutiveErrors} errori consecutivi`);
    }
  }

  private trip(reason: string): void {
    this.state = "OPEN";
    this.openedAt = this.now();
    this.consecutiveErrors = 0;
    logger.warn(
      { breaker: this.name, openMs: this.openMs, reason },
      "circuit: OPEN (richieste failfast)",
    );
  }

  /** Reset manuale — per admin/test. */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveErrors = 0;
    this.openedAt = 0;
  }
}
