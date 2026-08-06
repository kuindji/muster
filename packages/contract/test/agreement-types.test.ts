import { describe, expect, it } from "vitest";

import type {
  AgreementOutcome,
  AgreementPolicy,
} from "../src/agreement.js";
import {
  isAgreementFixtureShape,
  unanimousEquivalence,
} from "../src/agreement.js";
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
    type Payload = { source: string };
    type Result = { value: number; note: string };
    const policy: AgreementPolicy<Payload, Result> = {
      equivalenceKey: (result) => ({ value: result.value }),
      resolveEquivalent: (results) => results[0],
      agreementFixtures: [
        {
          kind: "equivalent",
          payload: { source: "fixture-equivalent" },
          results: [
            { value: 1, note: "x" },
            { value: 1, note: "y" },
          ],
          expected: "equivalent",
        },
        {
          kind: "split",
          payload: { source: "fixture-split" },
          results: [
            { value: 1, note: "x" },
            { value: 2, note: "x" },
          ],
          expected: "split",
        },
      ],
    };
    const missingFixturePayload: AgreementPolicy<Payload, Result> = {
      ...policy,
      agreementFixtures: [
        // @ts-expect-error revision 16 requires a payload for every fixture
        {
          kind: "split",
          results: [
            { value: 1, note: "x" },
            { value: 2, note: "x" },
          ],
          expected: "split",
        },
      ],
    };
    void missingFixturePayload;
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

  it("rejects malformed or under-specified fixture metadata", () => {
    expect(isAgreementFixtureShape({
      kind: "equivalent",
      payload: { source: "fixture" },
      results: [{ value: 1 }, { value: 1, note: "distinct" }],
      expected: "equivalent",
    })).toBe(true);
    expect(isAgreementFixtureShape({
      kind: "equivalent",
      payload: { source: "fixture" },
      results: [{ value: 1 }],
      expected: "equivalent",
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "equivalent",
      payload: { source: "fixture" },
      results: [{ value: 1 }, { value: 1 }],
      expected: "equivalent",
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "equivalent",
      payload: { source: "fixture" },
      results: [{ value: 1 }, { value: 2 }],
      expected: "split",
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "split",
      payload: { source: "fixture" },
      results: [{ value: 1 }, { value: 2 }],
      expected: "split",
      typo: true,
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "split",
      payload: { source: "fixture" },
      results: [{ value: 1 }, { value: undefined }],
      expected: "split",
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "split",
      results: [{ value: 1 }, { value: 2 }],
      expected: "split",
    })).toBe(false);
    expect(isAgreementFixtureShape({
      kind: "split",
      payload: { source: undefined },
      results: [{ value: 1 }, { value: 2 }],
      expected: "split",
    })).toBe(false);
  });
});
