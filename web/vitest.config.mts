import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The `@/` alias tsconfig gives the app. Vitest resolves modules itself
  // and does not read tsconfig paths, so without this any test that pulls
  // in a component fails at import time on the component's own `@/lib/...`
  // imports — nothing to do with the test's own import style.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
