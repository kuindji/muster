import {
  MUSTER_MCP_TOOL_NAMES,
  deepFreeze,
  isWireId,
  mcpRateWindow,
  type AuthenticatedWorkerSubject,
  type AuthorizeMcpCallInput,
  type AuthorizeMcpCallOutcome,
  type AuthorizedMcpCall,
  type BindMcpSubjectOutcome,
  type McpRateLimitPolicy,
  type McpStateStore,
  type McpSubjectBinding,
  type McpSubjectSeveranceReceipt,
  type MusterMcpToolName,
  type SeverMcpSubjectOutcome,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";

export type BindMcpSubjectInput = Parameters<McpStateStore["bindSubject"]>[0];
export type SeverMcpSubjectInput = Parameters<McpStateStore["severSubject"]>[0];

export interface McpSubjectLifecycleStore {
  bindSubject(input: BindMcpSubjectInput): Promise<BindMcpSubjectOutcome>;
  severSubject(input: SeverMcpSubjectInput): Promise<SeverMcpSubjectOutcome>;
}

/** Operator-only mapping lifecycle. These methods are deliberately not tools. */
export class McpSubjectLifecycleService {
  constructor(private readonly store: McpSubjectLifecycleStore) {}

  bindSubject(input: BindMcpSubjectInput): Promise<BindMcpSubjectOutcome> {
    return this.store.bindSubject(input);
  }

  severSubject(input: SeverMcpSubjectInput): Promise<SeverMcpSubjectOutcome> {
    return this.store.severSubject(input);
  }
}

export interface McpRateUsageSnapshot {
  readonly workerId: WorkerId;
  readonly ratePolicyVersion: string;
  readonly rateWindowId: string;
  readonly tool: MusterMcpToolName;
  readonly callsUsed: number;
}

export interface McpSlotUsageSnapshot {
  readonly workerId: WorkerId;
  readonly assignedSlotOccurrence: string;
  readonly leaseAttemptsUsed: number;
  readonly availabilityBudgetBucket?: 0 | 1 | 2 | 3;
}

export interface InMemoryMcpStateSnapshot {
  readonly bindings: readonly McpSubjectBinding[];
  readonly severances: readonly McpSubjectSeveranceReceipt[];
  readonly rateUsage: readonly McpRateUsageSnapshot[];
  readonly slotUsage: readonly McpSlotUsageSnapshot[];
}

interface RateUsageRecord extends McpRateUsageSnapshot {}
interface SlotUsageRecord extends McpSlotUsageSnapshot {}

interface SeveranceHistoryRecord {
  readonly receipt: McpSubjectSeveranceReceipt;
  readonly expectedRevision: number;
  readonly expectedBoundAt: Timestamp;
}

const clone = <T>(value: T): T => structuredClone(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validTimestamp = (value: unknown): value is Timestamp => {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const validSubjectValue = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1_024 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

const validIssuer = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value;
  } catch {
    return false;
  }
};

const validSubject = (value: unknown): value is AuthenticatedWorkerSubject =>
  isRecord(value) &&
  exactKeys(value, ["issuer", "subject"]) &&
  typeof value.issuer === "string" &&
  typeof value.subject === "string" &&
  validIssuer(value.issuer) &&
  validSubjectValue(value.subject);

const subjectKey = (subject: AuthenticatedWorkerSubject): string =>
  JSON.stringify([subject.issuer, subject.subject]);

const bindingEquals = (
  left: McpSubjectBinding,
  right: McpSubjectBinding,
): boolean =>
  left.revision === right.revision &&
  left.bindingId === right.bindingId &&
  left.subject.issuer === right.subject.issuer &&
  left.subject.subject === right.subject.subject &&
  left.workerId === right.workerId &&
  left.boundAt === right.boundAt;

const validBinding = (binding: unknown): binding is McpSubjectBinding =>
  isRecord(binding) &&
  exactKeys(binding, [
    "revision",
    "bindingId",
    "subject",
    "workerId",
    "boundAt",
  ]) &&
  Number.isSafeInteger(binding.revision) &&
  Number(binding.revision) > 0 &&
  typeof binding.bindingId === "string" &&
  isWireId(binding.bindingId) &&
  validSubject(binding.subject) &&
  typeof binding.workerId === "string" &&
  isWireId(binding.workerId) &&
  validTimestamp(binding.boundAt);

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

const policyEquals = (
  left: McpRateLimitPolicy,
  right: McpRateLimitPolicy,
): boolean =>
  left.version === right.version &&
  left.windowSeconds === right.windowSeconds &&
  left.maxLeaseAttemptsPerSlot === right.maxLeaseAttemptsPerSlot &&
  MUSTER_MCP_TOOL_NAMES.every(
    (tool) => left.maxCallsPerWindow[tool] === right.maxCallsPerWindow[tool],
  );

const validPolicy = (value: unknown): value is McpRateLimitPolicy => {
  if (
    !isRecord(value) ||
    !isRecord(value.maxCallsPerWindow) ||
    typeof value.version !== "string" ||
    !isWireId(value.version) ||
    !exactKeys(value, [
      "version",
      "windowSeconds",
      "maxCallsPerWindow",
      "maxLeaseAttemptsPerSlot",
    ]) ||
    !exactKeys(value.maxCallsPerWindow, MUSTER_MCP_TOOL_NAMES)
  ) {
    return false;
  }
  const policy = value as unknown as McpRateLimitPolicy;
  try {
    mcpRateWindow(policy, "2026-01-01T00:00:00.000Z");
    return true;
  } catch {
    return false;
  }
};

const validAvailability = (value: unknown): value is 0 | 1 | 2 | 3 =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;

const rateKey = (
  workerId: WorkerId,
  policyVersion: string,
  windowId: string,
  tool: MusterMcpToolName,
): string => JSON.stringify([workerId, policyVersion, windowId, tool]);

const slotKey = (workerId: WorkerId, occurrence: string): string =>
  JSON.stringify([workerId, occurrence]);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Serialized reference adapter for revision 27's MCP-owned identity and
 * side-channel state. Raw subjects exist only in active bindings. All other
 * durable records are pseudonymous, and every boundary value is detached.
 */
export class InMemoryMcpStateStore implements McpStateStore {
  private serialTail: Promise<void> = Promise.resolve();

  private readonly bindingsById = new Map<string, McpSubjectBinding>();
  private readonly bindingIdBySubject = new Map<string, string>();
  private readonly bindingIdByWorker = new Map<WorkerId, string>();
  private readonly retiredBindingIds = new Set<string>();
  private readonly workerBindingRevisions = new Map<WorkerId, number>();
  private readonly severances = new Map<string, SeveranceHistoryRecord>();
  private readonly policies = new Map<string, McpRateLimitPolicy>();
  private readonly rateUsage = new Map<string, RateUsageRecord>();
  private readonly slotUsage = new Map<string, SlotUsageRecord>();

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

  bindSubject(input: BindMcpSubjectInput): Promise<BindMcpSubjectOutcome> {
    return this.atomicInput(input, (captured) => {
      if (
        !isRecord(captured) ||
        !exactKeys(captured, ["bindingId", "subject", "workerId", "at"]) ||
        typeof captured.bindingId !== "string" ||
        !isWireId(captured.bindingId) ||
        !validTimestamp(captured.at)
      ) {
        return { kind: "conflict", reason: "binding_id" };
      }
      if (!validSubject(captured.subject)) {
        return { kind: "conflict", reason: "subject" };
      }
      if (typeof captured.workerId !== "string" || !isWireId(captured.workerId)) {
        return { kind: "conflict", reason: "worker" };
      }

      const existing = this.bindingsById.get(captured.bindingId);
      if (existing !== undefined) {
        const exact = existing.subject.issuer === captured.subject.issuer &&
          existing.subject.subject === captured.subject.subject &&
          existing.workerId === captured.workerId &&
          existing.boundAt === captured.at;
        return exact
          ? { kind: "replayed", binding: clone(existing) }
          : { kind: "conflict", reason: "binding_id" };
      }
      if (this.retiredBindingIds.has(captured.bindingId)) {
        return { kind: "conflict", reason: "binding_id" };
      }
      if (this.bindingIdBySubject.has(subjectKey(captured.subject))) {
        return { kind: "conflict", reason: "subject" };
      }
      if (this.bindingIdByWorker.has(captured.workerId)) {
        return { kind: "conflict", reason: "worker" };
      }

      const revision = (this.workerBindingRevisions.get(captured.workerId) ?? 0) + 1;
      const binding = deepFreeze({
        revision,
        bindingId: captured.bindingId,
        subject: clone(captured.subject),
        workerId: captured.workerId,
        boundAt: captured.at,
      } satisfies McpSubjectBinding);
      this.bindingsById.set(binding.bindingId, binding);
      this.bindingIdBySubject.set(subjectKey(binding.subject), binding.bindingId);
      this.bindingIdByWorker.set(binding.workerId, binding.bindingId);
      this.workerBindingRevisions.set(binding.workerId, revision);
      return { kind: "bound", binding: clone(binding) };
    });
  }

  resolveSubject(subject: AuthenticatedWorkerSubject): Promise<McpSubjectBinding | null> {
    return this.atomicInput(subject, (captured) => {
      if (!validSubject(captured)) return null;
      const bindingId = this.bindingIdBySubject.get(subjectKey(captured));
      return clone(bindingId === undefined ? null : this.bindingsById.get(bindingId) ?? null);
    });
  }

  severSubject(input: SeverMcpSubjectInput): Promise<SeverMcpSubjectOutcome> {
    return this.atomicInput(input, (captured) => {
      if (
        !isRecord(captured) ||
        !exactKeys(captured, ["severanceId", "expectedBinding", "at"]) ||
        typeof captured.severanceId !== "string" ||
        !isWireId(captured.severanceId) ||
        !validBinding(captured.expectedBinding) ||
        !validTimestamp(captured.at)
      ) {
        return { kind: "conflict" };
      }

      const prior = this.severances.get(captured.severanceId);
      if (prior !== undefined) {
        const replay = prior.receipt.bindingId === captured.expectedBinding.bindingId &&
          prior.receipt.workerId === captured.expectedBinding.workerId &&
          prior.expectedRevision === captured.expectedBinding.revision &&
          prior.expectedBoundAt === captured.expectedBinding.boundAt &&
          prior.receipt.severedAt === captured.at;
        return replay
          ? { kind: "replayed", receipt: clone(prior.receipt) }
          : { kind: "conflict" };
      }

      const current = this.bindingsById.get(captured.expectedBinding.bindingId);
      if (current === undefined) return { kind: "not_found" };
      if (
        !bindingEquals(current, captured.expectedBinding) ||
        Date.parse(captured.at) < Date.parse(current.boundAt)
      ) {
        return { kind: "conflict" };
      }

      const receipt = deepFreeze({
        severanceId: captured.severanceId,
        bindingId: current.bindingId,
        workerId: current.workerId,
        severedAt: captured.at,
      } satisfies McpSubjectSeveranceReceipt);
      this.bindingsById.delete(current.bindingId);
      this.bindingIdBySubject.delete(subjectKey(current.subject));
      this.bindingIdByWorker.delete(current.workerId);
      this.retiredBindingIds.add(current.bindingId);
      this.severances.set(captured.severanceId, deepFreeze({
        receipt,
        expectedRevision: current.revision,
        expectedBoundAt: current.boundAt,
      }));
      return { kind: "severed", receipt: clone(receipt) };
    });
  }

  authorizeCall(input: AuthorizeMcpCallInput): Promise<AuthorizeMcpCallOutcome> {
    return this.atomicInput(input, (captured) => {
      if (!this.validAuthorizeInput(captured)) {
        return { kind: "refused", reason: "policy_or_window_invalid" };
      }
      const currentBinding = this.bindingsById.get(captured.expectedBinding.bindingId);
      if (
        currentBinding === undefined ||
        !bindingEquals(currentBinding, captured.expectedBinding)
      ) {
        return { kind: "refused", reason: "mapping_stale" };
      }

      const pinnedPolicy = this.policies.get(captured.policy.version);
      if (pinnedPolicy !== undefined && !policyEquals(pinnedPolicy, captured.policy)) {
        return { kind: "refused", reason: "policy_or_window_invalid" };
      }

      const rateUsageKey = rateKey(
        currentBinding.workerId,
        captured.policy.version,
        captured.window.id,
        captured.tool,
      );
      const currentRate = this.rateUsage.get(rateUsageKey);
      const callsUsed = currentRate?.callsUsed ?? 0;
      if (callsUsed >= captured.policy.maxCallsPerWindow[captured.tool]) {
        return { kind: "refused", reason: "rate_limited" };
      }

      const occurrenceKey = slotKey(
        currentBinding.workerId,
        captured.assignedSlotOccurrence,
      );
      const currentSlot = this.slotUsage.get(occurrenceKey);
      const leaseAttemptsUsed = currentSlot?.leaseAttemptsUsed ?? 0;
      if (
        captured.tool === "lease_job" &&
        leaseAttemptsUsed >= captured.policy.maxLeaseAttemptsPerSlot
      ) {
        return { kind: "refused", reason: "slot_attempt_limit" };
      }
      if (
        captured.availabilityBudgetBucket !== undefined &&
        currentSlot?.availabilityBudgetBucket !== undefined &&
        captured.availabilityBudgetBucket > currentSlot.availabilityBudgetBucket
      ) {
        return { kind: "refused", reason: "availability_increase" };
      }

      if (pinnedPolicy === undefined) {
        this.policies.set(captured.policy.version, deepFreeze(clone(captured.policy)));
      }
      const nextRate = deepFreeze({
        workerId: currentBinding.workerId,
        ratePolicyVersion: captured.policy.version,
        rateWindowId: captured.window.id,
        tool: captured.tool,
        callsUsed: callsUsed + 1,
      } satisfies RateUsageRecord);
      this.rateUsage.set(rateUsageKey, nextRate);

      const nextSlot = deepFreeze({
        workerId: currentBinding.workerId,
        assignedSlotOccurrence: captured.assignedSlotOccurrence,
        leaseAttemptsUsed: leaseAttemptsUsed + (captured.tool === "lease_job" ? 1 : 0),
        ...(captured.availabilityBudgetBucket === undefined
          ? currentSlot?.availabilityBudgetBucket === undefined
            ? {}
            : { availabilityBudgetBucket: currentSlot.availabilityBudgetBucket }
          : { availabilityBudgetBucket: captured.availabilityBudgetBucket }),
      } satisfies SlotUsageRecord);
      this.slotUsage.set(occurrenceKey, nextSlot);

      const authorized = deepFreeze({
        workerId: currentBinding.workerId,
        bindingRevision: currentBinding.revision,
        tool: captured.tool,
        ratePolicyVersion: captured.policy.version,
        rateWindowId: captured.window.id,
        assignedSlotOccurrence: captured.assignedSlotOccurrence,
        callsUsed: nextRate.callsUsed,
        leaseAttemptsUsed: nextSlot.leaseAttemptsUsed,
        ...(nextSlot.availabilityBudgetBucket === undefined
          ? {}
          : { availabilityBudgetBucket: nextSlot.availabilityBudgetBucket }),
      } satisfies AuthorizedMcpCall);
      return { kind: "authorized", current: clone(authorized) };
    });
  }

  snapshot(): Promise<InMemoryMcpStateSnapshot> {
    return this.atomic(() => ({
      bindings: clone([...this.bindingsById.values()].sort((left, right) =>
        compareStrings(left.bindingId, right.bindingId)
      )),
      severances: clone([...this.severances.values()].map(({ receipt }) => receipt)
        .sort((left, right) => compareStrings(left.severanceId, right.severanceId))),
      rateUsage: clone([...this.rateUsage.values()].sort((left, right) =>
        compareStrings(left.workerId, right.workerId) ||
        compareStrings(left.ratePolicyVersion, right.ratePolicyVersion) ||
        compareStrings(left.rateWindowId, right.rateWindowId) ||
        compareStrings(left.tool, right.tool)
      )),
      slotUsage: clone([...this.slotUsage.values()].sort((left, right) =>
        compareStrings(left.workerId, right.workerId) ||
        compareStrings(left.assignedSlotOccurrence, right.assignedSlotOccurrence)
      )),
    }));
  }

  private validAuthorizeInput(input: unknown): input is AuthorizeMcpCallInput {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        "expectedBinding",
        "tool",
        "policy",
        "window",
        "assignedSlotOccurrence",
        ...(Object.hasOwn(input, "availabilityBudgetBucket")
          ? ["availabilityBudgetBucket"]
          : []),
        "at",
      ]) ||
      !validBinding(input.expectedBinding) ||
      typeof input.tool !== "string" ||
      !MUSTER_MCP_TOOL_NAMES.some((tool) => tool === input.tool) ||
      !validPolicy(input.policy) ||
      !isRecord(input.window) ||
      !exactKeys(input.window, ["id", "startsAt", "endsAt"]) ||
      typeof input.assignedSlotOccurrence !== "string" ||
      !isWireId(input.assignedSlotOccurrence) ||
      !validTimestamp(input.at) ||
      (input.tool === "lease_job"
        ? !validAvailability(input.availabilityBudgetBucket)
        : input.availabilityBudgetBucket !== undefined)
    ) {
      return false;
    }
    try {
      const expectedWindow = mcpRateWindow(input.policy, input.at);
      return expectedWindow.id === input.window.id &&
        expectedWindow.startsAt === input.window.startsAt &&
        expectedWindow.endsAt === input.window.endsAt &&
        Date.parse(input.at) >= Date.parse(input.window.startsAt) &&
        Date.parse(input.at) < Date.parse(input.window.endsAt);
    } catch {
      return false;
    }
  }
}
