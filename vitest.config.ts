import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
