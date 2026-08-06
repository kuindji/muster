import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, NOTIFICATION_TYPES } from "../src/events.js";
import type { MusterEvent } from "../src/events.js";
import type {
  AdmissionHook,
  AdjudicationSource,
  Clock,
  EventSink,
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
      "contract_transition",
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

  it("ports are pure interfaces (compile-only)", () => {
    const use = (
      _s: Store,
      _c: Clock,
      _e: EventSink,
      _a: AdmissionHook,
      _j: AdjudicationSource,
    ) => true;
    expect(typeof use).toBe("function");
  });
});
