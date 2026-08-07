import { describe, expect, it } from "vitest";

import type {
  LeaseRecord,
  Store,
  WorkerRoutingSnapshot,
} from "../src/ports.js";

describe("revision-19 lease payload and no-work accounting freeze", () => {
  it("requires every lease to retain its exact operational payload reference", () => {
    const payloadRef: keyof LeaseRecord = "payloadRef";
    type ClaimInput = Parameters<Store["compareAndClaimLease"]>[0];
    const preparedPayload: keyof ClaimInput = "preparedPayload";
    expect([payloadRef, preparedPayload]).toEqual([
      "payloadRef",
      "preparedPayload",
    ]);
  });

  it("makes no-work accounting compare a complete routing snapshot", () => {
    type Input = Parameters<Store["recordNoWorkAttempt"]>[0];
    const keys: ReadonlyArray<keyof Input> = ["expectedWorker", "at"];
    const worker: WorkerRoutingSnapshot = {
      revision: 3,
      workerId: "worker-1",
      contributionWindowId: "2026-W32",
      contributionUsed: 1,
      assignedSlotOccurrence: "2026-W32-slot-2",
      openLeaseIds: [],
    };
    const input: Input = {
      expectedWorker: worker,
      at: "2026-08-07T00:00:00.000Z",
    };
    expect(keys).toEqual(["expectedWorker", "at"]);
    expect(input.expectedWorker).toBe(worker);

    // @ts-expect-error Store owns the next routing revision
    input.nextRevision = 4;
  });
});
