import {
  canTransitionContract,
  canTransitionWorker,
  isWireId,
} from "@kuindji/muster-contract";
import type {
  ContractLifecycleState,
  Timestamp,
  WorkerId,
  WorkerState,
} from "@kuindji/muster-contract";

import type {
  AdmissionHook,
  ClassVersionRecord,
  Clock,
  EventSink,
  Store,
  WorkerControlPolicy,
  WorkerRecord,
  WorkerRoutingPeriod,
  WorkerRoutingSnapshot,
} from "./ports.js";
import type { RuntimeClassRegistry } from "./registration.js";

const validTimestamp = (value: string): value is Timestamp =>
  value.length > 0 && Number.isFinite(Date.parse(value));

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const uniqueStrings = (
  value: unknown,
  validate: (entry: string) => boolean = nonEmpty,
): value is string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && validate(entry)) &&
  new Set(value).size === value.length;

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const workerPolicyIssue = (policy: WorkerControlPolicy): string | null => {
  if (
    !Number.isSafeInteger(policy.probationCheckedSuccesses) ||
    policy.probationCheckedSuccesses <= 0
  ) {
    return "probation_success_count_invalid";
  }
  if (
    !Number.isFinite(policy.probationMinimumEnrollmentAge) ||
    policy.probationMinimumEnrollmentAge <= 0
  ) {
    return "probation_age_invalid";
  }
  return null;
};

const routingPeriodIssue = (period: unknown): string | null => {
  if (typeof period !== "object" || period === null || Array.isArray(period)) {
    return "routing_period_invalid";
  }
  const candidate = period as Partial<WorkerRoutingPeriod>;
  if (
    typeof candidate.contributionWindowId !== "string" ||
    !isWireId(candidate.contributionWindowId)
  ) return "contribution_window_invalid";
  if (
    typeof candidate.assignedSlotOccurrence !== "string" ||
    !isWireId(candidate.assignedSlotOccurrence)
  ) return "slot_occurrence_invalid";
  if (typeof candidate.slotOpen !== "boolean") return "slot_eligibility_invalid";
  return null;
};

export type ClassLifecycleTransitionResult =
  | {
      readonly ok: true;
      readonly kind: "applied" | "replayed";
      readonly record: ClassVersionRecord;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "not_found" | "state_conflict";
      readonly actual?: ContractLifecycleState;
      readonly reason?: string;
    };

export interface ClassLifecycleTransitionInput {
  readonly classId: string;
  readonly contractVersion: string;
  readonly from: ContractLifecycleState;
  readonly to: ContractLifecycleState;
  readonly acceptedUntil?: Timestamp;
  /** Stable command time may be supplied when replaying an interrupted call. */
  readonly at?: Timestamp;
}

export type ClassLeaseEligibility =
  | { readonly ok: true; readonly record: ClassVersionRecord }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "leasing_disabled"
        | "runtime_not_compatible";
      readonly record?: ClassVersionRecord;
    };

export type ClassResultAcceptance =
  | { readonly ok: true; readonly record: ClassVersionRecord }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "contract_not_accepting"
        | "contract_expired"
        | "runtime_not_compatible";
      readonly coordinatorFault: boolean;
      readonly record?: ClassVersionRecord;
    };

export interface PermitEpochTransitionInput {
  readonly classId: string;
  readonly fromEpoch: string | null;
  readonly toEpoch: string;
  readonly at?: Timestamp;
}

export type PermitEpochResult =
  | {
      readonly ok: true;
      readonly kind: "applied" | "replayed";
      readonly currentEpoch: string;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "conflict";
      readonly currentEpoch?: string | null;
      readonly reason?: string;
    };

export interface WorkerEnrollmentInput {
  readonly workerId: WorkerId;
  readonly declaredCapPerWeek: number;
  /** Trusted enrollment-probe results, never lease-time worker selectors. */
  readonly capabilities: WorkerRecord["capabilities"];
  readonly accountCluster: string;
  readonly contractVersion: string;
}

export type WorkerEnrollmentResult =
  | {
      readonly ok: true;
      readonly kind: "registered" | "replayed";
      readonly worker: WorkerRecord;
      readonly routing: WorkerRoutingSnapshot;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "admission_denied" | "conflict";
      readonly reason?: string;
      readonly existingWorker?: WorkerRecord;
      readonly existingRouting?: WorkerRoutingSnapshot;
    };

export type WorkerStateResult =
  | {
      readonly ok: true;
      readonly kind: "applied" | "replayed";
      readonly worker: WorkerRecord;
      readonly requeuedLeaseCount: number;
    }
  | {
      readonly ok: false;
      readonly kind:
        | "invalid"
        | "not_found"
        | "state_conflict"
        | "probation_incomplete";
      readonly actual?: WorkerState;
      readonly reason?: string;
      readonly checkedSuccesses?: number;
      readonly requiredCheckedSuccesses?: number;
      readonly enrollmentAge?: number;
      readonly requiredEnrollmentAge?: number;
    };

const enrollmentIssue = (input: WorkerEnrollmentInput): string | null => {
  if (!isWireId(input.workerId)) return "worker_id_invalid";
  if (
    !Number.isSafeInteger(input.declaredCapPerWeek) ||
    input.declaredCapPerWeek < 0
  ) {
    return "declared_cap_invalid";
  }
  if (!nonEmpty(input.capabilities.providerSurface)) return "provider_surface_invalid";
  if (typeof input.capabilities.unattendedScheduling !== "boolean") {
    return "unattended_scheduling_invalid";
  }
  if (!uniqueStrings(input.capabilities.languages)) return "languages_invalid";
  if (!uniqueStrings(input.capabilities.jobClassIds, isWireId)) {
    return "job_classes_invalid";
  }
  if (!isWireId(input.accountCluster)) return "account_cluster_invalid";
  if (!isWireId(input.contractVersion)) return "contract_version_invalid";
  return null;
};

const matchesEnrollment = (
  worker: WorkerRecord,
  input: WorkerEnrollmentInput,
): boolean =>
  worker.workerId === input.workerId &&
  worker.declaredCapPerWeek === input.declaredCapPerWeek &&
  worker.capabilities.providerSurface === input.capabilities.providerSurface &&
  worker.capabilities.unattendedScheduling ===
    input.capabilities.unattendedScheduling &&
  sameStrings(worker.capabilities.languages, input.capabilities.languages) &&
  sameStrings(worker.capabilities.jobClassIds, input.capabilities.jobClassIds) &&
  worker.accountCluster === input.accountCluster &&
  worker.contractAcceptance.contractVersion === input.contractVersion;

/** M2 Task-3 class, permit-epoch, and worker control plane. */
export class ControlPlaneService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly clock: Clock;
    readonly events: EventSink;
    readonly admission: AdmissionHook;
    readonly workerPolicy: WorkerControlPolicy;
    readonly registry: RuntimeClassRegistry;
  }) {}

  async transitionClassLifecycle(
    input: ClassLifecycleTransitionInput,
  ): Promise<ClassLifecycleTransitionResult> {
    if (!canTransitionContract(input.from, input.to)) {
      return { ok: false, kind: "invalid", reason: "transition_not_allowed" };
    }
    const at = input.at ?? this.options.clock.now();
    if (!validTimestamp(at)) {
      return { ok: false, kind: "invalid", reason: "timestamp_invalid" };
    }
    const current = await this.options.store.getClassVersion(
      input.classId,
      input.contractVersion,
    );
    if (current === null) return { ok: false, kind: "not_found" };
    if (input.to === "active" && current.state === input.from) {
      const compatibility = await this.options.registry.compatibility(
        this.options.store,
        input.classId,
        input.contractVersion,
      );
      if (!compatibility.ok) {
        return { ok: false, kind: "invalid", reason: "runtime_not_compatible" };
      }
    }
    if (input.to === "draining") {
      if (
        input.acceptedUntil === undefined ||
        !validTimestamp(input.acceptedUntil) ||
        Date.parse(input.acceptedUntil) < Date.parse(at)
      ) {
        return { ok: false, kind: "invalid", reason: "accepted_until_invalid" };
      }
    } else if (input.acceptedUntil !== undefined) {
      return { ok: false, kind: "invalid", reason: "accepted_until_unexpected" };
    }
    if (
      input.to === "retired" &&
      current.state === input.from &&
      (
        current.acceptedUntil === undefined ||
        Date.parse(at) <= Date.parse(current.acceptedUntil)
      )
    ) {
      return {
        ok: false,
        kind: "invalid",
        reason: "accepted_until_not_reached",
      };
    }

    const outcome = await this.options.store.transitionClassVersion({
      classId: input.classId,
      contractVersion: input.contractVersion,
      from: input.from,
      to: input.to,
      at,
      ...(input.to === "draining"
        ? { leaseDisabledAt: at, acceptedUntil: input.acceptedUntil }
        : {}),
    });
    if (outcome.kind === "not_found") return { ok: false, kind: "not_found" };
    if (outcome.kind === "state_conflict") {
      if (outcome.actual === input.to) {
        const current = await this.options.store.getClassVersion(
          input.classId,
          input.contractVersion,
        );
        if (
          current !== null &&
          (input.to !== "draining" || current.acceptedUntil === input.acceptedUntil)
        ) {
          if (input.to === "retired") {
            this.options.registry.unload(input.classId, input.contractVersion);
          }
          return { ok: true, kind: "replayed", record: current };
        }
      }
      return { ok: false, kind: "state_conflict", actual: outcome.actual };
    }
    if (input.to === "retired") {
      this.options.registry.unload(input.classId, input.contractVersion);
    }
    if (outcome.kind === "applied") {
      this.options.events.emit({
        type: "contract_transition",
        at,
        classId: input.classId,
        contractVersion: input.contractVersion,
        from: input.from,
        to: input.to,
        ...(input.to === "draining"
          ? {
              detail: {
                leaseDisabledAt: at,
                acceptedUntil: input.acceptedUntil!,
              },
            }
          : {}),
      });
    }
    return { ok: true, kind: outcome.kind, record: outcome.record };
  }

  async leaseEligibility(
    classId: string,
    contractVersion: string,
  ): Promise<ClassLeaseEligibility> {
    const record = await this.options.store.getClassVersion(classId, contractVersion);
    if (record === null) return { ok: false, reason: "not_found" };
    if (record.state !== "active") {
      return { ok: false, reason: "leasing_disabled", record };
    }
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      classId,
      contractVersion,
    );
    return compatibility.ok
      ? { ok: true, record }
      : { ok: false, reason: "runtime_not_compatible", record };
  }

  async resultAcceptance(
    classId: string,
    contractVersion: string,
    at: Timestamp = this.options.clock.now(),
  ): Promise<ClassResultAcceptance> {
    const record = await this.options.store.getClassVersion(classId, contractVersion);
    if (record === null) {
      return { ok: false, reason: "not_found", coordinatorFault: false };
    }
    const withinLifecycle = record.state === "active" ||
      (
        record.state === "draining" &&
        record.acceptedUntil !== undefined &&
        Date.parse(at) <= Date.parse(record.acceptedUntil)
      );
    if (withinLifecycle) {
      const compatibility = await this.options.registry.compatibility(
        this.options.store,
        classId,
        contractVersion,
      );
      return compatibility.ok
        ? { ok: true, record }
        : {
            ok: false,
            reason: "runtime_not_compatible",
            coordinatorFault: true,
            record,
          };
    }
    if (record.state === "draining" || record.state === "retired") {
      return {
        ok: false,
        reason: "contract_expired",
        coordinatorFault: true,
        record,
      };
    }
    return {
      ok: false,
      reason: "contract_not_accepting",
      coordinatorFault: false,
      record,
    };
  }

  async transitionPermitEpoch(
    input: PermitEpochTransitionInput,
  ): Promise<PermitEpochResult> {
    const at = input.at ?? this.options.clock.now();
    if (
      !isWireId(input.classId) ||
      !isWireId(input.toEpoch) ||
      (input.fromEpoch !== null && !isWireId(input.fromEpoch)) ||
      input.toEpoch === input.fromEpoch ||
      !validTimestamp(at)
    ) {
      return { ok: false, kind: "invalid", reason: "epoch_transition_invalid" };
    }
    if (await this.options.store.getClassHealth(input.classId) === null) {
      return { ok: false, kind: "invalid", reason: "class_not_registered" };
    }
    const outcome = await this.options.store.transitionPermitEpoch({ ...input, at });
    if (outcome.kind === "conflict") {
      return {
        ok: false,
        kind: "conflict",
        currentEpoch: outcome.currentEpoch,
      };
    }
    if (outcome.kind === "applied") {
      this.options.events.emit({
        type: "permit_epoch_change",
        at,
        classId: input.classId,
        fromEpoch: input.fromEpoch,
        toEpoch: input.toEpoch,
        emergency: false,
      });
    }
    return {
      ok: true,
      kind: outcome.kind,
      currentEpoch: outcome.currentEpoch,
    };
  }

  async enrollWorker(
    input: WorkerEnrollmentInput,
  ): Promise<WorkerEnrollmentResult> {
    const invalid = enrollmentIssue(input) ?? workerPolicyIssue(this.options.workerPolicy);
    if (invalid !== null) return { ok: false, kind: "invalid", reason: invalid };

    const existing = await this.options.store.getWorker(input.workerId);
    if (existing !== null) {
      const routing = await this.options.store.getWorkerRoutingSnapshot(input.workerId);
      if (routing === null) throw new Error(`worker ${input.workerId} has no routing snapshot`);
      return matchesEnrollment(existing, input)
        ? { ok: true, kind: "replayed", worker: existing, routing }
        : {
            ok: false,
            kind: "conflict",
            existingWorker: existing,
            existingRouting: routing,
          };
    }

    const at = this.options.clock.now();
    if (!validTimestamp(at)) {
      return { ok: false, kind: "invalid", reason: "timestamp_invalid" };
    }
    const decision = await this.options.admission.admit({
      workerId: input.workerId,
      declaredCapPerWeek: input.declaredCapPerWeek,
    });
    if (!decision.admit) {
      this.options.events.emit({
        type: "enrollment",
        at,
        workerId: input.workerId,
        providerSurface: input.capabilities.providerSurface,
        outcome: "refused",
        contractVersion: input.contractVersion,
      });
      return {
        ok: false,
        kind: "admission_denied",
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      };
    }

    let slot: number;
    let period: unknown;
    try {
      slot = this.options.workerPolicy.assignSlot({
        workerId: input.workerId,
        enrolledAt: at,
      });
      period = this.options.workerPolicy.routingAt({
        workerId: input.workerId,
        slot,
        at,
      });
    } catch {
      return { ok: false, kind: "invalid", reason: "worker_policy_threw" };
    }
    if (!Number.isSafeInteger(slot) || slot < 0) {
      return { ok: false, kind: "invalid", reason: "slot_invalid" };
    }
    const periodInvalid = routingPeriodIssue(period);
    if (periodInvalid !== null) {
      return { ok: false, kind: "invalid", reason: periodInvalid };
    }

    const validPeriod = period as WorkerRoutingPeriod;
    const outcome = await this.options.store.registerWorker({
      worker: {
        workerId: input.workerId,
        state: "enrolled",
        enrolledAt: at,
        declaredCapPerWeek: input.declaredCapPerWeek,
        capabilities: {
          providerSurface: input.capabilities.providerSurface,
          unattendedScheduling: input.capabilities.unattendedScheduling,
          languages: [...input.capabilities.languages],
          jobClassIds: [...input.capabilities.jobClassIds],
        },
        accountCluster: input.accountCluster,
        slot,
        contractAcceptance: { contractVersion: input.contractVersion, acceptedAt: at },
      },
      routing: {
        contributionWindowId: validPeriod.contributionWindowId,
        contributionUsed: 0,
        assignedSlotOccurrence: validPeriod.assignedSlotOccurrence,
      },
    });
    if (outcome.kind === "conflict") {
      return {
        ok: false,
        kind: "conflict",
        existingWorker: outcome.existingWorker,
        existingRouting: outcome.existingRouting,
      };
    }
    if (outcome.kind === "registered") {
      this.options.events.emit({
        type: "enrollment",
        at,
        workerId: outcome.worker.workerId,
        providerSurface: outcome.worker.capabilities.providerSurface,
        outcome: "enrolled",
        contractVersion: outcome.worker.contractAcceptance.contractVersion,
      });
    }
    return {
      ok: true,
      kind: outcome.kind,
      worker: outcome.worker,
      routing: outcome.routing,
    };
  }

  async promoteWorker(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    const policyInvalid = workerPolicyIssue(this.options.workerPolicy);
    if (policyInvalid !== null) {
      return { ok: false, kind: "invalid", reason: policyInvalid };
    }
    const worker = await this.options.store.getWorker(workerId);
    if (worker === null) return { ok: false, kind: "not_found" };
    if (worker.state === "active") {
      return {
        ok: true,
        kind: "replayed",
        worker,
        requeuedLeaseCount: 0,
      };
    }
    if (worker.state !== "enrolled" && worker.state !== "paused") {
      return { ok: false, kind: "state_conflict", actual: worker.state };
    }
    if (!validTimestamp(at)) {
      return { ok: false, kind: "invalid", reason: "timestamp_invalid" };
    }
    const evidence = await this.options.store.listReputationEvidence(workerId);
    const checkedSuccesses = evidence.filter((record) =>
      record.source === "checked_success" &&
      Date.parse(record.at) >= Date.parse(worker.enrolledAt) &&
      Date.parse(record.at) <= Date.parse(at)
    ).length;
    const enrollmentAge = (Date.parse(at) - Date.parse(worker.enrolledAt)) / 1_000;
    if (
      checkedSuccesses < this.options.workerPolicy.probationCheckedSuccesses ||
      enrollmentAge < this.options.workerPolicy.probationMinimumEnrollmentAge
    ) {
      return {
        ok: false,
        kind: "probation_incomplete",
        checkedSuccesses,
        requiredCheckedSuccesses:
          this.options.workerPolicy.probationCheckedSuccesses,
        enrollmentAge,
        requiredEnrollmentAge:
          this.options.workerPolicy.probationMinimumEnrollmentAge,
      };
    }
    return this.applyWorkerTransition(worker, "active", at);
  }

  async setWorkerAvailability(
    workerId: WorkerId,
    to: "active" | "maintenance",
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    const worker = await this.options.store.getWorker(workerId);
    if (worker === null) return { ok: false, kind: "not_found" };
    if (worker.state === to) {
      return { ok: true, kind: "replayed", worker, requeuedLeaseCount: 0 };
    }
    const from = to === "maintenance" ? "active" : "maintenance";
    if (worker.state !== from) {
      return { ok: false, kind: "state_conflict", actual: worker.state };
    }
    return this.applyWorkerTransition(worker, to, at);
  }

  async pauseWorker(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    return this.transitionWorkerTo(workerId, "paused", at);
  }

  async resumeWorker(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    return this.promoteWorker(workerId, at);
  }

  async suspendWorker(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    return this.transitionWorkerTo(workerId, "suspended", at);
  }

  async revokeWorker(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStateResult> {
    return this.transitionWorkerTo(workerId, "revoked", at);
  }

  private async transitionWorkerTo(
    workerId: WorkerId,
    to: WorkerState,
    at: Timestamp,
  ): Promise<WorkerStateResult> {
    const worker = await this.options.store.getWorker(workerId);
    if (worker === null) return { ok: false, kind: "not_found" };
    if (worker.state === to) {
      return { ok: true, kind: "replayed", worker, requeuedLeaseCount: 0 };
    }
    if (!canTransitionWorker(worker.state, to)) {
      return { ok: false, kind: "state_conflict", actual: worker.state };
    }
    return this.applyWorkerTransition(worker, to, at);
  }

  private async applyWorkerTransition(
    worker: WorkerRecord,
    to: WorkerState,
    at: Timestamp,
  ): Promise<WorkerStateResult> {
    if (!validTimestamp(at)) {
      return { ok: false, kind: "invalid", reason: "timestamp_invalid" };
    }
    if (!canTransitionWorker(worker.state, to)) {
      return { ok: false, kind: "state_conflict", actual: worker.state };
    }
    const outcome = await this.options.store.transitionWorkerState({
      workerId: worker.workerId,
      from: worker.state,
      to,
      at,
    });
    if (outcome.kind === "not_found") return { ok: false, kind: "not_found" };
    if (outcome.kind === "state_conflict") {
      return { ok: false, kind: "state_conflict", actual: outcome.actual };
    }
    if (outcome.kind === "applied") {
      this.options.events.emit({
        type: "state_change",
        at,
        subjectKind: "worker",
        workerId: worker.workerId,
        from: worker.state,
        to,
      });
      if (to === "suspended" || to === "revoked") {
        const reason = to === "suspended"
          ? "worker_suspended" as const
          : "worker_revoked" as const;
        for (const lease of outcome.requeuedOpenLeases) {
          this.options.events.emit({
            type: "lease_requeue",
            at,
            classId: lease.classId,
            jobId: lease.jobId,
            collectionCycle: lease.collectionCycle,
            leaseId: lease.leaseId,
            workerId: worker.workerId,
            providerSurface: outcome.worker.capabilities.providerSurface,
            contractVersion: lease.contractVersion,
            permitEpoch: lease.permitEpoch,
            reason,
          });
        }
      }
    }
    return {
      ok: true,
      kind: outcome.kind,
      worker: outcome.worker,
      requeuedLeaseCount: outcome.requeuedOpenLeases.length,
    };
  }
}
