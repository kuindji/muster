import type { Action } from "./actions.js";
import { canonicalize } from "./canonical/jcs.js";
import { deepFreeze } from "./deep-freeze.js";
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

export const ORACLE_NEGATIVE_FIXTURE_CATEGORIES = deepFreeze([
  "out_of_domain",
  "unsupported_material",
  "omitted_material",
] as const);

export type OracleNegativeFixtureCategory =
  (typeof ORACLE_NEGATIVE_FIXTURE_CATEGORIES)[number];

/** A failure case bound to one declared predicate and failure family. */
export interface OracleNegativeFixture extends Fixture {
  predicate: string;
  category: OracleNegativeFixtureCategory;
}

/** Closed shape check; semantic predicate coverage is checked at registration. */
export function isOracleNegativeFixtureShape(
  value: unknown,
): value is OracleNegativeFixture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fixture = value as Record<string, unknown>;
  if (!Object.keys(fixture).every((key) =>
    ["name", "payload", "result", "predicate", "category"].includes(key),
  )) return false;
  let canonicalValues = false;
  if (Object.hasOwn(fixture, "payload") && Object.hasOwn(fixture, "result")) {
    try {
      canonicalize(fixture.payload);
      canonicalize(fixture.result);
      canonicalValues = true;
    } catch {
      canonicalValues = false;
    }
  }
  return canonicalValues && (
    typeof fixture.name === "string" &&
    typeof fixture.predicate === "string" &&
    fixture.predicate.length > 0 &&
    (ORACLE_NEGATIVE_FIXTURE_CATEGORIES as readonly unknown[]).includes(
      fixture.category,
    ) &&
    Object.hasOwn(fixture, "payload") &&
    Object.hasOwn(fixture, "result")
  );
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
  /** Evidence predicates this oracle implements. */
  predicates: NonEmptyArray<string>;
  /** Deterministic, no I/O. */
  run(payload: Payload, result: Result): OracleVerdict;
  /** Payload fields it actually examines. */
  coversPayloadPaths: JsonPath[];
  /** Result fields whose claims it checks. */
  coversResultPaths: JsonPath[];
  /** Completeness only. */
  absenceDomain?: AbsenceDomain;
  /** Cases the oracle must fail. */
  negativeFixtures: NonEmptyArray<OracleNegativeFixture>;
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
