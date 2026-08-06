export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

/**
 * Reject strings that are not well-formed UTF-16. RFC 8785 requires I-JSON
 * input, so lone surrogates terminate canonicalization.
 */
function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError("lone high surrogate");
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalizationError("lone low surrogate");
    }
  }
}

function stringifyChecked(value: string | number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new CanonicalizationError("unserializable value");
  }
  return serialized;
}

/**
 * RFC 8785 (JCS) canonical JSON serialization.
 *
 * Throws CanonicalizationError for anything that is not finite-number,
 * well-formed-string, acyclic, dense plain JSON data. Does not consult
 * toJSON().
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number: ${value}`);
      }
      return stringifyChecked(value);
    case "string":
      assertWellFormed(value);
      return stringifyChecked(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`unsupported type: ${typeof value}`);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new CanonicalizationError("cyclic structure");
  }
  seen.add(object);

  try {
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new CanonicalizationError("symbol-keyed properties");
    }

    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let index = 0; index < object.length; index++) {
        if (!Object.hasOwn(object, index)) {
          throw new CanonicalizationError("sparse array");
        }
        parts.push(serialize(object[index], seen));
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        "only plain objects are canonicalizable",
      );
    }

    const entries = Object.entries(object as Record<string, unknown>);
    for (const [key, entryValue] of entries) {
      assertWellFormed(key);
      if (entryValue === undefined) {
        throw new CanonicalizationError("undefined property value");
      }
    }

    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${stringifyChecked(key)}:${serialize(entryValue, seen)}`,
      )
      .join(",")}}`;
  } finally {
    seen.delete(object);
  }
}
