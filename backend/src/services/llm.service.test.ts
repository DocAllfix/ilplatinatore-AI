import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ───────────────────────────────────────────────────────────────
// Strategia: vi.hoisted permette di definire le funzioni mock prima del
// vi.mock("@google/generative-ai", ...) che è hoisted in cima dal compilatore.
// Senza vi.hoisted, le mockFn risulterebbero undefined al momento del mock factory.
//
// IMPORTANTE — singleton breaker:
//   `breaker = new CircuitBreaker(...)` è module-level in llm.service.ts.
//   Lo stato è condiviso tra i test → l'ordine conta. I test che TRIPPANO
//   il circuit (3 errori consecutivi) sono in fondo al file, dopo tutti i
//   test che richiedono breaker CLOSED.

const mocks = vi.hoisted(() => {
  return {
    generateContent: vi.fn(),
    generateContentStream: vi.fn(),
    getGenerativeModel: vi.fn(),
  };
});

vi.mock("@google/generative-ai", () => {
  mocks.getGenerativeModel.mockReturnValue({
    generateContent: mocks.generateContent,
    generateContentStream: mocks.generateContentStream,
  });
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: mocks.getGenerativeModel,
    })),
  };
});

vi.mock("@/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import dopo i mock — fondamentale per il top-level del modulo che istanzia
// `genAI = new GoogleGenerativeAI(...)` e `primaryModel = genAI.getGenerativeModel(...)`.
import {
  generateGuide,
  generateGuideStream,
  translateGuide,
  getBreakerState,
  previewPrompt,
} from "./llm.service.js";
import type { PromptContext } from "@/services/prompt.builder.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    ragContext: "fonte rag context",
    scrapingContext: "",
    gameTitle: "Elden Ring",
    targetName: "Malenia Boss Fight",
    guideType: "walkthrough",
    language: "en",
    userQuery: "How do I beat Malenia?",
    ...overrides,
  };
}

function stubResponse(text = "Lorem ipsum guide content.") {
  return {
    response: {
      text: () => text,
      candidates: [{ finishReason: "STOP" }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-mocka getGenerativeModel perché clearAllMocks azzera il return value.
  mocks.getGenerativeModel.mockReturnValue({
    generateContent: mocks.generateContent,
    generateContentStream: mocks.generateContentStream,
  });
});

// ── generateGuide — happy path & contract ────────────────────────────────────

describe("generateGuide", () => {
  it("invoca generateContent con prompt costruito e ritorna content + meta", async () => {
    mocks.generateContent.mockResolvedValueOnce(stubResponse("Guide text."));

    const result = await generateGuide(ctx());

    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    const call = mocks.generateContent.mock.calls[0]![0];
    expect(call).toHaveProperty("contents");
    expect(call).toHaveProperty("systemInstruction");
    expect(call.contents[0].parts[0].text).toBeTruthy();

    expect(result.content).toBe("Guide text.");
    expect(result.templateId).toBeTruthy();
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.finishReason).toBe("STOP");
    expect(typeof result.elapsedMs).toBe("number");
  });

  it("propaga finishReason null se Gemini non lo fornisce", async () => {
    mocks.generateContent.mockResolvedValueOnce({
      response: {
        text: () => "x",
        candidates: undefined,
      },
    });

    const result = await generateGuide(ctx());
    expect(result.finishReason).toBeNull();
  });

  it("rilancia errori della SDK Gemini (rete, quota, ecc.)", async () => {
    mocks.generateContent.mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(generateGuide(ctx())).rejects.toThrow("quota exceeded");
  });
});

// ── generateGuideStream ──────────────────────────────────────────────────────

describe("generateGuideStream", () => {
  it("yield ogni chunk testuale dello stream Gemini", async () => {
    async function* fakeStream() {
      yield { text: () => "Hello " };
      yield { text: () => "" }; // empty chunk → skipped
      yield { text: () => "world." };
    }
    mocks.generateContentStream.mockResolvedValueOnce({
      stream: fakeStream(),
    });

    const chunks: string[] = [];
    const gen = generateGuideStream(ctx());
    for await (const c of gen) chunks.push(c.text);

    expect(chunks).toEqual(["Hello ", "world."]);
  });

  it("propaga errore in apertura stream prima di yield", async () => {
    mocks.generateContentStream.mockRejectedValueOnce(new Error("auth failed"));

    const gen = generateGuideStream(ctx());
    await expect(gen.next()).rejects.toThrow("auth failed");
  });

  it("propaga errore mid-stream senza tripare il breaker", async () => {
    async function* faultyStream() {
      yield { text: () => "first" };
      throw new Error("stream broken");
    }
    mocks.generateContentStream.mockResolvedValueOnce({
      stream: faultyStream(),
    });

    const gen = generateGuideStream(ctx());
    const first = await gen.next();
    expect(first.value).toEqual({ text: "first" });
    await expect(gen.next()).rejects.toThrow("stream broken");
  });
});

// ── translateGuide ───────────────────────────────────────────────────────────

describe("translateGuide", () => {
  it("ritorna il contenuto originale se fromLang === toLang (shortcut)", async () => {
    const result = await translateGuide("contenuto", "it", "it");
    expect(result).toBe("contenuto");
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });

  it("traduce invocando Gemini con system prompt da fromLang a toLang", async () => {
    mocks.generateContent.mockResolvedValueOnce(stubResponse("Italian text."));

    const result = await translateGuide("English text.", "en", "it");

    expect(result).toBe("Italian text.");
    expect(mocks.generateContent).toHaveBeenCalledTimes(1);
    const call = mocks.generateContent.mock.calls[0]![0];
    const systemText = call.systemInstruction.parts[0].text as string;
    expect(systemText).toContain("en");
    expect(systemText).toContain("it");
  });

  it("degrada graceful: in caso di errore Gemini ritorna il content originale", async () => {
    mocks.generateContent.mockRejectedValueOnce(new Error("translation api down"));

    const result = await translateGuide("Original text.", "en", "it");
    expect(result).toBe("Original text.");
  });
});

// ── previewPrompt + getBreakerState (read-only su breaker CLOSED) ────────────

describe("previewPrompt", () => {
  it("ritorna BuiltPrompt con campi system/user/templateId senza chiamare Gemini", () => {
    const result = previewPrompt(ctx({ guideType: "walkthrough" }));

    expect(result).toHaveProperty("system");
    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("templateId");
    expect(result.user).toBeTruthy();
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
});

describe("getBreakerState (CLOSED iniziale)", () => {
  it("ritorna lo stato corrente del circuit breaker (stringa CLOSED|OPEN|HALF_OPEN)", () => {
    const state = getBreakerState();
    expect(["CLOSED", "OPEN", "HALF_OPEN"]).toContain(state);
  });
});

// ── Circuit-tripping test (DEVE essere ULTIMO — singleton breaker) ───────────
// Dopo questo describe il breaker rimane OPEN per LLM_CIRCUIT_OPEN_MS (5 min).
// Tutti i test successivi all'interno dello stesso file vedrebbero OPEN.

describe("generateGuide — circuit breaker (ultimo, trippa il singleton)", () => {
  it("dopo errori ripetuti il breaker passa OPEN e fa failfast (CircuitOpenError)", async () => {
    mocks.generateContent.mockRejectedValue(new Error("rete down"));

    // Robusto rispetto al conteggio iniziale di errori cumulati dai test precedenti
    // (singleton breaker): esercita fino a max 10 chiamate finché lo stato passa OPEN.
    for (let i = 0; i < 10; i++) {
      try {
        await generateGuide(ctx());
      } catch {
        // errori attesi (rete down OR CircuitOpenError)
      }
      if (getBreakerState() === "OPEN") break;
    }

    expect(getBreakerState()).toBe("OPEN");

    // Una nuova chiamata deve essere failfast con CircuitOpenError, non "rete down".
    await expect(generateGuide(ctx())).rejects.toThrow(/circuit/i);
  });
});
