import { promises as fs } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { logger } from "@/utils/logger.js";
import { UsersModel } from "@/models/users.model.js";
import { ValidationError, NotFoundError } from "@/utils/errors.js";

// ── Costanti ──────────────────────────────────────────────────────────────────

export const AVATAR_DIR_RELATIVE = "uploads/avatars";
// Path assoluto: <cwd>/uploads/avatars (cwd = backend container WORKDIR /app).
const AVATAR_DIR_ABSOLUTE = resolve(process.cwd(), AVATAR_DIR_RELATIVE);
// URL pubblico — il frontend lo concatena al base API URL.
const PUBLIC_PREFIX = "/uploads/avatars";

export const MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AvatarExt = "png" | "jpg" | "webp";

// ── Magic bytes detection (anti MIME-spoofing) ────────────────────────────────

/**
 * Detect del tipo immagine dalle prime byte del buffer (signature).
 * NON ci si fida del Content-Type del client (può essere spoofato).
 * - PNG  : 89 50 4E 47 0D 0A 1A 0A
 * - JPEG : FF D8 FF
 * - WEBP : 52 49 46 46 .. .. .. .. 57 45 42 50  ("RIFF....WEBP")
 */
export function detectImageType(buffer: Buffer): AvatarExt | null {
  if (buffer.length < 12) return null;

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG (FF D8 FF, qualsiasi 4° byte)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }

  // WEBP (RIFF....WEBP)
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

// ── Sicurezza path ────────────────────────────────────────────────────────────

/**
 * Verifica che il path target stia dentro AVATAR_DIR_ABSOLUTE.
 * Difesa in profondità contro path traversal (oltre al fatto che il filename
 * lo costruiamo sempre noi e non veniamo mai dal client).
 */
function assertPathSafe(targetPath: string): void {
  const normalized = resolve(targetPath);
  if (
    normalized !== AVATAR_DIR_ABSOLUTE &&
    !normalized.startsWith(AVATAR_DIR_ABSOLUTE + sep)
  ) {
    throw new ValidationError("Path avatar non valido");
  }
}

// ── Bootstrap: assicura cartella uploads esista al boot ───────────────────────

let dirEnsured = false;

async function ensureAvatarDir(): Promise<void> {
  if (dirEnsured) return;
  await fs.mkdir(AVATAR_DIR_ABSOLUTE, { recursive: true });
  dirEnsured = true;
}

// ── Pubblico: upload + update DB ──────────────────────────────────────────────

export interface UploadAvatarParams {
  userId: number;
  buffer: Buffer;
  mimeType: string;
}

export interface UploadAvatarResult {
  avatarUrl: string;
}

export async function uploadAvatar(
  params: UploadAvatarParams,
): Promise<UploadAvatarResult> {
  const { userId, buffer, mimeType } = params;

  // 1. Validazione MIME dichiarato (cheap check, prima del magic bytes).
  if (!ALLOWED_AVATAR_MIME_TYPES.includes(mimeType as never)) {
    throw new ValidationError(
      `Tipo file non supportato: ${mimeType}. Ammessi: png, jpeg, webp.`,
    );
  }

  // 2. Validazione magic bytes (anti-spoofing).
  const detected = detectImageType(buffer);
  if (!detected) {
    throw new ValidationError(
      "File non riconosciuto come immagine valida (PNG/JPEG/WEBP).",
    );
  }

  // 3. Coerenza MIME ↔ magic bytes (rifiuta png dichiarato che è jpeg vero).
  const expectedMime: Record<AvatarExt, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
  };
  if (mimeType !== expectedMime[detected]) {
    throw new ValidationError(
      "Tipo file dichiarato non corrisponde al contenuto.",
    );
  }

  // 4. Costruisce filename — SEMPRE server-side, MAI dal client.
  await ensureAvatarDir();
  const filename = `${userId}-${Date.now()}.${detected}`;
  const targetPath = join(AVATAR_DIR_ABSOLUTE, filename);
  assertPathSafe(targetPath);
  assertPathSafe(dirname(targetPath));

  // 5. Carica avatar precedente (per cleanup post-update).
  const currentUser = await UsersModel.findById(userId);
  if (!currentUser) throw new NotFoundError("Utente non trovato");
  const previousUrl = currentUser.avatar_url;

  // 6. Scrive il nuovo file (flag wx = exclusive create, race-safe).
  try {
    await fs.writeFile(targetPath, buffer, { flag: "wx", mode: 0o644 });
  } catch (err) {
    logger.error({ err, userId, targetPath }, "avatar.service: write fallita");
    throw err;
  }

  const newUrl = `${PUBLIC_PREFIX}/${filename}`;

  // 7. Aggiorna DB. Su errore, cleanup del file appena scritto.
  try {
    const updated = await UsersModel.updateAvatarUrl(userId, newUrl);
    if (!updated) {
      await safeUnlink(targetPath);
      throw new NotFoundError("Utente non trovato");
    }
  } catch (err) {
    await safeUnlink(targetPath);
    throw err;
  }

  // 8. Cleanup file precedente (best-effort, fail-open).
  if (previousUrl && previousUrl.startsWith(PUBLIC_PREFIX)) {
    const prevFilename = previousUrl.slice(PUBLIC_PREFIX.length + 1);
    const prevPath = join(AVATAR_DIR_ABSOLUTE, prevFilename);
    try {
      assertPathSafe(prevPath);
      await safeUnlink(prevPath);
    } catch (err) {
      logger.warn(
        { err, prevPath },
        "avatar.service: cleanup file precedente fallito (non-fatal)",
      );
    }
  }

  logger.info({ userId, avatarUrl: newUrl }, "avatar caricato");
  return { avatarUrl: newUrl };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, path }, "avatar.service: unlink fallito");
    }
  }
}
