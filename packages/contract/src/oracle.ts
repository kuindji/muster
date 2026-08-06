import type { Action } from "./actions.js";
import { canonicalize } from "./canonical/jcs.js";
import { pathsCover } from "./jsonpath.js";
import type { JsonPath } from "./jsonpath.js";
import type {
  CanonicalJsonValue,
  NonEmptyArray,
} from "./primitives.js";

export type OracleVerdict =
  | { kind: "pass" }
  | { kind: "fail"; code: string; detail?: string };

/** A case an oracle or validator is exercised against. */
export interface Fixture {
  name: string;
  payload: CanonicalJsonValue;
  result: CanonicalJsonValue;
}

/** Spec 6.7: the universe a completeness oracle can detect omissions over. */
export interface AbsenceDomain {
  /** Label for humans and audit records; no matching semantics. */
  id: string;
  payloadPaths: NonEmptyArray<JsonPath>;
}

/** Canonical identity: id excluded and payload paths sorted and deduplicated. */
export function canonicalAbsenceDomainKey(domain: AbsenceDomain): string {
  const payloadPaths = [...new Set(domain.payloadPaths)].sort();
  return canonicalize({ payloadPaths });
}

export function absenceDomainEquals(
  left: AbsenceDomain,
  right: AbsenceDomain,
): boolean {
  return canonicalAbsenceDomainKey(left) === canonicalAbsenceDomainKey(right);
}

/**
 * Spec 6.7/revision 12 plain path containment. Every required payload path
 * must equal or extend an oracle-domain path; semantic inference is forbidden.
 */
export function absenceDomainCovers(
  oracleDomain: AbsenceDomain,
  required: AbsenceDomain,
): boolean {
  return pathsCover(oracleDomain.payloadPaths, required.payloadPaths);
}

export interface OracleSpec<Payload, Result> {
  id: string;
  kind: "support" | "completeness";
  /** Deterministic, no I/O. */
  run(payload: Payload, result: Result): OracleVerdict;
  /** Payload fields it actually examines. */
  coversPayloadPaths: JsonPath[];
  /** Result fields whose claims it checks. */
  coversResultPaths: JsonPath[];
  /** Completeness only. */
  absenceDomain?: AbsenceDomain;
  /** Cases the oracle must fail. */
  negativeFixtures: NonEmptyArray<Fixture>;
}

export interface EvidenceRequirement {
  predicate: string;
  requiredPayloadPaths: JsonPath[];
  requiredResultPaths: JsonPath[];
}

export interface ActionEvidenceRequirement extends EvidenceRequirement {
  action: Action;
}

export interface AbsenceRequirement extends EvidenceRequirement {
  action: Action;
  requiredDomain: AbsenceDomain;
}
