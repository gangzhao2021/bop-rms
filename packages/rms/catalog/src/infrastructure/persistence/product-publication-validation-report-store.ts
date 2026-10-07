import { canonicalizeRfc8785 } from "@bop/audit";
import { CatalogError } from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { parseProductPublicationVersion } from "../../contracts/product-publication.js";
import { parseProductPublicationVersionV2 } from "../../contracts/product-publication-v2.js";
import {
  bindCatalogProductPublicationValidationReportToPublication,
  parseCatalogProductPublicationValidationReport,
  type CatalogProductPublicationValidationReport,
} from "../../contracts/product-publication-validation-report.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

export type ProductPublicationValidationReportCoverage =
  | { readonly status: "Recorded"; readonly report: CatalogProductPublicationValidationReport }
  | { readonly status: "NotRecorded"; readonly report: null };

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function parseHistoricalPublication(value: unknown) {
  const copied = copyCategoryPersistenceValue(value);
  return copied && typeof copied === "object" && Object.hasOwn(copied, "profile")
    ? parseProductPublicationVersionV2(copied)
    : parseProductPublicationVersion(copied);
}
function captureQuery(tx: ProductLifecycleTransaction) {
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
/** Inspect the SQL wrapper without traversing both independently bounded JSON
 * payloads together. Their owning parsers retain their original per-value limits. */
function row(value: unknown): Record<string, unknown> {
  const keys = ["publication", "required", "report", "metadata", "bounded"];
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
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function metadata(report: CatalogProductPublicationValidationReport) {
  return {
    operationReference: report.operationReference,
    tenantReference: report.binding.tenantReference,
    brandReference: report.binding.brandReference,
    productReference: report.binding.productReference,
    versionReference: report.binding.versionReference,
    publicationVersion: report.publicationVersion,
    sourceAggregateVersion: report.sourceAggregateVersion,
    resultAggregateVersion: report.resultAggregateVersion,
    publicationAction: report.publicationAction,
    originalIntentDigest: report.originalIntentDigest,
    publicationSnapshotDigest: report.publicationSnapshotDigest,
    validationEvidenceReference: report.validationEvidenceReference,
    digest: report.digest,
    recordedAt: report.recordedAt,
    dataClassification: "ConfigurationMetadata",
  };
}

/** Transaction-local append only. The publication writer holds current authority,
 * the Brand source barrier and its original source/approval leases through outer
 * COMMIT. Its final report builder binds the actual immutable publication first.
 * This helper creates neither admission nor a new source observation/deadline. */
export async function appendProductPublicationValidationReport(
  tx: ProductLifecycleTransaction,
  value: unknown,
): Promise<CatalogProductPublicationValidationReport> {
  const report = parseCatalogProductPublicationValidationReport(value),
    port = captureQuery(tx);
  const result = await port.query(
    `INSERT INTO rms_catalog.product_publication_validation_report
    (operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,
     source_aggregate_version,result_aggregate_version,action_code,publication_intent_digest,
     publication_snapshot_digest,validation_evidence_id,report_digest,recorded_at,snapshot_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [
      report.operationReference,
      report.binding.tenantReference,
      report.binding.brandReference,
      report.binding.productReference,
      report.binding.versionReference,
      report.publicationVersion,
      report.sourceAggregateVersion,
      report.resultAggregateVersion,
      report.publicationAction,
      report.originalIntentDigest,
      report.publicationSnapshotDigest,
      report.validationEvidenceReference,
      report.digest,
      report.recordedAt,
      canonicalizeRfc8785(report),
    ],
  );
  port.check();
  if (result.rowCount !== 1) return fail();
  return report;
}

/** Read an exact original revision/report under the caller's held history/read
 * authority and Tenant/Brand context. No clock is consulted: historical source
 * expiry does not invalidate an immutable report or renew its original lease.
 * Absence is legal only when the database's migration-era marker proves it. */
export async function recoverProductPublicationValidationReport(
  tx: ProductLifecycleTransaction,
  publicationValue: unknown,
): Promise<ProductPublicationValidationReportCoverage> {
  try {
    const publication = parseHistoricalPublication(publicationValue),
      port = captureQuery(tx);
    const result = await port.query<{
      publication: unknown;
      required: boolean;
      report: unknown;
      metadata: unknown;
      bounded: boolean;
    }>(
      `SELECT CASE WHEN octet_length(r.snapshot_json::text)<=1048576 THEN r.snapshot_json ELSE NULL END publication,
       r.validation_report_required required,
       CASE WHEN octet_length(p.snapshot_json::text)<=1048576 THEN p.snapshot_json ELSE NULL END report,
       CASE WHEN p.operation_id IS NULL THEN NULL ELSE jsonb_build_object(
        'operationReference',p.operation_id,'tenantReference',p.tenant_id,'brandReference',p.brand_id,
        'productReference',p.product_id,'versionReference',p.product_version_id,
        'publicationVersion',p.publication_version,'sourceAggregateVersion',p.source_aggregate_version,
        'resultAggregateVersion',p.result_aggregate_version,'publicationAction',p.action_code,
        'originalIntentDigest',p.publication_intent_digest,'publicationSnapshotDigest',p.publication_snapshot_digest,
        'validationEvidenceReference',p.validation_evidence_id,'digest',p.report_digest,
        'recordedAt',to_char(p.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'dataClassification',p.data_classification) END metadata,
       (octet_length(r.snapshot_json::text)<=1048576 AND
        (p.operation_id IS NULL OR octet_length(p.snapshot_json::text)<=1048576)) bounded
       FROM rms_catalog.product_publication_revision r
       LEFT JOIN rms_catalog.product_publication_validation_report p ON p.operation_id=r.operation_id
       WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.product_id=$3 AND r.product_version_id=$4
        AND r.operation_id=$5 LIMIT 2`,
      [
        publication.tenantReference,
        publication.brandReference,
        publication.productReference,
        publication.versionReference,
        publication.operationReference,
      ],
    );
    port.check();
    if (
      !Array.isArray(result.rows) ||
      Object.getPrototypeOf(result.rows) !== Array.prototype ||
      result.rows.length !== 1 ||
      Reflect.ownKeys(result.rows).length !== 2
    )
      return fail();
    const first = Object.getOwnPropertyDescriptor(result.rows, "0");
    if (!first?.enumerable || !("value" in first)) return fail();
    const raw = row(first.value);
    if (
      raw.bounded !== true ||
      typeof raw.required !== "boolean" ||
      !equal(parseHistoricalPublication(raw.publication), publication)
    )
      return fail();
    if (!raw.required) {
      if (raw.report !== null || raw.metadata !== null) return fail();
      return Object.freeze({ status: "NotRecorded", report: null });
    }
    if (!Object.hasOwn(publication, "profile") || raw.report === null || raw.metadata === null)
      return fail();
    const report = bindCatalogProductPublicationValidationReportToPublication(
      raw.report,
      publication,
    );
    // Metadata is independently descriptor-safe through its closed scalar wrapper;
    // never canonicalize an untrusted SQL value with a callable toJSON/getter.
    const descriptors = Object.getOwnPropertyDescriptors(raw.metadata);
    const expected = metadata(report);
    if (
      !raw.metadata ||
      typeof raw.metadata !== "object" ||
      Array.isArray(raw.metadata) ||
      Object.getPrototypeOf(raw.metadata) !== Object.prototype ||
      Reflect.ownKeys(raw.metadata).length !== Object.keys(expected).length
    )
      return fail();
    for (const [key, value] of Object.entries(expected)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value !== value)
        return fail();
    }
    return Object.freeze({ status: "Recorded", report });
  } catch {
    return fail();
  }
}
