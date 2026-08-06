import type {
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

export interface ReserveCharge {
  classId: string;
  lane: "lowCost" | "urgent" | "splitAndAdjudication" | "audit";
  week: string;
  chargeKey: string;
  workerIds: WorkerId[];
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
  extensionsUsed: number;
  snapshot: { maxResultBytes: number; maxPayloadBytes: number };
  open: boolean;
}

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
  putWorker(record: WorkerRecord): Promise<void>;
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
  }): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | null>;
  getPayload(payloadRef: string): Promise<CanonicalJsonValue | null>;
  claimLease(input: {
    workerId: WorkerId;
    classIds: string[];
    now: Timestamp;
  }): Promise<{ lease: LeaseRecord; job: JobRecord } | null>;
  getLease(leaseId: string): Promise<LeaseRecord | null>;
  extendLease(input: {
    workerId: WorkerId;
    leaseId: string;
    newExpiry: Timestamp;
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

  getClassHealth(classId: string): Promise<ClassHealth>;
  setClassHealth(classId: string, health: ClassHealth): Promise<void>;
  chargeReserve(charge: ReserveCharge): Promise<{
    ok: boolean;
    alreadyCharged: boolean;
  }>;
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
