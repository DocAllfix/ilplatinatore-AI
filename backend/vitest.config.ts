import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Env di test: valori placeholder sufficienti a passare il validator zod in env.ts.
    // I test chunkText sono puri e non chiamano Gemini/DB/Redis realmente.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:6432/test",
      POSTGRES_DIRECT_URL: "postgresql://test:test@localhost:5432/test",
      POSTGRES_DB: "test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      REDIS_URL: "redis://localhost:6379",
      GEMINI_API_KEY: "test",
      GOOGLE_EMBEDDING_API_KEY: "test",
      WP_API_URL: "https://test.local/wp-json",
      WP_APP_PASSWORD: "test",
      WP_WEBHOOK_SECRET: "test",
      JWT_SECRET: "test-jwt-secret-at-least-32-chars-long",
      JWT_REFRESH_SECRET: "test-jwt-refresh-secret-at-least-32chars",
      CSRF_SECRET: "test-csrf-secret-at-least-32-chars-long",
      STRIPE_SECRET_KEY: "test",
      STRIPE_WEBHOOK_SECRET: "test",
      STRIPE_PRICE_PRO: "test",
      STRIPE_PRICE_PLATINUM: "test",
      CORS_ORIGINS: "http://localhost:3000",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
