import { deepFreeze } from "@kuindji/muster-contract";
import type {
  DiversityAxis,
  ActionAdjudicationRequest,
  ActionAdjudicationVerdict,
  ActionAuthorization,
  AdjudicationCapacity,
  AttemptOutcome,
  AuthorizationDenialReason,
  AuthorizationInitialReceipt,
  AuthorizationInvalidationReason,
  AuthorizationRequestState,
  AuthorizationStatus,
  AutomaticVerificationStrength,
  CanonicalJsonValue,
  ClassHealth,
  ContractLifecycleState,
  EffectIntent,
  PrivacyClass,
  ResultAdjudicationRequest,
  ResultAdjudicationVerdict,
  ResultState,
  QueueMode,
  Seconds,
  SubmissionEvidence,
  SubmissionReceipt,
  Timestamp,
  WorkerId,
  WorkerState,
} from "@kuindji/muster-contract";
import type { MusterEvent } from "./events.js";

export interface Clock {
  now(): Timestamp;
}

export const CORE_IDENTITY_KINDS = deepFreeze([
  "lease",
  "result_adjudication_request",
  "authorization_request",
  "reputation_evidence",
] as const);

export type CoreIdentityKind = (typeof CORE_IDENTITY_KINDS)[number];

/** Deterministic core input; production adapters may allocate opaque IDs. */
export interface IdSource {
  next(kind: CoreIdentityKind): string;
}

/** Exhaustive ownership map for identities created or consumed by core. */
export const CORE_IDENTITY_OWNERSHIP = deepFreeze({
  callerSupplied: [
    "worker_id",
    "job_id",
    "class_id",
    "contract_version",
    "permit_epoch",
    "effect_intent_id",
    "adjudicator_id",
  ],
  contentDerived: [
    "payload_schema_hash",
    "output_schema_hash",
    "input_hash",
    "result_hash",
    "decision_result_hash",
    "effect_intent_hash",
    "verdict_hash",
    "expected_result_hash",
  ],
  idSourceAllocated: CORE_IDENTITY_KINDS,
} as const);

/** Deployment-owned bounded extension policy, snapshotted into every lease. */
export interface CoreDeploymentPolicy {
  readonly version: string;
  readonly extensionTtl: Seconds;
  readonly maxExtensionsPerLease: number;
}

/** Complete deterministic routing period prepared by worker-control policy. */
export interface WorkerRoutingPeriod {
  readonly contributionWindowId: string;
  readonly assignedSlotOccurrence: string;
  readonly slotOpen: boolean;
}

/**
 * Deployment-owned worker policy. Functions are deterministic and I/O-free;
 * their closed inputs deliberately contain no job or payload selector.
 */
export interface WorkerControlPolicy {
  readonly probationCheckedSuccesses: number;
  readonly probationMinimumEnrollmentAge: Seconds;
  assignSlot(input: {
    readonly workerId: WorkerId;
    readonly enrolledAt: Timestamp;
  }): number;
  routingAt(input: {
    readonly workerId: WorkerId;
    readonly slot: number;
    readonly at: Timestamp;
  }): WorkerRoutingPeriod;
}

export interface EventSink {
  emit(event: MusterEvent): void;
}

export interface AdmissionHook {
  admit(candidate: {
    workerId: WorkerId;
    declaredCapPerWeek: number;
  }): Promise<{ admit: boolean; reason?: string }>;
}

export interface AdjudicationSource {
  capacity(classId: string): AdjudicationCapacity;
  authenticate(
    verdict: ResultAdjudicationVerdict | ActionAdjudicationVerdict,
  ): boolean;
}

/** Deployment-owned queue facts consumed by deterministic operations policy. */
export interface QueueCapacityObservation {
  readonly observedAt: Timestamp;
  readonly activeWorkers: number;
  readonly itemsPerBatch: number;
  readonly combinedCanaryAuditFraction: number;
  readonly meanReplicationFactor: number;
  readonly minimumEffectiveCapacity: number;
  readonly oldestSlaBreachAt?: Timestamp;
  readonly slotWindow: {
    readonly startsAt: Timestamp;
    readonly endsAt: Timestamp;
    readonly providers: readonly {
      readonly providerSurface: string;
      readonly expectedArrivals: number;
      readonly observedArrivals: number;
    }[];
  };
}

/** Trusted observation boundary; policy is explicit and contains no job body. */
export interface OperationsSource {
  observeQueue(): QueueCapacityObservation;
}

export type ReputationEvidenceSource =
  | "checked_success"
  | "adjudicated_falsehood"
  | "deterministic_oracle"
  | "completeness_oracle"
  | "held_out_canary"
  | "human_audit"
  | "published_correction"
  | "structural_failure"
  | "validator_failure"
  | "post_payload_abandonment"
  | "escalation_quota_abuse";

interface ReputationEvidenceRecordBase {
  evidenceId: string;
  workerId: WorkerId;
  at: Timestamp;
  job?: { jobId: string; collectionCycle: number };
  detailHash?: string;
}

export type ReputationEvidenceRecord = ReputationEvidenceRecordBase &
  (
    | { source: "checked_success"; impact: "positive" }
    | {
        source: Exclude<ReputationEvidenceSource, "checked_success">;
        impact: "negative";
      }
  );

/** Consumer-owned routing policy; deterministic and I/O-free. */
export interface ReputationPolicy {
  assess(input: {
    worker: WorkerRecord;
    evidence: readonly ReputationEvidenceRecord[];
  }): { eligible: boolean; /** Finite routing tiebreaker. */ priority: number };
}

export interface WorkerRecord {
  workerId: WorkerId;
  state: WorkerState;
  enrolledAt: Timestamp;
  declaredCapPerWeek: number;
  capabilities: {
    providerSurface: string;
    unattendedScheduling: boolean;
    languages: string[];
    jobClassIds: string[];
  };
  accountCluster: string;
  slot: number;
  contractAcceptance: { contractVersion: string; acceptedAt: Timestamp };
}

export interface QueuePriority {
  readonly lane: "normal" | "urgent";
  /** Finite integer; higher values are selected first within a lane. */
  readonly value: number;
  readonly enqueuedAt: Timestamp;
  /** Stable bytewise tiebreaker allocated by the enqueue caller. */
  readonly sequence: string;
}

export interface JobRecord {
  jobId: string;
  classId: string;
  contractVersion: string;
  inputHash: string;
  payloadRef: string;
  policyVersion: string;
  permitEpoch: string;
  collectionCycle: number;
  notBefore?: Timestamp;
  firstEnqueuedAt: Timestamp;
  cycleStartedAt: Timestamp;
  rejectedDisputeRequeues: number;
  queuePriority: QueuePriority;
}

export interface DecisionResultRecord {
  decisionResultHash: string;
  jobId: string;
  collectionCycle: number;
  inputHash: string;
  result: CanonicalJsonValue;
  evidence: SubmissionEvidence[];
  achievedStrength: AutomaticVerificationStrength;
  resultAdjudicationVerdictHash?: string;
  contractVersion: string;
  permitEpoch: string;
  verifiedAt: Timestamp;
}

interface ReservePolicySnapshotBase {
  readonly classId: string;
  readonly contractVersion: string;
  readonly policyVersion: string;
  /** Opaque durable rollover identity; never inferred by a Store adapter. */
  readonly windowId: string;
  readonly windowStartsAt: Timestamp;
  readonly windowEndsAt: Timestamp;
  readonly laneLimit: number;
}

export type ReservePolicySnapshot =
  | (ReservePolicySnapshotBase & {
      readonly lane: "lowCost" | "urgent";
      readonly perWorkerLimit: number;
    })
  | (ReservePolicySnapshotBase & {
      readonly lane: "splitAndAdjudication" | "audit";
      readonly perWorkerLimit?: never;
    });

export interface ReserveWorkerUsage {
  readonly workerId: WorkerId;
  readonly used: number;
}

/** Authoritative Store-owned accounting state for one class/version/lane. */
export interface ReservePolicyRecord {
  readonly revision: number;
  readonly policy: ReservePolicySnapshot;
  readonly used: number;
  /** Canonically sorted by workerId; empty for non-worker-qualified lanes. */
  readonly workerUsage: readonly ReserveWorkerUsage[];
  readonly updatedAt: Timestamp;
}

export type InitializeReservePolicyOutcome =
  | {
      kind: "initialized" | "replayed";
      current: ReservePolicyRecord;
      classHealth: ClassHealthSnapshot;
    }
  | { kind: "conflict"; current: ReservePolicyRecord }
  | {
      kind: "refused";
      reason:
        | "class_version_not_found"
        | "class_version_retired"
        | "class_health_missing"
        | "invalid_policy";
    };

export type TransitionReservePolicyOutcome =
  | {
      kind: "applied" | "replayed";
      current: ReservePolicyRecord;
      classHealth: ClassHealthSnapshot;
    }
  | { kind: "conflict"; current: ReservePolicyRecord }
  | {
      kind: "refused";
      reason:
        | "class_version_retired"
        | "class_health_missing"
        | "invalid_policy"
        | "window_not_forward";
    };

export interface ReserveCharge {
  readonly chargeKey: string;
  /** Canonically sorted and unique. */
  readonly workerIds: readonly WorkerId[];
  readonly policy: ReservePolicySnapshot;
  /** First-attempt timestamp; exact retries replay the first persisted value. */
  readonly at: Timestamp;
}

export interface ReserveChargeRecord {
  readonly charge: ReserveCharge;
  readonly outcome: "charged" | "exhausted";
}

export const AUTHORIZATION_RESERVE_LANE_ORDER = deepFreeze([
  "lowCost",
  "urgent",
  "splitAndAdjudication",
] as const);

export type AuthorizationReserveLane =
  (typeof AUTHORIZATION_RESERVE_LANE_ORDER)[number];

export interface AuthorizationReserveSettlement {
  readonly lane: AuthorizationReserveLane;
  readonly charge: ReserveChargeRecord;
  readonly currentPolicy: ReservePolicyRecord;
}

export interface AuthorizationReserveBatchResult {
  readonly settlements: readonly AuthorizationReserveSettlement[];
  readonly skippedLanes: readonly AuthorizationReserveLane[];
  readonly classHealth: ClassHealthSnapshot;
}

export interface ReserveMutation<
  Outcome extends ReserveChargeRecord["outcome"] = ReserveChargeRecord["outcome"],
> {
  readonly charge: ReserveChargeRecord & { readonly outcome: Outcome };
  readonly currentPolicy: ReservePolicyRecord;
  readonly classHealth: ClassHealthSnapshot;
}

export type ReserveMutationConflict =
  | {
      kind: "reserve_charge_conflict";
      existingCharge: ReserveChargeRecord;
    }
  | {
      kind: "reserve_policy_conflict";
      currentPolicy: ReservePolicyRecord | null;
    };

export type AuthorizationReserveBatchConflict =
  | {
      kind: "reserve_charge_conflict";
      lane: AuthorizationReserveLane;
      existingCharge: ReserveChargeRecord;
    }
  | {
      kind: "reserve_policy_conflict";
      lane: AuthorizationReserveLane;
      currentPolicy: ReservePolicyRecord | null;
    }
  | {
      kind: "reserve_batch_invalid";
      reason:
        | "lane_order"
        | "duplicate_lane"
        | "charge_key"
        | "extraneous_lane"
        | "context_mismatch"
        | "worker_order"
        | "decision_mismatch";
    };

export type ReserveChargeOutcome =
  | ({
      kind: "charged";
      status: "applied" | "replayed";
    } & ReserveMutation<"charged">)
  | ({
      kind: "exhausted";
      status: "applied" | "replayed";
    } & ReserveMutation<"exhausted">)
  | ReserveMutationConflict;

export interface LeaseCanaryAssignment {
  readonly kind: "canary";
  readonly canaryKind: "probation" | "production" | "audit";
  readonly canaryId: string;
  readonly sourceJobId: string;
  readonly sourceContractVersion: string;
  readonly expectedResultHash: string;
}

export type LeaseAssignment =
  | { readonly kind: "ordinary" }
  | LeaseCanaryAssignment;

export interface LeaseRoutingSnapshot {
  readonly candidateRevision: number;
  readonly workerRevision: number;
  readonly operational: OperationalStateExpectation;
  readonly contributionWindowId: string;
  readonly contributionOrdinal: number;
  readonly assignedSlotOccurrence: string;
  readonly attemptNumber: number;
  readonly queuePriority: QueuePriority;
}

export interface LeaseRecord {
  leaseId: string;
  jobId: string;
  collectionCycle: number;
  classId: string;
  holder: WorkerId;
  inputHash: string;
  contractVersion: string;
  policyVersion: string;
  permitEpoch: string;
  /**
   * Exact operational payload sent under this lease. Ordinary leases retain
   * the job payload reference; canary leases reuse their IdSource leaseId so
   * core does not create a second unowned opaque identity.
   */
  payloadRef: string;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  absoluteInFlightDeadline: Timestamp;
  extensionsUsed: number;
  extensionPolicy: CoreDeploymentPolicy;
  snapshot: { maxResultBytes: number; maxPayloadBytes: number };
  assignment: LeaseAssignment;
  routing: LeaseRoutingSnapshot;
  open: boolean;
}

export interface AcceptedDiversityFact {
  readonly workerId: WorkerId;
  readonly axes: Readonly<Partial<Record<DiversityAxis, string>>>;
}

export interface JobCycleAttemptSnapshot {
  readonly attemptCount: number;
  readonly openLeaseIds: readonly string[];
  readonly acceptedWorkerIds: readonly WorkerId[];
  readonly acceptedDiversity: readonly AcceptedDiversityFact[];
  /** Persisted only after core proves a non-unanimous target evidence set. */
  readonly splitObserved: boolean;
}

/** Immutable Store read. Core ranks these records; Store does not. */
export interface LeaseCandidateSnapshot {
  readonly revision: number;
  readonly job: Readonly<JobRecord>;
  readonly attempts: JobCycleAttemptSnapshot;
  readonly operational: OperationalStateExpectation;
}

/** Durable facts core uses for contribution, slot, and concurrency checks. */
export interface WorkerRoutingSnapshot {
  readonly revision: number;
  readonly workerId: WorkerId;
  readonly contributionWindowId: string;
  readonly contributionUsed: number;
  readonly assignedSlotOccurrence: string;
  readonly openLeaseIds: readonly string[];
}

export interface QueueModeSnapshot {
  /** Store-owned monotonically increasing comparison token. */
  readonly revision: number;
  readonly mode: QueueMode;
  readonly cause:
    | "bootstrap"
    | "capacity"
    | "sla"
    | "pool_offline"
    | "operator"
    | "emergency";
  readonly updatedAt: Timestamp;
}

export type FrozenClassHealth = Readonly<Omit<ClassHealth, "reserves">> & {
  readonly reserves: Readonly<ClassHealth["reserves"]>;
};

export interface ClassHealthSnapshot {
  /** Store-owned monotonically increasing comparison token. */
  readonly revision: number;
  readonly classId: string;
  readonly health: FrozenClassHealth;
  readonly updatedAt: Timestamp;
  readonly source: "automatic" | "operator";
  /** First continuously unsafe capacity/demand observation, if any. */
  readonly adjudicationUnsafeSince?: Timestamp;
}

/** Atomic rolling-demand and pending-backlog comparison surface. */
export interface AdjudicationLoadSnapshot {
  readonly revision: number;
  readonly classId: string;
  readonly windowStartsAt: Timestamp;
  readonly admittedDemand: number;
  readonly oldestPendingOpenedAt?: Timestamp;
}

export interface LedgerEntry {
  readonly at: Timestamp;
  readonly kind: string;
  readonly outcome: string;
  readonly privacy: PrivacyClass;
  readonly classId?: string;
  readonly job?: { readonly jobId: string; readonly collectionCycle: number };
  readonly workerId?: WorkerId;
  readonly providerSurface?: string;
  readonly contractVersion?: string;
  readonly correlationId?: string;
  readonly hashes: Readonly<Record<string, string>>;
  readonly body?: CanonicalJsonValue;
  readonly descriptors?: CanonicalJsonValue;
}

export type AppendLedgerOutcome =
  | { readonly kind: "recorded" }
  | {
      readonly kind: "refused";
      readonly reason: "invalid_entry" | "privacy_violation";
    };

export interface OperationalStateExpectation {
  readonly queueRevision: number;
  readonly classHealthRevision: number;
}

export type OperationalTransitionOutcome<T> =
  | { kind: "applied" | "replayed"; current: T }
  | { kind: "conflict"; current: T };

export interface WorkerRegistration {
  readonly worker: WorkerRecord;
  readonly routing: {
    readonly contributionWindowId: string;
    readonly contributionUsed: 0;
    readonly assignedSlotOccurrence: string;
  };
}

export type RegisterWorkerOutcome =
  | {
      kind: "registered" | "replayed";
      worker: WorkerRecord;
      routing: WorkerRoutingSnapshot;
    }
  | {
      kind: "conflict";
      existingWorker: WorkerRecord;
      existingRouting: WorkerRoutingSnapshot;
    };

export type WorkerRoutingTransitionOutcome =
  OperationalTransitionOutcome<WorkerRoutingSnapshot>;

export type InitializeClassHealthOutcome =
  | { kind: "initialized" | "replayed"; current: ClassHealthSnapshot }
  | { kind: "conflict"; current: ClassHealthSnapshot };

export type EnqueueOutcome =
  | { kind: "enqueued" | "replayed" }
  | { kind: "conflict" }
  | {
      kind: "operational_state_conflict";
      current: OperationalStateExpectation;
    }
  | { kind: "refused"; queue: QueueMode; health: ClassHealth };

export type ClaimLeaseOutcome =
  | { kind: "claimed"; lease: LeaseRecord; job: JobRecord }
  | {
      kind: "conflict";
      reason:
        | "candidate_stale"
        | "worker_snapshot_stale"
        | "operational_state_stale"
        | "identity_collision"
        | "unclaimable";
    };

export type NoWorkAttemptOutcome =
  | { kind: "recorded"; current: WorkerRoutingSnapshot }
  | { kind: "conflict"; current: WorkerRoutingSnapshot };

export interface ClassVersionRecord {
  classId: string;
  contractVersion: string;
  payloadSchemaHash: string;
  outputSchemaHash: string;
  state: ContractLifecycleState;
  registeredAt: Timestamp;
  leaseDisabledAt?: Timestamp;
  acceptedUntil?: Timestamp;
}

/** Complete immutable comparison used by a first authorization attempt. */
export interface AuthorizationContextSnapshot {
  readonly decision: DecisionResultRecord;
  readonly jobCycle: JobRecord;
  readonly currentJob: JobRecord;
  readonly resultState: ResultState;
  readonly classVersion: ClassVersionRecord;
  /** Core-computed operational cutoff; never enters a wire hash or receipt. */
  readonly maxInFlightDeadline: Timestamp;
}

/** Complete immutable comparison used by a first result verdict. */
export interface ResultVerdictContextSnapshot {
  readonly request: ResultAdjudicationRequest;
  readonly jobCycle: JobRecord;
  readonly currentJob: JobRecord;
  readonly resultState: ResultState;
  readonly classVersion: ClassVersionRecord;
  readonly maxInFlightDeadline: Timestamp;
}

/** Persisted request binding plus the independently inspected live parent state. */
export interface ActionVerdictContextSnapshot {
  readonly persisted: AuthorizationContextSnapshot;
  readonly current: Omit<AuthorizationContextSnapshot, "maxInFlightDeadline">;
}

export interface ClassVersionRegistration {
  classId: string;
  contractVersion: string;
  payloadSchemaHash: string;
  outputSchemaHash: string;
  registeredAt: Timestamp;
}

export type RegisterClassVersionOutcome =
  | { kind: "registered"; record: ClassVersionRecord }
  | { kind: "replayed"; record: ClassVersionRecord }
  | { kind: "conflict"; existing: ClassVersionRecord };

export type ContractTransitionOutcome =
  | {
      kind: "applied" | "replayed";
      record: Omit<ClassVersionRecord, "state"> & {
        state: Exclude<ContractLifecycleState, "retired">;
      };
      classHealth?: never;
    }
  | {
      kind: "applied" | "replayed";
      record: Omit<ClassVersionRecord, "state"> & { state: "retired" };
      /** Retirement atomically recomputes accounting-owned reserve health. */
      classHealth: ClassHealthSnapshot;
    }
  | { kind: "state_conflict"; actual: ContractLifecycleState }
  | { kind: "not_found" };

export interface RequeuedLeaseIdentity {
  leaseId: string;
  classId: string;
  jobId: string;
  collectionCycle: number;
  contractVersion: string;
  permitEpoch: string;
}

export type WorkerStateTransitionOutcome =
  | {
      kind: "applied" | "replayed";
      worker: WorkerRecord;
      requeuedOpenLeases: RequeuedLeaseIdentity[];
    }
  | { kind: "state_conflict"; actual: WorkerState }
  | { kind: "not_found" };

export type InvalidationScope =
  | { kind: "class"; classId: string }
  | {
      kind: "job_cycles";
      classId: string;
      jobCycles: Array<{ jobId: string; collectionCycle: number }>;
    }
  | {
      kind: "decision_results";
      classId: string;
      decisionResultHashes: string[];
    }
  | { kind: "permit_epoch"; classId: string; permitEpoch: string }
  | {
      kind: "contract_version";
      classId: string;
      contractVersion: string;
    };

export interface InvalidationTarget {
  jobId: string;
  collectionCycle: number;
  state: ResultState;
  inputHash: string;
  permitEpoch: string;
  contractVersion: string;
}

export interface CycleRequeuePlan {
  jobId: string;
  fromCollectionCycle: number;
  newCollectionCycle: number;
  permitEpoch: string;
  inputHash: string;
  cycleStartedAt: Timestamp;
}

export interface PermitEpochTransition {
  classId: string;
  fromEpoch: string | null;
  toEpoch: string;
}

export type PermitEpochTransitionOutcome =
  | { kind: "applied" | "replayed"; currentEpoch: string }
  | { kind: "conflict"; currentEpoch: string | null };

export interface InvalidationSnapshot {
  scope: InvalidationScope;
  targets: InvalidationTarget[];
}

export type InvalidationOutcome =
  | { kind: "conflict"; current: InvalidationSnapshot }
  | {
      kind: "applied";
      resultTransitions: Array<{
        jobId: string;
        collectionCycle: number;
        from: ResultState;
        to: ResultState;
      }>;
      authorizationTransitions: Array<{
        authorizationRequestId: string;
        from: AuthorizationRequestState;
        to: AuthorizationRequestState;
      }>;
      invalidatedAuthorizations: Array<{
        authorizationRequestId: string;
        classId: string;
        jobId: string;
        collectionCycle: number;
        reason: AuthorizationInvalidationReason;
      }>;
      newCycles: CycleRequeuePlan[];
      epochTransition?: PermitEpochTransition;
    };

export type AppliedInvalidationOutcome = Extract<
  InvalidationOutcome,
  { kind: "applied" }
>;

export interface PendingAdjudication<Request> {
  request: Request;
  openedAt: Timestamp;
}

export type ReputationEvidenceOutcome =
  | { kind: "recorded"; record: ReputationEvidenceRecord }
  | { kind: "replayed"; record: ReputationEvidenceRecord }
  | { kind: "conflict"; existing: ReputationEvidenceRecord };

export type SubmitOutcome =
  | { kind: "accepted"; receipt: SubmissionReceipt }
  | { kind: "replayed"; receipt: SubmissionReceipt }
  | { kind: "conflict" }
  | { kind: "evidence_conflict" }
  | {
      kind: "refused";
      error: "lease_not_held" | "contract_expired";
    };

export type SubmissionAttemptClassification = Extract<
  AttemptOutcome,
  "rejected_invalid" | "coordinator_fault" | "lease_expired_no_fault"
>;

export type RejectSubmissionOutcome =
  | { kind: "recorded" | "replayed" }
  | { kind: "conflict" | "evidence_conflict" }
  | { kind: "refused"; error: "lease_not_held" };

export type MarkResultSplitOutcome =
  | { kind: "recorded" | "replayed" }
  | { kind: "conflict"; actual: ResultState | null };

export type AuthorizeIntentOutcome =
  | {
      kind: "applied" | "replayed";
      initialReceipt: AuthorizationInitialReceipt;
      reserveBatch?: AuthorizationReserveBatchResult;
    }
  | { kind: "conflict" }
  | {
      kind: "authorization_context_conflict";
      reason:
        | "decision_changed"
        | "job_cycle_changed"
        | "current_cycle_changed"
        | "result_not_verified"
        | "class_version_ineligible";
    }
  | AuthorizationReserveBatchConflict;

interface VerdictReceiptBase {
  requestId: string;
  verdictHash: string;
  decidedAt: Timestamp;
}

export type VerdictReceipt =
  | (VerdictReceiptBase & {
      outcome: "rejected";
      rejectOutcome: "requeued" | "cap_exhausted";
    })
  | (VerdictReceiptBase & {
      outcome: "resolved" | "approved" | "denied";
    });

export type VerdictOutcome =
  | { kind: "applied"; receipt: VerdictReceipt }
  | { kind: "replayed"; receipt: VerdictReceipt }
  | { kind: "conflict" }
  | { kind: "freshness_conflict" }
  | { kind: "terminal" };

export interface VerdictHistoryRecord {
  readonly kind: "result" | "action";
  readonly requestId: string;
  readonly verdictHash: string;
  readonly verdict: ResultAdjudicationVerdict | ActionAdjudicationVerdict;
  readonly receipt: VerdictReceipt;
}

export type OpenAdjudicationOutcome =
  | ({ kind: "opened_charged"; openedAt: Timestamp } &
      ReserveMutation<"charged">)
  | ({ kind: "opened_uncovered"; openedAt: Timestamp } &
      ReserveMutation<"exhausted">)
  | ({
      kind: "replayed";
      original: "opened_charged";
      openedAt: Timestamp;
    } & ReserveMutation<"charged">)
  | ({
      kind: "replayed";
      original: "opened_uncovered";
      openedAt: Timestamp;
    } & ReserveMutation<"exhausted">)
  | { kind: "state_conflict"; actual: ResultState }
  | { kind: "identity_conflict" }
  | ReserveMutationConflict;

export type TransitionOutcome =
  | { ok: true }
  | { ok: false; actual: ResultState };

/** Atomic persistence commands consumed by the Milestone 2 core engine. */
export interface Store {
  getWorker(workerId: WorkerId): Promise<WorkerRecord | null>;
  registerWorker(
    registration: WorkerRegistration,
  ): Promise<RegisterWorkerOutcome>;
  transitionWorkerState(input: {
    workerId: WorkerId;
    from: WorkerState;
    to: WorkerState;
    at: Timestamp;
  }): Promise<WorkerStateTransitionOutcome>;

  registerClassVersion(
    registration: ClassVersionRegistration,
  ): Promise<RegisterClassVersionOutcome>;
  getClassVersion(
    classId: string,
    contractVersion: string,
  ): Promise<ClassVersionRecord | null>;
  transitionClassVersion(input: {
    classId: string;
    contractVersion: string;
    from: ContractLifecycleState;
    to: ContractLifecycleState;
    at: Timestamp;
    leaseDisabledAt?: Timestamp;
    acceptedUntil?: Timestamp;
  }): Promise<ContractTransitionOutcome>;
  getCurrentPermitEpoch(classId: string): Promise<string | null>;
  transitionPermitEpoch(
    transition: PermitEpochTransition & { at: Timestamp },
  ): Promise<PermitEpochTransitionOutcome>;

  enqueueJob(input: {
    job: JobRecord;
    payload: CanonicalJsonValue;
    expectedOperationalState: OperationalStateExpectation;
  }): Promise<EnqueueOutcome>;
  getJob(jobId: string): Promise<JobRecord | null>;
  getPayload(payloadRef: string): Promise<CanonicalJsonValue | null>;
  listLeaseCandidates(input: {
    classIds: string[];
  }): Promise<readonly LeaseCandidateSnapshot[]>;
  getWorkerRoutingSnapshot(
    workerId: WorkerId,
  ): Promise<WorkerRoutingSnapshot | null>;
  transitionWorkerRouting(input: {
    expected: WorkerRoutingSnapshot;
    next: Pick<
      WorkerRoutingSnapshot,
      | "contributionWindowId"
      | "contributionUsed"
      | "assignedSlotOccurrence"
    >;
  }): Promise<WorkerRoutingTransitionOutcome>;
  compareAndClaimLease(input: {
    expectedCandidate: LeaseCandidateSnapshot;
    expectedWorker: WorkerRoutingSnapshot;
    preparedLease: LeaseRecord;
    /** Exact payload bound by preparedLease.inputHash and payloadRef. */
    preparedPayload: CanonicalJsonValue;
  }): Promise<ClaimLeaseOutcome>;
  /** Atomically account for a coarse no-work result against one routing period. */
  recordNoWorkAttempt(input: {
    expectedWorker: WorkerRoutingSnapshot;
    at: Timestamp;
  }): Promise<NoWorkAttemptOutcome>;
  getLease(leaseId: string): Promise<LeaseRecord | null>;
  extendLease(input: {
    workerId: WorkerId;
    leaseId: string;
    expectedExpiry: Timestamp;
    expectedExtensionsUsed: number;
    newExpiry: Timestamp;
    newExtensionsUsed: number;
  }): Promise<
    { kind: "extended"; newExpiry: Timestamp } | { kind: "refused" }
  >;
  abandonLease(input: {
    workerId: WorkerId;
    leaseId: string;
    classification:
      | "abandoned_before_payload"
      | "abandoned_after_payload"
      | "provider_or_platform_failure";
    requeue: { sameCyclePermitEpoch: string };
    at: Timestamp;
  }): Promise<{ kind: "recorded" } | { kind: "refused" }>;
  expireAndRequeue(
    leaseId: string,
    under: { sameCyclePermitEpoch: string },
  ): Promise<void>;

  acceptOrReplaySubmission(input: {
    workerId: WorkerId;
    leaseId: string;
    inputHash: string;
    resultHash: string;
    body: CanonicalJsonValue;
    receipt: SubmissionReceipt;
    /** Optional checked-success or failure evidence committed with acceptance. */
    reputationEvidence?: ReputationEvidenceRecord;
  }): Promise<SubmitOutcome>;
  /**
   * Atomically closes and requeues an unaccepted lease attempt, applies the
   * fair-attempt contribution rule, and records optional reputation evidence.
   */
  rejectSubmission(input: {
    workerId: WorkerId;
    leaseId: string;
    classification: SubmissionAttemptClassification;
    at: Timestamp;
    reputationEvidence?: ReputationEvidenceRecord;
  }): Promise<RejectSubmissionOutcome>;
  getAcceptedSubmission(leaseId: string): Promise<{
    receipt: SubmissionReceipt;
    body: CanonicalJsonValue;
  } | null>;
  listAcceptedReplicas(
    jobId: string,
    collectionCycle: number,
  ): Promise<Array<{
    evidence: SubmissionEvidence;
    body: CanonicalJsonValue;
    acceptedAt: Timestamp;
  }>>;

  getResultState(
    jobId: string,
    collectionCycle: number,
  ): Promise<ResultState | null>;
  /** Atomically fences the evidence set that first made a split absorbing. */
  markResultSplit(input: {
    jobId: string;
    collectionCycle: number;
    inputHash: string;
    evidence: SubmissionEvidence[];
  }): Promise<MarkResultSplitOutcome>;
  transitionResult(input: {
    jobId: string;
    collectionCycle: number;
    from: ResultState;
    to: ResultState;
    at: Timestamp;
    startNewCycle?: {
      permitEpoch: string;
      inputHash: string;
      cycleStartedAt: Timestamp;
    };
  }): Promise<TransitionOutcome>;
  recordDecisionResult(input: {
    decision: DecisionResultRecord;
    transition: { from: ResultState; at: Timestamp };
  }): Promise<TransitionOutcome>;
  getDecisionResult(
    decisionResultHash: string,
  ): Promise<DecisionResultRecord | null>;
  inspectAuthorizationContext(
    decisionResultHash: string,
  ): Promise<Omit<AuthorizationContextSnapshot, "maxInFlightDeadline"> | null>;

  authorizeOrReplayIntent(input: {
    authorizationRequestId: string;
    effectIntent: EffectIntent;
    effectIntentHash: string;
    decisionResultHash: string;
    expectedContext: AuthorizationContextSnapshot;
    decision:
      | {
          kind: "authorize";
          authorization: ActionAuthorization;
          charges?: readonly ReserveCharge[];
        }
      | { kind: "deny"; reason: AuthorizationDenialReason }
      | {
          kind: "pend";
          request: ActionAdjudicationRequest;
          charges: readonly ReserveCharge[];
        };
    at: Timestamp;
  }): Promise<AuthorizeIntentOutcome>;
  getAuthorizationStatus(
    authorizationRequestId: string,
  ): Promise<AuthorizationStatus | null>;
  getInitialReceipt(
    effectIntentId: string,
  ): Promise<AuthorizationInitialReceipt | null>;
  getAuthorization(
    authorizationRequestId: string,
  ): Promise<ActionAuthorization | null>;

  inspectInvalidationScope(
    scope: InvalidationScope,
  ): Promise<InvalidationSnapshot>;
  invalidateResultScope(input: {
    scope: InvalidationScope;
    expectedTargets: InvalidationTarget[];
    requeuePlans: CycleRequeuePlan[];
    at: Timestamp;
  } & (
    | {
        reason: "emergency_permit_withdrawal";
        epochTransition: PermitEpochTransition;
      }
    | {
        reason: Exclude<
          AuthorizationInvalidationReason,
          "emergency_permit_withdrawal"
        >;
        epochTransition?: never;
      }
  )): Promise<InvalidationOutcome>;

  openResultAdjudication(input: {
    request: ResultAdjudicationRequest;
    resultTransition: {
      jobId: string;
      collectionCycle: number;
      from: ResultState;
      at: Timestamp;
    };
    charge: ReserveCharge;
  }): Promise<OpenAdjudicationOutcome>;
  getResultAdjudicationRequest(
    id: string,
  ): Promise<ResultAdjudicationRequest | null>;
  inspectResultVerdictContext(
    id: string,
  ): Promise<Omit<ResultVerdictContextSnapshot, "maxInFlightDeadline"> | null>;
  listPendingResultAdjudications(
    classId: string,
  ): Promise<Array<PendingAdjudication<ResultAdjudicationRequest>>>;
  applyResultAdjudicationVerdict(input: {
    verdict: ResultAdjudicationVerdict;
    verdictHash: string;
    processedAt: Timestamp;
    expectedContext: ResultVerdictContextSnapshot;
  } & (
    | { decision: "resolve"; resolved: DecisionResultRecord }
    | {
        decision: "reject";
        onReject: {
          cap: number;
          newCycleEpoch: string;
          newCycleInputHash: string;
          cycleStartedAt: Timestamp;
        };
      }
  )): Promise<VerdictOutcome>;
  getActionAdjudicationRequest(
    authorizationRequestId: string,
  ): Promise<ActionAdjudicationRequest | null>;
  getPendingAuthorizationContext(
    authorizationRequestId: string,
  ): Promise<AuthorizationContextSnapshot | null>;
  listPendingActionAdjudications(
    classId: string,
  ): Promise<Array<PendingAdjudication<ActionAdjudicationRequest>>>;
  getVerdictHistory(requestId: string): Promise<VerdictHistoryRecord | null>;
  applyActionAdjudicationVerdict(input: {
    verdict: ActionAdjudicationVerdict;
    verdictHash: string;
    processedAt: Timestamp;
    expectedContext: ActionVerdictContextSnapshot;
  } & (
    | { decision: "approve"; authorization: ActionAuthorization }
    | { decision: "reject" }
  )): Promise<VerdictOutcome>;

  getQueueMode(): Promise<QueueModeSnapshot>;
  transitionQueueMode(input: {
    expected: QueueModeSnapshot;
    next: Pick<QueueModeSnapshot, "mode" | "cause" | "updatedAt">;
  }): Promise<OperationalTransitionOutcome<QueueModeSnapshot>>;
  initializeClassHealth(input: {
    initial: Omit<ClassHealthSnapshot, "revision">;
  }): Promise<InitializeClassHealthOutcome>;
  getClassHealth(classId: string): Promise<ClassHealthSnapshot | null>;
  listClassHealth(): Promise<ClassHealthSnapshot[]>;
  transitionClassHealth(input: {
    expected: ClassHealthSnapshot;
    next: Pick<ClassHealthSnapshot, "updatedAt" | "source"> & {
      /** Reserve lanes are accounting-owned and cannot be overwritten here. */
      health: Readonly<Omit<FrozenClassHealth, "reserves">>;
    };
  }): Promise<OperationalTransitionOutcome<ClassHealthSnapshot>>;
  inspectAdjudicationLoad(input: {
    classId: string;
    windowStartsAt: Timestamp;
  }): Promise<AdjudicationLoadSnapshot>;
  refreshClassHealth(input: {
    expectedHealth: ClassHealthSnapshot;
    expectedLoad: AdjudicationLoadSnapshot;
    next: Pick<
      ClassHealthSnapshot,
      "updatedAt" | "source" | "adjudicationUnsafeSince"
    > & {
      /** Reserve lanes remain accounting-owned. */
      health: Readonly<Omit<FrozenClassHealth, "reserves">>;
    };
  }): Promise<
    | {
        kind: "applied" | "replayed";
        health: ClassHealthSnapshot;
        load: AdjudicationLoadSnapshot;
      }
    | {
        kind: "conflict";
        health: ClassHealthSnapshot;
        load: AdjudicationLoadSnapshot;
      }
  >;
  enterEmergencyHalt(input: {
    expectedQueue: QueueModeSnapshot;
    nextQueue: Omit<QueueModeSnapshot, "revision" | "mode"> & {
      mode: "emergency_halted";
    };
    expectedClassHealth: ClassHealthSnapshot[];
    nextClassHealth: Array<
      Omit<ClassHealthSnapshot, "revision" | "health"> & {
        /** Emergency state changes preserve accounting-owned reserve lanes. */
        health: Readonly<Omit<FrozenClassHealth, "reserves">> & {
          readonly operating: "emergency_halted";
        };
      }
    >;
    invalidations: Array<{
      scope: Extract<InvalidationScope, { kind: "class" }>;
      expectedTargets: InvalidationTarget[];
      requeuePlans: CycleRequeuePlan[];
    }>;
    at: Timestamp;
  }): Promise<
    | {
        kind: "applied";
        queue: QueueModeSnapshot;
        classHealth: ClassHealthSnapshot[];
        invalidations: AppliedInvalidationOutcome[];
      }
    | {
        kind: "conflict";
        queue: QueueModeSnapshot;
        classHealth: ClassHealthSnapshot[];
        invalidations: InvalidationSnapshot[];
      }
  >;
  getReservePolicy(input: {
    classId: string;
    contractVersion: string;
    lane: ReservePolicySnapshot["lane"];
  }): Promise<ReservePolicyRecord | null>;
  initializeReservePolicy(input: {
    policy: ReservePolicySnapshot;
    at: Timestamp;
  }): Promise<InitializeReservePolicyOutcome>;
  transitionReservePolicy(input: {
    expected: ReservePolicyRecord;
    next: ReservePolicySnapshot;
    at: Timestamp;
  }): Promise<TransitionReservePolicyOutcome>;
  chargeReserve(charge: ReserveCharge): Promise<ReserveChargeOutcome>;
  appendLedger(entry: LedgerEntry): Promise<AppendLedgerOutcome>;
  listLedger(input?: {
    classId?: string;
    kind?: string;
  }): Promise<LedgerEntry[]>;
  recordReputationEvidence(
    record: ReputationEvidenceRecord,
  ): Promise<ReputationEvidenceOutcome>;
  listReputationEvidence(
    workerId: WorkerId,
  ): Promise<ReputationEvidenceRecord[]>;
}
