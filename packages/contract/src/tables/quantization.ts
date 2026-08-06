import { deepFreeze } from "../deep-freeze.js";

export const TTL_BUCKETS_SECONDS: readonly number[] = deepFreeze([
  300, 900, 1800, 3600, 7200,
]);
export const PAYLOAD_PAD_BUCKETS_BYTES: readonly number[] = deepFreeze([
  4096, 16384, 65536, 262144, 1048576,
]);
export const BATCH_SIZE_BUCKETS: readonly number[] = deepFreeze([
  1, 2, 5, 10,
]);

/** Return the smallest bucket at least as large as the value. */
export function bucketFor(
  value: number,
  buckets: readonly number[],
): number | null {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`unbucketable value: ${value}`);
  }
  if (buckets.length === 0) {
    throw new RangeError("empty bucket table");
  }
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]!;
    if (
      !Number.isFinite(bucket) ||
      bucket <= 0 ||
      (index > 0 && bucket <= buckets[index - 1]!)
    ) {
      throw new RangeError(
        "bucket table must be finite, positive, strictly increasing",
      );
    }
  }
  for (const bucket of buckets) {
    if (value <= bucket) return bucket;
  }
  return null;
}
