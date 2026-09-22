import { createPostgresOrderCancelledAmountSource } from "./persistence/order-cancelled-amount-source.js";
import { createHash } from "node:crypto";
import { createPostgresSubmittedOrderAmountSource } from "./persistence/submitted-order-amount-source.js";
import { createPostgresOrderAmendmentPosition } from "./persistence/dining-session-order-inventory.js";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
const fail = (): never => {
  throw new Error("ORDER_PRICED_AMOUNT_UNAVAILABLE");
};
/** Current merchandise price basis. Refund and write-off decisions
 * remain independent; this source never issues settlement or closure evidence.
 * Caller must retain the transaction while consuming this position. */
export function createPostgresOrderPricedAmountSource(
  options: Parameters<typeof createPostgresSubmittedOrderAmountSource>[0],
) {
  const brandReference = String(parseOrderingReference(options.brandReference)),
    storeReference = String(parseOrderingReference(options.storeReference));
  const submitted = createPostgresSubmittedOrderAmountSource({
    ...options,
    brandReference,
    storeReference,
  });
  const cancellations = createPostgresOrderCancelledAmountSource(options);
  const amendments = createPostgresOrderAmendmentPosition({
    brandReference,
    storeReference,
    authorizeAndFence: (tx, query) =>
      options.authorize(tx, { ...query, brandReference, storeReference }),
  });
  return async (...args: Parameters<typeof submitted>) => {
    try {
      const [tx, input] = args,
        query = {
          orderReference: String(parseOrderingReference(input.orderReference)),
          observedAt: String(parseOrderingInstant(input.observedAt)),
        };
      if ((await options.authorize(tx, { ...query, brandReference, storeReference })) !== true)
        return fail();
      // Match revision writers: disposition fence precedes parent/item locks.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" +
          [brandReference, storeReference, query.orderReference].join(":"),
      ]);
      const base = await submitted(tx, query),
        changes = await amendments.load(tx, query);
      for (const source of [base, changes])
        if (
          source.brandReference !== brandReference ||
          source.storeReference !== storeReference ||
          source.orderReference !== query.orderReference ||
          source.observedAt !== query.observedAt
        )
          return fail();
      if (
        base.currencyCode !== "CAD" ||
        base.tipIncluded !== false ||
        base.amendmentAdjustmentsIncluded !== false ||
        typeof base.totalMinor !== "bigint" ||
        base.totalMinor < 0n ||
        !/^sha256:[0-9a-f]{64}$/u.test(base.snapshotDigest)
      )
        return fail();
      const applied = changes.amendments.filter((change) => change.status === "Applied");
      const adjustment = applied.reduce((sum, change) => sum + BigInt(change.deltaMinor), 0n);
      const pending = changes.amendments.filter(
        (change) => change.status === "PendingApproval" || change.status === "PendingKitchen",
      ).length;
      if (adjustment !== changes.appliedDeltaMinor || pending !== changes.pendingCount)
        return fail();
      const cancelled = await cancellations(tx, base);
      if (
        typeof cancelled.cancelledTotalMinor !== "bigint" ||
        cancelled.cancelledTotalMinor < 0n ||
        cancelled.cancelledTotalMinor > base.totalMinor ||
        !/^sha256:[a-f0-9]{64}$/u.test(cancelled.snapshotDigest)
      )
        return fail();
      const pricedTotalMinor = base.totalMinor + adjustment - cancelled.cancelledTotalMinor;
      if (pricedTotalMinor < 0n || pricedTotalMinor > 9223372036854775807n) return fail();
      const evidence = Object.freeze(
        changes.amendments.map((change) => Object.freeze({ ...change })),
      );
      const snapshotDigest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              brandReference,
              storeReference,
              query.orderReference,
              base.snapshotDigest,
              cancelled.snapshotDigest,
              evidence,
              adjustment.toString(),
              pricedTotalMinor.toString(),
            ]),
          )
          .digest("hex");
      if ((await options.authorize(tx, { ...query, brandReference, storeReference })) !== true)
        return fail();
      return Object.freeze({
        brandReference,
        storeReference,
        ...query,
        currencyCode: "CAD" as const,
        submittedTotalMinor: base.totalMinor,
        appliedAmendmentDeltaMinor: adjustment,
        cancelledBatchTotalMinor: cancelled.cancelledTotalMinor,
        pricedTotalMinor,
        pendingAmendmentCount: pending,
        amendments: evidence,
        snapshotDigest,
      });
    } catch {
      return fail();
    }
  };
}
