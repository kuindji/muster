import {
  capUsageBucket,
  isWireId,
  nextSlotBucket,
  type CapUsageBucket,
  type NextSlotBucket,
  type Timestamp,
  type WorkerId,
  type WorkerState,
} from "@kuindji/muster-contract";

import type {
  Clock,
  Store,
  WorkerControlPolicy,
  WorkerNextSlot,
  WorkerRoutingPeriod,
} from "./ports.js";

const validTimestamp = (value: string): value is Timestamp =>
  value.length > 0 && Number.isFinite(Date.parse(value));

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

const nextSlotIssue = (slot: unknown): boolean => {
  if (typeof slot !== "object" || slot === null || Array.isArray(slot)) return true;
  const candidate = slot as Partial<WorkerNextSlot>;
  return !(
    typeof candidate.assignedSlotOccurrence === "string" &&
    isWireId(candidate.assignedSlotOccurrence) &&
    typeof candidate.startsInSeconds === "number" &&
    Number.isFinite(candidate.startsInSeconds) &&
    candidate.startsInSeconds >= 0
  );
};

export interface WorkerStatusSnapshot {
  readonly workerId: WorkerId;
  readonly state: Exclude<WorkerState, "revoked">;
  readonly contractVersion: string;
  readonly jobClassIds: readonly string[];
  readonly capUsageBucket: CapUsageBucket;
  readonly nextSlotBucket: NextSlotBucket;
  /** Internal opaque facts for MCP-state comparison; never worker output. */
  readonly assignedSlotOccurrence: string;
  readonly nextSlotOccurrence: string;
}

export type WorkerStatusResult =
  | { readonly ok: true; readonly status: WorkerStatusSnapshot }
  | { readonly ok: false; readonly kind: "unavailable" | "policy_invalid" };

/** Revision-27 coarse status read. It performs no Store mutation. */
export class WorkerStatusService {
  constructor(private readonly options: {
    readonly store: Store;
    readonly clock: Clock;
    readonly workerPolicy: WorkerControlPolicy;
  }) {}

  async getWorkerStatus(
    workerId: WorkerId,
    at: Timestamp = this.options.clock.now(),
  ): Promise<WorkerStatusResult> {
    if (!isWireId(workerId) || !validTimestamp(at)) {
      return { ok: false, kind: "policy_invalid" };
    }
    const worker = await this.options.store.getWorker(workerId);
    if (worker === null || worker.state === "revoked") {
      return { ok: false, kind: "unavailable" };
    }
    const routing = await this.options.store.getWorkerRoutingSnapshot(workerId);
    if (routing === null) return { ok: false, kind: "policy_invalid" };

    let period: unknown;
    let next: unknown;
    try {
      period = this.options.workerPolicy.routingAt({ workerId, slot: worker.slot, at });
      next = this.options.workerPolicy.nextSlot({ workerId, slot: worker.slot, at });
    } catch {
      return { ok: false, kind: "policy_invalid" };
    }
    if (routingIssue(period) || nextSlotIssue(next)) {
      return { ok: false, kind: "policy_invalid" };
    }
    const validPeriod = period as WorkerRoutingPeriod;
    const validNext = next as WorkerNextSlot;
    if (
      (validPeriod.slotOpen &&
        (validNext.startsInSeconds !== 0 ||
          validNext.assignedSlotOccurrence !== validPeriod.assignedSlotOccurrence)) ||
      (!validPeriod.slotOpen && validNext.startsInSeconds === 0)
    ) {
      return { ok: false, kind: "policy_invalid" };
    }

    const contributionUsed =
      routing.contributionWindowId === validPeriod.contributionWindowId
        ? routing.contributionUsed
        : 0;
    let usage: CapUsageBucket;
    let slotBucket: NextSlotBucket;
    try {
      usage = capUsageBucket(contributionUsed, worker.declaredCapPerWeek);
      slotBucket = nextSlotBucket(validNext.startsInSeconds);
    } catch {
      return { ok: false, kind: "policy_invalid" };
    }
    return {
      ok: true,
      status: {
        workerId: worker.workerId,
        state: worker.state,
        contractVersion: worker.contractAcceptance.contractVersion,
        jobClassIds: [...worker.capabilities.jobClassIds].sort(),
        capUsageBucket: usage,
        nextSlotBucket: slotBucket,
        assignedSlotOccurrence: validPeriod.assignedSlotOccurrence,
        nextSlotOccurrence: validNext.assignedSlotOccurrence,
      },
    };
  }
}
