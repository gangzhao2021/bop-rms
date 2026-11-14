import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference } from "../../contracts/product.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationWarningAcknowledgementReceipt,
  type CatalogProductPublicationWarningAcknowledgementReceipt,
} from "../../contracts/product-publication-warning-acknowledgement.js";
import { catalogProductPublicationWarningAcknowledgementEventId } from "../../contracts/product-publication-warning-acknowledgement-event.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const fail = (
  code:
    | "CATALOG_DEPENDENCY_UNAVAILABLE"
    | "CATALOG_IDEMPOTENCY_CONFLICT" = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function rows(value: unknown): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!d || !("value" in d)) return fail();
  const array: unknown = d.value;
  if (
    !Array.isArray(array) ||
    Object.getPrototypeOf(array) !== Array.prototype ||
    array.length > 1 ||
    Reflect.ownKeys(array).length !== array.length + 1
  )
    return fail();
  if (array.length === 0) return [];
  const item = Object.getOwnPropertyDescriptor(array, "0");
  if (!item?.enumerable || !("value" in item)) return fail();
  return [item.value];
}
function port(tx: ProductLifecycleTransaction) {
  if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
  const original = tx.query,
    query = original.bind(tx);
  return {
    query,
    check() {
      if (tx.query !== original) return fail();
    },
  };
}
const metadataKeys = [
  "operationReference",
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "actorReference",
  "expectedProductAggregateVersion",
  "acknowledgementSequence",
  "reportOperationReference",
  "reportDigest",
  "warningBindingDigest",
  "originalIntentDigest",
  "receiptDigest",
  "occurredAt",
  "recordedAt",
  "eventId",
  "auditId",
  "dataClassification",
] as const;
const select = `SELECT CASE WHEN octet_length(receipt_json::text)<=2097152 THEN receipt_json ELSE NULL END receipt,
 octet_length(receipt_json::text)<=2097152 bounded,
 jsonb_build_object('operationReference',operation_id,'tenantReference',tenant_id,'brandReference',brand_id,
 'productReference',product_id,'versionReference',product_version_id,'actorReference',actor_id,
 'expectedProductAggregateVersion',expected_product_aggregate_version,'acknowledgementSequence',acknowledgement_sequence,
 'reportOperationReference',report_operation_id,'reportDigest',report_digest,'warningBindingDigest',warning_binding_digest,
 'originalIntentDigest',intent_digest,'receiptDigest',receipt_digest,
 'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'eventId',event_id,'auditId',audit_id,'dataClassification',data_classification) metadata
 FROM rms_catalog.product_publication_warning_acknowledgement WHERE tenant_id=$1 AND brand_id=$2`;
function decode(value: unknown): CatalogProductPublicationWarningAcknowledgementReceipt {
  const raw = closed(value, ["receipt", "bounded", "metadata"]);
  if (raw.bounded !== true) return fail();
  // Parse the receipt independently: do not duplicate its full details into a
  // shared wrapper budget or canonicalize arbitrary SQL getters/toJSON hooks.
  const receipt = parseCatalogProductPublicationWarningAcknowledgementReceipt(raw.receipt),
    c = receipt.command,
    metadata = closed(raw.metadata, metadataKeys),
    sequence = metadata.acknowledgementSequence;
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > 2147483647
  )
    return fail();
  parseCatalogReference(metadata.auditId);
  const expected = {
    operationReference: c.operationReference,
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    productReference: c.productReference,
    versionReference: c.versionReference,
    actorReference: c.actorReference,
    expectedProductAggregateVersion: c.expectedProductAggregateVersion,
    reportOperationReference: c.reportOperationReference,
    reportDigest: c.reportDigest,
    warningBindingDigest: c.warningBindingDigest,
    originalIntentDigest: receipt.originalIntentDigest,
    receiptDigest: receipt.digest,
    occurredAt: c.occurredAt,
    recordedAt: receipt.recordedAt,
    eventId: catalogProductPublicationWarningAcknowledgementEventId(c),
    dataClassification: "ConfigurationMetadata",
  };
  for (const [key, expectedValue] of Object.entries(expected))
    if (metadata[key] !== expectedValue) return fail();
  return receipt;
}
/** Exact original recovery only. Caller holds current command/read authority and
 * the operation barrier. Historical observation expiry is never requalified. */
export async function recoverProductPublicationWarningAcknowledgement(
  tx: ProductLifecycleTransaction,
  commandValue: unknown,
): Promise<CatalogProductPublicationWarningAcknowledgementReceipt | null> {
  try {
    const command = parseCatalogProductPublicationWarningAcknowledgementCommand(commandValue),
      p = port(tx);
    const result = await p.query(select + " AND operation_id=$3 LIMIT 2", [
      command.tenantReference,
      command.brandReference,
      command.operationReference,
    ]);
    p.check();
    const found = rows(result);
    if (found.length === 0) return null;
    const receipt = decode(found[0]);
    if (
      receipt.originalIntentDigest !== hash(command) ||
      canonicalizeRfc8785(receipt.command) !== canonicalizeRfc8785(command)
    )
      return fail("CATALOG_IDEMPOTENCY_CONFLICT");
    return receipt;
  } catch (error) {
    if (error instanceof CatalogError && error.code === "CATALOG_IDEMPOTENCY_CONFLICT") throw error;
    return fail();
  }
}
/** Current held publication consumers select the latest Actor receipt first.
 * Semantic mismatch/corruption cannot silently resurrect an older confirmation. */
export async function readLatestProductPublicationWarningAcknowledgement(
  tx: ProductLifecycleTransaction,
  value: unknown,
): Promise<CatalogProductPublicationWarningAcknowledgementReceipt | null> {
  try {
    const r = closed(value, [
        "tenantReference",
        "brandReference",
        "productReference",
        "versionReference",
        "actorReference",
      ]),
      context = Object.freeze({
        tenantReference: parseCatalogReference(r.tenantReference),
        brandReference: parseCatalogReference(r.brandReference),
        productReference: parseCatalogReference(r.productReference),
        versionReference: parseCatalogReference(r.versionReference),
        actorReference: parseCatalogReference(r.actorReference),
      }),
      p = port(tx);
    const result = await p.query(
      select +
        " AND product_id=$3 AND product_version_id=$4 AND actor_id=$5 ORDER BY acknowledgement_sequence DESC LIMIT 1",
      Object.values(context),
    );
    p.check();
    const found = rows(result);
    if (found.length === 0) return null;
    const receipt = decode(found[0]);
    for (const key of Object.keys(context) as (keyof typeof context)[])
      if (receipt.command[key] !== context[key]) return fail();
    return receipt;
  } catch {
    return fail();
  }
}
/** Caller holds the Brand source barrier. The database independently validates
 * root and next sequence at INSERT; no Product operation/root is manufactured. */
export async function appendProductPublicationWarningAcknowledgement(
  tx: ProductLifecycleTransaction,
  value: { readonly receipt: unknown; readonly eventId: string; readonly auditId: string },
): Promise<void> {
  try {
    const r = closed(value, ["receipt", "eventId", "auditId"]),
      receipt = parseCatalogProductPublicationWarningAcknowledgementReceipt(r.receipt),
      c = receipt.command,
      eventId = parseCatalogReference(r.eventId),
      auditId = parseCatalogReference(r.auditId),
      p = port(tx);
    if (eventId !== catalogProductPublicationWarningAcknowledgementEventId(c)) return fail();
    const result = await p.query(
      `INSERT INTO rms_catalog.product_publication_warning_acknowledgement
 (operation_id,tenant_id,brand_id,product_id,product_version_id,actor_id,expected_product_aggregate_version,acknowledgement_sequence,
 report_operation_id,report_digest,warning_binding_digest,intent_digest,receipt_digest,occurred_at,recorded_at,receipt_json,event_id,audit_id)
 SELECT $1::platform_helpers.uuid_v7,$2::platform_helpers.uuid_v7,$3::platform_helpers.uuid_v7,$4::platform_helpers.uuid_v7,$5::platform_helpers.uuid_v7,$6::platform_helpers.uuid_v7,$7::integer,COALESCE(MAX(acknowledgement_sequence),0)+1,$8::platform_helpers.uuid_v7,$9::text,$10::text,$11::text,$12::text,$13::timestamptz,$14::timestamptz,$15::jsonb,$16::platform_helpers.uuid_v7,$17::platform_helpers.uuid_v7
 FROM rms_catalog.product_publication_warning_acknowledgement WHERE tenant_id=$2::platform_helpers.uuid_v7 AND brand_id=$3::platform_helpers.uuid_v7 AND product_id=$4::platform_helpers.uuid_v7 AND product_version_id=$5::platform_helpers.uuid_v7 AND actor_id=$6::platform_helpers.uuid_v7
 HAVING COALESCE(MAX(acknowledgement_sequence),0)<2147483647`,
      [
        c.operationReference,
        c.tenantReference,
        c.brandReference,
        c.productReference,
        c.versionReference,
        c.actorReference,
        c.expectedProductAggregateVersion,
        c.reportOperationReference,
        c.reportDigest,
        c.warningBindingDigest,
        receipt.originalIntentDigest,
        receipt.digest,
        c.occurredAt,
        receipt.recordedAt,
        canonicalizeRfc8785(receipt),
        eventId,
        auditId,
      ],
    );
    p.check();
    if (Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1) return fail();
  } catch {
    return fail();
  }
}
