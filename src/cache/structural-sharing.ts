function hasOnlyEnumerableStringDataProperties(value: object): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && 'value' in descriptor;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    hasOnlyEnumerableStringDataProperties(value)
  );
}

function isPositionalArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }

  return Reflect.ownKeys(value).every((key) => {
    if (key === 'length') return true;
    if (typeof key !== 'string') return false;
    const index = Number(key);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= value.length ||
      String(index) !== key
    ) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && 'value' in descriptor;
  });
}

function shareValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;

  if (previous instanceof Date && next instanceof Date) {
    return Object.is(previous.getTime(), next.getTime()) ? previous : next;
  }

  if (isPositionalArray(previous) && isPositionalArray(next)) {
    const shared = new Array<unknown>(next.length);
    let equal = previous.length === next.length;

    for (let index = 0; index < next.length; index += 1) {
      const previousHasValue = Object.hasOwn(previous, index);
      const nextHasValue = Object.hasOwn(next, index);
      if (previousHasValue !== nextHasValue) equal = false;
      if (!nextHasValue) continue;

      const value = previousHasValue
        ? shareValue(previous[index], next[index])
        : next[index];
      shared[index] = value;
      if (!previousHasValue || !Object.is(value, previous[index])) equal = false;
    }

    return equal ? previous : shared;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    const shared = Object.create(Object.getPrototypeOf(next)) as Record<
      string,
      unknown
    >;
    let equal =
      previousKeys.length === nextKeys.length &&
      Object.getPrototypeOf(previous) === Object.getPrototypeOf(next);

    for (const key of nextKeys) {
      const previousHasValue = Object.hasOwn(previous, key);
      const value = previousHasValue
        ? shareValue(previous[key], next[key])
        : next[key];
      Object.defineProperty(shared, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      if (!previousHasValue || !Object.is(value, previous[key])) equal = false;
    }

    return equal ? previous : shared;
  }

  return next;
}

/**
 * Reuses equal branches from an immutable, acyclic snapshot. Arrays and plain
 * objects with enumerable string-keyed data properties are compared by
 * position/key. Equal Dates reuse the previous instance; other values stay
 * opaque.
 */
export function structurallyShare<T>(previous: T, next: T): T {
  return shareValue(previous, next) as T;
}
