import { deepFreeze } from "./deep-freeze.js";
import type { Timestamp } from "./primitives.js";

/**
 * Spec 6.5 immutable acceptance facts. Exact retries replay this value; all
 * post-acceptance verification and adjudication data lives in status reads.
 */
export interface SubmissionReceipt {
  leaseId: string;
  jobId: string;
  collectionCycle: number;
  inputHash: string;
  resultHash: string;
  contractVersion: string;
  permitEpoch: string;
  outcome: "accepted";
  acceptedAt: Timestamp;
}

export type ResultState =
  | "collecting"
  | "pending_result_adjudication"
  | "verified"
  | "rejected"
  | "expired"
  | "superseded"
  | "cancelled";

export type ResultAdjudicationRequestState =
  | "pending_result_adjudication"
  | "resolved"
  | "rejected"
  | "expired"
  | "superseded"
  | "cancelled";

export type AuthorizationRequestState =
  | "pending_adjudication"
  | "authorized"
  | "denied"
  | "expired"
  | "superseded"
  | "cancelled";

export type AuthorizationInvalidationReason =
  | "emergency_halted"
  | "emergency_permit_withdrawal"
  | "contract_expired"
  | "max_in_flight_exceeded"
  | "operator_cancelled";

export type AuthorizationDenialReason =
  | "permit_rejected"
  | "gate_failed"
  | "escalation_budget_exhausted"
  | "human_rejected";

export type AuthorizationValidity =
  | { kind: "valid" }
  | {
      kind: "invalid";
      reason: AuthorizationInvalidationReason;
      invalidatedAt: Timestamp;
    };

export type AuthorizationStatus =
  | { state: "authorized"; validity: AuthorizationValidity }
  | { state: "denied"; reason: AuthorizationDenialReason }
  | {
      state: Exclude<
        AuthorizationRequestState,
        "authorized" | "denied"
      >;
    };

export interface ClassHealth {
  operating:
    | "ready"
    | "adjudication_starved"
    | "admission_halted"
    | "emergency_halted";
  reserves: {
    lowCost: "available" | "saturated";
    urgent: "available" | "saturated";
    splitAndAdjudication: "available" | "saturated";
    audit: "available" | "saturated";
  };
}

export interface AdjudicationCapacity {
  classId: string;
  availableReviewsPerWeek: number;
  observedAt: Timestamp;
}

/**
 * Result retirement targets. Verified is final for collection but remains
 * usable for new intents until one of these causes retires it.
 */
export const RESULT_INVALIDATION_TERMINALS: readonly ResultState[] =
  deepFreeze([
    "rejected",
    "expired",
    "superseded",
    "cancelled",
  ]);

export const TERMINAL_AUTHORIZATION_STATES: readonly AuthorizationRequestState[] =
  deepFreeze([
    "authorized",
    "denied",
    "expired",
    "superseded",
    "cancelled",
  ]);

/**
 * Spec 6.6 precedence rows 2–6. Store commands derive the retirement target
 * from the cause so an invalid cause/state pairing is not representable.
 */
export const INVALIDATION_RESULT_TARGET: Record<
  AuthorizationInvalidationReason,
  ResultState
> = deepFreeze({
  emergency_halted: "cancelled",
  operator_cancelled: "cancelled",
  emergency_permit_withdrawal: "superseded",
  contract_expired: "expired",
  max_in_flight_exceeded: "expired",
});
