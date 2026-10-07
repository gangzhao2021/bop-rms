import {
  buildCatalogProductScopeJournalManagement,
  productScopeJournalManagementFields,
} from "../../contracts/product-scope-journal.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  parseProductPublicationVersion,
  parseProductPublicationCommand,
} from "../../contracts/product-publication.js";
import {
  bindCatalogProductReviewForApproval,
  productApprovalReviewFields,
} from "../../contracts/product-approval-decision.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  buildProductPublicationSourceSnapshot,
  parseProductPublicationSourceRequest,
  productPublicationSourceFields,
  type ProductPublicationSourceRequest,
  type ProductPublicationSourceSnapshot,
} from "../../contracts/product-publication-source.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
import {
  assertProductPublicationV1Compatible,
  loadProductRetirementCoverage,
} from "./product-scope-retirement-store.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationVersionV2,
} from "../../contracts/product-publication-v2.js";
import type { CatalogProductRetirementCoverage } from "../../contracts/product-publication-source-v2.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
import {
  bindCatalogProductApprovalReceipt,
  parseCatalogProductApprovalRequest,
  productApprovalSourceFields,
} from "../../contracts/product-approval-receipt.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
const utc = (v: string) => `to_char(${v} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT jsonb_build_object('aggregateVersion',p.aggregate_version,'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'revisions',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('action',r.action_code,'publication',r.snapshot_json,'aggregate',s.snapshot_json,'content',c.snapshot_json,'snapshotDigest',receipt.snapshot_digest,'coherent',
 o.action_code='ProductPublication' AND o.brand_id=r.brand_id AND o.product_id=r.product_id AND o.intent_digest=r.intent_digest AND o.result_aggregate_version=r.result_aggregate_version AND o.occurred_at=r.occurred_at AND
 s.brand_id=r.brand_id AND s.product_id=r.product_id AND s.result_aggregate_version=r.result_aggregate_version AND s.occurred_at=r.occurred_at AND
 receipt.brand_id=r.brand_id AND receipt.product_id=r.product_id AND receipt.result_aggregate_version=r.result_aggregate_version AND receipt.occurred_at=r.occurred_at AND
 receipt.event_type=CASE r.action_code WHEN 'Validate' THEN 'ProductValidationCompleted' WHEN 'SubmitReview' THEN 'ProductReviewSubmitted' WHEN 'Approve' THEN 'ProductVersionApproved' WHEN 'Reject' THEN 'ProductVersionRejected' WHEN 'SchedulePublish' THEN 'ProductVersionPublishScheduled' WHEN 'ReschedulePublish' THEN 'ProductVersionPublishRescheduled' WHEN 'CancelScheduledPublish' THEN 'ProductVersionPublishScheduleCancelled' WHEN 'Supersede' THEN 'ProductVersionSuperseded' ELSE 'ProductVersionPublished' END)
 ORDER BY r.result_aggregate_version)
 FROM (SELECT * FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY result_aggregate_version LIMIT 1001) r
 LEFT JOIN rms_catalog.product_operation_record o ON o.operation_id=r.operation_id
 LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=r.operation_id
 LEFT JOIN rms_catalog.product_source_commit receipt ON receipt.operation_id=r.operation_id
 LEFT JOIN rms_catalog.product_publication_content c ON c.product_version_id=r.product_version_id AND c.tenant_id=r.tenant_id AND c.brand_id=r.brand_id AND c.product_id=r.product_id
 ),'[]'::jsonb)) AS source FROM rms_catalog.product p WHERE p.brand_id=$2 AND p.product_id=$3`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function single(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length !== 1
  )
    return fail();
  const row = Object.getOwnPropertyDescriptor(descriptor.value, "0")?.value;
  if (!row || typeof row !== "object" || Reflect.ownKeys(row).length !== 1) return fail();
  const item = Object.getOwnPropertyDescriptor(row, field);
  if (!item?.enumerable || !("value" in item)) return fail();
  return item.value;
}
/** Internal minimal recorded/current publication graphs. Permission and fields
 * precede private reads; source barrier and caller authority survive COMMIT.
 * Runtime resolver still requires held current topology/policy/validation. */
export function createPostgresProductPublicationSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind?: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly approvalAuthority?: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User" | "System";
        readonly productReference: string;
        readonly purposeCode: "CATALOG_PRODUCT_APPROVAL_SOURCE";
        readonly permission: "catalog.manage";
        readonly owningAction: "catalog.product.approval.read";
        readonly requiredFields: typeof productApprovalSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly reviewAuthority?: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User";
        readonly productReference: string;
        readonly purposeCode: "CATALOG_PRODUCT_APPROVAL_DECISION";
        readonly permission: "catalog.manage";
        readonly owningAction: "catalog.product.approve";
        readonly requiredFields: typeof productApprovalReviewFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly scopeJournalAuthority?: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User";
        readonly productReference: string;
        readonly purposeCode: "CATALOG_PRODUCT_SCOPE_JOURNAL";
        readonly permission: "catalog.manage";
        readonly owningAction: "catalog.product.history.read";
        readonly requiredFields: typeof productScopeJournalManagementFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly productReference: string | null;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE";
        readonly permission: "catalog.manage";
        readonly owningAction: "catalog.product.history.read" | "catalog.product.publish";
        readonly requiredFields: typeof productPublicationSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    approvalActorKind = options.actorKind ?? "User";
  if (!["User", "System"].includes(approvalActorKind)) return fail();
  const scopeJournalConfiguration = {
    ...options,
    tenantReference,
    brandReference,
    actorReference,
    actorKind: "User" as const,
  };
  async function read<T>(
    input: ProductPublicationSourceRequest,
    work: (snapshot: ProductPublicationSourceSnapshot) => Promise<T>,
  ): Promise<T> {
    try {
      const request = parseProductPublicationSourceRequest(input);
      let calls = 0;
      let completed: { value: T } | undefined;
      const result = await options.transactions.run(async (tx) => {
        if (++calls !== 1) return fail();
        const authorize = () =>
          options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference,
            brandReference,
            actorReference,
            productReference: request.productReference,
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
            permission: "catalog.manage",
            owningAction: "catalog.product.history.read",
            requiredFields: productPublicationSourceFields,
            observedAt: parseCatalogInstant(options.clock.now()),
          });
        await authorize();
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
          [tenantReference, brandReference],
        );
        const mode = await tx.query("SHOW transaction_isolation", []);
        if (single(mode, "transaction_isolation") !== "read committed") return fail();
        await holdProductSourceBarrier(tx, brandReference);
        await assertProductPublicationV1Compatible(
          tx,
          tenantReference,
          brandReference,
          request.productReference,
        );
        const query = await tx.query(select, [
          tenantReference,
          brandReference,
          request.productReference,
        ]);
        const snapshot = buildProductPublicationSourceSnapshot(
          single(query, "source"),
          { tenantReference, brandReference },
          request,
          options.clock.now(),
        );
        await authorize();
        const value = await work(snapshot);
        await authorize();
        const at = parseCatalogInstant(options.clock.now());
        if (at < snapshot.observedAt || Date.parse(at) - Date.parse(snapshot.observedAt) > 5000)
          return fail();
        completed = Object.freeze({ value });
        return completed;
      });
      if (calls !== 1 || !completed || result !== completed) return fail();
      return completed.value;
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  }
  async function discoverDueSchedules(value: unknown) {
    try {
      if (options.actorKind !== "System") return fail();
      const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, "afterVersionReference") ||
        !Object.hasOwn(raw, "limit") ||
        !Number.isInteger(raw.limit) ||
        (raw.limit as number) < 1 ||
        (raw.limit as number) > 100
      )
        return fail();
      const after =
          raw.afterVersionReference === null
            ? null
            : parseCatalogReference(raw.afterVersionReference),
        limit = raw.limit as number,
        at = parseCatalogInstant(options.clock.now());
      let calls = 0;
      let completed: object | undefined;
      const result = await options.transactions.run(async (tx) => {
        if (++calls !== 1) return fail();
        const authorize = () =>
          options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference,
            brandReference,
            actorReference,
            productReference: null,
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
            permission: "catalog.manage",
            owningAction: "catalog.product.publish",
            requiredFields: productPublicationSourceFields,
            observedAt: parseCatalogInstant(options.clock.now()),
          });
        await authorize();
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
          [tenantReference, brandReference],
        );
        if (
          single(await tx.query("SHOW transaction_isolation", []), "transaction_isolation") !==
          "read committed"
        )
          return fail();
        await holdProductSourceBarrier(tx, brandReference);
        const queried = await tx.query(
          `WITH latest AS (SELECT DISTINCT ON(product_id,product_version_id) product_id,product_version_id,snapshot_json,state,publication_version FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 ORDER BY product_id,product_version_id,publication_version DESC)
     SELECT COALESCE(jsonb_agg(jsonb_build_object('publication',s.snapshot_json,'expectedAggregateVersion',s.aggregate_version) ORDER BY s.product_version_id),'[]'::jsonb) AS candidates FROM (
      SELECT l.*,p.aggregate_version FROM latest l JOIN rms_catalog.product p ON p.product_id=l.product_id AND p.brand_id=$2
      JOIN rms_catalog.product_version v ON v.product_id=p.product_id AND v.product_version_id=l.product_version_id AND v.status='Draft'
      WHERE l.state='Scheduled' AND (l.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')::timestamptz<=$3::timestamptz
      AND ((l.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}') IS NULL OR (l.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}')::timestamptz>$3::timestamptz)
      AND ($4::uuid IS NULL OR l.product_version_id>$4::uuid) ORDER BY l.product_version_id LIMIT $5
     ) s`,
          [tenantReference, brandReference, at, after, limit],
        );
        const rows = copyCategoryPersistenceValue(single(queried, "candidates"));
        if (!Array.isArray(rows) || rows.length > limit) return fail();
        let previous: string | null = after;
        const candidates = Object.freeze(
          rows.map((raw) => {
            if (
              !raw ||
              typeof raw !== "object" ||
              Array.isArray(raw) ||
              Object.keys(raw).length !== 2
            )
              return fail();
            const r = raw as Record<string, unknown>,
              p = parseProductPublicationVersion(r.publication);
            if (
              p.tenantReference !== tenantReference ||
              p.brandReference !== brandReference ||
              p.state !== "Scheduled" ||
              p.scheduleReference === null ||
              p.effectivePeriod.effectiveFrom.instant > at ||
              (p.effectivePeriod.effectiveUntil !== null &&
                p.effectivePeriod.effectiveUntil.instant <= at) ||
              (previous !== null && p.versionReference <= previous) ||
              !Number.isInteger(r.expectedAggregateVersion) ||
              (r.expectedAggregateVersion as number) < p.productAggregateVersion + 1 ||
              (r.expectedAggregateVersion as number) >= 2147483647
            )
              return fail();
            previous = p.versionReference;
            return Object.freeze({
              publication: p,
              expectedAggregateVersion: r.expectedAggregateVersion as number,
            });
          }),
        );
        for (const product of new Set(
          candidates.map((candidate) => candidate.publication.productReference),
        )) {
          await assertProductPublicationV1Compatible(tx, tenantReference, brandReference, product);
        }
        await authorize();
        const ended = parseCatalogInstant(options.clock.now());
        if (ended < at || Date.parse(ended) - Date.parse(at) > 5000) return fail();
        completed = Object.freeze({
          candidates,
          nextAfterVersionReference: candidates.length === limit ? previous : null,
        });
        return completed;
      });
      if (calls !== 1 || !completed || completed !== result) return fail();
      return result as {
        readonly candidates: readonly {
          readonly publication: ReturnType<typeof parseProductPublicationVersion>;
          readonly expectedAggregateVersion: number;
        }[];
        readonly nextAfterVersionReference: string | null;
      };
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  }
  return Object.freeze({
    context: Object.freeze({
      tenantReference,
      brandReference,
      actorReference,
      actorKind: approvalActorKind,
    }),
    async withCurrentReview<T>(
      value: unknown,
      work: (
        proof: ReturnType<typeof bindCatalogProductReviewForApproval>,
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      const c = parseProductPublicationCommand(copyCategoryPersistenceValue(value));
      if (
        approvalActorKind !== "User" ||
        c.action !== "Approve" ||
        c.actorKind !== "User" ||
        c.tenantReference !== tenantReference ||
        c.brandReference !== brandReference ||
        c.actorReference !== actorReference ||
        typeof options.reviewAuthority?.holdUntilTransactionCompletes !== "function"
      )
        return fail();
      const authority = options.reviewAuthority,
        observedAt = parseCatalogInstant(options.clock.now());
      let calls = 0,
        completed: { value: T } | undefined;
      try {
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const check = () => {
            const now = parseCatalogInstant(options.clock.now());
            if (now < observedAt || Date.parse(now) - Date.parse(observedAt) >= 30000)
              return fail();
          };
          const hold = () =>
            authority.holdUntilTransactionCompletes(tx, {
              tenantReference,
              brandReference,
              actorReference,
              actorKind: "User",
              productReference: c.productReference,
              purposeCode: "CATALOG_PRODUCT_APPROVAL_DECISION",
              permission: "catalog.manage",
              owningAction: "catalog.product.approve",
              requiredFields: productApprovalReviewFields,
              observedAt: parseCatalogInstant(options.clock.now()),
            });
          check();
          await hold();
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenantReference, brandReference],
          );
          await holdProductSourceBarrier(tx, brandReference);
          await assertProductPublicationV1Compatible(
            tx,
            tenantReference,
            brandReference,
            c.productReference,
          );
          const result = await tx.query<{ review: unknown; coherent: boolean }>(
            `
SELECT r.snapshot_json review,
 (r.action_code='SubmitReview' AND r.state='InReview' AND r.result_aggregate_version=p.aggregate_version AND p.aggregate_version=$5 AND r.publication_version=$6
 AND r.snapshot_json->>'operationReference'=r.operation_id::text AND r.snapshot_json->>'intentDigest'=r.intent_digest AND (r.snapshot_json->>'occurredAt')::timestamptz=r.occurred_at
 AND r.snapshot_json->'productAggregateVersion'=to_jsonb(r.source_aggregate_version) AND r.snapshot_json->'publicationVersion'=to_jsonb(r.publication_version)
 AND o.action_code='ProductPublication' AND o.product_id=p.product_id AND o.result_aggregate_version=r.result_aggregate_version AND o.intent_digest=r.intent_digest AND o.occurred_at=r.occurred_at
 AND s.product_id=p.product_id AND s.result_aggregate_version=r.result_aggregate_version AND s.occurred_at=r.occurred_at AND s.event_type='ProductReviewSubmitted' AND s.actor_id::text=r.snapshot_json->>'actorReference') coherent
FROM rms_catalog.product p
JOIN rms_catalog.product_version v ON v.brand_id=$2 AND v.product_id=p.product_id AND v.product_version_id=$4 AND v.status='Draft'
JOIN LATERAL (SELECT * FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 ORDER BY publication_version DESC LIMIT 1) r ON true
JOIN rms_catalog.product_operation_record o ON o.operation_id=r.operation_id AND o.brand_id=$2
JOIN rms_catalog.product_source_commit s ON s.operation_id=r.operation_id AND s.brand_id=$2
WHERE p.product_id=$3 AND p.brand_id=$2`,
            [
              tenantReference,
              brandReference,
              c.productReference,
              c.versionReference,
              c.expectedProductAggregateVersion,
              c.expectedPublicationVersion,
            ],
          );
          if (result.rows.length !== 1 || result.rows[0]?.coherent !== true) return fail();
          const proof = bindCatalogProductReviewForApproval(c, result.rows[0].review, observedAt);
          await hold();
          check();
          const value = await work(proof, tx);
          check();
          await hold();
          check();
          completed = Object.freeze({ value });
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
    async withCurrentApproval<T>(
      value: unknown,
      work: (
        proof: ReturnType<typeof bindCatalogProductApprovalReceipt>,
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      const request = parseCatalogProductApprovalRequest(value);
      if (typeof options.approvalAuthority?.holdUntilTransactionCompletes !== "function")
        return fail();
      const authority = options.approvalAuthority;
      let calls = 0;
      let completed: { value: T } | undefined;
      try {
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const hold = () =>
            authority.holdUntilTransactionCompletes(tx, {
              tenantReference,
              brandReference,
              actorReference,
              actorKind: approvalActorKind,
              productReference: request.productReference,
              purposeCode: "CATALOG_PRODUCT_APPROVAL_SOURCE",
              permission: "catalog.manage",
              owningAction: "catalog.product.approval.read",
              requiredFields: productApprovalSourceFields,
              observedAt: parseCatalogInstant(options.clock.now()),
            });
          const check = () => {
            const now = parseCatalogInstant(options.clock.now());
            if (now < request.observedAt || now >= request.validUntil) return fail();
            return now;
          };
          check();
          await hold();
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenantReference, brandReference],
          );
          await holdProductSourceBarrier(tx, brandReference);
          await assertProductPublicationV1Compatible(
            tx,
            tenantReference,
            brandReference,
            request.productReference,
          );
          const queried = await tx.query<{
            receipt: unknown;
            approved: unknown;
            review: unknown;
            current: unknown;
            coherent: boolean;
          }>(
            `
SELECT r.snapshot_json receipt,a.snapshot_json approved,v.snapshot_json review,c.snapshot_json current,
 (r.receipt_digest=r.snapshot_json->>'digest' AND r.publication_version=a.publication_version AND r.result_aggregate_version=a.result_aggregate_version
  AND r.recorded_at=a.occurred_at AND r.snapshot_json->>'originalIntentDigest'=a.intent_digest AND a.action_code='Approve' AND a.state='Approved'
  AND c.result_aggregate_version=p.aggregate_version AND p.aggregate_version=$5 AND c.publication_version=$6
  AND co.action_code='ProductPublication' AND co.product_id=r.product_id AND co.result_aggregate_version=c.result_aggregate_version AND co.intent_digest=c.intent_digest AND co.occurred_at=c.occurred_at
  AND cc.product_id=r.product_id AND cc.result_aggregate_version=c.result_aggregate_version AND cc.occurred_at=c.occurred_at AND cc.actor_id::text=c.snapshot_json->>'actorReference'
  AND cc.event_type=CASE c.state WHEN 'Approved' THEN 'ProductVersionApproved' WHEN 'Scheduled' THEN 'ProductVersionPublishScheduled' ELSE '' END
  AND c.state IN('Approved','Scheduled') AND c.snapshot_json->>'approvalEvidenceReference'=r.approval_id::text
  AND o.action_code='ProductPublication' AND o.product_id=r.product_id AND o.result_aggregate_version=a.result_aggregate_version AND o.intent_digest=a.intent_digest AND o.occurred_at=a.occurred_at
  AND ac.product_id=r.product_id AND ac.result_aggregate_version=a.result_aggregate_version AND ac.occurred_at=a.occurred_at AND ac.event_type='ProductVersionApproved'
  AND ac.actor_id::text=a.snapshot_json->>'actorReference'
  AND v.action_code='SubmitReview' AND v.state='InReview' AND vo.action_code='ProductPublication' AND vo.product_id=r.product_id AND vo.result_aggregate_version=v.result_aggregate_version AND vo.intent_digest=v.intent_digest AND vo.occurred_at=v.occurred_at
  AND vc.product_id=r.product_id AND vc.result_aggregate_version=v.result_aggregate_version AND vc.occurred_at=v.occurred_at AND vc.event_type='ProductReviewSubmitted' AND vc.actor_id::text=v.snapshot_json->>'actorReference'
  AND r.data_classification='ApprovalEvidence') coherent
FROM rms_catalog.product p
JOIN rms_catalog.product_version cv ON cv.product_id=p.product_id AND cv.brand_id=$2 AND cv.product_version_id=$4 AND cv.status='Draft'
JOIN LATERAL (SELECT * FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 ORDER BY publication_version DESC LIMIT 1) c ON true
JOIN rms_catalog.product_approval_receipt r ON r.tenant_id=$1 AND r.brand_id=$2 AND r.product_id=$3 AND r.product_version_id=$4 AND r.approval_id::text=c.snapshot_json->>'approvalEvidenceReference'
JOIN rms_catalog.product_publication_revision a ON a.operation_id=r.operation_id AND a.tenant_id=$1 AND a.brand_id=$2 AND a.product_id=$3 AND a.product_version_id=$4
JOIN rms_catalog.product_operation_record o ON o.operation_id=a.operation_id AND o.brand_id=$2
JOIN rms_catalog.product_source_commit ac ON ac.operation_id=a.operation_id AND ac.brand_id=$2
JOIN rms_catalog.product_operation_record co ON co.operation_id=c.operation_id AND co.brand_id=$2
JOIN rms_catalog.product_source_commit cc ON cc.operation_id=c.operation_id AND cc.brand_id=$2
JOIN rms_catalog.product_publication_revision v ON v.tenant_id=$1 AND v.brand_id=$2 AND v.product_id=$3 AND v.product_version_id=$4 AND v.publication_version=(r.snapshot_json#>>'{approval,reviewVersion}')::integer
JOIN rms_catalog.product_operation_record vo ON vo.operation_id=v.operation_id AND vo.brand_id=$2
JOIN rms_catalog.product_source_commit vc ON vc.operation_id=v.operation_id AND vc.brand_id=$2
WHERE p.brand_id=$2 AND p.product_id=$3`,
            [
              tenantReference,
              brandReference,
              request.productReference,
              request.versionReference,
              request.expectedAggregateVersion,
              request.expectedPublicationVersion,
            ],
          );
          if (queried.rows.length !== 1 || queried.rows[0]?.coherent !== true) return fail();
          const r = queried.rows[0],
            proof = bindCatalogProductApprovalReceipt(
              r.receipt,
              r.approved,
              r.review,
              r.current,
              request,
              check(),
            );
          await hold();
          check();
          const result = await work(proof, tx);
          const now = check();
          if (now >= proof.validUntil) return fail();
          await hold();
          if (check() >= proof.validUntil) return fail();
          completed = Object.freeze({ value: result });
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
    async withCurrentScopeJournals<T>(
      input: ProductPublicationSourceRequest,
      work: (
        projection: ReturnType<typeof buildCatalogProductScopeJournalManagement>,
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      const authority = scopeJournalConfiguration.scopeJournalAuthority;
      if (
        approvalActorKind !== "User" ||
        typeof authority?.holdUntilTransactionCompletes !== "function"
      )
        return fail();
      try {
        const request = parseProductPublicationSourceRequest(input);
        let calls = 0,
          workCalls = 0,
          completed: { value: T } | undefined,
          observedAt = "",
          deadline = 0;
        const result = await scopeJournalConfiguration.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const hold = () =>
            authority.holdUntilTransactionCompletes(tx, {
              tenantReference,
              brandReference,
              actorReference,
              actorKind: "User",
              productReference: request.productReference,
              purposeCode: "CATALOG_PRODUCT_SCOPE_JOURNAL",
              permission: "catalog.manage",
              owningAction: "catalog.product.history.read",
              requiredFields: productScopeJournalManagementFields,
              observedAt: parseCatalogInstant(scopeJournalConfiguration.clock.now()),
            });
          await hold();
          const source = createPostgresProductPublicationSourceStore({
            ...scopeJournalConfiguration,
            transactions: { run: (callback) => callback(tx) },
          });
          const answer = await source.withCurrentSnapshot(request, async (snapshot) => {
            observedAt = snapshot.observedAt;
            deadline = Date.parse(observedAt) + 5000;
            const check = () => {
              const at = parseCatalogInstant(scopeJournalConfiguration.clock.now());
              if (at < snapshot.observedAt || Date.parse(at) >= deadline) return fail();
            };
            check();
            await hold();
            check();
            const rows = await tx.query(
              `SELECT CASE WHEN count(*)<=1000 AND COALESCE(sum(octet_length(snapshot_json::text)),0)<=1048576 THEN COALESCE(jsonb_agg(jsonb_build_object('operationReference',operation_id,'digest',journal_digest,'journal',snapshot_json,'coherent',
              (snapshot_json->>'digest'=journal_digest AND snapshot_json#>>'{incoming,operationReference}'=operation_id::text AND snapshot_json#>>'{incoming,intentDigest}'=intent_digest AND snapshot_json#>>'{incoming,tenantReference}'=tenant_id::text AND snapshot_json#>>'{incoming,brandReference}'=brand_id::text AND snapshot_json#>>'{incoming,productReference}'=product_id::text AND snapshot_json->'sourceAggregateVersion'=to_jsonb(source_aggregate_version) AND snapshot_json->>'sourceRevision'=source_revision::text)) ORDER BY operation_id),'[]'::jsonb) ELSE NULL END records
              FROM rms_catalog.product_scope_journal WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3`,
              [tenantReference, brandReference, request.productReference],
            );
            const projection = buildCatalogProductScopeJournalManagement(
              snapshot,
              single(rows, "records"),
            );
            check();
            if (++workCalls !== 1) return fail();
            const value = await work(projection, tx);
            check();
            await hold();
            check();
            completed = Object.freeze({ value });
            return completed;
          });
          if (!completed || answer !== completed) return fail();
          await hold();
          const at = parseCatalogInstant(scopeJournalConfiguration.clock.now());
          // Check again after the normal publication-history final authority.
          if (at < observedAt || Date.parse(at) >= deadline) return fail();
          return answer;
        });
        if (calls !== 1 || workCalls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
    discoverDueSchedules,
    loadSnapshot: (input: ProductPublicationSourceRequest) => read(input, async (s) => s),
    withCurrentSnapshot: read,
  });
}

export const productPublicationSourceFieldsV2 = Object.freeze([
  ...productPublicationSourceFields,
  "replacementIntent",
  "scopeRetirementHeaders",
  "scopeRetirements",
  "completePublicationHistory",
] as const);

/** Owning recorded/current history only. Eligibility still needs the separately
 * held current policy, topology, validation and approval in the actual writer.
 * This explicit V2 surface never projects a V2 participant through a V1 source. */
export function createPostgresProductPublicationSourceStoreV2(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User" | "System";
        readonly productReference: string | null;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE";
        readonly permission: "catalog.manage";
        readonly owningActions: readonly (
          "catalog.product.history.read" | "catalog.product.publish"
        )[];
        readonly requiredFields: typeof productPublicationSourceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    actorKind = options.actorKind;
  if (
    !["User", "System"].includes(actorKind) ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    holdAuthority = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  const exact = (value: unknown, keys: readonly string[]) => {
    const r = copyCategoryPersistenceValue(value);
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(r, key))
    )
      return fail();
    return r as Record<string, unknown>;
  };
  async function read<T>(
    productReference: string | null,
    scheduled: boolean,
    work: (tx: ProductLifecycleTransaction, observedAt: string, check: () => void) => Promise<T>,
  ): Promise<T> {
    const observedAt = parseCatalogInstant(now()),
      deadline = Date.parse(observedAt) + 5000;
    const check = () => {
      const at = parseCatalogInstant(now());
      if (at < observedAt || Date.parse(at) >= deadline) return fail();
    };
    let calls = 0,
      completed: { value: T } | undefined;
    try {
      const answer = await run(async (tx) => {
        if (++calls !== 1) return fail();
        const hold = () =>
          holdAuthority(tx, {
            tenantReference,
            brandReference,
            actorReference,
            actorKind,
            productReference,
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
            permission: "catalog.manage",
            owningActions: scheduled
              ? ["catalog.product.history.read", "catalog.product.publish"]
              : ["catalog.product.history.read"],
            requiredFields: productPublicationSourceFieldsV2,
            observedAt: parseCatalogInstant(now()),
          });
        await hold();
        check();
        await requireCategoryCurrentReads(tx);
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
          [tenantReference, brandReference],
        );
        await holdProductSourceBarrier(tx, brandReference);
        check();
        const value = await work(tx, observedAt, check);
        check();
        await hold();
        check();
        completed = Object.freeze({ value });
        return completed;
      });
      if (calls !== 1 || !completed || answer !== completed) return fail();
      check();
      return completed.value;
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  }
  return Object.freeze({
    context: Object.freeze({ tenantReference, brandReference, actorReference, actorKind }),
    async withCurrentCoverage<T>(
      value: unknown,
      work: (
        coverage: CatalogProductRetirementCoverage,
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      const r = exact(value, ["productReference", "expectedAggregateVersion"]),
        productReference = parseCatalogReference(r.productReference);
      if (
        !Number.isSafeInteger(r.expectedAggregateVersion) ||
        (r.expectedAggregateVersion as number) < 1 ||
        (r.expectedAggregateVersion as number) > 2147483647 ||
        typeof work !== "function"
      )
        return fail();
      return read(productReference, false, async (tx, observedAt, check) => {
        const coverage = await loadProductRetirementCoverage(tx, {
          tenantReference,
          brandReference,
          productReference,
          expectedAggregateVersion: r.expectedAggregateVersion as number,
          observedAt,
        });
        check();
        return work(coverage, tx);
      });
    },
    async discoverDueSchedules(value: unknown) {
      const r = exact(value, ["afterVersionReference", "limit"]);
      if (
        actorKind !== "System" ||
        !Number.isInteger(r.limit) ||
        (r.limit as number) < 1 ||
        (r.limit as number) > 100
      )
        return fail();
      const after =
          r.afterVersionReference === null ? null : parseCatalogReference(r.afterVersionReference),
        limit = r.limit as number;
      return read(null, true, async (tx, observedAt, check) => {
        // This query locates candidates only. Every returned product is then read
        // through complete native coverage before any candidate can be exposed.
        const located = await tx.query<{
          product_id: string;
          product_version_id: string;
          aggregate_version: number;
        }>(
          `WITH latest AS (SELECT DISTINCT ON(product_id,product_version_id) product_id,product_version_id,snapshot_json,state FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 ORDER BY product_id,product_version_id,publication_version DESC)
           SELECT l.product_id,l.product_version_id,p.aggregate_version FROM latest l JOIN rms_catalog.product p ON p.product_id=l.product_id AND p.brand_id=$2
           JOIN rms_catalog.product_version v ON v.product_id=p.product_id AND v.brand_id=$2 AND v.product_version_id=l.product_version_id AND v.status='Draft'
           WHERE l.state='Scheduled' AND l.snapshot_json ? 'profile' AND (l.snapshot_json#>>'{effectivePeriod,effectiveFrom,instant}')::timestamptz<=$3::timestamptz
           AND ((l.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}') IS NULL OR (l.snapshot_json#>>'{effectivePeriod,effectiveUntil,instant}')::timestamptz>$3::timestamptz)
           AND ($4::uuid IS NULL OR l.product_version_id>$4::uuid) ORDER BY l.product_version_id LIMIT $5`,
          [tenantReference, brandReference, observedAt, after, limit],
        );
        if (located.rows.length > limit) return fail();
        const candidates: {
            readonly publication: ProductPublicationVersionV2;
            readonly expectedAggregateVersion: number;
          }[] = [],
          coverageByProduct = new Map<string, CatalogProductRetirementCoverage>();
        let previous = after;
        for (const row of located.rows) {
          const productReference = parseCatalogReference(row.product_id),
            versionReference = parseCatalogReference(row.product_version_id);
          if (
            (previous !== null && versionReference <= previous) ||
            !Number.isInteger(row.aggregate_version) ||
            row.aggregate_version < 1 ||
            row.aggregate_version >= 2147483647
          )
            return fail();
          let coverage = coverageByProduct.get(productReference);
          if (!coverage) {
            coverage = await loadProductRetirementCoverage(tx, {
              tenantReference,
              brandReference,
              productReference,
              expectedAggregateVersion: row.aggregate_version,
              observedAt,
            });
            coverageByProduct.set(productReference, coverage);
          }
          if (coverage.aggregateVersion !== row.aggregate_version) return fail();
          const p = parseProductPublicationVersionV2(
            coverage.latest.find(
              (publication) => publication.versionReference === versionReference,
            ),
          );
          if (
            p.state !== "Scheduled" ||
            p.scheduleReference === null ||
            p.effectivePeriod.effectiveFrom.instant > observedAt ||
            (p.effectivePeriod.effectiveUntil !== null &&
              p.effectivePeriod.effectiveUntil.instant <= observedAt)
          )
            return fail();
          candidates.push(
            Object.freeze({ publication: p, expectedAggregateVersion: row.aggregate_version }),
          );
          previous = versionReference;
          check();
        }
        return Object.freeze({
          candidates: Object.freeze(candidates),
          nextAfterVersionReference: candidates.length === limit ? previous : null,
        });
      });
    },
  });
}
