import RedisModule from "ioredis";
import { env } from "@/config/env.js";
import { logger } from "@/utils/logger.js";

const Redis = RedisModule.default ?? RedisModule;

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("connect", () => {
  logger.info("Redis: connessione stabilita");
});

redis.on("ready", () => {
  logger.info("Redis: pronto a ricevere comandi");
});

redis.on("error", (err: Error) => {
  logger.error({ err }, "Redis: errore di connessione");
});

/**
 * Verifica che la connessione Redis funzioni.
 */
export async function testRedisConnection(): Promise<void> {
  const pong = await redis.ping();
  logger.info({ pong }, "Connessione Redis OK");
}
