import type {
  ActionAdjudicationRequest,
  ClassHealth,
  EffectIntent,
  JobClass,
  JSONSchema,
  ResultAdjudicationVerdict,
} from "@kuindji/muster-contract";
import {
  computeDecisionResultHash,
  computeEffectIntentHash,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import {
  AdjudicationService,
  InvalidationService,
} from "../src/adjudication-service.js";
import { LeaseService } from "../src/lease-service.js";
import { InMemoryStore } from "../src/memory-store.js";
import type {
  AdjudicationSource,
  ReputationPolicy,
  WorkerControlPolicy,
} from "../src/ports.js";
import { RuntimeClassRegistry } from "../src/registration.js";
import { SubmissionService } from "../src/submission-service.js";
import {
  ManualClock,
  RecordingEventSink,
  SequenceIdSource,
} from "../src/testing.js";

const NOW = "2026-08-07T12:00:00.000Z";
const LATER = "2026-08-07T12:01:00.000Z";

type Payload = { instruction: string };
type Result = { answer: string };

const objectSchema = (property: string): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: { [property]: { type: "string" } },
  required: [property],
});

const definition = (replicationTarget = 2): JobClass<Payload, Result> => ({
  id: "class-1",
  contractVersion: "1.0.0",
  kind: "oneshot",
  payloadSchema: objectSchema("instruction"),
  outputSchema: objectSchema("answer"),
  maxPayloadBytes: 4_096,
  maxResultBytes: 4_096,
  sanitize: (raw) => raw as Payload,
  verification: "structural_only",
  validators: [],
  oracles: [],
  replication: { target: replicationTarget, maxSplitEvidenceReroutes: 0 },
  ...(replicationTarget === 1 ? {} : { agreement: {
    equivalenceKey: (result) => result.answer,
    resolveEquivalent: (results) => results[0],
    agreementFixtures: [{
      kind: "split",
      payload: { instruction: "answer" },
      results: [{ answer: "left" }, { answer: "right" }],
      expected: "split",
    }],
  } }),
  permits: [
    {
      action: "routeToHumanLowCost",
      mode: "automatic",
      effectSchema: objectSchema("reason"),
      effectInput: { payloadPaths: [], resultPaths: ["$.answer"] },
      deriveEffect: ({ result }) => ({ reason: (result as Result).answer }),
      effectFixtures: [{
        input: {
          payload: { instruction: "answer" },
          result: { answer: "approved" },
        },
        expectedDescriptor: { reason: "approved" },
      }],
    },
    {
      action: "suppress",
      mode: "human_only",
      effectSchema: objectSchema("reason"),
      reviewRequirement: {
        predicate: "human-reviewed",
        requiredPayloadPaths: [],
        requiredResultPaths: [],
        requiredEffectPaths: ["$.reason"],
      },
    },
  ],
  consequence: "low",
  surface: "unbounded",
  evidenceRequirements: [],
  absenceRequirements: [],
  requires: {},
  privacy: "internal",
  cost: {
    expectedTurns: 1,
    maxLeaseTtl: 300,
    leaseTtl: () => 240,
    maxInFlightLifetime: 1_801,
  },
  escalation: {
    lowCostPerWeek: 0,
    urgentPerWeek: 0,
    splitAndAdjudicationPerWeek: 1,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 0,
    perWorkerUrgentQuotaPerWeek: 0,
  },
  adjudication: {
    requiredRatePerWeek: 1,
    starvationDwell: 300,
    restoreAbovePerWeek: 2,
    capacityMaxAge: 300,
    maxRejectedDisputeRequeues: 1,
  },
});

const readyHealth = (): ClassHealth => ({
  operating: "ready",
  reserves: {
    lowCost: "available",
    urgent: "available",
    splitAndAdjudication: "available",
    audit: "available",
  },
});

const workerPolicy: WorkerControlPolicy = {
  probationCheckedSuccesses: 1,
  probationMinimumEnrollmentAge: 0,
  assignSlot: ({ workerId }) => Number(workerId.at(-1) ?? 1),
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

const reputationPolicy: ReputationPolicy = {
  assess: () => ({ eligible: true }),
};

const adjudicationSource: AdjudicationSource = {
  capacity: (classId) => ({
    classId,
    availableReviewsPerWeek: 10,
    observedAt: NOW,
  }),
  authenticate: () => true,
};

const setup = async (replicationTarget = 2) => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const clock = new ManualClock(NOW);
  const registry = new RuntimeClassRegistry();
  const events = new RecordingEventSink();
  const ids = new SequenceIdSource("task6");
  const jobClass = definition(replicationTarget);
  registry.load({
    jobClass,
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
  });
  await store.registerClassVersion({
    classId: jobClass.id,
    contractVersion: jobClass.contractVersion,
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
    registeredAt: NOW,
  });
  await store.initializeClassHealth({
    initial: {
      classId: jobClass.id,
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic",
    },
  });
  await store.transitionClassVersion({
    classId: jobClass.id,
    contractVersion: jobClass.contractVersion,
    from: "draft",
    to: "active",
    at: NOW,
  });
  await store.transitionPermitEpoch({
    classId: jobClass.id,
    fromEpoch: null,
    toEpoch: "epoch-1",
    at: NOW,
  });
  for (let index = 1; index <= 2; index += 1) {
    await store.registerWorker({
      worker: {
        workerId: `worker-${index}`,
        state: "active",
        enrolledAt: NOW,
        declaredCapPerWeek: 10,
        capabilities: {
          providerSurface: `provider-${index}`,
          unattendedScheduling: true,
          languages: ["en"],
          jobClassIds: [jobClass.id],
        },
        accountCluster: `cluster-${index}`,
        slot: index,
        contractAcceptance: {
          contractVersion: "1.1.0",
          acceptedAt: NOW,
        },
      },
      routing: {
        contributionWindowId: NOW.slice(0, 10),
        contributionUsed: 0,
        assignedSlotOccurrence: `${NOW.slice(0, 10)}-slot-${index}`,
      },
    });
  }
  const leases = new LeaseService({
    store,
    registry,
    clock,
    ids,
    events,
    workerPolicy,
    reputationPolicy,
    deploymentPolicy: {
      version: "deployment-1",
      extensionTtl: 300,
      maxExtensionsPerLease: 2,
    },
  });
  const submissions = new SubmissionService({
    store,
    registry,
    clock,
    ids,
    events,
  });
  await leases.enqueue({
    jobId: "job-1",
    classId: jobClass.id,
    contractVersion: jobClass.contractVersion,
    rawPayload: { instruction: "answer" },
    policyVersion: "policy-1",
    priority: { lane: "normal", value: 1, sequence: "sequence-1" },
  });
  return { clock, events, ids, leases, registry, store, submissions };
};

const claim = async (leases: LeaseService, workerId: string) => {
  const outcome = await leases.leaseJob(workerId);
  if (outcome.outcome !== "lease") throw new Error(`expected lease for ${workerId}`);
  return outcome.lease;
};

const createSplit = async (
  leases: LeaseService,
  submissions: SubmissionService,
): Promise<void> => {
  const first = await claim(leases, "worker-1");
  await submissions.submitResult(
    "worker-1",
    first.leaseId,
    first.inputHash,
    { answer: "left" },
  );
  const second = await claim(leases, "worker-2");
  await submissions.submitResult(
    "worker-2",
    second.leaseId,
    second.inputHash,
    { answer: "right" },
  );
};

describe("M2 Task 6 adjudication service", () => {
  it("refuses an unproven diversity shortfall", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-1",
        windowId: "2026-W32",
        windowStartsAt: "2026-08-03T00:00:00.000Z",
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "splitAndAdjudication",
        laneLimit: 1,
      },
      at: NOW,
    });
    const service = new AdjudicationService({
      ...state,
      source: adjudicationSource,
    });

    await expect(service.openResult({
      jobId: "job-1",
      collectionCycle: 1,
      reason: "diversity_shortfall",
    })).resolves.toEqual({ kind: "invalid_request" });
    expect(await state.store.getResultState("job-1", 1)).toBe("collecting");
    expect(await state.store.listPendingResultAdjudications("class-1"))
      .toEqual([]);
  });

  it("opens a reserve-bound result dispute and replays an authenticated rejection", async () => {
    const { clock, events, ids, leases, registry, store, submissions } = await setup();
    await createSplit(leases, submissions);
    await store.initializeReservePolicy({
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-1",
        windowId: "2026-W32",
        windowStartsAt: "2026-08-03T00:00:00.000Z",
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "splitAndAdjudication",
        laneLimit: 1,
      },
      at: NOW,
    });
    const service = new AdjudicationService({
      store,
      registry,
      clock,
      ids,
      source: adjudicationSource,
      events,
    });
    const opened = await service.openResult({
      jobId: "job-1",
      collectionCycle: 1,
      reason: "split_exhausted",
    });
    expect(opened.kind).toBe("opened_charged");
    const pending = await store.listPendingResultAdjudications("class-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.openedAt).toBe(NOW);

    clock.set(LATER);
    const request = pending[0]!.request;
    const verdict: ResultAdjudicationVerdict = {
      kind: "human",
      resultAdjudicationRequestId: request.id,
      reason: request.reason,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      inputHash: request.inputHash,
      candidateResultHashes: request.candidateResultHashes,
      evidence: request.evidence,
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      adjudicatorId: "human-1",
      decision: { kind: "reject" },
      decidedAt: NOW,
    };
    const applied = await service.applyResultVerdict(verdict);
    expect(applied).toMatchObject({
      kind: "applied",
      receipt: {
        decidedAt: NOW,
        outcome: "rejected",
        rejectOutcome: "requeued",
      },
    });
    await expect(service.applyResultVerdict(verdict)).resolves.toMatchObject({
      kind: "replayed",
      receipt: { outcome: "rejected", rejectOutcome: "requeued" },
    });
    expect(await store.getResultState("job-1", 1)).toBe("rejected");
    expect(await store.getJob("job-1")).toMatchObject({
      collectionCycle: 2,
      cycleStartedAt: LATER,
    });
    expect(events.all().filter((event) => event.type === "verdict"))
      .toHaveLength(2);
  });

  it("authenticates verdicts before changing the pending request", async () => {
    const state = await setup();
    await createSplit(state.leases, state.submissions);
    await state.store.initializeReservePolicy({
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-1",
        windowId: "2026-W32",
        windowStartsAt: "2026-08-03T00:00:00.000Z",
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "splitAndAdjudication",
        laneLimit: 1,
      },
      at: NOW,
    });
    const opening = new AdjudicationService({
      ...state,
      source: adjudicationSource,
    });
    await opening.openResult({
      jobId: "job-1",
      collectionCycle: 1,
      reason: "split_exhausted",
    });
    const request = (await state.store.listPendingResultAdjudications("class-1"))[0]!.request;
    const denied = new AdjudicationService({
      ...state,
      source: { ...adjudicationSource, authenticate: () => false },
    });
    const verdict: ResultAdjudicationVerdict = {
      kind: "human",
      resultAdjudicationRequestId: request.id,
      reason: request.reason,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      inputHash: request.inputHash,
      candidateResultHashes: request.candidateResultHashes,
      evidence: request.evidence,
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      adjudicatorId: "human-1",
      decision: { kind: "reject" },
      decidedAt: LATER,
    };
    await expect(denied.applyResultVerdict(verdict))
      .resolves.toEqual({ kind: "unauthenticated" });
    expect(await state.store.getResultState("job-1", 1))
      .toBe("pending_result_adjudication");
  });

  it("uses processing time to invalidate an overdue first result verdict", async () => {
    const { clock, events, ids, leases, registry, store, submissions } = await setup();
    await createSplit(leases, submissions);
    await store.initializeReservePolicy({
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "reserves-1",
        windowId: "2026-W32",
        windowStartsAt: "2026-08-03T00:00:00.000Z",
        windowEndsAt: "2026-08-10T00:00:00.000Z",
        lane: "splitAndAdjudication",
        laneLimit: 1,
      },
      at: NOW,
    });
    const service = new AdjudicationService({
      store,
      registry,
      clock,
      ids,
      source: adjudicationSource,
      events,
    });
    await service.openResult({
      jobId: "job-1",
      collectionCycle: 1,
      reason: "split_exhausted",
    });
    const request = (await store.listPendingResultAdjudications("class-1"))[0]!
      .request;
    clock.set("2026-08-07T12:30:01.000Z");
    await expect(service.applyResultVerdict({
      kind: "human",
      resultAdjudicationRequestId: request.id,
      reason: request.reason,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      inputHash: request.inputHash,
      candidateResultHashes: request.candidateResultHashes,
      evidence: request.evidence,
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      adjudicatorId: "human-1",
      decision: { kind: "reject" },
      decidedAt: NOW,
    })).resolves.toEqual({ kind: "freshness_conflict" });
    expect(await store.getResultState("job-1", 1)).toBe("expired");
    expect(await store.getJob("job-1")).toMatchObject({
      collectionCycle: 2,
      cycleStartedAt: "2026-08-07T12:30:01.000Z",
    });
    expect(await store.getVerdictHistory(request.id)).toBeNull();
  });

  it("applies and exactly replays an authenticated action verdict", async () => {
    const state = await setup(1);
    const lease = await claim(state.leases, "worker-1");
    await state.submissions.submitResult(
      "worker-1",
      lease.leaseId,
      lease.inputHash,
      { answer: "approved" },
    );
    const replicas = await state.store.listAcceptedReplicas("job-1", 1);
    const decisionResultHash = await computeDecisionResultHash({
      result: { answer: "approved" },
      evidence: replicas.map((replica) => replica.evidence),
    });
    const decision = await state.store.getDecisionResult(decisionResultHash);
    expect(decision).not.toBeNull();
    const policy = {
      classId: "class-1",
      contractVersion: "1.0.0",
      policyVersion: "reserves-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "splitAndAdjudication" as const,
      laneLimit: 1,
    };
    const lowCostPolicy = {
      classId: "class-1",
      contractVersion: "1.0.0",
      policyVersion: "low-cost-reserves-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "lowCost" as const,
      laneLimit: 2,
      perWorkerLimit: 2,
    };
    await state.store.initializeReservePolicy({ policy: lowCostPolicy, at: NOW });
    await state.store.initializeReservePolicy({ policy, at: NOW });
    const effectIntent: EffectIntent = {
      id: "effect-intent-1",
      effects: [
        {
          action: "routeToHumanLowCost" as const,
          descriptor: { reason: "approved" },
        },
        { action: "suppress" as const, descriptor: { reason: "unsafe" } },
      ],
    };
    const effectIntentHash = await computeEffectIntentHash(effectIntent);
    const authorizationRequestId = state.ids.next("authorization_request");
    const inspectedContext = await state.store.inspectAuthorizationContext(
      decisionResultHash,
    );
    expect(inspectedContext).not.toBeNull();
    const expectedContext = {
      ...inspectedContext!,
      maxInFlightDeadline: "2026-08-07T12:30:01.000Z",
    };
    const request: ActionAdjudicationRequest = {
      authorizationRequestId,
      jobId: "job-1",
      collectionCycle: 1,
      effectIntent,
      effectIntentHash,
      inputHash: lease.inputHash,
      decisionResultHash,
      evidence: replicas.map((replica) => replica.evidence),
      contractVersion: "1.0.0",
      permitEpoch: "epoch-1",
      humanReviews: [{
        action: "suppress" as const,
        predicate: "human-reviewed",
        requiredPayloadPaths: [],
        requiredResultPaths: [],
        requiredEffectPaths: ["$.reason" as const],
      }],
    };
    await expect(state.store.authorizeOrReplayIntent({
      authorizationRequestId,
      effectIntent,
      effectIntentHash,
      decisionResultHash,
      expectedContext,
      decision: {
        kind: "pend",
        request,
        charges: [
          {
            chargeKey: `${authorizationRequestId}:lowCost`,
            workerIds: ["worker-1", "worker-2"],
            policy: lowCostPolicy,
            at: NOW,
          },
          {
            chargeKey: `${authorizationRequestId}:splitAndAdjudication`,
            workerIds: [],
            policy,
            at: NOW,
          },
        ],
      },
      at: NOW,
    })).resolves.toMatchObject({
      kind: "applied",
      initialReceipt: { outcome: "pending_adjudication" },
    });

    const service = new AdjudicationService({
      store: state.store,
      registry: state.registry,
      clock: state.clock,
      ids: state.ids,
      source: adjudicationSource,
      events: state.events,
    });
    state.clock.set(LATER);
    const verdict = {
      kind: "human" as const,
      jobId: "job-1",
      collectionCycle: 1,
      authorizationRequestId,
      effectIntentId: effectIntent.id,
      effectIntentHash,
      actions: ["routeToHumanLowCost" as const, "suppress" as const],
      inputHash: lease.inputHash,
      decisionResultHash,
      evidence: replicas.map((replica) => replica.evidence),
      contractVersion: "1.0.0",
      permitEpoch: "epoch-1",
      adjudicatorId: "human-1",
      decision: "approve" as const,
      decidedAt: LATER,
    };
    await expect(service.applyActionVerdict(verdict)).resolves.toMatchObject({
      kind: "applied",
      receipt: { outcome: "approved" },
    });
    await expect(service.applyActionVerdict(verdict)).resolves.toMatchObject({
      kind: "replayed",
      receipt: { outcome: "approved" },
    });
    expect(await state.store.getAuthorizationStatus(authorizationRequestId))
      .toEqual({ state: "authorized", validity: { kind: "valid" } });
    expect(await state.store.getAuthorization(authorizationRequestId))
      .toMatchObject({
        authorizationRequestId,
        actionAdjudicationVerdictHash: expect.any(String),
        actions: ["routeToHumanLowCost", "suppress"],
      });

    const urgentPolicy = {
      classId: "class-1",
      contractVersion: "1.0.0",
      policyVersion: "urgent-reserves-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "urgent" as const,
      laneLimit: 0,
      perWorkerLimit: 0,
    };
    await state.store.initializeReservePolicy({ policy: urgentPolicy, at: LATER });
    const urgentIntent: EffectIntent = {
      id: "effect-intent-urgent",
      effects: [{ action: "routeToUrgent", descriptor: { reason: "urgent" } }],
    };
    const urgentIntentHash = await computeEffectIntentHash(urgentIntent);
    const urgentRequestId = state.ids.next("authorization_request");
    await expect(state.store.authorizeOrReplayIntent({
      authorizationRequestId: urgentRequestId,
      effectIntent: urgentIntent,
      effectIntentHash: urgentIntentHash,
      decisionResultHash,
      expectedContext,
      decision: {
        kind: "authorize",
        authorization: {
          authorizationRequestId: urgentRequestId,
          effectIntentId: urgentIntent.id,
          effectIntentHash: urgentIntentHash,
          jobId: "job-1",
          collectionCycle: 1,
          inputHash: lease.inputHash,
          decisionResultHash,
          evidence: replicas.map((replica) => replica.evidence),
          contractVersion: "1.0.0",
          permitEpoch: "epoch-1",
          actions: ["routeToUrgent"],
        },
        charges: [
          {
            chargeKey: `${urgentRequestId}:lowCost`,
            workerIds: ["worker-1"],
            policy: lowCostPolicy,
            at: LATER,
          },
          {
            chargeKey: `${urgentRequestId}:urgent`,
            workerIds: ["worker-1"],
            policy: urgentPolicy,
            at: LATER,
          },
        ],
      },
      at: LATER,
    })).resolves.toMatchObject({
      kind: "applied",
      initialReceipt: {
        outcome: "denied",
        denialReason: "escalation_budget_exhausted",
      },
      reserveBatch: {
        settlements: [{ charge: { outcome: "exhausted" } }],
        skippedLanes: ["lowCost"],
      },
    });
    expect(await state.store.getAuthorization(urgentRequestId)).toBeNull();
    expect(await state.store.getReservePolicy({
      classId: "class-1",
      contractVersion: "1.0.0",
      lane: "lowCost",
    })).toMatchObject({ used: 1 });

    const invalidation = new InvalidationService({
      store: state.store,
      registry: state.registry,
      clock: state.clock,
      events: state.events,
    });
    await expect(invalidation.invalidate({
      scope: {
        kind: "job_cycles",
        classId: "class-1",
        jobCycles: [{ jobId: "job-1", collectionCycle: 1 }],
      },
      reason: "operator_cancelled",
    })).resolves.toMatchObject({ kind: "applied" });
    expect(await state.store.getAuthorizationStatus(authorizationRequestId))
      .toEqual({
        state: "authorized",
        validity: {
          kind: "invalid",
          reason: "operator_cancelled",
          invalidatedAt: LATER,
        },
      });
    expect(await state.store.getInitialReceipt(effectIntent.id))
      .toMatchObject({ outcome: "pending_adjudication" });
    expect(state.events.all()).toContainEqual(expect.objectContaining({
      type: "authorization_validity_change",
      authorizationRequestId,
      reason: "operator_cancelled",
    }));
    state.registry.unload("class-1", "1.0.0");
    state.clock.set("2026-08-08T12:00:00.000Z");
    await expect(service.applyActionVerdict(verdict)).resolves.toMatchObject({
      kind: "replayed",
      receipt: { outcome: "approved" },
    });
  });
});

describe("M2 Task 6 invalidation service", () => {
  it("withdraws an epoch and atomically starts a freshly hashed cycle", async () => {
    const { clock, events, registry, store } = await setup();
    clock.set(LATER);
    const service = new InvalidationService({ store, registry, clock, events });
    const oldHash = (await store.getJob("job-1"))!.inputHash;
    const outcome = await service.invalidate({
      scope: { kind: "permit_epoch", classId: "class-1", permitEpoch: "epoch-1" },
      reason: "emergency_permit_withdrawal",
      toEpoch: "epoch-2",
    });
    expect(outcome.kind).toBe("applied");
    expect(await store.getCurrentPermitEpoch("class-1")).toBe("epoch-2");
    expect(await store.getResultState("job-1", 1)).toBe("superseded");
    expect(await store.getJob("job-1")).toMatchObject({
      collectionCycle: 2,
      permitEpoch: "epoch-2",
    });
    expect((await store.getJob("job-1"))!.inputHash).not.toBe(oldHash);
    expect(events.all()).toContainEqual(expect.objectContaining({
      type: "permit_epoch_change",
      fromEpoch: "epoch-1",
      toEpoch: "epoch-2",
      emergency: true,
    }));
  });
});
