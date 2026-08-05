export default [
  {
    test: {
      name: "workspace",
      include: [],
      passWithNoTests: true,
    },
  },
  "packages/*/vitest.config.ts",
  "gate/*/vitest.config.ts",
];
