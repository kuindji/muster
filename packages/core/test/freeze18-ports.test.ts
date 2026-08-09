import {
  MUSTER_WIRE_CONTRACT_VERSION,
  type JSONSchema,
} from "@kuindji/muster-contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { LeaseJobResult } from "../src/lease-service.js";

describe("revision-29 MCP result-JSON freeze", () => {
  it("projects only a detached output schema beside the successful lease", () => {
    type SuccessfulLease = Extract<LeaseJobResult, { outcome: "lease" }>;
    expectTypeOf<SuccessfulLease["outputSchema"]>().toEqualTypeOf<JSONSchema>();
    const keys: ReadonlyArray<keyof SuccessfulLease> = [
      "outcome",
      "lease",
      "payload",
      "outputSchema",
    ];
    expect(keys).toHaveLength(4);

    // @ts-expect-error mutable registry handles never cross the lease boundary
    const registryHandle: keyof SuccessfulLease = "runtimeClassEntry";
    void registryHandle;
    expect(MUSTER_WIRE_CONTRACT_VERSION).toBe("1.1.0");
  });
});
