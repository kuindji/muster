import {
  TASK4_STORE_CONFORMANCE_CASES,
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

const selectedIds = new Set([
  "worker-routing-period-transition-race",
  "candidate-compare-and-claim-single-winner",
  "core-id-collision-refused",
  "losing-claim-id-leaves-no-state",
  "worker-suspension-requeues-open-leases",
  "worker-state-transition-fences-prepared-claim",
  "no-work-contribution-single-winner",
  "canary-payload-claim-atomic",
  "worker-id-binding-rejects-other-holder",
  "extension-deadline-strict",
  "expiry-requeue-atomic",
  "epoch-sticky-through-requeue",
]);

const selectedCases = TASK4_STORE_CONFORMANCE_CASES.filter(({ id }) =>
  selectedIds.has(id)
);
if (selectedCases.length !== selectedIds.size) {
  throw new Error("PostgreSQL Task-4 conformance selection is incomplete");
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

describe("PostgreSQL lease-state Store slice", () => {
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
    const registered = await store.registerWorker({
      worker: {
        workerId: "worker-direct",
        state: "active",
        enrolledAt: NOW,
        declaredCapPerWeek: 4,
        capabilities: {
          providerSurface: "provider.example",
          unattendedScheduling: true,
          languages: ["en"],
          jobClassIds: ["class-direct"],
        },
        accountCluster: "cluster-direct",
        slot: 1,
        contractAcceptance: { contractVersion: "1.1.0", acceptedAt: NOW },
      },
      routing: {
        contributionWindowId: "2026-W32",
        contributionUsed: 0,
        assignedSlotOccurrence: "2026-W32-slot-1",
      },
    });
    if (registered.kind !== "registered") throw new Error("worker setup failed");
    return registered.routing;
  };

  const enqueueDirect = async (store: Store, jobId = "job-direct") => {
    const job = jobRecord(jobId);
    const health = await store.getClassHealth(job.classId);
    if (health === null) throw new Error("health setup failed");
    const result = await store.enqueueJob({
      job,
      payload: { instruction: `process ${jobId}` },
      expectedOperationalState: {
        queueRevision: (await store.getQueueMode()).revision,
        classHealthRevision: health.revision,
      },
    });
    if (result.kind !== "enqueued") throw new Error("enqueue setup failed");
    const candidate = (await store.listLeaseCandidates({
      classIds: [job.classId],
    })).find((entry) => entry.job.jobId === jobId);
    if (candidate === undefined) throw new Error("candidate setup failed");
    return { candidate, job };
  };

  it.each(selectedCases)("passes frozen case $id", async (testCase) => {
    await testCase.run(createStore);
  });

  it("keeps enqueue and claim replay durable across adapter restart", async () => {
    const store = await createStore();
    const worker = await initializeDirectState(store);
    const job = jobRecord();
    const health = await store.getClassHealth(job.classId);
    if (health === null) throw new Error("health setup failed");
    const enqueueInput = {
      job,
      payload: { instruction: "process direct job" },
      expectedOperationalState: {
        queueRevision: (await store.getQueueMode()).revision,
        classHealthRevision: health.revision,
      },
    };
    expect(await store.enqueueJob(enqueueInput)).toEqual({ kind: "enqueued" });
    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    expect(await restarted.enqueueJob(enqueueInput)).toEqual({ kind: "replayed" });
    const candidate = (await restarted.listLeaseCandidates({
      classIds: [job.classId],
    }))[0];
    if (candidate === undefined) throw new Error("candidate setup failed");
    const claimInput = {
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: preparedLease(candidate, worker, "lease-direct"),
      preparedPayload: enqueueInput.payload,
    };
    const claimed = await restarted.compareAndClaimLease(claimInput);
    expect(claimed.kind).toBe("claimed");
    const restartedAgain = new PostgresStore({
      pool: harness.pool,
      schema: store.schema,
    });
    expect(await restartedAgain.compareAndClaimLease(claimInput)).toEqual(claimed);
  });

  it("applies successful extension, contribution release, and cap fencing", async () => {
    const store = await createStore();
    const initialWorker = await initializeDirectState(store);
    const { candidate } = await enqueueDirect(store);
    const lease = preparedLease(candidate, initialWorker, "lease-lifecycle-direct");
    expect(await store.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: initialWorker,
      preparedLease: lease,
      preparedPayload: { instruction: "process job-direct" },
    })).toMatchObject({ kind: "claimed" });
    expect(await store.extendLease({
      workerId: initialWorker.workerId,
      leaseId: lease.leaseId,
      expectedExpiry: lease.expiresAt,
      expectedExtensionsUsed: 0,
      newExpiry: "2026-08-08T08:20:00.000Z",
      newExtensionsUsed: 1,
    })).toEqual({
      kind: "extended",
      newExpiry: "2026-08-08T08:20:00.000Z",
    });
    expect(await store.abandonLease({
      workerId: initialWorker.workerId,
      leaseId: lease.leaseId,
      classification: "abandoned_before_payload",
      requeue: { sameCyclePermitEpoch: "epoch-1" },
      at: NOW,
    })).toEqual({ kind: "recorded" });
    expect(await store.getWorkerRoutingSnapshot(initialWorker.workerId))
      .toMatchObject({ contributionUsed: 0, openLeaseIds: [] });

    const capStore = await createStore();
    const capWorker = await initializeDirectState(capStore);
    const { candidate: capCandidate } = await enqueueDirect(capStore, "job-cap");
    expect(await capStore.recordNoWorkAttempt({
      expectedWorker: capWorker,
      at: NOW,
    })).toMatchObject({ kind: "recorded", current: { contributionUsed: 1 } });
    const cappedRouting = await capStore.getWorkerRoutingSnapshot(capWorker.workerId);
    if (cappedRouting === null) throw new Error("routing setup failed");
    // The direct fixture declares a cap of four, so record three more occurrences.
    let current = cappedRouting;
    for (let count = 0; count < 3; count += 1) {
      const recorded = await capStore.recordNoWorkAttempt({
        expectedWorker: current,
        at: NOW,
      });
      if (recorded.kind !== "recorded") throw new Error("cap setup failed");
      current = recorded.current;
    }
    expect(await capStore.compareAndClaimLease({
      expectedCandidate: capCandidate,
      expectedWorker: current,
      preparedLease: preparedLease(capCandidate, current, "lease-over-cap"),
      preparedPayload: { instruction: "process job-cap" },
    })).toEqual({ kind: "conflict", reason: "unclaimable" });
    expect(await capStore.getLease("lease-over-cap")).toBeNull();
  });

  it("rolls back enqueue and canary claim after later-table failures", async () => {
    const enqueueStore = await createStore();
    await initializeDirectState(enqueueStore);
    const invalidJob = { ...jobRecord("job-rollback"), cycleStartedAt: "invalid" };
    const health = await enqueueStore.getClassHealth(invalidJob.classId);
    if (health === null) throw new Error("health setup failed");
    await expect(enqueueStore.enqueueJob({
      job: invalidJob,
      payload: { instruction: "must roll back" },
      expectedOperationalState: {
        queueRevision: (await enqueueStore.getQueueMode()).revision,
        classHealthRevision: health.revision,
      },
    })).rejects.toThrow();
    expect(await enqueueStore.getJob(invalidJob.jobId)).toBeNull();
    expect(await enqueueStore.getPayload(invalidJob.payloadRef)).toBeNull();

    const claimStore = await createStore();
    const worker = await initializeDirectState(claimStore);
    const job = jobRecord("job-canary-rollback");
    const claimHealth = await claimStore.getClassHealth(job.classId);
    if (claimHealth === null) throw new Error("health setup failed");
    await claimStore.enqueueJob({
      job,
      payload: { instruction: "ordinary" },
      expectedOperationalState: {
        queueRevision: (await claimStore.getQueueMode()).revision,
        classHealthRevision: claimHealth.revision,
      },
    });
    const candidate = (await claimStore.listLeaseCandidates({
      classIds: [job.classId],
    }))[0];
    if (candidate === undefined) throw new Error("candidate setup failed");
    const lease: LeaseRecord = {
      ...preparedLease(candidate, worker, "lease-canary-rollback"),
      inputHash: "canary-input",
      payloadRef: "lease-canary-rollback",
      issuedAt: "invalid",
      assignment: {
        kind: "canary",
        canaryKind: "production",
        canaryId: "canary-1",
        sourceJobId: "resolved-1",
        sourceContractVersion: "1.0.0",
        expectedResultHash: "result-1",
      },
    };
    await expect(claimStore.compareAndClaimLease({
      expectedCandidate: candidate,
      expectedWorker: worker,
      preparedLease: lease,
      preparedPayload: { instruction: "canary" },
    })).rejects.toThrow();
    expect(await claimStore.getLease(lease.leaseId)).toBeNull();
    expect(await claimStore.getPayload(lease.payloadRef)).toBeNull();
    const identity = await harness.pool.query(
      `SELECT identity_id FROM ${claimStore.quotedSchema}.core_identities
        WHERE identity_id = $1`,
      [lease.leaseId],
    );
    expect(identity.rowCount).toBe(0);
  });

  it("uses the candidate and open-lease indexes", async () => {
    const store = await createStore();
    const client = await harness.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const candidatePlan = await client.query<{ readonly "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         SELECT job_id FROM ${store.quotedSchema}.jobs
          WHERE class_id = $1
          ORDER BY lane, priority_value DESC, enqueued_at, sequence`,
        ["class-direct"],
      );
      const leasePlan = await client.query<{ readonly "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         SELECT lease_id FROM ${store.quotedSchema}.leases
          WHERE holder = $1 AND open = true
          ORDER BY job_id, collection_cycle, lease_id`,
        ["worker-direct"],
      );
      expect(candidatePlan.rows.map((row) => row["QUERY PLAN"]).join("\n"))
        .toContain("jobs_candidate_lookup_idx");
      expect(leasePlan.rows.map((row) => row["QUERY PLAN"]).join("\n"))
        .toContain("leases_open_holder_idx");
    } finally {
      client.release();
    }
  });
});
