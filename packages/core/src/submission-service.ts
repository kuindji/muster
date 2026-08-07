import {
  canonicalize,
  computeDecisionResultHash,
  computeResultHash,
  isWireId,
  pathsCover,
  validateMusterValue,
  type AutomaticVerificationStrength,
  type CanonicalJsonValue,
  type JobClass,
  type OracleSpec,
  type OracleVerdict,
  type SubmissionEvidence,
  type SubmissionReceipt,
  type Timestamp,
  type WorkerId,
  type WorkerWireErrorCode,
} from "@kuindji/muster-contract";

import type { AuditLeaseIdentity } from "./events.js";
import type {
  Clock,
  DecisionResultRecord,
  EventSink,
  IdSource,
  LeaseCandidateSnapshot,
  LeaseRecord,
  ReputationEvidenceRecord,
  ReputationEvidenceSource,
  Store,
} from "./ports.js";
import type {
  RuntimeClassEntry,
  RuntimeClassRegistry,
} from "./registration.js";

const MAX_SETTLEMENT_RETRIES = 8;

const byteLength = (canonical: string): number =>
  new TextEncoder().encode(canonical).byteLength;

const validTimestamp = (value: string): value is Timestamp =>
  value.length > 0 && Number.isFinite(Date.parse(value));

const validVerdict = (value: unknown): value is OracleVerdict => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const verdict = value as Partial<OracleVerdict>;
  return verdict.kind === "pass" ||
    (verdict.kind === "fail" && typeof verdict.code === "string");
};

const evidenceByLeaseId = (
  replicas: Awaited<ReturnType<Store["listAcceptedReplicas"]>>,
): SubmissionEvidence[] => replicas.map((replica) => replica.evidence);

const resolvedLeaseIdentity = (lease: LeaseRecord): AuditLeaseIdentity => ({
  resolved: true,
  classId: lease.classId,
  jobId: lease.jobId,
  collectionCycle: lease.collectionCycle,
  contractVersion: lease.contractVersion,
});

const requirementCovered = (
  requirement: NonNullable<JobClass<unknown, unknown>["resultEvidenceRequirement"]>,
  oracle: OracleSpec<unknown, unknown>,
): boolean =>
  oracle.kind === "support" &&
  oracle.predicates.includes(requirement.predicate) &&
  pathsCover(oracle.coversPayloadPaths, requirement.requiredPayloadPaths) &&
  pathsCover(oracle.coversResultPaths, requirement.requiredResultPaths);

interface VerificationOutcome {
  readonly ok: boolean;
  readonly achievedStrength: AutomaticVerificationStrength;
  readonly coordinatorFault?: boolean;
  readonly failureSource?: Extract<
    ReputationEvidenceSource,
    "structural_failure" | "validator_failure" | "deterministic_oracle" | "completeness_oracle"
  >;
  readonly checked: boolean;
}

export type SubmitResult =
  | { readonly ok: true; readonly receipt: SubmissionReceipt }
  | { readonly ok: false; readonly error: WorkerWireErrorCode };

/** M2 Task-5 submission settlement and automatic verification pipeline. */
export class SubmissionService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly ids: IdSource;
    readonly events: EventSink;
  }) {}

  async submitResult(
    workerId: WorkerId,
    leaseId: string,
    inputHash: string,
    result: unknown,
  ): Promise<SubmitResult> {
    const at = this.options.clock.now();
    const lease = isWireId(workerId) && isWireId(leaseId)
      ? await this.options.store.getLease(leaseId)
      : null;
    if (
      lease === null ||
      lease.holder !== workerId ||
      !validTimestamp(at)
    ) {
      return this.refuse(workerId, leaseId, "lease_not_held", at, lease);
    }

    let canonical: string;
    let body: CanonicalJsonValue;
    try {
      canonical = canonicalize(result);
      body = structuredClone(result) as CanonicalJsonValue;
    } catch {
      return this.rejectInvalid(
        workerId,
        lease,
        "invalid_result",
        "structural_failure",
        at,
      );
    }
    if (byteLength(canonical) > lease.snapshot.maxResultBytes) {
      return this.rejectInvalid(
        workerId,
        lease,
        "result_too_large",
        "structural_failure",
        at,
      );
    }

    const resultHash = await computeResultHash(body);
    const accepted = await this.options.store.getAcceptedSubmission(leaseId);
    if (accepted !== null) {
      if (
        accepted.receipt.inputHash === inputHash &&
        accepted.receipt.resultHash === resultHash
      ) {
        this.emitSubmit(workerId, lease, "replayed", accepted.receipt.resultHash, at);
        return { ok: true, receipt: accepted.receipt };
      }
      this.emitSuspicion(lease, workerId, "submission_conflict", at);
      return this.refuse(workerId, leaseId, "submission_conflict", at, lease);
    }

    if (inputHash !== lease.inputHash) {
      return this.rejectInvalid(
        workerId,
        lease,
        "input_hash_mismatch",
        "structural_failure",
        at,
        resultHash,
      );
    }

    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      lease.classId,
      lease.contractVersion,
    );
    if (!compatibility.ok) {
      return this.rejectCoordinatorFault(workerId, lease, at);
    }
    const payload = await this.options.store.getPayload(lease.payloadRef);
    if (payload === null) {
      return this.rejectCoordinatorFault(workerId, lease, at);
    }

    const verification = this.verify(
      compatibility.entry.jobClass,
      payload,
      body,
    );
    if (!verification.ok) {
      if (verification.coordinatorFault) {
        return this.rejectCoordinatorFault(workerId, lease, at);
      }
      return this.rejectInvalid(
        workerId,
        lease,
        "invalid_result",
        verification.failureSource ?? "structural_failure",
        at,
        resultHash,
      );
    }

    const evidence = this.acceptanceEvidence(
      lease,
      verification,
      resultHash,
      at,
    );
    if (evidence === null) {
      return this.rejectCoordinatorFault(workerId, lease, at);
    }
    const receipt: SubmissionReceipt = {
      leaseId,
      jobId: lease.jobId,
      collectionCycle: lease.collectionCycle,
      inputHash,
      resultHash,
      contractVersion: lease.contractVersion,
      permitEpoch: lease.permitEpoch,
      outcome: "accepted",
      acceptedAt: at,
    };
    const outcome = await this.options.store.acceptOrReplaySubmission({
      workerId,
      leaseId,
      inputHash,
      resultHash,
      body,
      receipt,
      ...(evidence === undefined ? {} : { reputationEvidence: evidence }),
    });
    if (outcome.kind === "accepted" || outcome.kind === "replayed") {
      this.emitSubmit(workerId, lease, outcome.kind, resultHash, at);
      if (outcome.kind === "accepted" && lease.assignment.kind === "ordinary") {
        await this.advanceOrdinaryResult(lease, compatibility.entry, payload, at);
      }
      if (
        outcome.kind === "accepted" &&
        lease.assignment.kind === "canary" &&
        lease.assignment.expectedResultHash !== resultHash
      ) {
        this.emitSuspicion(lease, workerId, "held_out_canary", at);
      }
      return { ok: true, receipt: outcome.receipt };
    }
    if (outcome.kind === "refused") {
      if (
        outcome.error === "lease_not_held" &&
        Date.parse(at) >= Date.parse(lease.expiresAt)
      ) {
        this.emitSuspicion(lease, workerId, "lease_expired_no_fault", at);
      }
      return this.refuse(workerId, leaseId, outcome.error, at, lease);
    }
    this.emitSuspicion(lease, workerId, outcome.kind, at);
    return this.refuse(workerId, leaseId, "submission_conflict", at, lease);
  }

  private verify(
    jobClass: JobClass<unknown, unknown>,
    payload: CanonicalJsonValue,
    result: CanonicalJsonValue,
  ): VerificationOutcome {
    let canonical: string;
    try {
      canonical = canonicalize(result);
    } catch {
      return {
        ok: false,
        achievedStrength: "structural_only",
        coordinatorFault: true,
        checked: false,
      };
    }
    if (
      byteLength(canonical) > jobClass.maxResultBytes ||
      !validateMusterValue(jobClass.outputSchema, result).ok
    ) {
      return {
        ok: false,
        achievedStrength: "structural_only",
        failureSource: "structural_failure",
        checked: false,
      };
    }
    try {
      for (const validator of jobClass.validators) {
        const verdict = validator.run(payload, result);
        if (!validVerdict(verdict)) throw new Error("invalid validator verdict");
        if (verdict.kind !== "pass") {
          return {
            ok: false,
            achievedStrength: "structural_only",
            failureSource: "validator_failure",
            checked: false,
          };
        }
      }
      const verdicts = jobClass.oracles.map((oracle) => {
        const verdict = oracle.run(payload, result);
        if (!validVerdict(verdict)) throw new Error("invalid oracle verdict");
        return { oracle, verdict };
      });
      const requirement = jobClass.resultEvidenceRequirement;
      const covering = requirement === undefined
        ? []
        : verdicts.filter(({ oracle }) => requirementCovered(requirement, oracle));
      const floorMet = jobClass.verification === "structural_only" ||
        covering.some(({ verdict }) => verdict.kind === "pass");
      const failed = verdicts.find(({ verdict }) => verdict.kind === "fail");
      return {
        ok: floorMet,
        achievedStrength: covering.some(({ verdict }) => verdict.kind === "pass")
          ? "deterministic_oracle"
          : "structural_only",
        ...(failed === undefined
          ? {}
          : {
              failureSource: failed.oracle.kind === "support"
                ? "deterministic_oracle" as const
                : "completeness_oracle" as const,
            }),
        checked: covering.some(({ verdict }) => verdict.kind === "pass"),
      };
    } catch {
      return {
        ok: false,
        achievedStrength: "structural_only",
        coordinatorFault: true,
        checked: false,
      };
    }
  }

  private acceptanceEvidence(
    lease: LeaseRecord,
    verification: VerificationOutcome,
    resultHash: string,
    at: Timestamp,
  ): ReputationEvidenceRecord | undefined | null {
    let source: ReputationEvidenceRecord["source"] | undefined;
    let impact: ReputationEvidenceRecord["impact"] | undefined;
    if (lease.assignment.kind === "canary") {
      if (lease.assignment.expectedResultHash === resultHash) {
        source = "checked_success";
        impact = "positive";
      } else {
        source = "held_out_canary";
        impact = "negative";
      }
    } else if (verification.failureSource === "deterministic_oracle" ||
      verification.failureSource === "completeness_oracle") {
      source = verification.failureSource;
      impact = "negative";
    } else if (verification.checked) {
      source = "checked_success";
      impact = "positive";
    }
    if (source === undefined || impact === undefined) return undefined;
    return this.prepareEvidence(lease, source, impact, at, resultHash);
  }

  private prepareEvidence(
    lease: LeaseRecord,
    source: ReputationEvidenceRecord["source"],
    impact: ReputationEvidenceRecord["impact"],
    at: Timestamp,
    detailHash?: string,
  ): ReputationEvidenceRecord | null {
    const evidenceId = this.options.ids.next("reputation_evidence");
    if (!isWireId(evidenceId)) return null;
    const base = {
      evidenceId,
      workerId: lease.holder,
      at,
      job: { jobId: lease.jobId, collectionCycle: lease.collectionCycle },
      ...(detailHash === undefined ? {} : { detailHash }),
    };
    return source === "checked_success" && impact === "positive"
      ? { ...base, source, impact }
      : source !== "checked_success" && impact === "negative"
        ? { ...base, source, impact }
        : null;
  }

  private async rejectInvalid(
    workerId: WorkerId,
    lease: LeaseRecord,
    error: WorkerWireErrorCode,
    source: Extract<
      ReputationEvidenceSource,
      "structural_failure" | "validator_failure" | "deterministic_oracle" | "completeness_oracle"
    >,
    at: Timestamp,
    detailHash?: string,
  ): Promise<SubmitResult> {
    const evidence = this.prepareEvidence(
      lease,
      source,
      "negative",
      at,
      detailHash,
    );
    if (evidence === null) return this.rejectCoordinatorFault(workerId, lease, at);
    const outcome = await this.options.store.rejectSubmission({
      workerId,
      leaseId: lease.leaseId,
      classification: "rejected_invalid",
      at,
      reputationEvidence: evidence,
    });
    if (outcome.kind === "recorded" || outcome.kind === "replayed") {
      this.emitSuspicion(lease, workerId, error, at);
      return this.refuse(workerId, lease.leaseId, error, at, lease);
    }
    if (outcome.kind === "refused") {
      return this.refuse(workerId, lease.leaseId, outcome.error, at, lease);
    }
    return this.refuse(workerId, lease.leaseId, "submission_conflict", at, lease);
  }

  private async rejectCoordinatorFault(
    workerId: WorkerId,
    lease: LeaseRecord,
    at: Timestamp,
  ): Promise<SubmitResult> {
    const outcome = await this.options.store.rejectSubmission({
      workerId,
      leaseId: lease.leaseId,
      classification: "coordinator_fault",
      at,
    });
    const error = outcome.kind === "refused"
      ? outcome.error
      : outcome.kind === "conflict" || outcome.kind === "evidence_conflict"
        ? "submission_conflict"
        : "contract_mismatch";
    return this.refuse(workerId, lease.leaseId, error, at, lease);
  }

  private async advanceOrdinaryResult(
    lease: LeaseRecord,
    entry: RuntimeClassEntry,
    payload: CanonicalJsonValue,
    at: Timestamp,
  ): Promise<void> {
    for (let retry = 0; retry < MAX_SETTLEMENT_RETRIES; retry += 1) {
      const replicas = await this.options.store.listAcceptedReplicas(
        lease.jobId,
        lease.collectionCycle,
      );
      if (replicas.length < entry.jobClass.replication.target) return;
      const candidate = await this.currentCandidate(lease);
      if (candidate === null) return;
      if (!this.diversitySatisfied(candidate, entry.jobClass)) {
        this.options.events.emit({
          type: "diversity_shortfall",
          at,
          classId: lease.classId,
          jobId: lease.jobId,
          collectionCycle: lease.collectionCycle,
          axis: entry.jobClass.diversity?.axes.join(",") ?? "worker",
        });
        return;
      }
      if (candidate.attempts.splitObserved) return;

      let resolved: CanonicalJsonValue;
      if (entry.jobClass.replication.target === 1) {
        resolved = structuredClone(replicas[0]!.body);
      } else {
        const agreement = entry.jobClass.agreement;
        if (agreement === undefined) return;
        let keys: string[];
        try {
          keys = replicas.map((replica) =>
            canonicalize(agreement.equivalenceKey(replica.body))
          );
        } catch {
          return;
        }
        if (!keys.every((key) => key === keys[0])) {
          const evidence = evidenceByLeaseId(replicas);
          const split = await this.options.store.markResultSplit({
            jobId: lease.jobId,
            collectionCycle: lease.collectionCycle,
            inputHash: lease.inputHash,
            evidence,
          });
          if (split.kind === "recorded") {
            this.options.events.emit({
              type: "split",
              at,
              classId: lease.classId,
              jobId: lease.jobId,
              collectionCycle: lease.collectionCycle,
              equivalenceKeyCount: new Set(keys).size,
            });
          }
          if (split.kind === "conflict") continue;
          return;
        }
        try {
          resolved = structuredClone(agreement.resolveEquivalent(
            replicas.map((replica) => replica.body) as [
              CanonicalJsonValue,
              ...CanonicalJsonValue[],
            ],
          )) as CanonicalJsonValue;
          if (canonicalize(agreement.equivalenceKey(resolved)) !== keys[0]) return;
        } catch {
          return;
        }
      }

      const verification = this.verify(entry.jobClass, payload, resolved);
      if (!verification.ok) return;
      const evidence = evidenceByLeaseId(replicas);
      const decisionResultHash = await computeDecisionResultHash({
        result: resolved,
        evidence,
      });
      const decision: DecisionResultRecord = {
        decisionResultHash,
        jobId: lease.jobId,
        collectionCycle: lease.collectionCycle,
        inputHash: lease.inputHash,
        result: resolved,
        evidence,
        achievedStrength: verification.achievedStrength,
        contractVersion: lease.contractVersion,
        permitEpoch: lease.permitEpoch,
        verifiedAt: at,
      };
      const recorded = await this.options.store.recordDecisionResult({
        decision,
        transition: { from: "collecting", at },
      });
      if (!recorded.ok) {
        if (recorded.actual === "collecting") continue;
        return;
      }
      this.options.events.emit({
        type: "state_change",
        at,
        classId: lease.classId,
        jobId: lease.jobId,
        collectionCycle: lease.collectionCycle,
        subjectKind: "result",
        contractVersion: lease.contractVersion,
        from: "collecting",
        to: "verified",
      });
      return;
    }
  }

  private async currentCandidate(
    lease: LeaseRecord,
  ): Promise<LeaseCandidateSnapshot | null> {
    const candidates = await this.options.store.listLeaseCandidates({
      classIds: [lease.classId],
    });
    return candidates.find((candidate) =>
      candidate.job.jobId === lease.jobId &&
      candidate.job.collectionCycle === lease.collectionCycle
    ) ?? null;
  }

  private diversitySatisfied(
    candidate: LeaseCandidateSnapshot,
    jobClass: JobClass<unknown, unknown>,
  ): boolean {
    const diversity = jobClass.diversity;
    if (diversity === undefined) return true;
    return diversity.axes.every((axis) =>
      new Set(candidate.attempts.acceptedDiversity.flatMap((fact) => {
        const value = fact.axes[axis];
        return value === undefined ? [] : [value];
      })).size >= diversity.minDistinct
    );
  }

  private emitSubmit(
    workerId: WorkerId,
    lease: LeaseRecord,
    outcome: "accepted" | "replayed",
    resultHash: string,
    at: Timestamp,
  ): void {
    this.options.events.emit({
      type: "submit",
      at,
      leaseId: lease.leaseId,
      workerId,
      outcome,
      resultHash,
      classId: lease.classId,
      jobId: lease.jobId,
      collectionCycle: lease.collectionCycle,
      contractVersion: lease.contractVersion,
    });
  }

  private emitSuspicion(
    lease: LeaseRecord,
    workerId: WorkerId,
    signal: string,
    at: Timestamp,
  ): void {
    this.options.events.emit({
      type: "suspicion",
      at,
      classId: lease.classId,
      workerId,
      signal,
    });
  }

  private refuse(
    workerId: WorkerId,
    leaseId: string,
    error: WorkerWireErrorCode,
    at: Timestamp,
    lease: LeaseRecord | null,
  ): SubmitResult {
    this.options.events.emit({
      type: "submit",
      at,
      leaseId,
      workerId,
      outcome: "rejected",
      errorCode: error,
      lease: lease === null
        ? { resolved: false }
        : resolvedLeaseIdentity(lease),
    });
    return { ok: false, error };
  }
}
