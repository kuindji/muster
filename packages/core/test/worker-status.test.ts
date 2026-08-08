import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/memory-store.js";
import type { WorkerControlPolicy } from "../src/ports.js";
import { ManualClock } from "../src/testing.js";
import { WorkerStatusService } from "../src/worker-status.js";

const NOW = "2026-08-08T10:00:00.000Z";

const policy = (overrides: Partial<WorkerControlPolicy> = {}): WorkerControlPolicy => ({
  probationCheckedSuccesses: 2,
  probationMinimumEnrollmentAge: 60,
  assignSlot: () => 2,
  routingAt: ({ slot, at }) => ({
    contributionWindowId: at.slice(0, 10),
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    slotOpen: true,
  }),
  nextSlot: ({ slot, at }) => ({
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    startsInSeconds: 0,
  }),
  ...overrides,
});

const setup = async (workerState: "active" | "suspended" | "revoked" = "active") => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const registered = await store.registerWorker({
    worker: {
      workerId: "worker-1",
      state: workerState,
      enrolledAt: NOW,
      declaredCapPerWeek: 4,
      capabilities: {
        providerSurface: "provider.example",
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: ["class-b", "class-a"],
      },
      accountCluster: "cluster-1",
      slot: 2,
      contractAcceptance: { contractVersion: "1.1.0", acceptedAt: NOW },
    },
    routing: {
      contributionWindowId: NOW.slice(0, 10),
      contributionUsed: 0,
      assignedSlotOccurrence: "2026-08-08-slot-2",
    },
  });
  if (registered.kind === "conflict") throw new Error("worker registration conflict");
  await store.transitionWorkerRouting({
    expected: registered.routing,
    next: {
      contributionWindowId: NOW.slice(0, 10),
      contributionUsed: 3,
      assignedSlotOccurrence: "2026-08-08-slot-2",
    },
  });
  return store;
};

describe("revision-27 worker status", () => {
  it("returns only coarse status plus internal occurrence identities", async () => {
    const store = await setup();
    const service = new WorkerStatusService({
      store,
      clock: new ManualClock(NOW),
      workerPolicy: policy(),
    });
    expect(await service.getWorkerStatus("worker-1")).toEqual({
      ok: true,
      status: {
        workerId: "worker-1",
        state: "active",
        contractVersion: "1.1.0",
        jobClassIds: ["class-a", "class-b"],
        capUsageBucket: 2,
        nextSlotBucket: 0,
        assignedSlotOccurrence: "2026-08-08-slot-2",
        nextSlotOccurrence: "2026-08-08-slot-2",
      },
    });
  });

  it("uses zero current-window usage after a policy rollover", async () => {
    const store = await setup();
    const service = new WorkerStatusService({
      store,
      clock: new ManualClock(NOW),
      workerPolicy: policy({
        routingAt: ({ slot }) => ({
          contributionWindowId: "2026-W33",
          assignedSlotOccurrence: `2026-W33-slot-${slot}`,
          slotOpen: false,
        }),
        nextSlot: ({ slot }) => ({
          assignedSlotOccurrence: `2026-W33-slot-${slot}`,
          startsInSeconds: 3_601,
        }),
      }),
    });
    const result = await service.getWorkerStatus("worker-1");
    expect(result).toMatchObject({
      ok: true,
      status: { capUsageBucket: 0, nextSlotBucket: 2 },
    });
  });

  it("treats missing and revoked workers as the same unavailable result", async () => {
    const store = await setup("revoked");
    const service = new WorkerStatusService({
      store,
      clock: new ManualClock(NOW),
      workerPolicy: policy(),
    });
    await expect(service.getWorkerStatus("worker-1"))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
    await expect(service.getWorkerStatus("worker-missing"))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("fails closed on inconsistent open-slot projections", async () => {
    const store = await setup();
    const service = new WorkerStatusService({
      store,
      clock: new ManualClock(NOW),
      workerPolicy: policy({
        nextSlot: () => ({
          assignedSlotOccurrence: "different-occurrence",
          startsInSeconds: 60,
        }),
      }),
    });
    await expect(service.getWorkerStatus("worker-1"))
      .resolves.toEqual({ ok: false, kind: "policy_invalid" });
  });
});
