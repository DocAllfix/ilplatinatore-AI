import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "@/services/llm.circuitBreaker.js";

// Timer iniettato per testare transizioni temporali deterministicamente.
// Il breaker accetta `now` via constructor — niente vi.useFakeTimers().
function makeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeBreaker(clock: ReturnType<typeof makeClock>, errorThreshold = 3, openMs = 5000) {
  return new CircuitBreaker({
    name: "test",
    errorThreshold,
    openMs,
    now: clock.now,
  });
}

describe("CircuitBreaker", () => {
  let clock: ReturnType<typeof makeClock>;

  beforeEach(() => {
    clock = makeClock();
  });

  it("stato iniziale CLOSED, execute passa attraverso", async () => {
    const b = makeBreaker(clock);
    expect(b.getState()).toBe("CLOSED");
    const result = await b.execute(async () => 42);
    expect(result).toBe(42);
    expect(b.getState()).toBe("CLOSED");
  });

  it("errori sotto soglia NON trippano (resilienza transienti)", async () => {
    const b = makeBreaker(clock, 3);
    for (let i = 0; i < 2; i++) {
      await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("CLOSED");
  });

  it("apre dopo N errori consecutivi e fa failfast", async () => {
    const b = makeBreaker(clock, 3, 5000);
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    }
    expect(b.getState()).toBe("OPEN");
    // Dopo trip, non chiama più fn — CircuitOpenError.
    await expect(b.execute(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("successo RESETTA il counter degli errori consecutivi", async () => {
    const b = makeBreaker(clock, 3);
    await expect(b.execute(async () => { throw new Error("e1"); })).rejects.toThrow();
    await expect(b.execute(async () => { throw new Error("e2"); })).rejects.toThrow();
    await b.execute(async () => 1); // successo resetta
    await expect(b.execute(async () => { throw new Error("e3"); })).rejects.toThrow();
    // Solo 1 errore post-reset, ancora CLOSED (serve 3 consecutivi).
    expect(b.getState()).toBe("CLOSED");
  });

  it("transizione OPEN → HALF_OPEN a cooldown scaduto", async () => {
    const b = makeBreaker(clock, 1, 5000);
    await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(b.getState()).toBe("OPEN");
    clock.advance(5000);
    expect(b.getState()).toBe("HALF_OPEN");
  });

  it("HALF_OPEN + successo probe → CLOSED", async () => {
    const b = makeBreaker(clock, 1, 5000);
    await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    clock.advance(5000);
    expect(b.getState()).toBe("HALF_OPEN");
    await b.execute(async () => "ok");
    expect(b.getState()).toBe("CLOSED");
  });

  it("HALF_OPEN + probe fallito → OPEN con nuovo cooldown", async () => {
    const b = makeBreaker(clock, 1, 5000);
    await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    clock.advance(5000);
    expect(b.getState()).toBe("HALF_OPEN");
    await expect(b.execute(async () => { throw new Error("still broken"); })).rejects.toThrow();
    expect(b.getState()).toBe("OPEN");
    // Richiesta immediata → CircuitOpenError (nuovo cooldown partito).
    await expect(b.execute(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("reset() forza CLOSED indipendentemente dallo stato", async () => {
    const b = makeBreaker(clock, 1, 5000);
    await expect(b.execute(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(b.getState()).toBe("OPEN");
    b.reset();
    expect(b.getState()).toBe("CLOSED");
    await b.execute(async () => 1); // niente failfast
  });
});
