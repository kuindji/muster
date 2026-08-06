import { describe, expect, it } from "vitest";

import {
  absenceDomainCovers,
  absenceDomainEquals,
  canonicalAbsenceDomainKey,
  isOracleNegativeFixtureShape,
  ORACLE_NEGATIVE_FIXTURE_CATEGORIES,
} from "../src/oracle.js";

const domain = (id: string, paths: [string, ...string[]]) => ({
  id,
  payloadPaths: paths,
});

describe("AbsenceDomain canonical identity (spec revision 12, 6.7)", () => {
  it("id carries no matching semantics", () => {
    expect(
      absenceDomainEquals(
        domain("a", ["$.items"]),
        domain("b", ["$.items"]),
      ),
    ).toBe(true);
  });

  it("path order and duplicates do not change identity", () => {
    const key = canonicalAbsenceDomainKey(
      domain("x", ["$.b", "$.a", "$.a"]),
    );
    expect(key).toBe(canonicalAbsenceDomainKey(domain("x", ["$.a", "$.b"])));
    expect(key).toBe('{"payloadPaths":["$.a","$.b"]}');
  });

  it("different path sets differ", () => {
    expect(
      absenceDomainEquals(
        domain("a", ["$.items"]),
        domain("a", ["$.items", "$.meta"]),
      ),
    ).toBe(false);
  });
});

describe("AbsenceDomain containment (acceptance)", () => {
  it("equal domains cover", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.items"]),
        domain("r", ["$.items"]),
      ),
    ).toBe(true);
  });

  it("required paths may be extensions of oracle paths", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.items"]),
        domain("r", ["$.items[*].claims"]),
      ),
    ).toBe(true);
  });

  it("a wider oracle domain covers a narrower requirement", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.items", "$.meta"]),
        domain("r", ["$.meta"]),
      ),
    ).toBe(true);
  });
});

describe("AbsenceDomain containment (refusal)", () => {
  it("an oracle child path does not cover its required parent", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.items[*].claims"]),
        domain("r", ["$.items"]),
      ),
    ).toBe(false);
  });

  it("disjoint domains never cover", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.meta"]),
        domain("r", ["$.items"]),
      ),
    ).toBe(false);
  });

  it("partial coverage is refusal", () => {
    expect(
      absenceDomainCovers(
        domain("o", ["$.items"]),
        domain("r", ["$.items", "$.meta"]),
      ),
    ).toBe(false);
  });
});

describe("Oracle negative fixture metadata (revision 14)", () => {
  it("freezes the failure families and binds each case to a predicate", () => {
    expect(ORACLE_NEGATIVE_FIXTURE_CATEGORIES).toEqual([
      "out_of_domain",
      "unsupported_material",
      "omitted_material",
    ]);
    expect(isOracleNegativeFixtureShape({
      name: "unsupported-claim",
      predicate: "claims-grounded",
      category: "unsupported_material",
      payload: { items: [] },
      result: { claims: [{ text: "invented" }] },
    })).toBe(true);
  });

  it("rejects missing, unknown, and typo'd metadata", () => {
    const valid = {
      name: "omission",
      predicate: "all-material-items-present",
      category: "omitted_material",
      payload: { items: [1] },
      result: { items: [] },
    };
    expect(isOracleNegativeFixtureShape({
      ...valid,
      category: "negative",
    })).toBe(false);
    const { predicate: _predicate, ...missingPredicate } = valid;
    expect(isOracleNegativeFixtureShape(missingPredicate)).toBe(false);
    expect(isOracleNegativeFixtureShape({ ...valid, predciate: "typo" }))
      .toBe(false);
    expect(isOracleNegativeFixtureShape({
      ...valid,
      result: { items: [undefined] },
    })).toBe(false);
  });
});
