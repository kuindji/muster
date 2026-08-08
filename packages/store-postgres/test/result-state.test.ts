import {
  TASK5_STORE_CONFORMANCE_CASES,
  TASK6_STORE_CONFORMANCE_CASES,
  type JobRecord,
  type LeaseCandidateSnapshot,
  type LeaseRecord,
  type Store,
  type WorkerRoutingSnapshot,
} from "@kuindji/muster-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  PostgresStore,
} from "../src/index.js";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

const NOW = "2026-08-08T08:00:00.000Z";
const LATER = "2026-08-08T08:10:00.000Z";

const selectedIds = new Set([
  "submit-idempotency-exact-triple",
  "conflicting-retry-preserves-accepted-row",
  "invalid-submission-settlement-atomic",
  "canary-submission-excluded-from-replicas",
  "contract-expiry-settlement-atomic",
  "split-marker-evidence-fenced",
  "decision-evidence-snapshot-atomic",
  "result-requeue-cycle-increment-atomic",
]);

const selectedCases = TASK6_STORE_CONFORMANCE_CASES.filter(({ id }) =>
  selectedIds.has(id)
);
if (selectedCases.length !== selectedIds.size ||
    TASK5_STORE_CONFORMANCE_CASES.filter(({ id }) => selectedIds.has(id)).length !== 7) {
  throw new Error("PostgreSQL Task-5 conformance selection is incomplete");
}

const readyHealth = () => ({
  operating: "ready" as const,
  reserves: {
    lowCost: "available" as const,
    urgent: "available" as const,
    splitAndAdjudication: "available" as const,
    audit: "available" as const,
  },
});

const jobRecord = (jobId = "job-direct"): JobRecord => ({
  jobId,
  classId: "class-direct",
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
  expiresAt: "2026-08-08T08:15:00.000Z",
  absoluteInFlightDeadline: "2026-08-08T09:00:00.000Z",
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

describe("PostgreSQL submission and result-state Store slice", () => {
  let harness: PostgresTestHarness;
  const schemas: string[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    for (const schema of schemas) await harness.dropSchema(schema);
    await harness.stop();
  });

  const createStore = async (): Promise<PostgresStore> => {
    const schema = await harness.createSchema();
    schemas.push(schema);
    await migrateMusterPostgres({ pool: harness.pool, schema });
    await bootstrapMusterPostgres({
      pool: harness.pool,
      schema,
      initialQueue: { mode: "normal", updatedAt: NOW },
    });
    return new PostgresStore({ pool: harness.pool, schema });
  };

  const initializeDirectState = async (store: Store) => {
    await store.registerClassVersion({
      classId: "class-direct",
      contractVersion: "1.0.0",
      payloadSchemaHash: "payload-schema-1",
      outputSchemaHash: "output-schema-1",
      registeredAt: NOW,
    });
    await store.initializeClassHealth({
      initial: {
        classId: "class-direct",
        health: readyHealth(),
        updatedAt: NOW,
        source: "automatic",
      },
    });
    await store.transitionClassVersion({
      classId: "class-direct",
      contractVersion: "1.0.0",
      from: "draft",
      to: "active",
      at: NOW,
    });
    await store.transitionPermitEpoch({
      classId: "class-direct",
      fromEpoch: null,
      toEpoch: "epoch-1",
      at: NOW,
    });
  };

  const initializeWorker = async (store: Store, workerId: string, slot: number) => {
    const registered = await store.registerWorker({
      worker: {
        workerId,
        state: "active",
        enrolledAt: NOW,
        declaredCapPerWeek: 4,
        capabilities: {
          providerSurface: `provider-${slot}.example`,
          unattendedScheduling: true,
          languages: ["en"],
          jobClassIds: ["class-direct"],
        },
        accountCluster: `cluster-${slot}`,
        slot,
        contractAcceptance: { contractVersion: "1.1.0", acceptedAt: NOW },
      },
      routing: {
        contributionWindowId: "2026-W32",
        contributionUsed: 0,
        assignedSlotOccurrence: `2026-W32-slot-${slot}`,
      },
    });
    if (registered.kind !== "registered") throw new Error("worker setup failed");
    return registered.routing;
  };

  const enqueueDirect = async (store: Store, jobId = "job-direct") => {
    const job = jobRecord(jobId);
    const health = await store.getClassHealth(job.classId);
    if (health === null) throw new Error("health setup failed");
    const payload = { instruction: `process ${jobId}` };
    const enqueued = await store.enqueueJob({
      job,
      payload,
      expectedOperationalState: {
        queueRevision: (await store.getQueueMode()).revision,
        classHealthRevision: health.revision,
      },
    });
    if (enqueued.kind !== "enqueued") throw new Error("enqueue setup failed");
    const candidate = (await store.listLeaseCandidates({
      classIds: [job.classId],
    })).find((entry) => entry.job.jobId === jobId);
    if (candidate === undefined) throw new Error("candidate setup failed");
    return { candidate, payload };
  };

  const acceptLease = async (
    store: Store,
    candidate: LeaseCandidateSnapshot,
    worker: WorkerRoutingSnapshot,
    leaseId: string,
    resultHash: string,
    payload: { instruction: string },
  ) => {
    const lease = preparedLease(candidate, worker, leaseId);
    const claimed = await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: payload,
    });
    if (claimed.kind !== "claimed") throw new Error("claim setup failed");
    const submission = {
      workerId: worker.workerId,
      leaseId,
      inputHash: lease.inputHash,
      resultHash,
      body: { answer: resultHash },
      receipt: {
        leaseId,
        jobId: lease.jobId,
        collectionCycle: lease.collectionCycle,
        inputHash: lease.inputHash,
        resultHash,
        contractVersion: lease.contractVersion,
        permitEpoch: lease.permitEpoch,
        outcome: "accepted" as const,
        acceptedAt: LATER,
      },
    };
    expect(await store.acceptOrReplaySubmission(submission))
      .toMatchObject({ kind: "accepted" });
    return { lease, submission };
  };

  it.each(selectedCases)("passes frozen case $id", async (testCase) => {
    await testCase.run(createStore);
  });

  it("replays an accepted submission after adapter restart", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const worker = await initializeWorker(store, "worker-restart", 1);
    const { candidate, payload } = await enqueueDirect(store, "job-restart");
    const { submission } = await acceptLease(
      store,
      candidate,
      worker,
      "lease-restart",
      "result-restart",
      payload,
    );
    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    expect(await restarted.acceptOrReplaySubmission(submission)).toEqual({
      kind: "replayed",
      receipt: submission.receipt,
    });
  });

  it("serializes split marking against automatic decision persistence", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const firstWorker = await initializeWorker(store, "worker-split-1", 1);
    const { candidate: firstCandidate, payload } = await enqueueDirect(
      store,
      "job-split-race",
    );
    await acceptLease(
      store,
      firstCandidate,
      firstWorker,
      "lease-split-race-1",
      "result-a",
      payload,
    );
    const secondWorker = await initializeWorker(store, "worker-split-2", 2);
    const secondCandidate = (await store.listLeaseCandidates({
      classIds: ["class-direct"],
    })).find((entry) => entry.job.jobId === "job-split-race");
    if (secondCandidate === undefined) throw new Error("second candidate missing");
    await acceptLease(
      store,
      secondCandidate,
      secondWorker,
      "lease-split-race-2",
      "result-b",
      payload,
    );
    const evidence = (await store.listAcceptedReplicas("job-split-race", 1))
      .map((entry) => entry.evidence);
    const [split, decision] = await Promise.all([
      store.markResultSplit({
        jobId: "job-split-race",
        collectionCycle: 1,
        inputHash: firstCandidate.job.inputHash,
        evidence,
      }),
      store.recordDecisionResult({
        decision: {
          decisionResultHash: "decision-split-race",
          jobId: "job-split-race",
          collectionCycle: 1,
          inputHash: firstCandidate.job.inputHash,
          result: { answer: "result-a" },
          evidence,
          achievedStrength: "structural_only",
          contractVersion: firstCandidate.job.contractVersion,
          permitEpoch: firstCandidate.job.permitEpoch,
          verifiedAt: LATER,
        },
        transition: { from: "collecting", at: LATER },
      }),
    ]);
    expect(Number(split.kind === "recorded") + Number(decision.ok)).toBe(1);
    expect(await store.getResultState("job-split-race", 1))
      .toBe(decision.ok ? "verified" : "collecting");
  });

  it("keeps accepted replicas isolated across a result requeue", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const worker = await initializeWorker(store, "worker-cycle", 1);
    const { candidate, payload } = await enqueueDirect(store, "job-cycle");
    await acceptLease(
      store,
      candidate,
      worker,
      "lease-cycle-1",
      "result-cycle-1",
      payload,
    );
    expect(await store.transitionResult({
      jobId: "job-cycle",
      collectionCycle: 1,
      from: "collecting",
      to: "expired",
      at: LATER,
      startNewCycle: {
        permitEpoch: "epoch-1",
        inputHash: "input-job-cycle-2",
        cycleStartedAt: LATER,
      },
    })).toEqual({ ok: true });
    expect(await store.listAcceptedReplicas("job-cycle", 1)).toHaveLength(1);
    expect(await store.listAcceptedReplicas("job-cycle", 2)).toHaveLength(0);
    expect(await store.getJob("job-cycle")).toMatchObject({
      collectionCycle: 2,
      inputHash: "input-job-cycle-2",
    });
  });

  it("reconstructs the complete live authorization context", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const worker = await initializeWorker(store, "worker-context", 1);
    const { candidate, payload } = await enqueueDirect(store, "job-context");
    await acceptLease(
      store,
      candidate,
      worker,
      "lease-context",
      "result-context",
      payload,
    );
    const evidence = (await store.listAcceptedReplicas("job-context", 1))
      .map((entry) => entry.evidence);
    const decision = {
      decisionResultHash: "decision-context",
      jobId: "job-context",
      collectionCycle: 1,
      inputHash: candidate.job.inputHash,
      result: { answer: "result-context" },
      evidence,
      achievedStrength: "structural_only" as const,
      contractVersion: candidate.job.contractVersion,
      permitEpoch: candidate.job.permitEpoch,
      verifiedAt: LATER,
    };
    expect(await store.recordDecisionResult({
      decision,
      transition: { from: "collecting", at: LATER },
    })).toEqual({ ok: true });
    expect(await store.inspectAuthorizationContext(decision.decisionResultHash))
      .toMatchObject({
        decision,
        jobCycle: { jobId: "job-context", collectionCycle: 1 },
        currentJob: { jobId: "job-context", collectionCycle: 1 },
        resultState: "verified",
        classVersion: {
          classId: "class-direct",
          contractVersion: "1.0.0",
          state: "active",
        },
      });
  });

  it("persists composite authorization, action verdict, and live invalidation atomically", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const worker = await initializeWorker(store, "worker-authorization", 1);
    const { candidate, payload } = await enqueueDirect(store, "job-authorization");
    await acceptLease(
      store,
      candidate,
      worker,
      "lease-authorization",
      "result-authorization",
      payload,
    );
    const evidence = (await store.listAcceptedReplicas("job-authorization", 1))
      .map((entry) => entry.evidence);
    const decision = {
      decisionResultHash: "decision-authorization",
      jobId: "job-authorization",
      collectionCycle: 1,
      inputHash: candidate.job.inputHash,
      result: { answer: "result-authorization" },
      evidence,
      achievedStrength: "structural_only" as const,
      contractVersion: candidate.job.contractVersion,
      permitEpoch: candidate.job.permitEpoch,
      verifiedAt: LATER,
    };
    expect(await store.recordDecisionResult({
      decision,
      transition: { from: "collecting", at: LATER },
    })).toEqual({ ok: true });
    const inspected = await store.inspectAuthorizationContext(
      decision.decisionResultHash,
    );
    if (inspected === null) throw new Error("authorization context missing");
    const expectedContext = {
      ...inspected,
      maxInFlightDeadline: "2026-08-08T09:00:00.000Z",
    };
    const lowCostPolicy = {
      classId: "class-direct",
      contractVersion: "1.0.0",
      policyVersion: "low-cost-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "lowCost" as const,
      laneLimit: 2,
      perWorkerLimit: 2,
    };
    const adjudicationPolicy = {
      classId: "class-direct",
      contractVersion: "1.0.0",
      policyVersion: "adjudication-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "splitAndAdjudication" as const,
      laneLimit: 2,
    };
    await store.initializeReservePolicy({ policy: lowCostPolicy, at: NOW });
    await store.initializeReservePolicy({ policy: adjudicationPolicy, at: NOW });
    const effectIntent: Parameters<Store["authorizeOrReplayIntent"]>[0]["effectIntent"] = {
      id: "effect-intent-authorization",
      effects: [
        { action: "routeToHumanLowCost" as const, descriptor: { reason: "review" } },
        { action: "suppress" as const, descriptor: { reason: "unsafe" } },
      ],
    };
    const effectIntentHash = "effect-intent-hash-authorization";
    const authorizationRequestId = "authorization-request-1";
    const request: Extract<
      Parameters<Store["authorizeOrReplayIntent"]>[0]["decision"],
      { kind: "pend" }
    >["request"] = {
      authorizationRequestId,
      jobId: decision.jobId,
      collectionCycle: decision.collectionCycle,
      effectIntent,
      effectIntentHash,
      inputHash: decision.inputHash,
      decisionResultHash: decision.decisionResultHash,
      evidence,
      contractVersion: decision.contractVersion,
      permitEpoch: decision.permitEpoch,
      humanReviews: [{
        action: "suppress" as const,
        predicate: "human-reviewed",
        requiredPayloadPaths: [],
        requiredResultPaths: [],
        requiredEffectPaths: ["$.reason" as const],
      }],
    };
    const authorizationInput: Parameters<Store["authorizeOrReplayIntent"]>[0] = {
      authorizationRequestId,
      effectIntent,
      effectIntentHash,
      decisionResultHash: decision.decisionResultHash,
      expectedContext,
      decision: {
        kind: "pend" as const,
        request,
        charges: [
          {
            chargeKey: `${authorizationRequestId}:lowCost`,
            workerIds: [worker.workerId],
            policy: lowCostPolicy,
            at: LATER,
          },
          {
            chargeKey: `${authorizationRequestId}:splitAndAdjudication`,
            workerIds: [],
            policy: adjudicationPolicy,
            at: LATER,
          },
        ],
      },
      at: LATER,
    };
    const concurrentOpen = await Promise.all([
      store.authorizeOrReplayIntent(authorizationInput),
      store.authorizeOrReplayIntent(authorizationInput),
    ]);
    expect(concurrentOpen.map((outcome) => outcome.kind).sort())
      .toEqual(["applied", "replayed"]);
    expect(concurrentOpen.find((outcome) => outcome.kind === "applied"))
      .toMatchObject({
        initialReceipt: { outcome: "pending_adjudication" },
        reserveBatch: { settlements: [{ lane: "lowCost" }, {
          lane: "splitAndAdjudication",
        }] },
      });
    const restarted = new PostgresStore({
      pool: harness.pool,
      schema: store.schema,
    });
    const replayCharges = authorizationInput.decision.kind === "pend"
      ? authorizationInput.decision.charges.map((charge) => ({
          ...charge,
          at: "2026-08-08T08:20:00.000Z",
        }))
      : [];
    expect(await restarted.authorizeOrReplayIntent({
      ...authorizationInput,
      at: "2026-08-08T08:20:00.000Z",
      decision: {
        kind: "pend",
        request,
        charges: replayCharges,
      },
    })).toMatchObject({ kind: "replayed" });
    const urgentPolicy = {
      classId: "class-direct",
      contractVersion: "1.0.0",
      policyVersion: "urgent-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "urgent" as const,
      laneLimit: 0,
      perWorkerLimit: 0,
    };
    await store.initializeReservePolicy({ policy: urgentPolicy, at: NOW });
    const urgentIntent: Parameters<Store["authorizeOrReplayIntent"]>[0]["effectIntent"] = {
      id: "effect-intent-urgent",
      effects: [{ action: "routeToUrgent", descriptor: { reason: "urgent" } }],
    };
    const urgentRequestId = "authorization-request-urgent";
    expect(await store.authorizeOrReplayIntent({
      authorizationRequestId: urgentRequestId,
      effectIntent: urgentIntent,
      effectIntentHash: "effect-intent-hash-urgent",
      decisionResultHash: decision.decisionResultHash,
      expectedContext,
      decision: {
        kind: "authorize",
        authorization: {
          authorizationRequestId: urgentRequestId,
          effectIntentId: urgentIntent.id,
          effectIntentHash: "effect-intent-hash-urgent",
          jobId: decision.jobId,
          collectionCycle: decision.collectionCycle,
          inputHash: decision.inputHash,
          decisionResultHash: decision.decisionResultHash,
          evidence,
          contractVersion: decision.contractVersion,
          permitEpoch: decision.permitEpoch,
          actions: ["routeToUrgent"],
        },
        charges: [
          {
            chargeKey: `${urgentRequestId}:lowCost`,
            workerIds: [worker.workerId],
            policy: lowCostPolicy,
            at: LATER,
          },
          {
            chargeKey: `${urgentRequestId}:urgent`,
            workerIds: [worker.workerId],
            policy: urgentPolicy,
            at: LATER,
          },
        ],
      },
      at: LATER,
    })).toMatchObject({
      kind: "applied",
      initialReceipt: {
        outcome: "denied",
        denialReason: "escalation_budget_exhausted",
      },
      reserveBatch: {
        settlements: [{ lane: "urgent", charge: { outcome: "exhausted" } }],
        skippedLanes: ["lowCost"],
      },
    });
    expect(await store.getReservePolicy({
      classId: "class-direct",
      contractVersion: "1.0.0",
      lane: "lowCost",
    })).toMatchObject({ used: 1 });
    const verdict = {
      kind: "human" as const,
      jobId: decision.jobId,
      collectionCycle: decision.collectionCycle,
      authorizationRequestId,
      effectIntentId: effectIntent.id,
      effectIntentHash,
      actions: effectIntent.effects.map((effect) => effect.action),
      inputHash: decision.inputHash,
      decisionResultHash: decision.decisionResultHash,
      evidence,
      contractVersion: decision.contractVersion,
      permitEpoch: decision.permitEpoch,
      adjudicatorId: "human-1",
      decision: "approve" as const,
      decidedAt: LATER,
    };
    const authorization = {
      authorizationRequestId,
      effectIntentId: effectIntent.id,
      effectIntentHash,
      jobId: decision.jobId,
      collectionCycle: decision.collectionCycle,
      inputHash: decision.inputHash,
      decisionResultHash: decision.decisionResultHash,
      evidence,
      actionAdjudicationVerdictHash: "action-verdict-1",
      contractVersion: decision.contractVersion,
      permitEpoch: decision.permitEpoch,
      actions: verdict.actions,
    };
    const verdictInput = {
      verdict,
      verdictHash: "action-verdict-1",
      processedAt: LATER,
      expectedContext: { persisted: expectedContext, current: inspected },
      decision: "approve" as const,
      authorization,
    };
    const concurrentVerdicts = await Promise.all([
      store.applyActionAdjudicationVerdict(verdictInput),
      restarted.applyActionAdjudicationVerdict(verdictInput),
    ]);
    expect(concurrentVerdicts.map((outcome) => outcome.kind).sort())
      .toEqual(["applied", "replayed"]);
    expect(concurrentVerdicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        receipt: expect.objectContaining({ outcome: "approved" }),
      }),
    ]));
    expect(await store.getAuthorizationStatus(authorizationRequestId)).toEqual({
      state: "authorized",
      validity: { kind: "valid" },
    });
    const snapshot = await store.inspectInvalidationScope({
      kind: "job_cycles",
      classId: "class-direct",
      jobCycles: [{ jobId: decision.jobId, collectionCycle: 1 }],
    });
    expect(await store.invalidateResultScope({
      scope: snapshot.scope,
      expectedTargets: snapshot.targets,
      requeuePlans: [],
      reason: "operator_cancelled",
      at: LATER,
    })).toMatchObject({ kind: "applied" });
    expect(await store.getAuthorizationStatus(authorizationRequestId)).toEqual({
      state: "authorized",
      validity: {
        kind: "invalid",
        reason: "operator_cancelled",
        invalidatedAt: LATER,
      },
    });
    await harness.pool.query(
      `UPDATE "${store.schema}".authorization_status
          SET record = '{"state":"future"}'::jsonb
        WHERE authorization_request_id = $1`,
      [authorizationRequestId],
    );
    await expect(store.getAuthorizationStatus(authorizationRequestId))
      .rejects.toMatchObject({ code: "invalid_stored_value" });
  });

  it("fails loudly on a malformed durable reserve replay", async () => {
    const store = await createStore();
    await initializeDirectState(store);
    const policy = {
      classId: "class-direct",
      contractVersion: "1.0.0",
      policyVersion: "adjudication-corruption-1",
      windowId: "2026-W32-corruption",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "splitAndAdjudication" as const,
      laneLimit: 1,
    };
    await expect(store.initializeReservePolicy({ policy, at: NOW }))
      .resolves.toMatchObject({ kind: "initialized" });
    const charge = {
      chargeKey: "reserve-corruption-1",
      workerIds: [],
      policy,
      at: NOW,
    };
    await expect(store.chargeReserve(charge)).resolves.toMatchObject({
      kind: "charged",
      status: "applied",
    });
    await harness.pool.query(
      `UPDATE "${store.schema}".reserve_charges
          SET record = '{"kind":"charged"}'::jsonb
        WHERE charge_key = $1`,
      [charge.chargeKey],
    );
    await expect(store.chargeReserve(charge))
      .rejects.toMatchObject({ code: "invalid_stored_value" });
  });
});
