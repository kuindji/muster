import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "muster-mcp",
    include: ["test/**/*.test.ts"],
  },
});
