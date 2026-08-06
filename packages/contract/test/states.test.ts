import { describe, expect, it } from "vitest";

import {
  CONSUMER_API_ERROR_CODES,
  WORKER_WIRE_ERROR_CODES,
} from "../src/errors.js";
import {
  INVALIDATION_RESULT_TARGET,
  RESULT_INVALIDATION_TERMINALS,
  TERMINAL_AUTHORIZATION_STATES,
} from "../src/states.js";
import type {
  AuthorizationStatus,
  ClassHealth,
  SubmissionReceipt,
} from "../src/states.js";

describe("SubmissionReceipt is immutable acceptance facts only (spec 6.5)", () => {
  it("carries exactly the nine frozen fields", () => {
    const receipt: SubmissionReceipt = {
      leaseId: "l1",
      jobId: "j1",
      inputHash: "ih",
      resultHash: "rh",
      collectionCycle: 1,
      contractVersion: "1.0.0",
      permitEpoch: "e1",
      outcome: "accepted",
      acceptedAt: "2026-08-05T10:00:00.000Z",
    };

    expect(Object.keys(receipt).sort()).toEqual([
      "acceptedAt",
      "collectionCycle",
      "contractVersion",
      "inputHash",
      "jobId",
      "leaseId",
      "outcome",
      "permitEpoch",
      "resultHash",
    ]);
    // @ts-expect-error post-acceptance state must not be representable
    const invalid: SubmissionReceipt = { ...receipt, canary: true };
    void invalid;
  });
});

describe("state vocabularies (spec 6.6)", () => {
  it("result invalidation terminals exclude verified", () => {
    expect(RESULT_INVALIDATION_TERMINALS).toEqual([
      "rejected",
      "expired",
      "superseded",
      "cancelled",
    ]);
  });

  it("each invalidation cause derives exactly one retirement state", () => {
    expect(INVALIDATION_RESULT_TARGET).toEqual({
      emergency_halted: "cancelled",
      operator_cancelled: "cancelled",
      emergency_permit_withdrawal: "superseded",
      contract_expired: "expired",
      max_in_flight_exceeded: "expired",
    });
  });

  it("freezes terminal authorization-request states", () => {
    expect(TERMINAL_AUTHORIZATION_STATES).toEqual([
      "authorized",
      "denied",
      "expired",
      "superseded",
      "cancelled",
    ]);
  });

  it("AuthorizationStatus discriminates denied from other states", () => {
    const denied: AuthorizationStatus = {
      state: "denied",
      reason: "human_rejected",
    };
    const pending: AuthorizationStatus = {
      state: "pending_adjudication",
    };
    const authorized: AuthorizationStatus = {
      state: "authorized",
      validity: {
        kind: "invalid",
        reason: "contract_expired",
        invalidatedAt: "2026-08-05T10:00:00.000Z",
      },
    };

    expect([denied.state, pending.state, authorized.state]).toEqual([
      "denied",
      "pending_adjudication",
      "authorized",
    ]);
  });

  it("ClassHealth is multidimensional", () => {
    const health: ClassHealth = {
      operating: "ready",
      reserves: {
        lowCost: "available",
        urgent: "saturated",
        splitAndAdjudication: "available",
        audit: "available",
      },
    };

    expect(Object.keys(health.reserves).sort()).toEqual([
      "audit",
      "lowCost",
      "splitAndAdjudication",
      "urgent",
    ]);
  });
});

describe("wire error codes", () => {
  it("worker-facing codes are frozen and exclude consumer-API codes", () => {
    expect(WORKER_WIRE_ERROR_CODES).toEqual([
      "lease_not_held",
      "result_too_large",
      "invalid_result",
      "submission_conflict",
      "input_hash_mismatch",
      "contract_mismatch",
      "contract_expired",
    ]);
    expect(CONSUMER_API_ERROR_CODES).toEqual([
      "authorization_conflict",
      "verdict_conflict",
      "effect_descriptor_mismatch",
      "intent_invalid",
    ]);
    for (const code of CONSUMER_API_ERROR_CODES) {
      expect(
        WORKER_WIRE_ERROR_CODES as readonly string[],
      ).not.toContain(code);
    }
    expect([
      ...WORKER_WIRE_ERROR_CODES,
      ...CONSUMER_API_ERROR_CODES,
    ]).not.toContain("escalation_budget_exhausted");
  });
});
