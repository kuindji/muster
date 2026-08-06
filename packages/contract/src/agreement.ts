import type {
  AtLeastTwo,
  CanonicalJsonValue,
  NonEmptyArray,
} from "./primitives.js";
import { canonicalize } from "./canonical/jcs.js";

export type AgreementFixture<Result> =
  | {
      kind: "equivalent";
      /** At least two JCS-distinct representations resolving to one key. */
      results: AtLeastTwo<Result>;
      expected: "equivalent";
    }
  | {
      kind: "split";
      /** At least two representations producing different keys. */
      results: AtLeastTwo<Result>;
      expected: "split";
    };

/** Closed shape check used before registration invokes consumer functions. */
export function isAgreementFixtureShape(
  value: unknown,
): value is AgreementFixture<CanonicalJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const fixture = value as Record<string, unknown>;
  if (
    !Object.keys(fixture).every((key) =>
      ["kind", "results", "expected"].includes(key),
    ) ||
    !Array.isArray(fixture.results) ||
    fixture.results.length < 2
  ) return false;
  const canonicalResults: string[] = [];
  try {
    for (const result of fixture.results) {
      canonicalResults.push(canonicalize(result));
    }
  } catch {
    return false;
  }
  if (new Set(canonicalResults).size < 2) return false;
  return (
    (fixture.kind === "equivalent" && fixture.expected === "equivalent") ||
    (fixture.kind === "split" && fixture.expected === "split")
  );
}

export interface AgreementPolicy<Result> {
  equivalenceKey(result: Result): CanonicalJsonValue;
  resolveEquivalent(results: NonEmptyArray<Result>): Result;
  agreementFixtures: NonEmptyArray<AgreementFixture<Result>>;
}

export type AgreementOutcome<Result> =
  | { kind: "agreed"; result: Result }
  | {
      kind: "split";
      equivalenceKeys: NonEmptyArray<CanonicalJsonValue>;
    };

/**
 * Spec 6.2: agreement requires byte-identical canonical keys from every
 * accepted replica; a majority is still a split.
 */
export function unanimousEquivalence(
  canonicalKeys: NonEmptyArray<string>,
): boolean {
  return canonicalKeys.every((key) => key === canonicalKeys[0]);
}
