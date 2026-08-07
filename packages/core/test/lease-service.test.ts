import {
  computeInputHash,
  computeResultHash,
  type ClassHealth,
  type JobClass,
  type JSONSchema,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { LeaseService } from "../src/lease-service.js";
import { InMemoryStore } from "../src/memory-store.js";
import type {
  ReputationPolicy,
  WorkerControlPolicy,
} from "../src/ports.js";
import { RuntimeClassRegistry } from "../src/registration.js";
import {
  ManualClock,
  RecordingEventSink,
  SequenceIdSource,
} from "../src/testing.js";

const NOW = "2026-08-07T08:00:00.000Z";

type Payload = { instruction: string };
type Result = { answer: string };

const objectSchema = (property: string): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: { [property]: { type: "string" } },
  required: [property],
});

const jobClass = (): JobClass<Payload, Result> => ({
  id: "class-1",
  contractVersion: "1.0.0",
  kind: "oneshot",
  payloadSchema: objectSchema("instruction"),
  outputSchema: objectSchema("answer"),
  maxPayloadBytes: 4_096,
  maxResultBytes: 4_096,
  sanitize: (raw) => ({
    instruction: String((raw as { instruction?: unknown }).instruction ?? "").trim(),
  }),
  verification: "structural_only",
  validators: [],
  oracles: [],
  replication: { target: 1, maxSplitEvidenceReroutes: 0 },
  permits: [],
  consequence: "low",
  surface: "unbounded",
  evidenceRequirements: [],
  absenceRequirements: [],
  requires: {
    providerSurfaces: ["provider.example"],
    unattendedScheduling: true,
    languages: ["en"],
  },
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
    splitAndAdjudicationPerWeek: 0,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 0,
    perWorkerUrgentQuotaPerWeek: 0,
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

const reputationPolicy: ReputationPolicy = {
  assess: () => ({ eligible: true, priority: 0 }),
};

const setup = async (options: {
  state?: "enrolled" | "active";
  classDefinition?: JobClass<Payload, Result>;
  policy?: WorkerControlPolicy;
  reputation?: ReputationPolicy;
} = {}) => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const clock = new ManualClock(NOW);
  const registry = new RuntimeClassRegistry();
  const events = new RecordingEventSink();
  const definition = options.classDefinition ?? jobClass();
  registry.load({
    jobClass: definition,
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
  });
  await store.registerClassVersion({
    classId: definition.id,
    contractVersion: definition.contractVersion,
    payloadSchemaHash: "payload-schema-1",
    outputSchemaHash: "output-schema-1",
    registeredAt: NOW,
  });
  await store.initializeClassHealth({
    initial: {
      classId: definition.id,
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic",
    },
  });
  await store.transitionClassVersion({
    classId: definition.id,
    contractVersion: definition.contractVersion,
    from: "draft",
    to: "active",
    at: NOW,
  });
  await store.transitionPermitEpoch({
    classId: definition.id,
    fromEpoch: null,
    toEpoch: "epoch-1",
    at: NOW,
  });
  await store.registerWorker({
    worker: {
      workerId: "worker-1",
      state: options.state ?? "active",
      enrolledAt: NOW,
      declaredCapPerWeek: 4,
      capabilities: {
        providerSurface: "provider.example",
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: [definition.id],
      },
      accountCluster: "cluster-1",
      slot: 2,
      contractAcceptance: {
        contractVersion: "1.1.0",
        acceptedAt: NOW,
      },
    },
    routing: {
      contributionWindowId: NOW.slice(0, 10),
      contributionUsed: 0,
      assignedSlotOccurrence: `${NOW.slice(0, 10)}-slot-2`,
    },
  });
  const service = new LeaseService({
    store,
    registry,
    clock,
    ids: new SequenceIdSource("task4"),
    events,
    workerPolicy: options.policy ?? workerPolicy(),
    reputationPolicy: options.reputation ?? reputationPolicy,
    deploymentPolicy: {
      version: "deployment-1",
      extensionTtl: 300,
      maxExtensionsPerLease: 2,
    },
  });
  return { clock, definition, events, service, store };
};

const enqueue = (
  service: LeaseService,
  jobId = "job-1",
  overrides: Partial<Parameters<LeaseService["enqueue"]>[0]> = {},
) => service.enqueue({
  jobId,
  classId: "class-1",
  contractVersion: "1.0.0",
  rawPayload: { instruction: `  process ${jobId}  ` },
  policyVersion: "policy-1",
  priority: { lane: "normal", value: 1, sequence: `sequence-${jobId}` },
  ...overrides,
});

describe("M2 Task 4 enqueue", () => {
  it("hashes the exact sanitized payload and replays without changing enqueue time", async () => {
    const { clock, definition, service, store } = await setup();
    const first = await enqueue(service);
    expect(first).toMatchObject({
      ok: true,
      kind: "enqueued",
      job: { payloadRef: "job-1", collectionCycle: 1, permitEpoch: "epoch-1" },
    });
    const payload = { instruction: "process job-1" };
    const expectedHash = await computeInputHash({
      payload,
      payload_schema: definition.payloadSchema,
      job_class_id: definition.id,
      contract_version: definition.contractVersion,
      output_schema: definition.outputSchema,
      policy_version: "policy-1",
      permit_epoch: "epoch-1",
    });
    expect(await store.getJob("job-1")).toMatchObject({ inputHash: expectedHash });
    expect(await store.getPayload("job-1")).toEqual(payload);

    clock.advance(60);
    await expect(enqueue(service)).resolves.toMatchObject({
      ok: true,
      kind: "replayed",
      job: { firstEnqueuedAt: NOW },
    });
    await expect(enqueue(service, "job-1", {
      rawPayload: { instruction: "different" },
    })).resolves.toMatchObject({ ok: false, kind: "conflict" });
    const queue = await store.getQueueMode();
    await store.transitionQueueMode({
      expected: queue,
      next: {
        mode: "admission_halted",
        cause: "operator",
        updatedAt: "2026-08-07T08:02:00.000Z",
      },
    });
    await expect(enqueue(service)).resolves.toMatchObject({
      ok: true,
      kind: "replayed",
    });
  });

  it("fails closed on schema, lifecycle, and intake-blocking reserve health", async () => {
    const { service, store } = await setup();
    await expect(enqueue(service, "invalid", {
      rawPayload: { instruction: "x".repeat(5_000) },
    })).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "payload_too_large",
    });
    const readHealth = store.getClassHealth.bind(store);
    store.getClassHealth = async (classId) => {
      const health = await readHealth(classId);
      return health === null
        ? null
        : {
            ...health,
            health: {
              ...health.health,
              reserves: { ...health.health.reserves, audit: "saturated" },
            },
          };
    };
    await expect(enqueue(service, "blocked"))
      .resolves.toEqual({ ok: false, kind: "refused", reason: "operational_state" });
  });

  it("refuses an out-of-range payload-derived TTL before listing a candidate", async () => {
    const definition = jobClass();
    definition.cost.leaseTtl = () => definition.cost.maxLeaseTtl + 1;
    const { service, store } = await setup({ classDefinition: definition });
    await expect(enqueue(service)).resolves.toEqual({
      ok: false,
      kind: "invalid",
      reason: "lease_ttl_out_of_range",
    });
    expect(await store.getJob("job-1")).toBeNull();
    expect(await store.listLeaseCandidates({ classIds: ["class-1"] })).toEqual([]);
  });
});

describe("M2 Task 4 routing and claim", () => {
  it("accounts for no-work, honors priority, and snapshots a quantized lease", async () => {
    const { events, service, store } = await setup();
    await expect(service.leaseJob("worker-1")).resolves.toEqual({ outcome: "no_work" });
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1 });

    await enqueue(service, "normal", {
      priority: { lane: "normal", value: 100, sequence: "sequence-normal" },
    });
    await enqueue(service, "urgent", {
      priority: { lane: "urgent", value: 1, sequence: "sequence-urgent" },
    });
    const result = await service.leaseJob("worker-1");
    expect(result).toMatchObject({
      outcome: "lease",
      lease: {
        jobId: "urgent",
        inputHash: expect.any(String),
        issuedAt: NOW,
        expiresAt: "2026-08-07T08:05:00.000Z",
        extensionsUsed: 0,
        assignment: { kind: "ordinary" },
        routing: { contributionOrdinal: 2, attemptNumber: 1 },
      },
      payload: { instruction: "process urgent" },
    });
    expect(events.all()).toContainEqual(expect.objectContaining({
      type: "lease",
      jobId: "urgent",
      workerId: "worker-1",
      canary: false,
    }));
  });

  it("transitions the deployment-owned routing period before counting work", async () => {
    const policy = workerPolicy();
    policy.routingAt = ({ slot }) => ({
      contributionWindowId: "2026-W33",
      assignedSlotOccurrence: `2026-W33-slot-${slot}`,
      slotOpen: true,
    });
    const { service, store } = await setup({ policy });
    await expect(service.leaseJob("worker-1")).resolves.toEqual({ outcome: "no_work" });
    expect(await store.getWorkerRoutingSnapshot("worker-1")).toMatchObject({
      contributionWindowId: "2026-W33",
      assignedSlotOccurrence: "2026-W33-slot-2",
      contributionUsed: 1,
      revision: 3,
    });
  });

  it("honors not-before and stops accounting at the declared contribution cap", async () => {
    const { clock, service, store } = await setup();
    await enqueue(service, "future", {
      notBefore: "2026-08-07T08:10:00.000Z",
    });
    await expect(service.leaseJob("worker-1")).resolves.toEqual({ outcome: "no_work" });
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1 });
    clock.set("2026-08-07T08:10:00.000Z");
    await expect(service.leaseJob("worker-1"))
      .resolves.toMatchObject({ outcome: "lease", lease: { jobId: "future" } });
    await service.abandonLease(
      "worker-1",
      "task4-lease-1",
      "provider_or_platform_failure",
    );
    await service.leaseJob("worker-1");
    await service.leaseJob("worker-1");
    await service.leaseJob("worker-1");
    const capped = await store.getWorkerRoutingSnapshot("worker-1");
    expect(capped?.contributionUsed).toBe(4);
    await service.leaseJob("worker-1");
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 4 });
  });

  it("fails worker capability, slot, and reputation policy checks closed", async () => {
    const incompatible = jobClass();
    incompatible.requires.languages = ["hy"];
    const capability = await setup({ classDefinition: incompatible });
    await enqueue(capability.service);
    await expect(capability.service.leaseJob("worker-1"))
      .resolves.toEqual({ outcome: "no_work" });
    expect(await capability.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1 });

    const closedPolicy = workerPolicy();
    closedPolicy.routingAt = ({ slot, at }) => ({
      contributionWindowId: at.slice(0, 10),
      assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
      slotOpen: false,
    });
    const closed = await setup({ policy: closedPolicy });
    await enqueue(closed.service);
    await closed.service.leaseJob("worker-1");
    expect(await closed.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 0 });

    const reputation = await setup({
      reputation: { assess: () => ({ eligible: false, priority: 1 }) },
    });
    await enqueue(reputation.service);
    await reputation.service.leaseJob("worker-1");
    expect(await reputation.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1 });
  });

  it("binds a probation canary's distinct payload and expected-result hash", async () => {
    const definition = jobClass();
    definition.canaries = {
      rates: { probationQ: 1, productionQ: 1, auditQ: 0 },
      draw: () => ({
        canaryId: "canary-1",
        sourceJobId: "resolved-1",
        contractVersion: "1.0.0",
        payload: { instruction: "known canary" },
        expected: { answer: "known answer" },
      }),
    };
    const { service, store } = await setup({
      state: "enrolled",
      classDefinition: definition,
    });
    await enqueue(service);
    const result = await service.leaseJob("worker-1");
    expect(result.outcome).toBe("lease");
    if (result.outcome !== "lease") return;
    expect(result.payload).toEqual({ instruction: "known canary" });
    expect(result.lease.payloadRef).toBe(result.lease.leaseId);
    expect(result.lease.inputHash).not.toBe((await store.getJob("job-1"))?.inputHash);
    expect(result.lease.assignment).toEqual({
      kind: "canary",
      canaryKind: "probation",
      canaryId: "canary-1",
      sourceJobId: "resolved-1",
      sourceContractVersion: "1.0.0",
      expectedResultHash: await computeResultHash({ answer: "known answer" }),
    });
    expect(await store.getPayload(result.lease.leaseId))
      .toEqual({ instruction: "known canary" });
    expect(await store.getPayload("job-1"))
      .toEqual({ instruction: "process job-1" });
  });

  it("selects the separate retrospective-audit canary rate for active workers", async () => {
    const definition = jobClass();
    definition.canaries = {
      rates: { probationQ: 0, productionQ: 0, auditQ: 1 },
      draw: (kind) => ({
        canaryId: `canary-${kind}`,
        sourceJobId: "resolved-audit",
        contractVersion: "1.0.0",
        payload: { instruction: "audit canary" },
        expected: { answer: "audit answer" },
      }),
    };
    const { service } = await setup({ classDefinition: definition });
    await enqueue(service);
    const result = await service.leaseJob("worker-1");
    expect(result).toMatchObject({
      outcome: "lease",
      lease: {
        assignment: {
          kind: "canary",
          canaryKind: "audit",
          canaryId: "canary-audit",
        },
      },
      payload: { instruction: "audit canary" },
    });
  });
});

describe("M2 Task 4 lease lifecycle", () => {
  it("extends only the holder within the snapshotted cap and strict deadline", async () => {
    const { events, service } = await setup();
    await enqueue(service);
    const claimed = await service.leaseJob("worker-1");
    expect(claimed.outcome).toBe("lease");
    if (claimed.outcome !== "lease") return;
    await expect(service.extendLease("other-worker", claimed.lease.leaseId))
      .resolves.toEqual({ outcome: "refused" });
    await expect(service.extendLease("worker-1", claimed.lease.leaseId))
      .resolves.toEqual({
        outcome: "extended",
        newExpiry: "2026-08-07T08:10:00.000Z",
      });
    await expect(service.extendLease("worker-1", claimed.lease.leaseId))
      .resolves.toEqual({
        outcome: "extended",
        newExpiry: "2026-08-07T08:15:00.000Z",
      });
    await expect(service.extendLease("worker-1", claimed.lease.leaseId))
      .resolves.toEqual({ outcome: "refused" });
    expect(events.all().filter((event) => event.type === "lease_extend"))
      .toHaveLength(4);
  });

  it("does not extend a draining lease beyond the contract acceptance cutoff", async () => {
    const { service, store } = await setup();
    await enqueue(service);
    const claimed = await service.leaseJob("worker-1");
    expect(claimed.outcome).toBe("lease");
    if (claimed.outcome !== "lease") return;
    await store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "draining",
      at: NOW,
      leaseDisabledAt: NOW,
      acceptedUntil: "2026-08-07T08:09:00.000Z",
    });
    await expect(service.extendLease("worker-1", claimed.lease.leaseId))
      .resolves.toEqual({ outcome: "refused" });
  });

  it("requeues abandonments and expiry in-cycle with fair-attempt accounting", async () => {
    const { clock, events, service, store } = await setup();
    await enqueue(service);
    const first = await service.leaseJob("worker-1");
    expect(first.outcome).toBe("lease");
    if (first.outcome !== "lease") return;
    await expect(service.abandonLease(
      "worker-1",
      first.lease.leaseId,
      "abandoned_before_payload",
    )).resolves.toEqual({ outcome: "recorded" });
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 0, openLeaseIds: [] });
    expect(await store.getJob("job-1")).toMatchObject({ collectionCycle: 1 });

    const second = await service.leaseJob("worker-1");
    expect(second.outcome).toBe("lease");
    if (second.outcome !== "lease") return;
    await expect(service.abandonLease(
      "worker-1",
      second.lease.leaseId,
      "provider_or_platform_failure",
    )).resolves.toEqual({ outcome: "recorded" });
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1, openLeaseIds: [] });

    const third = await service.leaseJob("worker-1");
    expect(third.outcome).toBe("lease");
    if (third.outcome !== "lease") return;
    clock.set(third.lease.expiresAt);
    await expect(service.expireLease(third.lease.leaseId)).resolves.toBe(true);
    expect(await store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1, openLeaseIds: [] });
    expect(await store.getJob("job-1")).toMatchObject({ collectionCycle: 1 });
    expect(events.all().filter((event) => event.type === "lease"))
      .toHaveLength(3);
  });
});
