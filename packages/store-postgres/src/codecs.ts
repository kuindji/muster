import { createHash } from "node:crypto";
import { PostgresInfrastructureError } from "./errors.js";

type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

const invalidStoredValue = (message: string): never => {
  throw new PostgresInfrastructureError("invalid_stored_value", message);
};

function copyJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidStoredValue(`${path} must be finite`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      invalidStoredValue(`${path} must not contain an unsafe integer`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => copyJson(entry, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalidStoredValue(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        copyJson(entry, `${path}.${key}`),
      ]),
    );
  }
  return invalidStoredValue(`${path} is not valid JSON`);
}

/** Reject malformed driver values and return a detached JSON tree. */
export function decodeStoredJson(value: unknown): JsonValue {
  return copyJson(value, "stored value");
}

/** Decode a JSONB record and fail loudly on a future/unknown discriminant. */
export function decodeStoredRecord<T>(
  value: unknown,
  validate: (record: Readonly<Record<string, JsonValue>>) => boolean,
  description: string,
): T {
  const decoded = decodeStoredJson(value);
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    return invalidStoredValue(`${description} must be a JSON object`);
  }
  if (!validate(decoded)) {
    return invalidStoredValue(`${description} has an unknown or invalid shape`);
  }
  return decoded as unknown as T;
}

export function decodePositiveRevision(value: unknown, field = "revision"): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    return invalidStoredValue(`${field} must be a positive safe integer`);
  }
  return parsed as number;
}

function normalized(value: unknown): unknown {
  if (value === undefined) return { __musterUndefined: true };
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalidStoredValue("command input must contain only plain objects");
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    invalidStoredValue("command input must contain only finite numbers");
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    invalidStoredValue("command input must not contain unsafe integers");
  }
  if (
    typeof value === "bigint" || typeof value === "function" ||
    typeof value === "symbol"
  ) {
    invalidStoredValue("command input contains a non-serializable value");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

/** Capture inputs before I/O while preserving optional-field presence. */
export function snapshotCommandInput<T>(value: T): Readonly<T> {
  const normalizedValue = normalized(value);
  void normalizedValue;
  return deepFreeze(structuredClone(value));
}

/** Reference-compatible structural fingerprint, including explicit undefined. */
export function commandFingerprint(value: unknown): string {
  const serialized = JSON.stringify(normalized(value));
  if (serialized === undefined) {
    return invalidStoredValue("command input cannot be serialized");
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
