import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingReference } from "../../domain/cart.js";
import {
  parseCartQuoteExpiryRecord,
  sameCartQuoteExpiryIntent,
  type CartQuoteExpiryRecord,
} from "../../domain/cart-quote-expiry.js";
import type { CartQuoteAttachment } from "../../domain/cart-quote-attachment.js";
import { createPostgresCartQuoteStore } from "./cart-quote-store.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";

export type CartQuoteExpiryResult = Readonly<
  | { status: "Expired"; record: CartQuoteExpiryRecord }
  | { status: "AlreadyAttached"; attachment: CartQuoteAttachment }
>;
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function conflict(): never {
  throw new CartError("CART_IDEMPOTENCY_CONFLICT");
}
function rows(value: unknown): unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    return fail();
  return value.rows;
}
const select = `SELECT jsonb_build_object(
 'resolutionVersion',resolution_version,'operationReference',operation_id,'brandReference',brand_id,
 'storeReference',store_id,'cartReference',cart_id,'guestSessionReference',guest_session_id,
 'quoteReference',quote_id,'cartVersion',cart_version,'quoteInputDigest',quote_input_digest,
 'requestIntentDigest',request_intent_digest,
 'quoteCreatedAt',to_char(quote_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'quoteExpiresAt',to_char(quote_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'requestCreatedAt',to_char(request_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'requestExpiresAt',to_char(request_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'expiredAt',to_char(expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS record
 FROM rms_ordering.cart_quote_expiry_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;

// Infrastructure capability: current Session/CSRF/binding authorization and original Pricing
// evidence are mandatory caller duties. No Pricing-private access or authorization is implied.
export function createPostgresCartQuoteExpiryStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const rawScope = readClosedRecord(
    scope,
    ["brandReference", "storeReference"],
    "ACTOR_SHAPE_INVALID",
  );
  const brand = parseOrderingReference(rawScope.brandReference);
  const store = parseOrderingReference(rawScope.storeReference);
  const ownedScope = Object.freeze({ brandReference: brand, storeReference: store });
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>): Promise<T> {
    return runner.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      return action(tx);
    });
  }
  async function resolve(tx: CartQueryTransaction, operation: string) {
    const found = rows(await tx.query(select, [brand, store, operation]));
    if (found.length === 0) return null;
    if (found.length !== 1) return fail();
    const record = parseCartQuoteExpiryRecord(
      readClosedRecord(found[0], ["record"], "ACTOR_SHAPE_INVALID").record,
    );
    if (
      record.brandReference !== brand ||
      record.storeReference !== store ||
      record.operationReference !== operation
    )
      return fail();
    return record;
  }
  return Object.freeze({
    async resolveOperation(value: string): Promise<CartQuoteExpiryRecord | null> {
      try {
        const operation = parseOrderingReference(value);
        return await run((tx) => resolve(tx, operation));
      } catch {
        return fail();
      }
    },
    async expire(value: {
      readonly record: CartQuoteExpiryRecord;
      readonly audit: unknown;
    }): Promise<CartQuoteExpiryResult> {
      try {
        const input = readClosedRecord(value, ["record", "audit"], "ACTOR_SHAPE_INVALID");
        const next = parseCartQuoteExpiryRecord(input.record);
        if (next.brandReference !== brand || next.storeReference !== store) return fail();
        const rawAudit = readClosedRecord(
          input.audit,
          [
            "auditId",
            "brandId",
            "storeId",
            "actor",
            "actionCode",
            "reasonCode",
            "targetType",
            "targetId",
            "occurredAt",
            "correlationId",
            "sourceChannel",
            "dataClassification",
            "retentionPolicyCode",
            "retentionPolicyVersion",
          ],
          "ACTOR_SHAPE_INVALID",
        );
        const actor = readClosedRecord(rawAudit.actor, ["type"], "ACTOR_SHAPE_INVALID");
        const audit = validateAuditRecord(
          { ...rawAudit, actor: { ...actor } },
          Date.parse(next.expiredAt),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_CART_QUOTE_EXPIRE" ||
          audit.reasonCode !== "QUOTE_VALIDITY_ENDED" ||
          audit.targetType !== "OrderingCart" ||
          audit.targetId !== next.cartReference ||
          audit.occurredAt !== next.expiredAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        return await run(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `ordering.quote.operation:${brand}:${store}:${next.operationReference}`,
          ]);
          const locked = rows(
            await tx.query(
              "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
              [brand, store, next.cartReference],
            ),
          );
          if (
            locked.length !== 1 ||
            readClosedRecord(locked[0], ["cart_id"], "ACTOR_SHAPE_INVALID").cart_id !==
              next.cartReference
          )
            return fail();
          const borrowed = {
            run: async <T>(action: (current: CartQueryTransaction) => Promise<T>) => action(tx),
          };
          const cart = await createPostgresCartQueryStore(borrowed, ownedScope).load(
            next.cartReference,
          );
          if (
            cart === null ||
            cart.orderType !== "Pickup" ||
            cart.diningSessionReference !== null ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            cart.createdByActorReference !== next.guestSessionReference ||
            cart.aggregateVersion < next.cartVersion ||
            cart.updatedAt > next.expiredAt
          )
            return fail();
          const priorAttachment = await createPostgresCartQuoteStore(borrowed, ownedScope, {
            hashIntent: () => fail(),
            equals: (a, b) => a === b,
          }).resolveOperation(next.operationReference);
          if (priorAttachment !== null) {
            for (const field of [
              "cartReference",
              "cartVersion",
              "guestSessionReference",
              "quoteReference",
              "quoteInputDigest",
              "quoteCreatedAt",
              "quoteExpiresAt",
            ] as const)
              if (priorAttachment[field] !== next[field]) return conflict();
            return Object.freeze({ status: "AlreadyAttached", attachment: priorAttachment });
          }
          const prior = await resolve(tx, next.operationReference);
          if (prior !== null) {
            if (!sameCartQuoteExpiryIntent(prior, next) || next.expiredAt < prior.expiredAt)
              return conflict();
            return Object.freeze({ status: "Expired", record: prior });
          }
          const inserted = rows(
            await tx.query(
              `INSERT INTO rms_ordering.cart_quote_expiry_record
 (brand_id,store_id,operation_id,cart_id,guest_session_id,quote_id,resolution_version,cart_version,quote_input_digest,request_intent_digest,quote_created_at,quote_expires_at,request_created_at,request_expires_at,expired_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING operation_id`,
              [
                brand,
                store,
                next.operationReference,
                next.cartReference,
                next.guestSessionReference,
                next.quoteReference,
                1,
                next.cartVersion,
                next.quoteInputDigest,
                next.requestIntentDigest,
                next.quoteCreatedAt,
                next.quoteExpiresAt,
                next.requestCreatedAt,
                next.requestExpiresAt,
                next.expiredAt,
              ],
            ),
          );
          if (
            inserted.length !== 1 ||
            readClosedRecord(inserted[0], ["operation_id"], "ACTOR_SHAPE_INVALID").operation_id !==
              next.operationReference
          )
            return fail();
          const persisted = await resolve(tx, next.operationReference);
          if (
            persisted === null ||
            !sameCartQuoteExpiryIntent(persisted, next) ||
            persisted.expiredAt !== next.expiredAt
          )
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Expired", record: persisted });
        });
      } catch (error) {
        if (error instanceof CartError && error.code === "CART_IDEMPOTENCY_CONFLICT") throw error;
        return fail();
      }
    },
  });
}
