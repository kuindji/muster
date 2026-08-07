import { describe, expect, it } from "vitest";

import * as contract from "../src/index.js";
import { ACTION_ORDER } from "../src/actions.js";
import { AUDIT_SOURCE_TABLE } from "../src/tables/audit-sources.js";
import {
  canTransitionContract,
  CONTRACT_LIFECYCLE_RULES,
} from "../src/tables/contract-lifecycle.js";
import { FAIR_ATTEMPT_TABLE } from "../src/tables/fair-attempt.js";
import {
  atHighestRank,
  PRECEDENCE_TABLE,
} from "../src/tables/precedence.js";
import { QUEUE_MODE_TABLE } from "../src/tables/queue-modes.js";
import {
  canTransitionWorker,
  WORKER_TRANSITIONS,
} from "../src/tables/worker-states.js";

function mutablePaths(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): string[] {
  if (typeof value !== "object" || value === null) return [];
  const object = value as object;
  if (seen.has(object)) return [];
  seen.add(object);

  const mutable = Object.isFrozen(object) ? [] : [path];
  for (const key of Object.getOwnPropertyNames(object)) {
    mutable.push(
      ...mutablePaths(
        (object as Record<string, unknown>)[key],
        `${path}.${key}`,
        seen,
      ),
    );
  }
  return mutable;
}

describe("worker state machine (spec 3.1)", () => {
  it("allows exactly the drawn transitions", () => {
    expect(canTransitionWorker("enrolled", "active")).toBe(true);
    expect(canTransitionWorker("enrolled", "paused")).toBe(true);
    expect(canTransitionWorker("active", "maintenance")).toBe(true);
    expect(canTransitionWorker("maintenance", "active")).toBe(true);
    expect(canTransitionWorker("active", "paused")).toBe(true);
    expect(canTransitionWorker("paused", "active")).toBe(true);
    expect(canTransitionWorker("suspended", "revoked")).toBe(true);
  });

  it("suspicion pauses active or maintenance workers", () => {
    expect(canTransitionWorker("maintenance", "paused")).toBe(true);
  });

  it("refuses undrawn transitions", () => {
    expect(canTransitionWorker("enrolled", "revoked")).toBe(false);
    expect(canTransitionWorker("revoked", "active")).toBe(false);
    expect(canTransitionWorker("paused", "maintenance")).toBe(false);
  });

  it("allows operator suspension from every non-terminal state", () => {
    for (const from of [
      "enrolled",
      "active",
      "maintenance",
      "paused",
    ] as const) {
      expect(canTransitionWorker(from, "suspended")).toBe(true);
    }
  });

  it("records a cause for every transition", () => {
    for (const transition of WORKER_TRANSITIONS) {
      expect(transition.cause.length).toBeGreaterThan(0);
    }
  });
});

describe("contract lifecycle (spec 5.6)", () => {
  it("moves draft -> active -> draining -> retired only", () => {
    expect(canTransitionContract("draft", "active")).toBe(true);
    expect(canTransitionContract("active", "draining")).toBe(true);
    expect(canTransitionContract("draining", "retired")).toBe(true);
    expect(canTransitionContract("active", "retired")).toBe(false);
    expect(canTransitionContract("draining", "active")).toBe(false);
    expect(canTransitionContract("retired", "draining")).toBe(false);
  });

  it("keeps draining validators loaded and classifies late results", () => {
    expect(CONTRACT_LIFECYCLE_RULES.draining).toEqual({
      leasing: "disabled",
      acceptsResults: "until_accepted_until",
      validatorsLoaded: true,
      queuedJobs: "reemit_or_migrate",
      lateResultClassification: "contract_expired_coordinator_fault",
    });
    expect(CONTRACT_LIFECYCLE_RULES.active.validatorsLoaded).toBe(true);
    expect(CONTRACT_LIFECYCLE_RULES.retired.validatorsLoaded).toBe(
      false,
    );
  });
});

describe("precedence table (spec 6.6)", () => {
  it("has 12 authority ranks represented by 13 condition rows", () => {
    expect(PRECEDENCE_TABLE.map((rule) => rule.id)).toEqual([
      "lease_holder_revoked",
      "emergency_halted",
      "operator_cancellation",
      "emergency_permit_withdrawal",
      "contract_expired",
      "max_in_flight_exceeded",
      "admission_halted",
      "adjudication_starved",
      "split_adjudication_saturated",
      "audit_saturated",
      "urgent_saturated",
      "low_cost_saturated",
      "permit_epoch",
    ]);
    expect(PRECEDENCE_TABLE.map((rule) => rule.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11, 12,
    ]);
  });

  it("starvation refuses new enqueues without stranding in-flight work", () => {
    const rule = PRECEDENCE_TABLE.find(
      ({ id }) => id === "adjudication_starved",
    )!;
    expect(rule.refusesNewEnqueue).toBe(true);
    expect(rule.inFlight).toBe("none");
    expect(rule.invalidatesIssuedAuthorizations).toBe(false);
  });

  it("gives reserve saturation narrow and distinct in-flight effects", () => {
    expect(
      PRECEDENCE_TABLE.find(
        ({ id }) => id === "split_adjudication_saturated",
      )!.inFlight,
    ).toBe("keep_pending");
    expect(
      PRECEDENCE_TABLE.find(({ id }) => id === "audit_saturated")!
        .inFlight,
    ).toBe("none");
    expect(
      PRECEDENCE_TABLE.find(({ id }) => id === "urgent_saturated")!
        .inFlight,
    ).toBe("deny_urgent_lane_authorizations");
    expect(
      PRECEDENCE_TABLE.find(
        ({ id }) => id === "low_cost_saturated",
      )!.inFlight,
    ).toBe("deny_overflow_escalations");
  });

  it("represents every reserve saturation separately", () => {
    const ids = PRECEDENCE_TABLE.map((rule) => rule.id);
    for (const id of [
      "split_adjudication_saturated",
      "audit_saturated",
      "urgent_saturated",
      "low_cost_saturated",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("only ranks 2 through 6 invalidate issued authorizations", () => {
    for (const rule of PRECEDENCE_TABLE) {
      expect(rule.invalidatesIssuedAuthorizations).toBe(
        rule.rank >= 2 && rule.rank <= 6,
      );
    }
  });

  it("distinguishes emergency withdrawal from ordinary epoch gating", () => {
    expect(
      PRECEDENCE_TABLE.find(
        ({ id }) => id === "emergency_permit_withdrawal",
      )!.inFlight,
    ).toBe("supersede_withdrawn_epoch");
    expect(
      PRECEDENCE_TABLE.find(({ id }) => id === "permit_epoch")!
        .inFlight,
    ).toBe("gate_under_stamped_epoch");
  });

  it("selects the lowest rank and retains same-rank conditions", () => {
    expect(
      atHighestRank(["urgent_saturated", "contract_expired"]).map(
        (rule) => rule.id,
      ),
    ).toEqual(["contract_expired"]);
    expect(
      atHighestRank([
        "split_adjudication_saturated",
        "audit_saturated",
      ]).map((rule) => rule.id),
    ).toEqual([
      "split_adjudication_saturated",
      "audit_saturated",
    ]);
    expect(atHighestRank([])).toEqual([]);
  });
});

describe("fair-attempt classification (spec 6.9)", () => {
  it("matches every table row", () => {
    expect(FAIR_ATTEMPT_TABLE).toEqual({
      no_work: {
        countsForContribution: true,
        raisesSuspicion: false,
      },
      success: {
        countsForContribution: true,
        raisesSuspicion: false,
      },
      coordinator_fault: {
        countsForContribution: true,
        raisesSuspicion: false,
      },
      provider_or_platform_failure: {
        countsForContribution: true,
        raisesSuspicion: false,
      },
      rejected_invalid: {
        countsForContribution: false,
        raisesSuspicion: true,
      },
      abandoned_before_payload: {
        countsForContribution: false,
        raisesSuspicion: false,
      },
      abandoned_after_payload: {
        countsForContribution: false,
        raisesSuspicion: true,
      },
      lease_expired_no_fault: {
        countsForContribution: false,
        raisesSuspicion: true,
      },
    });
  });
});

describe("audit sources (spec 6.11)", () => {
  it("allows only trusted sources to move reputation directly", () => {
    expect(
      AUDIT_SOURCE_TABLE.independent_worker_audit
        .mayMoveReputationDirectly,
    ).toBe(false);
    expect(
      AUDIT_SOURCE_TABLE.held_out_canary.mayMoveReputationDirectly,
    ).toBe(true);
    expect(
      AUDIT_SOURCE_TABLE.deterministic_or_completeness_oracle
        .mayMoveReputationDirectly,
    ).toBe(true);
    expect(
      AUDIT_SOURCE_TABLE.human_audit.mayMoveReputationDirectly,
    ).toBe(true);
  });
});

describe("queue modes (spec 6.12)", () => {
  it("distinguishes admission from emergency in-flight behavior", () => {
    expect(QUEUE_MODE_TABLE.admission_halted.inFlight).toBe(
      "completes",
    );
    expect(QUEUE_MODE_TABLE.emergency_halted.inFlight).toBe(
      "operator_policy",
    );
    expect(QUEUE_MODE_TABLE.emergency_halted.intake).toBe("refused");
  });

  it("degraded mode signals backpressure without inventing intake policy", () => {
    expect(QUEUE_MODE_TABLE.normal.urgent).toBe("prioritized");
    expect(QUEUE_MODE_TABLE.degraded).toEqual({
      intake: "full",
      inFlight: "completes",
      lowPriority: "normal",
      urgent: "prioritized",
      entryEvent: "backpressure",
    });
  });
});

describe("runtime freeze", () => {
  it("deep-freezes every object reachable from a public export", () => {
    const mutable = Object.entries(contract).flatMap(([name, value]) =>
      mutablePaths(value, name),
    );
    expect(mutable).toEqual([]);
  });

  it("frozen arrays reject mutation", () => {
    expect(() => {
      (ACTION_ORDER as string[]).push("detonate");
    }).toThrow();
  });
});
