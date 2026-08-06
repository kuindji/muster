import { deepFreeze } from "./deep-freeze.js";

/**
 * Coarse worker-facing MCP errors. Precise pipeline detail belongs only in
 * the ledger; `no_work` is an outcome and is deliberately absent.
 */
export const WORKER_WIRE_ERROR_CODES = deepFreeze([
  "lease_not_held",
  "result_too_large",
  "invalid_result",
  "submission_conflict",
  "input_hash_mismatch",
  "contract_mismatch",
  "contract_expired",
] as const);

/**
 * Consumer-boundary failures that create no authorization identity. Budget
 * exhaustion is instead a denial reason bound into a terminal receipt.
 */
export const CONSUMER_API_ERROR_CODES = deepFreeze([
  "authorization_conflict",
  "verdict_conflict",
  "effect_descriptor_mismatch",
  "intent_invalid",
] as const);

export type WorkerWireErrorCode =
  (typeof WORKER_WIRE_ERROR_CODES)[number];
export type ConsumerApiErrorCode =
  (typeof CONSUMER_API_ERROR_CODES)[number];
export type WireErrorCode = WorkerWireErrorCode | ConsumerApiErrorCode;
