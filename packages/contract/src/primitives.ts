export type NonEmptyArray<T> = [T, ...T[]];

export function isNonEmptyArray<T>(
  value: readonly T[],
): value is [T, ...T[]] {
  return value.length > 0;
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/** ISO 8601 UTC with millisecond precision and Z suffix. */
export type Timestamp = string;
export type Seconds = number;

/** Raw OAuth identity. Private to muster-mcp; never persisted in core data. */
export interface AuthenticatedWorkerSubject {
  issuer: string;
  subject: string;
}

/** Opaque pseudonym resolved by muster-mcp through a severable mapping. */
export type WorkerId = string;

/** Spec 4.3/rev 12. Field names are frozen: they enter decision_result_hash. */
export interface SubmissionEvidence {
  leaseId: string;
  collectionCycle: number;
  resultHash: string;
  workerId: WorkerId;
}

/**
 * Frozen ASCII wire-identifier grammar: printable ASCII, no space. All
 * coordinator-generated IDs, epochs, and hex digests satisfy it, which makes
 * every "bytewise" ordering in the spec implementable as plain JS string
 * comparison (UTF-16 and UTF-8 orders agree on ASCII, diverge outside it).
 */
export const WIRE_ID_PATTERN = /^[\x21-\x7e]+$/;

export function isWireId(value: string): boolean {
  return WIRE_ID_PATTERN.test(value);
}
