import { deepFreeze } from "./deep-freeze.js";
import type { CanonicalJsonValue } from "./primitives.js";
import { PRECEDENCE_TABLE } from "./tables/precedence.js";

export const LIFECYCLE_FIXTURE_AREAS = deepFreeze([
  "payload_binding",
  "submission_retry",
  "authorization_retry",
  "verdict_retry",
  "invalidation",
  "retirement",
  "requeue_cap",
  "collection_cycle",
  "epoch_assignment",
  "urgent_saturation",
  "class_registration",
  "worker_state",
  "adjudication_health",
  "reputation",
  "identity",
  "routing",
  "operational_state",
  "lease_bounds",
  "reserve_policy",
  "fixture_coverage",
] as const);

export type LifecycleFixtureArea =
  (typeof LIFECYCLE_FIXTURE_AREAS)[number];

export const LIFECYCLE_COMMANDS = deepFreeze([
  "enqueue",
  "claimLease",
  "extendLease",
  "abandonLease",
  "expireLease",
  "submit",
  "rejectSubmission",
  "markResultSplit",
  "authorizeActions",
  "getAuthorizationStatus",
  "openResultAdjudication",
  "applyResultAdjudicationVerdict",
  "applyActionAdjudicationVerdict",
  "contractExpire",
  "emergencyHalt",
  "emergencyWithdrawEpoch",
  "operatorCancel",
  "advanceTime",
  "saturateReserve",
  "rollReserveWindow",
  "registerWorker",
  "registerClassVersion",
  "transitionWorkerState",
  "transitionWorkerRouting",
  "recordNoWorkAttempt",
  "initializeClassHealth",
  "initializeReservePolicy",
  "transitionReservePolicy",
  "chargeReserve",
  "refreshClassHealth",
  "recordReputationEvidence",
  "listLeaseCandidates",
  "compareAndClaimLease",
  "transitionQueueMode",
  "transitionClassHealth",
] as const);

export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];

/** Closed argument shapes for revision-14 commands added by freeze 3. */
export const REVISION_14_COMMAND_ARGUMENT_KEYS = deepFreeze({
  listLeaseCandidates: {
    required: ["classIds"],
    allowed: ["classIds"],
  },
  compareAndClaimLease: {
    required: ["leaseId", "candidateRevision", "workerRevision"],
    allowed: [
      "leaseId",
      "candidateRevision",
      "workerRevision",
      "queueRevision",
      "classHealthRevision",
      "contributionWindowId",
      "contributionOrdinal",
      "assignedSlotOccurrence",
      "attemptNumber",
      "queueSequence",
      "assignment",
    ],
  },
  transitionQueueMode: {
    required: ["expectedRevision", "mode"],
    allowed: ["expectedRevision", "mode"],
  },
  transitionClassHealth: {
    required: ["classId", "expectedRevision", "operating"],
    allowed: [
      "classId",
      "expectedRevision",
      "operating",
      "source",
    ],
  },
} as const);

/** Closed argument shapes for revision-15 commands added by freeze 4. */
export const REVISION_15_COMMAND_ARGUMENT_KEYS = deepFreeze({
  registerWorker: {
    required: [
      "workerId",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
    ],
    allowed: [
      "workerId",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
    ],
  },
  transitionWorkerRouting: {
    required: [
      "workerId",
      "expectedRevision",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
    ],
    allowed: [
      "workerId",
      "expectedRevision",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
    ],
  },
  initializeClassHealth: {
    required: ["classId", "operating", "source"],
    allowed: ["classId", "operating", "source"],
  },
} as const);

/** Closed argument shapes for revision-19 commands added by freeze 8. */
export const REVISION_19_COMMAND_ARGUMENT_KEYS = deepFreeze({
  compareAndClaimLease: {
    required: [
      "leaseId",
      "candidateRevision",
      "workerRevision",
      "preparedPayload",
    ],
    allowed: [
      "leaseId",
      "candidateRevision",
      "workerRevision",
      "queueRevision",
      "classHealthRevision",
      "contributionWindowId",
      "contributionOrdinal",
      "assignedSlotOccurrence",
      "attemptNumber",
      "queueSequence",
      "assignment",
      "payloadRef",
      "inputHash",
      "preparedPayload",
    ],
  },
  recordNoWorkAttempt: {
    required: [
      "workerId",
      "expectedRevision",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
      "openLeaseIds",
      "at",
    ],
    allowed: [
      "workerId",
      "expectedRevision",
      "contributionWindowId",
      "contributionUsed",
      "assignedSlotOccurrence",
      "openLeaseIds",
      "at",
    ],
  },
} as const);

/** Closed argument shapes for revision-21 commands added by freeze 10. */
export const REVISION_21_COMMAND_ARGUMENT_KEYS = deepFreeze({
  initializeReservePolicy: {
    required: [
      "classId",
      "contractVersion",
      "lane",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "at",
    ],
    allowed: [
      "classId",
      "contractVersion",
      "lane",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "perWorkerLimit",
      "at",
    ],
  },
  transitionReservePolicy: {
    required: [
      "classId",
      "contractVersion",
      "lane",
      "expectedRevision",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "at",
    ],
    allowed: [
      "classId",
      "contractVersion",
      "lane",
      "expectedRevision",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "perWorkerLimit",
      "at",
    ],
  },
  chargeReserve: {
    required: [
      "chargeKey",
      "workerIds",
      "classId",
      "contractVersion",
      "lane",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "at",
    ],
    allowed: [
      "chargeKey",
      "workerIds",
      "classId",
      "contractVersion",
      "lane",
      "policyVersion",
      "windowId",
      "windowStartsAt",
      "windowEndsAt",
      "laneLimit",
      "perWorkerLimit",
      "at",
    ],
  },
} as const);

export const LIFECYCLE_CONDITIONS: readonly string[] = deepFreeze(
  PRECEDENCE_TABLE.map((rule) => rule.id),
);

export interface LifecycleStep {
  command: LifecycleCommand;
  args: Record<string, CanonicalJsonValue>;
  barrier?: string;
  expect?: Record<string, CanonicalJsonValue>;
}

export interface ExpectFinal {
  states?: Record<string, string>;
  events?: string[];
  charges?: Record<string, number>;
  receipts?: Record<string, "byte_identical" | "terminal_immutable">;
}

export interface LifecycleFixture {
  id: string;
  version: 1;
  area: LifecycleFixtureArea;
  description: string;
  setup: Record<string, CanonicalJsonValue>;
  conditions: string[];
  steps: LifecycleStep[];
  expectFinal: ExpectFinal;
  expectOneOf?: ExpectFinal[];
}

export const REQUIRED_CONCURRENCY_CASE_IDS: readonly string[] = deepFreeze([
  "concurrent-claim-single-winner",
  "no-double-lease-per-job",
  "worker-id-binding-rejects-other-holder",
  "submit-idempotency-exact-triple",
  "conflicting-retry-preserves-accepted-row",
  "invalid-submission-settlement-atomic",
  "contract-expiry-settlement-atomic",
  "split-marker-evidence-fenced",
  "decision-evidence-snapshot-atomic",
  "canary-submission-excluded-from-replicas",
  "expiry-requeue-atomic",
  "result-requeue-cycle-increment-atomic",
  "new-cycle-hash-and-epoch-atomic",
  "old-cycle-replicas-excluded",
  "authorization-identity-per-intent-id",
  "verdict-single-accepted-per-request",
  "charge-key-idempotent-under-race",
  "reserve-last-unit-race-fails-closed",
  "class-qualified-epoch-invalidation",
  "multi-cycle-invalidation-set-atomic",
  "stale-invalidation-snapshot-conflicts",
  "emergency-epoch-transition-and-requeue-atomic",
  "worker-suspension-requeues-open-leases",
  "class-version-schema-digest-conflict",
  "pending-backlog-preserves-opened-at",
  "reputation-evidence-idempotent-under-race",
  "candidate-compare-and-claim-single-winner",
  "claim-worker-exclusion-snapshot-race",
  "claim-cycle-change-stale-snapshot",
  "claim-operational-state-stale",
  "contribution-cap-claim-race",
  "slot-occurrence-claim-race",
  "core-id-collision-refused",
  "losing-claim-id-leaves-no-state",
  "halt-versus-enqueue-atomic",
  "halt-versus-claim-atomic",
  "stale-health-refresh-cannot-replace-operator-halt",
  "queue-class-precedence-atomic",
  "reserve-policy-change-race-fails-closed",
  "reserve-health-last-unit-atomic",
  "result-adjudication-id-collision-atomic",
  "reserve-retirement-health-recompute-atomic",
  "worker-registration-routing-atomic",
  "worker-routing-period-transition-race",
  "class-health-initialization-replay-conflict",
  "no-work-contribution-single-winner",
  "canary-payload-claim-atomic",
]);

export const REQUIRED_INJECTION_CATEGORIES: readonly string[] = deepFreeze([
  "direct_instruction",
  "tool_redirection",
  "exfiltration",
  "role_reassignment",
  "markdown_smuggling",
  "schema_escape",
]);

export const REQUIRED_LIFECYCLE_FIXTURE_IDS: readonly string[] = deepFreeze([
  "enqueue-hashes-exact-sanitized-payload",
  "input-hash-binds-both-schemas",
  "sub-retry-after-submission-closed",
  "sub-retry-after-lease-expiry",
  "sub-retry-after-contract-expiry",
  "sub-retry-after-admission-halt",
  "sub-retry-after-emergency-halt",
  "sub-retry-after-permit-withdrawal",
  "sub-conflict-different-result",
  "sub-exact-retry-wrong-worker-refused",
  "invalid-submission-requeues-same-cycle",
  "contract-cutoff-settles-submission",
  "absorbing-split-marker-persists",
  "extend-wrong-worker-refused",
  "abandon-wrong-worker-refused",
  "auth-exact-retry-replays-initial-receipt",
  "auth-authorized-retry-includes-same-authorization",
  "auth-conflict-different-decision-hash",
  "auth-conflict-different-intent-hash",
  "result-verdict-exact-retry",
  "result-verdict-conflict",
  "result-verdict-after-terminal",
  "action-verdict-exact-retry",
  "action-verdict-conflict",
  "action-verdict-after-terminal",
  "invalidate-emergency-halted",
  "invalidate-emergency-permit-withdrawal",
  "invalidate-contract-expired",
  "invalidate-max-in-flight",
  "invalidate-operator-cancelled",
  "retire-verified-before-second-intent",
  "withdrawal-supersedes-partially-authorized-result",
  "requeue-after-rejected-dispute",
  "requeue-cap-exhausted",
  "rejected-dispute-starts-new-cycle",
  "old-cycle-receipt-replays",
  "old-cycle-replicas-excluded-from-new-cycle",
  "lease-expiry-stays-in-cycle",
  "mixed-cycle-evidence-refused",
  "new-cycle-recomputes-input-hash",
  "epoch-sticky-through-requeue",
  "epoch-current-after-max-in-flight",
  "epoch-split-evidence-reroute-stays",
  "auth-urgent-saturated-denial",
  "urgent-fresh-intent-after-window",
  "epoch-label-isolated-by-class",
  "withdrawal-requeues-distinct-job-hashes",
  "worker-revocation-requeues-open-leases",
  "class-version-identical-schema-replays",
  "class-version-schema-conflicts",
  "adjudication-backlog-age-is-observable",
  "reputation-evidence-replays-and-conflicts",
  "routing-core-selects-store-compares",
  "routing-facts-persist-on-lease",
  "canary-assignment-durable-hash-only",
  "idsource-collision-preserves-existing",
  "losing-claim-id-is-skipped",
  "enqueue-refuses-stale-operational-revision",
  "claim-refuses-stale-operational-revision",
  "emergency-halt-publishes-invalidation-atomically",
  "stale-health-refresh-preserves-operator-halt",
  "lease-ttl-bound-at-enqueue",
  "lease-registration-quantized-strict-bound",
  "extension-deadline-strict",
  "reserve-policy-version-conflict",
  "reserve-window-rollover-isolated",
  "reserve-policy-initialization-replay-conflict",
  "reserve-zero-limit-saturates-on-install",
  "reserve-policy-same-window-retains-usage",
  "reserve-window-rollback-refused",
  "reserve-charge-key-input-conflict",
  "reserve-missing-policy-refuses-all-charge-paths",
  "reserve-retirement-clears-only-applicable-lane",
  "result-adjudication-id-collision-preserves-state",
  "health-transition-preserves-accounting-lanes",
  "agreement-fixture-families-required",
  "oracle-negative-fixture-families-bound",
  "worker-registration-routing-atomic",
  "worker-routing-transition-preserves-open-leases",
  "worker-state-transition-fences-prepared-claim",
  "class-health-initialization-replay-conflict",
  "ordinary-claim-payload-mismatch-refused",
  "canary-claim-binds-operational-payload",
  "no-work-attempt-advances-contribution-once",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const EXPECT_FINAL_KEYS = [
  "states",
  "events",
  "charges",
  "receipts",
] as const;
const STEP_KEYS = ["command", "args", "expect", "barrier"] as const;
const FIXTURE_KEYS = [
  "id",
  "version",
  "description",
  "area",
  "setup",
  "conditions",
  "steps",
  "expectFinal",
  "expectOneOf",
] as const;

function isExpectFinal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const isStringMap = (item: unknown): boolean =>
    isRecord(item) && Object.values(item).every((entry) =>
      typeof entry === "string",
    );
  const isNumberMap = (item: unknown): boolean =>
    isRecord(item) && Object.values(item).every((entry) =>
      typeof entry === "number" && Number.isFinite(entry),
    );
  if (value.states !== undefined && !isStringMap(value.states)) return false;
  if (
    value.events !== undefined &&
    !(
      Array.isArray(value.events) &&
      value.events.every((entry) => typeof entry === "string")
    )
  ) return false;
  if (value.charges !== undefined && !isNumberMap(value.charges)) return false;
  if (
    value.receipts !== undefined &&
    !(
      isRecord(value.receipts) &&
      Object.values(value.receipts).every((receipt) =>
        receipt === "byte_identical" || receipt === "terminal_immutable",
      )
    )
  ) return false;
  return hasOnlyKeys(value, EXPECT_FINAL_KEYS);
}

export function isLifecycleFixture(
  fixture: unknown,
): fixture is LifecycleFixture {
  if (!isRecord(fixture) || !hasOnlyKeys(fixture, FIXTURE_KEYS)) return false;
  if (
    typeof fixture.id !== "string" ||
    fixture.version !== 1 ||
    typeof fixture.description !== "string"
  ) return false;
  if (
    !(LIFECYCLE_FIXTURE_AREAS as readonly string[]).includes(
      fixture.area as string,
    )
  ) return false;
  if (!isRecord(fixture.setup)) return false;
  if (
    !Array.isArray(fixture.conditions) ||
    !fixture.conditions.every((condition) =>
      (LIFECYCLE_CONDITIONS as readonly string[]).includes(
        condition as string,
      ),
    )
  ) return false;
  if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) return false;
  let hasBarrier = false;
  for (const step of fixture.steps) {
    if (!isRecord(step) || !hasOnlyKeys(step, STEP_KEYS)) return false;
    if (
      !(LIFECYCLE_COMMANDS as readonly string[]).includes(
        step.command as string,
      )
    ) return false;
    if (!isRecord(step.args)) return false;
    const args = step.args;
    const closedShape = (
      REVISION_21_COMMAND_ARGUMENT_KEYS as Record<string, {
        readonly required: readonly string[];
        readonly allowed: readonly string[];
      }>
    )[step.command as string] ?? (
      REVISION_19_COMMAND_ARGUMENT_KEYS as Record<string, {
        readonly required: readonly string[];
        readonly allowed: readonly string[];
      }>
    )[step.command as string] ?? (
      REVISION_15_COMMAND_ARGUMENT_KEYS as Record<string, {
        readonly required: readonly string[];
        readonly allowed: readonly string[];
      }>
    )[step.command as string] ?? (
      REVISION_14_COMMAND_ARGUMENT_KEYS as Record<string, {
        readonly required: readonly string[];
        readonly allowed: readonly string[];
      }>
    )[step.command as string];
    if (closedShape !== undefined) {
      if (!hasOnlyKeys(args, closedShape.allowed)) return false;
      if (!closedShape.required.every((key) =>
        Object.hasOwn(args, key),
      )) return false;
    }
    if (step.expect !== undefined && !isRecord(step.expect)) return false;
    if (step.barrier !== undefined) {
      if (typeof step.barrier !== "string") return false;
      hasBarrier = true;
    }
  }
  if (!isExpectFinal(fixture.expectFinal)) return false;
  if (
    fixture.expectOneOf !== undefined &&
    !(
      Array.isArray(fixture.expectOneOf) &&
      fixture.expectOneOf.length > 0 &&
      fixture.expectOneOf.every(isExpectFinal)
    )
  ) return false;
  if (hasBarrier && fixture.expectOneOf === undefined) return false;
  return true;
}
