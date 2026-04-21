// Augmentation globale del namespace Express — NON importare da qui per
// evitare cicli di tipi (AccessPayload vive in services/auth.service.ts).
// Il payload è duplicato inline: è una struttura piccola e stabile.
declare namespace Express {
  interface Request {
    requestId: string;
    user?:
      | {
          userId: number;
          email: string | null;
          tier: "free" | "pro" | "platinum";
          iat?: number;
          exp?: number;
        }
      | null;
    sessionId?: string;
  }
}
