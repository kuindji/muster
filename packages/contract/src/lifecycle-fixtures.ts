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
] as const);

export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];

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
  "expiry-requeue-atomic",
  "result-requeue-cycle-increment-atomic",
  "new-cycle-hash-and-epoch-atomic",
  "old-cycle-replicas-excluded",
  "authorization-identity-per-intent-id",
  "verdict-single-accepted-per-request",
  "charge-key-idempotent-under-race",
  "reserve-last-unit-race-fails-closed",
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
