import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  parsePricingDigest,
  parsePricingReference,
  type PricingDigest,
} from "../../domain/money-tax-contract.js";
import type { PriceQuoteSnapshot } from "../../domain/price-quote.js";
import {
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
} from "../../domain/price-quote-snapshot-codec.js";
import {
  assertPriceQuoteRequestReplay,
  parsePriceQuoteRequestIdentity,
  parsePriceQuoteRequestRecord,
  priceQuoteRequestIntent,
  PriceQuoteRequestError,
  type PriceQuoteRequestIdentity,
  type PriceQuoteRequestRecord,
} from "../../domain/price-quote-request.js";
import {
  createPostgresPriceQuoteHistoryReader,
  type PriceQuoteQueryTransaction,
  type PriceQuoteQueryTransactionRunner,
} from "./price-quote-query-store.js";
import { createPostgresPriceQuoteStore } from "./price-quote-store.js";
export interface PriceQuoteRequestResult {
  readonly record: PriceQuoteRequestRecord;
  readonly quote: PriceQuoteSnapshot;
}
export interface PriceQuoteRequestLookup {
  readonly operationReference: string;
  readonly guestSessionReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly observedAt: string;
}
export interface PriceQuoteRequestStore {
  resolve(input: PriceQuoteRequestLookup): Promise<PriceQuoteRequestResult | null>;
  append(input: {
    readonly operationReference: string;
    readonly guestSessionReference: string;
    readonly observedAt: string;
    readonly quote: PriceQuoteSnapshot;
    readonly audit: AppendAuditRecordInput;
  }): Promise<PriceQuoteRequestResult>;
}
function fail(): never {
  throw new PriceQuoteRequestError("QUOTE_REQUEST_UNAVAILABLE");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value);
  const ds = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    fail();
  return Object.fromEntries(
    fields.map((k) => {
      const d = ds[k];
      if (d === undefined || !("value" in d) || !d.enumerable) fail();
      return [k, d.value];
    }),
  );
}
function rows(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (d === undefined || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) fail();
  if (d.value.length === 0) return [];
  const first = Object.getOwnPropertyDescriptor(d.value, "0");
  if (first === undefined || !("value" in first)) fail();
  return [first.value];
}
function failure(error: unknown): never {
  if (error instanceof PriceQuoteRequestError && error.code === "QUOTE_REQUEST_CONFLICT")
    throw error;
  return fail();
}
const select = `SELECT jsonb_build_object('operationReference',operation_id,'brandReference',brand_id,
 'storeReference',store_id,'guestSessionReference',guest_session_id,'cartReference',cart_id,'cartVersion',cart_version,
 'recordVersion',record_version,'intentDigest',intent_digest,'quoteReference',quote_id,'quoteOutcome',quote_outcome,
 'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'idempotencyExpiresAt',to_char(idempotency_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS record
 FROM rms_pricing.price_quote_request WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;
const insert = `INSERT INTO rms_pricing.price_quote_request
 (operation_id,brand_id,store_id,guest_session_id,cart_id,cart_version,record_version,intent_digest,quote_id,quote_outcome,created_at,idempotency_expires_at)
 VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11) RETURNING operation_id AS reference`;
/** Owner-scoped history only. Caller must authorize the current Session before lookup or append. */
export function createPostgresPriceQuoteRequestStore(
  runner: PriceQuoteQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  references: {
    generateReference(): string;
    hashIntent(value: string): string;
    equals(left: PricingDigest, right: PricingDigest): boolean;
  },
): PriceQuoteRequestStore {
  let brand: string;
  let store: string;
  try {
    const raw = closed(scope, ["brandReference", "storeReference"]);
    brand = parsePricingReference(raw.brandReference);
    store = parsePricingReference(raw.storeReference);
  } catch {
    return fail();
  }
  const ownedScope = Object.freeze({ brandReference: brand, storeReference: store });
  const digest = (identity: PriceQuoteRequestIdentity) =>
    parsePricingDigest(references.hashIntent(priceQuoteRequestIntent(identity)));
  const context = (tx: PriceQuoteQueryTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  async function resolve(
    tx: PriceQuoteQueryTransaction,
    identity: PriceQuoteRequestIdentity,
    observedAt: string,
  ): Promise<PriceQuoteRequestResult | null> {
    const result = rows(await tx.query(select, [brand, store, identity.operationReference]));
    if (result.length === 0) return null;
    const record = parsePriceQuoteRequestRecord(closed(result[0], ["record"]).record);
    assertPriceQuoteRequestReplay(record, identity, observedAt);
    if (!references.equals(record.intentDigest, digest(identity))) fail();
    const quote = await createPostgresPriceQuoteHistoryReader(
      { run: async (action) => action(tx) },
      ownedScope,
    ).load(record.quoteReference);
    if (
      quote === null ||
      quote.brandReference !== brand ||
      quote.storeReference !== store ||
      quote.cartReference !== record.cartReference ||
      quote.cartVersion !== record.cartVersion ||
      record.createdAt < quote.createdAt ||
      record.createdAt >= quote.expiresAt
    )
      fail();
    return Object.freeze({ record, quote });
  }
  return Object.freeze({
    async resolve(input: PriceQuoteRequestLookup) {
      try {
        const raw = closed(input, [
          "operationReference",
          "guestSessionReference",
          "cartReference",
          "cartVersion",
          "observedAt",
        ]);
        const observedAt = parseCanonicalInstant(raw.observedAt);
        const identity = parsePriceQuoteRequestIdentity({
          ...ownedScope,
          operationReference: raw.operationReference,
          guestSessionReference: raw.guestSessionReference,
          cartReference: raw.cartReference,
          cartVersion: raw.cartVersion,
        });
        return await runner.run(async (tx) => {
          await context(tx);
          return resolve(tx, identity, observedAt);
        });
      } catch (error) {
        return failure(error);
      }
    },
    async append(input: Parameters<PriceQuoteRequestStore["append"]>[0]) {
      try {
        const raw = closed(input, [
          "operationReference",
          "guestSessionReference",
          "observedAt",
          "quote",
          "audit",
        ]);
        const observedAt = parseCanonicalInstant(raw.observedAt);
        const quote = decodePriceQuoteSnapshot(
          encodePriceQuoteSnapshot(raw.quote as PriceQuoteSnapshot),
        );
        if (quote.brandReference !== brand || quote.storeReference !== store) fail();
        const identity = parsePriceQuoteRequestIdentity({
          ...ownedScope,
          operationReference: raw.operationReference,
          guestSessionReference: raw.guestSessionReference,
          cartReference: quote.cartReference,
          cartVersion: quote.cartVersion,
        });
        const auditRaw = closed(raw.audit, [
          "auditId",
          "brandId",
          "storeId",
          "actor",
          "actionCode",
          "targetType",
          "targetId",
          "reasonCode",
          "correlationId",
          "occurredAt",
          "sourceChannel",
          "dataClassification",
          "retentionPolicyCode",
          "retentionPolicyVersion",
        ]);
        if (
          closed(auditRaw.actor, ["type"]).type !== "System" ||
          Object.entries(auditRaw).some(
            ([key, value]) =>
              key !== "actor" &&
              (key === "retentionPolicyVersion"
                ? typeof value !== "number"
                : typeof value !== "string"),
          )
        )
          fail();
        const audit = validateAuditRecord(
          Object.freeze({ ...auditRaw, actor: Object.freeze({ type: "System" }) }),
          Date.parse(quote.createdAt),
        );
        const intentDigest = digest(identity);
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `pricing.quote.request:${brand}:${store}:${identity.operationReference}`,
          ]);
          const prior = await resolve(tx, identity, observedAt);
          if (prior !== null) return prior;
          if (observedAt < quote.createdAt || observedAt >= quote.expiresAt) fail();
          const borrowed: PriceQuoteQueryTransactionRunner = { run: async (action) => action(tx) };
          const persisted = await createPostgresPriceQuoteStore(
            borrowed,
            ownedScope,
            references,
          ).append({ quote, audit });
          const record = parsePriceQuoteRequestRecord({
            ...identity,
            recordVersion: 1,
            intentDigest,
            quoteReference: persisted.quote.quoteReference,
            quoteOutcome: persisted.status,
            createdAt: observedAt,
            idempotencyExpiresAt: new Date(
              Date.parse(observedAt) + 24 * 60 * 60 * 1000,
            ).toISOString(),
          });
          const result = rows(
            await tx.query(insert, [
              record.operationReference,
              brand,
              store,
              record.guestSessionReference,
              record.cartReference,
              record.cartVersion,
              record.intentDigest,
              record.quoteReference,
              record.quoteOutcome,
              record.createdAt,
              record.idempotencyExpiresAt,
            ]),
          );
          if (
            result.length !== 1 ||
            closed(result[0], ["reference"]).reference !== record.operationReference
          )
            fail();
          const confirmed = await resolve(tx, identity, observedAt);
          if (confirmed === null || JSON.stringify(confirmed.record) !== JSON.stringify(record))
            fail();
          return confirmed;
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
