import { describe, expect, it } from "vitest";
import {
  CAP_USAGE_BUCKET_MEANINGS,
  MUSTER_MCP_ABANDON_REFUSAL_ERROR,
  MUSTER_MCP_ENDPOINT_SCOPE,
  MUSTER_MCP_JOB_SCOPE,
  MUSTER_MCP_TOOL_OUTCOME_RULES,
  MUSTER_MCP_TOOL_SCOPES,
  MUSTER_MCP_WORKER_SCOPE,
  NEXT_SLOT_BUCKET_MEANINGS,
  capUsageBucket,
  mcpLeasePaddingTargetBytes,
  mcpRateWindow,
  mcpTtlBucketSeconds,
  nextSlotBucket,
  skillReleaseSelectionKey,
  type McpRateLimitPolicy,
} from "../src/index.js";

const policy: McpRateLimitPolicy = {
  version: "rate-1",
  windowSeconds: 60,
  maxCallsPerWindow: {
    lease_job: 4,
    submit_result: 8,
    abandon_job: 4,
    extend_lease: 4,
    get_worker_status: 8,
    set_availability: 4,
  },
  maxLeaseAttemptsPerSlot: 2,
};

describe("revision-28 MCP boundary tables", () => {
  it("uses exact endpoint, job, and worker scopes", () => {
    expect(MUSTER_MCP_ENDPOINT_SCOPE).toBe("muster:access");
    expect(MUSTER_MCP_JOB_SCOPE).toBe("muster:jobs");
    expect(MUSTER_MCP_WORKER_SCOPE).toBe("muster:worker");
    expect(MUSTER_MCP_TOOL_SCOPES).toMatchObject({
      lease_job: "muster:jobs",
      get_worker_status: "muster:worker",
    });
  });

  it("computes cap usage at every exact edge", () => {
    expect(CAP_USAGE_BUCKET_MEANINGS).toHaveProperty("3", "at_cap");
    expect(capUsageBucket(0, 0)).toBe(3);
    expect(capUsageBucket(0, 4)).toBe(0);
    expect(capUsageBucket(1, 4)).toBe(1);
    expect(capUsageBucket(2, 4)).toBe(1);
    expect(capUsageBucket(3, 4)).toBe(2);
    expect(capUsageBucket(4, 4)).toBe(3);
    expect(capUsageBucket(5, 4)).toBe(3);
    expect(capUsageBucket(
      Math.floor(Number.MAX_SAFE_INTEGER / 2),
      Number.MAX_SAFE_INTEGER,
    )).toBe(1);
    expect(() => capUsageBucket(-1, 4)).toThrow(RangeError);
  });

  it("quantizes next-slot distance with an explicit overflow bucket", () => {
    expect(Object.keys(NEXT_SLOT_BUCKET_MEANINGS)).toHaveLength(6);
    expect(nextSlotBucket(0)).toBe(0);
    expect(nextSlotBucket(3_600)).toBe(1);
    expect(nextSlotBucket(3_601)).toBe(2);
    expect(nextSlotBucket(21_600)).toBe(2);
    expect(nextSlotBucket(86_400)).toBe(3);
    expect(nextSlotBucket(259_200)).toBe(4);
    expect(nextSlotBucket(259_201)).toBe(5);
    expect(() => nextSlotBucket(Infinity)).toThrow(RangeError);
  });

  it("selects one release by contract and the canonical complete class set", () => {
    expect(skillReleaseSelectionKey({
      contractVersion: "1.1.0",
      jobClassIds: ["class-b", "class-a"],
    })).toBe(skillReleaseSelectionKey({
      contractVersion: "1.1.0",
      jobClassIds: ["class-a", "class-b"],
    }));
    expect(() => skillReleaseSelectionKey({
      contractVersion: "1.1.0",
      jobClassIds: ["class-a", "class-a"],
    })).toThrow(RangeError);
    expect(() => skillReleaseSelectionKey({
      contractVersion: "1.1.0",
      jobClassIds: [],
    })).toThrow(RangeError);
  });

  it("derives fixed UTC rate windows from reviewed policy", () => {
    expect(mcpRateWindow(policy, "2026-08-08T10:00:30.000Z")).toEqual({
      id: "rate-1:2026-08-08T10:00:00.000Z",
      startsAt: "2026-08-08T10:00:00.000Z",
      endsAt: "2026-08-08T10:01:00.000Z",
    });
    expect(() => mcpRateWindow({ ...policy, windowSeconds: 0 },
      "2026-08-08T10:00:30.000Z")).toThrow(RangeError);
  });

  it("pads the complete encoded lease response and extends the bucket series", () => {
    expect(mcpLeasePaddingTargetBytes(4_000)).toBe(4_096);
    expect(mcpLeasePaddingTargetBytes(4_097)).toBe(16_384);
    expect(mcpLeasePaddingTargetBytes(2_000_000)).toBe(4_194_304);
    expect(() => mcpLeasePaddingTargetBytes(-1)).toThrow(RangeError);
  });

  it("extends TTL buckets by doubling without exposing an exact long expiry", () => {
    expect(mcpTtlBucketSeconds(0)).toBe(300);
    expect(mcpTtlBucketSeconds(301)).toBe(900);
    expect(mcpTtlBucketSeconds(7_200)).toBe(7_200);
    expect(mcpTtlBucketSeconds(7_201)).toBe(14_400);
    expect(mcpTtlBucketSeconds(14_401)).toBe(28_800);
    expect(() => mcpTtlBucketSeconds(-1)).toThrow(RangeError);
    expect(() => mcpTtlBucketSeconds(Number.MAX_SAFE_INTEGER)).toThrow(
      RangeError,
    );
  });

  it("assigns one exact abandon refusal code", () => {
    expect(MUSTER_MCP_ABANDON_REFUSAL_ERROR).toBe("lease_not_held");
  });

  it("freezes one output-vs-tool-error rule for every tool", () => {
    expect(Object.keys(MUSTER_MCP_TOOL_OUTCOME_RULES).sort()).toEqual([
      "abandon_job",
      "extend_lease",
      "get_worker_status",
      "lease_job",
      "set_availability",
      "submit_result",
    ]);
    expect(MUSTER_MCP_TOOL_OUTCOME_RULES.lease_job.domainRefusal)
      .toBe("no_work_success");
    expect(MUSTER_MCP_TOOL_OUTCOME_RULES.set_availability.domainRefusal)
      .toBe("generic_tool_error");
  });
});
