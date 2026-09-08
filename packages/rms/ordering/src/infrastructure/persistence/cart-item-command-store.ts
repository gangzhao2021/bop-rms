import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
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
import { advanceCartLifecycle } from "../../domain/cart-lifecycle.js";
import { createPostgresCartQueryStore, type CartQueryTransaction } from "./cart-query-store.js";
import { createPostgresCartItemOperationStore } from "./cart-item-operation-store.js";

export interface CartItemWriteTransactionRunner {
  // Own a bounded transaction: commit on success, rollback on every failure, release connection/context.
  run<T>(action: (transaction: CartQueryTransaction) => Promise<T>): Promise<T>;
}
type CommitInput = Parameters<CartItemCommandPorts["repository"]["commit"]>[0];
export interface CartItemCommandStore {
  commit(input: CommitInput): Promise<CartItemOperationRecord>;
}
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function one(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== 1
  )
    fail();
}
function changed(value: unknown) {
  if (value === null || typeof value !== "object" || !("rowCount" in value) || value.rowCount !== 1)
    fail();
}
function canonical(cart: CartAggregate) {
  return JSON.stringify({
    ...cart,
    items: [...cart.items].sort((a, b) => a.cartItemReference.localeCompare(b.cartItemReference)),
  });
}
function record(input: CartItemOperationRecord): CartItemOperationRecord {
  const result = parseCartAggregate(input.result);
  const occurredAt = parseOrderingInstant(input.occurredAt);
  const expiresAt = parseOrderingInstant(input.expiresAt);
  const cartReference = parseOrderingReference(input.cartReference);
  if (
    !["Add", "Update", "Remove"].includes(input.action) ||
    result.cartReference !== cartReference ||
    result.updatedAt !== occurredAt ||
    Date.parse(expiresAt) - Date.parse(occurredAt) !== 86_400_000
  )
    fail();
  return Object.freeze({
    action: input.action,
    operationReference: parseOrderingReference(input.operationReference),
    operationIntentHash: parseOrderingHash(input.operationIntentHash),
    guestSessionReference: parseOrderingReference(input.guestSessionReference),
    cartReference,
    cartItemReference: parseOrderingReference(input.cartItemReference),
    result,
    occurredAt,
    expiresAt,
  });
}
function transition(current: CartAggregate, next: CartItemOperationRecord) {
  const target = next.cartItemReference;
  const before = current.items.find((item) => item.cartItemReference === target);
  const after = next.result.items.find((item) => item.cartItemReference === target);
  if (Date.parse(next.occurredAt) < Date.parse(current.updatedAt)) fail();
  if (next.action === "Add") {
    if (
      before !== undefined ||
      after === undefined ||
      after.addedByActorReference !== next.guestSessionReference ||
      after.addedAt !== next.occurredAt
    )
      fail();
  } else {
    if (before === undefined) fail();
    if (next.action === "Remove") {
      if (after !== undefined) fail();
    } else if (
      after === undefined ||
      before.sellableReference !== after.sellableReference ||
      before.addedAt !== after.addedAt ||
      before.addedByActorReference !== after.addedByActorReference ||
      before.addedByParticipantReference !== after.addedByParticipantReference
    )
      fail();
  }
  if (
    current.orderType === "Pickup" &&
    current.createdByActorReference !== next.guestSessionReference
  )
    fail();
  const items =
    next.action === "Add" && after !== undefined
      ? [...current.items, after]
      : next.action === "Remove"
        ? current.items.filter((item) => item.cartItemReference !== target)
        : current.items.map((item) =>
            item.cartItemReference === target && after !== undefined ? after : item,
          );
  const expected = parseCartAggregate({
    ...current,
    aggregateVersion: current.aggregateVersion + 1,
    updatedAt: next.occurredAt,
    lifecycle: advanceCartLifecycle(current.lifecycle, next.occurredAt),
    items,
  });
  if (canonical(expected) !== canonical(next.result)) fail();
  return after;
}

// Preserve WP-2225's historical encoding while comparing concurrent intent at the winner's time.
function businessIntent(next: CartItemOperationRecord, version: number, at: string) {
  const cartReference = next.cartReference;
  const cartItemReference = next.cartItemReference;
  const operationReference = next.operationReference;
  const requestedAt = at;
  const item = next.result.items.find(
    (candidate) => candidate.cartItemReference === cartItemReference,
  );
  if (next.action !== "Remove" && item === undefined) fail();
  const content =
    next.action === "Add"
      ? {
          cartReference,
          expectedAggregateVersion: version,
          sellableReference: item?.sellableReference,
          quantity: item?.quantity,
          optionSelections: item?.optionSelections,
          customerNote: item?.customerNote,
          operationReference,
          requestedAt,
        }
      : next.action === "Update"
        ? {
            cartReference,
            cartItemReference,
            expectedAggregateVersion: version,
            quantity: item?.quantity,
            optionSelections: item?.optionSelections,
            customerNote: item?.customerNote,
            operationReference,
            requestedAt,
          }
        : {
            cartReference,
            cartItemReference,
            expectedAggregateVersion: version,
            operationReference,
            requestedAt,
          };
  return next.action + ":" + JSON.stringify(content);
}

// Infrastructure only: the command service must first authorize Session/Participant, Catalog and intent.
export function createPostgresCartItemCommandStore(
  runner: CartItemWriteTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  references: Pick<CartItemCommandPorts["references"], "hashIntent" | "equals">,
): CartItemCommandStore {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async commit(input: CommitInput) {
      try {
        const next = record(input.record);
        const version = input.expectedAggregateVersion;
        if (
          !Number.isSafeInteger(version) ||
          version < 1 ||
          next.result.aggregateVersion !== version + 1
        )
          fail();
        if (next.result.brandReference !== brand || next.result.storeReference !== store) fail();
        const intentAt = (at: string) =>
          parseOrderingHash(references.hashIntent(businessIntent(next, version, at)));
        if (!references.equals(next.operationIntentHash, intentAt(next.occurredAt))) fail();
        const audit = validateAuditRecord(input.audit, Date.parse(next.occurredAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== `ORDERING_CART_ITEM_${next.action.toUpperCase()}` ||
          audit.targetType !== "OrderingCart" ||
          audit.targetId !== next.cartReference ||
          audit.reasonCode !== "AUTHORIZED_CART_MUTATION" ||
          audit.occurredAt !== next.occurredAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          fail();
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          one(
            await transaction.query(
              "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
              [brand, store, next.cartReference],
            ),
          );
          // Both readers borrow this transaction; neither starts or commits a nested transaction.
          const borrowed = {
            run: async <T>(action: (tx: CartQueryTransaction) => Promise<T>) => action(transaction),
          };
          const prior = await createPostgresCartItemOperationStore(borrowed, {
            brandReference: brand,
            storeReference: store,
          }).resolveOperation(next.operationReference);
          if (prior !== null) {
            if (
              prior.action !== next.action ||
              prior.cartReference !== next.cartReference ||
              prior.guestSessionReference !== next.guestSessionReference ||
              prior.result.aggregateVersion !== next.result.aggregateVersion ||
              Date.parse(next.occurredAt) >= Date.parse(prior.expiresAt) ||
              !references.equals(prior.operationIntentHash, intentAt(prior.occurredAt))
            )
              throw new CartError("CART_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          const current = await createPostgresCartQueryStore(borrowed, {
            brandReference: brand,
            storeReference: store,
          }).load(next.cartReference);
          if (current === null) fail();
          if (current.aggregateVersion !== version) throw new CartError("CART_VERSION_CONFLICT");
          const item = transition(current, next);
          changed(
            await transaction.query(
              `UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5, idle_expires_at=$6
            WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$7`,
              [
                brand,
                store,
                next.cartReference,
                next.result.aggregateVersion,
                next.occurredAt,
                next.result.lifecycle?.idleExpiresAt,
                version,
              ],
            ),
          );
          if (next.action === "Add" && item !== undefined) {
            one(
              await transaction.query(
                `INSERT INTO rms_ordering.cart_line
              (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at,customer_note,catalog_selection_evidence_json)
              VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb) RETURNING cart_line_id`,
                [
                  item.cartItemReference,
                  next.cartReference,
                  brand,
                  store,
                  item.sellableReference,
                  item.quantity,
                  JSON.stringify(item.optionSelections),
                  item.addedByActorReference,
                  item.addedByParticipantReference,
                  item.addedAt,
                  item.customerNote,
                  JSON.stringify(item.catalogSelectionEvidence),
                ],
              ),
            );
          } else if (next.action === "Update" && item !== undefined) {
            changed(
              await transaction.query(
                `UPDATE rms_ordering.cart_line SET quantity=$5, option_selections_json=$6::jsonb, customer_note=$7, catalog_selection_evidence_json=$8::jsonb
              WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_line_id=$4`,
                [
                  brand,
                  store,
                  next.cartReference,
                  next.cartItemReference,
                  item.quantity,
                  JSON.stringify(item.optionSelections),
                  item.customerNote,
                  JSON.stringify(item.catalogSelectionEvidence),
                ],
              ),
            );
          } else {
            one(
              await transaction.query(
                "DELETE FROM rms_ordering.cart_line WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_line_id=$4 RETURNING cart_line_id",
                [brand, store, next.cartReference, next.cartItemReference],
              ),
            );
          }
          const persisted = await createPostgresCartQueryStore(borrowed, {
            brandReference: brand,
            storeReference: store,
          }).load(next.cartReference);
          if (persisted === null || canonical(persisted) !== canonical(next.result)) fail();
          one(
            await transaction.query(
              `INSERT INTO rms_ordering.cart_operation_record
            (operation_id,brand_id,store_id,cart_id,cart_line_id,guest_session_id,action_code,intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING operation_id`,
              [
                next.operationReference,
                brand,
                store,
                next.cartReference,
                next.cartItemReference,
                next.guestSessionReference,
                next.action,
                next.operationIntentHash,
                next.result.aggregateVersion,
                JSON.stringify(next.result),
                next.occurredAt,
                next.expiresAt,
              ],
            ),
          );
          await appendAuditRecordInTransaction(transaction, audit);
          return next;
        });
      } catch (error) {
        if (
          error instanceof CartError &&
          ["CART_VERSION_CONFLICT", "CART_IDEMPOTENCY_CONFLICT"].includes(error.code)
        )
          throw error;
        return fail();
      }
    },
  });
}
