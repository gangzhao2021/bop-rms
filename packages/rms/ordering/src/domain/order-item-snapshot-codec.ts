import {
  parseOrderItemTransactionSnapshot,
  type OrderItemTransactionSnapshot,
} from "./order-item-snapshot.js";

export class OrderItemSnapshotCodecError extends Error {
  readonly code = "ORDER_ITEM_SNAPSHOT_CODEC_INVALID";
  constructor() {
    super("order item snapshot representation is invalid");
    this.name = "OrderItemSnapshotCodecError";
  }
}
function fail(): never {
  throw new OrderItemSnapshotCodecError();
}
const maximumBytes = 16 * 1024 * 1024;
const minimumMinor = -(2n ** 63n),
  maximumMinor = 2n ** 63n - 1n;

/** Copy inert bounded data without invoking property accessors, iterators or toJSON hooks. */
function capture(value: unknown, wire: boolean): unknown {
  let nodes = 0,
    characters = 0;
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 32) fail();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      characters += current.length;
      if (characters > maximumBytes) fail();
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) fail();
      return current;
    }
    if (typeof current === "bigint") {
      if (wire) fail();
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) fail();
    ancestors.add(current);
    try {
      const keys = Reflect.ownKeys(current);
      if (Array.isArray(current)) {
        if (
          Object.getPrototypeOf(current) !== Array.prototype ||
          current.length > 1000 ||
          keys.length !== current.length + 1
        )
          fail();
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) fail();
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (Object.getPrototypeOf(current) !== Object.prototype || keys.length > 1000) fail();
      const entries: [string, unknown][] = [];
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 256) fail();
        characters += key.length;
        if (characters > maximumBytes) fail();
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) fail();
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      const result = Object.fromEntries(entries);
      if (
        wire &&
        keys.length === 2 &&
        Object.hasOwn(result, "amountMinor") &&
        Object.hasOwn(result, "currencyCode")
      ) {
        const amount: unknown = result.amountMinor;
        if (
          typeof amount !== "string" ||
          !/^-?(0|[1-9][0-9]{0,18})$/u.test(amount) ||
          amount === "-0"
        )
          fail();
        const parsed = BigInt(amount);
        if (parsed < minimumMinor || parsed > maximumMinor) fail();
        result.amountMinor = parsed;
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, 0);
}
function serialize(snapshot: OrderItemTransactionSnapshot): string {
  const encoded = JSON.stringify(snapshot, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) fail();
  return encoded;
}

/** JSON text for the existing owner JSONB snapshot column; monetary values are decimal strings. */
export function encodeOrderItemSnapshot(value: unknown): string {
  try {
    return serialize(parseOrderItemTransactionSnapshot(capture(value, false)));
  } catch {
    return fail();
  }
}

/** Takes a parsed JSONB data object, not an executable object or a legacy partial snapshot. */
export function decodeOrderItemSnapshot(value: unknown): OrderItemTransactionSnapshot {
  try {
    const snapshot = parseOrderItemTransactionSnapshot(capture(value, true));
    serialize(snapshot);
    return snapshot;
  } catch {
    return fail();
  }
}
