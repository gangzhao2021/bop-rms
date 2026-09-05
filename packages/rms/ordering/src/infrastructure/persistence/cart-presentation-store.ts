import type { CustomerCartPresentationPorts } from "../../application/customer-cart-presentation-service.js";
import { CartError, parseOrderingReference } from "../../domain/cart.js";
import type { CustomerCartDatabaseRunner } from "./customer-cart-store.js";
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function rows(value: unknown): Record<string, unknown>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { rows?: unknown }).rows)
  )
    return unavailable();
  return (value as { rows: Record<string, unknown>[] }).rows;
}
export function createPostgresCartPresentationStore(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly runner: CustomerCartDatabaseRunner;
}): CustomerCartPresentationPorts["quotes"] {
  const brand = parseOrderingReference(input.brandReference);
  const store = parseOrderingReference(input.storeReference);
  const runner = input.runner;
  return Object.freeze({
    async resolve(request) {
      try {
        if (
          request.brandReference !== brand ||
          request.storeReference !== store ||
          !Number.isSafeInteger(request.cartVersion) ||
          request.cartVersion < 1
        )
          return unavailable();
        const cartReference = parseOrderingReference(request.cartReference);
        const cartVersion = request.cartVersion;
        return await runner.run(async (tx) => {
          const current = rows(
            await tx.query(
              `SELECT aggregate_version FROM rms_ordering.cart
          WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 FOR UPDATE`,
              [brand, store, cartReference],
            ),
          );
          if (current.length !== 1 || current[0]?.aggregate_version !== cartVersion)
            return unavailable();
          // A separate statement after the Cart lock observes completed attachment writes.
          // Any attachment requires the future Quote-aware view, even if attached to an older version.
          const attachments = rows(
            await tx.query(
              `SELECT operation_id FROM rms_ordering.cart_quote_attachment
          WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 LIMIT 1`,
              [brand, store, cartReference],
            ),
          );
          return Object.freeze({
            brandReference: brand,
            storeReference: store,
            cartReference,
            cartVersion,
            quoteStatus: attachments.length === 0 ? "None" : "Present",
          });
        });
      } catch {
        return unavailable();
      }
    },
  });
}
