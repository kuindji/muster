import type { Consequence, Surface } from "./actions.js";
import type { AgreementPolicy } from "./agreement.js";
import { deepFreeze } from "./deep-freeze.js";
import type { ActionPermit, JSONSchema } from "./effect.js";
import type {
  AbsenceRequirement,
  ActionEvidenceRequirement,
  EvidenceRequirement,
  OracleSpec,
  OracleVerdict,
} from "./oracle.js";
import type { NonEmptyArray, Seconds } from "./primitives.js";
import type { AutomaticVerificationStrength } from "./verification.js";

export type WorkerState =
  | "enrolled"
  | "active"
  | "maintenance"
  | "paused"
  | "suspended"
  | "revoked";

export interface Validator<Payload, Result> {
  id: string;
  /** Deterministic, no I/O. */
  run(payload: Payload, result: Result): OracleVerdict;
}

export interface CanaryCase<Payload, Result> {
  /** Ledger identity of this canary case. */
  canaryId: string;
  /** Real resolved job from which the case was drawn (spec 5.7, 6.11). */
  sourceJobId: string;
  contractVersion: string;
  payload: Payload;
  expected: Result;
}

/**
 * Spec 6.11: three canary rates. Drawing is deterministic in `(kind, seed)`
 * so injection can be replayed in audit; core supplies the seed.
 */
export interface CanarySource<Payload, Result> {
  rates: {
    probationQ: number;
    productionQ: number;
    auditQ: number;
  };
  draw(
    kind: "probation" | "production" | "audit",
    seed: string,
  ): CanaryCase<Payload, Result> | null;
}

/**
 * Spec 3.2 capability matching. Omitted axes impose no requirement.
 * `providerSurfaces` is any-of, `languages` is all-of, and true unattended
 * scheduling requires a verified enrollment probe.
 */
export interface CapabilityRequirement {
  providerSurfaces?: NonEmptyArray<string>;
  unattendedScheduling?: boolean;
  languages?: NonEmptyArray<string>;
}

export type DiversityAxis =
  | "slot"
  | "provider"
  | "accountCluster"
  | "language"
  | "modelFamily";

export type AxisConfidence =
  | "attested"
  | "observed"
  | "self_reported"
  | "unknown";

/** Spec 6.2 confidence table. Registration refuses axes below observed. */
export const AXIS_CONFIDENCE: Record<
  DiversityAxis,
  AxisConfidence
> = deepFreeze({
  slot: "attested",
  provider: "observed",
  accountCluster: "observed",
  language: "observed",
  modelFamily: "self_reported",
});

/**
 * Every listed axis must show at least `minDistinct` accepted values.
 * Registration refuses values below two or above the replication target.
 */
export interface DiversityRule {
  axes: NonEmptyArray<DiversityAxis>;
  minDistinct: number;
}

export type PrivacyClass = "public" | "internal" | "sensitive";

/**
 * Spec 7 retention and consumer-notification visibility. Audit events remain
 * hash-only for every class; deployment configuration owns durations in M2.
 */
export const PRIVACY_CLASS_RULES: Record<
  PrivacyClass,
  {
    bodiesInConsumerNotifications: boolean;
    descriptorsInConsumerNotifications: boolean;
    ledgerBodies: "full" | "hash_only";
  }
> = deepFreeze({
  public: {
    bodiesInConsumerNotifications: true,
    descriptorsInConsumerNotifications: true,
    ledgerBodies: "full",
  },
  internal: {
    bodiesInConsumerNotifications: false,
    descriptorsInConsumerNotifications: false,
    ledgerBodies: "full",
  },
  sensitive: {
    bodiesInConsumerNotifications: false,
    descriptorsInConsumerNotifications: false,
    ledgerBodies: "hash_only",
  },
});

export interface ReplicationPolicy {
  /** Integer >= 1; independent accepted results required. */
  target: number;
  /** Integer >= 0; additional evidence only after a split. */
  maxSplitEvidenceReroutes: number;
}

export interface EscalationReserves {
  lowCostPerWeek: number;
  urgentPerWeek: number;
  splitAndAdjudicationPerWeek: number;
  /** Declared retrospective checks per week that the audit reserve must cover. */
  retrospectiveAuditProjectionPerWeek: number;
  auditPerWeek: number;
  perWorkerLowCostQuotaPerWeek: number;
  perWorkerUrgentQuotaPerWeek: number;
}

export interface AdjudicationPolicy {
  requiredRatePerWeek: number;
  starvationDwell: Seconds;
  /** Strictly greater than requiredRatePerWeek to provide hysteresis. */
  restoreAbovePerWeek: number;
  capacityMaxAge: Seconds;
  /** Integer >= 0; spec 6.6 rejected-dispute requeue cap. */
  maxRejectedDisputeRequeues: number;
}

export interface JobClass<Payload, Result> {
  id: string;
  /** Enters input_hash. */
  contractVersion: string;
  /** Reserved; v1 is one-shot only. */
  kind: "oneshot";

  /** Closed schema of the exact sanitized payload; enters input_hash. */
  payloadSchema: JSONSchema;
  /** Closed output schema; enters input_hash. */
  outputSchema: JSONSchema;
  maxPayloadBytes: number;
  maxResultBytes: number;
  sanitize(raw: unknown): Payload;

  /** Required automatic result floor. */
  verification: AutomaticVerificationStrength;
  /** Required for a deterministic result floor. */
  resultEvidenceRequirement?: EvidenceRequirement;
  validators: Validator<Payload, Result>[];
  oracles: OracleSpec<Payload, Result>[];
  /** Required when replication.target > 1. */
  agreement?: AgreementPolicy<Payload, Result>;
  replication: ReplicationPolicy;
  canaries?: CanarySource<Payload, Result>;

  /** Upper bound with one authorization mode per action; empty is meaningful. */
  permits: ActionPermit[];
  consequence: Consequence;
  /** Mandatory: bounded consumers must not silently receive weaker gates. */
  surface: Surface;
  evidenceRequirements: ActionEvidenceRequirement[];
  absenceRequirements: AbsenceRequirement[];

  requires: CapabilityRequirement;
  diversity?: DiversityRule;
  privacy: PrivacyClass;
  cost: {
    expectedTurns: number;
    /** Positive declared ceiling for every leaseTtl(payload) result. */
    maxLeaseTtl: Seconds;
    leaseTtl(payload: Payload): Seconds;
    maxInFlightLifetime: Seconds;
  };
  sla?: {
    targetLatency: Seconds;
    urgency: "normal" | "urgent";
  };
  escalation: EscalationReserves;
  /** Required when a gate may need a human. */
  adjudication?: AdjudicationPolicy;
}
