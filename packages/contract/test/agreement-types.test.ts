import { describe, expect, it } from "vitest";

import type {
  AgreementOutcome,
  AgreementPolicy,
} from "../src/agreement.js";
import { unanimousEquivalence } from "../src/agreement.js";
import { canonicalize } from "../src/canonical/jcs.js";

describe("unanimousEquivalence (spec 6.2)", () => {
  it("one key is unanimous", () => {
    expect(unanimousEquivalence(['{"a":1}'])).toBe(true);
  });

  it("identical keys are unanimous", () => {
    expect(
      unanimousEquivalence(['{"a":1}', '{"a":1}', '{"a":1}']),
    ).toBe(true);
  });

  it("any differing key is a split — never a vote", () => {
    expect(
      unanimousEquivalence(['{"a":1}', '{"a":1}', '{"a":2}']),
    ).toBe(false);
  });
});

describe("AgreementPolicy shape compiles as specified", () => {
  it("equivalenceKey feeds canonical comparison", () => {
    type Result = { value: number; note: string };
    const policy: AgreementPolicy<Result> = {
      equivalenceKey: (result) => ({ value: result.value }),
      resolveEquivalent: (results) => results[0],
      agreementFixtures: [
        {
          results: [
            { value: 1, note: "x" },
            { value: 1, note: "y" },
          ],
          expected: "equivalent",
        },
        {
          results: [
            { value: 1, note: "x" },
            { value: 2, note: "x" },
          ],
          expected: "split",
        },
      ],
    };
    const keys = policy.agreementFixtures[0].results.map((result) =>
      canonicalize(policy.equivalenceKey(result)),
    );

    expect(unanimousEquivalence(keys as [string, ...string[]])).toBe(
      true,
    );
    const outcome: AgreementOutcome<Result> = {
      kind: "agreed",
      result: { value: 1, note: "x" },
    };
    expect(outcome.kind).toBe("agreed");
  });
});
