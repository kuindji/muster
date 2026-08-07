import { describe, expectTypeOf, it } from "vitest";

import type {
  AppliedInvalidationOutcome,
  InvalidationSnapshot,
  Store,
} from "../src/ports.js";

describe("revision-24 queue-wide emergency port freeze", () => {
  it("lists the complete class-health comparison set", () => {
    type Listed = Awaited<ReturnType<Store["listClassHealth"]>>;
    expectTypeOf<Listed>().toMatchTypeOf<readonly unknown[]>();
  });

  it("requires one class-qualified invalidation per prepared class", () => {
    type Input = Parameters<Store["enterEmergencyHalt"]>[0];
    expectTypeOf<Input["invalidations"]>().toMatchTypeOf<
      Array<{
        scope: { kind: "class"; classId: string };
        expectedTargets: unknown[];
        requeuePlans: unknown[];
      }>
    >();

    const invalid: Input["invalidations"][number]["scope"] = {
      // @ts-expect-error an emergency batch cannot accept a non-class scope
      kind: "permit_epoch",
      classId: "class-1",
      permitEpoch: "epoch-1",
    };
    void invalid;
  });

  it("returns one class-qualified result per invalidation", () => {
    type Outcome = Awaited<ReturnType<Store["enterEmergencyHalt"]>>;
    type Applied = Extract<Outcome, { kind: "applied" }>;
    type Conflict = Extract<Outcome, { kind: "conflict" }>;
    expectTypeOf<Applied["invalidations"]>().toEqualTypeOf<
      AppliedInvalidationOutcome[]
    >();
    expectTypeOf<Conflict["invalidations"]>().toEqualTypeOf<
      InvalidationSnapshot[]
    >();
  });
});
