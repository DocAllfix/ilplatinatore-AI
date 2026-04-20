import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { extractWithReadability } from "@/extractors/readability.extractor";
import type { ExtractedContent } from "@/types";

// --- SINGLETON BROWSER ---
// Una sola istanza Chromium per tutto il processo. Ogni scrape = una nuova Page (tab).
// CRITICO: non lanciare un nuovo browser per request (costo ~2s + 200MB RAM).
let browser: Browser | null = null;
let initPromise: Promise<Browser> | null = null;

// --- SEMAPHORE: MAX 2 PAGINE CONTEMPORANEE (regola prompt §Regole Critiche) ---
const MAX_CONCURRENT_PAGES = 2;
let activePages = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return;
  }
  // Coda FIFO: aspetta che qualcuno rilasci uno slot.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // Trasferimento diretto dello slot al prossimo waiter (activePages invariato).
    next();
  } else {
    activePages--;
  }
}

const NAV_TIMEOUT_MS = 10_000;
const WAIT_SELECTOR_MS = 5_000;
const WAIT_SELECTOR_QUERY = "article, .guide-content, main";

/**
 * Avvia il browser singleton. Idempotente e race-safe (initPromise guard).
 * Usa Chromium di sistema via PUPPETEER_EXECUTABLE_PATH (no download bundled).
 */
export async function initBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (initPromise) return initPromise;
  initPromise = puppeteer
    .launch({
      executablePath: env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    })
    .then((b) => {
      browser = b;
      logger.info(
        { executablePath: env.PUPPETEER_EXECUTABLE_PATH },
        "puppeteer: browser singleton avviato",
      );
      b.on("disconnected", () => {
        logger.warn("puppeteer: browser disconnesso — reset singleton");
        browser = null;
        initPromise = null;
      });
      return b;
    })
    .catch((err) => {
      logger.error({ err }, "puppeteer: init fallita");
      initPromise = null;
      throw err;
    });
  return initPromise;
}

/**
 * Shutdown graceful. Da chiamare in SIGTERM/SIGINT handler.
 */
export async function closeBrowser(): Promise<void> {
  try {
    if (browser) {
      await browser.close();
      browser = null;
      initPromise = null;
      logger.info("puppeteer: browser chiuso");
    }
  } catch (err) {
    logger.warn({ err }, "puppeteer: close error");
  }
}

/**
 * Estrae contenuto da una pagina JS-rendered.
 * Flusso: acquireSlot → new page → goto → waitForSelector → content() → readability → close page.
 * Page intercept scarta image/media/font per velocità (tipicamente 3-5x più veloce).
 */
export async function extractWithPuppeteer(
  url: string,
): Promise<ExtractedContent | null> {
  let b: Browser;
  try {
    b = await initBrowser();
  } catch {
    return null;
  }

  await acquireSlot();
  const start = Date.now();
  let page: Page | null = null;

  try {
    page = await b.newPage();
    await page.setUserAgent(env.USER_AGENT);

    // Skip risorse pesanti per velocità — ci serve solo l'HTML.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font") {
        req.abort().catch(() => undefined);
      } else {
        req.continue().catch(() => undefined);
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Attendi il contenuto principale — best-effort, non fatale se timeout.
    try {
      await page.waitForSelector(WAIT_SELECTOR_QUERY, { timeout: WAIT_SELECTOR_MS });
    } catch {
      logger.debug({ url }, "puppeteer: waitForSelector timeout, continuo con DOM corrente");
    }

    const html = await page.content();
    const extracted = extractWithReadability(html, url);
    const elapsed = Date.now() - start;

    if (extracted) {
      logger.info(
        { url, wordCount: extracted.wordCount, elapsed },
        "puppeteer: extraction OK",
      );
      // Override extractor tag — readability è il parser, puppeteer è il fetcher.
      return { ...extracted, extractor: "puppeteer" };
    }
    logger.debug({ url, elapsed }, "puppeteer: extraction null");
    return null;
  } catch (err) {
    logger.warn(
      { err, url, elapsed: Date.now() - start },
      "puppeteer: navigation/extraction error",
    );
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    releaseSlot();
  }
}
