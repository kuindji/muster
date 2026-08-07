import {
  canonicalize,
  parseJsonPath,
  type CanonicalJsonValue,
} from "@kuindji/muster-contract";

export const cloneCanonical = <T>(value: T): T =>
  JSON.parse(canonicalize(value)) as T;

const mergeProjection = (left: unknown, right: unknown): unknown => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.map((entry, index) => mergeProjection(entry, right[index]));
  }
  if (
    typeof left === "object" && left !== null && !Array.isArray(left) &&
    typeof right === "object" && right !== null && !Array.isArray(right)
  ) {
    const merged: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = mergeProjection(merged[key], value);
    }
    return merged;
  }
  return right;
};

const selectProjection = (
  value: unknown,
  segments: readonly string[],
): unknown => {
  if (segments.length === 0) return cloneCanonical(value);
  const [head, ...tail] = segments;
  if (head === "[*]") {
    return Array.isArray(value)
      ? value.map((entry) => selectProjection(entry, tail))
      : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (head === undefined || !Object.hasOwn(record, head)) return undefined;
  return { [head]: selectProjection(record[head], tail) };
};

/** Canonical projection used by registration fixtures and runtime derivation. */
export const projectCanonical = (
  value: CanonicalJsonValue,
  paths: readonly string[],
): CanonicalJsonValue => {
  let selected: unknown;
  for (const path of paths) {
    selected = mergeProjection(
      selected,
      selectProjection(value, parseJsonPath(path)),
    );
  }
  return cloneCanonical((selected ?? {}) as CanonicalJsonValue);
};
