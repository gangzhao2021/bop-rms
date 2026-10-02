import {
  holdProductEditorContent,
  type ProductEditorContentAuthority,
} from "../../application/product-editor-content-authority.js";
import { parseProductPublicationVersion } from "../../contracts/product-publication.js";
import { catalogProductPublicationEventTypes } from "../../contracts/product-publication-event.js";
import type { ProductCategoryAssignmentAuthority } from "./product-category-assignment.js";
import { holdProductSourceBarrier, appendProductSourceCommit } from "./product-source-producer.js";
import {
  appendAuditRecordInTransaction,
  sha256Hex,
  validateAuditRecord,
  canonicalizeRfc8785,
} from "@bop/audit";
import {
  CatalogError,
  parseProductAggregate,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogHash,
  transitionCatalogLifecycle,
  type ProductAggregate,
} from "../../contracts/product.js";
import type {
  CatalogOperationRecord,
  CatalogProductRepositoryPort,
} from "../../application/ports/product-ports.js";

export interface ProductLifecycleTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
}
export interface ProductAggregateVersionReader {
  /** Exact append-only owning receipt, not the current mutable Draft. Null means
   * no historical version evidence; consumers must not synthesize a baseline.
   * Caller must hold required parent fields/Phase/purpose leases through COMMIT. */
  loadAggregateVersion(
    productReference: string,
    aggregateVersion: number,
  ): Promise<ProductAggregate | null>;
}
type Store = Pick<CatalogProductRepositoryPort, "load" | "resolveOperation" | "commit"> &
  ProductAggregateVersionReader;
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export const productSnapshotSelectSql =
  "SELECT jsonb_build_object(\n'productReference',p.product_id,'brandReference',p.brand_id,'internalCode',p.internal_code,\n'productType',p.product_type,'lifecycle',p.lifecycle,'aggregateVersion',p.aggregate_version,\n'createdAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n'createdByActorReference',p.created_by_actor_id,\n'updatedAt',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n'draft',jsonb_build_object(\n'versionReference',v.product_version_id,'baseVersionReference',v.base_product_version_id,\n'status',v.status,'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,\n'taxClassificationReference',v.tax_classification_id,\n'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n'skus',COALESCE((SELECT jsonb_agg(jsonb_build_object(\n'skuReference',s.sku_id,'productReference',s.product_id,'brandReference',s.brand_id,\n'skuCode',s.sku_code,'lifecycle',s.lifecycle,'localizedNames',s.localized_names_json,\n'variantSelections',s.variant_selections_json,'unitOfSale',s.unit_of_sale,'unitQuantity',s.unit_quantity::text,\n'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),\n'createdByActorReference',s.created_by_actor_id) ORDER BY s.sku_id)\nFROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.product_version_id=v.product_version_id),'[]'::jsonb),\n'optionBindings',COALESCE((SELECT jsonb_agg(jsonb_build_object(\n'bindingReference',b.binding_id,'optionSetReference',b.option_set_id,'optionSetVersionReference',b.option_set_version_id,\n'purpose',b.purpose,'sortOrder',b.sort_order,\n'minimumSelectionOverride',b.minimum_selection_override,'maximumSelectionOverride',b.maximum_selection_override,\n'storeOverrideAllowed',b.store_override_allowed,\n'enabledOptionReferences',COALESCE((SELECT jsonb_agg(o.option_id ORDER BY o.option_id) FROM rms_catalog.product_option_binding_option o WHERE o.binding_id=b.binding_id AND o.product_id=b.product_id AND o.brand_id=b.brand_id),'[]'::jsonb),\n'defaultSelections',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionReference',o.option_id,'quantity',o.default_quantity) ORDER BY o.option_id) FROM rms_catalog.product_option_binding_option o WHERE o.binding_id=b.binding_id AND o.product_id=b.product_id AND o.brand_id=b.brand_id AND o.default_quantity IS NOT NULL),'[]'::jsonb),\n'includedSkuReferences',COALESCE((SELECT jsonb_agg(s.sku_id ORDER BY s.sku_id) FROM rms_catalog.product_option_binding_sku_scope s WHERE s.binding_id=b.binding_id AND s.product_id=b.product_id AND s.brand_id=b.brand_id AND s.scope_kind='Include'),'[]'::jsonb),\n'excludedSkuReferences',COALESCE((SELECT jsonb_agg(s.sku_id ORDER BY s.sku_id) FROM rms_catalog.product_option_binding_sku_scope s WHERE s.binding_id=b.binding_id AND s.product_id=b.product_id AND s.brand_id=b.brand_id AND s.scope_kind='Exclude'),'[]'::jsonb),\n'channelCodes',COALESCE((SELECT jsonb_agg(c.channel_code ORDER BY c.channel_code) FROM rms_catalog.product_option_binding_channel c WHERE c.binding_id=b.binding_id AND c.product_id=b.product_id AND c.brand_id=b.brand_id),'[]'::jsonb)\n) ORDER BY b.sort_order,b.binding_id) FROM rms_catalog.product_option_binding b WHERE b.product_id=p.product_id AND b.brand_id=p.brand_id AND b.product_version_id=v.product_version_id),'[]'::jsonb)\n) || CASE WHEN v.category_classification_known THEN jsonb_build_object('categoryClassification',jsonb_build_object('categoryReferences',COALESCE((SELECT jsonb_agg(c.category_id ORDER BY c.category_id) FROM rms_catalog.product_version_category_assignment c WHERE c.brand_id=p.brand_id AND c.product_id=p.product_id AND c.product_version_id=v.product_version_id),'[]'::jsonb),'primaryCategoryReference',v.primary_category_id)) ELSE '{}'::jsonb END || CASE WHEN v.editor_content_json IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('editorContent',v.editor_content_json) END) snapshot,\n(date_trunc('milliseconds',p.created_at)=p.created_at AND date_trunc('milliseconds',p.updated_at)=p.updated_at\nAND date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at\nAND NOT EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id\nAND date_trunc('milliseconds',s.created_at)<>s.created_at)) precise\nFROM rms_catalog.product p JOIN rms_catalog.product_version v ON v.product_id=p.product_id AND v.brand_id=p.brand_id\nWHERE p.brand_id=$1 AND p.product_id=$2 AND v.status='Draft'";

/** Lifecycle-only owner adapter: never edits names/units/options or fabricates
 * historical results from the current mutable Draft. Creation/editing use their
 * own repository operations. Caller supplies current Brand permission authority.
 */
export function createPostgresProductLifecycleStore(options: {
  brandReference: string;
  categoryAssignments?: ProductCategoryAssignmentAuthority;
  editorContentAuthority?: ProductEditorContentAuthority;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  authorize(
    tx: ProductLifecycleTransaction,
    request: {
      productReference: string | null;
      record?: CatalogOperationRecord;
    },
  ): Promise<boolean>;
}): Store {
  const brand = parseCatalogReference(options.brandReference);
  const allowed = async (
    tx: ProductLifecycleTransaction,
    product: string | null,
    record?: CatalogOperationRecord,
  ) => {
    if (
      !(await options.authorize(tx, { productReference: product, ...(record ? { record } : {}) }))
    )
      return fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
    await holdProductSourceBarrier(tx, brand);
    if (record) await holdClassification(tx, options, record.aggregate, "Read");
  };
  const scoped = async <T>(
    product: string | null,
    work: (tx: ProductLifecycleTransaction) => Promise<T>,
  ) =>
    options.transactions.run(async (tx) => {
      await allowed(tx, product);
      const result = await work(tx);
      await allowed(tx, product);
      return result;
    });
  const load = async (
    tx: ProductLifecycleTransaction,
    product: string,
  ): Promise<ProductAggregate | null> => {
    const rows = (await tx.query(productSnapshotSelectSql, [brand, product])).rows;
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !rows[0] || rows[0].precise !== true) return fail();
    const result = parseProductAggregate(rows[0].snapshot);
    if (result.productReference !== product || result.brandReference !== brand) return fail();
    await holdClassification(tx, options, result, "Read");
    return result;
  };
  const replay = async (
    tx: ProductLifecycleTransaction,
    operation: string,
  ): Promise<CatalogOperationRecord | null> => {
    const rows = (
      await tx.query(
        "SELECT r.product_id,r.action_code,r.intent_digest,r.result_aggregate_version,r.occurred_at,s.snapshot_json,s.brand_id snapshot_brand,s.product_id snapshot_product,s.result_aggregate_version snapshot_version,s.occurred_at snapshot_time FROM rms_catalog.product_operation_record r LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=r.operation_id WHERE r.brand_id=$1 AND r.operation_id=$2",
        [brand, operation],
      )
    ).rows;
    if (rows.length === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || !row) return fail();
    const product = parseCatalogReference(row.product_id);
    await allowed(tx, product);
    if (
      !["Create", "ReplaceDraft", "ChangeLifecycle"].includes(String(row.action_code)) ||
      typeof row.intent_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(row.intent_digest) ||
      !(row.occurred_at instanceof Date) ||
      !(row.snapshot_time instanceof Date) ||
      row.snapshot_brand !== brand ||
      row.snapshot_product !== product ||
      row.snapshot_version !== row.result_aggregate_version ||
      row.snapshot_time.toISOString() !== row.occurred_at.toISOString()
    )
      return fail();
    const aggregate = parseProductAggregate(row.snapshot_json);
    if (
      aggregate.brandReference !== brand ||
      aggregate.productReference !== product ||
      aggregate.aggregateVersion !== row.result_aggregate_version ||
      aggregate.updatedAt !== row.occurred_at.toISOString()
    )
      return fail();
    await holdClassification(tx, options, aggregate, "Read");
    return {
      action: row.action_code as CatalogOperationRecord["action"],
      operationReference: parseCatalogReference(operation),
      operationIntentHash: parseCatalogHash(row.intent_digest.slice(7)),
      aggregate,
    };
  };
  return Object.freeze<Store>({
    load: (reference) => scoped(parseCatalogReference(reference), (tx) => load(tx, reference)),
    loadAggregateVersion(reference, version) {
      const product = parseCatalogReference(reference);
      if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647)
        return fail("CATALOG_INPUT_INVALID");
      return scoped(product, async (tx) => {
        const rows = (
          await tx.query(
            "SELECT operation_id,action_code FROM rms_catalog.product_operation_record WHERE brand_id=$1 AND product_id=$2 AND result_aggregate_version=$3 ORDER BY operation_id LIMIT 2",
            [brand, product, version],
          )
        ).rows;
        if (!Array.isArray(rows)) return fail();
        if (rows.length === 0) return null;
        if (rows.length !== 1 || !rows[0]) return fail();
        try {
          // Original operations/snapshots cannot mutate. Read in this exact held
          // transaction without taking an older operation lock after a Product lock.
          const operation = parseCatalogReference(rows[0].operation_id);
          if (rows[0].action_code === "ProductPublication") {
            // Publication produces the successor Draft in this same owning
            // namespace. Version reads admit its exact append-only receipt;
            // legacy operation replay still refuses publication commands.
            const receipts = (
              await tx.query(
                "SELECT CASE WHEN octet_length(s.snapshot_json::text)<=8388608 THEN s.snapshot_json END aggregate,p.snapshot_json publication,p.tenant_id,p.action_code,p.occurred_at publication_time,p.intent_digest publication_intent,c.event_type,c.snapshot_digest,(r.action_code='ProductPublication' AND r.intent_digest=p.intent_digest AND r.result_aggregate_version=s.result_aggregate_version AND r.occurred_at=s.occurred_at AND p.result_aggregate_version=s.result_aggregate_version AND p.source_aggregate_version=s.result_aggregate_version-1 AND p.occurred_at=s.occurred_at AND c.result_aggregate_version=s.result_aggregate_version AND c.occurred_at=s.occurred_at AND c.source_revision<=h.source_revision AND p.tenant_id::text=current_setting('bop.tenant_id',true) AND p.snapshot_json->>'versionReference'=p.product_version_id::text AND p.snapshot_json->'publicationVersion'=to_jsonb(p.publication_version) AND p.snapshot_json->>'state'=p.state AND p.snapshot_json->>'actorReference'=c.actor_id::text) coherent FROM rms_catalog.product_operation_record r JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=r.operation_id AND s.brand_id=r.brand_id AND s.product_id=r.product_id JOIN rms_catalog.product_publication_revision p ON p.operation_id=r.operation_id AND p.brand_id=r.brand_id AND p.product_id=r.product_id JOIN rms_catalog.product_source_commit c ON c.operation_id=r.operation_id AND c.brand_id=r.brand_id AND c.product_id=r.product_id JOIN rms_catalog.product_source_head h ON h.brand_id=r.brand_id WHERE r.brand_id=$1 AND r.product_id=$2 AND r.operation_id=$3 AND r.result_aggregate_version=$4 LIMIT 2",
                [brand, product, operation, version],
              )
            ).rows;
            if (receipts.length !== 1 || receipts[0]?.coherent !== true) return fail();
            const receipt = receipts[0];
            const aggregate = parseProductAggregate(receipt.aggregate),
              publication = parseProductPublicationVersion(receipt.publication),
              action = receipt.action_code as keyof typeof catalogProductPublicationEventTypes;
            if (
              aggregate.brandReference !== brand ||
              aggregate.productReference !== product ||
              aggregate.aggregateVersion !== version ||
              publication.tenantReference !== receipt.tenant_id ||
              publication.brandReference !== brand ||
              publication.productReference !== product ||
              publication.operationReference !== operation ||
              publication.productAggregateVersion + 1 !== version ||
              publication.occurredAt !== aggregate.updatedAt ||
              !(receipt.publication_time instanceof Date) ||
              publication.occurredAt !== receipt.publication_time.toISOString() ||
              publication.intentDigest !== receipt.publication_intent ||
              receipt.snapshot_digest !== "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate)) ||
              !Object.hasOwn(catalogProductPublicationEventTypes, action) ||
              receipt.event_type !== catalogProductPublicationEventTypes[action] ||
              publication.state !==
                (
                  {
                    Validate: "Draft",
                    SubmitReview: "InReview",
                    Approve: "Approved",
                    Reject: "Draft",
                    Publish: "Published",
                    SchedulePublish: "Scheduled",
                    ReschedulePublish: "Scheduled",
                    CancelScheduledPublish: "Draft",
                    ActivateScheduled: "Published",
                    Supersede: "Superseded",
                  } as const
                )[action] ||
              (publication.actorKind === "System") !==
                (action === "ActivateScheduled" || action === "Supersede") ||
              (publication.state === "Published"
                ? aggregate.draft.versionReference !== publication.successorDraftVersionReference
                : publication.state !== "Superseded" &&
                  aggregate.draft.versionReference !== publication.versionReference)
            )
              return fail();
            await allowed(tx, product);
            await holdClassification(tx, options, aggregate, "Read");
            return aggregate;
          }
          const record = await replay(tx, operation);
          if (
            !record ||
            record.aggregate.productReference !== product ||
            record.aggregate.brandReference !== brand ||
            record.aggregate.aggregateVersion !== version
          )
            return fail();
          return record.aggregate;
        } catch (error) {
          if (error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID")
            return fail();
          throw error;
        }
      });
    },
    resolveOperation: (reference) =>
      scoped(null, async (tx) => {
        const operation = parseCatalogReference(reference);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProductOperation:" + brand + ":" + operation,
        ]);
        return replay(tx, operation);
      }),
    commit: (input) => {
      const aggregate = parseProductAggregate(input.record.aggregate);
      const record = { ...input.record, aggregate };
      const operation = parseCatalogReference(record.operationReference);
      const intent = parseCatalogHash(record.operationIntentHash);
      const audit = validateAuditRecord(input.audit, Date.parse(aggregate.updatedAt));
      if (
        record.action !== "ChangeLifecycle" ||
        aggregate.brandReference !== brand ||
        audit.brandId !== brand ||
        audit.storeId !== undefined ||
        audit.actor.type === "System" ||
        audit.targetType !== "CatalogProduct" ||
        audit.targetId !== aggregate.productReference ||
        audit.actionCode !== "CATALOG_PRODUCT_CHANGELIFECYCLE" ||
        audit.occurredAt !== aggregate.updatedAt
      )
        return fail("CATALOG_PERMISSION_DENIED");
      return scoped(aggregate.productReference, async (tx) => {
        await allowed(tx, aggregate.productReference, record);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProductOperation:" + brand + ":" + operation,
        ]);
        const prior = await replay(tx, operation);
        if (prior) {
          if (canonicalizeRfc8785(prior) !== canonicalizeRfc8785(record))
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProduct:" + brand + ":" + aggregate.productReference,
        ]);
        const current = await load(tx, aggregate.productReference);
        if (
          !current ||
          !Number.isSafeInteger(input.expectedAggregateVersion) ||
          current.aggregateVersion !== input.expectedAggregateVersion ||
          aggregate.aggregateVersion !== current.aggregateVersion + 1
        )
          return fail("CATALOG_VERSION_CONFLICT");
        if (aggregate.updatedAt < current.updatedAt) return fail("CATALOG_INPUT_INVALID");
        const changed = aggregate.draft.skus.filter(
          (sku) =>
            current.draft.skus.find((old) => old.skuReference === sku.skuReference)?.lifecycle !==
            sku.lifecycle,
        );
        const productChanged = aggregate.lifecycle !== current.lifecycle;
        if ((productChanged ? 1 : 0) + changed.length !== 1) return fail("CATALOG_INPUT_INVALID");
        let expected: ProductAggregate;
        if (productChanged)
          expected = {
            ...current,
            lifecycle: transitionCatalogLifecycle(current.lifecycle, aggregate.lifecycle),
            aggregateVersion: aggregate.aggregateVersion,
            updatedAt: aggregate.updatedAt,
          };
        else {
          const sku = changed[0];
          const old = current.draft.skus.find((item) => item.skuReference === sku?.skuReference);
          if (!sku || !old) return fail("CATALOG_INPUT_INVALID");
          const lifecycle = transitionCatalogLifecycle(old.lifecycle, sku.lifecycle);
          expected = {
            ...current,
            aggregateVersion: aggregate.aggregateVersion,
            updatedAt: aggregate.updatedAt,
            draft: {
              ...current.draft,
              updatedAt: aggregate.updatedAt,
              skus: current.draft.skus.map((item) =>
                item.skuReference === sku.skuReference ? { ...item, lifecycle } : item,
              ),
            },
          };
        }
        if (canonicalizeRfc8785(expected) !== canonicalizeRfc8785(aggregate))
          return fail("CATALOG_INPUT_INVALID");
        await tx.query("SAVEPOINT catalog_product_lifecycle", []);
        try {
          const updated = await tx.query(
            "UPDATE rms_catalog.product SET lifecycle=$3,aggregate_version=$4,updated_at=$5 WHERE brand_id=$1 AND product_id=$2 AND aggregate_version=$6",
            [
              brand,
              aggregate.productReference,
              aggregate.lifecycle,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
              current.aggregateVersion,
            ],
          );
          if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          if (!productChanged) {
            const sku = changed[0];
            if (!sku) return fail();
            const child = await tx.query(
              "UPDATE rms_catalog.sku SET lifecycle=$4 WHERE brand_id=$1 AND product_id=$2 AND sku_id=$3",
              [brand, aggregate.productReference, sku.skuReference, sku.lifecycle],
            );
            const version = await tx.query(
              "UPDATE rms_catalog.product_version SET updated_at=$4 WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3",
              [
                brand,
                aggregate.productReference,
                aggregate.draft.versionReference,
                aggregate.draft.updatedAt,
              ],
            );
            if (child.rowCount !== 1 || version.rowCount !== 1) return fail();
          }
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_record VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              operation,
              brand,
              aggregate.productReference,
              record.action,
              "sha256:" + intent,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
            ],
          );
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
            [
              operation,
              brand,
              aggregate.productReference,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
              JSON.stringify(aggregate),
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          await appendProductSourceCommit(tx, record, audit, current);
          await allowed(tx, aggregate.productReference, record);
          const saved = await load(tx, aggregate.productReference);
          if (canonicalizeRfc8785(saved) !== canonicalizeRfc8785(aggregate)) return fail();
          await tx.query("RELEASE SAVEPOINT catalog_product_lifecycle", []);
          return record;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT catalog_product_lifecycle", []);
          await tx.query("RELEASE SAVEPOINT catalog_product_lifecycle", []);
          throw error;
        }
      });
    },
  });
}

/** Initial Product graph writer. Draft replacement is a separate operation;
 * initial SKU ordering is preserved in immutable results, not inferred from rows. */
export function createPostgresProductCreationStore(
  options: Parameters<typeof createPostgresProductLifecycleStore>[0],
): Pick<CatalogProductRepositoryPort, "load" | "resolveOperation" | "create" | "codeAvailable"> {
  const brand = parseCatalogReference(options.brandReference);
  const existing = createPostgresProductLifecycleStore(options);
  const allowed = async (
    tx: ProductLifecycleTransaction,
    product: string | null,
    record?: CatalogOperationRecord,
  ) => {
    if (
      !(await options.authorize(tx, { productReference: product, ...(record ? { record } : {}) }))
    )
      return fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
    await holdProductSourceBarrier(tx, brand);
    if (record) await holdClassification(tx, options, record.aggregate, "Read");
  };
  const codes = async (
    tx: ProductLifecycleTransaction,
    productCode: string,
    skuCodes: readonly string[],
    excluding: string | null,
  ) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CatalogProductCodes:" + brand,
    ]);
    const result = await tx.query<{ available: boolean }>(
      "SELECT NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND internal_code=$2 AND ($4::uuid IS NULL OR product_id<>$4)) AND NOT EXISTS(SELECT 1 FROM rms_catalog.sku WHERE brand_id=$1 AND sku_code=ANY($3::text[]) AND ($4::uuid IS NULL OR product_id<>$4)) AS available",
      [brand, productCode, skuCodes, excluding],
    );
    if (result.rows.length !== 1 || typeof result.rows[0]?.available !== "boolean") return fail();
    return result.rows[0].available;
  };
  return Object.freeze({
    load: existing.load,
    resolveOperation: existing.resolveOperation,
    codeAvailable: async (input) => {
      if (parseCatalogReference(input.brandReference) !== brand)
        return fail("CATALOG_PERMISSION_DENIED");
      const code = parseCatalogCode(input.productCode);
      const skuCodes = input.skuCodes.map(parseCatalogCode);
      const excluding =
        input.excludingProductReference === null
          ? null
          : parseCatalogReference(input.excludingProductReference);
      return options.transactions.run(async (tx) => {
        await allowed(tx, excluding);
        const available = await codes(tx, code, skuCodes, excluding);
        await allowed(tx, excluding);
        return available;
      });
    },
    create: async (input) => {
      const aggregate = parseProductAggregate(input.record.aggregate);
      const record = { ...input.record, aggregate };
      const operation = parseCatalogReference(record.operationReference);
      const intent = parseCatalogHash(record.operationIntentHash);
      const audit = validateAuditRecord(input.audit, Date.parse(aggregate.createdAt));
      const variantKey = (sku: ProductAggregate["draft"]["skus"][number]) =>
        JSON.stringify(
          [...sku.variantSelections].sort((a, b) =>
            a.dimensionReference.localeCompare(b.dimensionReference),
          ),
        );
      if (new Set(aggregate.draft.skus.map(variantKey)).size !== aggregate.draft.skus.length)
        return fail("CATALOG_INPUT_INVALID");

      if (
        record.action !== "Create" ||
        aggregate.brandReference !== brand ||
        audit.brandId !== brand ||
        audit.storeId !== undefined ||
        audit.actor.type === "System" ||
        audit.actor.reference !== aggregate.createdByActorReference ||
        audit.targetType !== "CatalogProduct" ||
        audit.targetId !== aggregate.productReference ||
        audit.actionCode !== "CATALOG_PRODUCT_CREATE" ||
        audit.occurredAt !== aggregate.createdAt
      )
        return fail("CATALOG_PERMISSION_DENIED");
      if (
        aggregate.aggregateVersion !== 1 ||
        aggregate.lifecycle !== "Draft" ||
        aggregate.updatedAt !== aggregate.createdAt ||
        aggregate.draft.baseVersionReference !== null ||
        aggregate.draft.createdAt !== aggregate.createdAt ||
        aggregate.draft.updatedAt !== aggregate.createdAt ||
        aggregate.draft.optionBindings.length !== 0 ||
        aggregate.draft.skus.some(
          (sku) =>
            sku.lifecycle !== "Draft" ||
            sku.createdAt !== aggregate.createdAt ||
            sku.createdByActorReference !== aggregate.createdByActorReference ||
            !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(sku.unitQuantity) ||
            !/[1-9]/.test(sku.unitQuantity),
        )
      )
        return fail("CATALOG_INPUT_INVALID");
      return options.transactions.run(async (tx) => {
        await allowed(tx, aggregate.productReference, record);
        const reader = createPostgresProductLifecycleStore({
          ...options,
          transactions: { run: (work) => work(tx) },
        });
        // resolveOperation holds the same operation fence used by all Product mutations.
        const prior = await reader.resolveOperation(operation);
        if (prior) {
          if (canonicalizeRfc8785(prior) !== canonicalizeRfc8785(record))
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        if (
          !(await codes(
            tx,
            aggregate.internalCode,
            aggregate.draft.skus.map((sku) => sku.skuCode),
            null,
          ))
        )
          return fail("CATALOG_CODE_CONFLICT");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProduct:" + brand + ":" + aggregate.productReference,
        ]);
        if (await reader.load(aggregate.productReference)) return fail("CATALOG_CODE_CONFLICT");
        await tx.query("SAVEPOINT catalog_product_create", []);
        try {
          await holdClassification(tx, options, aggregate, "Write");
          await tx.query(
            "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,'Draft',1,$5,$6,$5)",
            [
              aggregate.productReference,
              brand,
              aggregate.internalCode,
              aggregate.productType,
              aggregate.createdAt,
              aggregate.createdByActorReference,
            ],
          );
          const draft = aggregate.draft;
          await tx.query(
            "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,base_product_version_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at,category_classification_known,primary_category_id,editor_content_json) VALUES($1,$2,$3,NULL,'Draft',$4,$5,$6,$7,$7,$8,$9,$10)",
            [
              draft.versionReference,
              aggregate.productReference,
              brand,
              draft.defaultLocale,
              JSON.stringify(draft.localizedNames),
              draft.taxClassificationReference,
              aggregate.createdAt,
              draft.categoryClassification !== undefined,
              draft.categoryClassification?.primaryCategoryReference ?? null,
              draft.editorContent === undefined ? null : JSON.stringify(draft.editorContent),
            ],
          );
          for (const category of draft.categoryClassification?.categoryReferences ?? [])
            await tx.query(
              "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
              [draft.versionReference, aggregate.productReference, brand, category],
            );
          for (const sku of draft.skus) {
            await tx.query(
              "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Draft',$6,$7,$8,$9,$10,$11,$12)",
              [
                sku.skuReference,
                aggregate.productReference,
                brand,
                draft.versionReference,
                sku.skuCode,
                JSON.stringify(sku.localizedNames),
                JSON.stringify(sku.variantSelections),
                "sha256:" + sha256Hex(variantKey(sku)),
                sku.unitOfSale,
                sku.unitQuantity,
                sku.createdAt,
                sku.createdByActorReference,
              ],
            );
          }
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_record VALUES($1,$2,$3,'Create',$4,1,$5)",
            [operation, brand, aggregate.productReference, "sha256:" + intent, aggregate.createdAt],
          );
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,1,$4,$5)",
            [
              operation,
              brand,
              aggregate.productReference,
              aggregate.createdAt,
              JSON.stringify(aggregate),
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          await appendProductSourceCommit(tx, record, audit, null);
          await allowed(tx, aggregate.productReference, record);
          const saved = await reader.load(aggregate.productReference);
          const ordered = (value: ProductAggregate | null) =>
            value === null
              ? null
              : {
                  ...value,
                  draft: {
                    ...value.draft,
                    skus: [...value.draft.skus].sort((a, b) =>
                      a.skuReference.localeCompare(b.skuReference),
                    ),
                  },
                };
          if (canonicalizeRfc8785(ordered(saved)) !== canonicalizeRfc8785(ordered(aggregate)))
            return fail();
          await tx.query("RELEASE SAVEPOINT catalog_product_create", []);
          return record;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT catalog_product_create", []);
          await tx.query("RELEASE SAVEPOINT catalog_product_create", []);
          throw error;
        }
      });
    },
  });
}

/** Mutable Draft graph replacement. Operation/Audit history remains append-only. */
export function createPostgresProductDraftStore(
  options: Parameters<typeof createPostgresProductLifecycleStore>[0],
): Store {
  const brand = parseCatalogReference(options.brandReference);
  const allowed = async (tx: ProductLifecycleTransaction, record: CatalogOperationRecord) => {
    if (
      !(await options.authorize(tx, {
        productReference: record.aggregate.productReference,
        record,
      }))
    )
      return fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
    await holdProductSourceBarrier(tx, brand);
    // The incoming record can be a prospective candidate. Persisted reads are
    // admitted by reader.load/resolveOperation; candidate content is held as
    // DraftWrite below, after the actual current-root checks and before CAS.
  };
  const existing = createPostgresProductLifecycleStore(options);
  const variantKey = (sku: ProductAggregate["draft"]["skus"][number]) =>
    JSON.stringify(
      [...sku.variantSelections].sort((a, b) =>
        a.dimensionReference.localeCompare(b.dimensionReference),
      ),
    );
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value
        .map(ordered)
        .sort((a, b) => canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b)));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ordered(child)]));
    return value;
  };
  return Object.freeze({
    load: existing.load,
    loadAggregateVersion: existing.loadAggregateVersion,
    resolveOperation: existing.resolveOperation,
    async commit(input: Parameters<CatalogProductRepositoryPort["commit"]>[0]) {
      const aggregate = parseProductAggregate(input.record.aggregate);
      const operation = parseCatalogReference(input.record.operationReference);
      const intent = parseCatalogHash(input.record.operationIntentHash);
      const record: CatalogOperationRecord = {
        ...input.record,
        operationReference: operation,
        operationIntentHash: intent,
        aggregate,
      };
      const audit = validateAuditRecord(input.audit, Date.parse(aggregate.updatedAt));
      if (
        record.action !== "ReplaceDraft" ||
        aggregate.brandReference !== brand ||
        audit.brandId !== brand ||
        audit.storeId !== undefined ||
        audit.actor.type === "System" ||
        audit.targetType !== "CatalogProduct" ||
        audit.targetId !== aggregate.productReference ||
        audit.actionCode !== "CATALOG_PRODUCT_REPLACEDRAFT" ||
        audit.occurredAt !== aggregate.updatedAt
      )
        return fail("CATALOG_PERMISSION_DENIED");
      const actorReference = audit.actor.reference;
      if (new Set(aggregate.draft.skus.map(variantKey)).size !== aggregate.draft.skus.length)
        return fail("CATALOG_INPUT_INVALID");
      return options.transactions.run(async (tx) => {
        await allowed(tx, record);
        const reader = createPostgresProductLifecycleStore({
          ...options,
          transactions: { run: (work) => work(tx) },
        });
        const prior = await reader.resolveOperation(operation);
        if (prior) {
          if (canonicalizeRfc8785(prior) !== canonicalizeRfc8785(record))
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        // Use the same code -> Product lock order as Product creation.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProductCodes:" + brand,
        ]);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogProduct:" + brand + ":" + aggregate.productReference,
        ]);
        const current = await reader.load(aggregate.productReference);
        if (
          current?.draft.editorContent !== undefined &&
          aggregate.draft.editorContent === undefined
        )
          return fail("CATALOG_INPUT_INVALID");
        if (
          !current ||
          !Number.isSafeInteger(input.expectedAggregateVersion) ||
          current.aggregateVersion !== input.expectedAggregateVersion ||
          aggregate.aggregateVersion !== current.aggregateVersion + 1
        )
          return fail("CATALOG_VERSION_CONFLICT");
        const draft = aggregate.draft;
        if (
          aggregate.updatedAt < current.updatedAt ||
          draft.updatedAt !== aggregate.updatedAt ||
          draft.versionReference !== current.draft.versionReference ||
          draft.createdAt !== current.draft.createdAt ||
          canonicalizeRfc8785({
            ...current,
            draft,
            aggregateVersion: aggregate.aggregateVersion,
            updatedAt: aggregate.updatedAt,
          }) !== canonicalizeRfc8785(aggregate)
        )
          return fail("CATALOG_INPUT_INVALID");
        for (const sku of draft.skus) {
          const old = current.draft.skus.find(
            (candidate) => candidate.skuReference === sku.skuReference,
          );
          if (
            sku.productReference !== current.productReference ||
            sku.brandReference !== brand ||
            !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(sku.unitQuantity) ||
            !/[1-9]/.test(sku.unitQuantity)
          )
            return fail("CATALOG_INPUT_INVALID");
          if (old) {
            if (
              old.skuCode !== sku.skuCode ||
              old.unitOfSale !== sku.unitOfSale ||
              old.unitQuantity !== sku.unitQuantity ||
              old.createdAt !== sku.createdAt ||
              old.createdByActorReference !== sku.createdByActorReference
            )
              return fail("CATALOG_INPUT_INVALID");
            // Draft configuration cannot perform an action-only SKU transition.
            if (old.lifecycle !== sku.lifecycle) return fail("CATALOG_INPUT_INVALID");
          } else if (
            sku.lifecycle !== "Draft" ||
            sku.createdAt !== aggregate.updatedAt ||
            sku.createdByActorReference !== actorReference ||
            current.draft.skus.some((candidate) => candidate.skuCode === sku.skuCode)
          )
            return fail("CATALOG_INPUT_INVALID");
        }
        const available = await tx.query<{ available: boolean }>(
          "SELECT NOT EXISTS(SELECT 1 FROM rms_catalog.sku WHERE brand_id=$1 AND sku_code=ANY($2::text[]) AND product_id<>$3) AS available",
          [brand, draft.skus.map((sku) => sku.skuCode), aggregate.productReference],
        );
        if (available.rows[0]?.available !== true) return fail("CATALOG_CODE_CONFLICT");
        await tx.query("SAVEPOINT catalog_product_draft", []);
        try {
          if (
            current.draft.categoryClassification !== undefined &&
            draft.categoryClassification === undefined
          )
            return fail("CATALOG_INPUT_INVALID");
          await holdClassification(tx, options, aggregate, "Write");

          const updated = await tx.query(
            "UPDATE rms_catalog.product SET aggregate_version=$3,updated_at=$4 WHERE brand_id=$1 AND product_id=$2 AND aggregate_version=$5",
            [
              brand,
              aggregate.productReference,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
              current.aggregateVersion,
            ],
          );
          if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          for (const table of [
            "product_option_binding_option",
            "product_option_binding_sku_scope",
            "product_option_binding_channel",
          ]) {
            await tx.query(
              "DELETE FROM rms_catalog." +
                table +
                " c USING rms_catalog.product_option_binding b WHERE c.binding_id=b.binding_id AND c.brand_id=b.brand_id AND c.product_id=b.product_id AND b.brand_id=$1 AND b.product_id=$2 AND b.product_version_id=$3",
              [brand, aggregate.productReference, draft.versionReference],
            );
          }
          await tx.query(
            "DELETE FROM rms_catalog.product_option_binding WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3",
            [brand, aggregate.productReference, draft.versionReference],
          );
          await tx.query(
            "DELETE FROM rms_catalog.sku WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3 AND NOT(sku_id=ANY($4::uuid[]))",
            [
              brand,
              aggregate.productReference,
              draft.versionReference,
              draft.skus.map((sku) => sku.skuReference),
            ],
          );
          // Temporary transaction-local digests permit swaps without weakening uniqueness.
          for (const sku of current.draft.skus) {
            if (!draft.skus.some((next) => next.skuReference === sku.skuReference)) continue;
            const staged = await tx.query(
              "UPDATE rms_catalog.sku SET variant_digest=$4 WHERE brand_id=$1 AND product_id=$2 AND sku_id=$3 AND product_version_id=$5",
              [
                brand,
                aggregate.productReference,
                sku.skuReference,
                "sha256:" + sha256Hex(operation + ":" + sku.skuReference),
                draft.versionReference,
              ],
            );
            if (staged.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          }
          for (const sku of draft.skus) {
            const values = [
              sku.skuReference,
              aggregate.productReference,
              brand,
              draft.versionReference,
              sku.skuCode,
              sku.lifecycle,
              JSON.stringify(sku.localizedNames),
              JSON.stringify(sku.variantSelections),
              "sha256:" + sha256Hex(variantKey(sku)),
              sku.unitOfSale,
              sku.unitQuantity,
              sku.createdAt,
              sku.createdByActorReference,
            ];
            if (current.draft.skus.some((old) => old.skuReference === sku.skuReference)) {
              const changed = await tx.query(
                "UPDATE rms_catalog.sku SET lifecycle=$6,localized_names_json=$7,variant_selections_json=$8,variant_digest=$9 WHERE sku_id=$1 AND product_id=$2 AND brand_id=$3 AND product_version_id=$4 AND sku_code=$5 AND unit_of_sale=$10 AND unit_quantity=$11 AND created_at=$12 AND created_by_actor_id=$13",
                values,
              );
              if (changed.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
            } else
              await tx.query(
                "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
                values,
              );
          }
          const version = await tx.query(
            "UPDATE rms_catalog.product_version SET base_product_version_id=$4,default_locale=$5,localized_names_json=$6,tax_classification_id=$7,updated_at=$8,category_classification_known=$9,primary_category_id=$10,editor_content_json=$11 WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3 AND status='Draft'",
            [
              brand,
              aggregate.productReference,
              draft.versionReference,
              draft.baseVersionReference,
              draft.defaultLocale,
              JSON.stringify(draft.localizedNames),
              draft.taxClassificationReference,
              draft.updatedAt,
              draft.categoryClassification !== undefined,
              draft.categoryClassification?.primaryCategoryReference ?? null,
              draft.editorContent === undefined ? null : JSON.stringify(draft.editorContent),
            ],
          );
          if (version.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          if (draft.categoryClassification !== undefined)
            await tx.query(
              "DELETE FROM rms_catalog.product_version_category_assignment WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3",
              [brand, aggregate.productReference, draft.versionReference],
            );
          for (const category of draft.categoryClassification?.categoryReferences ?? [])
            await tx.query(
              "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
              [draft.versionReference, aggregate.productReference, brand, category],
            );
          for (const binding of draft.optionBindings) {
            await tx.query(
              "INSERT INTO rms_catalog.product_option_binding(binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [
                binding.bindingReference,
                draft.versionReference,
                aggregate.productReference,
                brand,
                binding.optionSetReference,
                binding.optionSetVersionReference,
                binding.purpose,
                binding.sortOrder,
                binding.minimumSelectionOverride,
                binding.maximumSelectionOverride,
                binding.storeOverrideAllowed,
              ],
            );
            for (const option of binding.enabledOptionReferences)
              await tx.query(
                "INSERT INTO rms_catalog.product_option_binding_option(binding_id,product_id,brand_id,option_id,option_set_id,default_quantity) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  binding.bindingReference,
                  aggregate.productReference,
                  brand,
                  option,
                  binding.optionSetReference,
                  binding.defaultSelections.find(
                    (selection) => selection.optionReference === option,
                  )?.quantity ?? null,
                ],
              );
            for (const [kind, ids] of [
              ["Include", binding.includedSkuReferences],
              ["Exclude", binding.excludedSkuReferences],
            ] as const)
              for (const sku of ids)
                await tx.query(
                  "INSERT INTO rms_catalog.product_option_binding_sku_scope(binding_id,product_id,brand_id,sku_id,scope_kind) VALUES($1,$2,$3,$4,$5)",
                  [binding.bindingReference, aggregate.productReference, brand, sku, kind],
                );
            for (const channel of binding.channelCodes)
              await tx.query(
                "INSERT INTO rms_catalog.product_option_binding_channel(binding_id,product_id,brand_id,channel_code) VALUES($1,$2,$3,$4)",
                [binding.bindingReference, aggregate.productReference, brand, channel],
              );
          }
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_record VALUES($1,$2,$3,'ReplaceDraft',$4,$5,$6)",
            [
              operation,
              brand,
              aggregate.productReference,
              "sha256:" + intent,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
            ],
          );
          await tx.query(
            "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
            [
              operation,
              brand,
              aggregate.productReference,
              aggregate.aggregateVersion,
              aggregate.updatedAt,
              JSON.stringify(aggregate),
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          await appendProductSourceCommit(tx, record, audit, current);
          await allowed(tx, record);
          const saved = await reader.load(aggregate.productReference);
          if (canonicalizeRfc8785(ordered(saved)) !== canonicalizeRfc8785(ordered(aggregate)))
            return fail();
          await tx.query("RELEASE SAVEPOINT catalog_product_draft", []);
          return record;
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT catalog_product_draft", []);
          await tx.query("RELEASE SAVEPOINT catalog_product_draft", []);
          throw error;
        }
      });
    },
  });
}

async function holdClassification(
  tx: ProductLifecycleTransaction,
  options: {
    categoryAssignments?: ProductCategoryAssignmentAuthority;
    editorContentAuthority?: ProductEditorContentAuthority;
  },
  aggregate: ProductAggregate,
  mode: "Read" | "Write",
) {
  await holdProductEditorContent(
    tx,
    options.editorContentAuthority,
    aggregate,
    mode === "Write" ? "DraftWrite" : "Read",
  );
  if (aggregate.draft.categoryClassification === undefined) return;
  if (!options.categoryAssignments) return fail();
  await options.categoryAssignments.holdUntilTransactionCompletes(tx, { mode, aggregate });
}
