import { readClosedRecord } from "@bop/identity";
import {
  AdditionalDiningBatchError,
  parseAdditionalDiningBatchSnapshot,
} from "./additional-dining-batch.js";
import {
  encodeOrderItemSnapshot,
  encodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
} from "./order-item-snapshot-codec.js";

const maximumBytes = 16 * 1024 * 1024;
const fail = (): never => {
  throw new AdditionalDiningBatchError();
};
function bounded(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > maximumBytes ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  )
    return fail();
  return value;
}

/** Explicit immutable JSONB representation. Money retains the existing item
 * codec's decimal-string representation; this is not submission authorization.
 */
export function encodeAdditionalDiningBatchSnapshot(value: unknown): string {
  try {
    const snapshot = parseAdditionalDiningBatchSnapshot(value);
    const encodeItem =
      snapshot.snapshotVersion === 2 ? encodeConfiguredOrderItemSnapshot : encodeOrderItemSnapshot;
    return bounded(
      JSON.stringify({
        ...snapshot,
        items: snapshot.items.map((item) => JSON.parse(encodeItem(item)) as unknown),
      }),
    );
  } catch {
    return fail();
  }
}

export function decodeAdditionalDiningBatchSnapshot(value: unknown) {
  try {
    const raw = readClosedRecord(JSON.parse(bounded(value)) as unknown, [
      "orderReference",
      "brandReference",
      "storeReference",
      "diningSessionReference",
      "guestSessionReference",
      "originalOrderCreatedAt",
      "expectedOrderVersion",
      "batchSequence",
      "snapshotVersion",
      "batch",
      "items",
    ]);
    if (
      (raw.snapshotVersion !== 1 && raw.snapshotVersion !== 2) ||
      !Array.isArray(raw.items) ||
      raw.items.length < 1 ||
      raw.items.length > 100
    )
      return fail();
    const decodeItem =
      raw.snapshotVersion === 2 ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot;
    return parseAdditionalDiningBatchSnapshot({
      ...raw,
      items: raw.items.map((item: unknown) => decodeItem(item)),
    });
  } catch {
    return fail();
  }
}
