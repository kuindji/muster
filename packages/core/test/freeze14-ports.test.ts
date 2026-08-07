import { describe, expectTypeOf, it } from "vitest";

import type { ClassVersionRecord, Store } from "../src/ports.js";

describe("revision-25 class-health policy-set freeze", () => {
  it("lists every durable class version deterministically", () => {
    type Listed = Awaited<ReturnType<Store["listClassVersions"]>>;
    expectTypeOf<Listed>().toEqualTypeOf<ClassVersionRecord[]>();
  });

  it("atomically compares the policy-bearing version set", () => {
    type Refresh = Parameters<Store["refreshClassHealth"]>[0];
    expectTypeOf<Refresh["expectedClassVersions"]>().toEqualTypeOf<
      ClassVersionRecord[]
    >();

    // @ts-expect-error health refresh cannot omit its complete policy set
    const invalid: Refresh = {
      expectedHealth: {} as Refresh["expectedHealth"],
      expectedLoad: {} as Refresh["expectedLoad"],
      next: {
        health: { operating: "ready" },
        updatedAt: "2026-08-07T15:00:00.000Z",
        source: "automatic",
      },
    };
    void invalid;
  });
});
