import { describe, expect, it } from "vitest";
import {
  BATCH_SIZE_BUCKETS,
  PAYLOAD_PAD_BUCKETS_BYTES,
  TTL_BUCKETS_SECONDS,
  bucketFor,
} from "../src/tables/quantization.js";

describe("side-channel quantization (spec 5.7)", () => {
  it("bucket sets are frozen, non-empty, strictly increasing", () => {
    expect(TTL_BUCKETS_SECONDS).toEqual([300, 900, 1800, 3600, 7200]);
    expect(PAYLOAD_PAD_BUCKETS_BYTES).toEqual([
      4096, 16384, 65536, 262144, 1048576,
    ]);
    expect(BATCH_SIZE_BUCKETS).toEqual([1, 2, 5, 10]);
    for (const buckets of [
      TTL_BUCKETS_SECONDS,
      PAYLOAD_PAD_BUCKETS_BYTES,
      BATCH_SIZE_BUCKETS,
    ]) {
      for (let index = 1; index < buckets.length; index += 1) {
        expect(buckets[index]!).toBeGreaterThan(buckets[index - 1]!);
      }
      expect(Object.isFrozen(buckets)).toBe(true);
    }
  });

  it("bucketFor rounds UP to the smallest bucket >= value", () => {
    expect(bucketFor(1, TTL_BUCKETS_SECONDS)).toBe(300);
    expect(bucketFor(300, TTL_BUCKETS_SECONDS)).toBe(300);
    expect(bucketFor(301, TTL_BUCKETS_SECONDS)).toBe(900);
    expect(bucketFor(5000, PAYLOAD_PAD_BUCKETS_BYTES)).toBe(16384);
  });

  it("returns null on overflow rather than rounding down", () => {
    expect(bucketFor(7201, TTL_BUCKETS_SECONDS)).toBe(null);
    expect(bucketFor(2_000_000, PAYLOAD_PAD_BUCKETS_BYTES)).toBe(null);
  });

  it("rejects non-finite and negative values", () => {
    for (const bad of [NaN, Infinity, -1]) {
      expect(() => bucketFor(bad, TTL_BUCKETS_SECONDS)).toThrow();
    }
  });

  it("rejects malformed bucket tables", () => {
    for (const badTable of [[], [300, 300], [900, 300], [0, 300], [NaN]]) {
      expect(() => bucketFor(1, badTable)).toThrow(RangeError);
    }
  });
});
