import {
  MUSTER_WIRE_CONTRACT_VERSION,
  TTL_BUCKETS_SECONDS,
  bucketFor,
  canonicalize,
  computeInputHash,
  computeResultHash,
  isWireId,
  sha256Hex,
  validateMusterValue,
  type CanonicalJsonValue,
  type DiversityAxis,
  type JobClass,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";

import type {
  Clock,
  CoreDeploymentPolicy,
  EventSink,
  IdSource,
  JobRecord,
  LeaseAssignment,
  LeaseCandidateSnapshot,
  LeaseRecord,
  QueuePriority,
  ReputationPolicy,
  Store,
  WorkerControlPolicy,
  WorkerRecord,
  WorkerRoutingPeriod,
  WorkerRoutingSnapshot,
} from "./ports.js";
import type {
  RuntimeClassEntry,
  RuntimeClassRegistry,
} from "./registration.js";

const MAX_COMPARE_RETRIES = 8;

const validTimestamp = (value: string): value is Timestamp =>
  value.length > 0 && Number.isFinite(Date.parse(value));

const addSeconds = (at: Timestamp, seconds: number): Timestamp => {
  const value = Date.parse(at) + seconds * 1_000;
  if (!Number.isFinite(value)) throw new Error("timestamp overflow");
  return new Date(value).toISOString();
};

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(canonicalize(value)).byteLength;

const deterministicFraction = async (seed: string): Promise<number> => {
  const digest = await sha256Hex(seed);
  const numerator = Number.parseInt(digest.slice(0, 13), 16);
  return numerator / 0x10_0000_0000_0000;
};

const sameCanonical = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};

const quantizedLeaseTtl = (
  jobClass: JobClass<unknown, unknown>,
  payload: CanonicalJsonValue,
): number | null => {
  let requested: number;
  try {
    requested = jobClass.cost.leaseTtl(payload);
  } catch {
    return null;
  }
  if (
    !Number.isFinite(requested) ||
    requested <= 0 ||
    requested > jobClass.cost.maxLeaseTtl
  ) return null;
  return bucketFor(requested, TTL_BUCKETS_SECONDS);
};

const routingIssue = (period: unknown): boolean => {
  if (typeof period !== "object" || period === null || Array.isArray(period)) {
    return true;
  }
  const candidate = period as Partial<WorkerRoutingPeriod>;
  return !(
    typeof candidate.contributionWindowId === "string" &&
    isWireId(candidate.contributionWindowId) &&
    typeof candidate.assignedSlotOccurrence === "string" &&
    isWireId(candidate.assignedSlotOccurrence) &&
    typeof candidate.slotOpen === "boolean"
  );
};

const intakeRefused = (health: {
  readonly operating: string;
  readonly reserves: {
    readonly urgent: string;
    readonly splitAndAdjudication: string;
    readonly audit: string;
  };
}): boolean =>
  health.operating !== "ready" ||
  health.reserves.urgent === "saturated" ||
  health.reserves.splitAndAdjudication === "saturated" ||
  health.reserves.audit === "saturated";

const capabilityMatches = (
  worker: WorkerRecord,
  jobClass: JobClass<unknown, unknown>,
): boolean => {
  const required = jobClass.requires;
  return worker.capabilities.jobClassIds.includes(jobClass.id) &&
    (required.providerSurfaces === undefined ||
      required.providerSurfaces.includes(worker.capabilities.providerSurface)) &&
    (required.unattendedScheduling !== true ||
      worker.capabilities.unattendedScheduling) &&
    (required.languages === undefined ||
      required.languages.every((language) =>
        worker.capabilities.languages.includes(language)
      ));
};

const workerAxis = (
  worker: WorkerRecord,
  axis: DiversityAxis,
): string | null => {
  switch (axis) {
    case "slot":
      return String(worker.slot);
    case "provider":
      return worker.capabilities.providerSurface;
    case "accountCluster":
      return worker.accountCluster;
    case "language":
      return [...worker.capabilities.languages].sort().join(",");
    case "modelFamily":
      return null;
  }
};

const diversityFeasible = (
  worker: WorkerRecord,
  candidate: LeaseCandidateSnapshot,
  jobClass: JobClass<unknown, unknown>,
): boolean => {
  const rule = jobClass.diversity;
  if (rule === undefined) return true;
  const acceptedCount = candidate.attempts.acceptedWorkerIds.length;
  const remainingAfterClaim = Math.max(
    0,
    jobClass.replication.target - acceptedCount - 1,
  );
  return rule.axes.every((axis) => {
    const value = workerAxis(worker, axis);
    if (value === null) return false;
    const distinct = new Set(
      candidate.attempts.acceptedDiversity.flatMap((fact) => {
        const accepted = fact.axes[axis];
        return accepted === undefined ? [] : [accepted];
      }),
    );
    distinct.add(value);
    return distinct.size + remainingAfterClaim >= rule.minDistinct;
  });
};

const comparePriority = (
  left: LeaseCandidateSnapshot,
  right: LeaseCandidateSnapshot,
): number => {
  const leftLane = left.job.queuePriority.lane === "urgent" ? 1 : 0;
  const rightLane = right.job.queuePriority.lane === "urgent" ? 1 : 0;
  return rightLane - leftLane ||
    right.job.queuePriority.value - left.job.queuePriority.value ||
    left.job.queuePriority.enqueuedAt.localeCompare(
      right.job.queuePriority.enqueuedAt,
    ) ||
    left.job.queuePriority.sequence.localeCompare(right.job.queuePriority.sequence) ||
    left.job.jobId.localeCompare(right.job.jobId);
};

export interface EnqueueJobInput {
  readonly jobId: string;
  readonly classId: string;
  readonly contractVersion: string;
  readonly rawPayload: unknown;
  readonly policyVersion: string;
  readonly priority: {
    readonly lane: QueuePriority["lane"];
    readonly value: number;
    readonly sequence: string;
  };
  readonly notBefore?: Timestamp;
  readonly at?: Timestamp;
}

export type EnqueueJobResult =
  | {
      readonly ok: true;
      readonly kind: "enqueued" | "replayed";
      readonly job: JobRecord;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "conflict" | "refused";
      readonly reason: string;
    };

export type LeaseJobResult =
  | {
      readonly outcome: "lease";
      readonly lease: LeaseRecord;
      readonly payload: CanonicalJsonValue;
    }
  | { readonly outcome: "no_work" };

export type ExtendLeaseResult =
  | { readonly outcome: "extended"; readonly newExpiry: Timestamp }
  | { readonly outcome: "refused" };

export type AbandonLeaseResult =
  | { readonly outcome: "recorded" }
  | { readonly outcome: "refused" };

/** M2 Task-4 deterministic enqueue, routing, and lease lifecycle. */
export class LeaseService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly ids: IdSource;
    readonly events: EventSink;
    readonly workerPolicy: WorkerControlPolicy;
    readonly reputationPolicy: ReputationPolicy;
    readonly deploymentPolicy: CoreDeploymentPolicy;
  }) {}

  async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    const at = input.at ?? this.options.clock.now();
    if (
      !isWireId(input.jobId) ||
      !isWireId(input.classId) ||
      !isWireId(input.contractVersion) ||
      !isWireId(input.policyVersion) ||
      !isWireId(input.priority.sequence) ||
      (input.priority.lane !== "normal" && input.priority.lane !== "urgent") ||
      !Number.isSafeInteger(input.priority.value) ||
      !validTimestamp(at) ||
      (input.notBefore !== undefined && !validTimestamp(input.notBefore))
    ) {
      return { ok: false, kind: "invalid", reason: "enqueue_input_invalid" };
    }

    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      input.classId,
      input.contractVersion,
    );
    if (!compatibility.ok) {
      return { ok: false, kind: "invalid", reason: "runtime_not_compatible" };
    }
    let payload: CanonicalJsonValue;
    try {
      const sanitized = compatibility.entry.jobClass.sanitize(input.rawPayload);
      const validation = validateMusterValue(
        compatibility.entry.jobClass.payloadSchema,
        sanitized,
      );
      if (!validation.ok) {
        return { ok: false, kind: "invalid", reason: "payload_schema_invalid" };
      }
      if (byteLength(sanitized) > compatibility.entry.jobClass.maxPayloadBytes) {
        return { ok: false, kind: "invalid", reason: "payload_too_large" };
      }
      payload = structuredClone(sanitized) as CanonicalJsonValue;
    } catch {
      return { ok: false, kind: "invalid", reason: "payload_sanitization_failed" };
    }
    if (quantizedLeaseTtl(compatibility.entry.jobClass, payload) === null) {
      return { ok: false, kind: "invalid", reason: "lease_ttl_out_of_range" };
    }

    const existing = await this.options.store.getJob(input.jobId);
    if (existing !== null) {
      const existingPayload = await this.options.store.getPayload(existing.payloadRef);
      const replayHash = await computeInputHash({
        payload,
        payload_schema: compatibility.entry.jobClass.payloadSchema,
        job_class_id: input.classId,
        contract_version: input.contractVersion,
        output_schema: compatibility.entry.jobClass.outputSchema,
        policy_version: input.policyVersion,
        permit_epoch: existing.permitEpoch,
      });
      const replay =
        existing.classId === input.classId &&
        existing.contractVersion === input.contractVersion &&
        existing.inputHash === replayHash &&
        existing.policyVersion === input.policyVersion &&
        existing.notBefore === input.notBefore &&
        existing.queuePriority.lane === input.priority.lane &&
        existing.queuePriority.value === input.priority.value &&
        existing.queuePriority.sequence === input.priority.sequence &&
        sameCanonical(existingPayload, payload);
      return replay
        ? { ok: true, kind: "replayed", job: existing }
        : { ok: false, kind: "conflict", reason: "job_id_conflict" };
    }

    const durable = await this.options.store.getClassVersion(
      input.classId,
      input.contractVersion,
    );
    if (durable?.state !== "active") {
      return { ok: false, kind: "refused", reason: "leasing_disabled" };
    }
    const permitEpoch = await this.options.store.getCurrentPermitEpoch(input.classId);
    if (permitEpoch === null) {
      return { ok: false, kind: "refused", reason: "permit_epoch_missing" };
    }
    const queue = await this.options.store.getQueueMode();
    const health = await this.options.store.getClassHealth(input.classId);
    if (health === null) {
      return { ok: false, kind: "refused", reason: "class_health_missing" };
    }
    if (
      queue.mode === "admission_halted" ||
      queue.mode === "emergency_halted" ||
      intakeRefused(health.health)
    ) {
      return { ok: false, kind: "refused", reason: "operational_state" };
    }
    const inputHash = await computeInputHash({
      payload,
      payload_schema: compatibility.entry.jobClass.payloadSchema,
      job_class_id: input.classId,
      contract_version: input.contractVersion,
      output_schema: compatibility.entry.jobClass.outputSchema,
      policy_version: input.policyVersion,
      permit_epoch: permitEpoch,
    });

    const job: JobRecord = {
      jobId: input.jobId,
      classId: input.classId,
      contractVersion: input.contractVersion,
      inputHash,
      payloadRef: input.jobId,
      policyVersion: input.policyVersion,
      permitEpoch,
      collectionCycle: 1,
      ...(input.notBefore === undefined ? {} : { notBefore: input.notBefore }),
      firstEnqueuedAt: at,
      cycleStartedAt: at,
      rejectedDisputeRequeues: 0,
      queuePriority: {
        lane: input.priority.lane,
        value: input.priority.value,
        enqueuedAt: at,
        sequence: input.priority.sequence,
      },
    };
    const outcome = await this.options.store.enqueueJob({
      job,
      payload,
      expectedOperationalState: {
        queueRevision: queue.revision,
        classHealthRevision: health.revision,
      },
    });
    if (outcome.kind === "enqueued" || outcome.kind === "replayed") {
      return { ok: true, kind: outcome.kind, job };
    }
    if (outcome.kind === "refused" || outcome.kind === "operational_state_conflict") {
      return { ok: false, kind: "refused", reason: "operational_state" };
    }
    return { ok: false, kind: "conflict", reason: "job_id_conflict" };
  }

  async leaseJob(workerId: WorkerId): Promise<LeaseJobResult> {
    const at = this.options.clock.now();
    if (!isWireId(workerId) || !validTimestamp(at)) return { outcome: "no_work" };

    for (let retry = 0; retry < MAX_COMPARE_RETRIES; retry += 1) {
      const worker = await this.options.store.getWorker(workerId);
      if (
        worker === null ||
        (worker.state !== "enrolled" && worker.state !== "active") ||
        worker.contractAcceptance.contractVersion !== MUSTER_WIRE_CONTRACT_VERSION
      ) {
        return { outcome: "no_work" };
      }
      let routing = await this.options.store.getWorkerRoutingSnapshot(workerId);
      if (routing === null) return { outcome: "no_work" };

      let period: WorkerRoutingPeriod;
      try {
        const candidate = this.options.workerPolicy.routingAt({
          workerId,
          slot: worker.slot,
          at,
        });
        if (routingIssue(candidate)) return { outcome: "no_work" };
        period = candidate;
      } catch {
        return { outcome: "no_work" };
      }
      if (
        routing.contributionWindowId !== period.contributionWindowId ||
        routing.assignedSlotOccurrence !== period.assignedSlotOccurrence
      ) {
        const transitioned = await this.options.store.transitionWorkerRouting({
          expected: routing,
          next: {
            contributionWindowId: period.contributionWindowId,
            contributionUsed:
              routing.contributionWindowId === period.contributionWindowId
                ? routing.contributionUsed
                : 0,
            assignedSlotOccurrence: period.assignedSlotOccurrence,
          },
        });
        if (transitioned.kind === "conflict") continue;
        routing = transitioned.current;
      }
      if (!period.slotOpen || routing.contributionUsed >= worker.declaredCapPerWeek) {
        return { outcome: "no_work" };
      }

      const assessment = await this.assessWorker(worker);
      if (!assessment.eligible) {
        const noWork = await this.recordNoWork(worker, routing, at);
        if (noWork !== null) return noWork;
        continue;
      }

      const candidates = await this.options.store.listLeaseCandidates({
        classIds: worker.capabilities.jobClassIds,
      });
      const eligible = candidates
        .filter((candidate) =>
          this.candidateEligible(candidate, worker, at)
        )
        .sort(comparePriority);
      let candidate: LeaseCandidateSnapshot | undefined;
      let entry: RuntimeClassEntry | null = null;
      let jobPayload: CanonicalJsonValue | null = null;
      for (const eligibleCandidate of eligible) {
        const compatible = await this.compatibleEntry(eligibleCandidate);
        if (compatible === null) continue;
        const payload = await this.options.store.getPayload(
          eligibleCandidate.job.payloadRef,
        );
        if (payload === null) continue;
        candidate = eligibleCandidate;
        entry = compatible;
        jobPayload = payload;
        break;
      }
      if (candidate === undefined || entry === null || jobPayload === null) {
        const noWork = await this.recordNoWork(worker, routing, at);
        if (noWork !== null) return noWork;
        continue;
      }

      const leaseId = this.options.ids.next("lease");
      if (!isWireId(leaseId)) return { outcome: "no_work" };
      const operational = await this.prepareOperationalPayload(
        entry,
        candidate,
        worker,
        leaseId,
        jobPayload,
      );
      if (operational === null) {
        const noWork = await this.recordNoWork(worker, routing, at);
        if (noWork !== null) return noWork;
        continue;
      }
      const lease = this.prepareLease(
        candidate,
        routing,
        leaseId,
        workerId,
        at,
        entry.jobClass,
        operational.inputHash,
        operational.payloadRef,
        operational.assignment,
        operational.payload,
      );
      if (lease === null) {
        const noWork = await this.recordNoWork(worker, routing, at);
        if (noWork !== null) return noWork;
        continue;
      }

      const claimed = await this.options.store.compareAndClaimLease({
        expectedCandidate: candidate,
        expectedWorker: routing,
        preparedLease: lease,
        preparedPayload: operational.payload,
      });
      if (claimed.kind === "conflict") continue;
      this.options.events.emit({
        type: "lease",
        at,
        classId: lease.classId,
        jobId: lease.jobId,
        collectionCycle: lease.collectionCycle,
        leaseId: lease.leaseId,
        workerId,
        providerSurface: worker.capabilities.providerSurface,
        contractVersion: lease.contractVersion,
        permitEpoch: lease.permitEpoch,
        canary: lease.assignment.kind === "canary",
      });
      return { outcome: "lease", lease: claimed.lease, payload: operational.payload };
    }
    return this.accountFinalNoWork(workerId, at);
  }

  async extendLease(
    workerId: WorkerId,
    leaseId: string,
  ): Promise<ExtendLeaseResult> {
    const at = this.options.clock.now();
    const lease = await this.options.store.getLease(leaseId);
    const resolved = lease === null
      ? { resolved: false as const }
      : {
          resolved: true as const,
          classId: lease.classId,
          jobId: lease.jobId,
          collectionCycle: lease.collectionCycle,
          contractVersion: lease.contractVersion,
        };
    const refuse = (): ExtendLeaseResult => {
      this.options.events.emit({
        type: "lease_extend",
        at,
        leaseId,
        workerId,
        outcome: "refused",
        lease: resolved,
      });
      return { outcome: "refused" };
    };
    if (
      lease === null ||
      !lease.open ||
      lease.holder !== workerId ||
      Date.parse(at) >= Date.parse(lease.expiresAt)
    ) return refuse();
    const newExpiry = addSeconds(
      lease.expiresAt,
      lease.extensionPolicy.extensionTtl,
    );
    const contract = await this.options.store.getClassVersion(
      lease.classId,
      lease.contractVersion,
    );
    const contractAcceptsExtension = contract?.state === "active" ||
      (
        contract?.state === "draining" &&
        contract.acceptedUntil !== undefined &&
        Date.parse(at) <= Date.parse(contract.acceptedUntil) &&
        Date.parse(newExpiry) <= Date.parse(contract.acceptedUntil)
      );
    if (
      !contractAcceptsExtension ||
      Date.parse(newExpiry) >= Date.parse(lease.absoluteInFlightDeadline)
    ) {
      return refuse();
    }
    const result = await this.options.store.extendLease({
      workerId,
      leaseId,
      expectedExpiry: lease.expiresAt,
      expectedExtensionsUsed: lease.extensionsUsed,
      newExpiry,
      newExtensionsUsed: lease.extensionsUsed + 1,
    });
    if (result.kind === "refused") return refuse();
    this.options.events.emit({
      type: "lease_extend",
      at,
      leaseId,
      workerId,
      outcome: "extended",
      classId: lease.classId,
      jobId: lease.jobId,
      collectionCycle: lease.collectionCycle,
    });
    return { outcome: "extended", newExpiry: result.newExpiry };
  }

  async abandonLease(
    workerId: WorkerId,
    leaseId: string,
    classification:
      | "abandoned_before_payload"
      | "abandoned_after_payload"
      | "provider_or_platform_failure",
  ): Promise<AbandonLeaseResult> {
    const lease = await this.options.store.getLease(leaseId);
    if (lease === null || !lease.open || lease.holder !== workerId) {
      return { outcome: "refused" };
    }
    const at = this.options.clock.now();
    const outcome = await this.options.store.abandonLease({
      workerId,
      leaseId,
      classification,
      requeue: { sameCyclePermitEpoch: lease.permitEpoch },
      at,
    });
    if (outcome.kind === "refused") return { outcome: "refused" };
    if (classification === "abandoned_after_payload") {
      this.options.events.emit({
        type: "suspicion",
        at,
        classId: lease.classId,
        workerId,
        signal: classification,
      });
    }
    return { outcome: "recorded" };
  }

  async expireLease(leaseId: string): Promise<boolean> {
    const lease = await this.options.store.getLease(leaseId);
    const at = this.options.clock.now();
    if (lease === null || !lease.open || Date.parse(at) < Date.parse(lease.expiresAt)) {
      return false;
    }
    await this.options.store.expireAndRequeue(leaseId, {
      sameCyclePermitEpoch: lease.permitEpoch,
    });
    return true;
  }

  private async assessWorker(worker: WorkerRecord): Promise<{
    eligible: boolean;
    priority: number;
  }> {
    try {
      const result = this.options.reputationPolicy.assess({
        worker,
        evidence: await this.options.store.listReputationEvidence(worker.workerId),
      });
      return Number.isFinite(result.priority)
        ? result
        : { eligible: false, priority: 0 };
    } catch {
      return { eligible: false, priority: 0 };
    }
  }

  private candidateEligible(
    candidate: LeaseCandidateSnapshot,
    worker: WorkerRecord,
    at: Timestamp,
  ): boolean {
    if (
      candidate.job.notBefore !== undefined &&
      Date.parse(candidate.job.notBefore) > Date.parse(at)
    ) return false;
    if (
      candidate.attempts.openLeaseIds.length > 0 ||
      candidate.attempts.acceptedWorkerIds.includes(worker.workerId)
    ) return false;
    const entry = this.options.registry.get(
      candidate.job.classId,
      candidate.job.contractVersion,
    );
    const acceptedLimit = entry === null
      ? 0
      : entry.jobClass.replication.target +
        (candidate.attempts.splitObserved
          ? entry.jobClass.replication.maxSplitEvidenceReroutes
          : 0);
    return entry !== null &&
      candidate.attempts.acceptedWorkerIds.length < acceptedLimit &&
      capabilityMatches(worker, entry.jobClass) &&
      diversityFeasible(worker, candidate, entry.jobClass);
  }

  private async compatibleEntry(
    candidate: LeaseCandidateSnapshot,
  ): Promise<RuntimeClassEntry | null> {
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      candidate.job.classId,
      candidate.job.contractVersion,
    );
    return compatibility.ok ? compatibility.entry : null;
  }

  private async prepareOperationalPayload(
    entry: RuntimeClassEntry,
    candidate: LeaseCandidateSnapshot,
    worker: WorkerRecord,
    leaseId: string,
    jobPayload: CanonicalJsonValue,
  ): Promise<{
    payload: CanonicalJsonValue;
    inputHash: string;
    payloadRef: string;
    assignment: LeaseAssignment;
  } | null> {
    const source = entry.jobClass.canaries;
    if (source !== undefined) {
      const seed = [
        candidate.job.jobId,
        candidate.job.collectionCycle,
        candidate.attempts.attemptCount + 1,
        worker.workerId,
        leaseId,
      ].join(":");
      try {
        const { probationQ, productionQ, auditQ } = source.rates;
        if (
          ![probationQ, productionQ, auditQ].every((rate) =>
            Number.isFinite(rate) && rate >= 0 && rate <= 1
          ) ||
          productionQ + auditQ > 1
        ) return null;
        const fraction = await deterministicFraction(seed);
        const kind = worker.state === "enrolled"
          ? (fraction < probationQ ? "probation" : null)
          : fraction < auditQ
            ? "audit"
            : fraction < auditQ + productionQ
              ? "production"
              : null;
        if (kind !== null) {
          const drawn = source.draw(kind, seed);
          if (drawn !== null) {
            const payloadValidation = validateMusterValue(
              entry.jobClass.payloadSchema,
              drawn.payload,
            );
            const resultValidation = validateMusterValue(
              entry.jobClass.outputSchema,
              drawn.expected,
            );
            if (
              !isWireId(drawn.canaryId) ||
              !isWireId(drawn.sourceJobId) ||
              !isWireId(drawn.contractVersion) ||
              drawn.contractVersion !== candidate.job.contractVersion ||
              !payloadValidation.ok ||
              !resultValidation.ok ||
              byteLength(drawn.payload) > entry.jobClass.maxPayloadBytes
            ) return null;
            const payload = structuredClone(drawn.payload) as CanonicalJsonValue;
            return {
              payload,
              inputHash: await computeInputHash({
                payload,
                payload_schema: entry.jobClass.payloadSchema,
                job_class_id: candidate.job.classId,
                contract_version: candidate.job.contractVersion,
                output_schema: entry.jobClass.outputSchema,
                policy_version: candidate.job.policyVersion,
                permit_epoch: candidate.job.permitEpoch,
              }),
              payloadRef: leaseId,
              assignment: {
                kind: "canary",
                canaryKind: kind,
                canaryId: drawn.canaryId,
                sourceJobId: drawn.sourceJobId,
                sourceContractVersion: drawn.contractVersion,
                expectedResultHash: await computeResultHash(
                  structuredClone(drawn.expected) as CanonicalJsonValue,
                ),
              },
            };
          }
        }
      } catch {
        return null;
      }
    }
    return {
      payload: jobPayload,
      inputHash: candidate.job.inputHash,
      payloadRef: candidate.job.payloadRef,
      assignment: { kind: "ordinary" },
    };
  }

  private prepareLease(
    candidate: LeaseCandidateSnapshot,
    routing: WorkerRoutingSnapshot,
    leaseId: string,
    workerId: WorkerId,
    at: Timestamp,
    jobClass: JobClass<unknown, unknown>,
    inputHash: string,
    payloadRef: string,
    assignment: LeaseAssignment,
    payload: CanonicalJsonValue,
  ): LeaseRecord | null {
    const deployment = this.options.deploymentPolicy;
    if (
      !isWireId(deployment.version) ||
      !Number.isFinite(deployment.extensionTtl) ||
      deployment.extensionTtl <= 0 ||
      !Number.isSafeInteger(deployment.maxExtensionsPerLease) ||
      deployment.maxExtensionsPerLease < 0 ||
      !Number.isFinite(jobClass.cost.maxInFlightLifetime) ||
      jobClass.cost.maxInFlightLifetime <= 0 ||
      !validTimestamp(candidate.job.cycleStartedAt)
    ) return null;
    const ttl = quantizedLeaseTtl(jobClass, payload);
    if (
      ttl === null ||
      ttl + deployment.extensionTtl * deployment.maxExtensionsPerLease >=
        jobClass.cost.maxInFlightLifetime
    ) return null;
    const expiresAt = addSeconds(at, ttl);
    const absoluteInFlightDeadline = addSeconds(
      candidate.job.cycleStartedAt,
      jobClass.cost.maxInFlightLifetime,
    );
    if (Date.parse(expiresAt) >= Date.parse(absoluteInFlightDeadline)) return null;
    return {
      leaseId,
      jobId: candidate.job.jobId,
      collectionCycle: candidate.job.collectionCycle,
      classId: candidate.job.classId,
      holder: workerId,
      inputHash,
      contractVersion: candidate.job.contractVersion,
      policyVersion: candidate.job.policyVersion,
      permitEpoch: candidate.job.permitEpoch,
      payloadRef,
      issuedAt: at,
      expiresAt,
      absoluteInFlightDeadline,
      extensionsUsed: 0,
      extensionPolicy: structuredClone(deployment),
      snapshot: {
        maxResultBytes: jobClass.maxResultBytes,
        maxPayloadBytes: jobClass.maxPayloadBytes,
      },
      assignment,
      routing: {
        candidateRevision: candidate.revision,
        workerRevision: routing.revision,
        operational: candidate.operational,
        contributionWindowId: routing.contributionWindowId,
        contributionOrdinal: routing.contributionUsed + 1,
        assignedSlotOccurrence: routing.assignedSlotOccurrence,
        attemptNumber: candidate.attempts.attemptCount + 1,
        queuePriority: candidate.job.queuePriority,
      },
      open: true,
    };
  }

  private async recordNoWork(
    worker: WorkerRecord,
    routing: WorkerRoutingSnapshot,
    at: Timestamp,
  ): Promise<LeaseJobResult | null> {
    const outcome = await this.options.store.recordNoWorkAttempt({
      expectedWorker: routing,
      at,
    });
    if (outcome.kind === "recorded") return { outcome: "no_work" };
    const currentWorker = await this.options.store.getWorker(worker.workerId);
    if (
      currentWorker === null ||
      (currentWorker.state !== "enrolled" && currentWorker.state !== "active") ||
      outcome.current.contributionUsed >= currentWorker.declaredCapPerWeek
    ) {
      return { outcome: "no_work" };
    }
    return null;
  }

  private async accountFinalNoWork(
    workerId: WorkerId,
    at: Timestamp,
  ): Promise<LeaseJobResult> {
    for (let retry = 0; retry < MAX_COMPARE_RETRIES; retry += 1) {
      const worker = await this.options.store.getWorker(workerId);
      const routing = await this.options.store.getWorkerRoutingSnapshot(workerId);
      if (
        worker === null ||
        routing === null ||
        (worker.state !== "enrolled" && worker.state !== "active") ||
        routing.contributionUsed >= worker.declaredCapPerWeek
      ) return { outcome: "no_work" };
      let period: WorkerRoutingPeriod;
      try {
        const prepared = this.options.workerPolicy.routingAt({
          workerId,
          slot: worker.slot,
          at,
        });
        if (routingIssue(prepared)) return { outcome: "no_work" };
        period = prepared;
      } catch {
        return { outcome: "no_work" };
      }
      if (!period.slotOpen) return { outcome: "no_work" };
      if (
        routing.contributionWindowId !== period.contributionWindowId ||
        routing.assignedSlotOccurrence !== period.assignedSlotOccurrence
      ) {
        await this.options.store.transitionWorkerRouting({
          expected: routing,
          next: {
            contributionWindowId: period.contributionWindowId,
            contributionUsed:
              routing.contributionWindowId === period.contributionWindowId
                ? routing.contributionUsed
                : 0,
            assignedSlotOccurrence: period.assignedSlotOccurrence,
          },
        });
        continue;
      }
      const outcome = await this.options.store.recordNoWorkAttempt({
        expectedWorker: routing,
        at,
      });
      if (outcome.kind === "recorded") return { outcome: "no_work" };
    }
    return { outcome: "no_work" };
  }
}
