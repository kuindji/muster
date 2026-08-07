import type {
  AdjudicationPolicy,
  ClassHealth,
  Timestamp,
} from "@kuindji/muster-contract";

import type {
  AdjudicationSource,
  ClassHealthSnapshot,
  ClassVersionRecord,
  Clock,
  EventSink,
  OperationsSource,
  QueueCapacityObservation,
  QueueModeSnapshot,
  Store,
} from "./ports.js";
import type { RuntimeClassRegistry } from "./registration.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

const validTimestamp = (value: unknown): value is Timestamp =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
};

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const validObservation = (
  observation: unknown,
  at: Timestamp,
): observation is QueueCapacityObservation => {
  if (typeof observation !== "object" || observation === null ||
    Array.isArray(observation)) return false;
  const value = observation as Record<string, unknown>;
  if (!exactKeys(value, [
    "observedAt", "activeWorkers", "itemsPerBatch",
    "combinedCanaryAuditFraction", "meanReplicationFactor",
    "minimumEffectiveCapacity", "slotWindow",
  ], ["oldestSlaBreachAt"])) return false;
  if (
    value.observedAt !== at ||
    !Number.isSafeInteger(value.activeWorkers) || Number(value.activeWorkers) < 0 ||
    !finiteNonNegative(value.itemsPerBatch) || value.itemsPerBatch === 0 ||
    !finiteNonNegative(value.combinedCanaryAuditFraction) ||
    value.combinedCanaryAuditFraction >= 1 ||
    !finiteNonNegative(value.meanReplicationFactor) ||
    value.meanReplicationFactor < 1 ||
    !finiteNonNegative(value.minimumEffectiveCapacity) ||
    (value.oldestSlaBreachAt !== undefined &&
      (!validTimestamp(value.oldestSlaBreachAt) ||
        Date.parse(value.oldestSlaBreachAt) > Date.parse(at)))
  ) return false;
  if (typeof value.slotWindow !== "object" || value.slotWindow === null ||
    Array.isArray(value.slotWindow)) return false;
  const window = value.slotWindow as Record<string, unknown>;
  if (!exactKeys(window, ["startsAt", "endsAt", "providers"]) ||
    !validTimestamp(window.startsAt) || !validTimestamp(window.endsAt) ||
    Date.parse(window.startsAt) >= Date.parse(window.endsAt) ||
    window.endsAt !== at || !Array.isArray(window.providers)) return false;
  const seen = new Set<string>();
  return window.providers.every((provider) => {
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      return false;
    }
    const entry = provider as Record<string, unknown>;
    if (!exactKeys(entry, [
      "providerSurface", "expectedArrivals", "observedArrivals",
    ]) || typeof entry.providerSurface !== "string" ||
      entry.providerSurface.length === 0 || seen.has(entry.providerSurface) ||
      !Number.isSafeInteger(entry.expectedArrivals) ||
      Number(entry.expectedArrivals) < 0 ||
      !Number.isSafeInteger(entry.observedArrivals) ||
      Number(entry.observedArrivals) < 0) return false;
    seen.add(entry.providerSurface);
    return true;
  });
};

export interface CapacityProjectionInput {
  readonly activeWorkers: number;
  readonly itemsPerBatch: number;
  readonly combinedCanaryAuditFraction: number;
  readonly meanReplicationFactor: number;
}

/** Revision 25 section 6.12 effective, not nominal, throughput. */
export const projectCapacity = (input: CapacityProjectionInput): number => {
  if (
    !Number.isSafeInteger(input.activeWorkers) || input.activeWorkers < 0 ||
    !Number.isFinite(input.itemsPerBatch) || input.itemsPerBatch <= 0 ||
    !Number.isFinite(input.combinedCanaryAuditFraction) ||
    input.combinedCanaryAuditFraction < 0 ||
    input.combinedCanaryAuditFraction >= 1 ||
    !Number.isFinite(input.meanReplicationFactor) ||
    input.meanReplicationFactor < 1
  ) throw new RangeError("invalid capacity projection input");
  const capacity = input.activeWorkers * input.itemsPerBatch *
    (1 - input.combinedCanaryAuditFraction) / input.meanReplicationFactor;
  if (!Number.isFinite(capacity) || capacity < 0) {
    throw new RangeError("capacity projection overflow");
  }
  return capacity;
};

export interface AggregatedAdjudicationPolicy {
  readonly requiredRatePerWeek: number;
  readonly restoreAbovePerWeek: number;
  readonly starvationDwell: number;
  readonly capacityMaxAge: number;
}

const aggregatePolicies = (
  policies: readonly AdjudicationPolicy[],
): AggregatedAdjudicationPolicy | null => {
  if (policies.length === 0) return null;
  const aggregate = {
    requiredRatePerWeek: policies.reduce(
      (total, policy) => total + policy.requiredRatePerWeek,
      0,
    ),
    restoreAbovePerWeek: policies.reduce(
      (total, policy) => total + policy.restoreAbovePerWeek,
      0,
    ),
    starvationDwell: Math.min(...policies.map((policy) => policy.starvationDwell)),
    capacityMaxAge: Math.min(...policies.map((policy) => policy.capacityMaxAge)),
  };
  return Object.values(aggregate).every((value) =>
      Number.isFinite(value) && value > 0
    ) && aggregate.restoreAbovePerWeek > aggregate.requiredRatePerWeek
    ? aggregate
    : null;
};

export type QueueOperationResult =
  | { readonly kind: "invalid_observation"; readonly queue: QueueModeSnapshot }
  | {
      readonly kind: "unchanged" | "retained";
      readonly queue: QueueModeSnapshot;
      readonly effectiveCapacity?: number;
      readonly offlineProviders?: readonly string[];
    }
  | {
      readonly kind: "applied" | "replayed" | "conflict";
      readonly queue: QueueModeSnapshot;
      readonly effectiveCapacity?: number;
      readonly offlineProviders?: readonly string[];
    };

export type ClassHealthOperationResult =
  | {
      readonly kind:
        | "runtime_mismatch"
        | "invalid_capacity"
        | "restore_refused"
        | "retained";
      readonly health: ClassHealthSnapshot | null;
    }
  | {
      readonly kind: "unchanged" | "applied" | "replayed" | "conflict";
      readonly health: ClassHealthSnapshot;
      readonly policy: AggregatedAdjudicationPolicy | null;
    };

export type EmergencyHaltResult = Awaited<
  ReturnType<Store["enterEmergencyHalt"]>
> | { readonly kind: "unchanged"; readonly queue: QueueModeSnapshot };

const sameOperating = (
  health: ClassHealth,
  operating: ClassHealth["operating"],
): boolean => health.operating === operating;

export class OperationsService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly registry: RuntimeClassRegistry;
    readonly clock: Clock;
    readonly operations: OperationsSource;
    readonly adjudication: AdjudicationSource;
    readonly events: EventSink;
  }) {}

  async refreshQueueMode(): Promise<QueueOperationResult> {
    const at = this.options.clock.now();
    const queue = await this.options.store.getQueueMode();
    if (!validTimestamp(at)) return { kind: "invalid_observation", queue };
    let observation: QueueCapacityObservation;
    try {
      observation = this.options.operations.observeQueue();
    } catch {
      await this.recordQueue("refresh", "invalid_observation", queue, at);
      return { kind: "invalid_observation", queue };
    }
    if (!validObservation(observation, at)) {
      await this.recordQueue("refresh", "invalid_observation", queue, at);
      return { kind: "invalid_observation", queue };
    }
    let effectiveCapacity: number;
    try {
      effectiveCapacity = projectCapacity(observation);
    } catch {
      await this.recordQueue("refresh", "invalid_observation", queue, at);
      return { kind: "invalid_observation", queue };
    }
    const offlineProviders = observation.slotWindow.providers
      .filter((provider) =>
        provider.expectedArrivals > 0 && provider.observedArrivals === 0
      )
      .map((provider) => provider.providerSurface)
      .sort();
    const expectedArrivals = observation.slotWindow.providers.reduce(
      (total, provider) => total + provider.expectedArrivals,
      0,
    );
    const observedArrivals = observation.slotWindow.providers.reduce(
      (total, provider) => total + provider.observedArrivals,
      0,
    );
    if (queue.mode === "admission_halted" || queue.mode === "emergency_halted") {
      await this.recordQueue("refresh", "retained", queue, at);
      return { kind: "retained", queue, effectiveCapacity, offlineProviders };
    }
    const next = expectedArrivals > 0 && observedArrivals === 0
      ? { mode: "admission_halted" as const, cause: "pool_offline" as const }
      : observation.oldestSlaBreachAt !== undefined
        ? { mode: "degraded" as const, cause: "sla" as const }
        : effectiveCapacity < observation.minimumEffectiveCapacity
          ? { mode: "degraded" as const, cause: "capacity" as const }
          : {
              mode: "normal" as const,
              cause: queue.mode === "degraded" &&
                  (queue.cause === "sla" || queue.cause === "capacity")
                ? queue.cause
                : "capacity" as const,
            };
    if (queue.mode === next.mode &&
      (queue.mode === "normal" || queue.cause === next.cause)) {
      await this.recordQueue("refresh", "unchanged", queue, at);
      return { kind: "unchanged", queue, effectiveCapacity, offlineProviders };
    }
    const outcome = await this.options.store.transitionQueueMode({
      expected: queue,
      next: { ...next, updatedAt: at },
    });
    if (outcome.kind === "applied") {
      if (queue.mode !== "degraded" && outcome.current.mode === "degraded") {
        this.options.events.emit({ type: "backpressure", at });
      }
      if (outcome.current.mode === "admission_halted" &&
        outcome.current.cause === "pool_offline") {
        this.options.events.emit({ type: "pool_offline", at });
      }
    }
    await this.recordQueue("refresh", outcome.kind, outcome.current, at);
    return {
      kind: outcome.kind,
      queue: outcome.current,
      effectiveCapacity,
      offlineProviders,
    };
  }

  async pauseAdmission(): Promise<QueueOperationResult> {
    return this.operatorQueueTransition("admission_halted");
  }

  async restoreAdmission(): Promise<QueueOperationResult> {
    return this.operatorQueueTransition("normal");
  }

  private async operatorQueueTransition(
    mode: "normal" | "admission_halted",
  ): Promise<QueueOperationResult> {
    const at = this.options.clock.now();
    const queue = await this.options.store.getQueueMode();
    if (!validTimestamp(at)) return { kind: "retained", queue };
    if (queue.mode === "emergency_halted" ||
      (mode === "normal" && queue.mode !== "admission_halted")) {
      await this.recordQueue("operator_transition", "retained", queue, at);
      return { kind: "retained", queue };
    }
    if (queue.mode === mode && queue.cause === "operator") {
      await this.recordQueue("operator_transition", "unchanged", queue, at);
      return { kind: "unchanged", queue };
    }
    const outcome = await this.options.store.transitionQueueMode({
      expected: queue,
      next: { mode, cause: "operator", updatedAt: at },
    });
    await this.recordQueue("operator_transition", outcome.kind, outcome.current, at);
    return { kind: outcome.kind, queue: outcome.current };
  }

  async refreshClassHealth(classId: string): Promise<ClassHealthOperationResult> {
    return this.evaluateClassHealth(classId, false);
  }

  async restoreClassHealth(classId: string): Promise<ClassHealthOperationResult> {
    return this.evaluateClassHealth(classId, true);
  }

  private async evaluateClassHealth(
    classId: string,
    restore: boolean,
  ): Promise<ClassHealthOperationResult> {
    const at = this.options.clock.now();
    const health = await this.options.store.getClassHealth(classId);
    if (health === null || !validTimestamp(at)) {
      return { kind: "runtime_mismatch", health };
    }
    if (health.health.operating === "admission_halted" ||
      health.health.operating === "emergency_halted") {
      await this.recordHealth(restore ? "restore" : "refresh", "retained", health, at);
      return { kind: "retained", health };
    }
    const versions = await this.options.store.listClassVersions(classId);
    const live = versions.filter((version) =>
      version.state === "active" || version.state === "draining"
    );
    if (live.length === 0) return { kind: "runtime_mismatch", health };
    const policies: AdjudicationPolicy[] = [];
    for (const version of live) {
      const compatibility = await this.options.registry.compatibility(
        this.options.store,
        classId,
        version.contractVersion,
      );
      if (!compatibility.ok) return { kind: "runtime_mismatch", health };
      if (compatibility.entry.jobClass.adjudication !== undefined) {
        policies.push(compatibility.entry.jobClass.adjudication);
      }
    }
    const policy = aggregatePolicies(policies);
    if (policies.length > 0 && policy === null) {
      return { kind: "runtime_mismatch", health };
    }
    const windowStartsAt = new Date(Date.parse(at) - WEEK_MS).toISOString();
    const load = await this.options.store.inspectAdjudicationLoad({
      classId,
      windowStartsAt,
    });
    if (policy === null) {
      if (restore && health.health.operating === "adjudication_starved") {
        return this.applyHealthRefresh(
          health,
          load,
          versions,
          { operating: "ready" },
          undefined,
          "operator",
          at,
          policy,
        );
      }
      if (restore || health.health.operating === "adjudication_starved") {
        return { kind: "restore_refused", health };
      }
      if (health.adjudicationUnsafeSince === undefined) {
        return { kind: "unchanged", health, policy };
      }
      return this.applyHealthRefresh(
        health,
        load,
        versions,
        { operating: "ready" },
        undefined,
        "automatic",
        at,
        policy,
      );
    }
    let capacity;
    try {
      capacity = this.options.adjudication.capacity(classId);
    } catch {
      return { kind: "invalid_capacity", health };
    }
    const capacityAt = Date.parse(capacity.observedAt);
    const now = Date.parse(at);
    if (capacity.classId !== classId ||
      !finiteNonNegative(capacity.availableReviewsPerWeek) ||
      !Number.isFinite(capacityAt) || capacityAt > now) {
      return { kind: "invalid_capacity", health };
    }
    const capacityFresh = (now - capacityAt) / 1_000 <= policy.capacityMaxAge;
    const oldestAge = load.oldestPendingOpenedAt === undefined
      ? 0
      : (now - Date.parse(load.oldestPendingOpenedAt)) / 1_000;
    if (!Number.isFinite(oldestAge) || oldestAge < 0) {
      return { kind: "runtime_mismatch", health };
    }
    const demandCovered = capacityFresh &&
      load.admittedDemand <= capacity.availableReviewsPerWeek;
    const backlogWithinDwell = oldestAge < policy.starvationDwell;
    if (restore) {
      if (health.health.operating !== "adjudication_starved" ||
        !capacityFresh ||
        capacity.availableReviewsPerWeek <= policy.restoreAbovePerWeek ||
        !demandCovered || !backlogWithinDwell) {
        await this.recordHealth("restore", "restore_refused", health, at);
        return { kind: "restore_refused", health };
      }
      return this.applyHealthRefresh(
        health,
        load,
        versions,
        { operating: "ready" },
        undefined,
        "operator",
        at,
        policy,
      );
    }
    if (health.health.operating === "adjudication_starved") {
      await this.recordHealth("refresh", "unchanged", health, at);
      return { kind: "unchanged", health, policy };
    }
    const unsafeCapacity = !capacityFresh ||
      capacity.availableReviewsPerWeek < policy.requiredRatePerWeek ||
      !demandCovered;
    const backlogOverdue = !backlogWithinDwell;
    const unsafe = unsafeCapacity || backlogOverdue;
    const unsafeSince = unsafe
      ? health.adjudicationUnsafeSince ?? at
      : undefined;
    const unsafeAge = unsafeSince === undefined
      ? 0
      : (now - Date.parse(unsafeSince)) / 1_000;
    const operating = backlogOverdue || unsafeAge >= policy.starvationDwell
      ? "adjudication_starved" as const
      : "ready" as const;
    if (sameOperating(health.health, operating) &&
      health.adjudicationUnsafeSince === unsafeSince) {
      await this.recordHealth("refresh", "unchanged", health, at);
      return { kind: "unchanged", health, policy };
    }
    return this.applyHealthRefresh(
      health,
      load,
      versions,
      { operating },
      unsafeSince,
      "automatic",
      at,
      policy,
    );
  }

  private async applyHealthRefresh(
    expectedHealth: ClassHealthSnapshot,
    expectedLoad: Awaited<ReturnType<Store["inspectAdjudicationLoad"]>>,
    expectedClassVersions: ClassVersionRecord[],
    health: Pick<ClassHealth, "operating">,
    adjudicationUnsafeSince: Timestamp | undefined,
    source: "automatic" | "operator",
    at: Timestamp,
    policy: AggregatedAdjudicationPolicy | null,
  ): Promise<ClassHealthOperationResult> {
    const outcome = await this.options.store.refreshClassHealth({
      expectedHealth,
      expectedLoad,
      expectedClassVersions,
      next: {
        health,
        updatedAt: at,
        source,
        ...(adjudicationUnsafeSince === undefined
          ? {}
          : { adjudicationUnsafeSince }),
      },
    });
    if (outcome.kind === "applied" &&
      outcome.health.health.operating !== expectedHealth.health.operating) {
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId: outcome.health.classId,
        health: outcome.health.health,
      });
    }
    await this.recordHealth("health_transition", outcome.kind, outcome.health, at);
    return { kind: outcome.kind, health: outcome.health, policy };
  }

  async setClassAdmission(
    classId: string,
    halted: boolean,
  ): Promise<ClassHealthOperationResult> {
    const at = this.options.clock.now();
    const health = await this.options.store.getClassHealth(classId);
    if (health === null || !validTimestamp(at)) {
      return { kind: "runtime_mismatch", health };
    }
    if (health.health.operating === "emergency_halted" ||
      (!halted && health.health.operating !== "admission_halted")) {
      return { kind: "retained", health };
    }
    const operating = halted ? "admission_halted" as const : "ready" as const;
    if (health.health.operating === operating) {
      return { kind: "unchanged", health, policy: null };
    }
    const outcome = await this.options.store.transitionClassHealth({
      expected: health,
      next: { health: { operating }, updatedAt: at, source: "operator" },
    });
    if (outcome.kind === "applied") {
      this.options.events.emit({
        type: "class_health_changed",
        at,
        classId,
        health: outcome.current.health,
      });
    }
    await this.recordHealth("operator_admission", outcome.kind, outcome.current, at);
    return { kind: outcome.kind, health: outcome.current, policy: null };
  }

  async enterEmergencyHalt(): Promise<EmergencyHaltResult> {
    const at = this.options.clock.now();
    const queue = await this.options.store.getQueueMode();
    if (!validTimestamp(at)) return { kind: "unchanged", queue };
    if (queue.mode === "emergency_halted") {
      await this.recordQueue("emergency_halt", "unchanged", queue, at);
      return { kind: "unchanged", queue };
    }
    const classHealth = await this.options.store.listClassHealth();
    const prepared = await Promise.all(classHealth.map(async (health) => ({
      health,
      invalidation: await this.options.store.inspectInvalidationScope({
        kind: "class",
        classId: health.classId,
      }),
      pendingActions: await this.options.store.listPendingActionAdjudications(
        health.classId,
      ),
    })));
    const outcome = await this.options.store.enterEmergencyHalt({
      expectedQueue: queue,
      nextQueue: { mode: "emergency_halted", cause: "emergency", updatedAt: at },
      expectedClassHealth: classHealth,
      nextClassHealth: classHealth.map((health) => ({
        classId: health.classId,
        health: { operating: "emergency_halted" },
        updatedAt: at,
        source: "operator",
      })),
      invalidations: prepared.map(({ health, invalidation }) => ({
        scope: { kind: "class", classId: health.classId },
        expectedTargets: invalidation.targets,
        requeuePlans: [],
      })),
      at,
    });
    if (outcome.kind === "applied") {
      for (const health of outcome.classHealth) {
        this.options.events.emit({
          type: "class_health_changed",
          at,
          classId: health.classId,
          health: health.health,
        });
      }
      for (let index = 0; index < outcome.invalidations.length; index += 1) {
        this.emitEmergencyInvalidation(
          outcome.invalidations[index]!,
          prepared[index]!,
          at,
        );
      }
    }
    await this.recordQueue("emergency_halt", outcome.kind, outcome.queue, at);
    return outcome;
  }

  private emitEmergencyInvalidation(
    outcome: Extract<
      Awaited<ReturnType<Store["enterEmergencyHalt"]>>,
      { kind: "applied" }
    >["invalidations"][number],
    prepared: {
      health: ClassHealthSnapshot;
      invalidation: Awaited<ReturnType<Store["inspectInvalidationScope"]>>;
      pendingActions: Awaited<ReturnType<Store["listPendingActionAdjudications"]>>;
    },
    at: Timestamp,
  ): void {
    for (const transition of outcome.resultTransitions) {
      const target = prepared.invalidation.targets.find((entry) =>
        entry.jobId === transition.jobId &&
        entry.collectionCycle === transition.collectionCycle
      );
      this.options.events.emit({
        type: "state_change",
        at,
        classId: prepared.health.classId,
        jobId: transition.jobId,
        collectionCycle: transition.collectionCycle,
        subjectKind: "result",
        contractVersion: target?.contractVersion ?? "unknown-contract",
        from: transition.from,
        to: transition.to,
      });
    }
    for (const transition of outcome.authorizationTransitions) {
      const pending = prepared.pendingActions.find((entry) =>
        entry.request.authorizationRequestId === transition.authorizationRequestId
      );
      if (pending === undefined) continue;
      this.options.events.emit({
        type: "state_change",
        at,
        classId: prepared.health.classId,
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

  private async recordQueue(
    kind: string,
    outcome: string,
    queue: QueueModeSnapshot,
    at: Timestamp,
  ): Promise<void> {
    const appended = await this.options.store.appendLedger({
      at,
      kind: `queue_${kind}`,
      outcome,
      privacy: "sensitive",
      correlationId: `queue:${queue.revision}`,
      hashes: {},
    });
    if (appended.kind !== "recorded") throw new Error("queue ledger append refused");
  }

  private async recordHealth(
    kind: string,
    outcome: string,
    health: ClassHealthSnapshot,
    at: Timestamp,
  ): Promise<void> {
    const appended = await this.options.store.appendLedger({
      at,
      kind: `class_health_${kind}`,
      outcome,
      privacy: "sensitive",
      classId: health.classId,
      correlationId: `class-health:${health.classId}:${health.revision}`,
      hashes: {},
    });
    if (appended.kind !== "recorded") throw new Error("health ledger append refused");
  }
}
