import type { ConsumerTransaction } from "@bop/eventing";
import { createHash } from "node:crypto";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  parseOrderClosureRecord,
  resolveOrderClosureHistory,
} from "../../domain/order-closure-record.js";
import { createPostgresOrderRevisionPosition } from "./order-revision-position.js";
const fail = (): never => {
  throw new Error("ORDER_CLOSURE_POSITION_UNAVAILABLE");
};
/** Requires successful complete history read and existing scoped Order. Missing
 * persistence is unavailable, never initial Open. Retain transaction until use. */
function createOrderClosureRead(
  options: Parameters<typeof createPostgresOrderRevisionPosition>[0] & { tenantReference: string },
) {
  const tenant = parseOrderingReference(options.tenantReference),
    brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  const revision = createPostgresOrderRevisionPosition({
    ...options,
    brandReference: brand,
    storeReference: store,
  });
  return async (tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) => {
    try {
      const query = {
        orderReference: parseOrderingReference(input.orderReference),
        observedAt: parseOrderingInstant(input.observedAt),
      };
      const current = await revision(tx, query);
      if (
        current.brandReference !== brand ||
        current.storeReference !== store ||
        current.orderReference !== query.orderReference ||
        current.observedAt !== query.observedAt
      )
        return fail();
      const result = await tx.query(
        `SELECT closure_id AS "closureReference",operation_id AS "operationReference",tenant_id AS "tenantReference",brand_id AS "brandReference",store_id AS "storeReference",order_id AS "orderReference",closure_version AS "closureVersion",order_version AS "orderVersion",previous_closure_id AS "previousClosureReference",status,actor_type AS "actorType",actor_id AS "actorReference",reason_code AS "reasonCode",financial_finality_id AS "financialFinalityReference",evidence_digest AS "evidenceDigest",occurred_at AS "occurredAt" FROM rms_ordering.order_closure_version WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY closure_version LIMIT 1001`,
        [brand, store, query.orderReference],
      );
      if (result.rows.length > 1000) return fail();
      const history = result.rows.map((row) =>
        parseOrderClosureRecord({
          ...row,
          occurredAt:
            row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
        }),
      );
      if (
        history.some(
          (record) =>
            record.tenantReference !== tenant ||
            record.brandReference !== brand ||
            record.storeReference !== store ||
            record.orderReference !== query.orderReference ||
            record.occurredAt > query.observedAt ||
            record.orderVersion > current.version,
        )
      )
        return fail();
      const latest = history.length ? resolveOrderClosureHistory(history) : null;
      if (latest?.status === "Closed" && latest.orderVersion !== current.version) return fail();
      if ((await options.authorize(tx, query)) !== true) return fail();
      const position = Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        ...query,
        orderVersion: current.version,
        orderCheckpoint: current.checkpoint,
        status: latest?.status ?? ("Open" as const),
        closureVersion: latest?.closureVersion ?? 0,
        closureReference: latest?.closureReference ?? null,
        financialFinalityReference: latest?.financialFinalityReference ?? null,
        snapshotDigest:
          "sha256:" +
          createHash("sha256")
            .update(
              JSON.stringify([
                tenant,
                brand,
                store,
                query.orderReference,
                current.snapshotDigest,
                history,
              ]),
            )
            .digest("hex"),
      });
      return Object.freeze({ position, records: Object.freeze(history) });
    } catch {
      return fail();
    }
  };
}

/** Current position contract remains unchanged for existing consumers. */
export function createPostgresOrderClosurePosition(
  options: Parameters<typeof createOrderClosureRead>[0],
) {
  const read = createOrderClosureRead(options);
  return async (...input: Parameters<typeof read>) => (await read(...input)).position;
}

/** Complete immutable owner history, including earlier Closed facts after Reopen.
 * Historical closure is not evidence of present-day balance or new-task clearance.
 * Caller must retain the transaction and match the relevant episode and Payment fact. */
export function createPostgresOrderClosureHistory(
  options: Parameters<typeof createOrderClosureRead>[0],
) {
  return createOrderClosureRead(options);
}
