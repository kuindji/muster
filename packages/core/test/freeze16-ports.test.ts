import {
  MUSTER_MCP_ENDPOINT_SCOPE,
  MUSTER_MCP_TOOL_SCOPES,
  MUSTER_WIRE_CONTRACT_VERSION,
  type McpStateStore,
  type McpTokenRevocationSource,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import type { WorkerControlPolicy } from "../src/ports.js";
import type { LeaseService } from "../src/lease-service.js";

describe("revision-27 MCP boundary freeze", () => {
  it("preserves wire 1.1.0 while freezing exact OAuth scopes", () => {
    expect(MUSTER_WIRE_CONTRACT_VERSION).toBe("1.1.0");
    expect(MUSTER_MCP_ENDPOINT_SCOPE).toBe("muster:access");
    expect(MUSTER_MCP_TOOL_SCOPES.lease_job).toBe("muster:jobs");
    expect(MUSTER_MCP_TOOL_SCOPES.get_worker_status).toBe("muster:worker");
  });

  it("adds only worker, slot, and time to the next-slot policy input", () => {
    type Input = Parameters<WorkerControlPolicy["nextSlot"]>[0];
    const keys: ReadonlyArray<keyof Input> = ["workerId", "slot", "at"];
    expect(keys).toEqual(["workerId", "slot", "at"]);

    // @ts-expect-error no job selector crosses into worker policy
    const job: keyof Input = "jobId";
    // @ts-expect-error no availability value crosses into worker policy
    const availability: keyof Input = "availability";
    void [job, availability];
  });

  it("keeps raw OAuth mapping state outside the core Store port", () => {
    type CoreStoreKey = keyof import("../src/ports.js").Store;
    type McpStoreKey = keyof McpStateStore;
    const mcpKeys: McpStoreKey[] = [
      "bindSubject",
      "resolveSubject",
      "severSubject",
      "authorizeCall",
    ];
    expect(mcpKeys).toHaveLength(4);
    // @ts-expect-error core Store has no raw subject resolver
    const rawIdentityLeak: CoreStoreKey = "resolveSubject";
    void rawIdentityLeak;
  });

  it("gives token revocation a hash-only MCP boundary", () => {
    type RevocationInput = Parameters<McpTokenRevocationSource["isRevoked"]>[0];
    const keys: ReadonlyArray<keyof RevocationInput> = [
      "issuer",
      "tokenFingerprintSha256",
      "at",
    ];
    expect(keys).toEqual(["issuer", "tokenFingerprintSha256", "at"]);

    // @ts-expect-error raw bearer bytes never cross the revocation source
    const bearer: keyof RevocationInput = "bearerToken";
    void bearer;
  });

  it("keeps availability outside the singular core lease operation", () => {
    type LeaseArguments = Parameters<LeaseService["leaseJob"]>;
    const exact: LeaseArguments = ["worker-1"];
    expect(exact).toEqual(["worker-1"]);

    // @ts-expect-error availability is MCP state, not a core selector
    const widened: LeaseArguments = ["worker-1", { budget_bucket: 2 }];
    void widened;
  });
});
