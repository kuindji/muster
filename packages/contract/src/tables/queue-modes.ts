import { deepFreeze } from "../deep-freeze.js";

export type QueueMode =
  | "normal"
  | "degraded"
  | "admission_halted"
  | "emergency_halted";

export interface QueueModeRow {
  intake: "full" | "throttled" | "refused";
  inFlight: "completes" | "operator_policy";
  lowPriority: "normal" | "expire_early";
  urgent: "normal" | "prioritized";
  entryEvent: "backpressure" | "pool_offline" | null;
}

/**
 * Spec 6.12 queue modes; per-class health remains orthogonal. `pool_offline`
 * fires for admission_halted only when pool-offline detection caused the halt.
 */
export const QUEUE_MODE_TABLE: Record<QueueMode, QueueModeRow> =
  deepFreeze({
    normal: {
      intake: "full",
      inFlight: "completes",
      lowPriority: "normal",
      urgent: "normal",
      entryEvent: null,
    },
    degraded: {
      intake: "throttled",
      inFlight: "completes",
      lowPriority: "expire_early",
      urgent: "prioritized",
      entryEvent: "backpressure",
    },
    admission_halted: {
      intake: "refused",
      inFlight: "completes",
      lowPriority: "normal",
      urgent: "normal",
      entryEvent: "pool_offline",
    },
    emergency_halted: {
      intake: "refused",
      inFlight: "operator_policy",
      lowPriority: "normal",
      urgent: "normal",
      entryEvent: null,
    },
  });
