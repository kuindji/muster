import { describe, expect, it } from "vitest";

import {
  CORE_IDENTITY_KINDS,
  CORE_IDENTITY_OWNERSHIP,
  type ClassHealthSnapshot,
  type IdSource,
  type JobRecord,
  type LeaseCandidateSnapshot,
  type LeaseRecord,
  type QueueModeSnapshot,
  type ReserveCharge,
  type Store,
  type WorkerRoutingSnapshot,
} from "../src/ports.js";

const now = "2026-08-06T12:00:00.000Z";
const operational = {
  queueRevision: 1,
  classHealthRevision: 1,
};

const job: JobRecord = {
  jobId: "job-1",
  classId: "class-1",
  contractVersion: "1.0.0",
  inputHash: "input-hash",
  payloadRef: "payload-1",
  policyVersion: "policy-1",
  permitEpoch: "epoch-1",
  collectionCycle: 1,
  firstEnqueuedAt: now,
  cycleStartedAt: now,
  rejectedDisputeRequeues: 0,
  queuePriority: {
    lane: "normal",
    value: 10,
    enqueuedAt: now,
    sequence: "enqueue-1",
  },
};

const candidate: LeaseCandidateSnapshot = {
  revision: 1,
  job,
  attempts: {
    attemptCount: 0,
    openLeaseIds: [],
    acceptedWorkerIds: [],
    acceptedDiversity: [],
  },
  operational,
};

const worker: WorkerRoutingSnapshot = {
  revision: 1,
  workerId: "worker-1",
  contributionWindowId: "2026-W32",
  contributionUsed: 0,
  assignedSlotOccurrence: "2026-W32-slot-3",
  openLeaseIds: [],
};

const lease: LeaseRecord = {
  leaseId: "lease-1",
  jobId: "job-1",
  collectionCycle: 1,
  classId: "class-1",
  holder: "worker-1",
  inputHash: "input-hash",
  contractVersion: "1.0.0",
  policyVersion: "policy-1",
  permitEpoch: "epoch-1",
  payloadRef: "payload-1",
  issuedAt: now,
  expiresAt: "2026-08-06T12:15:00.000Z",
  absoluteInFlightDeadline: "2026-08-06T13:00:00.000Z",
  extensionsUsed: 0,
  extensionPolicy: {
    version: "deployment-1",
    extensionTtl: 300,
    maxExtensionsPerLease: 2,
  },
  snapshot: { maxResultBytes: 1024, maxPayloadBytes: 2048 },
  assignment: { kind: "ordinary" },
  routing: {
    candidateRevision: candidate.revision,
    workerRevision: worker.revision,
    operational,
    contributionWindowId: worker.contributionWindowId,
    contributionOrdinal: 1,
    assignedSlotOccurrence: worker.assignedSlotOccurrence,
    attemptNumber: 1,
    queuePriority: job.queuePriority,
  },
  open: true,
};

describe("revision-14 M2-entry port freeze", () => {
  it("allocates every core-created identity through the closed IdSource port", () => {
    const values = new Map<string, number>();
    const source: IdSource = {
      next: (kind) => `${kind}-${(values.get(kind) ?? 0) + 1}`,
    };
    expect(CORE_IDENTITY_KINDS.map((kind) => source.next(kind))).toEqual([
      "lease-1",
      "result_adjudication_request-1",
      "authorization_request-1",
      "reputation_evidence-1",
    ]);
    expect(CORE_IDENTITY_OWNERSHIP.idSourceAllocated).toEqual(
      CORE_IDENTITY_KINDS,
    );
  });

  it("makes core prepare the complete lease before compare-and-claim", () => {
    type Input = Parameters<Store["compareAndClaimLease"]>[0];
    const input: Input = {
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "work" },
    };
    expect(input.preparedLease.routing.candidateRevision).toBe(
      input.expectedCandidate.revision,
    );
    expect(input.preparedLease.absoluteInFlightDeadline).toBe(
      "2026-08-06T13:00:00.000Z",
    );

    const cannotMutateSnapshot = () => {
      // @ts-expect-error candidate comparison tokens are immutable snapshots
      candidate.revision = 2;
      // @ts-expect-error attempt arrays cannot be mutated after the Store read
      candidate.attempts.openLeaseIds.push("late-lease");
    };
    void cannotMutateSnapshot;

    // @ts-expect-error revision 14 removes Store-owned selection/construction
    const removed: keyof Store = "claimLease";
    void removed;
  });

  it("persists canary identity without worker-authentication subjects", () => {
    const canary: LeaseRecord = {
      ...lease,
      leaseId: "lease-canary",
      assignment: {
        kind: "canary",
        canaryKind: "probation",
        canaryId: "canary-7",
        sourceJobId: "resolved-job-3",
        sourceContractVersion: "1.0.0",
        expectedResultHash: "expected-hash",
      },
    };
    expect(canary.assignment.kind).toBe("canary");
    expect(JSON.stringify(canary)).not.toContain("issuer");
    expect(JSON.stringify(canary)).not.toContain("subject");
  });

  it("binds reserve charges to one class policy and rollover window", () => {
    const charge: ReserveCharge = {
      chargeKey: "charge-1",
      workerIds: ["worker-1"],
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-4",
        windowId: "2026-W32",
        windowStartsAt: "2026-08-03T00:00:00.000Z",
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "urgent",
        laneLimit: 5,
        perWorkerLimit: 1,
      },
    };
    expect(charge.policy.policyVersion).toBe("reserves-4");

    const invalid: ReserveCharge = {
      ...charge,
      // @ts-expect-error non-worker reserve lanes never invent a per-worker cap
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-4",
        windowId: "2026-W32",
        windowStartsAt: now,
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "audit",
        laneLimit: 10,
        perWorkerLimit: 1,
      },
    };
    void invalid;
  });

  it("carries emergency operational state and invalidation in one command", () => {
    const expectedQueue: QueueModeSnapshot = {
      revision: 1,
      mode: "normal",
      updatedAt: now,
    };
    const expectedHealth: ClassHealthSnapshot = {
      revision: 1,
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
    type HaltInput = Parameters<Store["enterEmergencyHalt"]>[0];
    const halt: HaltInput = {
      expectedQueue,
      nextQueue: {
        mode: "emergency_halted",
        updatedAt: now,
      },
      expectedClassHealth: [expectedHealth],
      nextClassHealth: [{
        classId: expectedHealth.classId,
        updatedAt: now,
        source: "operator",
        health: {
          ...expectedHealth.health,
          operating: "emergency_halted",
        },
      }],
      invalidation: {
        scope: { kind: "class", classId: "class-1" },
        expectedTargets: [],
        requeuePlans: [],
      },
      at: now,
    };
    expect(halt.nextQueue.mode).toBe("emergency_halted");
    expect(halt.nextClassHealth[0]?.health.operating).toBe(
      "emergency_halted",
    );
  });
});
