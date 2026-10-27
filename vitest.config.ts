import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Lets each worker read vitest's own progress replies between tests (see the file).
    setupFiles: ["tests/helpers/yield-between-tests.ts"],
    // Fixture-backed tool tests (months of synthetic history through the MCP
    // server) can exceed vitest's 5 s default when the whole suite runs in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
