import { deepFreeze } from "../deep-freeze.js";

export type AttemptOutcome =
  | "no_work"
  | "success"
  | "coordinator_fault"
  | "provider_or_platform_failure"
  | "rejected_invalid"
  | "abandoned_before_payload"
  | "abandoned_after_payload"
  | "lease_expired_no_fault";

interface FairAttemptRule {
  countsForContribution: boolean;
  raisesSuspicion: boolean;
}

/** Spec 6.9. Coordinator faults include outages and contract expiry. */
export const FAIR_ATTEMPT_TABLE: Record<
  AttemptOutcome,
  FairAttemptRule
> = deepFreeze({
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
