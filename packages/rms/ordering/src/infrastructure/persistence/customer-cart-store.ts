import { appendAuditRecordInTransaction, type AppendAuditRecordInput } from "@bop/audit";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import type {
  CustomerCartCreationRecord,
  CustomerCartOwner,
  CustomerCartPorts,
} from "../../application/ports/customer-cart-ports.js";

export interface CustomerCartDatabaseTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface CustomerCartDatabaseRunner {
  run<T>(action: (transaction: CustomerCartDatabaseTransaction) => Promise<T>): Promise<T>;
}
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
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function instant(value: unknown) {
  if (typeof value !== "string") return unavailable();
  return parseOrderingInstant(new Date(value).toISOString());
}
function aggregate(row: Record<string, unknown>): CartAggregate {
  const c = object(row.cart);
  if (!Array.isArray(row.lines)) return unavailable();
  return parseCartAggregate({
    cartReference: c.cart_id,
    brandReference: c.brand_id,
    storeReference: c.store_id,
    orderType: c.order_type,
    sourceChannel: c.source_channel,
    diningSessionReference: c.dining_session_id,
    createdByActorReference: c.created_by_actor_id,
    aggregateVersion: c.aggregate_version,
    createdAt: instant(c.created_at),
    updatedAt: instant(c.updated_at),
    lifecycle:
      c.lifecycle_status === "Legacy"
        ? null
        : {
            status: c.lifecycle_status,
            policyVersionReference: c.lifecycle_policy_version_id,
            policyDigest: c.lifecycle_policy_digest,
            idleTimeoutSeconds: c.idle_timeout_seconds,
            absoluteTimeoutSeconds: c.absolute_timeout_seconds,
            idleExpiresAt: instant(c.idle_expires_at),
            absoluteExpiresAt: instant(c.absolute_expires_at),
            terminalAt: c.terminal_at === null ? null : instant(c.terminal_at),
            terminalReason: c.terminal_reason,
          },
    items: row.lines.map((value: unknown) => {
      const line = object(value);
      return {
        cartItemReference: line.cart_line_id,
        cartReference: line.cart_id,
        sellableReference: line.sellable_id,
        quantity: line.quantity,
        optionSelections: line.option_selections_json,
        customerNote: line.customer_note,
        catalogSelectionEvidence: line.catalog_selection_evidence_json,
        addedByActorReference: line.added_by_actor_id,
        addedByParticipantReference: line.added_by_participant_id,
        addedAt: instant(line.added_at),
      };
    }),
  });
}
function matches(cart: CartAggregate, owner: CustomerCartOwner) {
  return (
    cart.brandReference === owner.brandReference &&
    cart.storeReference === owner.storeReference &&
    cart.orderType === owner.orderType &&
    ["Qr", "Web"].includes(cart.sourceChannel) &&
    (owner.orderType === "Pickup"
      ? cart.createdByActorReference === owner.ownerReference
      : cart.diningSessionReference === owner.ownerReference)
  );
}
const currentSql = `SELECT to_jsonb(c) AS cart
FROM rms_ordering.cart_customer_owner o JOIN rms_ordering.cart c
  ON c.cart_id = o.cart_id AND c.brand_id = o.brand_id AND c.store_id = o.store_id
WHERE o.brand_id = $1 AND o.store_id = $2 AND o.order_type = $3 AND o.owner_id = $4
FOR UPDATE OF c`;
const insertCart = `INSERT INTO rms_ordering.cart (
 cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,
 aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,
 idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at,terminal_at,terminal_reason)
 VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8,'Active',$9,$10,$11,$12,$13,$14,NULL,NULL) RETURNING cart_id`;

export function createPostgresCustomerCartStore(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly runner: CustomerCartDatabaseRunner;
}): CustomerCartPorts["repository"] {
  const brand = parseOrderingReference(input.brandReference);
  const store = parseOrderingReference(input.storeReference);
  const runner = input.runner;
  return Object.freeze({
    async run(owner, operationReference, action) {
      try {
        if (
          owner.brandReference !== brand ||
          owner.storeReference !== store ||
          !["Pickup", "DineIn"].includes(owner.orderType)
        )
          return unavailable();
        parseOrderingReference(owner.ownerReference);
        if (operationReference !== null) parseOrderingReference(operationReference);
        const scope = [brand, store, owner.orderType, owner.ownerReference];
        return await runner.run(async (tx) => {
          // Consistent operation-then-owner order; collisions only serialize unrelated requests.
          if (operationReference !== null)
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
              JSON.stringify(["ordering-cart-operation", brand, store, operationReference]),
            ]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            JSON.stringify(["ordering-cart-owner", ...scope]),
          ]);
          let active = true;
          let committed = false;
          let current: CartAggregate | null | undefined;
          async function load() {
            if (!active) return unavailable();
            const result = rows(await tx.query(currentSql, scope));
            if (result.length > 1) return unavailable();
            if (result.length === 1) {
              const row = result[0] ?? unavailable();
              const cartId = parseOrderingReference(object(row.cart).cart_id);
              // A separate statement after the Cart lock avoids READ COMMITTED mixed snapshots.
              const lines = rows(
                await tx.query(
                  `SELECT to_jsonb(l) AS line FROM rms_ordering.cart_line l
                WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 ORDER BY added_at, cart_line_id LIMIT 101`,
                  [brand, store, cartId],
                ),
              );
              const cart = aggregate({ ...row, lines: lines.map((line) => line.line) });
              if (!matches(cart, owner)) return unavailable();
              current = cart;
              return cart;
            }
            const legacy = rows(
              await tx.query(
                `SELECT cart_id FROM rms_ordering.cart
              WHERE brand_id = $1 AND store_id = $2 AND order_type = $3
              AND (($3 = 'Pickup' AND created_by_actor_id = $4) OR ($3 = 'DineIn' AND dining_session_id = $4)) LIMIT 1`,
                scope,
              ),
            );
            if (legacy.length !== 0) throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
            current = null;
            return null;
          }
          try {
            return await action(
              Object.freeze({
                async resolveOperation(
                  reference: CustomerCartCreationRecord["operationReference"],
                ) {
                  if (!active || reference !== operationReference) return unavailable();
                  const result = rows(
                    await tx.query(
                      `SELECT to_jsonb(r) AS record FROM rms_ordering.cart_creation_operation r WHERE brand_id = $1 AND store_id = $2 AND operation_id = $3`,
                      [brand, store, reference],
                    ),
                  );
                  if (result.length > 1) return unavailable();
                  if (result.length === 0) return null;
                  const r = object((result[0] ?? unavailable()).record);
                  const saved = parseCartAggregate(r.result_json);
                  if (
                    r.cart_id !== saved.cartReference ||
                    r.brand_id !== brand ||
                    r.store_id !== store
                  )
                    return unavailable();
                  const record: CustomerCartCreationRecord = Object.freeze({
                    operationReference: parseOrderingReference(r.operation_id),
                    operationIntentHash: parseOrderingHash(r.operation_intent_hash),
                    guestSessionReference: parseOrderingReference(r.guest_session_id),
                    owner: Object.freeze({
                      brandReference: brand,
                      storeReference: store,
                      orderType: r.order_type as "Pickup" | "DineIn",
                      ownerReference: parseOrderingReference(r.owner_id),
                    }),
                    outcome: r.outcome as "Created" | "Current",
                    aggregate: saved,
                    occurredAt: instant(r.occurred_at),
                    expiresAt: instant(r.expires_at),
                  });
                  if (!matches(saved, record.owner)) return unavailable();
                  return record;
                },
                loadCurrent: load,
                async commit(record: CustomerCartCreationRecord, audit: AppendAuditRecordInput) {
                  if (
                    !active ||
                    committed ||
                    operationReference === null ||
                    record.operationReference !== operationReference ||
                    current === undefined ||
                    record.owner.brandReference !== brand ||
                    record.owner.storeReference !== store ||
                    record.owner.orderType !== owner.orderType ||
                    record.owner.ownerReference !== owner.ownerReference
                  )
                    return unavailable();
                  if (
                    audit.brandId !== brand ||
                    audit.storeId !== store ||
                    audit.targetId !== record.aggregate.cartReference ||
                    audit.targetType !== "OrderingCart" ||
                    audit.actionCode !== "ORDERING_CART_CREATE" ||
                    audit.occurredAt !== record.occurredAt ||
                    audit.actor.type !== "System" ||
                    audit.reasonCode !== "AUTHORIZED_CART_MUTATION" ||
                    audit.sourceChannel !== "CUSTOMER_PWA" ||
                    audit.dataClassification !== "Restricted" ||
                    audit.beforeSummary !== undefined ||
                    audit.afterSummary !== undefined
                  )
                    return unavailable();
                  const c = parseCartAggregate(record.aggregate);
                  if (!matches(c, owner) || (record.outcome === "Created") !== (current === null))
                    return unavailable();
                  if (current !== null && JSON.stringify(c) !== JSON.stringify(current))
                    return unavailable();
                  if (current === null) {
                    const l = c.lifecycle;
                    if (
                      l === null ||
                      l.status !== "Active" ||
                      c.items.length !== 0 ||
                      c.aggregateVersion !== 1 ||
                      c.createdAt !== c.updatedAt ||
                      c.createdAt !== record.occurredAt ||
                      c.createdByActorReference !== record.guestSessionReference
                    )
                      return unavailable();
                    const inserted = rows(
                      await tx.query(insertCart, [
                        c.cartReference,
                        brand,
                        store,
                        c.orderType,
                        c.sourceChannel,
                        c.diningSessionReference,
                        c.createdByActorReference,
                        c.createdAt,
                        l.policyVersionReference,
                        l.policyDigest,
                        l.idleTimeoutSeconds,
                        l.absoluteTimeoutSeconds,
                        l.idleExpiresAt,
                        l.absoluteExpiresAt,
                      ]),
                    );
                    if (
                      inserted.length !== 1 ||
                      (inserted[0] ?? unavailable()).cart_id !== c.cartReference
                    )
                      return unavailable();
                    await tx.query(
                      `INSERT INTO rms_ordering.cart_customer_owner (brand_id,store_id,order_type,owner_id,cart_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
                      [...scope, c.cartReference, c.createdAt],
                    );
                  }
                  await tx.query(
                    `INSERT INTO rms_ordering.cart_creation_operation
                  (brand_id,store_id,operation_id,operation_intent_hash,guest_session_id,order_type,owner_id,cart_id,outcome,result_json,occurred_at,expires_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
                    [
                      brand,
                      store,
                      record.operationReference,
                      record.operationIntentHash,
                      record.guestSessionReference,
                      owner.orderType,
                      owner.ownerReference,
                      c.cartReference,
                      record.outcome,
                      JSON.stringify(c),
                      record.occurredAt,
                      record.expiresAt,
                    ],
                  );
                  await appendAuditRecordInTransaction(tx, audit);
                  committed = true;
                },
              }),
            );
          } finally {
            active = false;
          }
        });
      } catch (error) {
        if (error instanceof CartError) throw error;
        return unavailable();
      }
    },
  });
}
