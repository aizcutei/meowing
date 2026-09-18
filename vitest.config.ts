import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the conversion core is plain
// TypeScript, so the tests run in Node and validate output against the real
// sing-box binaries. Loading the Cloudflare plugin here would only get in the way.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
