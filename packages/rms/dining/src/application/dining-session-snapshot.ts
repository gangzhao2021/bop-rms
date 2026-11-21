import { DiningSessionError } from "../contracts/dining-session.js";

export function sessionDependency(): never {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
}

/** Capture only bounded plain data without invoking dependency accessors. */
export function captureSessionData<T>(value: T): T {
  let count = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++count > 20_000 || depth > 12) return sessionDependency();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && input.length <= 65_536) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null) return sessionDependency();
    const array = Array.isArray(input);
    if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype))
      return sessionDependency();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 10_000) return sessionDependency();
    const length = array ? Object.getOwnPropertyDescriptor(input, "length")?.value : 0;
    if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1))
      return sessionDependency();
    const entries = (array ? Array.from({ length }, (_, index) => String(index)) : keys).map(
      (key) => {
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== "string" || !field?.enumerable || !("value" in field))
          return sessionDependency();
        return [key, copy(field.value, depth + 1)] as const;
      },
    );
    return Object.freeze(array ? entries.map((entry) => entry[1]) : Object.fromEntries(entries));
  };
  try {
    return copy(value, 0) as T;
  } catch {
    return sessionDependency();
  }
}
