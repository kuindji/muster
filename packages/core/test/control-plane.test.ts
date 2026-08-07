import type {
  ClassHealth,
  JobClass,
  Timestamp,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { ControlPlaneService } from "../src/control-plane.js";
import { InMemoryStore } from "../src/memory-store.js";
import type {
  AdmissionHook,
  JobRecord,
  LeaseCandidateSnapshot,
  LeaseRecord,
  WorkerControlPolicy,
  WorkerRoutingSnapshot,
} from "../src/ports.js";
import { RuntimeClassRegistry } from "../src/registration.js";
import { ManualClock, RecordingEventSink } from "../src/testing.js";

const NOW = "2026-08-06T18:00:00.000Z";
const LATER = "2026-08-06T18:01:00.000Z";
const CUTOFF = "2026-08-06T19:00:00.000Z";

const readyHealth = (): ClassHealth => ({
  operating: "ready",
  reserves: {
    lowCost: "available",
    urgent: "available",
    splitAndAdjudication: "available",
    audit: "available",
  },
});

class RecordingAdmission implements AdmissionHook {
  readonly calls: Array<{ workerId: string; declaredCapPerWeek: number }> = [];

  constructor(private readonly decision: { admit: boolean; reason?: string }) {}

  admit(candidate: { workerId: string; declaredCapPerWeek: number }) {
    this.calls.push(structuredClone(candidate));
    return Promise.resolve(this.decision);
  }
}

const workerPolicy = (): WorkerControlPolicy => ({
  probationCheckedSuccesses: 2,
  probationMinimumEnrollmentAge: 60,
  assignSlot: () => 2,
  routingAt: ({ slot, at }) => ({
    contributionWindowId: at.slice(0, 10),
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    slotOpen: true,
  }),
});

const serviceFor = (options: {
  decision?: { admit: boolean; reason?: string };
  policy?: WorkerControlPolicy;
} = {}) => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const clock = new ManualClock(NOW);
  const events = new RecordingEventSink();
  const admission = new RecordingAdmission(options.decision ?? { admit: true });
  const registry = new RuntimeClassRegistry();
  const service = new ControlPlaneService({
    store,
    clock,
    events,
    admission,
    registry,
    workerPolicy: options.policy ?? workerPolicy(),
  });
  return { admission, clock, events, registry, service, store };
};

const registerClass = async (
  store: InMemoryStore,
  registry?: RuntimeClassRegistry,
) => {
  const result = await store.registerClassVersion({
    classId: "class-1",
    contractVersion: "1.0.0",
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
    registeredAt: NOW,
  });
  expect(result.kind).toBe("registered");
  const health = await store.initializeClassHealth({
    initial: {
      classId: "class-1",
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic",
    },
  });
  expect(health.kind).toBe("initialized");
  if (registry !== undefined) {
    registry.load({
      jobClass: {
        id: "class-1",
        contractVersion: "1.0.0",
      } as JobClass<unknown, unknown>,
      payloadSchemaHash: "payload-schema-1",
      outputSchemaHash: "output-schema-1",
    });
  }
};

const enrollment = (workerId = "worker-1") => ({
  workerId,
  declaredCapPerWeek: 4,
  capabilities: {
    providerSurface: "provider.example",
    unattendedScheduling: true,
    languages: ["en"],
    jobClassIds: ["class-1"],
  },
  accountCluster: "cluster-1",
  contractVersion: "1.1.0",
});

const jobRecord = (): JobRecord => ({
  jobId: "job-1",
  classId: "class-1",
  contractVersion: "1.0.0",
  inputHash: "input-job-1",
  payloadRef: "payload-job-1",
  policyVersion: "policy-1",
  permitEpoch: "epoch-1",
  collectionCycle: 1,
  firstEnqueuedAt: NOW,
  cycleStartedAt: NOW,
  rejectedDisputeRequeues: 0,
  queuePriority: {
    lane: "normal",
    value: 10,
    enqueuedAt: NOW,
    sequence: "sequence-job-1",
  },
});

const prepareLease = (
  candidate: LeaseCandidateSnapshot,
  worker: WorkerRoutingSnapshot,
): LeaseRecord => ({
  leaseId: "lease-1",
  jobId: candidate.job.jobId,
  collectionCycle: candidate.job.collectionCycle,
  classId: candidate.job.classId,
  holder: worker.workerId,
  inputHash: candidate.job.inputHash,
  contractVersion: candidate.job.contractVersion,
  policyVersion: candidate.job.policyVersion,
  permitEpoch: candidate.job.permitEpoch,
  payloadRef: candidate.job.payloadRef,
  issuedAt: NOW,
  expiresAt: "2026-08-06T18:15:00.000Z",
  absoluteInFlightDeadline: "2026-08-06T19:00:00.000Z",
  extensionsUsed: 0,
  extensionPolicy: {
    version: "deployment-1",
    extensionTtl: 300,
    maxExtensionsPerLease: 1,
  },
  snapshot: { maxResultBytes: 1_024, maxPayloadBytes: 2_048 },
  assignment: { kind: "ordinary" },
  routing: {
    candidateRevision: candidate.revision,
    workerRevision: worker.revision,
    operational: candidate.operational,
    contributionWindowId: worker.contributionWindowId,
    contributionOrdinal: worker.contributionUsed + 1,
    assignedSlotOccurrence: worker.assignedSlotOccurrence,
    attemptNumber: candidate.attempts.attemptCount + 1,
    queuePriority: candidate.job.queuePriority,
  },
  open: true,
});

const claimLease = async (
  store: InMemoryStore,
  worker: WorkerRoutingSnapshot,
) => {
  const queue = await store.getQueueMode();
  const health = await store.getClassHealth("class-1");
  expect(health).not.toBeNull();
  await expect(store.enqueueJob({
    job: jobRecord(),
    payload: { instruction: "process job-1" },
    expectedOperationalState: {
      queueRevision: queue.revision,
      classHealthRevision: health!.revision,
    },
  })).resolves.toMatchObject({ kind: "enqueued" });
  const candidates = await store.listLeaseCandidates({ classIds: ["class-1"] });
  const candidate = candidates[0];
  expect(candidate).toBeDefined();
  await expect(store.compareAndClaimLease({
    expectedCandidate: candidate!,
    expectedWorker: worker,
    preparedLease: prepareLease(candidate!, worker),
    preparedPayload: { instruction: "process job-1" },
  })).resolves.toMatchObject({ kind: "claimed" });
};

describe("M2 Task 3 contract lifecycle and permit epochs", () => {
  it("requires compatible runtime functions and enforces lifecycle cutoffs", async () => {
    const { clock, events, registry, service, store } = serviceFor();
    await registerClass(store);
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "runtime_not_compatible",
    });
    registry.load({
      jobClass: {
        id: "class-1",
        contractVersion: "1.0.0",
      } as JobClass<unknown, unknown>,
      payloadSchemaHash: "payload-schema-1",
      outputSchemaHash: "output-schema-1",
    });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
    })).resolves.toMatchObject({ ok: true, kind: "applied" });
    expect(await service.leaseEligibility("class-1", "1.0.0"))
      .toMatchObject({ ok: true });

    clock.advance(60);
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
    })).resolves.toMatchObject({ ok: true, kind: "replayed" });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "retired",
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "transition_not_allowed",
    });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "draining",
      acceptedUntil: CUTOFF,
    })).resolves.toMatchObject({
      ok: true,
      kind: "applied",
      record: { leaseDisabledAt: LATER, acceptedUntil: CUTOFF },
    });
    expect(await service.leaseEligibility("class-1", "1.0.0"))
      .toMatchObject({ ok: false, reason: "leasing_disabled" });
    expect(await service.resultAcceptance("class-1", "1.0.0", CUTOFF))
      .toMatchObject({ ok: true });
    expect(await service.resultAcceptance(
      "class-1",
      "1.0.0",
      "2026-08-06T19:00:00.001Z",
    )).toMatchObject({
      ok: false,
      reason: "contract_expired",
      coordinatorFault: true,
    });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draining",
      to: "retired",
      at: "2026-08-06T18:59:59.999Z",
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "accepted_until_not_reached",
    });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draining",
      to: "retired",
      at: CUTOFF,
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "accepted_until_not_reached",
    });
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draining",
      to: "retired",
      at: "2026-08-06T19:00:00.001Z",
    })).resolves.toMatchObject({ ok: true, kind: "applied" });
    expect(registry.get("class-1", "1.0.0")).toBeNull();
    await expect(service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
      at: NOW,
    })).resolves.toMatchObject({ ok: true, kind: "replayed" });
    expect(registry.get("class-1", "1.0.0")).toBeNull();
    expect(events.all().filter((event) => event.type === "contract_transition"))
      .toHaveLength(3);
  });

  it("initializes and ordinarily advances registered class epochs once", async () => {
    const { clock, events, service, store } = serviceFor();
    await expect(service.transitionPermitEpoch({
      classId: "missing-class",
      fromEpoch: null,
      toEpoch: "epoch-1",
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "class_not_registered",
    });
    await registerClass(store);
    await expect(service.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "epoch-1",
      at: NOW,
    })).resolves.toEqual({ ok: true, kind: "applied", currentEpoch: "epoch-1" });
    clock.advance(60);
    await expect(service.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "epoch-1",
      at: NOW,
    })).resolves.toEqual({ ok: true, kind: "replayed", currentEpoch: "epoch-1" });
    await expect(service.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: "stale-epoch",
      toEpoch: "epoch-1",
      at: LATER,
    })).resolves.toEqual({
      ok: false,
      kind: "conflict",
      currentEpoch: "epoch-1",
    });
    await expect(service.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "epoch-conflict",
    })).resolves.toEqual({
      ok: false,
      kind: "conflict",
      currentEpoch: "epoch-1",
    });
    expect(events.all().filter((event) => event.type === "permit_epoch_change"))
      .toHaveLength(1);
  });
});

describe("M2 Task 3 worker enrollment and lifecycle", () => {
  it("derives slot/routing policy and atomically replays immutable enrollment", async () => {
    const { admission, clock, events, service, store } = serviceFor();
    await expect(service.enrollWorker(enrollment())).resolves.toMatchObject({
      ok: true,
      kind: "registered",
      worker: { state: "enrolled", enrolledAt: NOW, slot: 2 },
      routing: {
        revision: 1,
        contributionWindowId: "2026-08-06",
        assignedSlotOccurrence: "2026-08-06-slot-2",
        contributionUsed: 0,
        openLeaseIds: [],
      },
    });
    clock.advance(60);
    await expect(service.enrollWorker(enrollment())).resolves.toMatchObject({
      ok: true,
      kind: "replayed",
      worker: { enrolledAt: NOW, slot: 2 },
    });
    expect(admission.calls).toHaveLength(1);
    expect(events.all().filter((event) => event.type === "enrollment"))
      .toHaveLength(1);

    const changed = enrollment();
    changed.capabilities.languages = ["hy"];
    await expect(service.enrollWorker(changed)).resolves.toMatchObject({
      ok: false,
      kind: "conflict",
    });
    expect((await store.getWorker("worker-1"))?.capabilities.languages)
      .toEqual(["en"]);
  });

  it("fails closed on invalid worker policy output", async () => {
    const invalidPolicy = workerPolicy();
    invalidPolicy.assignSlot = () => -1;
    const { service, store } = serviceFor({ policy: invalidPolicy });
    await expect(service.enrollWorker(enrollment())).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "slot_invalid",
    });
    expect(await store.getWorker("worker-1")).toBeNull();

    const malformedPolicy = workerPolicy();
    malformedPolicy.routingAt = () => undefined as never;
    const malformed = serviceFor({ policy: malformedPolicy });
    await expect(malformed.service.enrollWorker(enrollment("worker-malformed")))
      .resolves.toEqual({
        ok: false,
        kind: "invalid",
        reason: "routing_period_invalid",
      });
    expect(await malformed.store.getWorker("worker-malformed")).toBeNull();
  });

  it("records admission refusal without creating partial state", async () => {
    const { events, service, store } = serviceFor({
      decision: { admit: false, reason: "capacity" },
    });
    await expect(service.enrollWorker(enrollment("worker-denied"))).resolves.toEqual({
      ok: false,
      kind: "admission_denied",
      reason: "capacity",
    });
    expect(await store.getWorker("worker-denied")).toBeNull();
    expect(await store.getWorkerRoutingSnapshot("worker-denied")).toBeNull();
    expect(events.all()).toMatchObject([{
      type: "enrollment",
      outcome: "refused",
      workerId: "worker-denied",
    }]);
  });

  it("blocks the paused probation bypass until success and age gates pass", async () => {
    const { events, service, store } = serviceFor();
    await service.enrollWorker(enrollment());
    await expect(service.pauseWorker("worker-1", "2026-08-06T18:00:10.000Z"))
      .resolves.toMatchObject({ ok: true, kind: "applied" });
    await store.recordReputationEvidence({
      evidenceId: "success-before-enrollment",
      workerId: "worker-1",
      at: "2026-08-06T17:59:59.000Z",
      source: "checked_success",
      impact: "positive",
    });
    await store.recordReputationEvidence({
      evidenceId: "success-1",
      workerId: "worker-1",
      at: "2026-08-06T18:00:20.000Z",
      source: "checked_success",
      impact: "positive",
    });
    await expect(service.resumeWorker("worker-1", LATER)).resolves.toMatchObject({
      ok: false,
      kind: "probation_incomplete",
      checkedSuccesses: 1,
      requiredCheckedSuccesses: 2,
      enrollmentAge: 60,
      requiredEnrollmentAge: 60,
    });
    await store.recordReputationEvidence({
      evidenceId: "success-2",
      workerId: "worker-1",
      at: LATER,
      source: "checked_success",
      impact: "positive",
    });
    await expect(service.resumeWorker("worker-1", LATER)).resolves.toMatchObject({
      ok: true,
      kind: "applied",
      worker: { state: "active" },
    });
    expect(events.all().filter((event) => event.type === "state_change"))
      .toHaveLength(2);
  });

  it("emits one identity-complete requeue audit per suspended lease", async () => {
    const { events, registry, service, store } = serviceFor();
    await registerClass(store, registry);
    await service.transitionClassLifecycle({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
    });
    await service.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "epoch-1",
    });
    await service.enrollWorker(enrollment());
    await store.recordReputationEvidence({
      evidenceId: "success-1",
      workerId: "worker-1",
      at: NOW,
      source: "checked_success",
      impact: "positive",
    });
    await store.recordReputationEvidence({
      evidenceId: "success-2",
      workerId: "worker-1",
      at: LATER,
      source: "checked_success",
      impact: "positive",
    });
    await service.promoteWorker("worker-1", LATER);
    const routing = await store.getWorkerRoutingSnapshot("worker-1");
    expect(routing).not.toBeNull();
    await claimLease(store, routing!);

    const suspendedAt: Timestamp = "2026-08-06T18:02:00.000Z";
    await expect(service.suspendWorker("worker-1", suspendedAt))
      .resolves.toMatchObject({
        ok: true,
        kind: "applied",
        requeuedLeaseCount: 1,
      });
    const appliedEvents = events.all();
    expect(appliedEvents).toContainEqual({
      type: "state_change",
      at: suspendedAt,
      subjectKind: "worker",
      workerId: "worker-1",
      from: "active",
      to: "suspended",
    });
    expect(appliedEvents).toContainEqual({
      type: "lease_requeue",
      at: suspendedAt,
      classId: "class-1",
      jobId: "job-1",
      collectionCycle: 1,
      leaseId: "lease-1",
      workerId: "worker-1",
      providerSurface: "provider.example",
      contractVersion: "1.0.0",
      permitEpoch: "epoch-1",
      reason: "worker_suspended",
    });
    const eventCount = appliedEvents.length;
    await expect(service.suspendWorker("worker-1", suspendedAt))
      .resolves.toMatchObject({ ok: true, kind: "replayed" });
    expect(events.all()).toHaveLength(eventCount);
    expect(await store.getLease("lease-1")).toMatchObject({ open: false });
  });
});
