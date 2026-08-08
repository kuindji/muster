import { describe, expect, it } from "vitest";
import {
  commandFingerprint,
  decodePositiveRevision,
  decodeStoredJson,
  decodeStoredRecord,
  snapshotCommandInput,
} from "../src/codecs.js";

describe("PostgreSQL stored-value codecs", () => {
  it("detaches and freezes command input before I/O", () => {
    const input = { nested: { value: 1 }, optional: undefined };
    const captured = snapshotCommandInput(input);
    input.nested.value = 2;

    expect(captured).toEqual({ nested: { value: 1 }, optional: undefined });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.nested)).toBe(true);
  });

  it("preserves optional-field presence in structural fingerprints", () => {
    expect(commandFingerprint({ value: 1 })).not.toBe(
      commandFingerprint({ value: 1, optional: undefined }),
    );
    expect(commandFingerprint({ b: 2, a: 1 })).toBe(
      commandFingerprint({ a: 1, b: 2 }),
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 9_007_199_254_740_992])(
    "rejects unsafe stored number %s",
    (value) => {
      expect(() => decodeStoredJson({ value })).toThrowError(
        expect.objectContaining({ code: "invalid_stored_value" }),
      );
    },
  );

  it("rejects null records, invalid revisions, and unknown discriminants", () => {
    expect(() => decodeStoredRecord(null, () => true, "record")).toThrow();
    expect(() => decodePositiveRevision("9007199254740992")).toThrow();
    expect(() =>
      decodeStoredRecord(
        { kind: "future" },
        (record) => record.kind === "known",
        "record",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_stored_value" }));
  });
});
