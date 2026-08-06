import { deepFreeze } from "./deep-freeze.js";

export type Action =
  | "routeToHumanLowCost"
  | "routeToHumanUrgent"
  | "annotateDecisionRecord"
  | "deprioritize"
  | "routeToUrgent"
  | "updateRetrievalIndex"
  | "selectCandidateSet"
  | "mutateCanonicalState"
  | "enqueueDerivedWork"
  | "suppress"
  | "drop"
  | "publish";

/**
 * Spec 4.3 listing order. This enters effect_intent_hash and is frozen at
 * runtime to prevent mutation from changing future hashes.
 */
export const ACTION_ORDER: readonly Action[] = deepFreeze([
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
] as Action[]);

export function compareActions(left: Action, right: Action): number {
  return ACTION_ORDER.indexOf(left) - ACTION_ORDER.indexOf(right);
}

export function sortByActionOrder<T>(
  items: readonly T[],
  key: (item: T) => Action,
): T[] {
  return [...items].sort((left, right) =>
    compareActions(key(left), key(right)),
  );
}

export type Consequence = "low" | "material" | "high" | "irreversible";

export const CONSEQUENCE_ORDER: readonly Consequence[] = deepFreeze([
  "low",
  "material",
  "high",
  "irreversible",
] as Consequence[]);

export function consequenceAtLeast(
  consequence: Consequence,
  floor: Consequence,
): boolean {
  return (
    CONSEQUENCE_ORDER.indexOf(consequence) >=
    CONSEQUENCE_ORDER.indexOf(floor)
  );
}

export type Surface = "bounded" | "unbounded";

/** Spec 4.3: pushing an item off a bounded surface withholds it in fact. */
export function effectiveGateAction(
  action: Action,
  surface: Surface,
): Action {
  return action === "deprioritize" && surface === "bounded"
    ? "suppress"
    : action;
}
