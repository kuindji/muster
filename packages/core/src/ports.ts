import { deepFreeze } from "@kuindji/muster-contract";
import type {
  DiversityAxis,
  ActionAdjudicationRequest,
  ActionAdjudicationVerdict,
  ActionAuthorization,
  AdjudicationCapacity,
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

export interface ReserveCharge {
  chargeKey: string;
  workerIds: WorkerId[];
  policy: ReservePolicySnapshot;
}

export type ReserveChargeOutcome =
  | { kind: "charged" }
  | { kind: "replayed" }
  | { kind: "exhausted" }
  | {
      kind: "policy_conflict";
      currentPolicyVersion: string;
      currentWindowId: string;
    };

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
}

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
  | { kind: "applied"; record: ClassVersionRecord }
  | { kind: "replayed"; record: ClassVersionRecord }
  | { kind: "state_conflict"; actual: ContractLifecycleState }
  | { kind: "not_found" };

export interface RequeuedLeaseIdentity {
  leaseId: string;
  classId: string;
  jobId: string;
  collectionCycle: number;
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
  | { kind: "refused"; error: "lease_not_held" };

export type AuthorizeIntentOutcome =
  | {
      kind: "applied";
      initialReceipt: AuthorizationInitialReceipt;
      chargeOk?: boolean;
    }
  | { kind: "replayed"; initialReceipt: AuthorizationInitialReceipt }
  | { kind: "conflict" };

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
  | { kind: "terminal" };

export type OpenAdjudicationOutcome =
  | { kind: "opened_charged" }
  | { kind: "opened_uncovered" }
  | { kind: "replayed" }
  | { kind: "state_conflict"; actual: ResultState };

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
  }): Promise<ClaimLeaseOutcome>;
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
  }): Promise<SubmitOutcome>;
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

  authorizeOrReplayIntent(input: {
    authorizationRequestId: string;
    effectIntent: EffectIntent;
    effectIntentHash: string;
    decisionResultHash: string;
    decision:
      | {
          kind: "authorize";
          authorization: ActionAuthorization;
          charge?: ReserveCharge;
        }
      | { kind: "deny"; reason: AuthorizationDenialReason }
      | {
          kind: "pend";
          request: ActionAdjudicationRequest;
          charge?: ReserveCharge;
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
  listPendingResultAdjudications(
    classId: string,
  ): Promise<Array<PendingAdjudication<ResultAdjudicationRequest>>>;
  applyResultAdjudicationVerdict(input: {
    verdict: ResultAdjudicationVerdict;
    verdictHash: string;
    at: Timestamp;
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
  listPendingActionAdjudications(
    classId: string,
  ): Promise<Array<PendingAdjudication<ActionAdjudicationRequest>>>;
  applyActionAdjudicationVerdict(input: {
    verdict: ActionAdjudicationVerdict;
    verdictHash: string;
    at: Timestamp;
  } & (
    | { decision: "approve"; authorization: ActionAuthorization }
    | { decision: "reject" }
  )): Promise<VerdictOutcome>;

  getQueueMode(): Promise<QueueModeSnapshot>;
  transitionQueueMode(input: {
    expected: QueueModeSnapshot;
    next: Pick<QueueModeSnapshot, "mode" | "updatedAt">;
  }): Promise<OperationalTransitionOutcome<QueueModeSnapshot>>;
  initializeClassHealth(input: {
    initial: Omit<ClassHealthSnapshot, "revision">;
  }): Promise<InitializeClassHealthOutcome>;
  getClassHealth(classId: string): Promise<ClassHealthSnapshot | null>;
  transitionClassHealth(input: {
    expected: ClassHealthSnapshot;
    next: Pick<
      ClassHealthSnapshot,
      "health" | "updatedAt" | "source"
    >;
  }): Promise<OperationalTransitionOutcome<ClassHealthSnapshot>>;
  enterEmergencyHalt(input: {
    expectedQueue: QueueModeSnapshot;
    nextQueue: Omit<QueueModeSnapshot, "revision" | "mode"> & {
      mode: "emergency_halted";
    };
    expectedClassHealth: ClassHealthSnapshot[];
    nextClassHealth: Array<
      Omit<ClassHealthSnapshot, "revision" | "health"> & {
        health: FrozenClassHealth & {
          readonly operating: "emergency_halted";
        };
      }
    >;
    invalidation: {
      scope: InvalidationScope;
      expectedTargets: InvalidationTarget[];
      requeuePlans: CycleRequeuePlan[];
    };
    at: Timestamp;
  }): Promise<
    | {
        kind: "applied";
        queue: QueueModeSnapshot;
        classHealth: ClassHealthSnapshot[];
        invalidation: AppliedInvalidationOutcome;
      }
    | {
        kind: "conflict";
        queue: QueueModeSnapshot;
        classHealth: ClassHealthSnapshot[];
        invalidation: InvalidationSnapshot;
      }
  >;
  chargeReserve(charge: ReserveCharge): Promise<ReserveChargeOutcome>;
  appendLedger(entry: {
    at: Timestamp;
    kind: string;
    detail: CanonicalJsonValue;
  }): Promise<void>;
  recordReputationEvidence(
    record: ReputationEvidenceRecord,
  ): Promise<ReputationEvidenceOutcome>;
  listReputationEvidence(
    workerId: WorkerId,
  ): Promise<ReputationEvidenceRecord[]>;
}
