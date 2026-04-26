import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globalSetup: ["./tests/integration/setup.ts"],
    // No setupFiles: integration tests use real Redis and real Postgres — no mocks.
    env: {
      DATABASE_URL:
        "postgresql://platinatore:dev_password_2026@localhost:5432/platinatore_test",
      POSTGRES_DIRECT_URL:
        "postgresql://platinatore:dev_password_2026@localhost:5432/platinatore_test",
      POSTGRES_DB: "platinatore_test",
      POSTGRES_USER: "platinatore",
      POSTGRES_PASSWORD: "dev_password_2026",
      REDIS_URL: "redis://localhost:6379",
      NODE_ENV: "test",
      GEMINI_API_KEY: "test-placeholder-not-used",
      GOOGLE_EMBEDDING_API_KEY: "test-placeholder-not-used",
      WP_API_URL: "https://test.local/wp-json",
      WP_APP_PASSWORD: "test-placeholder-not-used",
      WP_WEBHOOK_SECRET: "test-placeholder-not-used",
      JWT_SECRET: "integration-test-jwt-secret-at-least-32ch",
      JWT_REFRESH_SECRET: "integration-test-refresh-secret-at-32ch",
      CSRF_SECRET: "integration-test-csrf-secret-at-least-32ch",
      STRIPE_SECRET_KEY: "sk_test_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_placeholder_integration",
      STRIPE_PRICE_PRO: "price_placeholder_pro",
      STRIPE_PRICE_PLATINUM: "price_placeholder_platinum",
      CORS_ORIGINS: "http://localhost:3000",
    },
    // Run test files sequentially — one DB, one Redis, no concurrent schema races.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/integration/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
