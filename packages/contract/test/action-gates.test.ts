import { describe, expect, it } from "vitest";

import {
  ACTION_ORDER,
  CONSEQUENCE_ORDER,
  consequenceAtLeast,
  effectiveGateAction,
  sortByActionOrder,
} from "../src/actions.js";
import { ACTION_GATE_TABLE } from "../src/tables/action-gates.js";

describe("Action enum order (spec 4.3 listing order)", () => {
  it("is frozen", () => {
    expect(ACTION_ORDER).toEqual([
      "routeToHumanLowCost",
      "routeToHumanUrgent",
      "annotateDecisionRecord",
      "deprioritize",
      "routeToUrgent",
      "updateRetrievalIndex",
      "selectCandidateSet",
      "mutateCanonicalState",
      "enqueueDerivedWork",
      "suppress",
      "drop",
      "publish",
    ]);
    expect(Object.isFrozen(ACTION_ORDER)).toBe(true);
  });

  it("sortByActionOrder sorts by that order, stably", () => {
    const items = [
      { id: "publish-1", action: "publish" },
      { id: "suppress-1", action: "suppress" },
      { id: "publish-2", action: "publish" },
      { id: "deprioritize-1", action: "deprioritize" },
    ] as const;
    expect(
      sortByActionOrder(items, (item) => item.action).map((item) => item.id),
    ).toEqual([
      "deprioritize-1",
      "suppress-1",
      "publish-1",
      "publish-2",
    ]);
  });
});

describe("Consequence order", () => {
  it("is frozen in increasing severity and supports floor checks", () => {
    expect(CONSEQUENCE_ORDER).toEqual([
      "low",
      "material",
      "high",
      "irreversible",
    ]);
    expect(Object.isFrozen(CONSEQUENCE_ORDER)).toBe(true);
    expect(consequenceAtLeast("high", "material")).toBe(true);
    expect(consequenceAtLeast("material", "material")).toBe(true);
    expect(consequenceAtLeast("low", "material")).toBe(false);
  });
});

describe("Action gate table (spec 6.3)", () => {
  const table = ACTION_GATE_TABLE;

  it("escalations: structural low-cost, deterministic urgent, both budgeted", () => {
    expect(table.routeToHumanLowCost).toEqual({
      automaticGate: "structural_only",
      requiresCompletenessOracle: false,
      humanOnlyAtOrAbove: null,
      budgetLane: "lowCost",
      maxAutomaticConsequence: null,
    });
    expect(table.routeToHumanUrgent).toEqual({
      automaticGate: "deterministic_oracle",
      requiresCompletenessOracle: false,
      humanOnlyAtOrAbove: null,
      budgetLane: "urgent",
      maxAutomaticConsequence: null,
    });
    expect(table.routeToUrgent.budgetLane).toBe("urgent");
    expect(table.routeToUrgent.automaticGate).toBe(
      "deterministic_oracle",
    );
  });

  it("annotateDecisionRecord is structural-only and unbudgeted", () => {
    expect(table.annotateDecisionRecord).toEqual({
      automaticGate: "structural_only",
      requiresCompletenessOracle: false,
      humanOnlyAtOrAbove: null,
      budgetLane: null,
      maxAutomaticConsequence: null,
    });
  });

  it("absence-gated actions require a completeness oracle", () => {
    for (const action of [
      "updateRetrievalIndex",
      "selectCandidateSet",
      "enqueueDerivedWork",
      "suppress",
    ] as const) {
      expect(table[action].automaticGate).toBe("deterministic_oracle");
      expect(table[action].requiresCompletenessOracle).toBe(true);
    }
    expect(table.deprioritize.requiresCompletenessOracle).toBe(false);
  });

  it("human-only floors: mutateCanonicalState/suppress/publish at high+, drop always", () => {
    expect(table.mutateCanonicalState.humanOnlyAtOrAbove).toBe("high");
    expect(table.suppress.humanOnlyAtOrAbove).toBe("high");
    expect(table.publish.humanOnlyAtOrAbove).toBe("high");
    expect(table.drop.automaticGate).toBe("unavailable");
    expect(table.drop.humanOnlyAtOrAbove).toBe("low");
  });

  it("publish is automatic only at consequence <= material", () => {
    expect(table.publish.maxAutomaticConsequence).toBe("material");
  });

  it("deprioritize on a bounded surface is gated as suppress", () => {
    expect(effectiveGateAction("deprioritize", "bounded")).toBe("suppress");
    expect(effectiveGateAction("deprioritize", "unbounded")).toBe(
      "deprioritize",
    );
    expect(effectiveGateAction("publish", "bounded")).toBe("publish");
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(table)).toBe(true);
    for (const row of Object.values(table)) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });
});
