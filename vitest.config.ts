import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // CJS project with .js import extensions — vitest resolves .js → .ts automatically
    globals: false,
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Sweeps leftover /tmp/uptool-* dirs once the whole suite is done.
    globalSetup: ["test/global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**"],
      // Pure commander wiring, no logic to cover.
      exclude: ["src/cli.ts"],
      // Ratchets set just under the measured baseline so they catch real
      // regressions without tripping on noise.
      //
      // The global figure reads low because v8 only instruments this process:
      // src/commands/* runs in a spawned CLI subprocess, so test/cli.test.ts
      // exercises those commands for real but scores them 0%. The per-glob
      // floor below is the number that actually guards the core.
      thresholds: {
        statements: 63,
        branches: 62,
        functions: 65,
        lines: 62,
        "src/{server,storage,config,lib}/**": {
          statements: 88,
          branches: 78,
          functions: 85,
          lines: 88,
        },
      },
    },
  },
});
