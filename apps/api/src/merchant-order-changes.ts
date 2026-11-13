import { createHash } from "node:crypto";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { readStoreOrderChangeMark } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";

/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): a freshly paid pickup reached the Orders screen
 * 30-70 s late. The Orders list itself lists every Order as soon as it exists; the screen read the
 * whole list only every 10 s, and that read is the heaviest staff read (several owner reads per
 * listed Order), so in a rush it ran long or answered busy and the next try came 10 s later. The
 * screen now asks every few seconds only whether anything changed among the Store's Orders (this
 * read: one probe per kind of Order record, nothing about any Order) and reads the whole list at
 * once when it did. Same permission as the list (ordering.operate at the selected Store); the mark
 * is opaque (a digest), so it names no Order.
 */
export function createPersistentMerchantOrderChanges(options: {
  readonly persistence: PersistentMerchantBffOptions;
}) {
  const source = options.persistence;
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now: source.now,
    currentActor: source.currentActor,
  });
  const resolveScope = createMerchantStoreScope(source);
  return async (input: { readonly sessionCookie: unknown }): Promise<{ readonly mark: string }> =>
    runMerchantSnapshotRead(source.transactions, async (transaction) => {
      const session = await currentSession(transaction, input.sessionCookie);
      const resolved = await resolveScope(
        transaction,
        input.sessionCookie,
        "ordering.operate",
        session.sessionReference,
      );
      const decisions = await resolved.authorizeActions(["ordering.operate"]);
      if (decisions.get("ordering.operate")?.effect !== "Allow")
        throw new Error("MERCHANT_ORDER_QUEUE_DENIED");
      const raw = await readStoreOrderChangeMark(
        transaction as unknown as ConsumerTransaction,
        {
          brandReference: String(resolved.context.brand.brandReference),
          storeReference: String(resolved.store.storeReference),
        },
        source.now(),
      );
      const mark = createHash("sha256")
        .update(String(resolved.store.storeReference) + "|" + raw)
        .digest("hex")
        .slice(0, 32);
      return Object.freeze({ mark });
    });
}
