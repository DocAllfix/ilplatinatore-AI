import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectImageType } from "./avatar.service.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/models/users.model.js", () => ({
  UsersModel: {
    findById: vi.fn(),
    updateAvatarUrl: vi.fn(),
  },
}));

import { promises as fs } from "node:fs";
import { UsersModel } from "@/models/users.model.js";
import { uploadAvatar } from "./avatar.service.js";
import { ValidationError, NotFoundError } from "@/utils/errors.js";

const mockFs = vi.mocked(fs);
const mockUsers = vi.mocked(UsersModel);

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.mkdir.mockResolvedValue(undefined as never);
  mockFs.writeFile.mockResolvedValue(undefined as never);
  mockFs.unlink.mockResolvedValue(undefined as never);
});

// ── Magic bytes detection ────────────────────────────────────────────────────

describe("detectImageType", () => {
  it("riconosce PNG dalla signature 89 50 4E 47 0D 0A 1A 0A", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectImageType(buf)).toBe("png");
  });

  it("riconosce JPEG dalla signature FF D8 FF", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    expect(detectImageType(buf)).toBe("jpg");
  });

  it("riconosce WEBP dal pattern RIFF....WEBP", () => {
    const buf = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "ascii");
    expect(detectImageType(buf)).toBe("webp");
  });

  it("ritorna null per buffer < 12 byte", () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("ritorna null per file non-immagine (es: testo plain)", () => {
    const buf = Buffer.from("not an image at all here", "ascii");
    expect(detectImageType(buf)).toBeNull();
  });

  it("rifiuta GIF (89a) — non in whitelist", () => {
    const buf = Buffer.from("GIF89a\x00\x00\x00\x00\x00\x00", "ascii");
    expect(detectImageType(buf)).toBeNull();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1,
]);

function makeUser(avatar: string | null = null) {
  return {
    id: 42,
    email: "u@x.com",
    password_hash: "h",
    display_name: null,
    tier: "free" as const,
    language: "it",
    total_queries: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    avatar_url: avatar,
    created_at: new Date(),
    last_active: new Date(),
  };
}

// ── uploadAvatar — validazione MIME ───────────────────────────────────────────

describe("uploadAvatar — validazione MIME/magic bytes", () => {
  it("rifiuta MIME non in whitelist (text/plain)", async () => {
    await expect(
      uploadAvatar({ userId: 42, buffer: PNG_HEADER, mimeType: "text/plain" }),
    ).rejects.toThrow(ValidationError);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("rifiuta buffer non valido come immagine (anti-spoofing magic bytes)", async () => {
    const fake = Buffer.from("<script>alert(1)</script>...........", "ascii");
    await expect(
      uploadAvatar({ userId: 42, buffer: fake, mimeType: "image/png" }),
    ).rejects.toThrow(ValidationError);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("rifiuta MIME=image/png ma magic bytes=jpeg (mismatch)", async () => {
    await expect(
      uploadAvatar({ userId: 42, buffer: JPG_HEADER, mimeType: "image/png" }),
    ).rejects.toThrow(/non corrisponde/i);
  });
});

// ── uploadAvatar — happy path ─────────────────────────────────────────────────

describe("uploadAvatar — happy path", () => {
  it("scrive file PNG e aggiorna avatar_url nel DB", async () => {
    mockUsers.findById.mockResolvedValueOnce(makeUser(null) as never);
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser("/uploads/avatars/x.png") as never);

    const result = await uploadAvatar({
      userId: 42,
      buffer: PNG_HEADER,
      mimeType: "image/png",
    });

    expect(result.avatarUrl).toMatch(/^\/uploads\/avatars\/42-\d+\.png$/);
    expect(mockFs.writeFile).toHaveBeenCalledOnce();
    const writeArgs = mockFs.writeFile.mock.calls[0]!;
    expect(writeArgs[2]).toEqual({ flag: "wx", mode: 0o644 });
    expect(mockUsers.updateAvatarUrl).toHaveBeenCalledOnce();
  });

  it("usa estensione .jpg per JPEG (non .jpeg)", async () => {
    mockUsers.findById.mockResolvedValueOnce(makeUser(null) as never);
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser() as never);

    const result = await uploadAvatar({
      userId: 7,
      buffer: JPG_HEADER,
      mimeType: "image/jpeg",
    });

    expect(result.avatarUrl).toMatch(/^\/uploads\/avatars\/7-\d+\.jpg$/);
  });

  it("filename prefissato dallo userId (anti collision tra utenti)", async () => {
    mockUsers.findById.mockResolvedValueOnce(makeUser(null) as never);
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser() as never);

    await uploadAvatar({ userId: 999, buffer: PNG_HEADER, mimeType: "image/png" });

    const targetPath = mockFs.writeFile.mock.calls[0]![0] as string;
    expect(targetPath).toMatch(/[\\/]999-\d+\.png$/);
  });
});

// ── uploadAvatar — cleanup ────────────────────────────────────────────────────

describe("uploadAvatar — cleanup file precedente", () => {
  it("cancella il file precedente dopo update DB riuscito", async () => {
    const oldUrl = "/uploads/avatars/42-1000000000.png";
    mockUsers.findById.mockResolvedValueOnce(makeUser(oldUrl) as never);
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser() as never);

    await uploadAvatar({ userId: 42, buffer: PNG_HEADER, mimeType: "image/png" });

    expect(mockFs.unlink).toHaveBeenCalledOnce();
    const unlinkPath = mockFs.unlink.mock.calls[0]![0] as string;
    expect(unlinkPath).toContain("42-1000000000.png");
  });

  it("non cancella file se URL precedente è esterno (es: CDN)", async () => {
    mockUsers.findById.mockResolvedValueOnce(
      makeUser("https://cdn.example.com/avatar.png") as never,
    );
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser() as never);

    await uploadAvatar({ userId: 42, buffer: PNG_HEADER, mimeType: "image/png" });

    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  it("non cancella file se URL precedente è null (primo upload)", async () => {
    mockUsers.findById.mockResolvedValueOnce(makeUser(null) as never);
    mockUsers.updateAvatarUrl.mockResolvedValueOnce(makeUser() as never);

    await uploadAvatar({ userId: 42, buffer: PNG_HEADER, mimeType: "image/png" });

    expect(mockFs.unlink).not.toHaveBeenCalled();
  });

  it("se DB UPDATE fallisce, cancella il file appena scritto (no orfani)", async () => {
    mockUsers.findById.mockResolvedValueOnce(makeUser(null) as never);
    mockUsers.updateAvatarUrl.mockRejectedValueOnce(new Error("DB down"));

    await expect(
      uploadAvatar({ userId: 42, buffer: PNG_HEADER, mimeType: "image/png" }),
    ).rejects.toThrow("DB down");

    expect(mockFs.unlink).toHaveBeenCalledOnce();
  });
});

// ── uploadAvatar — utente non trovato ─────────────────────────────────────────

describe("uploadAvatar — utente non trovato", () => {
  it("lancia NotFoundError se utente non esiste", async () => {
    mockUsers.findById.mockResolvedValueOnce(null);

    await expect(
      uploadAvatar({ userId: 999, buffer: PNG_HEADER, mimeType: "image/png" }),
    ).rejects.toThrow(NotFoundError);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
