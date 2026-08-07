import {
  computeDecisionResultHash,
  type ClassHealth,
  type EffectIntent,
  type JobClass,
  type JSONSchema,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { ActionAuthorizationService } from "../src/action-authorization-service.js";
import { LeaseService } from "../src/lease-service.js";
import { InMemoryStore } from "../src/memory-store.js";
import type {
  ReputationPolicy,
  ReservePolicySnapshot,
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

type Payload = { instruction: string; private: string };
type Result = { answer: string };

const objectSchema = (
  properties: Record<string, { type: "string" }>,
): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const effectSchema = objectSchema({ reason: { type: "string" } });

const definition = (): JobClass<Payload, Result> => ({
  id: "class-1",
  contractVersion: "1.0.0",
  kind: "oneshot",
  payloadSchema: objectSchema({
    instruction: { type: "string" },
    private: { type: "string" },
  }),
  outputSchema: objectSchema({ answer: { type: "string" } }),
  maxPayloadBytes: 4_096,
  maxResultBytes: 4_096,
  sanitize: (raw) => raw as Payload,
  verification: "structural_only",
  validators: [],
  oracles: [{
    id: "urgent-support",
    kind: "support",
    predicates: ["urgent-supported"],
    run: (_payload, result) => result.answer === "approved"
      ? { kind: "pass" }
      : { kind: "fail", code: "not-approved" },
    coversPayloadPaths: [],
    coversResultPaths: ["$.answer"],
    negativeFixtures: [{
      name: "not approved",
      payload: { instruction: "answer", private: "hidden" },
      result: { answer: "bad" },
      predicate: "urgent-supported",
      category: "unsupported_material",
    }],
  }],
  replication: { target: 1, maxSplitEvidenceReroutes: 0 },
  permits: [
    {
      action: "routeToHumanLowCost",
      mode: "automatic",
      effectSchema,
      effectInput: {
        payloadPaths: ["$.instruction"],
        resultPaths: ["$.answer"],
      },
      deriveEffect: ({ payload, result }) => ({
        reason: `${Object.keys(payload as object).join(",")}:${
          (result as Result).answer
        }`,
      }),
      effectFixtures: [{
        input: {
          payload: { instruction: "answer", private: "hidden" },
          result: { answer: "approved" },
        },
        expectedDescriptor: { reason: "instruction:approved" },
      }],
    },
    {
      action: "routeToUrgent",
      mode: "automatic",
      effectSchema,
      effectInput: { payloadPaths: [], resultPaths: ["$.answer"] },
      deriveEffect: ({ result }) => ({
        reason: (result as Result).answer,
      }),
      effectFixtures: [{
        input: {
          payload: { instruction: "answer", private: "hidden" },
          result: { answer: "approved" },
        },
        expectedDescriptor: { reason: "approved" },
      }],
    },
    {
      action: "suppress",
      mode: "human_only",
      effectSchema,
      reviewRequirement: {
        predicate: "human-reviewed",
        requiredPayloadPaths: [],
        requiredResultPaths: [],
        requiredEffectPaths: ["$.reason"],
        requiredAbsenceDomain: {
          id: "all-input",
          payloadPaths: ["$"],
        },
      },
    },
  ],
  consequence: "low",
  surface: "unbounded",
  evidenceRequirements: [{
    action: "routeToUrgent",
    predicate: "urgent-supported",
    requiredPayloadPaths: [],
    requiredResultPaths: ["$.answer"],
  }],
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
    lowCostPerWeek: 2,
    urgentPerWeek: 0,
    splitAndAdjudicationPerWeek: 2,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 2,
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
  assignSlot: () => 1,
  routingAt: ({ at }) => ({
    contributionWindowId: at.slice(0, 10),
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-1`,
    slotOpen: true,
  }),
};

const reputationPolicy: ReputationPolicy = {
  assess: () => ({ eligible: true }),
};

const policy = (
  lane: "lowCost" | "splitAndAdjudication",
  laneLimit = 2,
): ReservePolicySnapshot => {
  const common = {
    classId: "class-1",
    contractVersion: "1.0.0",
    policyVersion: `${lane}-policy-1`,
    windowId: "2026-W32",
    windowStartsAt: "2026-08-03T00:00:00.000Z",
    windowEndsAt: "2026-08-10T00:00:00.000Z",
    laneLimit,
  };
  return lane === "lowCost"
    ? { ...common, lane, perWorkerLimit: laneLimit }
    : { ...common, lane };
};

const setup = async () => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const clock = new ManualClock(NOW);
  const registry = new RuntimeClassRegistry();
  const events = new RecordingEventSink();
  const ids = new SequenceIdSource("task7");
  const jobClass = definition();
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
  await store.registerWorker({
    worker: {
      workerId: "worker-1",
      state: "active",
      enrolledAt: NOW,
      declaredCapPerWeek: 10,
      capabilities: {
        providerSurface: "provider-1",
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: [jobClass.id],
      },
      accountCluster: "cluster-1",
      slot: 1,
      contractAcceptance: {
        contractVersion: "1.1.0",
        acceptedAt: NOW,
      },
    },
    routing: {
      contributionWindowId: NOW.slice(0, 10),
      contributionUsed: 0,
      assignedSlotOccurrence: `${NOW.slice(0, 10)}-slot-1`,
    },
  });
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
    rawPayload: { instruction: "answer", private: "hidden" },
    policyVersion: "policy-1",
    priority: { lane: "normal", value: 1, sequence: "sequence-1" },
  });
  const leased = await leases.leaseJob("worker-1");
  if (leased.outcome !== "lease") throw new Error("expected lease");
  await submissions.submitResult(
    "worker-1",
    leased.lease.leaseId,
    leased.lease.inputHash,
    { answer: "approved" },
  );
  const replicas = await store.listAcceptedReplicas("job-1", 1);
  const decisionResultHash = await computeDecisionResultHash({
    result: { answer: "approved" },
    evidence: replicas.map((replica) => replica.evidence),
  });
  const service = new ActionAuthorizationService({
    store,
    registry,
    clock,
    ids,
    events,
  });
  return { clock, decisionResultHash, events, registry, service, store };
};

const automaticIntent = (id = "intent-1"): EffectIntent => ({
  id,
  effects: [{
    action: "routeToHumanLowCost",
    descriptor: { reason: "instruction:approved" },
  }],
});

describe("M2 Task 7 action authorization", () => {
  it("authorizes projected automatic descriptors and exactly replays", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({ policy: policy("lowCost"), at: NOW });
    const first = await state.service.authorizeActions(
      state.decisionResultHash,
      automaticIntent(),
    );
    expect(first).toMatchObject({
      ok: true,
      receipt: { outcome: "authorized" },
    });
    if (!first.ok) throw new Error("expected authorization");
    const requestId = first.receipt.authorizationRequestId;
    expect(await state.service.getAuthorizationStatus(requestId)).toEqual({
      state: "authorized",
      validity: { kind: "valid" },
    });
    expect(await state.store.getAuthorization(requestId)).toMatchObject({
      actions: ["routeToHumanLowCost"],
      evidence: [{ workerId: "worker-1" }],
    });
    state.registry.unload("class-1", "1.0.0");
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      automaticIntent(),
    )).resolves.toEqual(first);
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      { ...automaticIntent(), effects: [{
        action: "routeToHumanLowCost",
        descriptor: { reason: "changed" },
      }] },
    )).resolves.toEqual({ ok: false, error: "authorization_conflict" });
    expect(state.events.all()).toContainEqual(expect.objectContaining({
      type: "gate_decision",
      authorizationRequestId: requestId,
      outcome: "authorized",
    }));
  });

  it("rejects a descriptor mismatch without claiming an identity", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({ policy: policy("lowCost"), at: NOW });
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      { ...automaticIntent(), effects: [{
        action: "routeToHumanLowCost",
        descriptor: { reason: "private:approved" },
      }] },
    )).resolves.toEqual({ ok: false, error: "effect_descriptor_mismatch" });
    const accepted = await state.service.authorizeActions(
      state.decisionResultHash,
      automaticIntent("intent-2"),
    );
    expect(accepted).toMatchObject({
      ok: true,
      receipt: { authorizationRequestId: "task7-authorization_request-1" },
    });
  });

  it("persists a typed all-actions denial for an unpermitted action", async () => {
    const state = await setup();
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      {
        id: "intent-unpermitted",
        effects: [{ action: "publish", descriptor: { destination: "public" } }],
      },
    )).resolves.toMatchObject({
      ok: true,
      receipt: { outcome: "denied", denialReason: "permit_rejected" },
    });
  });

  it("denies the complete intent when the achieved strength misses a gate", async () => {
    const state = await setup();
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      {
        id: "intent-weak",
        effects: [{
          action: "routeToUrgent",
          descriptor: { reason: "approved" },
        }],
      },
    )).resolves.toMatchObject({
      ok: true,
      receipt: { outcome: "denied", denialReason: "gate_failed" },
    });
  });

  it("binds only the human subset and charges every applicable lane", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({ policy: policy("lowCost"), at: NOW });
    await state.store.initializeReservePolicy({
      policy: policy("splitAndAdjudication"),
      at: NOW,
    });
    const result = await state.service.authorizeActions(
      state.decisionResultHash,
      {
        id: "intent-mixed",
        effects: [
          {
            action: "routeToHumanLowCost",
            descriptor: { reason: "instruction:approved" },
          },
          { action: "suppress", descriptor: { reason: "human decision" } },
        ],
      },
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: { outcome: "pending_adjudication" },
    });
    if (!result.ok) throw new Error("expected pending request");
    const request = await state.store.getActionAdjudicationRequest(
      result.receipt.authorizationRequestId,
    );
    expect(request?.humanReviews).toEqual([expect.objectContaining({
      action: "suppress",
    })]);
    expect(await state.store.getReservePolicy({
      classId: "class-1",
      contractVersion: "1.0.0",
      lane: "lowCost",
    })).toMatchObject({ used: 1, workerUsage: [{ workerId: "worker-1", used: 1 }] });
    expect(await state.store.getReservePolicy({
      classId: "class-1",
      contractVersion: "1.0.0",
      lane: "splitAndAdjudication",
    })).toMatchObject({ used: 1, workerUsage: [] });
  });

  it("fails closed without partially charging a later human lane", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({
      policy: policy("lowCost", 0),
      at: NOW,
    });
    await state.store.initializeReservePolicy({
      policy: policy("splitAndAdjudication"),
      at: NOW,
    });
    const result = await state.service.authorizeActions(
      state.decisionResultHash,
      {
        id: "intent-exhausted",
        effects: [
          {
            action: "routeToHumanLowCost",
            descriptor: { reason: "instruction:approved" },
          },
          { action: "suppress", descriptor: { reason: "human decision" } },
        ],
      },
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        outcome: "denied",
        denialReason: "escalation_budget_exhausted",
      },
    });
    expect(await state.store.getReservePolicy({
      classId: "class-1",
      contractVersion: "1.0.0",
      lane: "splitAndAdjudication",
    })).toMatchObject({ used: 0 });
    expect(await state.store.listPendingActionAdjudications("class-1"))
      .toEqual([]);
  });

  it("retires an overdue result before creating a new intent", async () => {
    const state = await setup();
    await state.store.initializeReservePolicy({ policy: policy("lowCost"), at: NOW });
    state.clock.set("2026-08-07T12:30:01.000Z");
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      automaticIntent("intent-overdue"),
    )).resolves.toEqual({ ok: false, error: "intent_invalid" });
    expect(await state.store.getResultState("job-1", 1)).toBe("expired");
    expect(await state.store.getJob("job-1")).toMatchObject({
      collectionCycle: 2,
      cycleStartedAt: "2026-08-07T12:30:01.000Z",
    });
    expect(await state.store.getInitialReceipt("intent-overdue")).toBeNull();
  });

  it("retires a contract-expired result even after runtime unload", async () => {
    const state = await setup();
    await state.store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "retired",
      at: NOW,
    });
    state.registry.unload("class-1", "1.0.0");
    await expect(state.service.authorizeActions(
      state.decisionResultHash,
      automaticIntent("intent-retired"),
    )).resolves.toEqual({ ok: false, error: "intent_invalid" });
    expect(await state.store.getResultState("job-1", 1)).toBe("expired");
    expect(await state.store.getInitialReceipt("intent-retired")).toBeNull();
  });
});
