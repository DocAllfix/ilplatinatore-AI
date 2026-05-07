import { GoogleGenerativeAI, type GenerativeModel } from "@google/generative-ai";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";
import { CircuitBreaker, CircuitOpenError } from "@/services/llm.circuitBreaker.js";
import { buildPrompt, type PromptContext, type BuiltPrompt } from "@/services/prompt.builder.js";

// ── Gemini setup ─────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const geminiModel: GenerativeModel = genAI.getGenerativeModel({
  model: env.GEMINI_CHAT_MODEL,
  generationConfig: {
    temperature: env.LLM_CHAT_TEMPERATURE,
    topP: env.LLM_CHAT_TOP_P,
    maxOutputTokens: env.LLM_CHAT_MAX_TOKENS,
  },
});

// ── Shared circuit breaker ───────────────────────────────────────────────────
const breaker = new CircuitBreaker({ name: "llm-chat" });

export interface GenerateGuideResult {
  content: string;
  templateId: string;
  model: string;
  finishReason: string | null;
  elapsedMs: number;
}

export interface StreamChunk {
  text: string;
}

// ── DeepSeek helpers (OpenAI-compatible API) ─────────────────────────────────

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function deepseekComplete(system: string, user: string): Promise<string> {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ] satisfies DeepSeekMessage[],
      temperature: env.LLM_CHAT_TEMPERATURE,
      top_p: env.LLM_CHAT_TOP_P,
      max_tokens: env.LLM_CHAT_MAX_TOKENS,
      stream: false,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DeepSeek ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

async function* deepseekStream(system: string, user: string): AsyncGenerator<StreamChunk> {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ] satisfies DeepSeekMessage[],
      temperature: env.LLM_CHAT_TEMPERATURE,
      top_p: env.LLM_CHAT_TOP_P,
      max_tokens: env.LLM_CHAT_MAX_TOKENS,
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DeepSeek ${resp.status}: ${body.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6)) as {
            choices: Array<{ delta: { content?: string } }>;
          };
          const text = json.choices[0]?.delta?.content;
          if (text) yield { text };
        } catch {
          // partial JSON — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// Ordine provider: primario + fallback automatico sull'altro
const providerOrder: Array<"deepseek" | "gemini"> =
  env.LLM_CHAT_PROVIDER === "deepseek"
    ? ["deepseek", "gemini"]
    : ["gemini", "deepseek"];

function modelName(provider: "deepseek" | "gemini"): string {
  return provider === "deepseek" ? env.DEEPSEEK_CHAT_MODEL : env.GEMINI_CHAT_MODEL;
}

async function tryComplete(provider: "deepseek" | "gemini", system: string, user: string): Promise<string> {
  if (provider === "deepseek") {
    if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY non configurata");
    return deepseekComplete(system, user);
  }
  const result = await geminiModel.generateContent({
    contents: [{ role: "user", parts: [{ text: user }] }],
    systemInstruction: { role: "system", parts: [{ text: system }] },
  });
  return result.response.text();
}

export async function generateGuide(ctx: PromptContext): Promise<GenerateGuideResult> {
  const prompt = buildPrompt(ctx);
  const start = Date.now();
  let lastErr: unknown;

  for (const provider of providerOrder) {
    try {
      const content = await breaker.execute(() => tryComplete(provider, prompt.system, prompt.user));
      const elapsedMs = Date.now() - start;
      const model = modelName(provider);
      if (provider !== env.LLM_CHAT_PROVIDER) {
        logger.warn({ templateId: prompt.templateId, provider }, "generateGuide: usando provider fallback");
      }
      logger.info({ templateId: prompt.templateId, model, elapsedMs, length: content.length }, "generateGuide: OK");
      return { content, templateId: prompt.templateId, model, finishReason: null, elapsedMs };
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        logger.warn({ err, templateId: prompt.templateId, provider }, "generateGuide: circuit OPEN");
      } else {
        logger.warn({ err, templateId: prompt.templateId, provider }, "generateGuide: provider fallito, provo fallback");
      }
      lastErr = err;
    }
  }

  logger.error({ err: lastErr, templateId: prompt.templateId }, "generateGuide: tutti i provider falliti");
  throw lastErr;
}

export async function* generateGuideStream(
  ctx: PromptContext,
): AsyncGenerator<StreamChunk, { templateId: string; model: string; elapsedMs: number }, void> {
  const prompt = buildPrompt(ctx);
  const start = Date.now();
  let usedProvider: "deepseek" | "gemini" | null = null;

  // Prova i provider in ordine — il fallback scatta solo se l'apertura dello stream fallisce
  for (const provider of providerOrder) {
    try {
      if (provider === "deepseek") {
        if (!env.DEEPSEEK_API_KEY) continue;
        const stream = await breaker.execute(async () => deepseekStream(prompt.system, prompt.user));
        usedProvider = provider;
        if (provider !== env.LLM_CHAT_PROVIDER) {
          logger.warn({ templateId: prompt.templateId, provider }, "generateGuideStream: usando provider fallback");
        }
        try {
          for await (const chunk of stream) yield chunk;
        } catch (err) {
          logger.warn({ err, templateId: prompt.templateId }, "generateGuideStream: errore durante stream DeepSeek");
          throw err;
        }
      } else {
        const result = await breaker.execute(async () =>
          geminiModel.generateContentStream({
            contents: [{ role: "user", parts: [{ text: prompt.user }] }],
            systemInstruction: { role: "system", parts: [{ text: prompt.system }] },
          }),
        );
        usedProvider = provider;
        if (provider !== env.LLM_CHAT_PROVIDER) {
          logger.warn({ templateId: prompt.templateId, provider }, "generateGuideStream: usando provider fallback");
        }
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) yield { text };
          }
        } catch (err) {
          logger.warn({ err, templateId: prompt.templateId }, "generateGuideStream: errore durante stream Gemini");
          throw err;
        }
      }
      break; // stream completato senza errori
    } catch (err) {
      if (usedProvider !== null) throw err; // errore mid-stream, non ritentare
      if (err instanceof CircuitOpenError) {
        logger.warn({ err, templateId: prompt.templateId, provider }, "generateGuideStream: circuit OPEN");
      } else {
        logger.warn({ err, templateId: prompt.templateId, provider }, "generateGuideStream: apertura stream fallita, provo fallback");
      }
    }
  }

  if (usedProvider === null) {
    throw new Error("Tutti i provider LLM hanno fallito");
  }

  const elapsedMs = Date.now() - start;
  logger.info(
    { templateId: prompt.templateId, model: modelName(usedProvider), elapsedMs },
    "generateGuideStream: completato",
  );
  return { templateId: prompt.templateId, model: modelName(usedProvider), elapsedMs };
}

export async function translateGuide(
  content: string,
  fromLang: string,
  toLang: string,
): Promise<string> {
  if (fromLang === toLang) return content;

  const system = `Sei un traduttore tecnico specializzato in guide videoludiche.
Traduci il contenuto da ${fromLang} a ${toLang} preservando:
  - Markdown (titoli, liste, grassetto)
  - Nomi propri di personaggi, luoghi, trofei, abilità (mantieni l'originale)
  - Identificativi tecnici (psn_trophy_id, codici, tag HTML)
Ritorna SOLO il testo tradotto, senza preamboli né commenti.`;

  for (const provider of providerOrder) {
    try {
      return await breaker.execute(() => tryComplete(provider, system, content));
    } catch {
      // prova il prossimo provider
    }
  }
  logger.error({ fromLang, toLang }, "translateGuide: tutti i provider falliti, ritorno testo originale");
  return content;
}

export function getBreakerState() {
  return breaker.getState();
}

export function previewPrompt(ctx: PromptContext): BuiltPrompt {
  return buildPrompt(ctx);
}
