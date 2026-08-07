import type { ClassHealth } from "@kuindji/muster-contract";

import type {
  ClassHealthSnapshot,
  JobRecord,
  LeaseCandidateSnapshot,
  LeaseRecord,
  Store,
  WorkerRegistration,
  WorkerRoutingSnapshot,
} from "./ports.js";

export type StoreFactory = () => Store | Promise<Store>;

export interface StoreConformanceCase {
  readonly id: string;
  readonly run: (factory: StoreFactory) => Promise<void>;
}

const NOW = "2026-08-06T16:00:00.000Z";
const LATER = "2026-08-06T16:01:00.000Z";

const fail = (message: string): never => {
  throw new Error(`Store conformance failure: ${message}`);
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) fail(message);
};

const readyHealth = (): ClassHealth => ({
  operating: "ready",
  reserves: {
    lowCost: "available",
    urgent: "available",
    splitAndAdjudication: "available",
    audit: "available",
  },
});

const workerRegistration = (
  workerId = "worker-1",
  slot = 2,
): WorkerRegistration => ({
  worker: {
    workerId,
    state: "active",
    enrolledAt: NOW,
    declaredCapPerWeek: 4,
    capabilities: {
      providerSurface: "provider.example",
      unattendedScheduling: true,
      languages: ["en"],
      jobClassIds: ["class-1"],
    },
    accountCluster: `cluster-${slot}`,
    slot,
    contractAcceptance: {
      contractVersion: "1.1.0",
      acceptedAt: NOW,
    },
  },
  routing: {
    contributionWindowId: "2026-W32",
    contributionUsed: 0,
    assignedSlotOccurrence: `2026-W32-slot-${slot}`,
  },
});

const jobRecord = (jobId = "job-1"): JobRecord => ({
  jobId,
  classId: "class-1",
  contractVersion: "1.0.0",
  inputHash: `input-${jobId}`,
  payloadRef: `payload-${jobId}`,
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
    sequence: `sequence-${jobId}`,
  },
});

const preparedLease = (
  candidate: LeaseCandidateSnapshot,
  worker: WorkerRoutingSnapshot,
  leaseId: string,
): LeaseRecord => ({
  leaseId,
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
  expiresAt: "2026-08-06T16:15:00.000Z",
  absoluteInFlightDeadline: "2026-08-06T17:00:00.000Z",
  extensionsUsed: 0,
  extensionPolicy: {
    version: "deployment-1",
    extensionTtl: 300,
    maxExtensionsPerLease: 2,
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

const submissionInput = (
  lease: LeaseRecord,
  resultHash = `result-${lease.leaseId}`,
) => ({
  workerId: lease.holder,
  leaseId: lease.leaseId,
  inputHash: lease.inputHash,
  resultHash,
  body: { answer: lease.leaseId },
  receipt: {
    leaseId: lease.leaseId,
    jobId: lease.jobId,
    collectionCycle: lease.collectionCycle,
    inputHash: lease.inputHash,
    resultHash,
    contractVersion: lease.contractVersion,
    permitEpoch: lease.permitEpoch,
    outcome: "accepted" as const,
    acceptedAt: NOW,
  },
});

const initializeClass = async (store: Store): Promise<ClassHealthSnapshot> => {
  const registered = await store.registerClassVersion({
    classId: "class-1",
    contractVersion: "1.0.0",
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
    registeredAt: NOW,
  });
  assert(registered.kind === "registered", "class registration must succeed");
  const health = await store.initializeClassHealth({
    initial: {
      classId: "class-1",
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic",
    },
  });
  assert(health.kind === "initialized", "class health must initialize");
  const activated = await store.transitionClassVersion({
    classId: "class-1",
    contractVersion: "1.0.0",
    from: "draft",
    to: "active",
    at: NOW,
  });
  assert(activated.kind === "applied", "class must activate");
  const epoch = await store.transitionPermitEpoch({
    classId: "class-1",
    fromEpoch: null,
    toEpoch: "epoch-1",
    at: NOW,
  });
  assert(epoch.kind === "applied", "permit epoch must initialize");
  return health.current;
};

const initializeWorker = async (
  store: Store,
  workerId = "worker-1",
  slot = 2,
): Promise<WorkerRoutingSnapshot> => {
  const result = await store.registerWorker(workerRegistration(workerId, slot));
  assert(result.kind === "registered", "worker registration must succeed");
  return result.routing;
};

const enqueue = async (
  store: Store,
  jobId = "job-1",
): Promise<LeaseCandidateSnapshot> => {
  const queue = await store.getQueueMode();
  const health = await store.getClassHealth("class-1");
  assert(health !== null, "class health must exist before enqueue");
  const job = jobRecord(jobId);
  const result = await store.enqueueJob({
    job,
    payload: { instruction: `process ${jobId}` },
    expectedOperationalState: {
      queueRevision: queue.revision,
      classHealthRevision: health.revision,
    },
  });
  assert(result.kind === "enqueued", `${jobId} must enqueue`);
  const candidates = await store.listLeaseCandidates({ classIds: ["class-1"] });
  const candidate = candidates.find((entry) => entry.job.jobId === jobId);
  assert(candidate !== undefined, `${jobId} candidate must be readable`);
  return candidate;
};

const classLifecycleAndEpoch: StoreConformanceCase = {
  id: "class-version-schema-digest-conflict",
  run: async (factory) => {
    const store = await factory();
    const registration = {
      classId: "class-1",
      contractVersion: "1.0.0",
      payloadSchemaHash: "payload-schema-1",
      outputSchemaHash: "output-schema-1",
      registeredAt: NOW,
    };
    const [first, second] = await Promise.all([
      store.registerClassVersion(registration),
      store.registerClassVersion(registration),
    ]);
    assert(first.kind === "registered", "first class registration must win");
    assert(second.kind === "replayed", "identical class registration must replay");
    const conflict = await store.registerClassVersion({
      ...registration,
      outputSchemaHash: "different-output-schema",
    });
    assert(conflict.kind === "conflict", "schema digest reuse must conflict");

    const applied = await store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
      at: NOW,
    });
    const replayed = await store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
      at: NOW,
    });
    assert(applied.kind === "applied", "class transition must apply");
    assert(replayed.kind === "replayed", "class transition must replay");

    const epoch = await store.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "shared-label",
      at: NOW,
    });
    const epochReplay = await store.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "shared-label",
      at: NOW,
    });
    const otherClass = await store.transitionPermitEpoch({
      classId: "class-2",
      fromEpoch: null,
      toEpoch: "shared-label",
      at: NOW,
    });
    assert(epoch.kind === "applied", "initial epoch must apply");
    assert(epochReplay.kind === "replayed", "initial epoch must replay");
    assert(otherClass.kind === "applied", "epochs must be class-qualified");
  },
};

const workerRegistrationCase: StoreConformanceCase = {
  id: "worker-registration-routing-atomic",
  run: async (factory) => {
    const store = await factory();
    const registration = workerRegistration();
    const [first, replay] = await Promise.all([
      store.registerWorker(registration),
      store.registerWorker(registration),
    ]);
    assert(first.kind === "registered", "first worker registration must win");
    assert(replay.kind === "replayed", "identical worker registration must replay");
    assert(first.routing.revision === 1, "routing revision must start at one");
    assert(first.routing.openLeaseIds.length === 0, "new routing must have no leases");

    registration.worker.capabilities.languages.push("fr");
    const persisted = await store.getWorker("worker-1");
    assert(
      persisted?.capabilities.languages.length === 1,
      "Store must clone worker registration input",
    );
    if (persisted !== null) persisted.capabilities.languages.push("de");
    const reread = await store.getWorker("worker-1");
    assert(
      reread?.capabilities.languages.length === 1,
      "Store must clone worker reads",
    );

    const conflict = await store.registerWorker(workerRegistration("worker-1", 3));
    assert(conflict.kind === "conflict", "changed worker registration must conflict");
    const missing = await store.getWorkerRoutingSnapshot("missing-worker");
    assert(missing === null, "unknown worker routing must be null");
  },
};

const classHealthCase: StoreConformanceCase = {
  id: "class-health-initialization-replay-conflict",
  run: async (factory) => {
    const store = await factory();
    assert(await store.getClassHealth("class-1") === null, "unknown health must be null");
    const initial = {
      classId: "class-1",
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic" as const,
    };
    const first = await store.initializeClassHealth({ initial });
    const replay = await store.initializeClassHealth({ initial });
    const conflict = await store.initializeClassHealth({
      initial: {
        ...initial,
        health: { ...initial.health, operating: "admission_halted" },
        source: "operator",
      },
    });
    assert(first.kind === "initialized", "health must initialize");
    assert(replay.kind === "replayed", "identical health must replay");
    assert(conflict.kind === "conflict", "different initial health must conflict");
  },
};

const routingTransitionCase: StoreConformanceCase = {
  id: "worker-routing-period-transition-race",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const initialWorker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: initialWorker,
      preparedLease: preparedLease(candidate, initialWorker, "lease-routing"),
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "routing fixture lease must claim");
    const expected = await store.getWorkerRoutingSnapshot("worker-1");
    assert(expected !== null, "claimed worker routing must exist");
    const firstNext = {
      contributionWindowId: "2026-W33",
      contributionUsed: 0,
      assignedSlotOccurrence: "2026-W33-slot-2",
    };
    const secondNext = {
      contributionWindowId: "2026-W34",
      contributionUsed: 0,
      assignedSlotOccurrence: "2026-W34-slot-2",
    };
    const [first, second] = await Promise.all([
      store.transitionWorkerRouting({ expected, next: firstNext }),
      store.transitionWorkerRouting({ expected, next: secondNext }),
    ]);
    assert(first.kind === "applied", "first routing transition must apply");
    assert(second.kind === "conflict", "stale routing transition must conflict");
    assert(
      first.current.openLeaseIds.includes("lease-routing"),
      "routing transition must preserve Store-owned open leases",
    );
    const replay = await store.transitionWorkerRouting({ expected, next: firstNext });
    assert(replay.kind === "replayed", "routing transition must replay exactly");
  },
};

const claimRaceCase: StoreConformanceCase = {
  id: "candidate-compare-and-claim-single-winner",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const firstLease = preparedLease(candidate, worker, "lease-1");
    const losingLease = preparedLease(candidate, worker, "lease-losing");
    const [first, second] = await Promise.all([
      store.compareAndClaimLease({
        expectedCandidate: candidate,
        expectedWorker: worker,
        preparedLease: firstLease,
        preparedPayload: { instruction: "process job-1" },
      }),
      store.compareAndClaimLease({
        expectedCandidate: candidate,
        expectedWorker: worker,
        preparedLease: losingLease,
        preparedPayload: { instruction: "process job-1" },
      }),
    ]);
    assert(first.kind === "claimed", "one prepared lease must win");
    assert(second.kind === "conflict", "the stale prepared lease must lose");
    assert(await store.getLease("lease-losing") === null, "losing ID must leave no state");
    const replay = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: firstLease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(replay.kind === "claimed", "exact claim must replay the persisted identity");
  },
};

const identityCollisionCase: StoreConformanceCase = {
  id: "core-id-collision-refused",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const firstWorker = await initializeWorker(store, "worker-1", 1);
    const firstCandidate = await enqueue(store, "job-1");
    const first = await store.compareAndClaimLease({
      expectedCandidate: firstCandidate,
      expectedWorker: firstWorker,
      preparedLease: preparedLease(firstCandidate, firstWorker, "lease-shared"),
      preparedPayload: { instruction: "process job-1" },
    });
    assert(first.kind === "claimed", "first identity use must claim");

    const secondWorker = await initializeWorker(store, "worker-2", 2);
    const secondCandidate = await enqueue(store, "job-2");
    const collision = await store.compareAndClaimLease({
      expectedCandidate: secondCandidate,
      expectedWorker: secondWorker,
      preparedLease: preparedLease(secondCandidate, secondWorker, "lease-shared"),
      preparedPayload: { instruction: "process job-2" },
    });
    assert(
      collision.kind === "conflict" && collision.reason === "identity_collision",
      "reused durable lease identity must conflict",
    );
    const existing = await store.getLease("lease-shared");
    assert(existing?.jobId === "job-1", "identity collision must not replace state");
  },
};

const losingClaimIdentityCase: StoreConformanceCase = {
  id: "losing-claim-id-leaves-no-state",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const queue = await store.getQueueMode();
    const changed = await store.transitionQueueMode({
      expected: queue,
      next: { mode: "degraded", updatedAt: LATER },
    });
    assert(changed.kind === "applied", "queue transition must apply");
    const claim = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: preparedLease(candidate, worker, "lease-skipped"),
      preparedPayload: { instruction: "process job-1" },
    });
    assert(
      claim.kind === "conflict" && claim.reason === "operational_state_stale",
      "stale operational snapshot must refuse claim",
    );
    assert(
      await store.getLease("lease-skipped") === null,
      "losing IdSource value must leave no durable state",
    );
  },
};

const workerStateCase: StoreConformanceCase = {
  id: "worker-suspension-requeues-open-leases",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-1");
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "lease must exist before suspension");
    const suspended = await store.transitionWorkerState({
      workerId: "worker-1",
      from: "active",
      to: "suspended",
      at: LATER,
    });
    assert(suspended.kind === "applied", "suspension must apply");
    assert(suspended.requeuedOpenLeases.length === 1, "suspension must requeue lease");
    assert(
      suspended.requeuedOpenLeases[0]?.contractVersion === "1.0.0" &&
        suspended.requeuedOpenLeases[0]?.permitEpoch === "epoch-1",
      "requeue identity must retain contract version and permit epoch for audit",
    );
    const closed = await store.getLease("lease-1");
    assert(closed?.open === false, "suspension must close lease atomically");
    const routing = await store.getWorkerRoutingSnapshot("worker-1");
    assert(routing?.openLeaseIds.length === 0, "suspension must clear routing leases");
  },
};

const workerStateFenceCase: StoreConformanceCase = {
  id: "worker-state-transition-fences-prepared-claim",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const transitioned = await store.transitionWorkerState({
      workerId: "worker-1",
      from: "active",
      to: "maintenance",
      at: LATER,
    });
    assert(transitioned.kind === "applied", "worker state transition must apply");
    const claim = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: preparedLease(candidate, worker, "lease-stale-worker"),
      preparedPayload: { instruction: "process job-1" },
    });
    assert(
      claim.kind === "conflict" && claim.reason === "worker_snapshot_stale",
      "worker-state transition must fence prepared claim",
    );
  },
};

const noWorkContributionCase: StoreConformanceCase = {
  id: "no-work-contribution-single-winner",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const leaseId = "lease-no-work-open";
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: preparedLease(candidate, worker, leaseId),
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "no-work fixture lease must claim");
    const expected = await store.getWorkerRoutingSnapshot(worker.workerId);
    assert(expected !== null, "claimed worker routing must exist");

    const incompleteComparison = await store.recordNoWorkAttempt({
      expectedWorker: {
        ...expected,
        contributionUsed: expected.contributionUsed + 1,
      },
      at: NOW,
    });
    assert(
      incompleteComparison.kind === "conflict",
      "no-work must compare the complete routing snapshot, not only its revision",
    );

    const [first, second] = await Promise.all([
      store.recordNoWorkAttempt({ expectedWorker: expected, at: NOW }),
      store.recordNoWorkAttempt({ expectedWorker: expected, at: NOW }),
    ]);
    assert(
      [first, second].filter((outcome) => outcome.kind === "recorded").length === 1,
      "one no-work occurrence must record",
    );
    assert(
      [first, second].filter((outcome) => outcome.kind === "conflict").length === 1,
      "one stale no-work occurrence must conflict",
    );
    const current = await store.getWorkerRoutingSnapshot(worker.workerId);
    assert(
      current?.contributionUsed === expected.contributionUsed + 1,
      "no-work must consume one contribution",
    );
    assert(
      current.openLeaseIds.length === 1 && current.openLeaseIds[0] === leaseId,
      "no-work must preserve the Store-owned open-lease set",
    );

    const routingStore = await factory();
    const routingWorker = await initializeWorker(routingStore);
    const routed = await routingStore.transitionWorkerRouting({
      expected: routingWorker,
      next: {
        contributionWindowId: "2026-W33",
        contributionUsed: 0,
        assignedSlotOccurrence: "2026-W33-slot-2",
      },
    });
    assert(routed.kind === "applied", "routing transition must apply");
    const afterRouting = await routingStore.recordNoWorkAttempt({
      expectedWorker: routingWorker,
      at: NOW,
    });
    assert(
      afterRouting.kind === "conflict",
      "routing transition must fence a stale no-work occurrence",
    );

    const stateStore = await factory();
    const stateWorker = await initializeWorker(stateStore);
    const transitioned = await stateStore.transitionWorkerState({
      workerId: stateWorker.workerId,
      from: "active",
      to: "maintenance",
      at: LATER,
    });
    assert(transitioned.kind === "applied", "worker-state transition must apply");
    const afterState = await stateStore.recordNoWorkAttempt({
      expectedWorker: stateWorker,
      at: NOW,
    });
    assert(
      afterState.kind === "conflict",
      "worker-state transition must fence a stale no-work occurrence",
    );
  },
};

const canaryPayloadCase: StoreConformanceCase = {
  id: "canary-payload-claim-atomic",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const mismatched = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: preparedLease(candidate, worker, "lease-mismatch"),
      preparedPayload: { instruction: "different payload" },
    });
    assert(
      mismatched.kind === "conflict" && mismatched.reason === "unclaimable",
      "ordinary claim must compare the exact durable payload",
    );
    assert(
      await store.getLease("lease-mismatch") === null,
      "payload mismatch must leave no lease",
    );
    const canaryPayload = { instruction: "known canary" } as const;
    const unownedPayloadRef = "payload-unowned-canary";
    const unowned = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: {
        ...preparedLease(candidate, worker, "lease-unowned-canary"),
        inputHash: "input-unowned-canary",
        payloadRef: unownedPayloadRef,
        assignment: {
          kind: "canary",
          canaryKind: "production",
          canaryId: "canary-1",
          sourceJobId: "resolved-1",
          sourceContractVersion: "1.0.0",
          expectedResultHash: "expected-result-1",
        },
      },
      preparedPayload: canaryPayload,
    });
    assert(
      unowned.kind === "conflict" && unowned.reason === "unclaimable",
      "canary payload reference must reuse the prepared lease identity",
    );
    assert(
      await store.getPayload(unownedPayloadRef) === null,
      "unowned canary payload reference must leave no alias",
    );
    const canaryLease: LeaseRecord = {
      ...preparedLease(candidate, worker, "lease-canary"),
      inputHash: "input-canary",
      payloadRef: "lease-canary",
      assignment: {
        kind: "canary",
        canaryKind: "production",
        canaryId: "canary-1",
        sourceJobId: "resolved-1",
        sourceContractVersion: "1.0.0",
        expectedResultHash: "expected-result-1",
      },
    };
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: canaryLease,
      preparedPayload: canaryPayload,
    });
    assert(claimed.kind === "claimed", "canary payload claim must succeed");
    assert(
      canaryLease.payloadRef === canaryLease.leaseId,
      "canary payload reference must reuse its IdSource lease identity",
    );
    assert(
      JSON.stringify(await store.getPayload(canaryLease.payloadRef)) ===
        JSON.stringify(canaryPayload),
      "canary payload must persist under the lease reference",
    );
    assert(
      JSON.stringify(await store.getPayload(candidate.job.payloadRef)) ===
        JSON.stringify({ instruction: "process job-1" }),
      "canary claim must preserve the displaced job payload",
    );

    const losingStore = await factory();
    await initializeClass(losingStore);
    const losingWorker = await initializeWorker(losingStore);
    const losingCandidate = await enqueue(losingStore);
    const queue = await losingStore.getQueueMode();
    const advanced = await losingStore.transitionQueueMode({
      expected: queue,
      next: { mode: "degraded", updatedAt: LATER },
    });
    assert(advanced.kind === "applied", "losing canary setup must advance queue");
    const losingPayloadRef = "lease-losing-canary";
    const losing = await losingStore.compareAndClaimLease({
      expectedCandidate: losingCandidate,
      expectedWorker: losingWorker,
      preparedLease: {
        ...preparedLease(losingCandidate, losingWorker, "lease-losing-canary"),
        inputHash: "input-losing-canary",
        payloadRef: losingPayloadRef,
        assignment: canaryLease.assignment,
      },
      preparedPayload: canaryPayload,
    });
    assert(losing.kind === "conflict", "stale canary claim must lose");
    assert(
      await losingStore.getPayload(losingPayloadRef) === null,
      "losing canary claim must leave no payload alias",
    );

    const collisionStore = await factory();
    await initializeClass(collisionStore);
    const collisionWorker = await initializeWorker(collisionStore);
    const collisionCandidate = await enqueue(collisionStore);
    const collisionLeaseId = "payload-job-collision";
    await enqueue(collisionStore, "job-collision");
    const existingPayload = await collisionStore.getPayload(collisionLeaseId);
    const collision = await collisionStore.compareAndClaimLease({
      expectedCandidate: collisionCandidate,
      expectedWorker: collisionWorker,
      preparedLease: {
        ...preparedLease(
          collisionCandidate,
          collisionWorker,
          collisionLeaseId,
        ),
        inputHash: "input-colliding-canary",
        payloadRef: collisionLeaseId,
        assignment: canaryLease.assignment,
      },
      preparedPayload: canaryPayload,
    });
    assert(
      collision.kind === "conflict" && collision.reason === "unclaimable",
      "canary payload-reference collision must refuse the claim",
    );
    assert(
      await collisionStore.getLease(collisionLeaseId) === null,
      "payload-reference collision must leave no lease",
    );
    assert(
      JSON.stringify(await collisionStore.getPayload(collisionLeaseId)) ===
        JSON.stringify(existingPayload),
      "payload-reference collision must preserve the existing payload",
    );
  },
};

const workerLeaseBindingCase: StoreConformanceCase = {
  id: "worker-id-binding-rejects-other-holder",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-holder-bound");
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "holder-bound lease must claim");
    const extended = await store.extendLease({
      workerId: "other-worker",
      leaseId: lease.leaseId,
      expectedExpiry: lease.expiresAt,
      expectedExtensionsUsed: 0,
      newExpiry: "2026-08-06T16:20:00.000Z",
      newExtensionsUsed: 1,
    });
    assert(extended.kind === "refused", "other worker must not extend a lease");
    const abandoned = await store.abandonLease({
      workerId: "other-worker",
      leaseId: lease.leaseId,
      classification: "abandoned_before_payload",
      requeue: { sameCyclePermitEpoch: "epoch-1" },
      at: LATER,
    });
    assert(abandoned.kind === "refused", "other worker must not abandon a lease");
    assert((await store.getLease(lease.leaseId))?.open, "refusals must preserve lease");
  },
};

const extensionDeadlineCase: StoreConformanceCase = {
  id: "extension-deadline-strict",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease: LeaseRecord = {
      ...preparedLease(candidate, worker, "lease-deadline"),
      absoluteInFlightDeadline: "2026-08-06T16:20:00.000Z",
    };
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "deadline lease must claim");
    const extension = await store.extendLease({
      workerId: worker.workerId,
      leaseId: lease.leaseId,
      expectedExpiry: lease.expiresAt,
      expectedExtensionsUsed: 0,
      newExpiry: lease.absoluteInFlightDeadline,
      newExtensionsUsed: 1,
    });
    assert(extension.kind === "refused", "deadline equality must refuse");
    const current = await store.getLease(lease.leaseId);
    assert(current?.expiresAt === lease.expiresAt, "refusal must preserve expiry");
    assert(current?.extensionsUsed === 0, "refusal must preserve extension count");
  },
};

const expiryRequeueCase: StoreConformanceCase = {
  id: "expiry-requeue-atomic",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-expiring");
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "expiring lease must claim");
    await store.expireAndRequeue(lease.leaseId, {
      sameCyclePermitEpoch: "epoch-1",
    });
    assert((await store.getLease(lease.leaseId))?.open === false, "expiry must close");
    const after = await store.listLeaseCandidates({ classIds: ["class-1"] });
    assert(after.length === 1, "expiry must expose one same-cycle candidate");
    assert(after[0]?.job.collectionCycle === 1, "expiry must stay in cycle");
    assert(after[0]?.attempts.openLeaseIds.length === 0, "requeue must be atomic");
    const routing = await store.getWorkerRoutingSnapshot(worker.workerId);
    assert(routing?.contributionUsed === 0, "no-fault expiry must release contribution");
  },
};

const stickyEpochRequeueCase: StoreConformanceCase = {
  id: "epoch-sticky-through-requeue",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-abandoned");
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "abandonment lease must claim");
    const advancedEpoch = await store.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: "epoch-1",
      toEpoch: "epoch-2",
      at: LATER,
    });
    assert(advancedEpoch.kind === "applied", "current epoch must advance");
    const wrongEpoch = await store.abandonLease({
      workerId: worker.workerId,
      leaseId: lease.leaseId,
      classification: "provider_or_platform_failure",
      requeue: { sameCyclePermitEpoch: "epoch-other" },
      at: LATER,
    });
    assert(wrongEpoch.kind === "refused", "same-cycle epoch mismatch must refuse");
    const recorded = await store.abandonLease({
      workerId: worker.workerId,
      leaseId: lease.leaseId,
      classification: "provider_or_platform_failure",
      requeue: { sameCyclePermitEpoch: "epoch-1" },
      at: LATER,
    });
    assert(recorded.kind === "recorded", "matching epoch abandonment must record");
    const after = await store.listLeaseCandidates({ classIds: ["class-1"] });
    assert(after[0]?.job.collectionCycle === 1, "abandonment must stay in cycle");
    assert(after[0]?.job.permitEpoch === "epoch-1", "cycle epoch must stay stamped");
    const routing = await store.getWorkerRoutingSnapshot(worker.workerId);
    assert(
      routing?.contributionUsed === 1,
      "provider failure must retain its fair-attempt contribution",
    );

    const expiryStore = await factory();
    await initializeClass(expiryStore);
    const expiryWorker = await initializeWorker(expiryStore);
    const expiryCandidate = await enqueue(expiryStore);
    const expiryLease = preparedLease(
      expiryCandidate,
      expiryWorker,
      "lease-old-epoch-expiry",
    );
    await expiryStore.compareAndClaimLease({
      expectedCandidate: expiryCandidate,
      expectedWorker: expiryWorker,
      preparedLease: expiryLease,
      preparedPayload: { instruction: "process job-1" },
    });
    await expiryStore.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: "epoch-1",
      toEpoch: "epoch-2",
      at: LATER,
    });
    await expiryStore.expireAndRequeue(expiryLease.leaseId, {
      sameCyclePermitEpoch: "epoch-1",
    });
    assert(
      (await expiryStore.getLease(expiryLease.leaseId))?.open === false,
      "expiry must settle under the lease-stamped epoch after current epoch advances",
    );
  },
};

const submissionIdempotencyCase: StoreConformanceCase = {
  id: "submit-idempotency-exact-triple",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-submit");
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    assert(claimed.kind === "claimed", "submission lease must claim");
    const input = {
      ...submissionInput(lease),
      reputationEvidence: {
        evidenceId: "evidence-submit",
        workerId: worker.workerId,
        at: NOW,
        job: { jobId: lease.jobId, collectionCycle: lease.collectionCycle },
        source: "checked_success" as const,
        impact: "positive" as const,
      },
    };
    const [first, replay] = await Promise.all([
      store.acceptOrReplaySubmission(input),
      store.acceptOrReplaySubmission(input),
    ]);
    assert(first.kind === "accepted", "first submission must accept");
    assert(replay.kind === "replayed", "exact concurrent submit must replay");
    assert(
      JSON.stringify(first.receipt) === JSON.stringify(replay.receipt),
      "submission replay receipt must be byte-identical",
    );
    const persisted = await store.getAcceptedSubmission(lease.leaseId);
    assert(
      JSON.stringify(persisted) === JSON.stringify({
        receipt: input.receipt,
        body: input.body,
      }),
      "accepted body and receipt must persist together",
    );
    const replicas = await store.listAcceptedReplicas(lease.jobId, 1);
    assert(replicas.length === 1, "ordinary acceptance must add one replica");
    assert(
      (await store.getWorkerRoutingSnapshot(worker.workerId))?.contributionUsed === 1,
      "successful submission must retain its contribution occurrence",
    );
    assert(
      (await store.listReputationEvidence(worker.workerId)).length === 1,
      "checked evidence must commit with acceptance",
    );
  },
};

const conflictingSubmissionCase: StoreConformanceCase = {
  id: "conflicting-retry-preserves-accepted-row",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-conflict");
    await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    const input = submissionInput(lease);
    const accepted = await store.acceptOrReplaySubmission(input);
    assert(accepted.kind === "accepted", "baseline submission must accept");
    const conflict = await store.acceptOrReplaySubmission({
      ...input,
      resultHash: "different-result",
      receipt: { ...input.receipt, resultHash: "different-result" },
    });
    assert(conflict.kind === "conflict", "different result must conflict");
    assert(
      (await store.getAcceptedSubmission(lease.leaseId))?.receipt.resultHash ===
        input.resultHash,
      "conflict must preserve the accepted row",
    );
    const wrongHolder = await store.acceptOrReplaySubmission({
      ...input,
      workerId: "worker-other",
    });
    assert(
      wrongHolder.kind === "refused" && wrongHolder.error === "lease_not_held",
      "holder binding must precede replay disclosure",
    );
  },
};

const invalidSubmissionSettlementCase: StoreConformanceCase = {
  id: "invalid-submission-settlement-atomic",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-invalid");
    await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    const rejection = {
      workerId: worker.workerId,
      leaseId: lease.leaseId,
      classification: "rejected_invalid" as const,
      at: LATER,
      reputationEvidence: {
        evidenceId: "evidence-invalid",
        workerId: worker.workerId,
        at: LATER,
        job: { jobId: lease.jobId, collectionCycle: lease.collectionCycle },
        source: "structural_failure" as const,
        impact: "negative" as const,
      },
    };
    const recorded = await store.rejectSubmission(rejection);
    assert(recorded.kind === "recorded", "invalid submission must settle");
    assert(
      (await store.getLease(lease.leaseId))?.open === false,
      "invalid settlement must close the lease",
    );
    assert(
      (await store.getWorkerRoutingSnapshot(worker.workerId))?.contributionUsed === 0,
      "invalid settlement must release current-window contribution",
    );
    assert(
      (await store.listReputationEvidence(worker.workerId))[0]?.source ===
        "structural_failure",
      "invalid evidence must commit with lease settlement",
    );
    assert(
      (await store.rejectSubmission(rejection)).kind === "replayed",
      "exact invalid settlement must replay",
    );
    assert(
      (await store.acceptOrReplaySubmission(submissionInput(lease))).kind ===
        "refused",
      "settled invalid lease must not later accept",
    );
  },
};

const canarySubmissionProjectionCase: StoreConformanceCase = {
  id: "canary-submission-excluded-from-replicas",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease: LeaseRecord = {
      ...preparedLease(candidate, worker, "lease-canary-submit"),
      inputHash: "input-canary-submit",
      payloadRef: "lease-canary-submit",
      assignment: {
        kind: "canary",
        canaryKind: "probation",
        canaryId: "canary-submit",
        sourceJobId: "resolved-source",
        sourceContractVersion: candidate.job.contractVersion,
        expectedResultHash: "result-canary-expected",
      },
    };
    const claim = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "canary" },
    });
    assert(claim.kind === "claimed", "canary submission lease must claim");
    const accepted = await store.acceptOrReplaySubmission({
      ...submissionInput(lease, "result-canary-actual"),
      reputationEvidence: {
        evidenceId: "evidence-canary",
        workerId: worker.workerId,
        at: NOW,
        job: { jobId: lease.jobId, collectionCycle: lease.collectionCycle },
        source: "held_out_canary",
        impact: "negative",
      },
    });
    assert(accepted.kind === "accepted", "canary receipt must accept");
    assert(
      (await store.listAcceptedReplicas(lease.jobId, lease.collectionCycle)).length === 0,
      "canary must not enter ordinary accepted replicas",
    );
    assert(
      (await store.getAcceptedSubmission(lease.leaseId))?.receipt.resultHash ===
        "result-canary-actual",
      "canary receipt must remain replayable",
    );
    const current = (await store.listLeaseCandidates({ classIds: [lease.classId] }))[0];
    assert(
      current?.attempts.acceptedWorkerIds.length === 0,
      "canary worker must remain eligible for the displaced ordinary job",
    );
  },
};

const contractExpirySettlementCase: StoreConformanceCase = {
  id: "contract-expiry-settlement-atomic",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-contract-expired");
    await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    const draining = await store.transitionClassVersion({
      classId: lease.classId,
      contractVersion: lease.contractVersion,
      from: "active",
      to: "draining",
      at: NOW,
      leaseDisabledAt: NOW,
      acceptedUntil: NOW,
    });
    assert(draining.kind === "applied", "class must begin draining");
    const input = submissionInput(lease);
    const expired = await store.acceptOrReplaySubmission({
      ...input,
      receipt: { ...input.receipt, acceptedAt: LATER },
    });
    assert(
      expired.kind === "refused" && expired.error === "contract_expired",
      "acceptance must observe contract expiry in its transaction",
    );
    assert(
      (await store.getLease(lease.leaseId))?.open === false,
      "contract expiry must settle the lease atomically",
    );
    assert(
      (await store.getWorkerRoutingSnapshot(worker.workerId))?.contributionUsed === 1,
      "coordinator fault must retain contribution",
    );
  },
};

const splitEvidenceFenceCase: StoreConformanceCase = {
  id: "split-marker-evidence-fenced",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const firstWorker = await initializeWorker(store, "worker-1", 1);
    const firstCandidate = await enqueue(store);
    const firstLease = preparedLease(firstCandidate, firstWorker, "lease-split-1");
    await store.compareAndClaimLease({
      expectedCandidate: firstCandidate,
      expectedWorker: firstWorker,
      preparedLease: firstLease,
      preparedPayload: { instruction: "process job-1" },
    });
    await store.acceptOrReplaySubmission(submissionInput(firstLease, "result-a"));

    const secondWorker = await initializeWorker(store, "worker-2", 2);
    const candidates = await store.listLeaseCandidates({ classIds: ["class-1"] });
    const secondCandidate = candidates[0];
    assert(secondCandidate !== undefined, "second replica candidate must exist");
    const secondLease = preparedLease(secondCandidate, secondWorker, "lease-split-2");
    await store.compareAndClaimLease({
      expectedCandidate: secondCandidate,
      expectedWorker: secondWorker,
      preparedLease: secondLease,
      preparedPayload: { instruction: "process job-1" },
    });
    await store.acceptOrReplaySubmission(submissionInput(secondLease, "result-b"));
    const evidence = (await store.listAcceptedReplicas("job-1", 1))
      .map((replica) => replica.evidence);
    const marked = await store.markResultSplit({
      jobId: "job-1",
      collectionCycle: 1,
      inputHash: firstCandidate.job.inputHash,
      evidence,
    });
    assert(marked.kind === "recorded", "complete split evidence must mark");
    const replay = await store.markResultSplit({
      jobId: "job-1",
      collectionCycle: 1,
      inputHash: firstCandidate.job.inputHash,
      evidence: [...evidence].reverse(),
    });
    assert(replay.kind === "replayed", "canonical split evidence must replay");
    const changed = await store.markResultSplit({
      jobId: "job-1",
      collectionCycle: 1,
      inputHash: firstCandidate.job.inputHash,
      evidence: evidence.map((item, index) =>
        index === 0 ? { ...item, resultHash: "changed-result" } : item
      ),
    });
    assert(changed.kind === "conflict", "changed split evidence must conflict");
    const current = (await store.listLeaseCandidates({ classIds: ["class-1"] }))[0];
    assert(current?.attempts.splitObserved, "split marker must be durable");
    const decision = await store.recordDecisionResult({
      decision: {
        decisionResultHash: "decision-after-split",
        jobId: "job-1",
        collectionCycle: 1,
        inputHash: firstCandidate.job.inputHash,
        result: { answer: "must not verify" },
        evidence,
        achievedStrength: "structural_only",
        contractVersion: firstCandidate.job.contractVersion,
        permitEpoch: firstCandidate.job.permitEpoch,
        verifiedAt: LATER,
      },
      transition: { from: "collecting", at: LATER },
    });
    assert(!decision.ok, "absorbing split must fence automatic decision");
  },
};

const decisionEvidenceSnapshotCase: StoreConformanceCase = {
  id: "decision-evidence-snapshot-atomic",
  run: async (factory) => {
    const store = await factory();
    await initializeClass(store);
    const worker = await initializeWorker(store);
    const candidate = await enqueue(store);
    const lease = preparedLease(candidate, worker, "lease-decision");
    await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-1" },
    });
    await store.acceptOrReplaySubmission(submissionInput(lease));
    const evidence = (await store.listAcceptedReplicas("job-1", 1))
      .map((replica) => replica.evidence);
    const decision = {
      decisionResultHash: "decision-1",
      jobId: "job-1",
      collectionCycle: 1,
      inputHash: candidate.job.inputHash,
      result: { answer: "lease-decision" },
      evidence,
      achievedStrength: "structural_only" as const,
      contractVersion: candidate.job.contractVersion,
      permitEpoch: candidate.job.permitEpoch,
      verifiedAt: LATER,
    };
    const recorded = await store.recordDecisionResult({
      decision,
      transition: { from: "collecting", at: LATER },
    });
    assert(recorded.ok, "exact current evidence must record a decision");
    assert(
      await store.getResultState("job-1", 1) === "verified",
      "decision and verified state must publish together",
    );
    assert(
      JSON.stringify(await store.getDecisionResult("decision-1")) ===
        JSON.stringify(decision),
      "decision must be retrievable by its content hash",
    );

    const staleStore = await factory();
    await initializeClass(staleStore);
    const staleWorker = await initializeWorker(staleStore);
    const staleCandidate = await enqueue(staleStore);
    const staleLease = preparedLease(
      staleCandidate,
      staleWorker,
      "lease-stale-decision",
    );
    await staleStore.compareAndClaimLease({
      expectedCandidate: staleCandidate,
      expectedWorker: staleWorker,
      preparedLease: staleLease,
      preparedPayload: { instruction: "process job-1" },
    });
    await staleStore.acceptOrReplaySubmission(submissionInput(staleLease));
    const staleEvidence = (await staleStore.listAcceptedReplicas("job-1", 1))
      .map((replica) => replica.evidence);
    const refused = await staleStore.recordDecisionResult({
      decision: {
        ...decision,
        decisionResultHash: "decision-stale",
        evidence: [
          ...staleEvidence,
          {
            leaseId: "lease-fabricated",
            collectionCycle: 1,
            resultHash: "result-fabricated",
            workerId: "worker-fabricated",
          },
        ],
      },
      transition: { from: "collecting", at: LATER },
    });
    assert(!refused.ok, "stale or fabricated evidence must conflict");
    assert(
      await staleStore.getResultState("job-1", 1) === "collecting",
      "evidence conflict must preserve the collecting state",
    );
  },
};

const emergencyCase: StoreConformanceCase = {
  id: "queue-class-precedence-atomic",
  run: async (factory) => {
    const store = await factory();
    const health = await initializeClass(store);
    await enqueue(store, "job-before-halt");
    const queue = await store.getQueueMode();
    const invalidation = await store.inspectInvalidationScope({
      kind: "class",
      classId: "class-1",
    });
    const halt = await store.enterEmergencyHalt({
      expectedQueue: queue,
      nextQueue: { mode: "emergency_halted", updatedAt: LATER },
      expectedClassHealth: [health],
      nextClassHealth: [{
        classId: "class-1",
        health: { ...health.health, operating: "emergency_halted" },
        updatedAt: LATER,
        source: "operator",
      }],
      invalidation: {
        scope: { kind: "class", classId: "class-1" },
        expectedTargets: invalidation.targets,
        requeuePlans: [],
      },
      at: LATER,
    });
    assert(halt.kind === "applied", "emergency halt must apply atomically");
    assert(halt.invalidation.resultTransitions.length === 1, "halt must invalidate result");
    assert(
      await store.getResultState("job-before-halt", 1) === "cancelled",
      "halted result must be cancelled",
    );
    const staleRefresh = await store.transitionClassHealth({
      expected: health,
      next: { health: readyHealth(), updatedAt: LATER, source: "automatic" },
    });
    assert(staleRefresh.kind === "conflict", "stale health refresh must conflict");

    const staleEnqueue = await store.enqueueJob({
      job: jobRecord("job-after-halt"),
      payload: { instruction: "must not enter" },
      expectedOperationalState: {
        queueRevision: queue.revision,
        classHealthRevision: health.revision,
      },
    });
    assert(
      staleEnqueue.kind === "operational_state_conflict",
      "enqueue must not cross the halt revision",
    );
  },
};

export const TASK1_STORE_CONFORMANCE_CASES: readonly StoreConformanceCase[] =
  Object.freeze([
    classLifecycleAndEpoch,
    workerRegistrationCase,
    classHealthCase,
    routingTransitionCase,
    claimRaceCase,
    identityCollisionCase,
    losingClaimIdentityCase,
    workerStateCase,
    workerStateFenceCase,
    noWorkContributionCase,
    canaryPayloadCase,
    emergencyCase,
  ]);

export const TASK4_STORE_CONFORMANCE_CASES: readonly StoreConformanceCase[] =
  Object.freeze([
    ...TASK1_STORE_CONFORMANCE_CASES,
    workerLeaseBindingCase,
    extensionDeadlineCase,
    expiryRequeueCase,
    stickyEpochRequeueCase,
  ]);

export const TASK5_STORE_CONFORMANCE_CASES: readonly StoreConformanceCase[] =
  Object.freeze([
    ...TASK4_STORE_CONFORMANCE_CASES,
    submissionIdempotencyCase,
    conflictingSubmissionCase,
    invalidSubmissionSettlementCase,
    canarySubmissionProjectionCase,
    contractExpirySettlementCase,
    splitEvidenceFenceCase,
    decisionEvidenceSnapshotCase,
  ]);

export async function runTask1StoreConformance(
  factory: StoreFactory,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const testCase of TASK1_STORE_CONFORMANCE_CASES) {
    try {
      await testCase.run(factory);
      passed.push(testCase.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${testCase.id}: ${detail}`, { cause: error });
    }
  }
  return Object.freeze(passed);
}

export async function runTask4StoreConformance(
  factory: StoreFactory,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const testCase of TASK4_STORE_CONFORMANCE_CASES) {
    try {
      await testCase.run(factory);
      passed.push(testCase.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${testCase.id}: ${detail}`, { cause: error });
    }
  }
  return Object.freeze(passed);
}

export async function runTask5StoreConformance(
  factory: StoreFactory,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const testCase of TASK5_STORE_CONFORMANCE_CASES) {
    try {
      await testCase.run(factory);
      passed.push(testCase.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${testCase.id}: ${detail}`, { cause: error });
    }
  }
  return Object.freeze(passed);
}
