import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  // tsconfig keeps jsx:"preserve" for Next; tests need it compiled.
  esbuild: { jsx: "automatic" },
  test: { include: ["lib/**/*.test.ts", "components/**/*.test.tsx"], environment: "node", testTimeout: 30_000, hookTimeout: 30_000 },
});
