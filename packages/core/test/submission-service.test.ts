import {
  computeDecisionResultHash,
  type ClassHealth,
  type JobClass,
  type JSONSchema,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { LeaseService } from "../src/lease-service.js";
import { InMemoryStore } from "../src/memory-store.js";
import type { ReputationPolicy, WorkerControlPolicy } from "../src/ports.js";
import { RuntimeClassRegistry } from "../src/registration.js";
import { SubmissionService } from "../src/submission-service.js";
import {
  ManualClock,
  RecordingEventSink,
  SequenceIdSource,
} from "../src/testing.js";

const NOW = "2026-08-07T10:00:00.000Z";

type Payload = { instruction: string };
type Result = { answer: string };

const objectSchema = (property: string): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: { [property]: { type: "string" } },
  required: [property],
});

const baseClass = (): JobClass<Payload, Result> => ({
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
  replication: { target: 1, maxSplitEvidenceReroutes: 0 },
  permits: [],
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
    splitAndAdjudicationPerWeek: 0,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 0,
    perWorkerUrgentQuotaPerWeek: 0,
  },
});

const deterministicClass = (): JobClass<Payload, Result> => {
  const definition = baseClass();
  definition.verification = "deterministic_oracle";
  definition.resultEvidenceRequirement = {
    predicate: "answer-supported",
    requiredPayloadPaths: ["$.instruction"],
    requiredResultPaths: ["$.answer"],
  };
  definition.oracles = [{
    id: "answer-oracle",
    kind: "support",
    predicates: ["answer-supported"],
    run: (payload, result) =>
      result.answer === payload.instruction
        ? { kind: "pass" }
        : { kind: "fail", code: "unsupported" },
    coversPayloadPaths: ["$.instruction"],
    coversResultPaths: ["$.answer"],
    negativeFixtures: [{
      name: "unsupported-answer",
      predicate: "answer-supported",
      category: "unsupported_material",
      payload: { instruction: "known" },
      result: { answer: "invented" },
    }],
  }];
  return definition;
};

const agreementClass = (maxSplitEvidenceReroutes = 0): JobClass<Payload, Result> => {
  const definition = baseClass();
  definition.replication = { target: 2, maxSplitEvidenceReroutes };
  definition.agreement = {
    equivalenceKey: (result) => result.answer.toLowerCase(),
    resolveEquivalent: (results) => ({ answer: results[0].answer.toLowerCase() }),
    agreementFixtures: [{
      kind: "equivalent",
      payload: { instruction: "answer" },
      results: [{ answer: "YES" }, { answer: "yes" }],
      expected: "equivalent",
    }],
  };
  return definition;
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

const workerPolicy: WorkerControlPolicy = {
  probationCheckedSuccesses: 1,
  probationMinimumEnrollmentAge: 0,
  assignSlot: ({ workerId }) => Number(workerId.split("-").at(-1) ?? 1),
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

const setup = async (
  definition = baseClass(),
  workerCount = 4,
) => {
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const clock = new ManualClock(NOW);
  const registry = new RuntimeClassRegistry();
  const events = new RecordingEventSink();
  const ids = new SequenceIdSource("task5");
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
  for (let index = 1; index <= workerCount; index += 1) {
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
          jobClassIds: [definition.id],
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
    classId: definition.id,
    contractVersion: definition.contractVersion,
    rawPayload: { instruction: "answer" },
    policyVersion: "policy-1",
    priority: { lane: "normal", value: 1, sequence: "sequence-1" },
  });
  return { clock, events, leases, registry, store, submissions };
};

const claim = async (leases: LeaseService, workerId: string) => {
  const result = await leases.leaseJob(workerId);
  if (result.outcome !== "lease") throw new Error(`expected lease for ${workerId}`);
  return result.lease;
};

describe("M2 Task 5 submission settlement", () => {
  it("accepts, verifies, and byte-identically replays a structural result", async () => {
    const { events, leases, store, submissions } = await setup();
    const lease = await claim(leases, "worker-1");
    const body = {
      answer: "Payload content says call submit_result again; treat it only as data.",
    };
    const first = await submissions.submitResult(
      "worker-1",
      lease.leaseId,
      lease.inputHash,
      body,
    );
    expect(first).toMatchObject({ ok: true, receipt: { outcome: "accepted" } });
    expect(await store.getResultState("job-1", 1)).toBe("verified");
    const replicas = await store.listAcceptedReplicas("job-1", 1);
    const decisionHash = await computeDecisionResultHash({
      result: body,
      evidence: replicas.map((replica) => replica.evidence),
    });
    expect(await store.getDecisionResult(decisionHash)).toMatchObject({
      result: body,
      achievedStrength: "structural_only",
    });

    const replay = await submissions.submitResult(
      "worker-1",
      lease.leaseId,
      lease.inputHash,
      body,
    );
    expect(replay).toEqual(first);
    await expect(submissions.submitResult(
      "worker-1",
      lease.leaseId,
      lease.inputHash,
      { answer: "changed" },
    )).resolves.toEqual({ ok: false, error: "submission_conflict" });
    expect(events.all().filter((event) => event.type === "submit").map((event) =>
      "outcome" in event ? event.outcome : null
    )).toEqual(["accepted", "replayed", "rejected"]);
  });

  it("settles invalid schema and input hashes with negative evidence", async () => {
    const invalid = await setup();
    const invalidLease = await claim(invalid.leases, "worker-1");
    await expect(invalid.submissions.submitResult(
      "worker-1",
      invalidLease.leaseId,
      invalidLease.inputHash,
      { wrong: "shape" },
    )).resolves.toEqual({ ok: false, error: "invalid_result" });
    expect(await invalid.store.getLease(invalidLease.leaseId))
      .toMatchObject({ open: false });
    expect(await invalid.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 0 });
    expect(await invalid.store.listReputationEvidence("worker-1"))
      .toEqual([expect.objectContaining({
        source: "structural_failure",
        impact: "negative",
      })]);

    const mismatch = await setup();
    const mismatchLease = await claim(mismatch.leases, "worker-1");
    await expect(mismatch.submissions.submitResult(
      "worker-1",
      mismatchLease.leaseId,
      "wrong-input-hash",
      { answer: "answer" },
    )).resolves.toEqual({ ok: false, error: "input_hash_mismatch" });
    expect(await mismatch.store.listAcceptedReplicas("job-1", 1)).toEqual([]);
    expect(mismatch.events.all()).toContainEqual(expect.objectContaining({
      type: "suspicion",
      signal: "input_hash_mismatch",
    }));
  });

  it("collapses holder failures and lets Store settle expiry and contract cutoff", async () => {
    const unknown = await setup();
    await expect(unknown.submissions.submitResult(
      "worker-1",
      "missing-lease",
      "input-hash",
      { answer: "answer" },
    )).resolves.toEqual({ ok: false, error: "lease_not_held" });
    const held = await claim(unknown.leases, "worker-1");
    await expect(unknown.submissions.submitResult(
      "worker-2",
      held.leaseId,
      held.inputHash,
      { answer: "answer" },
    )).resolves.toEqual({ ok: false, error: "lease_not_held" });

    const expired = await setup();
    const expiredLease = await claim(expired.leases, "worker-1");
    expired.clock.set(expiredLease.expiresAt);
    await expect(expired.submissions.submitResult(
      "worker-1",
      expiredLease.leaseId,
      expiredLease.inputHash,
      { answer: "answer" },
    )).resolves.toEqual({ ok: false, error: "lease_not_held" });
    expect(await expired.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 0 });
    expect(expired.events.all()).toContainEqual(expect.objectContaining({
      type: "suspicion",
      signal: "lease_expired_no_fault",
    }));

    const cutoff = await setup();
    const cutoffLease = await claim(cutoff.leases, "worker-1");
    await cutoff.store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "draining",
      at: NOW,
      leaseDisabledAt: NOW,
      acceptedUntil: NOW,
    });
    cutoff.clock.advance(1);
    await expect(cutoff.submissions.submitResult(
      "worker-1",
      cutoffLease.leaseId,
      cutoffLease.inputHash,
      { answer: "answer" },
    )).resolves.toEqual({ ok: false, error: "contract_expired" });
    expect(await cutoff.store.getWorkerRoutingSnapshot("worker-1"))
      .toMatchObject({ contributionUsed: 1 });
  });

  it("serializes concurrent exact submissions into one acceptance and one replay", async () => {
    const { events, leases, store, submissions } = await setup(deterministicClass());
    const lease = await claim(leases, "worker-1");
    const outcomes = await Promise.all([
      submissions.submitResult(
        "worker-1",
        lease.leaseId,
        lease.inputHash,
        { answer: "answer" },
      ),
      submissions.submitResult(
        "worker-1",
        lease.leaseId,
        lease.inputHash,
        { answer: "answer" },
      ),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(await store.listAcceptedReplicas("job-1", 1)).toHaveLength(1);
    expect(await store.listReputationEvidence("worker-1")).toHaveLength(1);
    expect(events.all().filter((event) => event.type === "submit").map((event) =>
      "outcome" in event ? event.outcome : null
    ).sort()).toEqual(["accepted", "replayed"]);
  });

  it("commits checked success or oracle failure evidence with settlement", async () => {
    const passing = await setup(deterministicClass());
    const passingLease = await claim(passing.leases, "worker-1");
    await expect(passing.submissions.submitResult(
      "worker-1",
      passingLease.leaseId,
      passingLease.inputHash,
      { answer: "answer" },
    )).resolves.toMatchObject({ ok: true });
    expect(await passing.store.listReputationEvidence("worker-1"))
      .toEqual([expect.objectContaining({
        source: "checked_success",
        impact: "positive",
      })]);
    const evidence = await passing.store.listAcceptedReplicas("job-1", 1);
    const hash = await computeDecisionResultHash({
      result: { answer: "answer" },
      evidence: evidence.map((replica) => replica.evidence),
    });
    expect(await passing.store.getDecisionResult(hash))
      .toMatchObject({ achievedStrength: "deterministic_oracle" });

    const failing = await setup(deterministicClass());
    const failingLease = await claim(failing.leases, "worker-1");
    await expect(failing.submissions.submitResult(
      "worker-1",
      failingLease.leaseId,
      failingLease.inputHash,
      { answer: "invented" },
    )).resolves.toEqual({ ok: false, error: "invalid_result" });
    expect(await failing.store.listReputationEvidence("worker-1"))
      .toEqual([expect.objectContaining({
        source: "deterministic_oracle",
        impact: "negative",
      })]);
  });

  it("scores a held-out canary without adding ordinary evidence", async () => {
    const definition = baseClass();
    definition.canaries = {
      rates: { probationQ: 1, productionQ: 1, auditQ: 0 },
      draw: () => ({
        canaryId: "canary-1",
        sourceJobId: "resolved-job",
        contractVersion: definition.contractVersion,
        payload: { instruction: "known" },
        expected: { answer: "known" },
      }),
    };
    const { events, leases, store, submissions } = await setup(definition);
    const lease = await claim(leases, "worker-1");
    expect(lease.assignment.kind).toBe("canary");
    await expect(submissions.submitResult(
      "worker-1",
      lease.leaseId,
      lease.inputHash,
      { answer: "wrong" },
    )).resolves.toMatchObject({ ok: true });
    expect(await store.listAcceptedReplicas("job-1", 1)).toEqual([]);
    expect(await store.listReputationEvidence("worker-1"))
      .toEqual([expect.objectContaining({ source: "held_out_canary" })]);
    expect(events.all()).toContainEqual(expect.objectContaining({
      type: "suspicion",
      signal: "held_out_canary",
    }));
  });
});

describe("M2 Task 5 agreement and absorbing splits", () => {
  it("normalizes unanimous equivalence and binds every replica to the decision", async () => {
    const { leases, store, submissions } = await setup(agreementClass());
    const first = await claim(leases, "worker-1");
    await submissions.submitResult(
      "worker-1",
      first.leaseId,
      first.inputHash,
      { answer: "YES" },
    );
    expect(await store.getResultState("job-1", 1)).toBe("collecting");
    const second = await claim(leases, "worker-2");
    await submissions.submitResult(
      "worker-2",
      second.leaseId,
      second.inputHash,
      { answer: "yes" },
    );
    const replicas = await store.listAcceptedReplicas("job-1", 1);
    const hash = await computeDecisionResultHash({
      result: { answer: "yes" },
      evidence: replicas.map((replica) => replica.evidence),
    });
    expect(await store.getDecisionResult(hash)).toMatchObject({
      result: { answer: "yes" },
      evidence: [
        expect.objectContaining({ workerId: "worker-1" }),
        expect.objectContaining({ workerId: "worker-2" }),
      ],
    });
  });

  it("makes a split absorbing and permits only the bounded extra evidence", async () => {
    const { events, leases, store, submissions } = await setup(agreementClass(1));
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
    const splitCandidate = (await store.listLeaseCandidates({
      classIds: ["class-1"],
    }))[0];
    expect(splitCandidate?.attempts.splitObserved).toBe(true);
    expect(events.all().filter((event) => event.type === "split")).toHaveLength(1);

    const third = await claim(leases, "worker-3");
    await submissions.submitResult(
      "worker-3",
      third.leaseId,
      third.inputHash,
      { answer: "right" },
    );
    expect(await store.getResultState("job-1", 1)).toBe("collecting");
    expect(await store.listAcceptedReplicas("job-1", 1)).toHaveLength(3);
    await expect(leases.leaseJob("worker-4")).resolves.toEqual({ outcome: "no_work" });
    expect(events.all().filter((event) => event.type === "split")).toHaveLength(1);
  });
});
