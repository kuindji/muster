import { describe, expect, it } from "vitest";

import type {
  ClassHealthSnapshot,
  RegisterWorkerOutcome,
  Store,
  WorkerRegistration,
  WorkerRoutingSnapshot,
} from "../src/ports.js";

const now = "2026-08-06T16:00:00.000Z";

const registration: WorkerRegistration = {
  worker: {
    workerId: "worker-1",
    state: "enrolled",
    enrolledAt: now,
    declaredCapPerWeek: 3,
    capabilities: {
      providerSurface: "provider.example",
      unattendedScheduling: true,
      languages: ["en"],
      jobClassIds: ["class-1"],
    },
    accountCluster: "cluster-1",
    slot: 2,
    contractAcceptance: {
      contractVersion: "1.1.0",
      acceptedAt: now,
    },
  },
  routing: {
    contributionWindowId: "2026-W32",
    contributionUsed: 0,
    assignedSlotOccurrence: "2026-W32-slot-2",
  },
};

describe("revision-15 Store bootstrap port freeze", () => {
  it("registers worker identity and core-prepared routing state atomically", () => {
    type Input = Parameters<Store["registerWorker"]>[0];
    type Outcome = Awaited<ReturnType<Store["registerWorker"]>>;
    const input: Input = registration;
    const outcome: Outcome = {
      kind: "registered",
      worker: registration.worker,
      routing: {
        revision: 1,
        workerId: registration.worker.workerId,
        ...registration.routing,
        openLeaseIds: [],
      },
    };
    expect(outcome.routing.workerId).toBe(input.worker.workerId);

    const invalid: WorkerRegistration = {
      ...registration,
      routing: {
        ...registration.routing,
        // @ts-expect-error registration always starts with zero durable usage
        contributionUsed: 1,
      },
    };
    void invalid;

    // @ts-expect-error revision 15 removes non-atomic worker-only creation
    const removed: keyof Store = "putWorker";
    void removed;
  });

  it("makes absent routing and class-health records explicit", () => {
    type RoutingRead = Awaited<
      ReturnType<Store["getWorkerRoutingSnapshot"]>
    >;
    type HealthRead = Awaited<ReturnType<Store["getClassHealth"]>>;
    const routing: RoutingRead = null;
    const health: HealthRead = null;
    expect([routing, health]).toEqual([null, null]);
  });

  it("transitions complete routing periods while Store owns revisions and leases", () => {
    const expected: WorkerRoutingSnapshot = {
      revision: 4,
      workerId: "worker-1",
      contributionWindowId: "2026-W32",
      contributionUsed: 3,
      assignedSlotOccurrence: "2026-W32-slot-2",
      openLeaseIds: ["lease-1"],
    };
    type Input = Parameters<Store["transitionWorkerRouting"]>[0];
    const input: Input = {
      expected,
      next: {
        contributionWindowId: "2026-W33",
        contributionUsed: 0,
        assignedSlotOccurrence: "2026-W33-slot-2",
      },
    };
    expect(input.next).not.toHaveProperty("revision");
    expect(input.next).not.toHaveProperty("openLeaseIds");
  });

  it("initializes class health through a typed create/replay/conflict command", () => {
    const initial: Omit<ClassHealthSnapshot, "revision"> = {
      classId: "class-1",
      health: {
        operating: "ready",
        reserves: {
          lowCost: "available",
          urgent: "available",
          splitAndAdjudication: "available",
          audit: "available",
        },
      },
      updatedAt: now,
      source: "automatic",
    };
    type Input = Parameters<Store["initializeClassHealth"]>[0];
    const input: Input = { initial };
    expect(input.initial.classId).toBe("class-1");
  });

  it("keeps worker registration outcomes closed and typed", () => {
    const use = (outcome: RegisterWorkerOutcome): string => {
      if (outcome.kind === "conflict") return outcome.existingWorker.workerId;
      return outcome.worker.workerId;
    };
    expect(typeof use).toBe("function");
  });
});
