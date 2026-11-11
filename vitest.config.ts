import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Database tests boot an in-memory Postgres (PGlite) and run migrations.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
