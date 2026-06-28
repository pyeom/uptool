import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["cjs"],
  bundle: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
