import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    passWithNoTests: true,
    // simulated-clock orchestrator tests run several seconds under load (parallel lanes, overnight runs)
    testTimeout: 90_000,
  },
});
