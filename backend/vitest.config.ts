import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Setup file globale: mocka ioredis con ioredis-mock quando un test
    // non mocka esplicitamente @/config/redis.js (evita connessioni reali).
    setupFiles: ["./tests/setup.ts"],

    // Esclude i test di integrazione (richiedono Docker running).
    // Eseguire con: npm run test:integration
    exclude: ["tests/integration/**", "node_modules/**"],

    // Env di test: valori placeholder sufficienti a passare il validator zod in env.ts.
    // I test sono tutti unit (no Postgres/Redis running, no Internet).
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:6432/test",
      POSTGRES_DIRECT_URL: "postgresql://test:test@localhost:5432/test",
      POSTGRES_DB: "test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      REDIS_URL: "redis://localhost:6379",
      GEMINI_API_KEY: "test",
      GOOGLE_EMBEDDING_API_KEY: "test",
      TAVILY_API_KEY: "test",
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

    // REGOLA: "Nessun test deve durare più di 5 secondi."
    testTimeout: 5000,
    hookTimeout: 5000,

    // Coverage v8: baseline aggiornato dopo Fase 22 (auth + llm + cache + normalizer).
    // services lines: 61.17% · global lines: 37.29%
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        "src/index.ts",
        "src/config/**",
        "src/types/**",
        "src/migrations/**",
        "src/scripts/**",
      ],
      thresholds: {
        lines: 35,
        functions: 50,
        branches: 85,
        statements: 35,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
