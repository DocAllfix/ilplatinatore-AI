import { describe, it, expect, vi, afterEach } from "vitest";
import { makeCsrfToken, verifyCsrfToken } from "@/services/auth.csrf.js";

describe("auth.csrf — signed HMAC CSRF token", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trip: verify riconosce un token appena emesso", () => {
    const token = makeCsrfToken(42);
    expect(verifyCsrfToken(token, 42)).toBe(true);
  });

  it("user mismatch → 403 (userId diverso da quello firmato)", () => {
    const token = makeCsrfToken(42);
    expect(verifyCsrfToken(token, 99)).toBe(false);
  });

  it("tampering sulla firma → false (HMAC non matcha)", () => {
    const token = makeCsrfToken(42);
    // Flip dell'ultimo carattere del signature block → base64url ancora valido
    // ma il decoded HMAC hex sarà diverso → verify fallisce.
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    const sig = parts[2]!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    const tampered = Buffer.from(`${parts[0]}:${parts[1]}:${flipped}`).toString(
      "base64url",
    );
    expect(verifyCsrfToken(tampered, 42)).toBe(false);
  });

  it("tampering sullo userId del payload → false (HMAC legato all'uid originale)", () => {
    const token = makeCsrfToken(42);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    const tampered = Buffer.from(`99:${parts[1]}:${parts[2]}`).toString(
      "base64url",
    );
    // userId nel payload ora è 99 ma la firma è stata prodotta per 42.
    // Anche verificando con userId=99 deve fallire (HMAC mismatch).
    expect(verifyCsrfToken(tampered, 99)).toBe(false);
  });

  it("scadenza 24h → false quando il timestamp è più vecchio", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = makeCsrfToken(42);
    // Avanza di 24h + 1s
    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));
    expect(verifyCsrfToken(token, 42)).toBe(false);
  });

  it("entro la TTL di 24h il token resta valido", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = makeCsrfToken(42);
    vi.setSystemTime(new Date("2026-01-01T23:59:59Z"));
    expect(verifyCsrfToken(token, 42)).toBe(true);
  });

  it("input non-base64url → false senza throw (no 500)", () => {
    expect(verifyCsrfToken("not-a-valid-token", 42)).toBe(false);
  });

  it("input con parti insufficienti → false", () => {
    // "42:123" ha solo 2 parti (manca signature)
    const broken = Buffer.from("42:123").toString("base64url");
    expect(verifyCsrfToken(broken, 42)).toBe(false);
  });

  it("signature di lunghezza diversa → false (timingSafeEqual abort pre-compare)", () => {
    // Produce un token con sig troppo corto, che verify deve rigettare senza crashare
    // su timingSafeEqual (che richiede Buffer di pari lunghezza).
    const ts = Date.now();
    const broken = Buffer.from(`42:${ts}:deadbeef`).toString("base64url");
    expect(verifyCsrfToken(broken, 42)).toBe(false);
  });

  it("due token emessi nello stesso ms restano ambedue validi (timestamp non è nonce)", () => {
    const t1 = makeCsrfToken(42);
    const t2 = makeCsrfToken(42);
    expect(verifyCsrfToken(t1, 42)).toBe(true);
    expect(verifyCsrfToken(t2, 42)).toBe(true);
  });
});
