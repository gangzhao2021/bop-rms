import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { CartQuoteAttachmentPorts } from "../../application/ports/cart-quote-attachment-ports.js";
import {
  CartError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
} from "../../domain/cart.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../../domain/cart-quote-attachment.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";
type Attach = Parameters<CartQuoteAttachmentPorts["repository"]["attach"]>[0];
export interface CartQuoteStore {
  loadLatest(input: {
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly observedAt: string;
  }): Promise<CartQuoteAttachment | null>;
  resolveOperation(reference: string): Promise<CartQuoteAttachment | null>;
  attach(input: Attach): Promise<CartQuoteAttachment>;
}
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, fields: readonly string[]) {
  return readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
}
function rows(value: unknown): unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    fail();
  return value.rows;
}
const moneyFields = ["subtotal", "discount", "tax", "fee", "total"] as const;
function decode(value: unknown) {
  const raw = closed(value, [
    "operationReference",
    "operationIntentHash",
    "guestSessionReference",
    "cartReference",
    "brandReference",
    "storeReference",
    "cartVersion",
    "quoteReference",
    "quoteVersion",
    "quoteInputDigest",
    "currencyCode",
    "currencyMetadataVersion",
    "currencyMetadataVersionReference",
    ...moneyFields,
    "lines",
    "warnings",
    "quoteCreatedAt",
    "quoteExpiresAt",
    "attachedAt",
    "idempotencyExpiresAt",
  ]);
  const decoded = { ...raw };
  for (const field of moneyFields) {
    const amount = closed(raw[field], ["amountMinor", "currencyCode"]);
    if (
      typeof amount.amountMinor !== "string" ||
      !/^(?:0|[1-9][0-9]{0,18})$/u.test(amount.amountMinor)
    )
      fail();
    decoded[field] = { amountMinor: BigInt(amount.amountMinor), currencyCode: amount.currencyCode };
  }
  return parseCartQuoteAttachment(decoded);
}
function canonical(value: CartQuoteAttachment) {
  return JSON.stringify(
    {
      ...value,
      lines: [...value.lines].sort((a, b) => a.lineReference.localeCompare(b.lineReference)),
    },
    (_key, field: unknown) => (typeof field === "bigint" ? field.toString() : field),
  );
}
const select = `SELECT jsonb_build_object(
 'operationReference',a.operation_id,'operationIntentHash',a.intent_digest,'guestSessionReference',a.guest_session_id,
 'cartReference',a.cart_id,'brandReference',a.brand_id,'storeReference',a.store_id,'cartVersion',a.cart_version,
 'quoteReference',a.quote_id,'quoteVersion',a.quote_version,'quoteInputDigest',a.quote_input_digest,
 'currencyCode',a.currency_code,'currencyMetadataVersion',a.currency_metadata_version,'currencyMetadataVersionReference',a.currency_metadata_version_id,
 'subtotal',jsonb_build_object('amountMinor',a.subtotal_minor::text,'currencyCode',a.currency_code),
 'discount',jsonb_build_object('amountMinor',a.discount_minor::text,'currencyCode',a.currency_code),
 'tax',jsonb_build_object('amountMinor',a.tax_minor::text,'currencyCode',a.currency_code),
 'fee',jsonb_build_object('amountMinor',a.fee_minor::text,'currencyCode',a.currency_code),
 'total',jsonb_build_object('amountMinor',a.total_minor::text,'currencyCode',a.currency_code),
 'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('lineReference',l.cart_line_id,'sellableReference',l.sellable_id,
 'productVersionReference',l.product_version_id,'menuVersionReference',l.menu_version_id,'quantity',l.quantity) ORDER BY l.cart_line_id)
 FROM rms_ordering.cart_quote_attachment_line l WHERE l.brand_id=$1 AND l.store_id=$2 AND l.cart_id=a.cart_id AND l.operation_id=a.operation_id),'[]'::jsonb),
 'warnings',a.warnings_json,
 'quoteCreatedAt',to_char(a.quote_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'quoteExpiresAt',to_char(a.quote_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attachedAt',to_char(a.attached_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'idempotencyExpiresAt',to_char(a.idempotency_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS attachment,
 a.line_count AS "lineCount"
 FROM rms_ordering.cart_quote_attachment a WHERE a.brand_id=$1 AND a.store_id=$2 AND a.operation_id=$3`;

// Infrastructure only. Current Session/Participant authorization and authoritative Pricing evidence
// are service duties. This scoped adapter owns one transaction and no Pricing-private access.
export function createPostgresCartQuoteStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  references: CartQuoteAttachmentPorts["references"],
): CartQuoteStore {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  function inScope(value: CartQuoteAttachment) {
    if (
      value.brandReference !== brand ||
      value.storeReference !== store ||
      value.lines.length === 0
    )
      fail();
  }
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>): Promise<T> {
    return runner.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      return action(tx);
    });
  }
  async function resolve(tx: CartQueryTransaction, reference: string) {
    const result = rows(await tx.query(select, [brand, store, reference]));
    if (result.length === 0) return null;
    if (result.length !== 1) fail();
    const raw = closed(result[0], ["attachment", "lineCount"]);
    const attachment = decode(raw.attachment);
    inScope(attachment);
    if (attachment.operationReference !== reference || attachment.lines.length !== raw.lineCount)
      fail();
    return attachment;
  }
  return Object.freeze({
    async loadLatest(input: Parameters<CartQuoteStore["loadLatest"]>[0]) {
      try {
        const raw = closed(input, ["cartReference", "cartVersion", "observedAt"]);
        const cartReference = parseOrderingReference(raw.cartReference);
        const observedAt = parseOrderingInstant(raw.observedAt);
        const cartVersion = raw.cartVersion;
        if (!Number.isSafeInteger(cartVersion) || Number(cartVersion) < 1) fail();
        return await run(async (tx) => {
          const result = rows(
            await tx.query(
              "SELECT operation_id FROM rms_ordering.cart_quote_attachment WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_version=$4 AND attached_at<=$5 ORDER BY attached_at DESC, operation_id DESC LIMIT 1",
              [brand, store, cartReference, cartVersion, observedAt],
            ),
          );
          if (result.length === 0) return null;
          if (result.length !== 1) fail();
          const operation = parseOrderingReference(
            closed(result[0], ["operation_id"]).operation_id,
          );
          const attachment = await resolve(tx, operation);
          if (
            attachment === null ||
            attachment.cartReference !== cartReference ||
            attachment.cartVersion !== cartVersion ||
            attachment.attachedAt > observedAt
          )
            fail();
          return attachment;
        });
      } catch {
        return fail();
      }
    },
    async resolveOperation(value: string) {
      try {
        const reference = parseOrderingReference(value);
        return await run((tx) => resolve(tx, reference));
      } catch {
        return fail();
      }
    },
    async attach(value: Attach) {
      try {
        const input = closed(value, ["attachment", "expectedCartVersion", "audit"]);
        const next = parseCartQuoteAttachment(input.attachment);
        inScope(next);
        const expectedCartVersion = input.expectedCartVersion;
        if (
          typeof expectedCartVersion !== "number" ||
          !Number.isSafeInteger(expectedCartVersion) ||
          expectedCartVersion < 1 ||
          next.cartVersion !== expectedCartVersion
        )
          fail();
        const intentAt = (requestedAt: string) =>
          parseOrderingHash(
            references.hashIntent(
              `AttachQuote:${JSON.stringify({
                cartReference: next.cartReference,
                expectedCartVersion,
                operationReference: next.operationReference,
                requestedAt,
              })}`,
            ),
          );
        if (!references.equals(next.operationIntentHash, intentAt(next.attachedAt))) fail();
        const audit = validateAuditRecord(input.audit, Date.parse(next.attachedAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_CART_ATTACH_QUOTE" ||
          audit.targetType !== "OrderingCart" ||
          audit.targetId !== next.cartReference ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined ||
          audit.reasonCode !== "AUTHORIZED_CART_QUOTE" ||
          audit.occurredAt !== next.attachedAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          fail();
        return await run(async (tx) => {
          if (
            rows(
              await tx.query(
                "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
                [brand, store, next.cartReference],
              ),
            ).length !== 1
          )
            fail();
          const prior = await resolve(tx, next.operationReference);
          if (prior !== null) {
            if (
              prior.cartReference !== next.cartReference ||
              prior.cartVersion !== expectedCartVersion ||
              prior.guestSessionReference !== next.guestSessionReference ||
              Date.parse(next.attachedAt) >= Date.parse(prior.idempotencyExpiresAt) ||
              !references.equals(prior.operationIntentHash, intentAt(prior.attachedAt))
            )
              throw new CartError("CART_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          const cart = await createPostgresCartQueryStore(
            {
              run: async <T>(action: (borrowed: CartQueryTransaction) => Promise<T>) => action(tx),
            },
            { brandReference: brand, storeReference: store },
          ).load(next.cartReference);
          if (cart === null) fail();
          if (cart.aggregateVersion !== expectedCartVersion)
            throw new CartError("CART_VERSION_CONFLICT");
          assertCartLifecycleActive(cart.lifecycle, next.attachedAt);
          if (
            Date.parse(next.attachedAt) < Date.parse(cart.updatedAt) ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            (cart.orderType === "Pickup" &&
              cart.createdByActorReference !== next.guestSessionReference) ||
            cart.items.length !== next.lines.length
          )
            fail();
          for (const item of cart.items) {
            const line = next.lines.find(
              (candidate) => candidate.lineReference === item.cartItemReference,
            );
            if (
              line === undefined ||
              item.catalogSelectionEvidence === null ||
              line.quantity !== item.quantity ||
              line.sellableReference !== item.sellableReference ||
              line.productVersionReference !==
                item.catalogSelectionEvidence.productVersionReference ||
              line.menuVersionReference !== item.catalogSelectionEvidence.menuVersionReference
            )
              fail();
          }
          if (
            rows(
              await tx.query(
                `INSERT INTO rms_ordering.cart_quote_attachment
            (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,quote_id,quote_version,quote_input_digest,
             currency_code,currency_metadata_version,currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,line_count,warnings_json,
             quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING operation_id`,
                [
                  next.operationReference,
                  brand,
                  store,
                  next.cartReference,
                  next.cartVersion,
                  next.guestSessionReference,
                  next.operationIntentHash,
                  next.quoteReference,
                  next.quoteVersion,
                  next.quoteInputDigest,
                  next.currencyCode,
                  next.currencyMetadataVersion,
                  next.currencyMetadataVersionReference,
                  ...moneyFields.map((field) => next[field].amountMinor.toString()),
                  next.lines.length,
                  JSON.stringify(next.warnings),
                  next.quoteCreatedAt,
                  next.quoteExpiresAt,
                  next.attachedAt,
                  next.idempotencyExpiresAt,
                ],
              ),
            ).length !== 1
          )
            fail();
          for (const line of next.lines) {
            if (
              rows(
                await tx.query(
                  `INSERT INTO rms_ordering.cart_quote_attachment_line
              (operation_id,brand_id,store_id,cart_id,cart_line_id,sellable_id,product_version_id,menu_version_id,quantity)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING cart_line_id`,
                  [
                    next.operationReference,
                    brand,
                    store,
                    next.cartReference,
                    line.lineReference,
                    line.sellableReference,
                    line.productVersionReference,
                    line.menuVersionReference,
                    line.quantity,
                  ],
                ),
              ).length !== 1
            )
              fail();
          }
          const persisted = await resolve(tx, next.operationReference);
          if (persisted === null || canonical(persisted) !== canonical(next)) fail();
          await appendAuditRecordInTransaction(tx, audit);
          return persisted;
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
