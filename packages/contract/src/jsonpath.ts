export type JsonPath = string;

const SEGMENT = /^[A-Za-z0-9_-]+$/;

export class JsonPathError extends Error {
  override name = "JsonPathError";
}

/**
 * Grammar: "$" then any number of ".name" or "[*]". Returns segments;
 * the array-wildcard segment is the literal string "[*]".
 */
export function parseJsonPath(path: string): string[] {
  if (!path.startsWith("$")) {
    throw new JsonPathError(`must start with $: ${path}`);
  }

  const segments: string[] = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith("[*]")) {
      segments.push("[*]");
      rest = rest.slice(3);
    } else if (rest.startsWith(".")) {
      const next = rest.slice(1);
      const dot = next.indexOf(".");
      const bracket = next.indexOf("[*]");
      const candidates = [dot, bracket].filter((index) => index >= 0);
      const end = candidates.length ? Math.min(...candidates) : next.length;
      const name = next.slice(0, end);
      if (!SEGMENT.test(name)) {
        throw new JsonPathError(`bad segment "${name}" in ${path}`);
      }
      segments.push(name);
      rest = next.slice(end);
    } else {
      throw new JsonPathError(`unexpected "${rest}" in ${path}`);
    }
  }

  return segments;
}

export function isJsonPath(path: string): boolean {
  try {
    parseJsonPath(path);
    return true;
  } catch {
    return false;
  }
}

/** True iff parent's segments are a proper prefix of child's. */
export function isPathExtension(
  child: JsonPath,
  parent: JsonPath,
): boolean {
  const childSegments = parseJsonPath(child);
  const parentSegments = parseJsonPath(parent);
  return (
    childSegments.length > parentSegments.length &&
    parentSegments.every(
      (segment, index) => childSegments[index] === segment,
    )
  );
}

/** True iff every required path equals or extends a covering path. */
export function pathsCover(
  covering: readonly JsonPath[],
  required: readonly JsonPath[],
): boolean {
  return required.every((requiredPath) =>
    covering.some(
      (coveringPath) =>
        requiredPath === coveringPath ||
        isPathExtension(requiredPath, coveringPath),
    ),
  );
}
