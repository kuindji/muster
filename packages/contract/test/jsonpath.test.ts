import { describe, expect, it } from "vitest";

import {
  isJsonPath,
  isPathExtension,
  parseJsonPath,
  pathsCover,
} from "../src/jsonpath.js";
import { isWireId } from "../src/primitives.js";

describe("JsonPath grammar", () => {
  it("parses root, properties, and array wildcards", () => {
    expect(parseJsonPath("$")).toEqual([]);
    expect(parseJsonPath("$.items")).toEqual(["items"]);
    expect(parseJsonPath("$.items[*].source_url")).toEqual([
      "items",
      "[*]",
      "source_url",
    ]);
  });

  it("rejects malformed paths", () => {
    for (const bad of [
      "",
      "items",
      "$.",
      "$..a",
      "$.a b",
      "$[0]",
      "$.a['b']",
      "$.é",
    ]) {
      expect(isJsonPath(bad), bad).toBe(false);
      expect(() => parseJsonPath(bad)).toThrow();
    }
  });
});

describe("path containment (spec 6.7)", () => {
  it("a path extends its proper prefixes", () => {
    expect(isPathExtension("$.a.b", "$.a")).toBe(true);
    expect(isPathExtension("$.a.b.c", "$.a")).toBe(true);
    expect(isPathExtension("$.items[*].id", "$.items")).toBe(true);
  });

  it("equality is not extension, and siblings never extend", () => {
    expect(isPathExtension("$.a", "$.a")).toBe(false);
    expect(isPathExtension("$.ab", "$.a")).toBe(false);
    expect(isPathExtension("$.a", "$.a.b")).toBe(false);
  });

  it("pathsCover: every required path equals or extends a covering path", () => {
    const domain = ["$.items", "$.meta.language"];
    expect(pathsCover(domain, ["$.items"])).toBe(true);
    expect(pathsCover(domain, ["$.items[*].claims"])).toBe(true);
    expect(
      pathsCover(domain, ["$.meta.language", "$.items[*].id"]),
    ).toBe(true);
    expect(pathsCover(domain, ["$.meta"])).toBe(false);
    expect(pathsCover(domain, ["$.other"])).toBe(false);
    expect(pathsCover([], ["$.items"])).toBe(false);
    expect(pathsCover(domain, [])).toBe(true);
  });
});

describe("wire identifier grammar", () => {
  it("accepts coordinator-shaped ids and hex digests", () => {
    for (const id of [
      "lease-1",
      "a".repeat(64),
      "epoch:2026-08",
      "intent_9",
    ]) {
      expect(isWireId(id)).toBe(true);
    }
  });

  it("rejects non-ASCII, spaces, controls, and empty", () => {
    for (const id of ["", "lease 1", "π", "ключ", "a\u0000b"]) {
      expect(isWireId(id)).toBe(false);
    }
  });
});
