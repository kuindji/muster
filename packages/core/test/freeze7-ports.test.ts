import { describe, expect, it } from "vitest";

import type {
  WorkerControlPolicy,
  WorkerRecord,
  WorkerRoutingPeriod,
} from "../src/ports.js";

const now = "2026-08-06T18:00:00.000Z";

describe("revision-18 worker-control policy freeze", () => {
  it("owns probation thresholds and deterministic routing preparation", () => {
    const policy: WorkerControlPolicy = {
      probationCheckedSuccesses: 3,
      probationMinimumEnrollmentAge: 7 * 24 * 60 * 60,
      assignSlot: ({ workerId }) => workerId.length % 4,
      routingAt: ({ slot, at }) => ({
        contributionWindowId: at.slice(0, 10),
        assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
        slotOpen: true,
      }),
      nextSlot: ({ slot, at }) => ({
        assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
        startsInSeconds: 0,
      }),
    };
    const slot = policy.assignSlot({ workerId: "worker-1", enrolledAt: now });
    expect(policy.routingAt({ workerId: "worker-1", slot, at: now }))
      .toEqual({
        contributionWindowId: "2026-08-06",
        assignedSlotOccurrence: `2026-08-06-slot-${slot}`,
        slotOpen: true,
      });
  });

  it("requires the complete routing result", () => {
    const complete: WorkerRoutingPeriod = {
      contributionWindowId: "2026-W32",
      assignedSlotOccurrence: "2026-W32-slot-2",
      slotOpen: false,
    };
    expect(complete.slotOpen).toBe(false);

    // @ts-expect-error slot eligibility cannot be omitted
    const incomplete: WorkerRoutingPeriod = {
      contributionWindowId: "2026-W32",
      assignedSlotOccurrence: "2026-W32-slot-2",
    };
    void incomplete;
  });

  it("keeps job and payload selectors out of policy inputs", () => {
    type SlotInput = Parameters<WorkerControlPolicy["assignSlot"]>[0];
    type RoutingInput = Parameters<WorkerControlPolicy["routingAt"]>[0];
    const slotKeys: ReadonlyArray<keyof SlotInput> = ["workerId", "enrolledAt"];
    const routingKeys: ReadonlyArray<keyof RoutingInput> = ["workerId", "slot", "at"];
    expect(slotKeys).toEqual(["workerId", "enrolledAt"]);
    expect(routingKeys).toEqual(["workerId", "slot", "at"]);

    // @ts-expect-error policy inputs expose no job content
    const jobKey: keyof RoutingInput = "jobId";
    // @ts-expect-error policy inputs expose no payload content
    const payloadKey: keyof SlotInput = "payload";
    void [jobKey, payloadKey];
  });

  it("does not change the durable worker shape", () => {
    const worker: WorkerRecord = {
      workerId: "worker-1",
      state: "enrolled",
      enrolledAt: now,
      declaredCapPerWeek: 4,
      capabilities: {
        providerSurface: "provider.example",
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: ["class-1"],
      },
      accountCluster: "cluster-1",
      slot: 2,
      contractAcceptance: { contractVersion: "1.1.0", acceptedAt: now },
    };
    expect(worker).not.toHaveProperty("probationCheckedSuccesses");
    expect(worker).not.toHaveProperty("contributionWindowId");
  });
});
