import { deepFreeze } from "../deep-freeze.js";

export type ContractLifecycleState =
  | "draft"
  | "active"
  | "draining"
  | "retired";

/** Spec 5.6 forward-only contract lifecycle. */
export const CONTRACT_LIFECYCLE_TRANSITIONS: ReadonlyArray<{
  from: ContractLifecycleState;
  to: ContractLifecycleState;
}> = deepFreeze([
  { from: "draft", to: "active" },
  { from: "active", to: "draining" },
  { from: "draining", to: "retired" },
]);

export function canTransitionContract(
  from: ContractLifecycleState,
  to: ContractLifecycleState,
): boolean {
  return CONTRACT_LIFECYCLE_TRANSITIONS.some(
    (transition) =>
      transition.from === from && transition.to === to,
  );
}

interface ContractLifecycleRule {
  leasing: "enabled" | "disabled";
  acceptsResults: "yes" | "until_accepted_until" | "no";
  validatorsLoaded: boolean;
  queuedJobs: "normal" | "reemit_or_migrate" | "none";
  lateResultClassification:
    | "not_applicable"
    | "contract_expired_coordinator_fault";
}

/** Per-state operational obligations, including mandatory draining dual-read. */
export const CONTRACT_LIFECYCLE_RULES: Record<
  ContractLifecycleState,
  ContractLifecycleRule
> = deepFreeze({
  draft: {
    leasing: "disabled",
    acceptsResults: "no",
    validatorsLoaded: false,
    queuedJobs: "none",
    lateResultClassification: "not_applicable",
  },
  active: {
    leasing: "enabled",
    acceptsResults: "yes",
    validatorsLoaded: true,
    queuedJobs: "normal",
    lateResultClassification: "not_applicable",
  },
  draining: {
    leasing: "disabled",
    acceptsResults: "until_accepted_until",
    validatorsLoaded: true,
    queuedJobs: "reemit_or_migrate",
    lateResultClassification: "contract_expired_coordinator_fault",
  },
  retired: {
    leasing: "disabled",
    acceptsResults: "no",
    validatorsLoaded: false,
    queuedJobs: "none",
    lateResultClassification: "contract_expired_coordinator_fault",
  },
});
