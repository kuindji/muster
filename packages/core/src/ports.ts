import type {
  ActionAdjudicationRequest,
  ActionAdjudicationVerdict,
  ActionAuthorization,
  AdjudicationCapacity,
  AuthorizationDenialReason,
  AuthorizationInitialReceipt,
  AuthorizationInvalidationReason,
  AuthorizationStatus,
  AutomaticVerificationStrength,
  CanonicalJsonValue,
  ClassHealth,
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

  invalidateResultScope(input: {
    scope:
      | { jobCycles: Array<{ jobId: string; collectionCycle: number }> }
      | { decisionResultHashes: string[] }
      | { permitEpoch: string }
      | { contractVersion: string };
    reason: AuthorizationInvalidationReason;
    startNewCycle?: {
      permitEpoch: string;
      inputHash: string;
      cycleStartedAt: Timestamp;
    };
    at: Timestamp;
  }): Promise<void>;

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
  ): Promise<ResultAdjudicationRequest[]>;
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
  ): Promise<ActionAdjudicationRequest[]>;
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
}
