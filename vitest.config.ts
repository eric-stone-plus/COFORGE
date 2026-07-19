import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The canonical suite lives in tests/. Stray local working directories
    // (e.g. an untracked archive/ snapshot) must not leak into npm test.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
