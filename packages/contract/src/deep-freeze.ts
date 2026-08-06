/**
 * Recursively Object.freeze a value in place and return it.
 *
 * Recursion intentionally does not stop at an already-frozen node. The seen
 * set makes cyclic structures safe.
 */
export function deepFreeze<T>(
  value: T,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const object = value as unknown as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);

  Object.freeze(object);
  for (const key of Object.getOwnPropertyNames(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }

  return value;
}
