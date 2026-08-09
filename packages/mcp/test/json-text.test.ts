import { canonicalize } from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";
import { parseCanonicalJsonText } from "../src/json-text.js";

describe("duplicate-safe nested JSON parser", () => {
  it.each([
    "null",
    "true",
    "false",
    "-0",
    "-12.5e+2",
    '"quote: \\\" slash: \\\\ solidus: \\/ controls: \\b\\f\\n\\r\\t"',
    '"unicode: \\u03c0 emoji: \\ud83d\\ude00"',
    "[]",
    "{}",
    '[1,{"nested":[false,null,"ok"]}]',
    '{"__proto__":{"safe":true},"constructor":1}',
  ])("matches native JSON values for valid text %s", (source) => {
    expect(canonicalize(parseCanonicalJsonText(source))).toBe(
      canonicalize(JSON.parse(source)),
    );
  });

  it.each([
    "",
    "+1",
    "01",
    "1.",
    "1e",
    "[1,]",
    '{"a":1,}',
    '"\\x20"',
    '"unterminated',
    "{}{}",
    "NaN",
    "Infinity",
    "1e999",
    '"\\uD800"',
    '"\\uDC00"',
  ])("rejects invalid or non-JCS text %s", (source) => {
    expect(() => parseCanonicalJsonText(source)).toThrow();
  });

  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"outer":{"x":1,"x":2}}',
    '{"__proto__":1,"__proto__":2}',
  ])("rejects decoded duplicate member names %s", (source) => {
    expect(() => parseCanonicalJsonText(source)).toThrow();
  });
});
