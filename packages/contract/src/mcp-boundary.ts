import { canonicalize } from "./canonical/jcs.js";
import { deepFreeze } from "./deep-freeze.js";
import { isWireId } from "./primitives.js";
import type {
  AuthenticatedWorkerSubject,
  Timestamp,
  WorkerId,
} from "./primitives.js";
import {
  PAYLOAD_PAD_BUCKETS_BYTES,
  bucketFor,
} from "./tables/quantization.js";

export const MUSTER_MCP_TOOL_NAMES = deepFreeze([
  "lease_job",
  "submit_result",
  "abandon_job",
  "extend_lease",
  "get_worker_status",
  "set_availability",
] as const);

export type MusterMcpToolName = (typeof MUSTER_MCP_TOOL_NAMES)[number];

/** Exact OAuth scope vocabulary. Wildcard-looking scope names are not used. */
export const MUSTER_MCP_ENDPOINT_SCOPE = "muster:access";
export const MUSTER_MCP_JOB_SCOPE = "muster:jobs";
export const MUSTER_MCP_WORKER_SCOPE = "muster:worker";
export const MUSTER_MCP_SCOPES = deepFreeze([
  MUSTER_MCP_ENDPOINT_SCOPE,
  MUSTER_MCP_JOB_SCOPE,
  MUSTER_MCP_WORKER_SCOPE,
] as const);

export type MusterMcpScope = (typeof MUSTER_MCP_SCOPES)[number];

export const MUSTER_MCP_TOOL_SCOPES: Readonly<
  Record<MusterMcpToolName, MusterMcpScope>
> = deepFreeze({
  lease_job: MUSTER_MCP_JOB_SCOPE,
  submit_result: MUSTER_MCP_JOB_SCOPE,
  abandon_job: MUSTER_MCP_JOB_SCOPE,
  extend_lease: MUSTER_MCP_JOB_SCOPE,
  get_worker_status: MUSTER_MCP_WORKER_SCOPE,
  set_availability: MUSTER_MCP_WORKER_SCOPE,
});

/**
 * Usage, not remaining allowance. Boundaries are exact and integer-only:
 * 0 = unused, 1 = at most half used, 2 = over half but below cap, 3 = at cap.
 * A zero cap is exhausted even when the durable used count is also zero.
 */
export const CAP_USAGE_BUCKET_MEANINGS = deepFreeze({
  0: "unused",
  1: "used_at_most_half",
  2: "used_over_half_below_cap",
  3: "at_cap",
} as const);

export type CapUsageBucket = keyof typeof CAP_USAGE_BUCKET_MEANINGS;

export function capUsageBucket(
  contributionUsed: number,
  declaredCapPerWeek: number,
): CapUsageBucket {
  if (
    !Number.isSafeInteger(contributionUsed) ||
    contributionUsed < 0 ||
    !Number.isSafeInteger(declaredCapPerWeek) ||
    declaredCapPerWeek < 0
  ) {
    throw new RangeError("cap usage requires non-negative safe integers");
  }
  if (declaredCapPerWeek === 0 || contributionUsed >= declaredCapPerWeek) return 3;
  if (contributionUsed === 0) return 0;
  return contributionUsed <= Math.floor(declaredCapPerWeek / 2) ? 1 : 2;
}

/** Coarse index table for seconds until the deployment-owned next slot. */
export const NEXT_SLOT_BUCKET_MEANINGS = deepFreeze({
  0: "open_now",
  1: "within_1_hour",
  2: "within_6_hours",
  3: "within_24_hours",
  4: "within_72_hours",
  5: "later_than_72_hours",
} as const);

export type NextSlotBucket = keyof typeof NEXT_SLOT_BUCKET_MEANINGS;

export function nextSlotBucket(secondsUntilStart: number): NextSlotBucket {
  if (!Number.isFinite(secondsUntilStart) || secondsUntilStart < 0) {
    throw new RangeError("next-slot distance must be finite and non-negative");
  }
  if (secondsUntilStart === 0) return 0;
  if (secondsUntilStart <= 3_600) return 1;
  if (secondsUntilStart <= 21_600) return 2;
  if (secondsUntilStart <= 86_400) return 3;
  if (secondsUntilStart <= 259_200) return 4;
  return 5;
}

/**
 * One immutable skill release is selected by the accepted worker contract and
 * the complete enrolled class set. Array order is deliberately not identity.
 */
export function skillReleaseSelectionKey(input: {
  readonly contractVersion: string;
  readonly jobClassIds: readonly string[];
}): string {
  if (!isWireId(input.contractVersion)) {
    throw new RangeError("invalid skill release contract version");
  }
  if (
    input.jobClassIds.length === 0 ||
    input.jobClassIds.some((classId) => !isWireId(classId)) ||
    new Set(input.jobClassIds).size !== input.jobClassIds.length
  ) {
    throw new RangeError("invalid skill release class set");
  }
  return canonicalize({
    contract_version: input.contractVersion,
    job_class_ids: [...input.jobClassIds].sort(),
  });
}

/**
 * Padding is outside the parsed MCP value. JSON responses append insignificant
 * trailing ASCII whitespace; SSE responses append ignored comment bytes. The
 * complete encoded response, not the payload value alone, selects the bucket.
 */
export const MCP_LEASE_PADDING = deepFreeze({
  jsonRepresentation: "trailing_ascii_whitespace",
  sseRepresentation: "trailing_sse_comment",
  overflow: "continue_power_of_four",
} as const);

export function mcpLeasePaddingTargetBytes(encodedResponseBytes: number): number {
  if (!Number.isSafeInteger(encodedResponseBytes) || encodedResponseBytes < 0) {
    throw new RangeError("encoded response length must be a non-negative safe integer");
  }
  const frozen = bucketFor(encodedResponseBytes, PAYLOAD_PAD_BUCKETS_BYTES);
  if (frozen !== null) return frozen;
  let bucket = PAYLOAD_PAD_BUCKETS_BYTES.at(-1)!;
  while (bucket < encodedResponseBytes) {
    bucket *= 4;
    if (!Number.isSafeInteger(bucket)) {
      throw new RangeError("response padding bucket overflow");
    }
  }
  return bucket;
}

export interface McpRateLimitPolicy {
  readonly version: string;
  readonly windowSeconds: number;
  readonly maxCallsPerWindow: Readonly<Record<MusterMcpToolName, number>>;
  readonly maxLeaseAttemptsPerSlot: number;
}

export interface McpRateWindow {
  readonly id: string;
  readonly startsAt: Timestamp;
  readonly endsAt: Timestamp;
}

/** Mandatory per-request revocation boundary; bearer bytes never cross it. */
export interface McpTokenRevocationSource {
  isRevoked(input: {
    readonly issuer: string;
    readonly tokenFingerprintSha256: string;
    readonly at: Timestamp;
  }): Promise<boolean>;
}

export function mcpRateWindow(
  policy: McpRateLimitPolicy,
  at: Timestamp,
): McpRateWindow {
  if (
    !isWireId(policy.version) ||
    !Number.isSafeInteger(policy.windowSeconds) ||
    policy.windowSeconds <= 0 ||
    !Number.isSafeInteger(policy.maxLeaseAttemptsPerSlot) ||
    policy.maxLeaseAttemptsPerSlot <= 0 ||
    MUSTER_MCP_TOOL_NAMES.some((tool) =>
      !Number.isSafeInteger(policy.maxCallsPerWindow[tool]) ||
      policy.maxCallsPerWindow[tool] <= 0
    )
  ) {
    throw new RangeError("invalid MCP rate-limit policy");
  }
  const milliseconds = Date.parse(at);
  if (!Number.isFinite(milliseconds)) throw new RangeError("invalid rate-window time");
  const windowMilliseconds = policy.windowSeconds * 1_000;
  const starts = Math.floor(milliseconds / windowMilliseconds) * windowMilliseconds;
  const ends = starts + windowMilliseconds;
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) {
    throw new RangeError("rate-window overflow");
  }
  const startsAt = new Date(starts).toISOString();
  return {
    id: `${policy.version}:${startsAt}`,
    startsAt,
    endsAt: new Date(ends).toISOString(),
  };
}

export interface McpSubjectBinding {
  readonly revision: number;
  readonly bindingId: string;
  readonly subject: AuthenticatedWorkerSubject;
  readonly workerId: WorkerId;
  readonly boundAt: Timestamp;
}

export type BindMcpSubjectOutcome =
  | { readonly kind: "bound" | "replayed"; readonly binding: McpSubjectBinding }
  | {
      readonly kind: "conflict";
      readonly reason: "binding_id" | "subject" | "worker";
    };

export interface McpSubjectSeveranceReceipt {
  readonly severanceId: string;
  readonly bindingId: string;
  readonly workerId: WorkerId;
  readonly severedAt: Timestamp;
}

export type SeverMcpSubjectOutcome =
  | {
      readonly kind: "severed" | "replayed";
      readonly receipt: McpSubjectSeveranceReceipt;
    }
  | { readonly kind: "not_found" | "conflict" };

export interface AuthorizeMcpCallInput {
  readonly expectedBinding: McpSubjectBinding;
  readonly tool: MusterMcpToolName;
  readonly policy: McpRateLimitPolicy;
  readonly window: McpRateWindow;
  readonly assignedSlotOccurrence: string;
  readonly availabilityBudgetBucket?: 0 | 1 | 2 | 3;
  readonly at: Timestamp;
}

export interface AuthorizedMcpCall {
  readonly workerId: WorkerId;
  readonly bindingRevision: number;
  readonly tool: MusterMcpToolName;
  readonly ratePolicyVersion: string;
  readonly rateWindowId: string;
  readonly assignedSlotOccurrence: string;
  readonly callsUsed: number;
  readonly leaseAttemptsUsed: number;
  readonly availabilityBudgetBucket?: 0 | 1 | 2 | 3;
}

export type AuthorizeMcpCallOutcome =
  | { readonly kind: "authorized"; readonly current: AuthorizedMcpCall }
  | {
      readonly kind: "refused";
      readonly reason:
        | "mapping_stale"
        | "rate_limited"
        | "slot_attempt_limit"
        | "availability_increase"
        | "policy_or_window_invalid";
    };

/**
 * MCP-owned durable state; raw identity never crosses into the core Store.
 * Binding and severance IDs are operator-supplied, wire-safe, raw-subject-free
 * command identities and are never accepted from a worker tool call. Exact
 * retries replay; every refused authorizeCall leaves all counters, slot state,
 * availability, and bindings unchanged.
 */
export interface McpStateStore {
  bindSubject(input: {
    readonly bindingId: string;
    readonly subject: AuthenticatedWorkerSubject;
    readonly workerId: WorkerId;
    readonly at: Timestamp;
  }): Promise<BindMcpSubjectOutcome>;
  resolveSubject(
    subject: AuthenticatedWorkerSubject,
  ): Promise<McpSubjectBinding | null>;
  severSubject(input: {
    readonly severanceId: string;
    readonly expectedBinding: McpSubjectBinding;
    readonly at: Timestamp;
  }): Promise<SeverMcpSubjectOutcome>;
  authorizeCall(input: AuthorizeMcpCallInput): Promise<AuthorizeMcpCallOutcome>;
}

/** Exact boundary between successful structured output and generic tool error. */
export const MUSTER_MCP_TOOL_OUTCOME_RULES = deepFreeze({
  lease_job: {
    domainRefusal: "no_work_success",
    stateRefusal: "generic_tool_error",
  },
  submit_result: {
    domainRefusal: "frozen_wire_error_success",
    stateRefusal: "generic_tool_error",
  },
  abandon_job: {
    domainRefusal: "frozen_wire_error_success",
    stateRefusal: "generic_tool_error",
  },
  extend_lease: {
    domainRefusal: "uniform_refused_success",
    stateRefusal: "generic_tool_error",
  },
  get_worker_status: {
    domainRefusal: "generic_tool_error",
    stateRefusal: "generic_tool_error",
  },
  set_availability: {
    domainRefusal: "generic_tool_error",
    stateRefusal: "generic_tool_error",
  },
} as const);
