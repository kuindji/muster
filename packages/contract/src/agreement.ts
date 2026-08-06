import type {
  CanonicalJsonValue,
  NonEmptyArray,
} from "./primitives.js";

export interface AgreementFixture<Result> {
  results: NonEmptyArray<Result>;
  expected: "equivalent" | "split";
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
