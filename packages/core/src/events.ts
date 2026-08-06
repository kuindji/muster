import {
  deepFreeze,
  type AuthorizationDenialReason,
  type AuthorizationInvalidationReason,
  type AuthorizationRequestState,
  type CanonicalJsonValue,
  type ClassHealth,
  type ResultAdjudicationRequestState,
  type ResultState,
  type Timestamp,
  type WorkerId,
  type WorkerState,
  type WorkerWireErrorCode,
} from "@kuindji/muster-contract";

export const NOTIFICATION_TYPES = deepFreeze([
  "suspicion", "split", "escalation", "low_cost_uncovered", "urgent_uncovered",
  "backpressure", "pool_offline", "contract_mismatch", "class_health_changed",
  "diversity_shortfall", "result_adjudication_requested", "action_adjudication_requested",
  "adjudication_uncovered", "audit_uncovered", "dispute_requeue_exhausted",
] as const);

export const AUDIT_EVENT_TYPES = deepFreeze([
  "enrollment", "lease", "lease_extend", "submit", "verdict", "gate_decision",
  "escalation_charge", "adjudication", "state_change", "permit_epoch_change",
  "contract_transition", "authorization_validity_change",
] as const);

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

interface Base<T extends string> {
  type: T;
  at: Timestamp;
}

interface ClassScoped<T extends string> extends Base<T> {
  classId: string;
}

interface JobCycleScoped<T extends string> extends ClassScoped<T> {
  jobId: string;
  collectionCycle: number;
}

/** Spec revision 14 section 7 consumer events; wire names remain unchanged. */
export type MusterNotification =
  | (ClassScoped<"suspicion"> & { workerId: WorkerId; signal: string })
  | (JobCycleScoped<"split"> & { equivalenceKeyCount: number })
  | (JobCycleScoped<"escalation"> & {
      lane: "lowCost" | "urgent" | "splitAndAdjudication";
    })
  | JobCycleScoped<"low_cost_uncovered">
  | (ClassScoped<"urgent_uncovered"> & {
      jobId?: string;
      collectionCycle?: number;
    })
  | Base<"backpressure">
  | Base<"pool_offline">
  | (JobCycleScoped<"contract_mismatch"> & { workerId: WorkerId })
  | (ClassScoped<"class_health_changed"> & { health: ClassHealth })
  | (JobCycleScoped<"diversity_shortfall"> & { axis: string })
  | (JobCycleScoped<"result_adjudication_requested"> & {
      resultAdjudicationRequestId: string;
    })
  | (JobCycleScoped<"action_adjudication_requested"> & {
      authorizationRequestId: string;
    })
  | ClassScoped<"adjudication_uncovered">
  | ClassScoped<"audit_uncovered">
  | JobCycleScoped<"dispute_requeue_exhausted">;

/** Honest lease identity for worker-wire refusals, including unknown IDs. */
export type AuditLeaseIdentity =
  | {
      resolved: true;
      classId: string;
      jobId: string;
      collectionCycle: number;
      contractVersion: string;
    }
  | { resolved: false };

/** Spec section 7 append-only audit events. */
export type MusterAuditEvent =
  | (Base<"enrollment"> & {
      workerId: WorkerId;
      providerSurface: string;
      outcome: "enrolled" | "refused";
      contractVersion: string;
    })
  | (JobCycleScoped<"lease"> & {
      leaseId: string;
      workerId: WorkerId;
      providerSurface: string;
      contractVersion: string;
      permitEpoch: string;
      canary: boolean;
    })
  | (Base<"lease_extend"> &
      { leaseId: string; workerId: WorkerId } &
      (
        | {
            outcome: "extended";
            classId: string;
            jobId: string;
            collectionCycle: number;
          }
        | { outcome: "refused"; lease: AuditLeaseIdentity }
      ))
  | (Base<"submit"> &
      { leaseId: string; workerId: WorkerId } &
      (
        | {
            outcome: "accepted" | "replayed";
            resultHash: string;
            classId: string;
            jobId: string;
            collectionCycle: number;
            contractVersion: string;
          }
        | {
            outcome: "rejected";
            errorCode: WorkerWireErrorCode;
            lease: AuditLeaseIdentity;
          }
      ))
  | (JobCycleScoped<"verdict"> & {
      requestId: string;
      verdictHash: string;
      adjudicatorId: string;
      contractVersion: string;
      kind: "result" | "action";
      outcome: "applied" | "replayed" | "conflict" | "terminal";
    })
  | (JobCycleScoped<"gate_decision"> &
      {
        authorizationRequestId: string;
        contractVersion: string;
        permitEpoch: string;
      } &
      (
        | { outcome: "authorized" | "pending_adjudication" }
        | { outcome: "denied"; denialReason: AuthorizationDenialReason }
      ))
  | (ClassScoped<"escalation_charge"> & {
      lane: "lowCost" | "urgent" | "splitAndAdjudication" | "audit";
      chargeKey: string;
      workerIds: WorkerId[];
      outcome: "charged" | "denied";
    })
  | (JobCycleScoped<"adjudication"> & {
      requestId: string;
      contractVersion: string;
      kind: "result" | "action";
      transition: ResultAdjudicationRequestState | AuthorizationRequestState;
    })
  | (Base<"state_change"> & {
      subjectKind: "worker";
      workerId: WorkerId;
      from: WorkerState;
      to: WorkerState;
    })
  | (JobCycleScoped<"state_change"> & {
      subjectKind: "result";
      contractVersion: string;
      from: ResultState;
      to: ResultState;
    })
  | (JobCycleScoped<"state_change"> & {
      subjectKind: "authorization_request";
      authorizationRequestId: string;
      from: AuthorizationRequestState;
      to: AuthorizationRequestState;
    })
  | (ClassScoped<"permit_epoch_change"> & {
      fromEpoch: string | null;
      toEpoch: string;
      emergency: boolean;
    })
  | (JobCycleScoped<"authorization_validity_change"> & {
      authorizationRequestId: string;
      from: "valid";
      to: "invalid";
      reason: AuthorizationInvalidationReason;
    })
  | (ClassScoped<"contract_transition"> & {
      contractVersion: string;
      from: string;
      to: string;
      detail?: CanonicalJsonValue;
    });

export type MusterEvent = MusterNotification | MusterAuditEvent;
