import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CartError,
  parseCartItem,
  parseOrderingInstant,
  parseOrderingReference,
} from "../../domain/cart.js";
import { createPostgresCartQueryStore, type CartQueryTransaction } from "./cart-query-store.js";
import { createPostgresDiningCartReadStore } from "./dining-cart-read-store.js";

/**
 * WP-2423 shared-table-cart-staff-round M38 (2000_412): the guest paying for a table's round
 * stopped before paying (its cancellation GUEST_CANCELLED_UNPAID is written first, in the same
 * transaction). Its dishes come back to the table's current shared cart, each as a new line as it
 * was added: dish, options, note, the Catalog evidence it was chosen with, and whose phone added it
 * (a dish that can't be sold now comes back and is marked, as any line is). Once per round: a
 * second return answers `AlreadyReturned` with nothing written. The caller owns the transaction
 * and has authorized the guest; the Audit record is the System's on the guest's channel.
 */
export interface DiningRoundCartReturnInput {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** The Guest Session asking: the one that sent the round, or a later one of the same phone. */
  readonly guestSessionReference: string;
  /** Its table participant (the phone at the table). */
  readonly participantReference: string;
  /** The Guest Session that sent the round (findGuestDiningRound). */
  readonly submittedGuestSessionReference: string;
  readonly operationReference: string;
  readonly observedAt: string;
  /** A fresh reference for each returned line. */
  newLineReference(): string;
  /** Action ORDERING_ROUND_RETURNED_TO_CART, System actor, CUSTOMER_PWA, target the cart. */
  audit(cartReference: string): AppendAuditRecordInput;
}
export interface DiningRoundCartReturn {
  readonly status: "Returned" | "AlreadyReturned";
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly cartItemReferences: readonly string[];
}

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function rowsOf(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || !("rows" in value)) return unavailable();
  const rows = (value as { rows: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : unavailable();
}
const lent = (tx: CartQueryTransaction) => ({
  run: async <T>(action: (transaction: CartQueryTransaction) => Promise<T>) => action(tx),
});

export async function returnDiningRoundToCart(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: DiningRoundCartReturnInput,
): Promise<DiningRoundCartReturn> {
  const brand = parseOrderingReference(scopeInput.brandReference);
  const store = parseOrderingReference(scopeInput.storeReference);
  const order = parseOrderingReference(input.orderReference);
  const batch = parseOrderingReference(input.orderBatchReference);
  const guest = parseOrderingReference(input.guestSessionReference);
  const participant = parseOrderingReference(input.participantReference);
  const submitter = parseOrderingReference(input.submittedGuestSessionReference);
  const operation = parseOrderingReference(input.operationReference);
  const at = parseOrderingInstant(input.observedAt);
  const scope = { brandReference: brand, storeReference: store };
  await tx.query(
    "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
    [brand, store],
  );
  // Once per round, whichever operation asked first.
  const prior = rowsOf(
    await tx.query(
      `SELECT cart_id::text AS cart, result_aggregate_version AS version,
         array_to_json(cart_line_ids) AS lines
       FROM rms_ordering.dining_round_cart_return
       WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3`,
      [brand, store, batch],
    ),
  );
  if (prior.length === 1) {
    const found = prior[0] as Record<string, unknown>;
    return Object.freeze({
      status: "AlreadyReturned" as const,
      cartReference: String(found.cart),
      cartVersion: Number(found.version),
      cartItemReferences: Object.freeze((found.lines as string[]).map(String)),
    });
  }
  // The round's own table: the dining session of the cart it was sent from.
  const source = rowsOf(
    await tx.query(
      `SELECT c.dining_session_id::text AS session, b.source_cart_id::text AS cart
       FROM rms_ordering.order_batch b
       JOIN rms_ordering.cart c ON c.cart_id=b.source_cart_id AND c.brand_id=b.brand_id
         AND c.store_id=b.store_id AND c.order_type='DineIn'
       WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4`,
      [brand, store, order, batch],
    ),
  );
  if (source.length !== 1 || typeof source[0]?.session !== "string") return unavailable();
  const session = String(source[0].session);
  const sourceCart = String(source[0].cart);
  const current = await createPostgresDiningCartReadStore(lent(tx), scope).current({
    ...scope,
    diningSessionReference: parseOrderingReference(session),
    observedAt: at,
  });
  // The table closed or its cart ended: nothing to put the dishes back into.
  if (current === null) throw new CartError("CART_UNAVAILABLE");
  const cartReference = String(current.cartReference);
  if (
    rowsOf(
      await tx.query(
        "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
        [brand, store, cartReference],
      ),
    ).length !== 1
  )
    return unavailable();
  const locked = await createPostgresCartQueryStore(lent(tx), scope).load(cartReference);
  if (locked === null) return unavailable();
  // Each dish as it was in the cart when it was sent: the newest of the last guest operation on
  // its line; for a dish an earlier stop put back (no cart operation added that line), the line as
  // that return recorded it; and for a dish that came back from the pay-first waiting list
  // (2000_520, no cart operation either), the line as it was set aside. A line the payer's choice
  // of dishes split (part of it waited) went on with fewer: its newest such split says how many.
  const items = rowsOf(
    await tx.query(
      `SELECT i.source_cart_line_id::text AS line, i.quantity,
         (SELECT k.item FROM (
            SELECT item, o.result_aggregate_version AS version
            FROM rms_ordering.cart_operation_record o,
              jsonb_array_elements(o.result_cart_snapshot_json->'items') AS item
            WHERE o.brand_id=$1 AND o.store_id=$2 AND o.cart_id=$5::uuid
              AND o.cart_line_id=i.source_cart_line_id AND o.action_code IN ('Add','Update')
              AND item->>'cartItemReference' = i.source_cart_line_id::text
            UNION ALL
            SELECT item, x.result_aggregate_version AS version
            FROM rms_ordering.dining_round_cart_return x,
              jsonb_array_elements(x.returned_items_json) AS item
            WHERE x.brand_id=$1 AND x.store_id=$2 AND x.cart_id=$5::uuid
              AND i.source_cart_line_id = ANY (x.cart_line_ids)
              AND item->>'cartItemReference' = i.source_cart_line_id::text
            UNION ALL
            SELECT jsonb_build_object(
                'cartItemReference', r.returned_cart_line_id, 'cartReference', r.cart_id,
                'sellableReference', w.sellable_id, 'quantity', w.quantity,
                'optionSelections', w.option_selections_json, 'customerNote', w.customer_note,
                'catalogSelectionEvidence', w.catalog_selection_evidence_json,
                'addedByActorReference', w.added_by_actor_id,
                'addedByParticipantReference', w.added_by_participant_id,
                'addedAt', to_char(w.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) AS item, r.cart_version AS version
            FROM rms_ordering.dining_cart_waiting_line_resolution r
            JOIN rms_ordering.dining_cart_waiting_line w ON w.brand_id=r.brand_id
              AND w.store_id=r.store_id AND w.waiting_line_id=r.waiting_line_id
            WHERE r.brand_id=$1 AND r.store_id=$2 AND r.cart_id=$5::uuid
              AND r.returned_cart_line_id=i.source_cart_line_id) k
          ORDER BY k.version DESC LIMIT 1) AS item,
         (SELECT jsonb_build_object('version', s.cart_version_to,
              'remaining', w.origin_quantity - w.quantity)
            FROM rms_ordering.dining_cart_waiting_line w
            JOIN rms_ordering.dining_checkout_scope s ON s.brand_id=w.brand_id
              AND s.store_id=w.store_id AND s.scope_id=w.scope_id
            WHERE w.brand_id=$1 AND w.store_id=$2 AND w.cart_id=$5::uuid
              AND w.origin_cart_line_id=i.source_cart_line_id
            ORDER BY s.cart_version_to DESC LIMIT 1) AS split,
         (SELECT max(v.version) FROM (
            SELECT o.result_aggregate_version AS version
            FROM rms_ordering.cart_operation_record o
            WHERE o.brand_id=$1 AND o.store_id=$2 AND o.cart_id=$5::uuid
              AND o.cart_line_id=i.source_cart_line_id AND o.action_code IN ('Add','Update')
            UNION ALL
            SELECT x.result_aggregate_version FROM rms_ordering.dining_round_cart_return x
            WHERE x.brand_id=$1 AND x.store_id=$2 AND x.cart_id=$5::uuid
              AND i.source_cart_line_id = ANY (x.cart_line_ids)
            UNION ALL
            SELECT r.cart_version FROM rms_ordering.dining_cart_waiting_line_resolution r
            WHERE r.brand_id=$1 AND r.store_id=$2 AND r.cart_id=$5::uuid
              AND r.returned_cart_line_id=i.source_cart_line_id) v) AS item_version
       FROM rms_ordering.order_item i
       WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.order_batch_id=$4
       ORDER BY i.ordinal, i.order_item_id`,
      [brand, store, order, batch, sourceCart],
    ),
  );
  if (items.length === 0 || items.length > 100) return unavailable();
  const lines = items.map((row) => {
    if (row.line === null || row.item === null || typeof row.item !== "object")
      return unavailable();
    const original = parseCartItem(row.item);
    // The payer's choice of dishes split this line after it was last recorded: the round took
    // what stayed (the rest waited and came back on its own line).
    const split = row.split as { version?: unknown; remaining?: unknown } | null;
    const quantity =
      split !== null &&
      typeof split === "object" &&
      Number(split.version) > Number(row.item_version) &&
      Number(split.remaining) >= 1 &&
      Number(split.remaining) < original.quantity
        ? Number(split.remaining)
        : original.quantity;
    if (quantity !== Number(row.quantity)) return unavailable();
    return parseCartItem({
      ...original,
      quantity,
      cartItemReference: parseOrderingReference(input.newLineReference()),
      cartReference,
      addedAt: at,
    });
  });
  const nextVersion = locked.aggregateVersion + 1;
  for (const line of lines)
    if (
      rowsOf(
        await tx.query(
          `INSERT INTO rms_ordering.cart_line
           (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at,customer_note,catalog_selection_evidence_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb) RETURNING cart_line_id`,
          [
            line.cartItemReference,
            cartReference,
            brand,
            store,
            line.sellableReference,
            line.quantity,
            JSON.stringify(line.optionSelections),
            line.addedByActorReference,
            line.addedByParticipantReference,
            line.addedAt,
            line.customerNote,
            JSON.stringify(line.catalogSelectionEvidence),
          ],
        ),
      ).length !== 1
    )
      return unavailable();
  const updated = await tx.query(
    "UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$6",
    [brand, store, cartReference, nextVersion, at, locked.aggregateVersion],
  );
  if ((updated as { rowCount?: unknown }).rowCount !== 1)
    throw new CartError("CART_VERSION_CONFLICT");
  // The cart as the owner reads it: every returned line valid, at the next version.
  const persisted = await createPostgresCartQueryStore(lent(tx), scope).load(cartReference);
  if (
    persisted === null ||
    persisted.aggregateVersion !== nextVersion ||
    persisted.items.length !== locked.items.length + lines.length
  )
    return unavailable();
  const audit = validateAuditRecord(input.audit(cartReference), Date.parse(at));
  if (
    audit.brandId !== brand ||
    audit.storeId !== store ||
    audit.actor.type !== "System" ||
    audit.actionCode !== "ORDERING_ROUND_RETURNED_TO_CART" ||
    audit.targetType !== "OrderingCart" ||
    audit.targetId !== cartReference ||
    audit.sourceChannel !== "CUSTOMER_PWA" ||
    audit.occurredAt !== at
  )
    return unavailable();
  const references = lines.map((line) => String(line.cartItemReference));
  if (
    rowsOf(
      await tx.query(
        `INSERT INTO rms_ordering.dining_round_cart_return
         (order_batch_id,brand_id,store_id,order_id,dining_session_id,cart_id,result_aggregate_version,cart_line_ids,returned_items_json,operation_id,guest_session_id,participant_id,submitted_guest_session_id,occurred_at,audit_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING order_batch_id`,
        [
          batch,
          brand,
          store,
          order,
          session,
          cartReference,
          nextVersion,
          references,
          JSON.stringify(lines),
          operation,
          guest,
          participant,
          submitter,
          at,
          audit.auditId,
        ],
      ),
    ).length !== 1
  )
    return unavailable();
  await appendAuditRecordInTransaction(tx as never, audit);
  return Object.freeze({
    status: "Returned" as const,
    cartReference,
    cartVersion: nextVersion,
    cartItemReferences: Object.freeze(references),
  });
}

/**
 * WP-2423 M38: the round of this table (its number at the table, as the cart's rounds number them)
 * that this phone sent, or null: sent by this Guest Session, or by an earlier Guest Session of the
 * same table participant as Ordering recorded it opening this table's Cart (the rule the cart's
 * rounds use for "sent by this phone"). Read only; the caller then proves it unpaid.
 */
export async function findGuestDiningRound(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly diningSessionReference: string;
    readonly guestSessionReference: string;
    readonly participantReference: string;
    readonly roundNumber: number;
  },
): Promise<{
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** The Guest Session that sent it. */
  readonly submittedGuestSessionReference: string;
  /** Its dishes already came back to the cart (2000_412): nothing more to do. */
  readonly returned: boolean;
} | null> {
  const brand = parseOrderingReference(scopeInput.brandReference);
  const store = parseOrderingReference(scopeInput.storeReference);
  if (!Number.isSafeInteger(input.roundNumber) || input.roundNumber < 1 || input.roundNumber > 999)
    throw new CartError("CART_INPUT_INVALID");
  await tx.query(
    "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
    [brand, store],
  );
  const rows = rowsOf(
    await tx.query(
      `SELECT r.order_id::text AS "order", r.order_batch_id::text AS batch,
         r.guest_session_id::text AS submitter,
         EXISTS (SELECT 1 FROM rms_ordering.dining_round_cart_return x
           WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_batch_id=r.order_batch_id) AS returned
       FROM (SELECT b.order_id, b.order_batch_id, s.guest_session_id,
               row_number() OVER (PARTITION BY b.order_id ORDER BY b.submitted_at, b.order_batch_id)
                 AS round_number
             FROM rms_ordering.order_batch b
             JOIN rms_ordering.order_submission_record s ON s.submission_id=b.submission_id
               AND s.brand_id=b.brand_id AND s.store_id=b.store_id
             WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id IN (
               SELECT o.order_id FROM rms_ordering.order_batch o
               JOIN rms_ordering.cart c ON c.cart_id=o.source_cart_id AND c.brand_id=o.brand_id
                 AND c.store_id=o.store_id AND c.order_type='DineIn'
               WHERE o.brand_id=$1 AND o.store_id=$2 AND c.dining_session_id=$3)) r
       WHERE r.round_number=$5 AND (r.guest_session_id=$4 OR EXISTS (
         SELECT 1 FROM rms_ordering.dining_cart_operation o
         WHERE o.brand_id=$1 AND o.store_id=$2 AND o.dining_session_id=$3
           AND o.guest_session_id=r.guest_session_id AND o.participant_id=$6))
       LIMIT 2`,
      [
        brand,
        store,
        parseOrderingReference(input.diningSessionReference),
        parseOrderingReference(input.guestSessionReference),
        input.roundNumber,
        parseOrderingReference(input.participantReference),
      ],
    ),
  );
  if (rows.length > 1) return unavailable();
  const row = rows[0];
  return row === undefined
    ? null
    : Object.freeze({
        orderReference: String(parseOrderingReference(row.order)),
        orderBatchReference: String(parseOrderingReference(row.batch)),
        submittedGuestSessionReference: String(parseOrderingReference(row.submitter)),
        returned: row.returned === true,
      });
}
