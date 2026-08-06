import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  platform: "neutral",
  target: "es2022",
  clean: true,
});
