import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type { CartQuoteAttachmentPorts } from "../../application/ports/cart-quote-attachment-ports.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../../domain/cart-quote-attachment.js";
import {
  CartError,
  parseOrderingReference,
  parseOrderingInstant,
  type CartAggregate,
} from "../../domain/cart.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import {
  decodeCartAggregateRow,
  type CustomerCartDatabaseRunner,
  type CustomerCartDatabaseTransaction,
} from "./customer-cart-store.js";

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  const result = object(value).rows;
  if (!Array.isArray(result)) return unavailable();
  return result.map(object);
}
function instant(value: unknown) {
  if (typeof value !== "string") return unavailable();
  return parseOrderingInstant(new Date(value).toISOString());
}
function minor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return unavailable();
  return BigInt(value);
}
function same(left: unknown, right: unknown) {
  const stringify = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  return stringify(left) === stringify(right);
}
function normalize(value: CartQuoteAttachment, brand: string, store: string) {
  const a = parseCartQuoteAttachment(value);
  if (
    a.brandReference !== brand ||
    a.storeReference !== store ||
    a.lines.length === 0 ||
    [a.subtotal, a.discount, a.tax, a.fee, a.total].some((amount) => amount.amountMinor < 0n) ||
    a.total.amountMinor !==
      a.subtotal.amountMinor - a.discount.amountMinor + a.tax.amountMinor + a.fee.amountMinor
  )
    return unavailable();
  // Evidence is a set keyed by immutable line reference; SQL has no source-array ordinal.
  return parseCartQuoteAttachment({
    ...a,
    lines: [...a.lines].sort((x, y) =>
      x.lineReference < y.lineReference ? -1 : x.lineReference > y.lineReference ? 1 : 0,
    ),
  });
}
function audit(input: AppendAuditRecordInput, a: CartQuoteAttachment) {
  const value = validateAuditRecord(input, Date.parse(a.attachedAt));
  if (
    value.brandId !== a.brandReference ||
    value.storeId !== a.storeReference ||
    value.targetId !== a.cartReference ||
    value.targetType !== "OrderingCart" ||
    value.actor.type !== "System" ||
    value.actionCode !== "ORDERING_CART_ATTACH_QUOTE" ||
    value.occurredAt !== a.attachedAt ||
    value.reasonCode !== "AUTHORIZED_CART_QUOTE" ||
    value.sourceChannel !== "CUSTOMER_PWA" ||
    value.dataClassification !== "Restricted" ||
    value.beforeSummary !== undefined ||
    value.afterSummary !== undefined
  )
    return unavailable();
}
function validateCart(cart: CartAggregate, a: CartQuoteAttachment) {
  assertCartLifecycleActive(cart.lifecycle, a.attachedAt);
  if (
    Date.parse(a.attachedAt) < Date.parse(cart.updatedAt) ||
    !["Qr", "Web"].includes(cart.sourceChannel) ||
    (cart.orderType === "Pickup" && cart.createdByActorReference !== a.guestSessionReference) ||
    cart.items.length !== a.lines.length
  )
    return unavailable();
  for (const item of cart.items) {
    const line = a.lines.find((value) => value.lineReference === item.cartItemReference);
    if (
      line === undefined ||
      item.catalogSelectionEvidence === null ||
      line.sellableReference !== item.sellableReference ||
      line.quantity !== item.quantity ||
      line.productVersionReference !== item.catalogSelectionEvidence.productVersionReference ||
      line.menuVersionReference !== item.catalogSelectionEvidence.menuVersionReference
    )
      return unavailable();
  }
}

/** Optional Ordering-owned attachment storage; Pricing and authorization use public service ports. */
export function createPostgresCartQuoteAttachmentStore(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly runner: CustomerCartDatabaseRunner;
}): CartQuoteAttachmentPorts["repository"] {
  const brand = parseOrderingReference(input.brandReference);
  const store = parseOrderingReference(input.storeReference);
  async function run<T>(action: (tx: CustomerCartDatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await input.runner.run(action);
    } catch (error) {
      if (
        error instanceof CartError &&
        [
          "CART_VERSION_CONFLICT",
          "CART_IDEMPOTENCY_CONFLICT",
          "CART_EXPIRED",
          "CART_ABANDONED",
          "CART_LIFECYCLE_UNAVAILABLE",
        ].includes(error.code)
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
  async function resolve(tx: CustomerCartDatabaseTransaction, reference: string) {
    parseOrderingReference(reference);
    // Cast inside PostgreSQL, before JSON decoding can round a bigint into a JS number.
    const headers = rows(
      await tx.query(
        `SELECT to_jsonb(q) || jsonb_build_object('subtotal_minor',q.subtotal_minor::text,'discount_minor',q.discount_minor::text,'tax_minor',q.tax_minor::text,'fee_minor',q.fee_minor::text,'total_minor',q.total_minor::text) AS attachment FROM rms_ordering.cart_quote_attachment q WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`,
        [brand, store, reference],
      ),
    );
    if (headers.length === 0) return null;
    if (headers.length !== 1) return unavailable();
    const h = object(headers[0]?.attachment);
    const lines = rows(
      await tx.query(
        `SELECT to_jsonb(l) AS line FROM rms_ordering.cart_quote_attachment_line l WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 AND cart_id=$4 ORDER BY cart_line_id LIMIT 101`,
        [brand, store, reference, h.cart_id],
      ),
    );
    const money = (field: string) => ({
      amountMinor: minor(h[field]),
      currencyCode: h.currency_code,
    });
    const a = normalize(
      parseCartQuoteAttachment({
        operationReference: h.operation_id,
        operationIntentHash: h.intent_digest,
        guestSessionReference: h.guest_session_id,
        cartReference: h.cart_id,
        brandReference: h.brand_id,
        storeReference: h.store_id,
        cartVersion: h.cart_version,
        quoteReference: h.quote_id,
        quoteVersion: h.quote_version,
        quoteInputDigest: h.quote_input_digest,
        currencyCode: h.currency_code,
        currencyMetadataVersion: h.currency_metadata_version,
        currencyMetadataVersionReference: h.currency_metadata_version_id,
        subtotal: money("subtotal_minor"),
        discount: money("discount_minor"),
        tax: money("tax_minor"),
        fee: money("fee_minor"),
        total: money("total_minor"),
        lines: lines.map((value) => {
          const l = object(value.line);
          if (
            l.brand_id !== brand ||
            l.store_id !== store ||
            l.operation_id !== reference ||
            l.cart_id !== h.cart_id
          )
            return unavailable();
          return {
            lineReference: l.cart_line_id,
            sellableReference: l.sellable_id,
            productVersionReference: l.product_version_id,
            menuVersionReference: l.menu_version_id,
            quantity: l.quantity,
          };
        }),
        warnings: h.warnings_json,
        quoteCreatedAt: instant(h.quote_created_at),
        quoteExpiresAt: instant(h.quote_expires_at),
        attachedAt: instant(h.attached_at),
        idempotencyExpiresAt: instant(h.idempotency_expires_at),
      }),
      brand,
      store,
    );
    if (a.operationReference !== reference || a.lines.length !== h.line_count) return unavailable();
    return a;
  }
  return Object.freeze({
    loadCart: (reference) => run((tx) => load(tx, reference)),
    resolveOperation: (reference) => run((tx) => resolve(tx, reference)),
    attach: (command) =>
      run(async (tx) => {
        const a = normalize(command.attachment, brand, store);
        audit(command.audit, a);
        if (
          !Number.isSafeInteger(command.expectedCartVersion) ||
          command.expectedCartVersion < 1 ||
          command.expectedCartVersion !== a.cartVersion
        )
          return unavailable();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(["ordering-cart-quote-operation", brand, store, a.operationReference]),
        ]);
        const prior = await resolve(tx, a.operationReference);
        if (prior !== null) {
          if (!same(prior, a)) throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        const cart = await load(tx, a.cartReference);
        if (cart === null) return unavailable();
        if (cart.aggregateVersion !== command.expectedCartVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        validateCart(cart, a);
        const inserted = object(
          await tx.query(
            `INSERT INTO rms_ordering.cart_quote_attachment (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,quote_id,quote_version,quote_input_digest,currency_code,currency_metadata_version,currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24)`,
            [
              a.operationReference,
              brand,
              store,
              a.cartReference,
              a.cartVersion,
              a.guestSessionReference,
              a.operationIntentHash,
              a.quoteReference,
              a.quoteVersion,
              a.quoteInputDigest,
              a.currencyCode,
              a.currencyMetadataVersion,
              a.currencyMetadataVersionReference,
              a.subtotal.amountMinor.toString(),
              a.discount.amountMinor.toString(),
              a.tax.amountMinor.toString(),
              a.fee.amountMinor.toString(),
              a.total.amountMinor.toString(),
              a.lines.length,
              JSON.stringify(a.warnings),
              a.quoteCreatedAt,
              a.quoteExpiresAt,
              a.attachedAt,
              a.idempotencyExpiresAt,
            ],
          ),
        );
        if (inserted.rowCount !== 1) return unavailable();
        for (const l of a.lines) {
          const insertedLine = object(
            await tx.query(
              `INSERT INTO rms_ordering.cart_quote_attachment_line (operation_id,brand_id,store_id,cart_id,cart_line_id,sellable_id,product_version_id,menu_version_id,quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                a.operationReference,
                brand,
                store,
                a.cartReference,
                l.lineReference,
                l.sellableReference,
                l.productVersionReference,
                l.menuVersionReference,
                l.quantity,
              ],
            ),
          );
          if (insertedLine.rowCount !== 1) return unavailable();
        }
        await appendAuditRecordInTransaction(tx, command.audit);
        return a;
      }),
  });
}
