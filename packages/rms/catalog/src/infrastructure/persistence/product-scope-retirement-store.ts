import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import type { ProductPublicationAction } from "../../contracts/product-publication.js";
import { parseProductPublicationVersionV2 } from "../../contracts/product-publication-v2.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationContent,
} from "../../contracts/product-publication-content.js";
import { catalogProductPublicationEventTypes } from "../../contracts/product-publication-event.js";
import {
  buildCatalogProductRetirementCoverage,
  type CatalogProductRetirementCoverage,
} from "../../contracts/product-publication-source-v2.js";
import {
  bindCatalogProductScopeRetirementHeader,
  parseCatalogProductScopeRetirementHeader,
} from "../../contracts/product-scope-retirement.js";
import { parseCatalogProductApprovalReceiptV2 } from "../../contracts/product-approval-v2.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function count(result: { rowCount?: number | null }) {
  if (result.rowCount !== 1) return fail();
}

/** The caller already holds current authority, Tenant/Brand context and the Brand
 * barrier. Original V1 operation recovery must precede this new-work fence.
 * Read only the legacy revision table, preserving historical role ACLs. */
export async function assertProductPublicationV1Compatible(
  tx: ProductLifecycleTransaction,
  tenant: string,
  brand: string,
  product: string,
): Promise<void> {
  const result = await tx.query<{ compatible: boolean }>(
    "SELECT NOT EXISTS(SELECT 1 FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND snapshot_json ? 'profile') compatible",
    [parseCatalogReference(tenant), parseCatalogReference(brand), parseCatalogReference(product)],
  );
  if (result.rows.length !== 1 || result.rows[0]?.compatible !== true) return fail();
}

/** Transaction-local complete history acquisition. This is not an authority
 * factory: caller must hold the complete history/disposition fields and purpose
 * through outer COMMIT, and check its original observation deadline afterward. */
export async function loadProductRetirementCoverage(
  tx: ProductLifecycleTransaction,
  value: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly productReference: string;
    readonly expectedAggregateVersion: number;
    readonly observedAt: string;
  },
): Promise<CatalogProductRetirementCoverage> {
  const r = copyCategoryPersistenceValue(value) as typeof value;
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== 5 ||
    ![
      "tenantReference",
      "brandReference",
      "productReference",
      "expectedAggregateVersion",
      "observedAt",
    ].every((key) => Object.hasOwn(r, key))
  )
    return fail();
  const tenant = parseCatalogReference(r.tenantReference),
    brand = parseCatalogReference(r.brandReference),
    product = parseCatalogReference(r.productReference),
    observedAt = parseCatalogInstant(r.observedAt);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    r.expectedAggregateVersion < 1 ||
    r.expectedAggregateVersion > 2147483647
  )
    return fail();
  await holdProductSourceBarrier(tx, brand);
  const scope = await tx.query<{ valid: boolean }>(
    "SELECT (current_setting('transaction_isolation')='read committed' AND current_setting('bop.tenant_id',true)=$1 AND current_setting('bop.brand_id',true)=$2 AND nullif(current_setting('bop.store_id',true),'') IS NULL) valid",
    [tenant, brand],
  );
  if (scope.rows.length !== 1 || scope.rows[0]?.valid !== true) return fail();
  const root = await tx.query<{ source_revision: string }>(
    "SELECT h.source_revision::text FROM rms_catalog.product p JOIN rms_catalog.product_source_head h ON h.brand_id=p.brand_id WHERE p.brand_id=$1 AND p.product_id=$2 AND p.aggregate_version=$3",
    [brand, product, r.expectedAggregateVersion],
  );
  if (root.rows.length !== 1) return fail();
  const sourceRevision = root.rows[0]?.source_revision;
  const budget = await tx.query<{
    revisions: number;
    headers: number;
    retirements: number;
    bytes: string;
  }>(
    `SELECT (SELECT count(*)::int FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3) revisions,
      (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3) headers,
      (SELECT count(*)::int FROM rms_catalog.product_scope_retirement WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3) retirements,
      (SELECT coalesce(sum(octet_length(snapshot_json::text)),0)::text FROM (
       SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3
       UNION ALL SELECT snapshot_json FROM rms_catalog.product_scope_retirement_header WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3
       UNION ALL SELECT snapshot_json FROM rms_catalog.product_scope_retirement WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3
       UNION ALL SELECT s.snapshot_json FROM rms_catalog.product_operation_snapshot s JOIN rms_catalog.product_publication_revision r ON r.operation_id=s.operation_id AND r.brand_id=s.brand_id AND r.product_id=s.product_id WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.product_id=$3
       UNION ALL SELECT f.snapshot_json FROM rms_catalog.product_publication_content f JOIN rms_catalog.product_publication_revision r ON r.product_version_id=f.product_version_id AND r.tenant_id=f.tenant_id AND r.brand_id=f.brand_id AND r.product_id=f.product_id WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.product_id=$3 AND r.state IN ('Published','Superseded')
      ) all_snapshots) bytes`,
    [tenant, brand, product],
  );
  const b = budget.rows[0];
  if (
    budget.rows.length !== 1 ||
    !b ||
    [b.revisions, b.headers, b.retirements].some(
      (n) => !Number.isSafeInteger(n) || n < 0 || n > 1000,
    ) ||
    !/^[0-9]+$/.test(b.bytes) ||
    BigInt(b.bytes) > 4194304n
  )
    return fail();
  const history = await tx.query<{
    publication_action: ProductPublicationAction;
    publication: unknown;
    aggregate: unknown;
    content: unknown;
    snapshot_digest: string;
    source_revision: string;
    event_type: string;
    actor_reference: string;
    correlation_reference: string;
    coherent: boolean;
  }>(
    `SELECT r.action_code publication_action,r.snapshot_json publication,s.snapshot_json aggregate,
      CASE WHEN r.state IN ('Published','Superseded') THEN f.snapshot_json ELSE NULL END content,
      sc.snapshot_digest,sc.source_revision::text,sc.event_type,sc.actor_id::text actor_reference,sc.correlation_id::text correlation_reference,
      (o.action_code='ProductPublication' AND o.product_id=r.product_id AND o.intent_digest=r.intent_digest AND o.result_aggregate_version=r.result_aggregate_version AND o.occurred_at=r.occurred_at
       AND s.product_id=r.product_id AND s.result_aggregate_version=r.result_aggregate_version AND s.occurred_at=r.occurred_at
       AND sc.product_id=r.product_id AND sc.result_aggregate_version=r.result_aggregate_version AND sc.occurred_at=r.occurred_at AND sc.source_revision<=$4::bigint
       AND sc.actor_id::text=r.snapshot_json->>'actorReference'
       AND sc.event_type=CASE r.action_code WHEN 'Validate' THEN 'ProductValidationCompleted' WHEN 'SubmitReview' THEN 'ProductReviewSubmitted' WHEN 'Approve' THEN 'ProductVersionApproved' WHEN 'Reject' THEN 'ProductVersionRejected' WHEN 'SchedulePublish' THEN 'ProductVersionPublishScheduled' WHEN 'ReschedulePublish' THEN 'ProductVersionPublishRescheduled' WHEN 'CancelScheduledPublish' THEN 'ProductVersionPublishScheduleCancelled' WHEN 'Supersede' THEN 'ProductVersionSuperseded' ELSE 'ProductVersionPublished' END
       AND (r.state NOT IN ('Published','Superseded') OR (f.tenant_id=r.tenant_id AND f.product_id=r.product_id AND f.content_digest=r.content_digest AND f.configuration_digest=r.configuration_digest))) coherent
     FROM rms_catalog.product_publication_revision r
     LEFT JOIN rms_catalog.product_operation_record o ON o.operation_id=r.operation_id AND o.brand_id=r.brand_id
     LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=r.operation_id AND s.brand_id=r.brand_id
     LEFT JOIN rms_catalog.product_source_commit sc ON sc.operation_id=r.operation_id AND sc.brand_id=r.brand_id
     LEFT JOIN rms_catalog.product_publication_content f ON f.product_version_id=r.product_version_id AND f.brand_id=r.brand_id
     WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.product_id=$3 ORDER BY r.source_aggregate_version LIMIT 1001`,
    [tenant, brand, product, sourceRevision],
  );
  const headers = await tx.query<{ header: unknown; retirement: unknown; coherent: boolean }>(
    `SELECT h.snapshot_json header,d.snapshot_json retirement,
      (sc.source_revision=h.observed_source_revision+1 AND sc.source_revision<=$4::bigint
       AND h.retirement_count=CASE WHEN d.operation_id IS NULL THEN 0 ELSE 1 END) coherent
     FROM rms_catalog.product_scope_retirement_header h
     LEFT JOIN rms_catalog.product_scope_retirement d ON d.operation_id=h.operation_id AND d.tenant_id=h.tenant_id AND d.brand_id=h.brand_id AND d.product_id=h.product_id
     LEFT JOIN rms_catalog.product_source_commit sc ON sc.operation_id=h.operation_id AND sc.brand_id=h.brand_id
     WHERE h.tenant_id=$1 AND h.brand_id=$2 AND h.product_id=$3 ORDER BY h.source_aggregate_version LIMIT 1001`,
    [tenant, brand, product, sourceRevision],
  );
  if (
    history.rows.length !== b.revisions ||
    headers.rows.length !== b.headers ||
    history.rows.some((row) => row.coherent !== true) ||
    headers.rows.some((row) => row.coherent !== true) ||
    headers.rows.filter((row) => row.retirement !== null).length !== b.retirements
  )
    return fail();
  const parsedHeaders = headers.rows.map((row) => {
    const header = parseCatalogProductScopeRetirementHeader(row.header);
    if (!equal(header.retirements, row.retirement === null ? [] : [row.retirement])) return fail();
    return header;
  });
  const coverage = buildCatalogProductRetirementCoverage({
    tenantReference: tenant,
    brandReference: brand,
    productReference: product,
    aggregateVersion: r.expectedAggregateVersion,
    sourceRevision,
    observedAt,
    history: history.rows.map((row) => ({
      publicationAction: row.publication_action,
      publication: row.publication,
    })),
    headers: parsedHeaders,
  });
  const operations = new Map(
    coverage.history.map((entry) => [entry.publication.operationReference, entry.publication]),
  );
  let previousSourceRevision = 0n;
  for (const [index, row] of history.rows.entries()) {
    const entry = coverage.history[index];
    if (!entry) return fail();
    const p = entry.publication,
      rawAggregate = copyCategoryPersistenceValue(row.aggregate),
      aggregate = parseProductAggregate(rawAggregate);
    // Read the actual immutable bodies rather than accepting their denormalized
    // SQL identity columns as content or original snapshot integrity evidence.
    if (
      !equal(rawAggregate, aggregate) ||
      row.snapshot_digest !== "sha256:" + sha256Hex(canonicalizeRfc8785(rawAggregate)) ||
      aggregate.brandReference !== brand ||
      aggregate.productReference !== product ||
      aggregate.aggregateVersion !== p.productAggregateVersion + 1 ||
      aggregate.updatedAt !== p.occurredAt ||
      row.event_type !== catalogProductPublicationEventTypes[entry.publicationAction] ||
      parseCatalogReference(row.actor_reference) !== p.actorReference ||
      !/^[1-9][0-9]{0,18}$/.test(row.source_revision) ||
      BigInt(row.source_revision) <= previousSourceRevision ||
      BigInt(row.source_revision) > BigInt(coverage.sourceRevision)
    )
      return fail();
    parseCatalogReference(row.correlation_reference);
    previousSourceRevision = BigInt(row.source_revision);
    if (p.state === "Published" || p.state === "Superseded") {
      const rawContent = copyCategoryPersistenceValue(row.content),
        content = parseCatalogProductPublicationContent(rawContent),
        original = operations.get(content.publicationOperationReference);
      if (
        !equal(rawContent, content) ||
        content.tenantReference !== tenant ||
        content.brandReference !== brand ||
        content.productReference !== product ||
        content.versionReference !== p.versionReference ||
        content.contentDigest !== p.contentDigest ||
        content.configurationDigest !== p.configurationDigest ||
        !original ||
        original.state !== "Published" ||
        original.versionReference !== content.versionReference ||
        original.productAggregateVersion !== content.sourceAggregateVersion ||
        original.publishedAt !== content.sealedAt ||
        (p.state === "Published" &&
          (content.publicationOperationReference !== p.operationReference ||
            aggregate.draft.versionReference !== p.successorDraftVersionReference ||
            aggregate.draft.baseVersionReference !== p.versionReference))
      )
        return fail();
    } else {
      const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
      if (
        row.content !== null ||
        aggregate.draft.versionReference !== p.versionReference ||
        identity.contentDigest !== p.contentDigest ||
        identity.configurationDigest !== p.configurationDigest
      )
        return fail();
    }
  }
  // Event-envelope and Audit persistence remain the existing owning producer's
  // responsibility. This reader does not synthesize Audit facts or query its tables.
  return coverage;
}

/** Only the owning writer invokes these appends inside its same locked UoW.
 * The deferred database guards additionally require the matching V2 publication,
 * source commit and original old Published tuple before COMMIT. */
export async function appendProductScopeRetirementHeader(
  tx: ProductLifecycleTransaction,
  value: unknown,
): Promise<void> {
  const h = parseCatalogProductScopeRetirementHeader(value);
  count(
    await tx.query(
      "INSERT INTO rms_catalog.product_scope_retirement_header(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,action_code,source_aggregate_version,result_aggregate_version,publication_intent_digest,publication_snapshot_digest,observed_source_revision,observed_source_head_digest,recorded_at,retirement_count,header_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)",
      [
        h.operationReference,
        h.tenantReference,
        h.brandReference,
        h.productReference,
        h.versionReference,
        h.publicationVersion,
        h.publicationAction,
        h.sourceAggregateVersion,
        h.resultAggregateVersion,
        h.publicationIntentDigest,
        h.publicationSnapshotDigest,
        h.observedSourceRevision,
        h.observedSourceHeadDigest,
        h.recordedAt,
        h.retirements.length,
        h.digest,
        JSON.stringify(h),
      ],
    ),
  );
  for (const d of h.retirements) {
    const i = d.replacementIntent;
    count(
      await tx.query(
        "INSERT INTO rms_catalog.product_scope_retirement(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,publication_intent_digest,previous_operation_id,previous_version_id,previous_publication_version,previous_intent_digest,previous_scope_digest,previous_period_digest,previous_selector_index,previous_selector_digest,previous_publication_digest,replacement_intent_digest,retired_at,retirement_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)",
        [
          h.operationReference,
          h.tenantReference,
          h.brandReference,
          h.productReference,
          h.versionReference,
          h.publicationVersion,
          h.publicationIntentDigest,
          i.previousPublicationOperationReference,
          i.previousVersionReference,
          i.expectedPreviousPublicationVersion,
          i.previousIntentDigest,
          i.previousScopeDigest,
          i.previousPeriodDigest,
          i.previousSelectorIndex,
          i.previousSelectorDigest,
          d.previousPublicationDigest,
          i.digest,
          d.retiredAt,
          d.digest,
          JSON.stringify(d),
        ],
      ),
    );
  }
}

/** Original immutable recovery only. No current head, policy, lease or source
 * generation is acquired and no missing half is reconstructed or written. */
export async function recoverProductScopeRetirementHeader(
  tx: ProductLifecycleTransaction,
  publicationValue: unknown,
  publicationAction: ProductPublicationAction,
) {
  const p = parseProductPublicationVersionV2(publicationValue);
  const rows = await tx.query<{ header: unknown; retirement: unknown; previous: unknown }>(
    "SELECT h.snapshot_json header,d.snapshot_json retirement,r.snapshot_json previous FROM rms_catalog.product_scope_retirement_header h LEFT JOIN rms_catalog.product_scope_retirement d ON d.operation_id=h.operation_id AND d.tenant_id=h.tenant_id AND d.brand_id=h.brand_id AND d.product_id=h.product_id LEFT JOIN rms_catalog.product_publication_revision r ON r.operation_id=d.previous_operation_id AND r.tenant_id=d.tenant_id AND r.brand_id=d.brand_id AND r.product_id=d.product_id WHERE h.tenant_id=$1 AND h.brand_id=$2 AND h.product_id=$3 AND h.operation_id=$4",
    [p.tenantReference, p.brandReference, p.productReference, p.operationReference],
  );
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || !row) return fail();
  const h = parseCatalogProductScopeRetirementHeader(row.header);
  if (!equal(h.retirements, row.retirement === null ? [] : [row.retirement])) return fail();
  return bindCatalogProductScopeRetirementHeader(h, {
    publicationAction,
    publication: p,
    // The binder must inspect the original persisted selector ordering itself;
    // parsing it here first would hide a normalization of historical ordinals.
    previousPublication: row.previous,
  });
}

/** Read an actual original Approve receipt. Authority precedes this query in the
 * V2 writer; pure binding against review/current/policy follows it there. */
export async function readProductApprovalReceiptV2(
  tx: ProductLifecycleTransaction,
  currentValue: unknown,
) {
  const p = parseProductPublicationVersionV2(currentValue);
  if (p.approvalEvidenceReference === null) return fail();
  const rows = await tx.query<{ receipt: unknown }>(
    "SELECT snapshot_json receipt FROM rms_catalog.product_approval_receipt WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 AND approval_id=$5",
    [
      p.tenantReference,
      p.brandReference,
      p.productReference,
      p.versionReference,
      p.approvalEvidenceReference,
    ],
  );
  if (rows.rows.length !== 1) return fail();
  return parseCatalogProductApprovalReceiptV2(rows.rows[0]?.receipt);
}
