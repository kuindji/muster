import {
  canonicalVerdict,
  canonicalize,
  computeDecisionResultHash,
  computeInputHash,
  computeVerdictHash,
  isWireId,
  pathsCover,
  validateMusterValue,
  VerdictShapeError,
  type ActionAdjudicationVerdict,
  type ActionAuthorization,
  type AutomaticVerificationStrength,
  type CanonicalJsonValue,
  type JobClass,
  type OracleSpec,
  type ResultAdjudicationReason,
  type ResultAdjudicationVerdict,
  type SubmissionEvidence,
  type Timestamp,
} from "@kuindji/muster-contract";

import { evaluateActionPermit } from "./action-gates.js";
import type {
  AdjudicationSource,
  ActionVerdictContextSnapshot,
  AuthorizationContextSnapshot,
  Clock,
  CycleRequeuePlan,
  EventSink,
  IdSource,
  InvalidationOutcome,
  InvalidationScope,
  ReserveCharge,
  ReserveChargeOutcome,
  ReservePolicyRecord,
  ReservePolicySnapshot,
  ResultVerdictContextSnapshot,
  Store,
  VerdictOutcome,
} from "./ports.js";
import type { RuntimeClassRegistry } from "./registration.js";

const byteLength = (value: string): number => new TextEncoder().encode(value).length;
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedEvidence = (evidence: readonly SubmissionEvidence[]): SubmissionEvidence[] =>
  [...evidence].sort((left, right) => compare(left.leaseId, right.leaseId));

const same = (left: unknown, right: unknown): boolean =>
  canonicalize(left) === canonicalize(right);

const addSeconds = (at: Timestamp, seconds: number): Timestamp =>
  new Date(Date.parse(at) + seconds * 1_000).toISOString();

const cutoffReason = (
  context: Pick<AuthorizationContextSnapshot, "classVersion" | "maxInFlightDeadline">,
  processedAt: Timestamp,
): "contract_expired" | "max_in_flight_exceeded" | null => {
  if (context.classVersion.state === "retired" ||
    context.classVersion.state === "draft" ||
    (context.classVersion.state === "draining" &&
      (context.classVersion.acceptedUntil === undefined ||
        Date.parse(processedAt) > Date.parse(context.classVersion.acceptedUntil)))) {
    return "contract_expired";
  }
  return Date.parse(processedAt) >= Date.parse(context.maxInFlightDeadline)
    ? "max_in_flight_exceeded"
    : null;
};

const requirementCovered = (
  requirement: NonNullable<JobClass<unknown, unknown>["resultEvidenceRequirement"]>,
  oracle: OracleSpec<unknown, unknown>,
): boolean =>
  oracle.kind === "support" &&
  oracle.predicates.includes(requirement.predicate) &&
  pathsCover(oracle.coversPayloadPaths, requirement.requiredPayloadPaths) &&
  pathsCover(oracle.coversResultPaths, requirement.requiredResultPaths);

const verifyAdjudicatedResult = (
  jobClass: JobClass<unknown, unknown>,
  payload: CanonicalJsonValue,
  result: CanonicalJsonValue,
): { ok: true; achievedStrength: AutomaticVerificationStrength } | { ok: false } => {
  let encoded: string;
  try {
    encoded = canonicalize(result);
  } catch {
    return { ok: false };
  }
  if (
    byteLength(encoded) > jobClass.maxResultBytes ||
    !validateMusterValue(jobClass.outputSchema, result).ok
  ) return { ok: false };

  try {
    for (const validator of jobClass.validators) {
      if (validator.run(payload, result).kind !== "pass") return { ok: false };
    }
    const verdicts = jobClass.oracles.map((oracle) => ({
      oracle,
      verdict: oracle.run(payload, result),
    }));
    if (verdicts.some(({ verdict }) => verdict.kind !== "pass")) {
      return { ok: false };
    }
    const requirement = jobClass.resultEvidenceRequirement;
    const covered = requirement === undefined
      ? false
      : verdicts.some(({ oracle, verdict }) =>
          verdict.kind === "pass" && requirementCovered(requirement, oracle)
        );
    if (jobClass.verification !== "structural_only" && !covered) {
      return { ok: false };
    }
    return {
      ok: true,
      achievedStrength: covered ? "deterministic_oracle" : "structural_only",
    };
  } catch {
    return { ok: false };
  }
};

export class ReserveService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly events: EventSink;
  }) {}

  async initialize(
    policy: ReservePolicySnapshot,
    at: Timestamp,
  ): ReturnType<Store["initializeReservePolicy"]> {
    const outcome = await this.options.store.initializeReservePolicy({ policy, at });
    if (outcome.kind === "initialized") {
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId: policy.classId,
        health: outcome.classHealth.health,
      });
    }
    return outcome;
  }

  async transition(
    expected: ReservePolicyRecord,
    next: ReservePolicySnapshot,
    at: Timestamp,
  ): ReturnType<Store["transitionReservePolicy"]> {
    const outcome = await this.options.store.transitionReservePolicy({
      expected,
      next,
      at,
    });
    if (outcome.kind === "applied") {
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId: next.classId,
        health: outcome.classHealth.health,
      });
    }
    return outcome;
  }

  async charge(charge: ReserveCharge): Promise<ReserveChargeOutcome> {
    const outcome = await this.options.store.chargeReserve(charge);
    if (outcome.kind === "charged" || outcome.kind === "exhausted") {
      if (outcome.status === "applied") {
        this.emitCharge(outcome.kind, outcome.charge.charge);
        this.options.events.emit({
          type: "class_health_changed",
          at: outcome.charge.charge.at,
          classId: outcome.charge.charge.policy.classId,
          health: outcome.classHealth.health,
        });
      }
    }
    return outcome;
  }

  emitCharge(outcome: "charged" | "exhausted", charge: ReserveCharge): void {
    this.options.events.emit({
      type: "escalation_charge",
      at: charge.at,
      classId: charge.policy.classId,
      lane: charge.policy.lane,
      chargeKey: charge.chargeKey,
      workerIds: [...charge.workerIds],
      outcome: outcome === "charged" ? "charged" : "denied",
    });
  }
}

export type OpenResultAdjudicationResult =
  | Awaited<ReturnType<Store["openResultAdjudication"]>>
  | { kind: "not_found" | "runtime_mismatch" | "invalid_request" | "identity_invalid" };

export type ApplyVerdictResult =
  | VerdictOutcome
  | {
      kind:
        | "not_found"
        | "unauthenticated"
        | "invalid_verdict"
        | "runtime_mismatch"
        | "verification_failed"
        | "binding_conflict"
        | "verdict_conflict";
    };

/** Deterministic M2 Task-6 result/action adjudication coordinator. */
export class AdjudicationService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly ids: IdSource;
    readonly source: AdjudicationSource;
    readonly events: EventSink;
  }) {}

  async openResult(input: {
    readonly jobId: string;
    readonly collectionCycle: number;
    readonly reason: ResultAdjudicationReason;
  }): Promise<OpenResultAdjudicationResult> {
    const job = await this.options.store.getJob(input.jobId);
    if (job === null || job.collectionCycle !== input.collectionCycle) {
      return { kind: "not_found" };
    }
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      job.classId,
      job.contractVersion,
    );
    if (!compatibility.ok) return { kind: "runtime_mismatch" };
    const adjudicationPolicy = compatibility.entry.jobClass.adjudication;
    if (adjudicationPolicy === undefined) return { kind: "invalid_request" };
    const policy = await this.options.store.getReservePolicy({
      classId: job.classId,
      contractVersion: job.contractVersion,
      lane: "splitAndAdjudication",
    });
    if (policy === null) return { kind: "invalid_request" };
    const id = this.options.ids.next("result_adjudication_request");
    if (!isWireId(id)) return { kind: "identity_invalid" };
    const at = this.options.clock.now();
    let capacityCovered = false;
    try {
      const capacity = this.options.source.capacity(job.classId);
      const observedAt = Date.parse(capacity.observedAt);
      const now = Date.parse(at);
      const ageSeconds = (now - observedAt) / 1_000;
      capacityCovered = capacity.classId === job.classId &&
        Number.isFinite(capacity.availableReviewsPerWeek) &&
        capacity.availableReviewsPerWeek >= adjudicationPolicy.requiredRatePerWeek &&
        Number.isFinite(ageSeconds) &&
        ageSeconds >= 0 &&
        ageSeconds <= adjudicationPolicy.capacityMaxAge;
    } catch {
      capacityCovered = false;
    }
    const replicas = await this.options.store.listAcceptedReplicas(
      job.jobId,
      job.collectionCycle,
    );
    const evidence = sortedEvidence(replicas.map((replica) => replica.evidence));
    const candidateResultHashes = [...new Set(
      evidence.map((item) => item.resultHash),
    )].sort(compare);
    if (input.reason === "split_exhausted") {
      const candidate = (await this.options.store.listLeaseCandidates({
        classIds: [job.classId],
      })).find((entry) =>
        entry.job.jobId === job.jobId &&
        entry.job.collectionCycle === job.collectionCycle
      );
      const requiredEvidence = compatibility.entry.jobClass.replication.target +
        compatibility.entry.jobClass.replication.maxSplitEvidenceReroutes;
      if (
        candidate === undefined ||
        !candidate.attempts.splitObserved ||
        evidence.length < requiredEvidence
      ) return { kind: "invalid_request" };
    }
    const request = {
      id,
      reason: input.reason,
      jobId: job.jobId,
      collectionCycle: job.collectionCycle,
      inputHash: job.inputHash,
      candidateResultHashes,
      evidence,
      contractVersion: job.contractVersion,
      permitEpoch: job.permitEpoch,
    };
    const charge: ReserveCharge = {
      chargeKey: `${id}:splitAndAdjudication`,
      workerIds: [],
      policy: policy.policy,
      at,
    };
    const outcome = await this.options.store.openResultAdjudication({
      request,
      resultTransition: {
        jobId: job.jobId,
        collectionCycle: job.collectionCycle,
        from: "collecting",
        at,
      },
      charge,
    });
    if (
      outcome.kind === "opened_charged" ||
      outcome.kind === "opened_uncovered"
    ) {
      this.options.events.emit({
        type: "result_adjudication_requested",
        at,
        classId: job.classId,
        jobId: job.jobId,
        collectionCycle: job.collectionCycle,
        resultAdjudicationRequestId: id,
      });
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId: job.classId,
        health: outcome.classHealth.health,
      });
      this.options.events.emit({
        type: "adjudication",
        at,
        classId: job.classId,
        jobId: job.jobId,
        collectionCycle: job.collectionCycle,
        requestId: id,
        contractVersion: job.contractVersion,
        kind: "result",
        transition: "pending_result_adjudication",
      });
      this.options.events.emit({
        type: "escalation_charge",
        at,
        classId: job.classId,
        lane: "splitAndAdjudication",
        chargeKey: charge.chargeKey,
        workerIds: [],
        outcome: outcome.kind === "opened_charged" ? "charged" : "denied",
      });
      if (outcome.kind === "opened_uncovered" || !capacityCovered) {
        this.options.events.emit({
          type: "adjudication_uncovered",
          at,
          classId: job.classId,
        });
      }
    }
    return outcome;
  }

  async applyResultVerdict(
    verdict: ResultAdjudicationVerdict,
  ): Promise<ApplyVerdictResult> {
    if (!this.options.source.authenticate(verdict)) {
      return { kind: "unauthenticated" };
    }
    let canonical: ResultAdjudicationVerdict;
    let verdictHash: string;
    try {
      canonical = canonicalVerdict(verdict);
      verdictHash = await computeVerdictHash(canonical);
    } catch (error) {
      if (error instanceof VerdictShapeError || error instanceof Error) {
        return { kind: "invalid_verdict" };
      }
      throw error;
    }
    const history = await this.options.store.getVerdictHistory(
      canonical.resultAdjudicationRequestId,
    );
    if (history !== null) {
      const exact = history.kind === "result" &&
          history.verdictHash === verdictHash &&
          same(history.verdict, canonical);
      const auditJob = await this.options.store.getJob(canonical.jobId);
      if (auditJob !== null) {
        this.emitVerdict(
          "result",
          auditJob.classId,
          canonical,
          verdictHash,
          exact
            ? { kind: "replayed", receipt: history.receipt }
            : { kind: "conflict" },
        );
      }
      return exact
        ? { kind: "replayed", receipt: history.receipt }
        : { kind: "verdict_conflict" };
    }
    const processedAt = this.options.clock.now();
    const inspected = await this.options.store.inspectResultVerdictContext(
      canonical.resultAdjudicationRequestId,
    );
    if (inspected === null) return { kind: "not_found" };
    const request = await this.options.store.getResultAdjudicationRequest(
      canonical.resultAdjudicationRequestId,
    );
    if (request === null) return { kind: "not_found" };
    const job = inspected.currentJob;
    if (!this.resultVerdictMatches(request, canonical)) {
      if (job !== null) {
        this.emitVerdict(
          "result",
          job.classId,
          canonical,
          verdictHash,
          { kind: "conflict" },
          processedAt,
        );
      }
      return { kind: "binding_conflict" };
    }
    if (inspected.resultState !== "pending_result_adjudication" ||
      inspected.currentJob.collectionCycle !== request.collectionCycle) {
      return { kind: "terminal" };
    }
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      inspected.jobCycle.classId,
      inspected.jobCycle.contractVersion,
    );
    if (!compatibility.ok) return { kind: "runtime_mismatch" };
    const expectedContext: ResultVerdictContextSnapshot = {
      ...inspected,
      maxInFlightDeadline: addSeconds(
        inspected.jobCycle.cycleStartedAt,
        compatibility.entry.jobClass.cost.maxInFlightLifetime,
      ),
    };
    const due = cutoffReason(expectedContext, processedAt);
    if (due !== null) {
      if (!await this.invalidateVerdictContext(expectedContext, due, processedAt)) {
        return { kind: "runtime_mismatch" };
      }
      return { kind: "freshness_conflict" };
    }

    let outcome: VerdictOutcome;
    if (canonical.decision.kind === "resolve") {
      if (request.evidence.length === 0) return { kind: "verification_failed" };
      const payload = await this.options.store.getPayload(job.payloadRef);
      if (payload === null) return { kind: "runtime_mismatch" };
      const result = canonical.decision.result;
      const verified = verifyAdjudicatedResult(
        compatibility.entry.jobClass,
        payload,
        result,
      );
      if (!verified.ok) return { kind: "verification_failed" };
      const decisionResultHash = await computeDecisionResultHash({
        result,
        evidence: request.evidence,
        result_adjudication_verdict_hash: verdictHash,
      });
      outcome = await this.options.store.applyResultAdjudicationVerdict({
        verdict: canonical,
        verdictHash,
        processedAt,
        expectedContext,
        decision: "resolve",
        resolved: {
          decisionResultHash,
          jobId: request.jobId,
          collectionCycle: request.collectionCycle,
          inputHash: request.inputHash,
          result,
          evidence: sortedEvidence(request.evidence),
          achievedStrength: verified.achievedStrength,
          resultAdjudicationVerdictHash: verdictHash,
          contractVersion: request.contractVersion,
          permitEpoch: request.permitEpoch,
          verifiedAt: processedAt,
        },
      });
    } else {
      const payload = await this.options.store.getPayload(job.payloadRef);
      const currentEpoch = await this.options.store.getCurrentPermitEpoch(job.classId);
      if (payload === null || currentEpoch === null) {
        return { kind: "runtime_mismatch" };
      }
      const newCycleInputHash = await computeInputHash({
        payload,
        payload_schema: compatibility.entry.jobClass.payloadSchema,
        job_class_id: job.classId,
        contract_version: job.contractVersion,
        output_schema: compatibility.entry.jobClass.outputSchema,
        policy_version: job.policyVersion,
        permit_epoch: currentEpoch,
      });
      const cap = compatibility.entry.jobClass.adjudication
        ?.maxRejectedDisputeRequeues;
      if (cap === undefined) return { kind: "runtime_mismatch" };
      outcome = await this.options.store.applyResultAdjudicationVerdict({
        verdict: canonical,
        verdictHash,
        processedAt,
        expectedContext,
        decision: "reject",
        onReject: {
          cap,
          newCycleEpoch: currentEpoch,
          newCycleInputHash,
          cycleStartedAt: processedAt,
        },
      });
    }
    this.emitVerdict("result", job.classId, canonical, verdictHash, outcome, processedAt);
    if (outcome.kind === "applied") {
      const transition = outcome.receipt.outcome === "resolved"
        ? "resolved"
        : "rejected";
      this.options.events.emit({
        type: "adjudication",
        at: processedAt,
        classId: job.classId,
        jobId: request.jobId,
        collectionCycle: request.collectionCycle,
        requestId: request.id,
        contractVersion: request.contractVersion,
        kind: "result",
        transition,
      });
      this.options.events.emit({
        type: "state_change",
        at: processedAt,
        classId: job.classId,
        jobId: request.jobId,
        collectionCycle: request.collectionCycle,
        subjectKind: "result",
        contractVersion: request.contractVersion,
        from: "pending_result_adjudication",
        to: transition === "resolved" ? "verified" : "rejected",
      });
      if (
        outcome.receipt.outcome === "rejected" &&
        outcome.receipt.rejectOutcome === "cap_exhausted"
      ) {
        this.options.events.emit({
          type: "dispute_requeue_exhausted",
          at: processedAt,
          classId: job.classId,
          jobId: request.jobId,
          collectionCycle: request.collectionCycle,
        });
      }
    }
    return outcome;
  }

  async applyActionVerdict(
    verdict: ActionAdjudicationVerdict,
  ): Promise<ApplyVerdictResult> {
    if (!this.options.source.authenticate(verdict)) {
      return { kind: "unauthenticated" };
    }
    let canonical: ActionAdjudicationVerdict;
    let verdictHash: string;
    try {
      canonical = canonicalVerdict(verdict);
      verdictHash = await computeVerdictHash(canonical);
    } catch {
      return { kind: "invalid_verdict" };
    }
    const history = await this.options.store.getVerdictHistory(
      canonical.authorizationRequestId,
    );
    if (history !== null) {
      const exact = history.kind === "action" &&
          history.verdictHash === verdictHash &&
          same(history.verdict, canonical);
      const auditJob = await this.options.store.getJob(canonical.jobId);
      if (auditJob !== null) {
        this.emitVerdict(
          "action",
          auditJob.classId,
          canonical,
          verdictHash,
          exact
            ? { kind: "replayed", receipt: history.receipt }
            : { kind: "conflict" },
        );
      }
      return exact
        ? { kind: "replayed", receipt: history.receipt }
        : { kind: "verdict_conflict" };
    }
    const processedAt = this.options.clock.now();
    const request = await this.options.store.getActionAdjudicationRequest(
      canonical.authorizationRequestId,
    );
    if (request === null) return { kind: "not_found" };
    const persistedContext = await this.options.store.getPendingAuthorizationContext(
      canonical.authorizationRequestId,
    );
    if (persistedContext === null) return { kind: "binding_conflict" };
    const liveContext = await this.options.store.inspectAuthorizationContext(
      request.decisionResultHash,
    );
    if (liveContext === null) return { kind: "terminal" };
    const expectedContext: ActionVerdictContextSnapshot = {
      persisted: persistedContext,
      current: liveContext,
    };
    const currentStatus = await this.options.store.getAuthorizationStatus(
      canonical.authorizationRequestId,
    );
    if (currentStatus?.state !== "pending_adjudication") {
      return { kind: "terminal" };
    }
    const job = liveContext.currentJob;
    const expectedActions = request.effectIntent.effects.map((effect) => effect.action);
    if (
      canonical.effectIntentId !== request.effectIntent.id ||
      canonical.effectIntentHash !== request.effectIntentHash ||
      canonical.jobId !== request.jobId ||
      canonical.collectionCycle !== request.collectionCycle ||
      canonical.inputHash !== request.inputHash ||
      canonical.decisionResultHash !== request.decisionResultHash ||
      canonical.resultAdjudicationVerdictHash !== request.resultAdjudicationVerdictHash ||
      canonical.contractVersion !== request.contractVersion ||
      canonical.permitEpoch !== request.permitEpoch ||
      !same(canonical.actions, expectedActions) ||
      !same(canonical.evidence, sortedEvidence(request.evidence))
    ) {
      this.emitVerdict(
        "action",
        job.classId,
        canonical,
        verdictHash,
        { kind: "conflict" },
        processedAt,
      );
      return { kind: "binding_conflict" };
    }
    const decision = await this.options.store.getDecisionResult(request.decisionResultHash);
    if (decision === null) {
      return { kind: "binding_conflict" };
    }
    const liveFullContext: AuthorizationContextSnapshot = {
      ...liveContext,
      maxInFlightDeadline: persistedContext.maxInFlightDeadline,
    };
    const due = cutoffReason(liveFullContext, processedAt);
    if (due !== null) {
      if (!await this.invalidateVerdictContext(liveFullContext, due, processedAt)) {
        return { kind: "runtime_mismatch" };
      }
      return { kind: "freshness_conflict" };
    }
    if (canonical.decision === "reject") {
      const outcome = await this.options.store.applyActionAdjudicationVerdict({
        verdict: canonical,
        verdictHash,
        processedAt,
        expectedContext,
        decision: "reject",
      });
      this.emitVerdict("action", job.classId, canonical, verdictHash, outcome, processedAt);
      if (outcome.kind === "applied") {
        this.emitActionTransition(request, job.classId, processedAt, "denied");
      }
      return outcome;
    }
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      job.classId,
      request.contractVersion,
    );
    if (!compatibility.ok) return { kind: "runtime_mismatch" };
    const payload = await this.options.store.getPayload(
      liveContext.jobCycle.payloadRef,
    );
    if (payload === null) return { kind: "runtime_mismatch" };
    const humanReviews = [];
    for (const [index, action] of expectedActions.entries()) {
      const permit = compatibility.entry.jobClass.permits.find((candidate) =>
        candidate.action === action
      );
      if (permit === undefined) return { kind: "binding_conflict" };
      if (permit.mode === "human_only") {
        humanReviews.push({ action, ...permit.reviewRequirement });
      } else if (!evaluateActionPermit(
        compatibility.entry.jobClass,
        permit,
        payload,
        decision,
        request.effectIntent.effects[index]!.descriptor,
      ).ok) {
        return { kind: "verification_failed" };
      }
    }
    if (!same(request.humanReviews, humanReviews)) {
      return { kind: "binding_conflict" };
    }
    const authorization: ActionAuthorization = {
      authorizationRequestId: request.authorizationRequestId,
      effectIntentId: request.effectIntent.id,
      effectIntentHash: request.effectIntentHash,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      inputHash: request.inputHash,
      decisionResultHash: request.decisionResultHash,
      evidence: sortedEvidence(request.evidence),
      ...(request.resultAdjudicationVerdictHash === undefined
        ? {}
        : { resultAdjudicationVerdictHash: request.resultAdjudicationVerdictHash }),
      actionAdjudicationVerdictHash: verdictHash,
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      actions: [...canonical.actions],
    };
    const outcome = await this.options.store.applyActionAdjudicationVerdict({
      verdict: canonical,
      verdictHash,
      processedAt,
      expectedContext,
      decision: "approve",
      authorization,
    });
    this.emitVerdict("action", job.classId, canonical, verdictHash, outcome, processedAt);
    if (outcome.kind === "applied") {
      const transition = outcome.receipt.outcome === "approved"
        ? "authorized"
        : "denied";
      this.options.events.emit({
        type: "adjudication",
        at: processedAt,
        classId: job.classId,
        jobId: request.jobId,
        collectionCycle: request.collectionCycle,
        requestId: request.authorizationRequestId,
        contractVersion: request.contractVersion,
        kind: "action",
        transition,
      });
      this.options.events.emit({
        type: "state_change",
        at: processedAt,
        classId: job.classId,
        jobId: request.jobId,
        collectionCycle: request.collectionCycle,
        subjectKind: "authorization_request",
        authorizationRequestId: request.authorizationRequestId,
        from: "pending_adjudication",
        to: transition,
      });
    }
    return outcome;
  }

  private emitActionTransition(
    request: NonNullable<Awaited<ReturnType<Store["getActionAdjudicationRequest"]>>>,
    classId: string,
    processedAt: Timestamp,
    to: "authorized" | "denied",
  ): void {
    this.options.events.emit({
      type: "adjudication",
      at: processedAt,
      classId,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      requestId: request.authorizationRequestId,
      contractVersion: request.contractVersion,
      kind: "action",
      transition: to,
    });
    this.options.events.emit({
      type: "state_change",
      at: processedAt,
      classId,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      subjectKind: "authorization_request",
      authorizationRequestId: request.authorizationRequestId,
      from: "pending_adjudication",
      to,
    });
  }

  private async invalidateVerdictContext(
    context: AuthorizationContextSnapshot | ResultVerdictContextSnapshot,
    reason: "contract_expired" | "max_in_flight_exceeded",
    processedAt: Timestamp,
  ): Promise<boolean> {
    const job = context.jobCycle;
    const scope: InvalidationScope = {
      kind: "job_cycles",
      classId: job.classId,
      jobCycles: [{ jobId: job.jobId, collectionCycle: job.collectionCycle }],
    };
    const expectedTargets = [{
      jobId: job.jobId,
      collectionCycle: job.collectionCycle,
      state: context.resultState,
      inputHash: job.inputHash,
      permitEpoch: job.permitEpoch,
      contractVersion: job.contractVersion,
    }];
    const requeuePlans: CycleRequeuePlan[] = [];
    if (reason === "max_in_flight_exceeded") {
      const compatibility = await this.options.registry.compatibility(
        this.options.store,
        job.classId,
        job.contractVersion,
      );
      const payload = await this.options.store.getPayload(job.payloadRef);
      const currentEpoch = await this.options.store.getCurrentPermitEpoch(job.classId);
      if (!compatibility.ok || payload === null || currentEpoch === null) return false;
      requeuePlans.push({
        jobId: job.jobId,
        fromCollectionCycle: job.collectionCycle,
        newCollectionCycle: job.collectionCycle + 1,
        permitEpoch: currentEpoch,
        inputHash: await computeInputHash({
          payload,
          payload_schema: compatibility.entry.jobClass.payloadSchema,
          job_class_id: job.classId,
          contract_version: job.contractVersion,
          output_schema: compatibility.entry.jobClass.outputSchema,
          policy_version: job.policyVersion,
          permit_epoch: currentEpoch,
        }),
        cycleStartedAt: processedAt,
      });
    }
    const outcome = await this.options.store.invalidateResultScope({
      scope,
      expectedTargets,
      requeuePlans,
      at: processedAt,
      reason,
    });
    if (outcome.kind === "applied") {
      for (const transition of outcome.resultTransitions) {
        this.options.events.emit({
          type: "state_change",
          at: processedAt,
          classId: job.classId,
          jobId: transition.jobId,
          collectionCycle: transition.collectionCycle,
          subjectKind: "result",
          contractVersion: job.contractVersion,
          from: transition.from,
          to: transition.to,
        });
      }
      for (const transition of outcome.authorizationTransitions) {
        this.options.events.emit({
          type: "state_change",
          at: processedAt,
          classId: job.classId,
          jobId: job.jobId,
          collectionCycle: job.collectionCycle,
          subjectKind: "authorization_request",
          authorizationRequestId: transition.authorizationRequestId,
          from: transition.from,
          to: transition.to,
        });
      }
      for (const transition of outcome.invalidatedAuthorizations) {
        this.options.events.emit({
          type: "authorization_validity_change",
          at: processedAt,
          classId: transition.classId,
          jobId: transition.jobId,
          collectionCycle: transition.collectionCycle,
          authorizationRequestId: transition.authorizationRequestId,
          from: "valid",
          to: "invalid",
          reason: transition.reason,
        });
      }
    }
    return true;
  }

  private resultVerdictMatches(
    request: NonNullable<Awaited<ReturnType<Store["getResultAdjudicationRequest"]>>>,
    verdict: ResultAdjudicationVerdict,
  ): boolean {
    return verdict.reason === request.reason &&
      verdict.jobId === request.jobId &&
      verdict.collectionCycle === request.collectionCycle &&
      verdict.inputHash === request.inputHash &&
      verdict.contractVersion === request.contractVersion &&
      verdict.permitEpoch === request.permitEpoch &&
      same(verdict.candidateResultHashes, request.candidateResultHashes) &&
      same(verdict.evidence, sortedEvidence(request.evidence));
  }

  private emitVerdict(
    kind: "result" | "action",
    classId: string,
    verdict: ResultAdjudicationVerdict | ActionAdjudicationVerdict,
    verdictHash: string,
    outcome: VerdictOutcome,
    at: Timestamp = verdict.decidedAt,
  ): void {
    const requestId = kind === "result"
      ? (verdict as ResultAdjudicationVerdict).resultAdjudicationRequestId
      : (verdict as ActionAdjudicationVerdict).authorizationRequestId;
    this.options.events.emit({
      type: "verdict",
      at,
      classId,
      jobId: verdict.jobId,
      collectionCycle: verdict.collectionCycle,
      requestId,
      verdictHash,
      adjudicatorId: verdict.adjudicatorId,
      contractVersion: verdict.contractVersion,
      kind,
      outcome: outcome.kind,
    });
  }

}

export type InvalidateResult =
  | InvalidationOutcome
  | { kind: "runtime_mismatch" | "invalid_epoch_transition" };

/** Class-qualified invalidation planner for the frozen compare-and-apply Store command. */
export class InvalidationService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly events: EventSink;
  }) {}

  async invalidate(input: {
    readonly scope: InvalidationScope;
    readonly reason:
      | "emergency_halted"
      | "operator_cancelled"
      | "emergency_permit_withdrawal"
      | "contract_expired"
      | "max_in_flight_exceeded";
    readonly toEpoch?: string;
    readonly requeueOperatorCancellation?: boolean;
  }): Promise<InvalidateResult> {
    const at = this.options.clock.now();
    const snapshot = await this.options.store.inspectInvalidationScope(input.scope);
    const pendingActions = await this.options.store.listPendingActionAdjudications(
      input.scope.classId,
    );
    const currentEpoch = await this.options.store.getCurrentPermitEpoch(input.scope.classId);
    if (
      input.reason === "emergency_permit_withdrawal" &&
      (currentEpoch === null || input.toEpoch === undefined || input.toEpoch === currentEpoch)
    ) return { kind: "invalid_epoch_transition" };
    const requeue = input.reason === "max_in_flight_exceeded" ||
      input.reason === "emergency_permit_withdrawal" ||
      (input.reason === "operator_cancelled" && input.requeueOperatorCancellation === true);
    const requeuePlans: CycleRequeuePlan[] = [];
    if (requeue) {
      const epoch = input.reason === "emergency_permit_withdrawal"
        ? input.toEpoch!
        : currentEpoch;
      if (epoch === null) return { kind: "runtime_mismatch" };
      for (const target of snapshot.targets) {
        const shouldRequeue = input.reason === "emergency_permit_withdrawal"
          ? target.state === "collecting"
          : input.reason === "max_in_flight_exceeded"
            ? target.state === "collecting" ||
              target.state === "pending_result_adjudication" ||
              target.state === "verified"
            : target.state === "collecting" ||
              target.state === "pending_result_adjudication" ||
              target.state === "verified";
        if (!shouldRequeue) continue;
        const job = await this.options.store.getJob(target.jobId);
        if (job === null || job.collectionCycle !== target.collectionCycle) {
          return { kind: "runtime_mismatch" };
        }
        const compatibility = await this.options.registry.compatibility(
          this.options.store,
          job.classId,
          job.contractVersion,
        );
        const payload = await this.options.store.getPayload(job.payloadRef);
        if (!compatibility.ok || payload === null) return { kind: "runtime_mismatch" };
        requeuePlans.push({
          jobId: job.jobId,
          fromCollectionCycle: job.collectionCycle,
          newCollectionCycle: job.collectionCycle + 1,
          permitEpoch: epoch,
          inputHash: await computeInputHash({
            payload,
            payload_schema: compatibility.entry.jobClass.payloadSchema,
            job_class_id: job.classId,
            contract_version: job.contractVersion,
            output_schema: compatibility.entry.jobClass.outputSchema,
            policy_version: job.policyVersion,
            permit_epoch: epoch,
          }),
          cycleStartedAt: at,
        });
      }
    }
    const outcome = input.reason === "emergency_permit_withdrawal"
      ? await this.options.store.invalidateResultScope({
          scope: input.scope,
          expectedTargets: snapshot.targets,
          requeuePlans,
          at,
          reason: input.reason,
          epochTransition: {
            classId: input.scope.classId,
            fromEpoch: currentEpoch,
            toEpoch: input.toEpoch!,
          },
        })
      : await this.options.store.invalidateResultScope({
          scope: input.scope,
          expectedTargets: snapshot.targets,
          requeuePlans,
          at,
          reason: input.reason,
        });
    if (outcome.kind === "applied") {
      this.emitInvalidation(
        outcome,
        snapshot.targets,
        pendingActions,
        input.scope.classId,
        at,
      );
    }
    return outcome;
  }

  private emitInvalidation(
    outcome: Extract<InvalidationOutcome, { kind: "applied" }>,
    targets: Readonly<
      Awaited<ReturnType<Store["inspectInvalidationScope"]>>["targets"]
    >,
    pendingActions: Awaited<ReturnType<Store["listPendingActionAdjudications"]>>,
    classId: string,
    at: Timestamp,
  ): void {
    for (const transition of outcome.resultTransitions) {
      const target = targets.find((candidate) =>
        candidate.jobId === transition.jobId &&
        candidate.collectionCycle === transition.collectionCycle
      );
      this.options.events.emit({
        type: "state_change",
        at,
        classId,
        jobId: transition.jobId,
        collectionCycle: transition.collectionCycle,
        subjectKind: "result",
        contractVersion: target?.contractVersion ?? "unknown-contract",
        from: transition.from,
        to: transition.to,
      });
    }
    if (outcome.epochTransition !== undefined) {
      this.options.events.emit({
        type: "permit_epoch_change",
        at,
        classId: outcome.epochTransition.classId,
        fromEpoch: outcome.epochTransition.fromEpoch,
        toEpoch: outcome.epochTransition.toEpoch,
        emergency: true,
      });
    }
    for (const transition of outcome.authorizationTransitions) {
      const pending = pendingActions.find((entry) =>
        entry.request.authorizationRequestId === transition.authorizationRequestId
      );
      if (pending === undefined) continue;
      this.options.events.emit({
        type: "state_change",
        at,
        classId,
        jobId: pending.request.jobId,
        collectionCycle: pending.request.collectionCycle,
        subjectKind: "authorization_request",
        authorizationRequestId: transition.authorizationRequestId,
        from: transition.from,
        to: transition.to,
      });
    }
    for (const transition of outcome.invalidatedAuthorizations) {
      this.options.events.emit({
        type: "authorization_validity_change",
        at,
        classId: transition.classId,
        jobId: transition.jobId,
        collectionCycle: transition.collectionCycle,
        authorizationRequestId: transition.authorizationRequestId,
        from: "valid",
        to: "invalid",
        reason: transition.reason,
      });
    }
  }
}
