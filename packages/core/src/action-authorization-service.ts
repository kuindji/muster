import {
  ACTION_GATE_TABLE,
  EFFECT_INTENT_TRANSPORT_CAP_BYTES,
  canonicalEffectIntent,
  canonicalize,
  computeEffectIntentHash,
  computeInputHash,
  effectiveGateAction,
  isWireId,
  type ActionAdjudicationRequest,
  type ActionAuthorization,
  type AuthorizationDenialReason,
  type AuthorizationInitialReceipt,
  type AuthorizationStatus,
  type CanonicalJsonValue,
  type ConsumerApiErrorCode,
  type EffectIntent,
  type HumanActionReviewRequirement,
  type NonEmptyArray,
  type SubmissionEvidence,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";

import { evaluateActionPermit } from "./action-gates.js";
import type {
  AuthorizationContextSnapshot,
  AuthorizationReserveBatchResult,
  AuthorizationReserveLane,
  Clock,
  EventSink,
  IdSource,
  ReserveCharge,
  ReservePolicySnapshot,
  Store,
} from "./ports.js";
import type { RuntimeClassRegistry } from "./registration.js";

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(canonicalize(value)).byteLength;

const addSeconds = (at: Timestamp, seconds: number): Timestamp =>
  new Date(Date.parse(at) + seconds * 1_000).toISOString();

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedEvidence = (
  evidence: readonly SubmissionEvidence[],
): SubmissionEvidence[] => [...evidence].sort((left, right) =>
  compare(left.leaseId, right.leaseId)
);

const evidenceWorkers = (
  evidence: readonly SubmissionEvidence[],
): WorkerId[] => [...new Set(evidence.map((entry) => entry.workerId))]
  .sort(compare);

const contractExpired = (
  context: Pick<AuthorizationContextSnapshot, "classVersion">,
  at: Timestamp,
): boolean =>
    context.classVersion.state === "draft" ||
    context.classVersion.state === "retired" ||
    (context.classVersion.state === "draining" &&
      (context.classVersion.acceptedUntil === undefined ||
        Date.parse(at) > Date.parse(context.classVersion.acceptedUntil)));

export type AuthorizeActionsResult =
  | { readonly ok: true; readonly receipt: AuthorizationInitialReceipt }
  | { readonly ok: false; readonly error: ConsumerApiErrorCode };

/** M2 Task-7 descriptor-bound, all-actions authorization coordinator. */
export class ActionAuthorizationService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly ids: IdSource;
    readonly events: EventSink;
  }) {}

  async authorizeActions(
    decisionResultHash: string,
    intent: EffectIntent,
  ): Promise<AuthorizeActionsResult> {
    const canonical = canonicalEffectIntent(intent);
    if (!canonical.ok || !isWireId(intent.id) || !isWireId(decisionResultHash)) {
      return { ok: false, error: "intent_invalid" };
    }
    let effectIntentHash: string;
    try {
      effectIntentHash = await computeEffectIntentHash(canonical.value);
    } catch {
      return { ok: false, error: "intent_invalid" };
    }

    const prior = await this.options.store.getInitialReceipt(intent.id);
    if (prior !== null) {
      return prior.effectIntentHash === effectIntentHash &&
          prior.decisionResultHash === decisionResultHash
        ? { ok: true, receipt: prior }
        : { ok: false, error: "authorization_conflict" };
    }
    if (byteLength(canonical.value) > EFFECT_INTENT_TRANSPORT_CAP_BYTES) {
      return { ok: false, error: "intent_invalid" };
    }

    const at = this.options.clock.now();
    if (!Number.isFinite(Date.parse(at))) {
      return { ok: false, error: "intent_invalid" };
    }
    const inspected = await this.options.store.inspectAuthorizationContext(
      decisionResultHash,
    );
    if (inspected === null) return { ok: false, error: "intent_invalid" };
    if (
      inspected.resultState !== "verified" ||
      inspected.currentJob.collectionCycle !== inspected.jobCycle.collectionCycle
    ) return { ok: false, error: "intent_invalid" };
    if (contractExpired(inspected, at)) {
      await this.invalidateDueContext(
        { ...inspected, maxInFlightDeadline: at },
        "contract_expired",
        at,
      );
      return { ok: false, error: "intent_invalid" };
    }
    const compatibility = await this.options.registry.compatibility(
      this.options.store,
      inspected.jobCycle.classId,
      inspected.jobCycle.contractVersion,
    );
    if (!compatibility.ok) return { ok: false, error: "intent_invalid" };
    const context: AuthorizationContextSnapshot = {
      ...inspected,
      maxInFlightDeadline: addSeconds(
        inspected.jobCycle.cycleStartedAt,
        compatibility.entry.jobClass.cost.maxInFlightLifetime,
      ),
    };
    if (!Number.isFinite(Date.parse(context.maxInFlightDeadline))) {
      return { ok: false, error: "intent_invalid" };
    }
    if (Date.parse(at) >= Date.parse(context.maxInFlightDeadline)) {
      await this.invalidateDueContext(context, "max_in_flight_exceeded", at);
      return { ok: false, error: "intent_invalid" };
    }

    const payload = await this.options.store.getPayload(
      inspected.jobCycle.payloadRef,
    );
    if (payload === null) return { ok: false, error: "intent_invalid" };

    const humanReviews: HumanActionReviewRequirement[] = [];
    const lanes = new Set<AuthorizationReserveLane>();
    let denialReason: AuthorizationDenialReason | undefined;
    for (const effect of canonical.value.effects) {
      const permit = compatibility.entry.jobClass.permits.find((candidate) =>
        candidate.action === effect.action
      );
      if (permit === undefined) {
        denialReason = "permit_rejected";
        continue;
      }
      const evaluated = evaluateActionPermit(
        compatibility.entry.jobClass,
        permit,
        payload,
        inspected.decision,
        effect.descriptor,
      );
      if (!evaluated.ok) {
        if (evaluated.reason === "descriptor_mismatch") {
          return { ok: false, error: "effect_descriptor_mismatch" };
        }
        denialReason = "gate_failed";
      }
      const lane = ACTION_GATE_TABLE[
        effectiveGateAction(effect.action, compatibility.entry.jobClass.surface)
      ].budgetLane;
      if (lane !== null) lanes.add(lane);
      if (permit.mode === "human_only") {
        lanes.add("splitAndAdjudication");
        humanReviews.push({ action: permit.action, ...permit.reviewRequirement });
      }
    }

    const evidence = sortedEvidence(inspected.decision.evidence);
    const actions = canonical.value.effects.map((effect) => effect.action);
    const policies = denialReason === undefined
      ? await this.loadPolicies([...lanes], context, at)
      : [];
    if (policies === null) return { ok: false, error: "intent_invalid" };
    const authorizationRequestId = this.options.ids.next(
      "authorization_request",
    );
    if (!isWireId(authorizationRequestId)) {
      return { ok: false, error: "intent_invalid" };
    }
    let decision: Parameters<Store["authorizeOrReplayIntent"]>[0]["decision"];
    if (denialReason !== undefined) {
      decision = { kind: "deny", reason: denialReason };
    } else {
      const charges = this.prepareCharges(
        policies,
        authorizationRequestId,
        inspected.decision.resultAdjudicationVerdictHash === undefined
          ? evidenceWorkers(evidence)
          : [],
        at,
      );
      if (humanReviews.length > 0) {
        const request: ActionAdjudicationRequest = {
          authorizationRequestId,
          jobId: inspected.decision.jobId,
          collectionCycle: inspected.decision.collectionCycle,
          effectIntent: canonical.value,
          effectIntentHash,
          inputHash: inspected.decision.inputHash,
          decisionResultHash,
          evidence,
          ...(inspected.decision.resultAdjudicationVerdictHash === undefined
            ? {}
            : {
                resultAdjudicationVerdictHash:
                  inspected.decision.resultAdjudicationVerdictHash,
              }),
          contractVersion: inspected.decision.contractVersion,
          permitEpoch: inspected.decision.permitEpoch,
          humanReviews: humanReviews as NonEmptyArray<HumanActionReviewRequirement>,
        };
        decision = { kind: "pend", request, charges };
      } else {
        const authorization: ActionAuthorization = {
          authorizationRequestId,
          effectIntentId: canonical.value.id,
          effectIntentHash,
          jobId: inspected.decision.jobId,
          collectionCycle: inspected.decision.collectionCycle,
          inputHash: inspected.decision.inputHash,
          decisionResultHash,
          evidence,
          ...(inspected.decision.resultAdjudicationVerdictHash === undefined
            ? {}
            : {
                resultAdjudicationVerdictHash:
                  inspected.decision.resultAdjudicationVerdictHash,
              }),
          contractVersion: inspected.decision.contractVersion,
          permitEpoch: inspected.decision.permitEpoch,
          actions,
        };
        decision = {
          kind: "authorize",
          authorization,
          ...(charges.length === 0 ? {} : { charges }),
        };
      }
    }

    const outcome = await this.options.store.authorizeOrReplayIntent({
      authorizationRequestId,
      effectIntent: canonical.value,
      effectIntentHash,
      decisionResultHash,
      expectedContext: context,
      decision,
      at,
    });
    if (outcome.kind !== "applied" && outcome.kind !== "replayed") {
      if (
        outcome.kind === "conflict" ||
        outcome.kind === "reserve_charge_conflict" ||
        outcome.kind === "reserve_batch_invalid"
      ) return { ok: false, error: "authorization_conflict" };
      return { ok: false, error: "intent_invalid" };
    }
    if (outcome.kind === "applied") {
      this.emitApplied(context, outcome.initialReceipt, outcome.reserveBatch);
    }
    return { ok: true, receipt: outcome.initialReceipt };
  }

  getAuthorizationStatus(
    authorizationRequestId: string,
  ): Promise<AuthorizationStatus | null> {
    return this.options.store.getAuthorizationStatus(authorizationRequestId);
  }

  private async loadPolicies(
    lanes: AuthorizationReserveLane[],
    context: AuthorizationContextSnapshot,
    at: Timestamp,
  ): Promise<ReservePolicySnapshot[] | null> {
    const order: readonly AuthorizationReserveLane[] = [
      "lowCost",
      "urgent",
      "splitAndAdjudication",
    ];
    lanes.sort((left, right) => order.indexOf(left) - order.indexOf(right));
    const policies: ReservePolicySnapshot[] = [];
    for (const lane of lanes) {
      const current = await this.options.store.getReservePolicy({
        classId: context.jobCycle.classId,
        contractVersion: context.jobCycle.contractVersion,
        lane,
      });
      if (
        current === null ||
        Date.parse(at) < Date.parse(current.policy.windowStartsAt) ||
        Date.parse(at) >= Date.parse(current.policy.windowEndsAt)
      ) return null;
      policies.push(current.policy);
    }
    return policies;
  }

  private prepareCharges(
    policies: ReservePolicySnapshot[],
    authorizationRequestId: string,
    workerIds: WorkerId[],
    at: Timestamp,
  ): ReserveCharge[] {
    return policies.map((policy) => ({
      chargeKey: `${authorizationRequestId}:${policy.lane}`,
      workerIds: policy.lane === "splitAndAdjudication" ? [] : workerIds,
      policy,
      at,
    }));
  }

  private emitApplied(
    context: AuthorizationContextSnapshot,
    receipt: AuthorizationInitialReceipt,
    reserveBatch: AuthorizationReserveBatchResult | undefined,
  ): void {
    const at = receipt.at;
    if (reserveBatch !== undefined) {
      for (const settlement of reserveBatch.settlements) {
        this.options.events.emit({
          type: "escalation_charge",
          at,
          classId: context.jobCycle.classId,
          lane: settlement.lane,
          chargeKey: settlement.charge.charge.chargeKey,
          workerIds: [...settlement.charge.charge.workerIds],
          outcome: settlement.charge.outcome === "charged" ? "charged" : "denied",
        });
        if (settlement.charge.outcome === "exhausted") {
          if (settlement.lane === "lowCost") {
            this.options.events.emit({
              type: "low_cost_uncovered",
              at,
              classId: context.jobCycle.classId,
              jobId: context.jobCycle.jobId,
              collectionCycle: context.jobCycle.collectionCycle,
            });
          } else if (settlement.lane === "urgent") {
            this.options.events.emit({
              type: "urgent_uncovered",
              at,
              classId: context.jobCycle.classId,
              jobId: context.jobCycle.jobId,
              collectionCycle: context.jobCycle.collectionCycle,
            });
          } else {
            this.options.events.emit({
              type: "adjudication_uncovered",
              at,
              classId: context.jobCycle.classId,
            });
          }
        }
      }
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId: context.jobCycle.classId,
        health: reserveBatch.classHealth.health,
      });
    }
    this.options.events.emit({
      type: "gate_decision",
      at,
      classId: context.jobCycle.classId,
      jobId: context.jobCycle.jobId,
      collectionCycle: context.jobCycle.collectionCycle,
      authorizationRequestId: receipt.authorizationRequestId,
      contractVersion: context.jobCycle.contractVersion,
      permitEpoch: context.jobCycle.permitEpoch,
      ...(receipt.outcome === "denied"
        ? { outcome: "denied", denialReason: receipt.denialReason }
        : { outcome: receipt.outcome }),
    });
    if (receipt.outcome === "pending_adjudication") {
      this.options.events.emit({
        type: "action_adjudication_requested",
        at,
        classId: context.jobCycle.classId,
        jobId: context.jobCycle.jobId,
        collectionCycle: context.jobCycle.collectionCycle,
        authorizationRequestId: receipt.authorizationRequestId,
      });
      this.options.events.emit({
        type: "adjudication",
        at,
        classId: context.jobCycle.classId,
        jobId: context.jobCycle.jobId,
        collectionCycle: context.jobCycle.collectionCycle,
        requestId: receipt.authorizationRequestId,
        contractVersion: context.jobCycle.contractVersion,
        kind: "action",
        transition: "pending_adjudication",
      });
    }
  }

  private async invalidateDueContext(
    context: AuthorizationContextSnapshot,
    reason: "contract_expired" | "max_in_flight_exceeded",
    at: Timestamp,
  ): Promise<void> {
    const requeuePlans = [];
    if (reason === "max_in_flight_exceeded") {
      const payload = await this.options.store.getPayload(context.jobCycle.payloadRef);
      const currentEpoch = await this.options.store.getCurrentPermitEpoch(
        context.jobCycle.classId,
      );
      if (payload === null || currentEpoch === null) return;
      const compatibility = await this.options.registry.compatibility(
        this.options.store,
        context.jobCycle.classId,
        context.jobCycle.contractVersion,
      );
      if (!compatibility.ok) return;
      requeuePlans.push({
        jobId: context.jobCycle.jobId,
        fromCollectionCycle: context.jobCycle.collectionCycle,
        newCollectionCycle: context.jobCycle.collectionCycle + 1,
        permitEpoch: currentEpoch,
        inputHash: await computeInputHash({
          payload,
          payload_schema: compatibility.entry.jobClass.payloadSchema,
          job_class_id: context.jobCycle.classId,
          contract_version: context.jobCycle.contractVersion,
          output_schema: compatibility.entry.jobClass.outputSchema,
          policy_version: context.jobCycle.policyVersion,
          permit_epoch: currentEpoch,
        }),
        cycleStartedAt: at,
      });
    }
    const outcome = await this.options.store.invalidateResultScope({
      scope: {
        kind: "job_cycles",
        classId: context.jobCycle.classId,
        jobCycles: [{
          jobId: context.jobCycle.jobId,
          collectionCycle: context.jobCycle.collectionCycle,
        }],
      },
      expectedTargets: [{
        jobId: context.jobCycle.jobId,
        collectionCycle: context.jobCycle.collectionCycle,
        state: context.resultState,
        inputHash: context.jobCycle.inputHash,
        permitEpoch: context.jobCycle.permitEpoch,
        contractVersion: context.jobCycle.contractVersion,
      }],
      requeuePlans,
      at,
      reason,
    });
    if (outcome.kind !== "applied") return;
    for (const transition of outcome.resultTransitions) {
      this.options.events.emit({
        type: "state_change",
        at,
        classId: context.jobCycle.classId,
        jobId: transition.jobId,
        collectionCycle: transition.collectionCycle,
        subjectKind: "result",
        contractVersion: context.jobCycle.contractVersion,
        from: transition.from,
        to: transition.to,
      });
    }
    for (const transition of outcome.authorizationTransitions) {
      this.options.events.emit({
        type: "state_change",
        at,
        classId: context.jobCycle.classId,
        jobId: context.jobCycle.jobId,
        collectionCycle: context.jobCycle.collectionCycle,
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
