import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyNewDraft } from "./notification.service.js";
import type { GuideDraftRow } from "@/models/guideDrafts.model.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// env è importato dal modulo testato; per cambiare ADMIN_WEBHOOK_URL fra test
// rimockiamo il modulo @/config/env.js prima di re-importare notifyNewDraft.
const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<GuideDraftRow> = {}): GuideDraftRow {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    session_id: "sess-1",
    user_id: null,
    game_id: 1,
    trophy_id: 10,
    title: null,
    slug: null,
    content: "Test guide content",
    language: "en",
    guide_type: "trophy",
    topic: null,
    status: "draft",
    iteration_count: 0,
    original_query: "how to get malenia",
    sources_json: [],
    search_metadata: { gameTitle: "Elden Ring", targetName: "Malenia" },
    quality_score: 0,
    validation_errors: [],
    created_at: new Date("2026-04-30T10:00:00.000Z"),
    updated_at: new Date("2026-04-30T10:00:00.000Z"),
    approved_at: null,
    published_at: null,
    published_guide_id: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("notifyNewDraft — webhook non configurato", () => {
  it("no-op silenzioso quando ADMIN_WEBHOOK_URL è stringa vuota", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "", ADMIN_DASHBOARD_URL: "" },
    }));
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("notifyNewDraft — webhook configurato", () => {
  it("chiama fetch con payload draft.created e content-type JSON", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: {
        ADMIN_WEBHOOK_URL: "https://hooks.slack.com/services/test",
        ADMIN_DASHBOARD_URL: "https://admin.example.com",
      },
    }));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.com/services/test");
    expect(opts.method).toBe("POST");
    expect(opts.headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(opts.body as string);
    expect(payload.event).toBe("draft.created");
    expect(payload.draftId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(payload.gameTitle).toBe("Elden Ring");
    expect(payload.targetName).toBe("Malenia");
    expect(payload.guideType).toBe("trophy");
    expect(payload.dashboardUrl).toBe(
      "https://admin.example.com/drafts/550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rimuove trailing slash da ADMIN_DASHBOARD_URL prima di concatenare", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: {
        ADMIN_WEBHOOK_URL: "https://h.example.com/",
        ADMIN_DASHBOARD_URL: "https://admin.example.com/",
      },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(payload.dashboardUrl).not.toContain("//drafts");
    expect(payload.dashboardUrl).toBe(
      "https://admin.example.com/drafts/550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("dashboardUrl=null quando ADMIN_DASHBOARD_URL non è configurato", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "https://h.example.com", ADMIN_DASHBOARD_URL: "" },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(payload.dashboardUrl).toBeNull();
  });

  it("usa fallback su search_metadata mancante (gameTitle/targetName='unknown')", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "https://h.example.com", ADMIN_DASHBOARD_URL: "" },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft({ search_metadata: {}, original_query: null }));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(payload.gameTitle).toBe("unknown");
    expect(payload.targetName).toBe("unknown");
  });
});

describe("notifyNewDraft — fail-open", () => {
  it("non lancia errore quando fetch rejecta (network error)", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "https://h.example.com", ADMIN_DASHBOARD_URL: "" },
    }));
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as never;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await expect(notify(makeDraft())).resolves.toBeUndefined();
  });

  it("non lancia errore quando webhook risponde con status non-2xx", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "https://h.example.com", ADMIN_DASHBOARD_URL: "" },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await expect(notify(makeDraft())).resolves.toBeUndefined();
  });

  it("AbortController.signal viene passato a fetch (timeout protection)", async () => {
    vi.doMock("@/config/env.js", () => ({
      env: { ADMIN_WEBHOOK_URL: "https://h.example.com", ADMIN_DASHBOARD_URL: "" },
    }));
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { notifyNewDraft: notify } = await import("./notification.service.js");
    await notify(makeDraft());

    const opts = fetchSpy.mock.calls[0]![1];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
