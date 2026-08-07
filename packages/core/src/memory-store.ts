import {
  FAIR_ATTEMPT_TABLE,
  INVALIDATION_RESULT_TARGET,
  type ActionAdjudicationRequest,
  type ActionAuthorization,
  type AuthorizationInitialReceipt,
  type AuthorizationInvalidationReason,
  type AuthorizationRequestState,
  type AuthorizationStatus,
  type CanonicalJsonValue,
  type EffectIntent,
  type ResultAdjudicationRequest,
  type ResultAdjudicationRequestState,
  type ResultState,
  type SubmissionEvidence,
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
  MarkResultSplitOutcome,
  NoWorkAttemptOutcome,
  OperationalStateExpectation,
  OperationalTransitionOutcome,
  PermitEpochTransition,
  PermitEpochTransitionOutcome,
  QueueModeSnapshot,
  ReserveChargeRecord,
  ReserveMutation,
  ReservePolicyRecord,
  ReservePolicySnapshot,
  ReputationEvidenceRecord,
  RejectSubmissionOutcome,
  RegisterClassVersionOutcome,
  RegisterWorkerOutcome,
  Store,
  TransitionOutcome,
  VerdictOutcome,
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
const isChargedMutation = (
  mutation: ReserveMutation<"charged"> | ReserveMutation<"exhausted">,
): mutation is ReserveMutation<"charged"> =>
  mutation.charge.outcome === "charged";
const compareWireIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const pairKey = (left: string, right: string): string =>
  JSON.stringify([left, right]);
const tripleKey = (first: string, second: string, third: string): string =>
  JSON.stringify([first, second, third]);
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
  private acceptedSubmissions = new Map<
    string,
    {
      receipt: Parameters<Store["acceptOrReplaySubmission"]>[0]["receipt"];
      body: CanonicalJsonValue;
    }
  >();
  private coreIdentities = new Map<string, CoreIdentityKind>();
  private resultStates = new Map<string, ResultState>();
  private decisions = new Map<string, DecisionResultRecord>();
  private reputationEvidence = new Map<string, ReputationEvidenceRecord>();
  private reservePolicies = new Map<string, ReservePolicyRecord>();
  private reserveWindowHistory = new Map<string, Set<string>>();
  private reserveCharges = new Map<
    string,
    ReserveMutation<"charged"> | ReserveMutation<"exhausted">
  >();
  private resultAdjudications = new Map<
    string,
    {
      request: ResultAdjudicationRequest;
      openedAt: Timestamp;
      state: ResultAdjudicationRequestState;
      charge: ReserveMutation<"charged"> | ReserveMutation<"exhausted">;
    }
  >();
  private resultAdjudicationByCycle = new Map<string, string>();
  private actionAdjudications = new Map<
    string,
    { request: ActionAdjudicationRequest; openedAt: Timestamp }
  >();
  private authorizationStatuses = new Map<string, AuthorizationStatus>();
  private authorizations = new Map<string, ActionAuthorization>();
  private initialReceipts = new Map<string, AuthorizationInitialReceipt>();
  private effectIntentRecords = new Map<
    string,
    {
      input: string;
      authorizationRequestId: string;
      effectIntent: EffectIntent;
      effectIntentHash: string;
      decisionResultHash: string;
    }
  >();
  private verdictHistory = new Map<
    string,
    {
      input: string;
      outcome: Extract<VerdictOutcome, { kind: "applied" }>;
    }
  >();
  private ledger: Array<Parameters<Store["appendLedger"]>[0]> = [];

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
  private rejectionHistory = new Map<string, {
    input: string;
    outcome: RejectSubmissionOutcome;
  }>();
  private splitHistory = new Map<string, string>();
  private invalidationHistory = new Map<string, InvalidationOutcome>();
  private emergencyHistory = new Map<
    string,
    Awaited<ReturnType<Store["enterEmergencyHalt"]>>
  >();
  private reserveInitializationHistory = new Map<
    string,
    Awaited<ReturnType<Store["initializeReservePolicy"]>>
  >();
  private reserveTransitionHistory = new Map<
    string,
    Awaited<ReturnType<Store["transitionReservePolicy"]>>
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
    this.acceptedSubmissions.clear();
    this.coreIdentities.clear();
    this.resultStates.clear();
    this.decisions.clear();
    this.reputationEvidence.clear();
    this.reservePolicies.clear();
    this.reserveWindowHistory.clear();
    this.reserveCharges.clear();
    this.resultAdjudications.clear();
    this.resultAdjudicationByCycle.clear();
    this.actionAdjudications.clear();
    this.authorizationStatuses.clear();
    this.authorizations.clear();
    this.initialReceipts.clear();
    this.effectIntentRecords.clear();
    this.verdictHistory.clear();
    this.ledger = [];
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
    this.rejectionHistory.clear();
    this.splitHistory.clear();
    this.invalidationHistory.clear();
    this.emergencyHistory.clear();
    this.reserveInitializationHistory.clear();
    this.reserveTransitionHistory.clear();
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
            contractVersion: lease.contractVersion,
            permitEpoch: lease.permitEpoch,
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
      const currentHealth = input.to === "retired"
        ? this.classHealth.get(input.classId)
        : undefined;
      if (input.to === "retired" && currentHealth === undefined) {
        throw new Error(`class ${input.classId} has no health snapshot`);
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
      const retirementHealth = record.state === "retired"
        ? this.publishReserveHealth(input.classId, input.at)
        : undefined;
      const outcome: ContractTransitionOutcome = record.state === "retired"
        ? {
            kind: "applied",
            record: { ...record, state: "retired" },
            classHealth: clone(retirementHealth!),
          }
        : {
            kind: "applied",
            record: {
              ...record,
              state: record.state,
            },
          };
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
        health.health.operating !== "ready" ||
        health.health.reserves.urgent === "saturated" ||
        health.health.reserves.splitAndAdjudication === "saturated" ||
        health.health.reserves.audit === "saturated"
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
      if (
        this.coreIdentities.has(input.job.payloadRef) ||
        (hasPayloadCollision && !equal(payloadCollision, input.payload))
      ) {
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
        splitObserved: false,
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
      if (
        input.preparedLease.assignment.kind === "ordinary" &&
        this.payloads.has(input.preparedLease.leaseId)
      ) {
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
      const storedJobPayload = this.payloads.get(currentCandidate.job.payloadRef);
      const expectedAttempt = currentCandidate.attempts.attemptCount + 1;
      const payloadBindingMatches = lease.assignment.kind === "ordinary"
        ? lease.payloadRef === currentCandidate.job.payloadRef &&
          lease.inputHash === currentCandidate.job.inputHash &&
          storedJobPayload !== undefined &&
          equal(input.preparedPayload, storedJobPayload)
        : lease.payloadRef === lease.leaseId &&
          lease.payloadRef !== currentCandidate.job.payloadRef &&
          !this.payloads.has(lease.payloadRef);
      const preparedMatches =
        lease.open &&
        lease.jobId === currentCandidate.job.jobId &&
        lease.collectionCycle === currentCandidate.job.collectionCycle &&
        lease.classId === currentCandidate.job.classId &&
        lease.holder === currentWorker.workerId &&
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
        equal(lease.routing.queuePriority, currentCandidate.job.queuePriority) &&
        payloadBindingMatches;
      if (
        !preparedMatches ||
        currentCandidate.attempts.openLeaseIds.length > 0 ||
        currentCandidate.attempts.acceptedWorkerIds.includes(currentWorker.workerId)
      ) {
        return { kind: "conflict", reason: "unclaimable" };
      }

      const persistedLease = clone(lease);
      this.leases.set(persistedLease.leaseId, persistedLease);
      if (persistedLease.assignment.kind === "canary") {
        this.payloads.set(persistedLease.payloadRef, clone(input.preparedPayload));
      }
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

  recordNoWorkAttempt(
    input: Parameters<Store["recordNoWorkAttempt"]>[0],
  ): Promise<NoWorkAttemptOutcome> {
    return this.atomicInput(input, (input) => {
      const current = this.workerRouting.get(input.expectedWorker.workerId);
      if (current === undefined) {
        throw new Error(
          `worker ${input.expectedWorker.workerId} has no routing snapshot`,
        );
      }
      if (!equal(current, input.expectedWorker)) {
        return clone({ kind: "conflict", current });
      }
      const next: WorkerRoutingSnapshot = {
        ...current,
        revision: current.revision + 1,
        contributionUsed: current.contributionUsed + 1,
        openLeaseIds: [...current.openLeaseIds],
      };
      this.workerRouting.set(current.workerId, next);
      return clone({ kind: "recorded", current: next });
    });
  }

  getResultState(
    jobId: string,
    collectionCycle: number,
  ): Promise<ResultState | null> {
    return this.atomic(() => this.resultStates.get(cycleKey(jobId, collectionCycle)) ?? null);
  }

  transitionResult(
    input: Parameters<Store["transitionResult"]>[0],
  ): Promise<TransitionOutcome> {
    return this.atomicInput(input, (input) => {
      const key = cycleKey(input.jobId, input.collectionCycle);
      const actual = this.resultStates.get(key);
      if (actual !== input.from) {
        return { ok: false, actual: actual ?? input.from };
      }
      const job = this.jobCycles.get(key);
      if (job === undefined) return { ok: false, actual: input.from };
      let next: JobRecord | undefined;
      if (input.startNewCycle !== undefined) {
        const nextCycle = input.collectionCycle + 1;
        const nextKey = cycleKey(input.jobId, nextCycle);
        if (
          this.jobCycles.has(nextKey) ||
          input.startNewCycle.permitEpoch.length === 0 ||
          input.startNewCycle.inputHash.length === 0
        ) return { ok: false, actual };
        next = {
          ...job,
          collectionCycle: nextCycle,
          permitEpoch: input.startNewCycle.permitEpoch,
          inputHash: input.startNewCycle.inputHash,
          cycleStartedAt: input.startNewCycle.cycleStartedAt,
        };
      }
      const attempts = this.attempts.get(key);
      for (const leaseId of [...(attempts?.openLeaseIds ?? [])]) {
        const lease = this.leases.get(leaseId);
        if (lease !== undefined && lease.open) this.closeLeaseAttempt(lease, true);
      }
      this.resultStates.set(key, input.to);
      if (next !== undefined) {
        const nextKey = cycleKey(next.jobId, next.collectionCycle);
        this.jobs.set(next.jobId, next);
        this.jobCycles.set(nextKey, next);
        this.resultStates.set(nextKey, "collecting");
        this.candidateRevisions.set(nextKey, 1);
        this.attempts.set(nextKey, {
          attemptCount: 0,
          openLeaseIds: [],
          acceptedWorkerIds: [],
          acceptedDiversity: [],
          splitObserved: false,
        });
      }
      return { ok: true };
    });
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
        health: {
          ...clone(input.next.health),
          reserves: clone(current.health.reserves),
        },
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
          health: {
            ...clone(next.health),
            reserves: clone(current.health.reserves),
          },
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

  private reservePolicyKey(policy: Pick<
    ReservePolicySnapshot,
    "classId" | "contractVersion" | "lane"
  >): string {
    return tripleKey(policy.classId, policy.contractVersion, policy.lane);
  }

  private validReservePolicy(policy: ReservePolicySnapshot): boolean {
    const start = Date.parse(policy.windowStartsAt);
    const end = Date.parse(policy.windowEndsAt);
    return policy.classId.length > 0 &&
      policy.contractVersion.length > 0 &&
      policy.policyVersion.length > 0 &&
      policy.windowId.length > 0 &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start < end &&
      Number.isSafeInteger(policy.laneLimit) &&
      policy.laneLimit >= 0 &&
      (policy.lane === "lowCost" || policy.lane === "urgent"
        ? Number.isSafeInteger(policy.perWorkerLimit) &&
          policy.perWorkerLimit >= 0
        : policy.perWorkerLimit === undefined);
  }

  private publishReserveHealth(
    classId: string,
    at: Timestamp,
  ): ClassHealthSnapshot {
    const current = this.classHealth.get(classId);
    if (current === undefined) {
      throw new Error(`class ${classId} has no health snapshot`);
    }
    const reserves: {
      lowCost: "available" | "saturated";
      urgent: "available" | "saturated";
      splitAndAdjudication: "available" | "saturated";
      audit: "available" | "saturated";
    } = {
      lowCost: "available",
      urgent: "available",
      splitAndAdjudication: "available",
      audit: "available",
    };
    for (const record of this.reservePolicies.values()) {
      if (record.policy.classId !== classId) continue;
      const version = this.classVersions.get(pairKey(
        classId,
        record.policy.contractVersion,
      ));
      if (version === undefined || version.state === "retired") continue;
      if (record.used >= record.policy.laneLimit) {
        reserves[record.policy.lane] = "saturated";
      }
    }
    const next: ClassHealthSnapshot = {
      revision: current.revision + 1,
      classId,
      health: {
        ...clone(current.health),
        reserves,
      },
      updatedAt: at,
      source: "automatic",
    };
    this.classHealth.set(classId, next);
    return next;
  }

  private settleReserve(
    charge: Parameters<Store["chargeReserve"]>[0],
  ): Awaited<ReturnType<Store["chargeReserve"]>> {
    const existing = this.reserveCharges.get(charge.chargeKey);
    if (existing !== undefined) {
      const sameSemanticInput = equal(existing.charge.charge.policy, charge.policy) &&
        equal(existing.charge.charge.workerIds, charge.workerIds);
      if (!sameSemanticInput) {
        return clone({
          kind: "reserve_charge_conflict",
          existingCharge: existing.charge,
        });
      }
      return isChargedMutation(existing)
        ? clone({ kind: "charged", status: "replayed", ...existing })
        : clone({ kind: "exhausted", status: "replayed", ...existing });
    }

    const key = this.reservePolicyKey(charge.policy);
    const current = this.reservePolicies.get(key);
    if (current === undefined || !equal(current.policy, charge.policy)) {
      return clone({
        kind: "reserve_policy_conflict",
        currentPolicy: current ?? null,
      });
    }

    const classCapacity = current.used < current.policy.laneLimit;
    let perWorkerCapacity = true;
    if (current.policy.lane === "lowCost" || current.policy.lane === "urgent") {
      const perWorkerLimit = current.policy.perWorkerLimit;
      perWorkerCapacity = charge.workerIds.every((workerId) =>
        (current.workerUsage.find((usage) => usage.workerId === workerId)?.used ?? 0) <
          perWorkerLimit
      );
    }
    const outcome = classCapacity && perWorkerCapacity ? "charged" : "exhausted";
    const firstCharge = clone(charge);
    let nextPolicy = current;
    if (outcome === "charged") {
      const usage = new Map(
        current.workerUsage.map((entry) => [entry.workerId, entry.used]),
      );
      if (current.policy.lane === "lowCost" || current.policy.lane === "urgent") {
        for (const workerId of charge.workerIds) {
          usage.set(workerId, (usage.get(workerId) ?? 0) + 1);
        }
      }
      nextPolicy = {
        revision: current.revision + 1,
        policy: clone(current.policy),
        used: current.used + 1,
        workerUsage: [...usage.entries()]
          .sort(([left], [right]) => compareWireIds(left, right))
          .map(([workerId, used]) => ({ workerId, used })),
        updatedAt: charge.at,
      };
      this.reservePolicies.set(key, nextPolicy);
    }
    const classHealth = this.publishReserveHealth(charge.policy.classId, charge.at);
    if (outcome === "charged") {
      const mutation: ReserveMutation<"charged"> = {
        charge: { charge: firstCharge, outcome },
        currentPolicy: nextPolicy,
        classHealth,
      };
      this.reserveCharges.set(charge.chargeKey, clone(mutation));
      return clone({ kind: "charged", status: "applied", ...mutation });
    }
    const mutation: ReserveMutation<"exhausted"> = {
      charge: { charge: firstCharge, outcome },
      currentPolicy: nextPolicy,
      classHealth,
    };
    this.reserveCharges.set(charge.chargeKey, clone(mutation));
    return clone({ kind: "exhausted", status: "applied", ...mutation });
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

  private closeLeaseAttempt(
    lease: LeaseRecord,
    releaseContribution: boolean,
  ): void {
    const closed = { ...lease, open: false };
    this.leases.set(lease.leaseId, closed);
    const key = cycleKey(lease.jobId, lease.collectionCycle);
    const attempt = this.attempts.get(key);
    if (attempt !== undefined) {
      this.attempts.set(key, {
        ...attempt,
        openLeaseIds: attempt.openLeaseIds.filter((id) => id !== lease.leaseId),
      });
    }
    this.candidateRevisions.set(
      key,
      (this.candidateRevisions.get(key) ?? 0) + 1,
    );

    const routing = this.workerRouting.get(lease.holder);
    if (routing === undefined) {
      throw new Error(`worker ${lease.holder} has no routing snapshot`);
    }
    const mayRelease =
      releaseContribution &&
      routing.contributionWindowId === lease.routing.contributionWindowId &&
      routing.contributionUsed > 0;
    this.workerRouting.set(lease.holder, {
      ...routing,
      revision: routing.revision + 1,
      contributionUsed: mayRelease
        ? routing.contributionUsed - 1
        : routing.contributionUsed,
      openLeaseIds: routing.openLeaseIds.filter((id) => id !== lease.leaseId),
    });
  }

  private acceptedReplicasFor(
    jobId: string,
    collectionCycle: number,
  ): Array<{
    evidence: SubmissionEvidence;
    body: CanonicalJsonValue;
    acceptedAt: Timestamp;
  }> {
    const replicas = [];
    for (const [leaseId, accepted] of this.acceptedSubmissions) {
      const lease = this.leases.get(leaseId);
      if (
        lease === undefined ||
        lease.assignment.kind !== "ordinary" ||
        lease.jobId !== jobId ||
        lease.collectionCycle !== collectionCycle
      ) continue;
      replicas.push({
        evidence: {
          leaseId,
          collectionCycle,
          resultHash: accepted.receipt.resultHash,
          workerId: lease.holder,
        },
        body: clone(accepted.body),
        acceptedAt: accepted.receipt.acceptedAt,
      });
    }
    return replicas.sort((left, right) =>
      compareWireIds(left.evidence.leaseId, right.evidence.leaseId)
    );
  }

  private evidenceConflict(record?: ReputationEvidenceRecord): boolean {
    if (record === undefined) return false;
    const existing = this.reputationEvidence.get(record.evidenceId);
    return existing !== undefined && !equal(existing, record);
  }

  private persistEvidence(record?: ReputationEvidenceRecord): void {
    if (record !== undefined && !this.reputationEvidence.has(record.evidenceId)) {
      this.reputationEvidence.set(record.evidenceId, clone(record));
    }
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
    at: Timestamp,
    epochTransition?: PermitEpochTransition,
  ): AppliedInvalidationOutcome {
    const to = INVALIDATION_RESULT_TARGET[reason];
    const authorizationTarget = to as Extract<
      AuthorizationRequestState,
      "expired" | "superseded" | "cancelled"
    >;
    const authorizationTransitions: AppliedInvalidationOutcome["authorizationTransitions"] = [];
    const invalidatedAuthorizations: AppliedInvalidationOutcome["invalidatedAuthorizations"] = [];
    const resultTransitions = snapshot.targets.map((target) => {
      const key = cycleKey(target.jobId, target.collectionCycle);
      const attempts = this.attempts.get(key);
      for (const leaseId of [...(attempts?.openLeaseIds ?? [])]) {
        const lease = this.leases.get(leaseId);
        if (lease !== undefined && lease.open) this.closeLeaseAttempt(lease, true);
      }
      this.resultStates.set(key, to);
      const resultRequestId = this.resultAdjudicationByCycle.get(key);
      if (resultRequestId !== undefined) {
        const request = this.resultAdjudications.get(resultRequestId);
        if (request?.state === "pending_result_adjudication") {
          request.state = to as ResultAdjudicationRequestState;
          this.resultAdjudications.set(resultRequestId, request);
        }
      }
      for (const [authorizationRequestId, pending] of this.actionAdjudications) {
        if (
          pending.request.jobId !== target.jobId ||
          pending.request.collectionCycle !== target.collectionCycle
        ) continue;
        const status = this.authorizationStatuses.get(authorizationRequestId);
        if (status?.state === "pending_adjudication") {
          this.authorizationStatuses.set(authorizationRequestId, {
            state: authorizationTarget,
          });
          authorizationTransitions.push({
            authorizationRequestId,
            from: "pending_adjudication",
            to: authorizationTarget,
          });
        }
      }
      for (const [authorizationRequestId, authorization] of this.authorizations) {
        if (
          authorization.jobId !== target.jobId ||
          authorization.collectionCycle !== target.collectionCycle
        ) continue;
        const status = this.authorizationStatuses.get(authorizationRequestId);
        if (status?.state === "authorized" && status.validity.kind === "valid") {
          this.authorizationStatuses.set(authorizationRequestId, {
            state: "authorized",
            validity: { kind: "invalid", reason, invalidatedAt: at },
          });
          const job = this.jobCycles.get(key);
          invalidatedAuthorizations.push({
            authorizationRequestId,
            classId: job?.classId ?? snapshot.scope.classId,
            jobId: target.jobId,
            collectionCycle: target.collectionCycle,
            reason,
          });
        }
      }
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
        splitObserved: false,
      });
    }
    if (epochTransition !== undefined) {
      this.permitEpochs.set(epochTransition.classId, epochTransition.toEpoch);
    }
    return clone({
      kind: "applied",
      resultTransitions,
      authorizationTransitions,
      invalidatedAuthorizations,
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
    input: Parameters<Store["extendLease"]>[0],
  ): ReturnType<Store["extendLease"]> {
    return this.atomicInput(input, (input) => {
      const lease = this.leases.get(input.leaseId);
      if (
        lease === undefined ||
        !lease.open ||
        lease.holder !== input.workerId ||
        lease.expiresAt !== input.expectedExpiry ||
        lease.extensionsUsed !== input.expectedExtensionsUsed ||
        !Number.isFinite(lease.extensionPolicy.extensionTtl) ||
        lease.extensionPolicy.extensionTtl <= 0 ||
        !Number.isSafeInteger(lease.extensionPolicy.maxExtensionsPerLease) ||
        lease.extensionPolicy.maxExtensionsPerLease < 0 ||
        input.newExtensionsUsed !== lease.extensionsUsed + 1 ||
        input.newExtensionsUsed > lease.extensionPolicy.maxExtensionsPerLease
      ) {
        return { kind: "refused" };
      }
      const expectedNewExpiry =
        Date.parse(lease.expiresAt) + lease.extensionPolicy.extensionTtl * 1_000;
      if (
        !Number.isFinite(expectedNewExpiry) ||
        !Number.isFinite(Date.parse(lease.absoluteInFlightDeadline)) ||
        !Number.isFinite(Date.parse(input.newExpiry)) ||
        Date.parse(input.newExpiry) !== expectedNewExpiry ||
        Date.parse(input.newExpiry) >= Date.parse(lease.absoluteInFlightDeadline)
      ) {
        return { kind: "refused" };
      }
      this.leases.set(input.leaseId, {
        ...lease,
        expiresAt: input.newExpiry,
        extensionsUsed: input.newExtensionsUsed,
      });
      return { kind: "extended", newExpiry: input.newExpiry };
    });
  }

  abandonLease(
    input: Parameters<Store["abandonLease"]>[0],
  ): ReturnType<Store["abandonLease"]> {
    return this.atomicInput(input, (input) => {
      const lease = this.leases.get(input.leaseId);
      if (
        lease === undefined ||
        !lease.open ||
        lease.holder !== input.workerId ||
        lease.permitEpoch !== input.requeue.sameCyclePermitEpoch
      ) {
        return { kind: "refused" };
      }
      this.closeLeaseAttempt(
        lease,
        input.classification !== "provider_or_platform_failure",
      );
      return { kind: "recorded" };
    });
  }

  expireAndRequeue(
    leaseId: string,
    under: Parameters<Store["expireAndRequeue"]>[1],
  ): ReturnType<Store["expireAndRequeue"]> {
    return this.atomicInput({ leaseId, under }, ({ leaseId, under }) => {
      const lease = this.leases.get(leaseId);
      if (
        lease === undefined ||
        !lease.open ||
        lease.permitEpoch !== under.sameCyclePermitEpoch
      ) {
        return;
      }
      this.closeLeaseAttempt(lease, true);
    });
  }

  acceptOrReplaySubmission(
    input: Parameters<Store["acceptOrReplaySubmission"]>[0],
  ): ReturnType<Store["acceptOrReplaySubmission"]> {
    return this.atomicInput(input, (input) => {
      const lease = this.leases.get(input.leaseId);
      if (lease === undefined || lease.holder !== input.workerId) {
        return { kind: "refused", error: "lease_not_held" };
      }
      const accepted = this.acceptedSubmissions.get(input.leaseId);
      if (accepted !== undefined) {
        return accepted.receipt.inputHash === input.inputHash &&
            accepted.receipt.resultHash === input.resultHash
          ? clone({ kind: "replayed", receipt: accepted.receipt })
          : { kind: "conflict" };
      }
      if (!lease.open) return { kind: "refused", error: "lease_not_held" };

      const receiptMatches =
        input.receipt.leaseId === lease.leaseId &&
        input.receipt.jobId === lease.jobId &&
        input.receipt.collectionCycle === lease.collectionCycle &&
        input.receipt.inputHash === input.inputHash &&
        input.receipt.resultHash === input.resultHash &&
        input.receipt.contractVersion === lease.contractVersion &&
        input.receipt.permitEpoch === lease.permitEpoch &&
        input.receipt.outcome === "accepted";
      if (!receiptMatches || input.inputHash !== lease.inputHash) {
        return { kind: "conflict" };
      }

      const acceptedAt = Date.parse(input.receipt.acceptedAt);
      if (
        !Number.isFinite(acceptedAt) ||
        acceptedAt < Date.parse(lease.issuedAt)
      ) return { kind: "conflict" };
      if (
        acceptedAt >= Date.parse(lease.expiresAt) ||
        acceptedAt >= Date.parse(lease.absoluteInFlightDeadline)
      ) {
        this.closeLeaseAttempt(
          lease,
          !FAIR_ATTEMPT_TABLE.lease_expired_no_fault.countsForContribution,
        );
        return { kind: "refused", error: "lease_not_held" };
      }
      const contract = this.classVersions.get(
        pairKey(lease.classId, lease.contractVersion),
      );
      const contractAccepts = contract?.state === "active" ||
        (
          contract?.state === "draining" &&
          contract.acceptedUntil !== undefined &&
          acceptedAt <= Date.parse(contract.acceptedUntil)
        );
      if (!contractAccepts) {
        this.closeLeaseAttempt(
          lease,
          !FAIR_ATTEMPT_TABLE.coordinator_fault.countsForContribution,
        );
        return { kind: "refused", error: "contract_expired" };
      }
      if (
        this.resultStates.get(cycleKey(lease.jobId, lease.collectionCycle)) !==
          "collecting"
      ) return { kind: "refused", error: "lease_not_held" };
      if (
        input.reputationEvidence !== undefined &&
        (
          input.reputationEvidence.workerId !== lease.holder ||
          input.reputationEvidence.job === undefined ||
          input.reputationEvidence.job.jobId !== lease.jobId ||
          input.reputationEvidence.job.collectionCycle !== lease.collectionCycle
        )
      ) return { kind: "evidence_conflict" };
      if (this.evidenceConflict(input.reputationEvidence)) {
        return { kind: "evidence_conflict" };
      }

      this.closeLeaseAttempt(lease, false);
      const persisted = {
        receipt: clone(input.receipt),
        body: clone(input.body),
      };
      this.acceptedSubmissions.set(lease.leaseId, persisted);
      if (lease.assignment.kind === "ordinary") {
        const key = cycleKey(lease.jobId, lease.collectionCycle);
        const attempts = this.attempts.get(key);
        const worker = this.workers.get(lease.holder);
        if (attempts === undefined || worker === undefined) {
          throw new Error(`missing accepted-replica state for ${lease.leaseId}`);
        }
        this.attempts.set(key, {
          ...attempts,
          acceptedWorkerIds: [...attempts.acceptedWorkerIds, lease.holder],
          acceptedDiversity: [
            ...attempts.acceptedDiversity,
            {
              workerId: lease.holder,
              axes: {
                slot: String(worker.slot),
                provider: worker.capabilities.providerSurface,
                accountCluster: worker.accountCluster,
                language: [...worker.capabilities.languages].sort().join(","),
              },
            },
          ],
        });
      }
      this.persistEvidence(input.reputationEvidence);
      return clone({ kind: "accepted", receipt: persisted.receipt });
    });
  }

  rejectSubmission(
    input: Parameters<Store["rejectSubmission"]>[0],
  ): Promise<RejectSubmissionOutcome> {
    return this.atomicInput(input, (input) => {
      const lease = this.leases.get(input.leaseId);
      if (lease === undefined || lease.holder !== input.workerId) {
        return { kind: "refused", error: "lease_not_held" };
      }
      if (this.acceptedSubmissions.has(input.leaseId)) return { kind: "conflict" };
      const history = this.rejectionHistory.get(input.leaseId);
      const inputKey = fingerprint(input);
      if (history !== undefined) {
        return history.input === inputKey
          ? { kind: "replayed" }
          : { kind: "conflict" };
      }
      if (!lease.open) return { kind: "refused", error: "lease_not_held" };
      if (
        input.reputationEvidence !== undefined &&
        (
          input.reputationEvidence.workerId !== lease.holder ||
          input.reputationEvidence.job === undefined ||
          input.reputationEvidence.job.jobId !== lease.jobId ||
          input.reputationEvidence.job.collectionCycle !== lease.collectionCycle
        )
      ) return { kind: "evidence_conflict" };
      if (this.evidenceConflict(input.reputationEvidence)) {
        return { kind: "evidence_conflict" };
      }
      this.closeLeaseAttempt(
        lease,
        !FAIR_ATTEMPT_TABLE[input.classification].countsForContribution,
      );
      this.persistEvidence(input.reputationEvidence);
      const outcome: RejectSubmissionOutcome = { kind: "recorded" };
      this.rejectionHistory.set(input.leaseId, { input: inputKey, outcome });
      return outcome;
    });
  }

  getAcceptedSubmission(
    leaseId: string,
  ): ReturnType<Store["getAcceptedSubmission"]> {
    return this.atomic(() => clone(this.acceptedSubmissions.get(leaseId) ?? null));
  }

  listAcceptedReplicas(
    jobId: string,
    collectionCycle: number,
  ): ReturnType<Store["listAcceptedReplicas"]> {
    return this.atomic(() => clone(this.acceptedReplicasFor(jobId, collectionCycle)));
  }

  markResultSplit(
    input: Parameters<Store["markResultSplit"]>[0],
  ): Promise<MarkResultSplitOutcome> {
    return this.atomicInput(input, (input) => {
      const key = cycleKey(input.jobId, input.collectionCycle);
      const actual = this.resultStates.get(key) ?? null;
      const job = this.jobCycles.get(key);
      const attempts = this.attempts.get(key);
      if (actual !== "collecting" || job?.inputHash !== input.inputHash || attempts === undefined) {
        return { kind: "conflict", actual };
      }
      const expected = [...input.evidence].sort((left, right) =>
        compareWireIds(left.leaseId, right.leaseId)
      );
      const inputKey = fingerprint({
        jobId: input.jobId,
        collectionCycle: input.collectionCycle,
        inputHash: input.inputHash,
        evidence: expected,
      });
      if (attempts.splitObserved) {
        return this.splitHistory.get(key) === inputKey
          ? { kind: "replayed" }
          : { kind: "conflict", actual };
      }
      const evidence = this.acceptedReplicasFor(
        input.jobId,
        input.collectionCycle,
      ).map((replica) => replica.evidence);
      if (expected.length < 2 || !equal(evidence, expected)) {
        return { kind: "conflict", actual };
      }
      this.attempts.set(key, { ...attempts, splitObserved: true });
      this.splitHistory.set(key, inputKey);
      this.candidateRevisions.set(
        key,
        (this.candidateRevisions.get(key) ?? 0) + 1,
      );
      return { kind: "recorded" };
    });
  }

  recordDecisionResult(
    input: Parameters<Store["recordDecisionResult"]>[0],
  ): ReturnType<Store["recordDecisionResult"]> {
    return this.atomicInput(input, (input) => {
      const existing = this.decisions.get(input.decision.decisionResultHash);
      if (existing !== undefined) {
        return equal(existing, input.decision)
          ? { ok: true }
          : { ok: false, actual: this.resultStates.get(cycleKey(
              input.decision.jobId,
              input.decision.collectionCycle,
            )) ?? "collecting" };
      }
      const key = cycleKey(
        input.decision.jobId,
        input.decision.collectionCycle,
      );
      const actual = this.resultStates.get(key) ?? null;
      const job = this.jobCycles.get(key);
      const attempts = this.attempts.get(key);
      const evidence = this.acceptedReplicasFor(
        input.decision.jobId,
        input.decision.collectionCycle,
      ).map((replica) => replica.evidence);
      const expectedEvidence = [...input.decision.evidence].sort((left, right) =>
        compareWireIds(left.leaseId, right.leaseId)
      );
      if (
        actual !== input.transition.from ||
        job === undefined ||
        attempts === undefined ||
        attempts.splitObserved ||
        attempts.openLeaseIds.length > 0 ||
        input.decision.inputHash !== job.inputHash ||
        input.decision.contractVersion !== job.contractVersion ||
        input.decision.permitEpoch !== job.permitEpoch ||
        !equal(evidence, expectedEvidence)
      ) {
        return { ok: false, actual: actual ?? input.transition.from };
      }
      this.decisions.set(
        input.decision.decisionResultHash,
        clone(input.decision),
      );
      this.resultStates.set(key, "verified");
      return { ok: true };
    });
  }

  getDecisionResult(
    decisionResultHash: string,
  ): ReturnType<Store["getDecisionResult"]> {
    return this.atomic(() => clone(this.decisions.get(decisionResultHash) ?? null));
  }

  authorizeOrReplayIntent(
    input: Parameters<Store["authorizeOrReplayIntent"]>[0],
  ): ReturnType<Store["authorizeOrReplayIntent"]> {
    return this.atomicInput(input, (input) => {
      const semantic = {
        authorizationRequestId: input.authorizationRequestId,
        effectIntent: input.effectIntent,
        effectIntentHash: input.effectIntentHash,
        decisionResultHash: input.decisionResultHash,
        decision: input.decision.kind === "deny"
          ? input.decision
          : {
              ...input.decision,
              ...(input.decision.charge === undefined
                ? {}
                : {
                    charge: {
                      ...input.decision.charge,
                      at: undefined,
                    },
                  }),
            },
      };
      const existing = this.effectIntentRecords.get(input.effectIntent.id);
      if (existing !== undefined) {
        const receipt = this.initialReceipts.get(input.effectIntent.id);
        if (receipt === undefined) throw new Error("missing initial receipt");
        return existing.input === fingerprint(semantic)
          ? clone({ kind: "replayed", initialReceipt: receipt })
          : { kind: "conflict" };
      }
      if (this.coreIdentities.has(input.authorizationRequestId)) {
        return { kind: "conflict" };
      }
      const durableDecision = this.decisions.get(input.decisionResultHash);
      if (durableDecision === undefined) return { kind: "conflict" };

      let reserve:
        | ReserveMutation<"charged">
        | ReserveMutation<"exhausted">
        | undefined;
      if (input.decision.kind !== "deny" && input.decision.charge !== undefined) {
        const settlement = this.settleReserve(input.decision.charge);
        if (
          settlement.kind === "reserve_charge_conflict" ||
          settlement.kind === "reserve_policy_conflict"
        ) return settlement;
        reserve = settlement.kind === "charged"
          ? {
              charge: settlement.charge,
              currentPolicy: settlement.currentPolicy,
              classHealth: settlement.classHealth,
            }
          : {
              charge: settlement.charge,
              currentPolicy: settlement.currentPolicy,
              classHealth: settlement.classHealth,
            };
      }
      if (input.decision.kind === "pend" && reserve === undefined) {
        throw new Error("pending adjudication requires a reserve charge");
      }

      let receipt: AuthorizationInitialReceipt;
      if (input.decision.kind === "deny") {
        receipt = {
          authorizationRequestId: input.authorizationRequestId,
          effectIntentId: input.effectIntent.id,
          effectIntentHash: input.effectIntentHash,
          jobId: durableDecision.jobId,
          collectionCycle: durableDecision.collectionCycle,
          decisionResultHash: input.decisionResultHash,
          at: input.at,
          outcome: "denied",
          denialReason: input.decision.reason,
        };
        this.authorizationStatuses.set(input.authorizationRequestId, {
          state: "denied",
          reason: input.decision.reason,
        });
      } else if (input.decision.kind === "authorize" && reserve?.charge.outcome === "exhausted") {
        receipt = {
          authorizationRequestId: input.authorizationRequestId,
          effectIntentId: input.effectIntent.id,
          effectIntentHash: input.effectIntentHash,
          jobId: durableDecision.jobId,
          collectionCycle: durableDecision.collectionCycle,
          decisionResultHash: input.decisionResultHash,
          at: input.at,
          outcome: "denied",
          denialReason: "escalation_budget_exhausted",
        };
        this.authorizationStatuses.set(input.authorizationRequestId, {
          state: "denied",
          reason: "escalation_budget_exhausted",
        });
      } else if (input.decision.kind === "authorize") {
        receipt = {
          authorizationRequestId: input.authorizationRequestId,
          effectIntentId: input.effectIntent.id,
          effectIntentHash: input.effectIntentHash,
          jobId: durableDecision.jobId,
          collectionCycle: durableDecision.collectionCycle,
          decisionResultHash: input.decisionResultHash,
          at: input.at,
          outcome: "authorized",
          authorization: clone(input.decision.authorization),
        };
        this.authorizationStatuses.set(input.authorizationRequestId, {
          state: "authorized",
          validity: { kind: "valid" },
        });
        this.authorizations.set(
          input.authorizationRequestId,
          clone(input.decision.authorization),
        );
      } else {
        receipt = {
          authorizationRequestId: input.authorizationRequestId,
          effectIntentId: input.effectIntent.id,
          effectIntentHash: input.effectIntentHash,
          jobId: durableDecision.jobId,
          collectionCycle: durableDecision.collectionCycle,
          decisionResultHash: input.decisionResultHash,
          at: input.at,
          outcome: "pending_adjudication",
        };
        this.authorizationStatuses.set(input.authorizationRequestId, {
          state: "pending_adjudication",
        });
        this.actionAdjudications.set(input.authorizationRequestId, {
          request: clone(input.decision.request),
          openedAt: input.at,
        });
      }
      this.coreIdentities.set(input.authorizationRequestId, "authorization_request");
      this.effectIntentRecords.set(input.effectIntent.id, {
        input: fingerprint(semantic),
        authorizationRequestId: input.authorizationRequestId,
        effectIntent: clone(input.effectIntent),
        effectIntentHash: input.effectIntentHash,
        decisionResultHash: input.decisionResultHash,
      });
      this.initialReceipts.set(input.effectIntent.id, clone(receipt));
      if (reserve === undefined) {
        return clone({
          kind: "applied",
          initialReceipt: receipt as Exclude<
            AuthorizationInitialReceipt,
            Extract<AuthorizationInitialReceipt, { outcome: "pending_adjudication" }>
          >,
        });
      }
      if (isChargedMutation(reserve)) {
        const chargedReserve: ReserveMutation<"charged"> = reserve;
        return clone({
          kind: "applied",
          initialReceipt: receipt as Extract<
            AuthorizationInitialReceipt,
            { outcome: "authorized" | "pending_adjudication" }
          >,
          reserve: chargedReserve,
        });
      }
      const exhaustedReserve: ReserveMutation<"exhausted"> = reserve;
      return clone({
        kind: "applied",
        initialReceipt: receipt as
          | Extract<AuthorizationInitialReceipt, { outcome: "pending_adjudication" }>
          | (Omit<
              Extract<AuthorizationInitialReceipt, { outcome: "denied" }>,
              "denialReason"
            > & { denialReason: "escalation_budget_exhausted" }),
        reserve: exhaustedReserve,
      });
    });
  }

  getAuthorizationStatus(
    authorizationRequestId: string,
  ): ReturnType<Store["getAuthorizationStatus"]> {
    return this.atomic(() => clone(
      this.authorizationStatuses.get(authorizationRequestId) ?? null,
    ));
  }

  getInitialReceipt(
    effectIntentId: string,
  ): ReturnType<Store["getInitialReceipt"]> {
    return this.atomic(() => clone(this.initialReceipts.get(effectIntentId) ?? null));
  }

  getAuthorization(
    authorizationRequestId: string,
  ): ReturnType<Store["getAuthorization"]> {
    return this.atomic(() => clone(
      this.authorizations.get(authorizationRequestId) ?? null,
    ));
  }

  openResultAdjudication(
    input: Parameters<Store["openResultAdjudication"]>[0],
  ): ReturnType<Store["openResultAdjudication"]> {
    return this.atomicInput(input, (input) => {
      const existing = this.resultAdjudications.get(input.request.id);
      if (existing !== undefined) {
        const same = equal(existing.request, input.request) &&
          equal(
            {
              ...existing.charge.charge.charge,
              at: undefined,
            },
            { ...input.charge, at: undefined },
          );
        if (!same) return { kind: "identity_conflict" };
        return isChargedMutation(existing.charge)
          ? clone({
              kind: "replayed",
              original: "opened_charged",
              openedAt: existing.openedAt,
              ...existing.charge,
            })
          : clone({
              kind: "replayed",
              original: "opened_uncovered",
              openedAt: existing.openedAt,
              ...existing.charge,
            });
      }
      if (this.coreIdentities.has(input.request.id)) {
        return { kind: "identity_conflict" };
      }
      const key = cycleKey(
        input.resultTransition.jobId,
        input.resultTransition.collectionCycle,
      );
      const job = this.jobCycles.get(key);
      if (
        job === undefined ||
        input.request.jobId !== input.resultTransition.jobId ||
        input.request.collectionCycle !== input.resultTransition.collectionCycle ||
        input.request.inputHash !== job.inputHash ||
        input.request.contractVersion !== job.contractVersion ||
        input.request.permitEpoch !== job.permitEpoch
      ) {
        return {
          kind: "state_conflict",
          actual: this.resultStates.get(key) ?? input.resultTransition.from,
        };
      }
      const actual = this.resultStates.get(key);
      if (actual !== input.resultTransition.from) {
        return { kind: "state_conflict", actual: actual ?? input.resultTransition.from };
      }
      const existingCycleRequest = this.resultAdjudicationByCycle.get(key);
      if (existingCycleRequest !== undefined) {
        return { kind: "state_conflict", actual };
      }
      const settlement = this.settleReserve(input.charge);
      if (
        settlement.kind === "reserve_charge_conflict" ||
        settlement.kind === "reserve_policy_conflict"
      ) return settlement;
      const openedAt = input.resultTransition.at;
      this.resultStates.set(key, "pending_result_adjudication");
      this.coreIdentities.set(input.request.id, "result_adjudication_request");
      this.resultAdjudicationByCycle.set(key, input.request.id);
      if (settlement.kind === "charged") {
        const charge: ReserveMutation<"charged"> = {
          charge: settlement.charge,
          currentPolicy: settlement.currentPolicy,
          classHealth: settlement.classHealth,
        };
        this.resultAdjudications.set(input.request.id, {
          request: clone(input.request),
          openedAt,
          state: "pending_result_adjudication",
          charge,
        });
        return clone({ kind: "opened_charged", openedAt, ...charge });
      }
      const charge: ReserveMutation<"exhausted"> = {
        charge: settlement.charge,
        currentPolicy: settlement.currentPolicy,
        classHealth: settlement.classHealth,
      };
      this.resultAdjudications.set(input.request.id, {
        request: clone(input.request),
        openedAt,
        state: "pending_result_adjudication",
        charge,
      });
      return clone({ kind: "opened_uncovered", openedAt, ...charge });
    });
  }

  getResultAdjudicationRequest(
    id: string,
  ): ReturnType<Store["getResultAdjudicationRequest"]> {
    return this.atomic(() => clone(this.resultAdjudications.get(id)?.request ?? null));
  }

  listPendingResultAdjudications(
    classId: string,
  ): ReturnType<Store["listPendingResultAdjudications"]> {
    return this.atomic(() => clone([...this.resultAdjudications.values()]
      .filter((entry) => {
        if (entry.state !== "pending_result_adjudication") return false;
        const job = this.jobCycles.get(cycleKey(
          entry.request.jobId,
          entry.request.collectionCycle,
        ));
        return job?.classId === classId;
      })
      .map(({ request, openedAt }) => ({ request, openedAt }))
      .sort((left, right) =>
        compareWireIds(left.openedAt, right.openedAt) ||
        compareWireIds(left.request.id, right.request.id)
      )));
  }

  applyResultAdjudicationVerdict(
    input: Parameters<Store["applyResultAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyResultAdjudicationVerdict"]> {
    return this.atomicInput(input, (input) => {
      const requestId = input.verdict.resultAdjudicationRequestId;
      const verdictInput = fingerprint({
        verdict: input.verdict,
        verdictHash: input.verdictHash,
        at: input.at,
      });
      const prior = this.verdictHistory.get(requestId);
      if (prior !== undefined) {
        return prior.input === verdictInput
          ? clone({ kind: "replayed", receipt: prior.outcome.receipt })
          : { kind: "conflict" };
      }
      const adjudication = this.resultAdjudications.get(requestId);
      if (adjudication === undefined ||
        adjudication.state !== "pending_result_adjudication") {
        return { kind: "terminal" };
      }
      const request = adjudication.request;
      const verdictMatches =
        input.verdict.reason === request.reason &&
        input.verdict.jobId === request.jobId &&
        input.verdict.collectionCycle === request.collectionCycle &&
        input.verdict.inputHash === request.inputHash &&
        equal(input.verdict.candidateResultHashes, request.candidateResultHashes) &&
        equal(input.verdict.evidence, request.evidence) &&
        input.verdict.contractVersion === request.contractVersion &&
        input.verdict.permitEpoch === request.permitEpoch &&
        input.verdict.decidedAt === input.at &&
        input.verdict.decision.kind === input.decision;
      if (!verdictMatches) return { kind: "conflict" };
      const key = cycleKey(request.jobId, request.collectionCycle);
      if (this.resultStates.get(key) !== "pending_result_adjudication") {
        return { kind: "terminal" };
      }

      let receipt: Extract<VerdictOutcome, { kind: "applied" }>["receipt"];
      if (input.decision === "resolve") {
        const resolved = input.resolved;
        if (
          resolved.jobId !== request.jobId ||
          resolved.collectionCycle !== request.collectionCycle ||
          resolved.inputHash !== request.inputHash ||
          resolved.contractVersion !== request.contractVersion ||
          resolved.permitEpoch !== request.permitEpoch ||
          resolved.resultAdjudicationVerdictHash !== input.verdictHash ||
          !equal(resolved.evidence, request.evidence) ||
          this.decisions.has(resolved.decisionResultHash)
        ) return { kind: "conflict" };
        this.decisions.set(resolved.decisionResultHash, clone(resolved));
        this.resultStates.set(key, "verified");
        adjudication.state = "resolved";
        receipt = {
          requestId,
          verdictHash: input.verdictHash,
          decidedAt: input.at,
          outcome: "resolved",
        };
      } else {
        const job = this.jobCycles.get(key);
        if (job === undefined) return { kind: "terminal" };
        const requeue = job.rejectedDisputeRequeues < input.onReject.cap;
        if (requeue) {
          if (
            input.onReject.newCycleEpoch.length === 0 ||
            input.onReject.newCycleInputHash.length === 0
          ) return { kind: "conflict" };
          const nextCycle = job.collectionCycle + 1;
          const nextKey = cycleKey(job.jobId, nextCycle);
          if (this.jobCycles.has(nextKey)) return { kind: "conflict" };
          this.resultStates.set(key, "rejected");
          adjudication.state = "rejected";
          const next: JobRecord = {
            ...job,
            collectionCycle: nextCycle,
            permitEpoch: input.onReject.newCycleEpoch,
            inputHash: input.onReject.newCycleInputHash,
            cycleStartedAt: input.onReject.cycleStartedAt,
            rejectedDisputeRequeues: job.rejectedDisputeRequeues + 1,
          };
          this.jobs.set(job.jobId, next);
          this.jobCycles.set(nextKey, next);
          this.resultStates.set(nextKey, "collecting");
          this.candidateRevisions.set(nextKey, 1);
          this.attempts.set(nextKey, {
            attemptCount: 0,
            openLeaseIds: [],
            acceptedWorkerIds: [],
            acceptedDiversity: [],
            splitObserved: false,
          });
        } else {
          this.resultStates.set(key, "rejected");
          adjudication.state = "rejected";
        }
        receipt = {
          requestId,
          verdictHash: input.verdictHash,
          decidedAt: input.at,
          outcome: "rejected",
          rejectOutcome: requeue ? "requeued" : "cap_exhausted",
        };
      }
      const outcome: Extract<VerdictOutcome, { kind: "applied" }> = {
        kind: "applied",
        receipt,
      };
      this.resultAdjudications.set(requestId, adjudication);
      this.verdictHistory.set(requestId, { input: verdictInput, outcome: clone(outcome) });
      return clone(outcome);
    });
  }

  getActionAdjudicationRequest(
    authorizationRequestId: string,
  ): ReturnType<Store["getActionAdjudicationRequest"]> {
    return this.atomic(() => clone(
      this.actionAdjudications.get(authorizationRequestId)?.request ?? null,
    ));
  }

  listPendingActionAdjudications(
    classId: string,
  ): ReturnType<Store["listPendingActionAdjudications"]> {
    return this.atomic(() => clone([...this.actionAdjudications.values()]
      .filter((entry) => {
        const status = this.authorizationStatuses.get(
          entry.request.authorizationRequestId,
        );
        const job = this.jobCycles.get(cycleKey(
          entry.request.jobId,
          entry.request.collectionCycle,
        ));
        return status?.state === "pending_adjudication" && job?.classId === classId;
      })
      .sort((left, right) =>
        compareWireIds(left.openedAt, right.openedAt) ||
        compareWireIds(
          left.request.authorizationRequestId,
          right.request.authorizationRequestId,
        )
      )));
  }

  applyActionAdjudicationVerdict(
    input: Parameters<Store["applyActionAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyActionAdjudicationVerdict"]> {
    return this.atomicInput(input, (input) => {
      const requestId = input.verdict.authorizationRequestId;
      const verdictInput = fingerprint({
        verdict: input.verdict,
        verdictHash: input.verdictHash,
        at: input.at,
      });
      const prior = this.verdictHistory.get(requestId);
      if (prior !== undefined) {
        return prior.input === verdictInput
          ? clone({ kind: "replayed", receipt: prior.outcome.receipt })
          : { kind: "conflict" };
      }
      const pending = this.actionAdjudications.get(requestId);
      const status = this.authorizationStatuses.get(requestId);
      if (pending === undefined || status?.state !== "pending_adjudication") {
        return { kind: "terminal" };
      }
      const request = pending.request;
      const verdictMatches =
        input.verdict.jobId === request.jobId &&
        input.verdict.collectionCycle === request.collectionCycle &&
        input.verdict.effectIntentId === request.effectIntent.id &&
        input.verdict.effectIntentHash === request.effectIntentHash &&
        input.verdict.inputHash === request.inputHash &&
        input.verdict.decisionResultHash === request.decisionResultHash &&
        equal(input.verdict.evidence, request.evidence) &&
        input.verdict.resultAdjudicationVerdictHash ===
          request.resultAdjudicationVerdictHash &&
        input.verdict.contractVersion === request.contractVersion &&
        input.verdict.permitEpoch === request.permitEpoch &&
        input.verdict.decidedAt === input.at &&
        input.verdict.decision === input.decision;
      if (!verdictMatches) return { kind: "conflict" };

      const receipt = input.decision === "approve"
        ? {
            requestId,
            verdictHash: input.verdictHash,
            decidedAt: input.at,
            outcome: "approved" as const,
          }
        : {
            requestId,
            verdictHash: input.verdictHash,
            decidedAt: input.at,
            outcome: "denied" as const,
          };
      if (input.decision === "approve") {
        const authorization = input.authorization;
        if (
          authorization.authorizationRequestId !== requestId ||
          authorization.effectIntentId !== request.effectIntent.id ||
          authorization.effectIntentHash !== request.effectIntentHash ||
          authorization.jobId !== request.jobId ||
          authorization.collectionCycle !== request.collectionCycle ||
          authorization.inputHash !== request.inputHash ||
          authorization.decisionResultHash !== request.decisionResultHash ||
          !equal(authorization.evidence, request.evidence) ||
          authorization.resultAdjudicationVerdictHash !==
            request.resultAdjudicationVerdictHash ||
          authorization.actionAdjudicationVerdictHash !== input.verdictHash ||
          authorization.contractVersion !== request.contractVersion ||
          authorization.permitEpoch !== request.permitEpoch ||
          !equal(authorization.actions, input.verdict.actions)
        ) return { kind: "conflict" };
        this.authorizations.set(requestId, clone(authorization));
        this.authorizationStatuses.set(requestId, {
          state: "authorized",
          validity: { kind: "valid" },
        });
      } else {
        this.authorizationStatuses.set(requestId, {
          state: "denied",
          reason: "human_rejected",
        });
      }
      const outcome: Extract<VerdictOutcome, { kind: "applied" }> = {
        kind: "applied",
        receipt,
      };
      this.verdictHistory.set(requestId, { input: verdictInput, outcome: clone(outcome) });
      return clone(outcome);
    });
  }

  chargeReserve(
    charge: Parameters<Store["chargeReserve"]>[0],
  ): ReturnType<Store["chargeReserve"]> {
    return this.atomicInput(charge, (charge) => this.settleReserve(charge));
  }

  getReservePolicy(
    input: Parameters<Store["getReservePolicy"]>[0],
  ): ReturnType<Store["getReservePolicy"]> {
    return this.atomicInput(input, (input) => clone(
      this.reservePolicies.get(this.reservePolicyKey(input)) ?? null,
    ));
  }

  initializeReservePolicy(
    input: Parameters<Store["initializeReservePolicy"]>[0],
  ): ReturnType<Store["initializeReservePolicy"]> {
    return this.atomicInput(input, (input) => {
      const key = this.reservePolicyKey(input.policy);
      const existing = this.reservePolicies.get(key);
      const prior = this.reserveInitializationHistory.get(key);
      if (
        prior?.kind === "initialized" &&
        equal(prior.current.policy, input.policy)
      ) {
        return clone({ ...prior, kind: "replayed" });
      }
      if (existing !== undefined) {
        return clone({ kind: "conflict", current: existing });
      }
      const version = this.classVersions.get(pairKey(
        input.policy.classId,
        input.policy.contractVersion,
      ));
      if (version === undefined) {
        return { kind: "refused", reason: "class_version_not_found" };
      }
      if (version.state === "retired") {
        return { kind: "refused", reason: "class_version_retired" };
      }
      if (!this.classHealth.has(input.policy.classId)) {
        return { kind: "refused", reason: "class_health_missing" };
      }
      if (!this.validReservePolicy(input.policy)) {
        return { kind: "refused", reason: "invalid_policy" };
      }
      const current: ReservePolicyRecord = {
        revision: 1,
        policy: clone(input.policy),
        used: 0,
        workerUsage: [],
        updatedAt: input.at,
      };
      this.reservePolicies.set(key, current);
      this.reserveWindowHistory.set(key, new Set([input.policy.windowId]));
      const classHealth = this.publishReserveHealth(input.policy.classId, input.at);
      const outcome: Awaited<ReturnType<Store["initializeReservePolicy"]>> = {
        kind: "initialized",
        current,
        classHealth,
      };
      this.reserveInitializationHistory.set(key, clone(outcome));
      return clone(outcome);
    });
  }

  transitionReservePolicy(
    input: Parameters<Store["transitionReservePolicy"]>[0],
  ): ReturnType<Store["transitionReservePolicy"]> {
    return this.atomicInput(input, (input) => {
      const replayKey = fingerprint({ expected: input.expected, next: input.next });
      const prior = this.reserveTransitionHistory.get(replayKey);
      if (prior?.kind === "applied") {
        return clone({ ...prior, kind: "replayed" });
      }
      const key = this.reservePolicyKey(input.expected.policy);
      const current = this.reservePolicies.get(key);
      if (current === undefined || !equal(current, input.expected)) {
        if (current === undefined) {
          throw new Error(`reserve policy ${key} is missing`);
        }
        return clone({ kind: "conflict", current });
      }
      const version = this.classVersions.get(pairKey(
        input.next.classId,
        input.next.contractVersion,
      ));
      if (version?.state === "retired") {
        return { kind: "refused", reason: "class_version_retired" };
      }
      if (!this.classHealth.has(input.next.classId)) {
        return { kind: "refused", reason: "class_health_missing" };
      }
      if (
        !this.validReservePolicy(input.next) ||
        this.reservePolicyKey(input.next) !== key
      ) {
        return { kind: "refused", reason: "invalid_policy" };
      }
      const sameWindow = input.next.windowId === current.policy.windowId;
      if (
        sameWindow &&
        (
          input.next.windowStartsAt !== current.policy.windowStartsAt ||
          input.next.windowEndsAt !== current.policy.windowEndsAt
        )
      ) {
        return { kind: "refused", reason: "window_not_forward" };
      }
      const history = this.reserveWindowHistory.get(key) ?? new Set<string>();
      if (
        !sameWindow &&
        (
          history.has(input.next.windowId) ||
          Date.parse(input.next.windowStartsAt) < Date.parse(current.policy.windowEndsAt)
        )
      ) {
        return { kind: "refused", reason: "window_not_forward" };
      }
      const next: ReservePolicyRecord = {
        revision: current.revision + 1,
        policy: clone(input.next),
        used: sameWindow ? current.used : 0,
        workerUsage: sameWindow ? clone(current.workerUsage) : [],
        updatedAt: input.at,
      };
      this.reservePolicies.set(key, next);
      history.add(input.next.windowId);
      this.reserveWindowHistory.set(key, history);
      const classHealth = this.publishReserveHealth(input.next.classId, input.at);
      const outcome: Awaited<ReturnType<Store["transitionReservePolicy"]>> = {
        kind: "applied",
        current: next,
        classHealth,
      };
      this.reserveTransitionHistory.set(replayKey, clone(outcome));
      return clone(outcome);
    });
  }

  appendLedger(
    entry: Parameters<Store["appendLedger"]>[0],
  ): ReturnType<Store["appendLedger"]> {
    return this.atomicInput(entry, (entry) => {
      this.ledger.push(clone(entry));
    });
  }

  recordReputationEvidence(
    record: Parameters<Store["recordReputationEvidence"]>[0],
  ): ReturnType<Store["recordReputationEvidence"]> {
    return this.atomicInput(record, (record) => {
      const existing = this.reputationEvidence.get(record.evidenceId);
      if (existing !== undefined) {
        return equal(existing, record)
          ? { kind: "replayed", record: clone(existing) }
          : { kind: "conflict", existing: clone(existing) };
      }
      this.reputationEvidence.set(record.evidenceId, clone(record));
      return { kind: "recorded", record: clone(record) };
    });
  }

  listReputationEvidence(
    workerId: WorkerId,
  ): ReturnType<Store["listReputationEvidence"]> {
    return this.atomic(() =>
      clone([...this.reputationEvidence.values()]
        .filter((record) => record.workerId === workerId)
        .sort((left, right) =>
          left.at.localeCompare(right.at) ||
          left.evidenceId.localeCompare(right.evidenceId),
        )),
    );
  }
}
