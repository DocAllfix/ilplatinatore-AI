import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface UserRow {
  id: number;
  email: string | null;
  password_hash: string | null;
  display_name: string | null;
  tier: "free" | "pro" | "platinum";
  language: string;
  total_queries: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  avatar_url: string | null;
  created_at: Date;
  last_active: Date;
}

export interface UserCreate {
  email: string;
  password_hash: string;
  display_name?: string | null;
  tier?: UserRow["tier"];
  language?: string;
}

const USER_COLS = `
  id, email, password_hash, display_name, tier,
  language, total_queries, stripe_customer_id,
  stripe_subscription_id, avatar_url, created_at, last_active
`;

export const UsersModel = {
  async findById(id: number): Promise<UserRow | null> {
    try {
      const res = await query<UserRow>(
        `-- Recupera utente per chiave primaria (profilo, sessione autenticata).
         SELECT ${USER_COLS}
         FROM users
         WHERE id = $1`,
        [id],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "UsersModel.findById failed");
      throw err;
    }
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    try {
      const res = await query<UserRow>(
        `-- Recupera utente per email, incluso password_hash per verifica auth service.
         SELECT ${USER_COLS}
         FROM users
         WHERE email = $1`,
        [email],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err }, "UsersModel.findByEmail failed");
      throw err;
    }
  },

  async create(data: UserCreate): Promise<UserRow> {
    try {
      const res = await query<UserRow>(
        `-- Inserisce nuovo utente; accetta SOLO password_hash, MAI password in chiaro.
         INSERT INTO users (email, password_hash, display_name, tier, language)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLS}`,
        [
          data.email,
          data.password_hash,
          data.display_name ?? null,
          data.tier ?? "free",
          data.language ?? "it",
        ],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err }, "UsersModel.create failed");
      throw err;
    }
  },

  async updateProfile(
    id: number,
    data: { display_name?: string | null; language?: string },
  ): Promise<UserRow | null> {
    try {
      // Costruisce SET dinamico solo per campi forniti — evita di sovrascrivere a null
      // i campi non passati (a differenza di "SET col = COALESCE($1, col)" che soffre
      // di edge-case con il valore null voluto).
      const fields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      if (data.display_name !== undefined) {
        fields.push(`display_name = $${idx++}`);
        values.push(data.display_name);
      }
      if (data.language !== undefined) {
        fields.push(`language = $${idx++}`);
        values.push(data.language);
      }
      if (fields.length === 0) {
        // Niente da aggiornare → ritorna lo stato corrente (idempotente).
        return this.findById(id);
      }
      values.push(id);
      const res = await query<UserRow>(
        `-- Aggiorna campi profilo modificabili dall'utente (display_name, language).
         -- email/tier/password gestiti da altri endpoint dedicati per separation of concerns.
         UPDATE users
         SET ${fields.join(", ")}
         WHERE id = $${idx}
         RETURNING ${USER_COLS}`,
        values,
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "UsersModel.updateProfile failed");
      throw err;
    }
  },

  async updateAvatarUrl(
    id: number,
    avatarUrl: string | null,
  ): Promise<UserRow | null> {
    try {
      const res = await query<UserRow>(
        `-- Aggiorna URL avatar utente. Atomico — ritorna riga aggiornata o null.
         UPDATE users
         SET avatar_url = $2
         WHERE id = $1
         RETURNING ${USER_COLS}`,
        [id, avatarUrl],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id }, "UsersModel.updateAvatarUrl failed");
      throw err;
    }
  },

  async updateTier(
    id: number,
    tier: UserRow["tier"],
  ): Promise<UserRow | null> {
    try {
      const res = await query<UserRow>(
        `-- Aggiorna piano abbonamento utente (free/pro/platinum).
         UPDATE users
         SET tier = $2
         WHERE id = $1
         RETURNING ${USER_COLS}`,
        [id, tier],
      );
      return res.rows[0] ?? null;
    } catch (err) {
      logger.error({ err, id, tier }, "UsersModel.updateTier failed");
      throw err;
    }
  },

  async updateLastActive(id: number): Promise<void> {
    try {
      await query(
        `-- Aggiorna timestamp ultima attività utente (chiamata fire-and-forget).
         UPDATE users SET last_active = NOW() WHERE id = $1`,
        [id],
      );
    } catch (err) {
      logger.error({ err, id }, "UsersModel.updateLastActive failed");
      throw err;
    }
  },

  async incrementTotalQueries(id: number): Promise<void> {
    try {
      await query(
        `-- Incrementa atomicamente il contatore storico query dell'utente.
         UPDATE users SET total_queries = total_queries + 1 WHERE id = $1`,
        [id],
      );
    } catch (err) {
      logger.error({ err, id }, "UsersModel.incrementTotalQueries failed");
      throw err;
    }
  },
};
