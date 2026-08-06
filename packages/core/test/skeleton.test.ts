import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, NOTIFICATION_TYPES } from "../src/events.js";
import type { MusterEvent } from "../src/events.js";
import type {
  AdmissionHook,
  AdjudicationSource,
  ClassVersionRegistration,
  Clock,
  EventSink,
  InvalidationScope,
  InvalidationTarget,
  PendingAdjudication,
  ReputationEvidenceRecord,
  ReputationPolicy,
  Store,
  VerdictReceipt,
} from "../src/ports.js";

describe("event schema (spec 7)", () => {
  it("has one notification member per consumer event, revision-12 names", () => {
    expect(NOTIFICATION_TYPES).toEqual([
      "suspicion", "split", "escalation", "low_cost_uncovered", "urgent_uncovered",
      "backpressure", "pool_offline", "contract_mismatch", "class_health_changed",
      "diversity_shortfall", "result_adjudication_requested", "action_adjudication_requested",
      "adjudication_uncovered", "audit_uncovered", "dispute_requeue_exhausted",
    ]);
  });

  it("has one append-only audit member per spec-7 category", () => {
    expect(AUDIT_EVENT_TYPES).toEqual([
      "enrollment", "lease", "lease_extend", "submit", "verdict", "gate_decision",
      "escalation_charge", "adjudication", "state_change", "permit_epoch_change",
      "contract_transition", "authorization_validity_change",
    ]);
  });

  it("members carry their scoping fields; queue- and worker-scoped members carry no classId", () => {
    const split: MusterEvent = {
      type: "split",
      at: "2026-08-05T10:00:00.000Z",
      classId: "extract-claims",
      jobId: "j1",
      collectionCycle: 1,
      equivalenceKeyCount: 2,
    };
    const offline: MusterEvent = {
      type: "pool_offline",
      at: "2026-08-05T10:00:00.000Z",
    };
    const enrolled: MusterEvent = {
      type: "enrollment",
      at: "2026-08-05T10:00:00.000Z",
      workerId: "worker-1",
      providerSurface: "provider.example",
      outcome: "enrolled",
      contractVersion: "1.0.0",
    };
    expect([split.type, offline.type, enrolled.type]).toEqual([
      "split",
      "pool_offline",
      "enrollment",
    ]);
    // @ts-expect-error pool_offline is queue-scoped and must not carry classId
    const bad: MusterEvent = { type: "pool_offline", at: "t", classId: "c" };
    void bad;
  });

  it("refusals can name an unknown lease without fabricating identifiers", () => {
    const unknownLease: MusterEvent = {
      type: "submit",
      at: "2026-08-05T10:00:00.000Z",
      leaseId: "unknown",
      workerId: "worker-1",
      outcome: "rejected",
      errorCode: "lease_not_held",
      lease: { resolved: false },
    };
    expect(unknownLease.type).toBe("submit");
    const bad: MusterEvent = {
      type: "submit", at: "t", leaseId: "l1",
      workerId: "worker-1",
      outcome: "accepted", resultHash: "h", classId: "c", jobId: "j",
      collectionCycle: 1, contractVersion: "v",
      // @ts-expect-error an accepted submission always resolved its lease
      lease: { resolved: false },
    };
    void bad;
  });

  it("a verdict receipt cannot lose or invent its reject outcome", () => {
    // @ts-expect-error rejected requires rejectOutcome
    const missing: VerdictReceipt = {
      requestId: "r", verdictHash: "h", outcome: "rejected", decidedAt: "t",
    };
    const extra: VerdictReceipt = {
      requestId: "r", verdictHash: "h", outcome: "approved",
      // @ts-expect-error only rejections carry one
      rejectOutcome: "requeued", decidedAt: "t",
    };
    void missing;
    void extra;
  });

  it("represents initial epochs and authorization-validity invalidation", () => {
    const initialEpoch: MusterEvent = {
      type: "permit_epoch_change",
      at: "2026-08-06T00:00:00.000Z",
      classId: "c1",
      fromEpoch: null,
      toEpoch: "e1",
      emergency: false,
    };
    const invalidated: MusterEvent = {
      type: "authorization_validity_change",
      at: "2026-08-06T00:01:00.000Z",
      classId: "c1",
      jobId: "j1",
      collectionCycle: 1,
      authorizationRequestId: "ar1",
      from: "valid",
      to: "invalid",
      reason: "emergency_permit_withdrawal",
    };
    expect([initialEpoch.fromEpoch, invalidated.to]).toEqual([null, "invalid"]);
  });

  it("ports are pure interfaces (compile-only)", () => {
    const use = (
      _s: Store,
      _c: Clock,
      _e: EventSink,
      _a: AdmissionHook,
      _j: AdjudicationSource,
      _r: ReputationPolicy,
    ) => true;
    expect(typeof use).toBe("function");
  });

  it("qualifies every invalidation scope by class", () => {
    const scopes: InvalidationScope[] = [
      { kind: "class", classId: "c1" },
      {
        kind: "job_cycles",
        classId: "c1",
        jobCycles: [{ jobId: "j1", collectionCycle: 1 }],
      },
      {
        kind: "decision_results",
        classId: "c1",
        decisionResultHashes: ["dh1"],
      },
      { kind: "permit_epoch", classId: "c1", permitEpoch: "e1" },
      {
        kind: "contract_version",
        classId: "c1",
        contractVersion: "v1",
      },
    ];
    expect(scopes.every((scope) => scope.classId === "c1")).toBe(true);

    // @ts-expect-error epoch invalidation must never be globally scoped
    const unqualified: InvalidationScope = {
      kind: "permit_epoch", permitEpoch: "e1",
    };
    void unqualified;
  });

  it("represents one expected target and one hash per requeued cycle", () => {
    const targets: InvalidationTarget[] = [
      {
        jobId: "j1",
        collectionCycle: 1,
        state: "collecting",
        inputHash: "old-1",
        permitEpoch: "e1",
        contractVersion: "v1",
      },
      {
        jobId: "j2",
        collectionCycle: 1,
        state: "collecting",
        inputHash: "old-2",
        permitEpoch: "e1",
        contractVersion: "v1",
      },
    ];
    const hashes = ["new-1", "new-2"];
    expect(new Set(hashes).size).toBe(targets.length);

    type InvalidationInput = Parameters<Store["invalidateResultScope"]>[0];
    const emergency: InvalidationInput = {
      scope: { kind: "permit_epoch", classId: "c1", permitEpoch: "e1" },
      expectedTargets: targets,
      reason: "emergency_permit_withdrawal",
      requeuePlans: [],
      epochTransition: { classId: "c1", fromEpoch: "e1", toEpoch: "e2" },
      at: "2026-08-06T00:00:00.000Z",
    };
    expect(emergency.epochTransition.toEpoch).toBe("e2");

    // @ts-expect-error emergency withdrawal must atomically carry its epoch transition
    const unsafeEmergency: InvalidationInput = {
      scope: { kind: "permit_epoch", classId: "c1", permitEpoch: "e1" },
      expectedTargets: targets,
      reason: "emergency_permit_withdrawal",
      requeuePlans: [],
      at: "2026-08-06T00:00:00.000Z",
    };
    void unsafeEmergency;
  });

  it("keeps backlog timestamps and reputation bodies outside frozen records", () => {
    const pending: PendingAdjudication<{ id: string }> = {
      request: { id: "rr1" },
      openedAt: "2026-08-06T00:00:00.000Z",
    };
    const evidence: ReputationEvidenceRecord = {
      evidenceId: "rep1",
      workerId: "worker-1",
      source: "held_out_canary",
      impact: "negative",
      at: "2026-08-06T00:00:00.000Z",
      job: { jobId: "j1", collectionCycle: 1 },
      detailHash: "sha256-detail",
    };
    expect([pending.openedAt, evidence.detailHash]).toHaveLength(2);

    const leaked: ReputationEvidenceRecord = {
      ...evidence,
      // @ts-expect-error reputation records carry hashes, never raw bodies
      body: { secret: true },
    };
    void leaked;

    const registration: ClassVersionRegistration = {
      classId: "c1",
      contractVersion: "v1",
      payloadSchemaHash: "ph1",
      outputSchemaHash: "oh1",
      registeredAt: "2026-08-06T00:00:00.000Z",
    };
    const unsafeRegistration: ClassVersionRegistration = {
      ...registration,
      // @ts-expect-error registration always creates draft; callers cannot choose state
      state: "active",
    };
    // @ts-expect-error only checked_success may be positive
    const invalidPositive: ReputationEvidenceRecord = {
      ...evidence,
      source: "held_out_canary",
      impact: "positive",
    };
    void unsafeRegistration;
    void invalidPositive;
  });
});
