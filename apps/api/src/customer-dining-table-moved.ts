import { DiningCheckoutServiceError, DiningCheckoutStoreError } from "@rms/dining";
import { OrderCreationError } from "@rms/ordering";

/**
 * Dining's refusal of a round whose party staff moved off its table. Recognized by shape too, so it
 * survives a second copy of the owner module (the pilot composes owner stores from sources).
 */
export function isTableMoved(error: unknown): boolean {
  if (error instanceof DiningCheckoutStoreError)
    return error.code === "DINING_CHECKOUT_STORE_TABLE_MOVED";
  if (error instanceof DiningCheckoutServiceError)
    return error.code === "DINING_CHECKOUT_TABLE_MOVED";
  if (error instanceof OrderCreationError) return error.code === "ORDER_CREATE_TABLE_MOVED";
  if (error === null || typeof error !== "object") return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    (name === "DiningCheckoutStoreError" && code === "DINING_CHECKOUT_STORE_TABLE_MOVED") ||
    (name === "DiningCheckoutServiceError" && code === "DINING_CHECKOUT_TABLE_MOVED")
  );
}

/**
 * WP-2423 (table-move-payment review, 2026-11-06): staff moved the party off the table a round was
 * being sent from after it was prepared. Dining refuses to send it from the old table; Ordering
 * passes the refusal on unchanged (nothing written, nothing charged) and the guest's phone starts
 * checkout again at the table the party sits at now, instead of retrying the same checkout until
 * it lapses.
 */
export async function refuseRoundOfMovedTable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isTableMoved(error)) throw new OrderCreationError("ORDER_CREATE_TABLE_MOVED");
    throw error;
  }
}

/**
 * WP-2423 (table-move-send, v15 fabf0261 2026-11-06): carries Dining's "table moved" across a
 * foreign owner's port. Payment's tip selection and Ordering's checkout validation ask Dining
 * whether the round can still be sent from inside their own ports, and turn any port failure into
 * their own "unavailable" (the phone retried a 503 until the checkout lapsed). `watch` runs the
 * Dining call and remembers a table-moved refusal; the foreign owner then refuses with nothing
 * written, and the composition's outer catch calls `rethrow`, which answers that the table moved.
 *
 * Holds state: create one latch per request (inside each `select`/`create` call), never per
 * composition, so one guest's refusal can never relabel another request's failure.
 */
export function createTableMovedLatch() {
  let moved = false;
  const classify = (error: unknown): unknown =>
    moved || isTableMoved(error) ? new OrderCreationError("ORDER_CREATE_TABLE_MOVED") : error;
  return Object.freeze({
    /** Runs a Dining call; a table-moved refusal is remembered and rethrown unchanged. */
    async watch<T>(work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } catch (error) {
        if (isTableMoved(error)) moved = true;
        throw error;
      }
    },
    /** As `watch`, for a port whose refusal is `null` (Payment's authorization). */
    async watchOrNull<T>(work: () => Promise<T>): Promise<T | null> {
      try {
        return await work();
      } catch (error) {
        if (!isTableMoved(error)) throw error;
        moved = true;
        return null;
      }
    },
    /** The outer catch's answer: the table moved if Dining said so in this request, else `error`. */
    classify,
    rethrow(error: unknown): never {
      throw classify(error);
    },
  });
}
