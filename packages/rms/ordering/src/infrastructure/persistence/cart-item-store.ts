import { parseCartItemPresentationSnapshot } from "../../application/cart-item-presentation-snapshot.js";
import { appendAuditRecordInTransaction, type AppendAuditRecordInput } from "@bop/audit";
import type {
  CartItemCommandPorts,
  CartItemOperationRecord,
} from "../../application/ports/cart-item-command-ports.js";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { advanceCartLifecycle, assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import {
  decodeCartAggregateRow,
  type CustomerCartDatabaseRunner,
  type CustomerCartDatabaseTransaction,
} from "./customer-cart-store.js";

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
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assertRecord(record: CartItemOperationRecord, brand: string, store: string) {
  const cart = parseCartAggregate(record.result);
  if (record.presentationSnapshot !== undefined)
    parseCartItemPresentationSnapshot(record.presentationSnapshot, cart);
  parseOrderingReference(record.operationReference);
  parseOrderingReference(record.guestSessionReference);
  parseOrderingReference(record.cartItemReference);
  parseOrderingHash(record.operationIntentHash);
  parseOrderingInstant(record.occurredAt);
  parseOrderingInstant(record.expiresAt);
  if (
    !["Add", "Update", "Remove"].includes(record.action) ||
    cart.brandReference !== brand ||
    cart.storeReference !== store ||
    cart.cartReference !== record.cartReference ||
    cart.aggregateVersion < 2 ||
    cart.updatedAt !== record.occurredAt ||
    Date.parse(record.expiresAt) - Date.parse(record.occurredAt) !== 86_400_000 ||
    (record.action === "Remove"
      ? cart.items.some((item) => item.cartItemReference === record.cartItemReference)
      : !cart.items.some((item) => item.cartItemReference === record.cartItemReference))
  )
    return unavailable();
  return cart;
}
function assertAudit(audit: AppendAuditRecordInput, record: CartItemOperationRecord) {
  if (
    audit.brandId !== record.result.brandReference ||
    audit.storeId !== record.result.storeReference ||
    audit.targetId !== record.cartReference ||
    audit.targetType !== "OrderingCart" ||
    audit.actionCode !== `ORDERING_CART_ITEM_${record.action.toUpperCase()}` ||
    audit.occurredAt !== record.occurredAt ||
    audit.actor.type !== "System" ||
    audit.reasonCode !== "AUTHORIZED_CART_MUTATION" ||
    audit.sourceChannel !== "CUSTOMER_PWA" ||
    audit.dataClassification !== "Restricted" ||
    audit.beforeSummary !== undefined ||
    audit.afterSummary !== undefined
  )
    return unavailable();
}
function assertTransition(current: CartAggregate, record: CartItemOperationRecord) {
  const next = record.result;
  if (Date.parse(record.occurredAt) < Date.parse(current.updatedAt)) return unavailable();
  assertCartLifecycleActive(current.lifecycle, record.occurredAt);
  const oldItem = current.items.find((item) => item.cartItemReference === record.cartItemReference);
  const newItem = next.items.find((item) => item.cartItemReference === record.cartItemReference);
  if (record.action === "Add") {
    if (
      oldItem !== undefined ||
      newItem === undefined ||
      newItem.addedByActorReference !== record.guestSessionReference ||
      newItem.addedAt !== record.occurredAt ||
      (current.orderType === "DineIn"
        ? newItem.addedByParticipantReference === null
        : newItem.addedByParticipantReference !== null)
    )
      return unavailable();
  } else if (oldItem === undefined) return unavailable();
  if (
    current.orderType === "Pickup" &&
    current.createdByActorReference !== record.guestSessionReference
  )
    return unavailable();
  if (record.action !== "Remove") {
    if (newItem?.catalogSelectionEvidence?.validatedAt !== record.occurredAt) return unavailable();
    if (
      record.action === "Update" &&
      oldItem !== undefined &&
      newItem !== undefined &&
      !same(newItem, {
        ...oldItem,
        quantity: newItem.quantity,
        optionSelections: newItem.optionSelections,
        customerNote: newItem.customerNote,
        catalogSelectionEvidence: newItem.catalogSelectionEvidence,
      })
    )
      return unavailable();
  }
  const items =
    record.action === "Add"
      ? [...current.items, newItem]
      : record.action === "Remove"
        ? current.items.filter((item) => item.cartItemReference !== record.cartItemReference)
        : current.items.map((item) =>
            item.cartItemReference === record.cartItemReference ? newItem : item,
          );
  const expected = parseCartAggregate({
    ...current,
    aggregateVersion: current.aggregateVersion + 1,
    updatedAt: record.occurredAt,
    lifecycle: advanceCartLifecycle(current.lifecycle, record.occurredAt),
    items,
  });
  if (!same(expected, next)) return unavailable();
}

/** Opt-in Ordering-owned persistence. Authorization and Catalog validation precede this boundary. */
export function createPostgresCartItemStore(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly runner: CustomerCartDatabaseRunner;
  readonly requireUnquotedPresentation?: boolean;
}): CartItemCommandPorts["repository"] {
  const brand = parseOrderingReference(input.brandReference);
  const store = parseOrderingReference(input.storeReference);
  const runner = input.runner;
  const requireUnquotedPresentation = input.requireUnquotedPresentation === true;
  async function run<T>(action: (tx: CustomerCartDatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(action);
    } catch (error) {
      if (
        error instanceof CartError &&
        ["CART_VERSION_CONFLICT", "CART_IDEMPOTENCY_CONFLICT"].includes(error.code)
      )
        throw error;
      return unavailable();
    }
  }
  async function load(tx: CustomerCartDatabaseTransaction, cartReference: string) {
    parseOrderingReference(cartReference);
    const result = rows(
      await tx.query(
        `SELECT to_jsonb(c) AS cart FROM rms_ordering.cart c
      WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 FOR UPDATE`,
        [brand, store, cartReference],
      ),
    );
    if (result.length === 0) return null;
    if (result.length !== 1) return unavailable();
    // The Cart lock must precede the line snapshot, including for standalone loads.
    const lines = rows(
      await tx.query(
        `SELECT to_jsonb(l) AS line FROM rms_ordering.cart_line l
      WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 ORDER BY added_at, cart_line_id LIMIT 101`,
        [brand, store, cartReference],
      ),
    );
    const cart = decodeCartAggregateRow({ ...result[0], lines: lines.map((line) => line.line) });
    if (
      cart.brandReference !== brand ||
      cart.storeReference !== store ||
      cart.cartReference !== cartReference
    )
      return unavailable();
    return cart;
  }
  async function resolve(tx: CustomerCartDatabaseTransaction, operationReference: string) {
    parseOrderingReference(operationReference);
    const result = rows(
      await tx.query(
        `SELECT to_jsonb(r) AS record FROM rms_ordering.cart_operation_record r
      WHERE brand_id = $1 AND store_id = $2 AND operation_id = $3`,
        [brand, store, operationReference],
      ),
    );
    if (result.length === 0) return null;
    if (result.length !== 1) return unavailable();
    const row = object(result[0]?.record);
    const rawSnapshot = row.result_presentation_snapshot_json;
    const envelope =
      rawSnapshot != null && Object.hasOwn(object(rawSnapshot), "snapshot")
        ? object(rawSnapshot)
        : null;
    if (
      envelope !== null &&
      (Object.keys(envelope).length !== 3 ||
        envelope.schemaVersion !== 1 ||
        envelope.quoteStatus !== "None")
    )
      return unavailable();
    const snapshot = envelope === null ? rawSnapshot : envelope.snapshot;
    if (envelope !== null && snapshot == null) return unavailable();
    const record: CartItemOperationRecord = Object.freeze({
      action: row.action_code as CartItemOperationRecord["action"],
      operationReference: parseOrderingReference(row.operation_id),
      operationIntentHash: parseOrderingHash(row.intent_digest),
      guestSessionReference: parseOrderingReference(row.guest_session_id),
      cartReference: parseOrderingReference(row.cart_id),
      cartItemReference: parseOrderingReference(row.cart_line_id),
      result: parseCartAggregate(row.result_cart_snapshot_json),
      ...(snapshot == null
        ? {}
        : {
            presentationSnapshot: parseCartItemPresentationSnapshot(
              snapshot,
              parseCartAggregate(row.result_cart_snapshot_json),
            ),
          }),
      ...(envelope === null ? {} : { quoteAbsenceVerified: true as const }),
      occurredAt: instant(row.occurred_at),
      expiresAt: instant(row.expires_at),
    });
    const cart = assertRecord(record, brand, store);
    if (
      row.brand_id !== brand ||
      row.store_id !== store ||
      record.operationReference !== operationReference ||
      row.result_aggregate_version !== cart.aggregateVersion
    )
      return unavailable();
    return record;
  }
  return Object.freeze({
    ...(requireUnquotedPresentation ? { unquotedPresentation: true as const } : {}),
    load: (reference) => run((tx) => load(tx, reference)),
    resolveOperation: (reference) => run((tx) => resolve(tx, reference)),
    commit: (command) =>
      run(async (tx) => {
        const record = command.record;
        if (record.quoteAbsenceVerified !== undefined) return unavailable();
        const next = assertRecord(record, brand, store);
        assertAudit(command.audit, record);
        if (
          !Number.isSafeInteger(command.expectedAggregateVersion) ||
          command.expectedAggregateVersion < 1 ||
          next.aggregateVersion !== command.expectedAggregateVersion + 1
        )
          return unavailable();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(["ordering-cart-item-operation", brand, store, record.operationReference]),
        ]);
        // The service reconciles a controlled conflict with the now-durable original result.
        // Do not return the losing candidate's generated Item reference or observation time.
        if ((await resolve(tx, record.operationReference)) !== null)
          throw new CartError("CART_IDEMPOTENCY_CONFLICT");
        const current = await load(tx, record.cartReference);
        if (current === null) return unavailable();
        if (current.aggregateVersion !== command.expectedAggregateVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        assertTransition(current, record);
        if (requireUnquotedPresentation) {
          if (record.presentationSnapshot === undefined || current.orderType !== "Pickup")
            return unavailable();
          const attachments = rows(
            await tx.query(
              `SELECT operation_id FROM rms_ordering.cart_quote_attachment WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 LIMIT 1`,
              [brand, store, record.cartReference],
            ),
          );
          if (attachments.length !== 0) return unavailable();
        }
        // Identity-protection rules prohibit UPDATE RETURNING; verify the affected-row count.
        const changed = object(
          await tx.query(
            `UPDATE rms_ordering.cart SET aggregate_version = $4,
        updated_at = $5, idle_expires_at = $6 WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3
        AND aggregate_version = $7`,
            [
              brand,
              store,
              record.cartReference,
              next.aggregateVersion,
              next.updatedAt,
              next.lifecycle?.idleExpiresAt,
              command.expectedAggregateVersion,
            ],
          ),
        );
        if (changed.rowCount !== 1) throw new CartError("CART_VERSION_CONFLICT");
        const item = next.items.find(
          (candidate) => candidate.cartItemReference === record.cartItemReference,
        );
        let mutation;
        if (record.action === "Add" && item !== undefined) {
          mutation = await tx.query(
            `INSERT INTO rms_ordering.cart_line
          (brand_id,store_id,cart_id,cart_line_id,sellable_id,quantity,option_selections_json,customer_note,
           catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12)`,
            [
              brand,
              store,
              record.cartReference,
              item.cartItemReference,
              item.sellableReference,
              item.quantity,
              JSON.stringify(item.optionSelections),
              item.customerNote,
              JSON.stringify(item.catalogSelectionEvidence),
              item.addedByActorReference,
              item.addedByParticipantReference,
              item.addedAt,
            ],
          );
        } else if (record.action === "Update" && item !== undefined) {
          mutation = await tx.query(
            `UPDATE rms_ordering.cart_line SET quantity = $5, option_selections_json = $6::jsonb,
          customer_note = $7, catalog_selection_evidence_json = $8::jsonb
          WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 AND cart_line_id = $4`,
            [
              brand,
              store,
              record.cartReference,
              item.cartItemReference,
              item.quantity,
              JSON.stringify(item.optionSelections),
              item.customerNote,
              JSON.stringify(item.catalogSelectionEvidence),
            ],
          );
        } else {
          mutation = await tx.query(
            `DELETE FROM rms_ordering.cart_line
          WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 AND cart_line_id = $4`,
            [brand, store, record.cartReference, record.cartItemReference],
          );
        }
        if (object(mutation).rowCount !== 1) return unavailable();
        await tx.query(
          `INSERT INTO rms_ordering.cart_operation_record
        (brand_id,store_id,operation_id,cart_id,cart_line_id,guest_session_id,action_code,intent_digest,
         result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at,result_presentation_snapshot_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`,
          [
            brand,
            store,
            record.operationReference,
            record.cartReference,
            record.cartItemReference,
            record.guestSessionReference,
            record.action,
            record.operationIntentHash,
            next.aggregateVersion,
            JSON.stringify(next),
            record.occurredAt,
            record.expiresAt,
            record.presentationSnapshot === undefined
              ? null
              : JSON.stringify(
                  requireUnquotedPresentation
                    ? {
                        schemaVersion: 1,
                        quoteStatus: "None",
                        snapshot: parseCartItemPresentationSnapshot(
                          record.presentationSnapshot,
                          next,
                        ),
                      }
                    : parseCartItemPresentationSnapshot(record.presentationSnapshot, next),
                ),
          ],
        );
        await appendAuditRecordInTransaction(tx, command.audit);
        return Object.freeze({
          ...record,
          ...(requireUnquotedPresentation ? { quoteAbsenceVerified: true as const } : {}),
        });
      }),
  });
}
