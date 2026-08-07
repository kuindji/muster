import { expectTypeOf, describe, it } from "vitest";

import type { ReputationPolicy } from "../src/ports.js";

describe("revision-26 Task-10 review freeze", () => {
  it("makes reputation a worker-eligibility policy in the pull lease protocol", () => {
    type Assessment = ReturnType<ReputationPolicy["assess"]>;
    expectTypeOf<Assessment>().toEqualTypeOf<{ eligible: boolean }>();

    // @ts-expect-error pull-based lease requests have no cross-worker priority set
    const invalid: Assessment = { eligible: true, priority: 1 };
    void invalid;
  });
});
