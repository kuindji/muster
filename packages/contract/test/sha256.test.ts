import { describe, expect, it } from "vitest";

import {
  hashCanonical,
  sha256Hex,
} from "../src/canonical/sha256.js";

describe("sha256Hex", () => {
  it("matches NIST vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches NIST vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes UTF-8 bytes, not UTF-16", async () => {
    expect(await sha256Hex("π")).toBe(
      await sha256Hex(new Uint8Array([0xcf, 0x80])),
    );
  });
});

describe("hashCanonical", () => {
  it("is the digest of the canonical form", async () => {
    expect(await hashCanonical({ b: 1, a: 2 })).toBe(
      await sha256Hex('{"a":2,"b":1}'),
    );
  });

  it("is key-order independent", async () => {
    expect(await hashCanonical({ x: [1, 2], y: "z" })).toBe(
      await hashCanonical({ y: "z", x: [1, 2] }),
    );
  });
});
