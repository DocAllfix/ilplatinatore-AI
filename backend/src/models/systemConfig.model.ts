import { query } from "@/config/database.js";
import { logger } from "@/utils/logger.js";

export interface SystemConfigRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: Date;
}

export const SystemConfigModel = {
  async get(key: string): Promise<string | null> {
    try {
      const res = await query<Pick<SystemConfigRow, "value">>(
        `-- Recupera singolo parametro di configurazione per chiave primaria.
         SELECT value FROM system_config WHERE key = $1`,
        [key],
      );
      return res.rows[0]?.value ?? null;
    } catch (err) {
      logger.error({ err, key }, "SystemConfigModel.get failed");
      throw err;
    }
  },

  async getAll(): Promise<SystemConfigRow[]> {
    try {
      const res = await query<SystemConfigRow>(
        `-- Recupera tutti i parametri di configurazione ordinati per chiave.
         SELECT key, value, description, updated_at
         FROM system_config
         ORDER BY key`,
      );
      return res.rows;
    } catch (err) {
      logger.error({ err }, "SystemConfigModel.getAll failed");
      throw err;
    }
  },

  async set(key: string, value: string): Promise<SystemConfigRow> {
    try {
      const res = await query<SystemConfigRow>(
        `-- Upsert parametro: inserisce se assente, aggiorna value e updated_at se presente.
         INSERT INTO system_config (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
         RETURNING key, value, description, updated_at`,
        [key, value],
      );
      return res.rows[0]!;
    } catch (err) {
      logger.error({ err, key }, "SystemConfigModel.set failed");
      throw err;
    }
  },

  async getTyped<T>(
    key: string,
    parser: (value: string) => T,
  ): Promise<T | null> {
    try {
      const raw = await SystemConfigModel.get(key);
      if (raw === null) return null;
      return parser(raw);
    } catch (err) {
      logger.error({ err, key }, "SystemConfigModel.getTyped failed");
      throw err;
    }
  },
};
