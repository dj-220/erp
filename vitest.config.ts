import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Database tests boot an in-memory Postgres (PGlite) and run migrations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Cheap password hashing keeps login tests fast; production uses the default (2^15).
    env: { ERP_SCRYPT_LOG_N: "10" },
  },
});
