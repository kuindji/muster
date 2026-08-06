import { readFileSync } from "node:fs";

import serializeReference from "canonicalize";
import { describe, expect, it } from "vitest";

import {
  canonicalize,
  CanonicalizationError,
} from "../src/canonical/jcs.js";

const vectors: Array<{ name: string; input: unknown; expected: string }> =
  JSON.parse(
    readFileSync(
      new URL("../fixtures/jcs-rfc8785.json", import.meta.url),
      "utf8",
    ),
  );

describe("RFC 8785 canonicalization", () => {
  for (const vector of vectors) {
    it(`matches RFC vector: ${vector.name}`, () => {
      expect(canonicalize(vector.input)).toBe(vector.expected);
    });
  }

  it("sorts object keys by UTF-16 code units, recursively", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("agrees with the reference implementation on a structured sample", () => {
    const sample = {
      id: "x-1",
      effects: [
        {
          action: "suppress",
          descriptor: { reason: "duplicate", of: ["a", "b"] },
        },
      ],
      n: [0, 1e21, 0.000001, -45.3],
      s: "pi: π, quote: \" backslash: \\ newline: \n",
    };
    expect(canonicalize(sample)).toBe(serializeReference(sample));
  });

  it("rejects non-JSON values", () => {
    for (const bad of [
      undefined,
      () => {},
      Symbol("s"),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => canonicalize(bad)).toThrow(CanonicalizationError);
    }
    expect(() => canonicalize({ a: undefined })).toThrow(
      CanonicalizationError,
    );
    expect(() => canonicalize([Number.NaN])).toThrow(CanonicalizationError);
    expect(() => canonicalize({ [Symbol("s")]: 1 } as never)).toThrow(
      CanonicalizationError,
    );
    const arrayWithSymbol: unknown[] = [1, 2];
    (arrayWithSymbol as unknown as Record<symbol, unknown>)[Symbol("s")] = 1;
    expect(() => canonicalize(arrayWithSymbol)).toThrow(
      CanonicalizationError,
    );
  });

  it("rejects lone UTF-16 surrogates (RFC 8785 requires I-JSON input)", () => {
    expect(() => canonicalize("\uD800")).toThrow(CanonicalizationError);
    expect(() => canonicalize("a\uDC00b")).toThrow(CanonicalizationError);
    expect(() => canonicalize({ "\uD800": 1 })).toThrow(
      CanonicalizationError,
    );
    expect(canonicalize("😀")).toBe(JSON.stringify("😀"));
  });

  it("rejects sparse arrays and cycles with a typed error", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalize([1, , 3])).toThrow(CanonicalizationError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(CanonicalizationError);
  });

  it("serializes negative zero as 0 per ECMAScript number-to-string", () => {
    expect(canonicalize(-0)).toBe("0");
  });
});
