import { describe, expect, it } from "vitest";

import type {
  AuthorizeIntentOutcome,
  ClassHealthSnapshot,
  ContractTransitionOutcome,
  OpenAdjudicationOutcome,
  ReserveCharge,
  ReserveChargeOutcome,
  ReservePolicyRecord,
  ReservePolicySnapshot,
  Store,
} from "../src/ports.js";

const now = "2026-08-07T08:00:00.000Z";

const policy: ReservePolicySnapshot = {
  classId: "class-1",
  contractVersion: "1.0.0",
  policyVersion: "reserves-1",
  windowId: "2026-W32",
  windowStartsAt: "2026-08-03T00:00:00.000Z",
  windowEndsAt: "2026-08-10T00:00:00.000Z",
  lane: "urgent",
  laneLimit: 5,
  perWorkerLimit: 1,
};

const record: ReservePolicyRecord = {
  revision: 3,
  policy,
  used: 4,
  workerUsage: [{ workerId: "worker-1", used: 1 }],
  updatedAt: now,
};

const health: ClassHealthSnapshot = {
  revision: 7,
  classId: "class-1",
  health: {
    operating: "ready",
    reserves: {
      lowCost: "available",
      urgent: "available",
      splitAndAdjudication: "available",
      audit: "available",
    },
  },
  updatedAt: now,
  source: "automatic",
};

const charge: ReserveCharge = {
  chargeKey: "intent-1:urgent",
  workerIds: ["worker-1"],
  policy,
  at: now,
};

describe("revision-21 reserve-accounting port freeze", () => {
  it("freezes authoritative policy read, initialize, and transition commands", () => {
    type Read = Parameters<Store["getReservePolicy"]>[0];
    type Initialize = Parameters<Store["initializeReservePolicy"]>[0];
    type Transition = Parameters<Store["transitionReservePolicy"]>[0];

    const read: Read = {
      classId: policy.classId,
      contractVersion: policy.contractVersion,
      lane: policy.lane,
    };
    const initialize: Initialize = { policy, at: now };
    const transition: Transition = {
      expected: record,
      next: { ...policy, policyVersion: "reserves-2", laneLimit: 8 },
      at: now,
    };

    expect([read.lane, initialize.policy.windowId, transition.expected.revision])
      .toEqual(["urgent", "2026-W32", 3]);
  });

  it("preserves charged versus exhausted on exact replay", () => {
    const outcome: ReserveChargeOutcome = {
      kind: "exhausted",
      status: "replayed",
      charge: { charge, outcome: "exhausted" },
      currentPolicy: record,
      classHealth: health,
    };
    expect([outcome.kind, outcome.status]).toEqual(["exhausted", "replayed"]);
  });

  it("keeps charge-key and policy conflicts distinct on every charge-bearing command", () => {
    const chargeConflict: AuthorizeIntentOutcome = {
      kind: "reserve_charge_conflict",
      lane: "urgent",
      existingCharge: { charge, outcome: "charged" },
    };
    const policyConflict: OpenAdjudicationOutcome = {
      kind: "reserve_policy_conflict",
      currentPolicy: null,
    };
    const identityConflict: OpenAdjudicationOutcome = {
      kind: "identity_conflict",
    };
    expect([chargeConflict.kind, policyConflict.kind, identityConflict.kind])
      .toEqual([
        "reserve_charge_conflict",
        "reserve_policy_conflict",
        "identity_conflict",
      ]);
  });

  it("correlates adjudication replay with its first disposition and openedAt", () => {
    const replay: OpenAdjudicationOutcome = {
      kind: "replayed",
      original: "opened_charged",
      openedAt: now,
      charge: { charge, outcome: "charged" },
      currentPolicy: record,
      classHealth: health,
    };
    expect([replay.original, replay.openedAt]).toEqual([
      "opened_charged",
      now,
    ]);

    const invalid: OpenAdjudicationOutcome = {
      kind: "opened_charged",
      openedAt: now,
      // @ts-expect-error opened_charged cannot carry an exhausted settlement
      charge: { charge, outcome: "exhausted" },
      currentPolicy: record,
      classHealth: health,
    };
    void invalid;
  });

  it("keeps generic operational transitions out of reserve accounting", () => {
    type Next = Parameters<Store["transitionClassHealth"]>[0]["next"];
    const invalid: Next = {
      health: {
        operating: "ready",
        // @ts-expect-error reserve lanes change only through accounting commands
        reserves: health.health.reserves,
      },
      updatedAt: now,
      source: "automatic",
    };
    void invalid;
  });

  it("requires retirement to return its atomic class-health publication", () => {
    // @ts-expect-error a retired contract outcome must expose resulting health
    const invalid: ContractTransitionOutcome = {
      kind: "applied",
      record: {
        classId: "class-1",
        contractVersion: "1.0.0",
        payloadSchemaHash: "payload-schema",
        outputSchemaHash: "output-schema",
        state: "retired",
        registeredAt: now,
      },
    };
    void invalid;
  });

  it("publishes authorization reserve settlement as one aggregate batch", () => {
    const outcome: AuthorizeIntentOutcome = {
      kind: "applied",
      initialReceipt: {
        authorizationRequestId: "authorization-1",
        effectIntentId: "intent-1",
        effectIntentHash: "intent-hash",
        jobId: "job-1",
        collectionCycle: 1,
        decisionResultHash: "decision-1",
        at: now,
        outcome: "authorized",
        authorization: {
          authorizationRequestId: "authorization-1",
          effectIntentId: "intent-1",
          effectIntentHash: "intent-hash",
          jobId: "job-1",
          collectionCycle: 1,
          inputHash: "input-hash",
          decisionResultHash: "decision-1",
          evidence: [],
          contractVersion: "1.0.0",
          permitEpoch: "epoch-1",
          actions: ["routeToUrgent"],
        },
      },
      reserveBatch: {
        settlements: [{
          lane: "urgent",
          charge: { charge, outcome: "charged" },
          currentPolicy: record,
        }],
        skippedLanes: [],
        classHealth: health,
      },
    };
    expect(outcome.reserveBatch?.settlements).toHaveLength(1);
  });

  it("removes the ambiguous chargeOk boolean from authorization outcomes", () => {
    const invalid: AuthorizeIntentOutcome = {
      kind: "applied",
      // @ts-expect-error reserve settlement is typed and cannot be collapsed
      chargeOk: true,
      initialReceipt: {
        authorizationRequestId: "authorization-1",
        effectIntentId: "intent-1",
        effectIntentHash: "intent-hash",
        jobId: "job-1",
        collectionCycle: 1,
        decisionResultHash: "decision-1",
        at: now,
        outcome: "denied",
        denialReason: "escalation_budget_exhausted",
      },
    };
    void invalid;
  });
});
