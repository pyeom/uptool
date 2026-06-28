import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // CJS project with .js import extensions — vitest resolves .js → .ts automatically
    globals: false,
  },
});
