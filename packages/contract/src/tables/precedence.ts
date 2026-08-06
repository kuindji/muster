import { deepFreeze } from "../deep-freeze.js";

export type PrecedenceConditionId =
  | "lease_holder_revoked"
  | "emergency_halted"
  | "operator_cancellation"
  | "emergency_permit_withdrawal"
  | "contract_expired"
  | "max_in_flight_exceeded"
  | "admission_halted"
  | "adjudication_starved"
  | "split_adjudication_saturated"
  | "audit_saturated"
  | "urgent_saturated"
  | "low_cost_saturated"
  | "permit_epoch";

export type InFlightEffect =
  | "none"
  | "requeue_holder_work"
  | "cancel_and_invalidate"
  | "supersede_withdrawn_epoch"
  | "expire_and_invalidate"
  | "expire_invalidate_requeue"
  | "keep_pending"
  | "deny_urgent_lane_authorizations"
  | "deny_overflow_escalations"
  | "gate_under_stamped_epoch";

export interface PrecedenceRule {
  /** One is the highest authority. */
  rank: number;
  id: PrecedenceConditionId;
  refusesNewEnqueue: boolean;
  refusesLease: boolean;
  invalidatesIssuedAuthorizations: boolean;
  inFlight: InFlightEffect;
  summary: string;
}

/** Spec 6.6 precedence. Results must not depend on evaluation order. */
export const PRECEDENCE_TABLE: readonly PrecedenceRule[] = deepFreeze([
  {
    rank: 1,
    id: "lease_holder_revoked",
    refusesNewEnqueue: false,
    refusesLease: true,
    invalidatesIssuedAuthorizations: false,
    inFlight: "requeue_holder_work",
    summary:
      "Reject that holder's open leases, requeue their work; other workers' accepted evidence remains valid",
  },
  {
    rank: 2,
    id: "emergency_halted",
    refusesNewEnqueue: true,
    refusesLease: true,
    invalidatesIssuedAuthorizations: true,
    inFlight: "cancel_and_invalidate",
    summary:
      "Cancel affected results for future intents and pending adjudications under the recorded operator policy",
  },
  {
    rank: 3,
    id: "operator_cancellation",
    refusesNewEnqueue: false,
    refusesLease: false,
    invalidatesIssuedAuthorizations: true,
    inFlight: "cancel_and_invalidate",
    summary:
      "Cancel selected results and their pending adjudications; apply the recorded requeue policy atomically",
  },
  {
    rank: 4,
    id: "emergency_permit_withdrawal",
    refusesNewEnqueue: false,
    refusesLease: false,
    invalidatesIssuedAuthorizations: true,
    inFlight: "supersede_withdrawn_epoch",
    summary:
      "Supersede pending adjudications and verified results of the withdrawn epoch; requeue collecting results under the current epoch",
  },
  {
    rank: 5,
    id: "contract_expired",
    refusesNewEnqueue: true,
    refusesLease: true,
    invalidatesIssuedAuthorizations: true,
    inFlight: "expire_and_invalidate",
    summary:
      "Expire affected results and pending states; contract_expired, coordinator fault",
  },
  {
    rank: 6,
    id: "max_in_flight_exceeded",
    refusesNewEnqueue: false,
    refusesLease: false,
    invalidatesIssuedAuthorizations: true,
    inFlight: "expire_invalidate_requeue",
    summary:
      "Expire, requeue under the current epoch, re-gate from scratch",
  },
  {
    rank: 7,
    id: "admission_halted",
    refusesNewEnqueue: true,
    refusesLease: true,
    invalidatesIssuedAuthorizations: false,
    inFlight: "none",
    summary:
      "Refuse new enqueue and lease; valid in-flight submissions and verdicts may complete",
  },
  {
    rank: 8,
    id: "adjudication_starved",
    refusesNewEnqueue: true,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "none",
    summary:
      "Refuse NEW enqueues only; split-evidence reroutes and expiry requeues of existing work proceed",
  },
  {
    rank: 9,
    id: "split_adjudication_saturated",
    refusesNewEnqueue: true,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "keep_pending",
    summary:
      "Refuse new class enqueues; affected in-flight results stay pending; never converts a split into agreement",
  },
  {
    rank: 9,
    id: "audit_saturated",
    refusesNewEnqueue: true,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "none",
    summary:
      "Refuse new class enqueues rather than lower the declared audit rate; no in-flight effect",
  },
  {
    rank: 10,
    id: "urgent_saturated",
    refusesNewEnqueue: true,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "deny_urgent_lane_authorizations",
    summary:
      "Refuse new enqueues; an in-flight authorization request including an urgent-lane action is denied escalation_budget_exhausted",
  },
  {
    rank: 11,
    id: "low_cost_saturated",
    refusesNewEnqueue: false,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "deny_overflow_escalations",
    summary:
      "Intake continues; deny overflow routine escalation from existing results, fire onLowCostUncovered",
  },
  {
    rank: 12,
    id: "permit_epoch",
    refusesNewEnqueue: false,
    refusesLease: false,
    invalidatesIssuedAuthorizations: false,
    inFlight: "gate_under_stamped_epoch",
    summary: "Gate under the stamped epoch",
  },
]);

/** Return every active rule at the winning (lowest) rank. */
export function atHighestRank(
  active: PrecedenceConditionId[],
): PrecedenceRule[] {
  const rules = PRECEDENCE_TABLE.filter((rule) =>
    active.includes(rule.id),
  );
  if (rules.length === 0) return [];
  const winningRank = Math.min(...rules.map((rule) => rule.rank));
  return rules.filter((rule) => rule.rank === winningRank);
}
