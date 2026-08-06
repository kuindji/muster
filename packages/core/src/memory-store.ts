import {
  INVALIDATION_RESULT_TARGET,
  type AuthorizationInvalidationReason,
  type CanonicalJsonValue,
  type ResultState,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";

import type {
  AppliedInvalidationOutcome,
  ClassHealthSnapshot,
  ClassVersionRecord,
  ClaimLeaseOutcome,
  ContractTransitionOutcome,
  CycleRequeuePlan,
  DecisionResultRecord,
  EnqueueOutcome,
  InitializeClassHealthOutcome,
  InvalidationOutcome,
  InvalidationScope,
  InvalidationSnapshot,
  InvalidationTarget,
  JobCycleAttemptSnapshot,
  JobRecord,
  LeaseCandidateSnapshot,
  LeaseRecord,
  OperationalStateExpectation,
  OperationalTransitionOutcome,
  PermitEpochTransition,
  PermitEpochTransitionOutcome,
  QueueModeSnapshot,
  RegisterClassVersionOutcome,
  RegisterWorkerOutcome,
  Store,
  TransitionOutcome,
  WorkerRecord,
  WorkerRegistration,
  WorkerRoutingSnapshot,
  WorkerRoutingTransitionOutcome,
  WorkerStateTransitionOutcome,
  CoreIdentityKind,
} from "./ports.js";

export interface InMemoryStoreOptions {
  /** Explicit deployment bootstrap; the reference Store never invents it. */
  readonly initialQueue: Pick<QueueModeSnapshot, "mode" | "updatedAt">;
}

export class StoreOperationNotImplementedError extends Error {
  constructor(readonly operation: keyof Store) {
    super(`${String(operation)} is scheduled for a later M2 task`);
    this.name = "StoreOperationNotImplementedError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);

const normalized = (value: unknown): unknown => {
  if (value === undefined) return { __musterUndefined: true };
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value;
};

const fingerprint = (value: unknown): string => JSON.stringify(normalized(value));
const equal = (left: unknown, right: unknown): boolean =>
  fingerprint(left) === fingerprint(right);

const pairKey = (left: string, right: string): string =>
  JSON.stringify([left, right]);
const cycleKey = (jobId: string, collectionCycle: number): string =>
  JSON.stringify([jobId, collectionCycle]);

const sortTargets = (targets: readonly InvalidationTarget[]): InvalidationTarget[] =>
  [...clone(targets)].sort((left, right) =>
    left.jobId.localeCompare(right.jobId) ||
    left.collectionCycle - right.collectionCycle,
  );

/**
 * Reference adapter for the frozen Store boundary.
 *
 * Every public operation is serialized through one promise tail. Reads and
 * writes therefore observe whole commands, even if later M2 tasks add awaits
 * inside an operation. All records cross the boundary through structured
 * clones so callers cannot mutate durable state by alias.
 */
export class InMemoryStore implements Store {
  private serialTail: Promise<void> = Promise.resolve();

  private workers = new Map<WorkerId, WorkerRecord>();
  private workerRouting = new Map<WorkerId, WorkerRoutingSnapshot>();
  private classVersions = new Map<string, ClassVersionRecord>();
  private permitEpochs = new Map<string, string>();
  private queue!: QueueModeSnapshot;
  private classHealth = new Map<string, ClassHealthSnapshot>();

  private jobs = new Map<string, JobRecord>();
  private jobCycles = new Map<string, JobRecord>();
  private payloads = new Map<string, CanonicalJsonValue>();
  private candidateRevisions = new Map<string, number>();
  private attempts = new Map<string, JobCycleAttemptSnapshot>();
  private leases = new Map<string, LeaseRecord>();
  private coreIdentities = new Map<string, CoreIdentityKind>();
  private resultStates = new Map<string, ResultState>();
  private decisions = new Map<string, DecisionResultRecord>();

  private classTransitionHistory = new Map<string, ContractTransitionOutcome>();
  private permitTransitionHistory = new Map<string, PermitEpochTransitionOutcome>();
  private workerTransitionHistory = new Map<string, WorkerStateTransitionOutcome>();
  private workerRegistrationHistory = new Map<
    WorkerId,
    { input: string; worker: WorkerRecord; routing: WorkerRoutingSnapshot }
  >();
  private workerRoutingHistory = new Map<string, WorkerRoutingTransitionOutcome>();
  private queueTransitionHistory = new Map<
    string,
    OperationalTransitionOutcome<QueueModeSnapshot>
  >();
  private healthInitialization = new Map<string, string>();
  private healthTransitionHistory = new Map<
    string,
    OperationalTransitionOutcome<ClassHealthSnapshot>
  >();
  private enqueueHistory = new Map<string, EnqueueOutcome>();
  private claimHistory = new Map<string, ClaimLeaseOutcome>();
  private invalidationHistory = new Map<string, InvalidationOutcome>();
  private emergencyHistory = new Map<
    string,
    Awaited<ReturnType<Store["enterEmergencyHalt"]>>
  >();

  constructor(options: InMemoryStoreOptions) {
    this.initialize(options);
  }

  /** Deterministic test/setup reset, serialized with every other command. */
  reset(options: InMemoryStoreOptions): Promise<void> {
    return this.atomicInput(options, (captured) => this.initialize(captured));
  }

  private initialize(options: InMemoryStoreOptions): void {
    this.workers.clear();
    this.workerRouting.clear();
    this.classVersions.clear();
    this.permitEpochs.clear();
    this.classHealth.clear();
    this.jobs.clear();
    this.jobCycles.clear();
    this.payloads.clear();
    this.candidateRevisions.clear();
    this.attempts.clear();
    this.leases.clear();
    this.coreIdentities.clear();
    this.resultStates.clear();
    this.decisions.clear();
    this.classTransitionHistory.clear();
    this.permitTransitionHistory.clear();
    this.workerTransitionHistory.clear();
    this.workerRegistrationHistory.clear();
    this.workerRoutingHistory.clear();
    this.queueTransitionHistory.clear();
    this.healthInitialization.clear();
    this.healthTransitionHistory.clear();
    this.enqueueHistory.clear();
    this.claimHistory.clear();
    this.invalidationHistory.clear();
    this.emergencyHistory.clear();
    this.queue = {
      revision: 1,
      mode: options.initialQueue.mode,
      updatedAt: options.initialQueue.updatedAt,
    };
  }

  private atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.serialTail.then(operation, operation);
    this.serialTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private atomicInput<Input, Output>(
    input: Input,
    operation: (captured: Input) => Output | Promise<Output>,
  ): Promise<Output> {
    const captured = clone(input);
    return this.atomic(() => operation(captured));
  }

  private unsupported<T>(operation: keyof Store): Promise<T> {
    return Promise.reject(new StoreOperationNotImplementedError(operation));
  }

  getWorker(workerId: WorkerId): Promise<WorkerRecord | null> {
    return this.atomic(() => clone(this.workers.get(workerId) ?? null));
  }

  registerWorker(registration: WorkerRegistration): Promise<RegisterWorkerOutcome> {
    return this.atomicInput(registration, (registration) => {
      const workerId = registration.worker.workerId;
      const existingWorker = this.workers.get(workerId);
      const existingRouting = this.workerRouting.get(workerId);
      if (existingWorker !== undefined || existingRouting !== undefined) {
        if (existingWorker === undefined || existingRouting === undefined) {
          throw new Error(`corrupt worker registration for ${workerId}`);
        }
        const registered = this.workerRegistrationHistory.get(workerId);
        if (registered?.input === fingerprint(registration)) {
          return clone({
            kind: "replayed",
            worker: existingWorker,
            routing: existingRouting,
          });
        }
        return clone({
          kind: "conflict",
          existingWorker,
          existingRouting,
        });
      }

      const worker = clone(registration.worker);
      const routing: WorkerRoutingSnapshot = {
        revision: 1,
        workerId,
        contributionWindowId: registration.routing.contributionWindowId,
        contributionUsed: 0,
        assignedSlotOccurrence: registration.routing.assignedSlotOccurrence,
        openLeaseIds: [],
      };
      this.workers.set(workerId, worker);
      this.workerRouting.set(workerId, routing);
      const outcome: RegisterWorkerOutcome = {
        kind: "registered",
        worker,
        routing,
      };
      this.workerRegistrationHistory.set(workerId, {
        input: fingerprint(registration),
        worker: clone(worker),
        routing: clone(routing),
      });
      return clone(outcome);
    });
  }

  transitionWorkerState(
    input: Parameters<Store["transitionWorkerState"]>[0],
  ): Promise<WorkerStateTransitionOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.workerTransitionHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }

      const worker = this.workers.get(input.workerId);
      if (worker === undefined) return { kind: "not_found" };
      if (worker.state !== input.from) {
        return { kind: "state_conflict", actual: worker.state };
      }
      const routing = this.workerRouting.get(input.workerId);
      if (routing === undefined) {
        throw new Error(`worker ${input.workerId} has no routing snapshot`);
      }

      const requeuedOpenLeases = [];
      const closesLeases = input.to === "suspended" || input.to === "revoked";
      if (closesLeases) {
        for (const leaseId of routing.openLeaseIds) {
          const lease = this.leases.get(leaseId);
          if (lease === undefined || !lease.open) continue;
          lease.open = false;
          this.leases.set(leaseId, lease);
          const key = cycleKey(lease.jobId, lease.collectionCycle);
          const attempt = this.attempts.get(key);
          if (attempt !== undefined) {
            this.attempts.set(key, {
              ...attempt,
              openLeaseIds: attempt.openLeaseIds.filter((id) => id !== leaseId),
            });
          }
          this.candidateRevisions.set(
            key,
            (this.candidateRevisions.get(key) ?? 0) + 1,
          );
          requeuedOpenLeases.push({
            leaseId,
            classId: lease.classId,
            jobId: lease.jobId,
            collectionCycle: lease.collectionCycle,
          });
        }
      }

      const nextWorker: WorkerRecord = { ...worker, state: input.to };
      const nextRouting: WorkerRoutingSnapshot = {
        ...routing,
        revision: routing.revision + 1,
        openLeaseIds: closesLeases ? [] : [...routing.openLeaseIds],
      };
      this.workers.set(input.workerId, nextWorker);
      this.workerRouting.set(input.workerId, nextRouting);
      const outcome: WorkerStateTransitionOutcome = {
        kind: "applied",
        worker: nextWorker,
        requeuedOpenLeases,
      };
      this.workerTransitionHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  registerClassVersion(
    registration: Parameters<Store["registerClassVersion"]>[0],
  ): Promise<RegisterClassVersionOutcome> {
    return this.atomicInput(registration, (registration) => {
      const key = pairKey(registration.classId, registration.contractVersion);
      const existing = this.classVersions.get(key);
      if (existing !== undefined) {
        if (
          existing.payloadSchemaHash === registration.payloadSchemaHash &&
          existing.outputSchemaHash === registration.outputSchemaHash &&
          existing.registeredAt === registration.registeredAt
        ) {
          return clone({ kind: "replayed", record: existing });
        }
        return clone({ kind: "conflict", existing });
      }
      const record: ClassVersionRecord = {
        ...clone(registration),
        state: "draft",
      };
      this.classVersions.set(key, record);
      return clone({ kind: "registered", record });
    });
  }

  getClassVersion(
    classId: string,
    contractVersion: string,
  ): Promise<ClassVersionRecord | null> {
    return this.atomic(() =>
      clone(this.classVersions.get(pairKey(classId, contractVersion)) ?? null),
    );
  }

  transitionClassVersion(
    input: Parameters<Store["transitionClassVersion"]>[0],
  ): Promise<ContractTransitionOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.classTransitionHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      const key = pairKey(input.classId, input.contractVersion);
      const current = this.classVersions.get(key);
      if (current === undefined) return { kind: "not_found" };
      if (current.state !== input.from) {
        return { kind: "state_conflict", actual: current.state };
      }
      const record: ClassVersionRecord = {
        ...current,
        state: input.to,
        ...(input.leaseDisabledAt === undefined
          ? {}
          : { leaseDisabledAt: input.leaseDisabledAt }),
        ...(input.acceptedUntil === undefined
          ? {}
          : { acceptedUntil: input.acceptedUntil }),
      };
      this.classVersions.set(key, record);
      const outcome: ContractTransitionOutcome = { kind: "applied", record };
      this.classTransitionHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  getCurrentPermitEpoch(classId: string): Promise<string | null> {
    return this.atomic(() => this.permitEpochs.get(classId) ?? null);
  }

  transitionPermitEpoch(
    transition: Parameters<Store["transitionPermitEpoch"]>[0],
  ): Promise<PermitEpochTransitionOutcome> {
    return this.atomicInput(transition, (transition) => {
      const historyKey = fingerprint(transition);
      const prior = this.permitTransitionHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      const current = this.permitEpochs.get(transition.classId) ?? null;
      if (current !== transition.fromEpoch) {
        return { kind: "conflict", currentEpoch: current };
      }
      this.permitEpochs.set(transition.classId, transition.toEpoch);
      const outcome: PermitEpochTransitionOutcome = {
        kind: "applied",
        currentEpoch: transition.toEpoch,
      };
      this.permitTransitionHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  enqueueJob(input: Parameters<Store["enqueueJob"]>[0]): Promise<EnqueueOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.enqueueHistory.get(historyKey);
      if (prior?.kind === "enqueued") return { kind: "replayed" };
      const existing = this.jobs.get(input.job.jobId);
      if (existing !== undefined) {
        const existingPayload = this.payloads.get(existing.payloadRef);
        if (equal(existing, input.job) && equal(existingPayload, input.payload)) {
          return { kind: "replayed" };
        }
        return { kind: "conflict" };
      }

      const health = this.classHealth.get(input.job.classId);
      if (health === undefined) return { kind: "conflict" };
      const currentOperational = this.operationalFor(input.job.classId);
      if (!equal(currentOperational, input.expectedOperationalState)) {
        return {
          kind: "operational_state_conflict",
          current: currentOperational,
        };
      }
      if (
        this.queue.mode === "admission_halted" ||
        this.queue.mode === "emergency_halted" ||
        health.health.operating === "admission_halted" ||
        health.health.operating === "emergency_halted"
      ) {
        return clone({
          kind: "refused",
          queue: this.queue.mode,
          health: health.health,
        });
      }
      const classVersion = this.classVersions.get(
        pairKey(input.job.classId, input.job.contractVersion),
      );
      if (
        classVersion?.state !== "active" ||
        this.permitEpochs.get(input.job.classId) !== input.job.permitEpoch
      ) {
        return { kind: "conflict" };
      }
      const hasPayloadCollision = this.payloads.has(input.job.payloadRef);
      const payloadCollision = this.payloads.get(input.job.payloadRef);
      if (hasPayloadCollision && !equal(payloadCollision, input.payload)) {
        return { kind: "conflict" };
      }

      const job = clone(input.job);
      const key = cycleKey(job.jobId, job.collectionCycle);
      this.jobs.set(job.jobId, job);
      this.jobCycles.set(key, job);
      this.payloads.set(job.payloadRef, clone(input.payload));
      this.candidateRevisions.set(key, 1);
      this.attempts.set(key, {
        attemptCount: 0,
        openLeaseIds: [],
        acceptedWorkerIds: [],
        acceptedDiversity: [],
      });
      this.resultStates.set(key, "collecting");
      const outcome: EnqueueOutcome = { kind: "enqueued" };
      this.enqueueHistory.set(historyKey, outcome);
      return outcome;
    });
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.atomic(() => clone(this.jobs.get(jobId) ?? null));
  }

  getPayload(payloadRef: string): Promise<CanonicalJsonValue | null> {
    return this.atomic(() => clone(this.payloads.get(payloadRef) ?? null));
  }

  listLeaseCandidates(
    input: Parameters<Store["listLeaseCandidates"]>[0],
  ): Promise<readonly LeaseCandidateSnapshot[]> {
    return this.atomicInput(input, (input) => {
      const classIds = new Set(input.classIds);
      const candidates: LeaseCandidateSnapshot[] = [];
      for (const job of this.jobs.values()) {
        if (!classIds.has(job.classId)) continue;
        if (this.resultStates.get(cycleKey(job.jobId, job.collectionCycle)) !== "collecting") {
          continue;
        }
        const candidate = this.currentCandidate(job.jobId);
        if (candidate !== null) candidates.push(candidate);
      }
      return clone(candidates);
    });
  }

  getWorkerRoutingSnapshot(
    workerId: WorkerId,
  ): Promise<WorkerRoutingSnapshot | null> {
    return this.atomic(() => clone(this.workerRouting.get(workerId) ?? null));
  }

  transitionWorkerRouting(
    input: Parameters<Store["transitionWorkerRouting"]>[0],
  ): Promise<WorkerRoutingTransitionOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.workerRoutingHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      const current = this.workerRouting.get(input.expected.workerId);
      if (current === undefined) {
        throw new Error(`worker ${input.expected.workerId} has no routing snapshot`);
      }
      if (!equal(current, input.expected)) {
        return clone({ kind: "conflict", current });
      }
      const next: WorkerRoutingSnapshot = {
        revision: current.revision + 1,
        workerId: current.workerId,
        contributionWindowId: input.next.contributionWindowId,
        contributionUsed: input.next.contributionUsed,
        assignedSlotOccurrence: input.next.assignedSlotOccurrence,
        openLeaseIds: [...current.openLeaseIds],
      };
      this.workerRouting.set(current.workerId, next);
      const outcome: WorkerRoutingTransitionOutcome = {
        kind: "applied",
        current: next,
      };
      this.workerRoutingHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  compareAndClaimLease(
    input: Parameters<Store["compareAndClaimLease"]>[0],
  ): Promise<ClaimLeaseOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.claimHistory.get(historyKey);
      if (prior !== undefined) return clone(prior);
      if (this.coreIdentities.has(input.preparedLease.leaseId)) {
        return { kind: "conflict", reason: "identity_collision" };
      }
      const currentCandidate = this.currentCandidate(
        input.expectedCandidate.job.jobId,
      );
      if (
        currentCandidate === null ||
        currentCandidate.revision !== input.expectedCandidate.revision ||
        !equal(currentCandidate.job, input.expectedCandidate.job) ||
        !equal(currentCandidate.attempts, input.expectedCandidate.attempts)
      ) {
        return { kind: "conflict", reason: "candidate_stale" };
      }
      const currentWorker = this.workerRouting.get(input.expectedWorker.workerId);
      if (currentWorker === undefined || !equal(currentWorker, input.expectedWorker)) {
        return { kind: "conflict", reason: "worker_snapshot_stale" };
      }
      const currentOperational = this.operationalFor(currentCandidate.job.classId);
      if (!equal(currentOperational, input.expectedCandidate.operational)) {
        return { kind: "conflict", reason: "operational_state_stale" };
      }
      const health = this.classHealth.get(currentCandidate.job.classId);
      if (
        health === undefined ||
        this.queue.mode === "admission_halted" ||
        this.queue.mode === "emergency_halted" ||
        health.health.operating === "admission_halted" ||
        health.health.operating === "emergency_halted"
      ) {
        return { kind: "conflict", reason: "unclaimable" };
      }
      const classVersion = this.classVersions.get(
        pairKey(
          currentCandidate.job.classId,
          currentCandidate.job.contractVersion,
        ),
      );
      if (classVersion?.state !== "active") {
        return { kind: "conflict", reason: "unclaimable" };
      }

      const lease = input.preparedLease;
      const expectedAttempt = currentCandidate.attempts.attemptCount + 1;
      const preparedMatches =
        lease.open &&
        lease.jobId === currentCandidate.job.jobId &&
        lease.collectionCycle === currentCandidate.job.collectionCycle &&
        lease.classId === currentCandidate.job.classId &&
        lease.holder === currentWorker.workerId &&
        lease.inputHash === currentCandidate.job.inputHash &&
        lease.contractVersion === currentCandidate.job.contractVersion &&
        lease.policyVersion === currentCandidate.job.policyVersion &&
        lease.permitEpoch === currentCandidate.job.permitEpoch &&
        lease.routing.candidateRevision === currentCandidate.revision &&
        lease.routing.workerRevision === currentWorker.revision &&
        equal(lease.routing.operational, currentOperational) &&
        lease.routing.contributionWindowId === currentWorker.contributionWindowId &&
        lease.routing.contributionOrdinal === currentWorker.contributionUsed + 1 &&
        lease.routing.assignedSlotOccurrence === currentWorker.assignedSlotOccurrence &&
        lease.routing.attemptNumber === expectedAttempt &&
        equal(lease.routing.queuePriority, currentCandidate.job.queuePriority);
      if (
        !preparedMatches ||
        currentCandidate.attempts.openLeaseIds.length > 0 ||
        currentCandidate.attempts.acceptedWorkerIds.includes(currentWorker.workerId)
      ) {
        return { kind: "conflict", reason: "unclaimable" };
      }

      const persistedLease = clone(lease);
      this.leases.set(persistedLease.leaseId, persistedLease);
      this.coreIdentities.set(persistedLease.leaseId, "lease");
      const key = cycleKey(persistedLease.jobId, persistedLease.collectionCycle);
      this.attempts.set(key, {
        ...currentCandidate.attempts,
        attemptCount: expectedAttempt,
        openLeaseIds: [persistedLease.leaseId],
      });
      this.candidateRevisions.set(key, currentCandidate.revision + 1);
      this.workerRouting.set(currentWorker.workerId, {
        ...currentWorker,
        revision: currentWorker.revision + 1,
        contributionUsed: currentWorker.contributionUsed + 1,
        openLeaseIds: [...currentWorker.openLeaseIds, persistedLease.leaseId],
      });
      const outcome: ClaimLeaseOutcome = {
        kind: "claimed",
        lease: persistedLease,
        job: currentCandidate.job,
      };
      this.claimHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  getLease(leaseId: string): Promise<LeaseRecord | null> {
    return this.atomic(() => clone(this.leases.get(leaseId) ?? null));
  }

  getResultState(
    jobId: string,
    collectionCycle: number,
  ): Promise<ResultState | null> {
    return this.atomic(() => this.resultStates.get(cycleKey(jobId, collectionCycle)) ?? null);
  }

  transitionResult(
    _input: Parameters<Store["transitionResult"]>[0],
  ): Promise<TransitionOutcome> {
    return this.unsupported("transitionResult");
  }

  inspectInvalidationScope(scope: InvalidationScope): Promise<InvalidationSnapshot> {
    return this.atomicInput(scope, (scope) =>
      clone(this.currentInvalidationSnapshot(scope)),
    );
  }

  invalidateResultScope(
    input: Parameters<Store["invalidateResultScope"]>[0],
  ): Promise<InvalidationOutcome> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.invalidationHistory.get(historyKey);
      if (prior !== undefined) return clone(prior);
      const current = this.currentInvalidationSnapshot(input.scope);
      if (!equal(current.targets, sortTargets(input.expectedTargets))) {
        return clone({ kind: "conflict", current });
      }
      if (
        input.reason === "emergency_permit_withdrawal" &&
        (this.permitEpochs.get(input.epochTransition.classId) ?? null) !==
          input.epochTransition.fromEpoch
      ) {
        return clone({ kind: "conflict", current });
      }
      this.validateRequeuePlans(input.requeuePlans, current.targets);
      const outcome = this.applyInvalidation(
        current,
        input.reason,
        input.requeuePlans,
        input.at,
        input.reason === "emergency_permit_withdrawal"
          ? input.epochTransition
          : undefined,
      );
      this.invalidationHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  getQueueMode(): Promise<QueueModeSnapshot> {
    return this.atomic(() => clone(this.queue));
  }

  transitionQueueMode(
    input: Parameters<Store["transitionQueueMode"]>[0],
  ): Promise<OperationalTransitionOutcome<QueueModeSnapshot>> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.queueTransitionHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      if (!equal(this.queue, input.expected)) {
        return clone({ kind: "conflict", current: this.queue });
      }
      this.queue = {
        revision: this.queue.revision + 1,
        mode: input.next.mode,
        updatedAt: input.next.updatedAt,
      };
      const outcome: OperationalTransitionOutcome<QueueModeSnapshot> = {
        kind: "applied",
        current: this.queue,
      };
      this.queueTransitionHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  initializeClassHealth(
    input: Parameters<Store["initializeClassHealth"]>[0],
  ): Promise<InitializeClassHealthOutcome> {
    return this.atomicInput(input, (input) => {
      const classId = input.initial.classId;
      const existing = this.classHealth.get(classId);
      if (existing !== undefined) {
        const initialKey = this.healthInitialization.get(classId);
        if (initialKey === fingerprint(input.initial)) {
          return clone({ kind: "replayed", current: existing });
        }
        return clone({ kind: "conflict", current: existing });
      }
      const current: ClassHealthSnapshot = {
        revision: 1,
        ...clone(input.initial),
      };
      this.classHealth.set(classId, current);
      this.healthInitialization.set(classId, fingerprint(input.initial));
      return clone({ kind: "initialized", current });
    });
  }

  getClassHealth(classId: string): Promise<ClassHealthSnapshot | null> {
    return this.atomic(() => clone(this.classHealth.get(classId) ?? null));
  }

  transitionClassHealth(
    input: Parameters<Store["transitionClassHealth"]>[0],
  ): Promise<OperationalTransitionOutcome<ClassHealthSnapshot>> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.healthTransitionHistory.get(historyKey);
      if (prior !== undefined && prior.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      const current = this.classHealth.get(input.expected.classId);
      if (current === undefined) {
        throw new Error(`class ${input.expected.classId} has no health snapshot`);
      }
      if (!equal(current, input.expected)) {
        return clone({ kind: "conflict", current });
      }
      const next: ClassHealthSnapshot = {
        revision: current.revision + 1,
        classId: current.classId,
        health: clone(input.next.health),
        updatedAt: input.next.updatedAt,
        source: input.next.source,
      };
      this.classHealth.set(current.classId, next);
      const outcome: OperationalTransitionOutcome<ClassHealthSnapshot> = {
        kind: "applied",
        current: next,
      };
      this.healthTransitionHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  enterEmergencyHalt(
    input: Parameters<Store["enterEmergencyHalt"]>[0],
  ): ReturnType<Store["enterEmergencyHalt"]> {
    return this.atomicInput(input, (input) => {
      const historyKey = fingerprint(input);
      const prior = this.emergencyHistory.get(historyKey);
      if (prior !== undefined) return clone(prior);
      const currentHealth = input.expectedClassHealth
        .map((expected) => this.classHealth.get(expected.classId))
        .filter((snapshot): snapshot is ClassHealthSnapshot => snapshot !== undefined);
      const currentInvalidation = this.currentInvalidationSnapshot(
        input.invalidation.scope,
      );
      const healthMatches =
        currentHealth.length === input.expectedClassHealth.length &&
        input.expectedClassHealth.every((expected) =>
          currentHealth.some((current) => equal(current, expected)),
        );
      const nextClassIds = new Set(input.nextClassHealth.map((next) => next.classId));
      if (
        !equal(this.queue, input.expectedQueue) ||
        !healthMatches ||
        nextClassIds.size !== input.expectedClassHealth.length ||
        !input.expectedClassHealth.every((expected) => nextClassIds.has(expected.classId)) ||
        !equal(currentInvalidation.targets, sortTargets(input.invalidation.expectedTargets))
      ) {
        return clone({
          kind: "conflict",
          queue: this.queue,
          classHealth: currentHealth,
          invalidation: currentInvalidation,
        });
      }

      this.validateRequeuePlans(
        input.invalidation.requeuePlans,
        currentInvalidation.targets,
      );

      const invalidation = this.applyInvalidation(
        currentInvalidation,
        "emergency_halted",
        input.invalidation.requeuePlans,
        input.at,
      );
      this.queue = {
        revision: this.queue.revision + 1,
        mode: "emergency_halted",
        updatedAt: input.nextQueue.updatedAt,
      };
      const nextHealth = input.nextClassHealth.map((next) => {
        const current = this.classHealth.get(next.classId);
        if (current === undefined) throw new Error(`missing class health ${next.classId}`);
        const snapshot: ClassHealthSnapshot = {
          revision: current.revision + 1,
          classId: next.classId,
          health: clone(next.health),
          updatedAt: next.updatedAt,
          source: next.source,
        };
        this.classHealth.set(next.classId, snapshot);
        return snapshot;
      });
      const outcome: Awaited<ReturnType<Store["enterEmergencyHalt"]>> = {
        kind: "applied",
        queue: this.queue,
        classHealth: nextHealth,
        invalidation,
      };
      this.emergencyHistory.set(historyKey, clone(outcome));
      return clone(outcome);
    });
  }

  private operationalFor(classId: string): OperationalStateExpectation {
    const health = this.classHealth.get(classId);
    if (health === undefined) throw new Error(`class ${classId} has no health snapshot`);
    return {
      queueRevision: this.queue.revision,
      classHealthRevision: health.revision,
    };
  }

  private currentCandidate(jobId: string): LeaseCandidateSnapshot | null {
    const job = this.jobs.get(jobId);
    if (job === undefined) return null;
    const key = cycleKey(job.jobId, job.collectionCycle);
    const revision = this.candidateRevisions.get(key);
    const attempts = this.attempts.get(key);
    if (revision === undefined || attempts === undefined) return null;
    return clone({
      revision,
      job,
      attempts,
      operational: this.operationalFor(job.classId),
    });
  }

  private currentInvalidationSnapshot(scope: InvalidationScope): InvalidationSnapshot {
    const selectedDecisionHashes =
      scope.kind === "decision_results" ? new Set(scope.decisionResultHashes) : null;
    const selectedCycles =
      scope.kind === "job_cycles"
        ? new Set(scope.jobCycles.map((entry) => cycleKey(entry.jobId, entry.collectionCycle)))
        : null;
    const targets: InvalidationTarget[] = [];
    for (const [key, state] of this.resultStates) {
      const job = this.jobCycles.get(key);
      if (job === undefined || job.classId !== scope.classId) continue;
      let matches = false;
      switch (scope.kind) {
        case "class":
          matches = true;
          break;
        case "job_cycles":
          matches = selectedCycles?.has(key) ?? false;
          break;
        case "permit_epoch":
          matches = job.permitEpoch === scope.permitEpoch;
          break;
        case "contract_version":
          matches = job.contractVersion === scope.contractVersion;
          break;
        case "decision_results":
          matches = [...this.decisions.values()].some((decision) =>
            selectedDecisionHashes?.has(decision.decisionResultHash) &&
            decision.jobId === job.jobId &&
            decision.collectionCycle === job.collectionCycle,
          );
          break;
      }
      if (!matches) continue;
      targets.push({
        jobId: job.jobId,
        collectionCycle: job.collectionCycle,
        state,
        inputHash: job.inputHash,
        permitEpoch: job.permitEpoch,
        contractVersion: job.contractVersion,
      });
    }
    return clone({ scope, targets: sortTargets(targets) });
  }

  private applyInvalidation(
    snapshot: InvalidationSnapshot,
    reason: AuthorizationInvalidationReason,
    requeuePlans: CycleRequeuePlan[],
    _at: Timestamp,
    epochTransition?: PermitEpochTransition,
  ): AppliedInvalidationOutcome {
    const to = INVALIDATION_RESULT_TARGET[reason];
    const resultTransitions = snapshot.targets.map((target) => {
      this.resultStates.set(cycleKey(target.jobId, target.collectionCycle), to);
      return {
        jobId: target.jobId,
        collectionCycle: target.collectionCycle,
        from: target.state,
        to,
      };
    });
    for (const plan of requeuePlans) {
      const oldKey = cycleKey(plan.jobId, plan.fromCollectionCycle);
      const oldJob = this.jobCycles.get(oldKey)!;
      const nextJob: JobRecord = {
        ...oldJob,
        collectionCycle: plan.newCollectionCycle,
        permitEpoch: plan.permitEpoch,
        inputHash: plan.inputHash,
        cycleStartedAt: plan.cycleStartedAt,
      };
      const nextKey = cycleKey(plan.jobId, plan.newCollectionCycle);
      this.jobs.set(plan.jobId, nextJob);
      this.jobCycles.set(nextKey, nextJob);
      this.resultStates.set(nextKey, "collecting");
      this.candidateRevisions.set(nextKey, 1);
      this.attempts.set(nextKey, {
        attemptCount: 0,
        openLeaseIds: [],
        acceptedWorkerIds: [],
        acceptedDiversity: [],
      });
    }
    if (epochTransition !== undefined) {
      this.permitEpochs.set(epochTransition.classId, epochTransition.toEpoch);
    }
    return clone({
      kind: "applied",
      resultTransitions,
      authorizationTransitions: [],
      invalidatedAuthorizations: [],
      newCycles: requeuePlans,
      ...(epochTransition === undefined ? {} : { epochTransition }),
    });
  }

  private validateRequeuePlans(
    requeuePlans: readonly CycleRequeuePlan[],
    targets: readonly InvalidationTarget[],
  ): void {
    const targetCycles = new Set(
      targets.map((target) => cycleKey(target.jobId, target.collectionCycle)),
    );
    const nextCycles = new Set<string>();
    for (const plan of requeuePlans) {
      const oldKey = cycleKey(plan.jobId, plan.fromCollectionCycle);
      if (!this.jobCycles.has(oldKey) || !targetCycles.has(oldKey)) {
        throw new Error(`missing requeue source ${oldKey}`);
      }
      if (plan.newCollectionCycle !== plan.fromCollectionCycle + 1) {
        throw new Error(`non-consecutive requeue target for ${oldKey}`);
      }
      const nextKey = cycleKey(plan.jobId, plan.newCollectionCycle);
      if (nextCycles.has(nextKey) || this.jobCycles.has(nextKey)) {
        throw new Error(`duplicate requeue target ${nextKey}`);
      }
      nextCycles.add(nextKey);
    }
  }

  extendLease(
    _input: Parameters<Store["extendLease"]>[0],
  ): ReturnType<Store["extendLease"]> {
    return this.unsupported("extendLease");
  }

  abandonLease(
    _input: Parameters<Store["abandonLease"]>[0],
  ): ReturnType<Store["abandonLease"]> {
    return this.unsupported("abandonLease");
  }

  expireAndRequeue(
    _leaseId: string,
    _under: Parameters<Store["expireAndRequeue"]>[1],
  ): ReturnType<Store["expireAndRequeue"]> {
    return this.unsupported("expireAndRequeue");
  }

  acceptOrReplaySubmission(
    _input: Parameters<Store["acceptOrReplaySubmission"]>[0],
  ): ReturnType<Store["acceptOrReplaySubmission"]> {
    return this.unsupported("acceptOrReplaySubmission");
  }

  getAcceptedSubmission(
    _leaseId: string,
  ): ReturnType<Store["getAcceptedSubmission"]> {
    return this.unsupported("getAcceptedSubmission");
  }

  listAcceptedReplicas(
    _jobId: string,
    _collectionCycle: number,
  ): ReturnType<Store["listAcceptedReplicas"]> {
    return this.unsupported("listAcceptedReplicas");
  }

  recordDecisionResult(
    _input: Parameters<Store["recordDecisionResult"]>[0],
  ): ReturnType<Store["recordDecisionResult"]> {
    return this.unsupported("recordDecisionResult");
  }

  getDecisionResult(
    decisionResultHash: string,
  ): ReturnType<Store["getDecisionResult"]> {
    return this.atomic(() => clone(this.decisions.get(decisionResultHash) ?? null));
  }

  authorizeOrReplayIntent(
    _input: Parameters<Store["authorizeOrReplayIntent"]>[0],
  ): ReturnType<Store["authorizeOrReplayIntent"]> {
    return this.unsupported("authorizeOrReplayIntent");
  }

  getAuthorizationStatus(
    _authorizationRequestId: string,
  ): ReturnType<Store["getAuthorizationStatus"]> {
    return this.unsupported("getAuthorizationStatus");
  }

  getInitialReceipt(
    _effectIntentId: string,
  ): ReturnType<Store["getInitialReceipt"]> {
    return this.unsupported("getInitialReceipt");
  }

  getAuthorization(
    _authorizationRequestId: string,
  ): ReturnType<Store["getAuthorization"]> {
    return this.unsupported("getAuthorization");
  }

  openResultAdjudication(
    _input: Parameters<Store["openResultAdjudication"]>[0],
  ): ReturnType<Store["openResultAdjudication"]> {
    return this.unsupported("openResultAdjudication");
  }

  getResultAdjudicationRequest(
    _id: string,
  ): ReturnType<Store["getResultAdjudicationRequest"]> {
    return this.unsupported("getResultAdjudicationRequest");
  }

  listPendingResultAdjudications(
    _classId: string,
  ): ReturnType<Store["listPendingResultAdjudications"]> {
    return this.unsupported("listPendingResultAdjudications");
  }

  applyResultAdjudicationVerdict(
    _input: Parameters<Store["applyResultAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyResultAdjudicationVerdict"]> {
    return this.unsupported("applyResultAdjudicationVerdict");
  }

  getActionAdjudicationRequest(
    _authorizationRequestId: string,
  ): ReturnType<Store["getActionAdjudicationRequest"]> {
    return this.unsupported("getActionAdjudicationRequest");
  }

  listPendingActionAdjudications(
    _classId: string,
  ): ReturnType<Store["listPendingActionAdjudications"]> {
    return this.unsupported("listPendingActionAdjudications");
  }

  applyActionAdjudicationVerdict(
    _input: Parameters<Store["applyActionAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyActionAdjudicationVerdict"]> {
    return this.unsupported("applyActionAdjudicationVerdict");
  }

  chargeReserve(
    _charge: Parameters<Store["chargeReserve"]>[0],
  ): ReturnType<Store["chargeReserve"]> {
    return this.unsupported("chargeReserve");
  }

  appendLedger(
    _entry: Parameters<Store["appendLedger"]>[0],
  ): ReturnType<Store["appendLedger"]> {
    return this.unsupported("appendLedger");
  }

  recordReputationEvidence(
    _record: Parameters<Store["recordReputationEvidence"]>[0],
  ): ReturnType<Store["recordReputationEvidence"]> {
    return this.unsupported("recordReputationEvidence");
  }

  listReputationEvidence(
    _workerId: WorkerId,
  ): ReturnType<Store["listReputationEvidence"]> {
    return this.unsupported("listReputationEvidence");
  }
}
