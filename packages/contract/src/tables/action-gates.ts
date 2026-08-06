import type { Action, Consequence } from "../actions.js";
import { deepFreeze } from "../deep-freeze.js";
import type { AutomaticVerificationStrength } from "../verification.js";

export interface ActionGateRow {
  /** Minimum achieved strength for automatic authorization. */
  automaticGate: AutomaticVerificationStrength | "unavailable";
  /** Whether the action is absence-gated under spec 6.3. */
  requiresCompletenessOracle: boolean;
  /** Consequence at or above which permit mode must be human-only. */
  humanOnlyAtOrAbove: Consequence | null;
  /** Escalation reserve lane spent by this action under spec 6.4. */
  budgetLane: "lowCost" | "urgent" | null;
  /** Highest consequence at which automatic mode remains available. */
  maxAutomaticConsequence: Consequence | null;
}

/** Spec 6.3 gate table, one deeply frozen row per action. */
export const ACTION_GATE_TABLE: Record<Action, ActionGateRow> = deepFreeze({
  annotateDecisionRecord: {
    automaticGate: "structural_only",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: null,
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  routeToHumanLowCost: {
    automaticGate: "structural_only",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: null,
    budgetLane: "lowCost",
    maxAutomaticConsequence: null,
  },
  routeToHumanUrgent: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: null,
    budgetLane: "urgent",
    maxAutomaticConsequence: null,
  },
  deprioritize: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: null,
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  routeToUrgent: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: null,
    budgetLane: "urgent",
    maxAutomaticConsequence: null,
  },
  updateRetrievalIndex: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: true,
    humanOnlyAtOrAbove: null,
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  selectCandidateSet: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: true,
    humanOnlyAtOrAbove: null,
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  mutateCanonicalState: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: "high",
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  enqueueDerivedWork: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: true,
    humanOnlyAtOrAbove: null,
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  suppress: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: true,
    humanOnlyAtOrAbove: "high",
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  drop: {
    automaticGate: "unavailable",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: "low",
    budgetLane: null,
    maxAutomaticConsequence: null,
  },
  publish: {
    automaticGate: "deterministic_oracle",
    requiresCompletenessOracle: false,
    humanOnlyAtOrAbove: "high",
    budgetLane: null,
    maxAutomaticConsequence: "material",
  },
});
