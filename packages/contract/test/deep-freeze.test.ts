import { expect, it } from "vitest";

import { deepFreeze } from "../src/deep-freeze.js";

it("freezes nested rows through an already-frozen root", () => {
  const table = deepFreeze(
    Object.freeze({ active: { leasing: "enabled" } }),
  );
  expect(Object.isFrozen(table)).toBe(true);
  expect(Object.isFrozen(table.active)).toBe(true);
  expect(() => {
    (table.active as { leasing: string }).leasing = "disabled";
  }).toThrow();
});

it("terminates on a cyclic structure", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  expect(Object.isFrozen(deepFreeze(value))).toBe(true);
});
