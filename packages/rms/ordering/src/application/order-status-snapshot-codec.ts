import {
  parseOrderStatusSourceSnapshot,
  OrderStatusProjectionError,
} from "../domain/order-status-projection.js";

export function encodeOrderStatusSnapshot(value: unknown): string {
  return JSON.stringify(parseOrderStatusSourceSnapshot(value), (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

/** Existing projection_snapshot_json contains the snapshot, not a new envelope. */
export function decodeOrderStatusSnapshot(value: unknown) {
  try {
    if (typeof value !== "string") throw new Error("invalid");
    const snapshot = JSON.parse(value);
    if (!Array.isArray(snapshot?.batches) || snapshot.batches.length > 20)
      throw new Error("invalid");
    for (const batch of snapshot.batches) {
      if (!Array.isArray(batch?.items) || batch.items.length > 100) throw new Error("invalid");
      for (const item of batch.items) {
        const amount = item?.lineTotal?.amountMinor;
        if (typeof amount !== "string" || !/^(0|-?[1-9][0-9]{0,18})$/.test(amount))
          throw new Error("invalid");
        item.lineTotal.amountMinor = BigInt(amount);
      }
    }
    return parseOrderStatusSourceSnapshot(snapshot);
  } catch {
    throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  }
}
