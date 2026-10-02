import {
  createPostgresMenuCategorySourceStore,
  type MenuCategorySourceAuthority,
} from "./menu-category-source-store.js";
import { parseCatalogLocale as categoryTreeLocale } from "../../contracts/product.js";
import {
  categoryTreeViewFields,
  categoryTreeMenuViewFields,
  deriveCatalogCategoryTreeView,
  deriveCatalogCategoryTreeQueryView,
  parseCatalogCategoryTreeFilters,
  type CatalogCategoryTreeView,
  type CatalogCategoryTreeQueryView,
} from "../../contracts/category-tree-view.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import {
  createPostgresCategorySourceStore,
  type CategorySourceAuthority,
} from "./category-source-store.js";
import {
  productClassificationSourceFields,
  productClassificationMaximumAssignments,
  categoryProductViewFields,
  parseProductClassificationSourceSnapshot,
  deriveCatalogCategoryProductView,
  type ProductClassificationSourceSnapshot,
  type CatalogCategoryProductView,
} from "../../contracts/product-category-source.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  consumeEventInTransaction,
  validateDomainEventEnvelope,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseLocalizedNames,
  parseProductAggregate,
  parseProductCategoryClassification,
  parseProductLifecycle,
} from "../../contracts/product.js";
import {
  productListArray,
  productListCopy,
  productListRecord,
  productListType,
} from "../../contracts/product-list.js";
import {
  parseProductSearchBuildRequest,
  parseProductSearchGeneration,
  productSearchRevision,
  type ProductSearchBuildRequest,
  type ProductSearchBuildResult,
  type ProductSearchGeneration,
  type ProductSearchGenerationState,
} from "../../contracts/product-search-generation.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import { holdProductSourceBarrier, productSourceEventDigest } from "./product-source-producer.js";

export interface ProductSearchBuildAuthority {
  /** Acquire current Tenant/Brand/Actor/purpose/field/Phase and complete source-protocol
   * authority in this transaction. ALL fences must remain held until outer COMMIT or
   * rollback, including when this method is called by an Event consumer. No default grant. */
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_PRODUCT_SEARCH_BUILD" | "CATALOG_PRODUCT_CATEGORY_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly capability: "catalog.cat_product_list";
      readonly sourceProtocolVersion: 1;
      readonly requiredClassificationFields?: typeof productClassificationSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
/** Current derived-view field/Phase/purpose authority, held independently from
 * the two complete source feeds. Reading source fields is not a default grant
 * to expose count, primary-name or membership projection fields. */
export interface CategoryProductViewAuthority {
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_CATEGORY_PRODUCT_VIEW_READ";
      readonly permission: "catalog.manage";
      readonly capability: "catalog.cat_category_tree";
      readonly referencedCapability: "catalog.cat_product_list";
      readonly requiredFields: typeof categoryProductViewFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
export interface CategoryTreeViewAuthority {
  holdUntilTransactionCompletes(
    tx: ProductLifecycleTransaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ";
      readonly permission: "catalog.manage";
      readonly capability: "catalog.cat_category_tree";
      readonly referencedCapability: "catalog.cat_product_list";
      readonly requiredFields: typeof categoryTreeViewFields | typeof categoryTreeMenuViewFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const utc = (value: string) =>
  `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const eventTypes = Object.freeze([
  "ProductCreated",
  "ProductDraftUpdated",
  "ProductActivated",
  "ProductSuspended",
  "ProductResumed",
  "ProductDiscontinued",
  "ProductArchived",
  "ProductRestored",
]);
const numeric = (value: unknown, minimum = 0): number => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return unavailable();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return unavailable();
  return parsed;
};
async function rows(
  tx: ProductLifecycleTransaction,
  sql: string,
  values: readonly unknown[],
  maximum: number,
) {
  const result = await tx.query(sql, values);
  if (!result || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor)) return unavailable();
  return productListArray(descriptor.value, maximum).map((row) =>
    sql === sourcePageSql || sql === classificationPageSql
      ? copyCategoryPersistenceValue(row)
      : productListCopy(row),
  );
}
const normalizedGraph = (value: unknown): unknown => {
  if (Array.isArray(value))
    return value
      .map(normalizedGraph)
      .sort((a, b) => canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizedGraph(item)]),
    );
  return value;
};
function sourceEnvelope(value: DomainEventEnvelope): DomainEventEnvelope {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const permitted = new Set([
      "eventId",
      "eventType",
      "schemaVersion",
      "occurredAt",
      "producerModule",
      "tenantId",
      "storeId",
      "aggregateType",
      "aggregateId",
      "aggregateVersion",
      "correlationId",
      "causationId",
      "actor",
      "payload",
      "redactionClassification",
      "replayMetadata",
    ]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > permitted.size ||
      keys.some((key) => typeof key !== "string" || !permitted.has(key))
    )
      return invalid();
    const safe: Record<string, unknown> = {};
    for (const key of keys) {
      const item = descriptors[key as string];
      if (!item || !("value" in item)) return invalid();
      if (key === "aggregateVersion") {
        if (typeof item.value !== "bigint" || item.value < 1n || item.value > 2147483647n)
          return invalid();
        safe[key] = String(item.value);
      } else if (item.value !== undefined) safe[key as string] = item.value;
    }
    const copy = productListCopy(safe) as Record<string, unknown>;
    const envelope = validateDomainEventEnvelope({
      ...copy,
      aggregateVersion: BigInt(String(copy.aggregateVersion)),
    } as DomainEventEnvelope);
    if (
      !eventTypes.includes(envelope.eventType) ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/catalog" ||
      envelope.aggregateType !== "Product" ||
      envelope.storeId !== undefined ||
      envelope.actor.type !== "Actor"
    )
      return invalid();
    const payload = productListRecord(envelope.payload, [
      "productReference",
      "productVersionReference",
      "aggregateVersion",
      "lifecycle",
      "changedSkuReference",
      "sourceRevision",
      "operationReference",
      "snapshotDigest",
    ]);
    if (
      parseCatalogReference(payload.productReference) !== envelope.aggregateId ||
      payload.aggregateVersion !== String(envelope.aggregateVersion) ||
      typeof payload.snapshotDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(payload.snapshotDigest) ||
      productSearchRevision(payload.sourceRevision) === "0"
    )
      return invalid();
    parseCatalogReference(payload.productVersionReference);
    parseCatalogReference(payload.operationReference);
    parseProductLifecycle(payload.lifecycle);
    if (payload.changedSkuReference !== null) parseCatalogReference(payload.changedSkuReference);
    return envelope;
  } catch {
    return invalid();
  }
}

// Reuse the actual owner Aggregate SQL. Range pagination changes only its exact root predicate.
const sourcePageSql =
  productSnapshotSelectSql.replace(
    "AND p.product_id=$2",
    "AND ($2::uuid IS NULL OR p.product_id>$2)",
  ) + " ORDER BY p.product_id LIMIT $3";
const classificationPageSql =
  "SELECT product_id,source_json,row_digest,list_digest FROM rms_catalog.product_search_row WHERE brand_id=$1 AND generation_id=$2 AND ($3::uuid IS NULL OR product_id>$3) ORDER BY product_id LIMIT $4";
const generationSelect = `SELECT jsonb_build_object('generationReference',g.generation_id,'brandReference',g.brand_id,'sourceRevision',g.source_revision::text,'sourceDigest',g.source_digest,'projectedAt',${utc("g.projected_at")},'productCount',g.product_count,'coverage',g.source_coverage,'partial',g.is_partial) generation,
 g.actor_id,g.intent_digest,(SELECT count(*)::text FROM rms_catalog.product_search_row r WHERE r.brand_id=g.brand_id AND r.generation_id=g.generation_id) actual_count
 FROM rms_catalog.product_search_generation g WHERE g.brand_id=$1`;

export function createPostgresProductSearchGenerationStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authorization: ProductSearchBuildAuthority;
  readonly clock: { now(): string };
  /** Explicit resource budget; exceeding it fails without activating a partial snapshot. */
  readonly maximumProducts: number;
  readonly categorySource?: {
    readonly authority: CategorySourceAuthority;
    readonly viewAuthority?: CategoryProductViewAuthority;
    readonly treeAuthority?: CategoryTreeViewAuthority;
    readonly menuAuthority?: MenuCategorySourceAuthority;
    readonly maximumCategoryNodes: number;
    readonly maximumSourceCommits: number;
  };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    !Number.isSafeInteger(options.maximumProducts) ||
    options.maximumProducts < 1 ||
    options.maximumProducts > 1_000_000
  )
    return invalid();
  const authorize = async (
    tx: ProductLifecycleTransaction,
    observedAt: string,
    purposeCode:
      | "CATALOG_PRODUCT_SEARCH_BUILD"
      | "CATALOG_PRODUCT_CATEGORY_SOURCE_READ" = "CATALOG_PRODUCT_SEARCH_BUILD",
  ) => {
    const now = parseCatalogInstant(options.clock.now());
    if (observedAt > now || Date.parse(now) - Date.parse(observedAt) > 30_000) return invalid();
    await options.authorization.holdUntilTransactionCompletes(
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        purposeCode,
        permission: "catalog.manage",
        capability: "catalog.cat_product_list",
        sourceProtocolVersion: 1,
        ...(purposeCode === "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"
          ? { requiredClassificationFields: productClassificationSourceFields }
          : {}),
        observedAt,
      }),
    );
    await tx.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
      [brand],
    );
    await holdProductSourceBarrier(tx, brand);
  };
  const head = async (tx: ProductLifecycleTransaction) => {
    const values = await rows(
      tx,
      "SELECT COALESCE((SELECT source_revision::text FROM rms_catalog.product_source_head WHERE brand_id=$1),'0') revision,count(*)::text commits,COALESCE(min(source_revision),0)::text minimum,COALESCE(max(source_revision),0)::text maximum FROM rms_catalog.product_source_commit WHERE brand_id=$1",
      [brand],
      1,
    );
    if (values.length !== 1) return unavailable();
    const row = productListRecord(values[0], ["revision", "commits", "minimum", "maximum"]);
    const revision = productSearchRevision(row.revision);
    if (
      row.commits !== revision ||
      row.maximum !== revision ||
      row.minimum !== (revision === "0" ? "0" : "1")
    )
      return unavailable();
    return revision;
  };
  const generation = async (
    tx: ProductLifecycleTransaction,
    predicate: string,
    values: readonly unknown[],
  ) => {
    const found = await rows(tx, generationSelect + predicate, values, 1);
    if (found.length === 0) return null;
    if (found.length !== 1) return unavailable();
    const raw = productListRecord(found[0], [
      "generation",
      "actor_id",
      "intent_digest",
      "actual_count",
    ]);
    const value = parseProductSearchGeneration(raw.generation);
    if (
      value.brandReference !== brand ||
      value.productCount > options.maximumProducts ||
      value.productCount !== numeric(raw.actual_count) ||
      typeof raw.intent_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(raw.intent_digest)
    )
      return unavailable();
    return { value, actor: parseCatalogReference(raw.actor_id), intent: raw.intent_digest };
  };
  const current = async (tx: ProductLifecycleTransaction) => {
    const active = await rows(
      tx,
      "SELECT generation_id FROM rms_catalog.product_search_activation WHERE brand_id=$1",
      [brand],
      1,
    );
    if (active.length === 0) return null;
    if (active.length !== 1) return unavailable();
    const row = productListRecord(active[0], ["generation_id"]);
    const selected = await generation(tx, " AND g.generation_id=$2", [
      brand,
      parseCatalogReference(row.generation_id),
    ]);
    if (!selected) return unavailable();
    return selected.value;
  };
  const state = async (
    tx: ProductLifecycleTransaction,
    value: ProductSearchGeneration,
  ): Promise<ProductSearchGenerationState> => {
    const active = await current(tx);
    if (!active || active.generationReference !== value.generationReference) return "Superseded";
    if ((await head(tx)) !== value.sourceRevision) return "Changed";
    const now = parseCatalogInstant(options.clock.now());
    return now < value.projectedAt || Date.parse(now) - Date.parse(value.projectedAt) > 30_000
      ? "Stale"
      : "Current";
  };
  const verifyEvent = async (tx: ProductLifecycleTransaction, event: DomainEventEnvelope) => {
    if (event.tenantId !== brand) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    const evidence = await rows(
      tx,
      "SELECT c.event_digest,c.actor_id,c.correlation_id,c.source_revision::text revision,c.product_id,c.result_aggregate_version,c.snapshot_digest,s.snapshot_json FROM rms_catalog.product_source_commit c JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=c.operation_id AND s.brand_id=c.brand_id AND s.product_id=c.product_id AND s.result_aggregate_version=c.result_aggregate_version WHERE c.brand_id=$1 AND c.event_id=$2 AND c.event_type=$3 AND c.operation_id=$4",
      [brand, event.eventId, event.eventType, event.payload.operationReference],
      1,
    );
    if (evidence.length !== 1) return invalid();
    const row = productListRecord(evidence[0], [
      "event_digest",
      "actor_id",
      "correlation_id",
      "revision",
      "product_id",
      "result_aggregate_version",
      "snapshot_digest",
      "snapshot_json",
    ]);
    if (
      row.event_digest !== productSourceEventDigest(event) ||
      event.actor.type !== "Actor" ||
      row.actor_id !== event.actor.actorId ||
      row.correlation_id !== event.correlationId ||
      row.revision !== event.payload.sourceRevision ||
      row.product_id !== event.aggregateId ||
      row.result_aggregate_version !== Number(event.aggregateVersion) ||
      row.snapshot_digest !== event.payload.snapshotDigest ||
      digest(row.snapshot_json) !== row.snapshot_digest
    )
      return invalid();
  };
  const build = async (
    tx: ProductLifecycleTransaction,
    request: ProductSearchBuildRequest,
    kind: "Rebuild" | "Event",
  ): Promise<ProductSearchBuildResult> => {
    const intent = digest({
      brand,
      actor,
      kind,
      operationReference: request.operationReference,
      purpose: "CATALOG_PRODUCT_SEARCH_BUILD",
      sourceProtocolVersion: 1,
    });
    const prior = await generation(tx, " AND g.build_kind=$2 AND g.operation_id=$3", [
      brand,
      kind,
      request.operationReference,
    ]);
    if (prior) {
      if (prior.actor !== actor || prior.intent !== intent)
        throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
      return Object.freeze({
        status: "AlreadyBuilt",
        generation: prior.value,
        state: await state(tx, prior.value),
      });
    }
    const revision = await head(tx);
    const counts = await rows(
      tx,
      "SELECT count(*)::text count FROM rms_catalog.product WHERE brand_id=$1",
      [brand],
      1,
    );
    if (counts.length !== 1) return unavailable();
    const count = numeric(productListRecord(counts[0], ["count"]).count);
    if (count > options.maximumProducts) return unavailable();
    const references: {
      reference: string;
      source: Record<string, unknown>;
      checksum: string;
      list: Record<string, unknown>;
      listChecksum: string;
    }[] = [];
    let last: string | null = null;
    while (true) {
      const page = await rows(tx, sourcePageSql, [brand, last, 200], 200);
      if (page.length === 0) break;
      for (const item of page) {
        const entry = productListRecord(item, ["snapshot", "precise"]);
        if (entry.precise !== true) return unavailable();
        const snapshot = productListRecord(entry.snapshot, [
          "productReference",
          "brandReference",
          "internalCode",
          "productType",
          "lifecycle",
          "aggregateVersion",
          "createdAt",
          "createdByActorReference",
          "updatedAt",
          "draft",
        ]);
        const reference = parseCatalogReference(snapshot.productReference);
        if (snapshot.brandReference !== brand || (last !== null && reference <= last))
          return unavailable();
        const rawDraft = productListRecord(snapshot.draft, [
          "versionReference",
          "baseVersionReference",
          "status",
          "defaultLocale",
          "localizedNames",
          "taxClassificationReference",
          "createdAt",
          "updatedAt",
          "skus",
          "optionBindings",
          ...(Object.hasOwn(snapshot.draft as object, "categoryClassification")
            ? ["categoryClassification"]
            : []),
        ]);
        const createdAt = parseCatalogInstant(snapshot.createdAt),
          updatedAt = parseCatalogInstant(snapshot.updatedAt),
          draftUpdatedAt = parseCatalogInstant(rawDraft.updatedAt);
        if (
          createdAt > updatedAt ||
          draftUpdatedAt > updatedAt ||
          rawDraft.status !== "Draft" ||
          !Number.isSafeInteger(snapshot.aggregateVersion) ||
          (snapshot.aggregateVersion as number) < 1
        )
          return unavailable();
        const known = await rows(
          tx,
          "SELECT c.result_aggregate_version,c.snapshot_digest,c.actor_id,s.snapshot_json FROM rms_catalog.product_source_commit c JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=c.operation_id AND s.brand_id=c.brand_id AND s.product_id=c.product_id WHERE c.brand_id=$1 AND c.product_id=$2 ORDER BY c.result_aggregate_version DESC LIMIT 1",
          [brand, reference],
          1,
        );
        let updatedBy: string | null = null;
        if (known.length) {
          const saved = productListRecord(known[0], [
            "result_aggregate_version",
            "snapshot_digest",
            "actor_id",
            "snapshot_json",
          ]);
          if (
            saved.result_aggregate_version !== snapshot.aggregateVersion ||
            digest(saved.snapshot_json) !== saved.snapshot_digest ||
            canonicalizeRfc8785(normalizedGraph(parseProductAggregate(saved.snapshot_json))) !==
              canonicalizeRfc8785(normalizedGraph(parseProductAggregate(snapshot)))
          )
            return unavailable();
          updatedBy = parseCatalogReference(saved.actor_id);
        }
        const names = parseLocalizedNames(rawDraft.localizedNames, rawDraft.defaultLocale);
        const skus = productListArray(rawDraft.skus, 100).map((item) => {
          const sku = productListRecord(item, [
            "skuReference",
            "productReference",
            "brandReference",
            "skuCode",
            "lifecycle",
            "localizedNames",
            "variantSelections",
            "unitOfSale",
            "unitQuantity",
            "createdAt",
            "createdByActorReference",
          ]);
          if (
            sku.productReference !== reference ||
            sku.brandReference !== brand ||
            parseCatalogInstant(sku.createdAt) > updatedAt
          )
            return unavailable();
          return Object.freeze({
            skuReference: parseCatalogReference(sku.skuReference),
            skuCode: parseCatalogCode(sku.skuCode),
            lifecycle: parseProductLifecycle(sku.lifecycle),
            localizedNames: parseLocalizedNames(sku.localizedNames, rawDraft.defaultLocale),
          });
        });
        if (
          new Set(skus.map((sku) => sku.skuReference)).size !== skus.length ||
          new Set(skus.map((sku) => sku.skuCode)).size !== skus.length
        )
          return unavailable();
        const source = Object.freeze({
          productReference: reference,
          brandReference: brand,
          internalCode: parseCatalogCode(snapshot.internalCode),
          productType: productListType(snapshot.productType),
          lifecycle: parseProductLifecycle(snapshot.lifecycle),
          aggregateVersion: snapshot.aggregateVersion,
          createdAt,
          createdByActorReference: parseCatalogReference(snapshot.createdByActorReference),
          updatedAt,
          updatedByActorReference: updatedBy,
          productVersionReference: parseCatalogReference(rawDraft.versionReference),
          configuration: "Draft",
          draftUpdatedAt,
          defaultLocale: rawDraft.defaultLocale,
          localizedNames: names,
          taxClassificationReference:
            rawDraft.taxClassificationReference === null
              ? null
              : parseCatalogReference(rawDraft.taxClassificationReference),
          skuCount: skus.length,
          activeSkuCount: skus.filter((sku) => sku.lifecycle === "Active").length,
          skuSearch: skus,
          ...(Object.hasOwn(rawDraft, "categoryClassification")
            ? {
                categoryClassification: parseProductCategoryClassification(
                  rawDraft.categoryClassification,
                ),
              }
            : {}),
        });
        const list = Object.freeze({
          productReference: reference,
          brandReference: brand,
          internalCode: source.internalCode,
          productType: source.productType,
          lifecycle: source.lifecycle,
          aggregateVersion: String(source.aggregateVersion),
          updatedAt,
          createdAt,
          draftUpdatedAt,
          productVersionReference: source.productVersionReference,
          defaultLocale: rawDraft.defaultLocale,
          localizedNames: names,
          skuCount: String(skus.length),
          activeSkuCount: String(source.activeSkuCount),
          precise: true,
          skuSearch: skus.map((sku) => ({
            skuCode: sku.skuCode,
            localizedNames: sku.localizedNames,
          })),
        });
        references.push({
          reference,
          source,
          checksum: digest(source),
          list,
          listChecksum: digest(list),
        });
        if (references.length > count || references.length > options.maximumProducts)
          return unavailable();
        last = reference;
      }
    }
    if (references.length !== count) return unavailable();
    const clock = await rows(tx, `SELECT ${utc("statement_timestamp()")} projected_at`, [], 1);
    if (clock.length !== 1) return unavailable();
    const projectedAt = parseCatalogInstant(
      productListRecord(clock[0], ["projected_at"]).projected_at,
    );
    if (references.some((row) => String(row.source.updatedAt) > projectedAt)) return unavailable();
    const sourceDigest = digest({
      brandReference: brand,
      sourceRevision: revision,
      coverage: "CatalogProductDraftV1",
      rows: references.map((row) => ({
        productReference: row.reference,
        rowDigest: row.checksum,
        listDigest: row.listChecksum,
      })),
    });
    const hash = sha256Hex(
      "CatalogProductSearchGeneration:v1:" + brand + ":" + kind + ":" + request.operationReference,
    );
    const generationReference = parseCatalogReference(
      request.operationReference.slice(0, 14) +
        "7" +
        hash.slice(0, 3) +
        "-8" +
        hash.slice(3, 6) +
        "-" +
        hash.slice(6, 18),
    );
    const value = parseProductSearchGeneration({
      generationReference,
      brandReference: brand,
      sourceRevision: revision,
      sourceDigest,
      projectedAt,
      productCount: count,
      coverage: "CatalogProductDraftV1",
      partial: true,
    });
    await tx.query("SAVEPOINT catalog_product_search_build", []);
    try {
      const inserted = await tx.query(
        "INSERT INTO rms_catalog.product_search_generation(generation_id,brand_id,operation_id,build_kind,actor_id,intent_digest,source_revision,source_digest,projected_at,product_count,source_coverage,is_partial) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CatalogProductDraftV1',true)",
        [
          generationReference,
          brand,
          request.operationReference,
          kind,
          actor,
          intent,
          revision,
          sourceDigest,
          projectedAt,
          count,
        ],
      );
      if (inserted.rowCount !== 1) return unavailable();
      for (const row of references) {
        const insertedRow = await tx.query(
          "INSERT INTO rms_catalog.product_search_row(generation_id,brand_id,product_id,source_json,row_digest,list_json,list_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            generationReference,
            brand,
            row.reference,
            JSON.stringify(row.source),
            row.checksum,
            JSON.stringify(row.list),
            row.listChecksum,
          ],
        );
        if (insertedRow.rowCount !== 1) return unavailable();
      }
      const readback = await generation(tx, " AND g.generation_id=$2", [
        brand,
        generationReference,
      ]);
      if (
        !readback ||
        canonicalizeRfc8785(readback.value) !== canonicalizeRfc8785(value) ||
        (await head(tx)) !== revision
      )
        return unavailable();
      const activated = await tx.query(
        "INSERT INTO rms_catalog.product_search_activation(brand_id,generation_id,source_revision,source_digest) VALUES($1,$2,$3,$4) ON CONFLICT(brand_id) DO UPDATE SET generation_id=EXCLUDED.generation_id,source_revision=EXCLUDED.source_revision,source_digest=EXCLUDED.source_digest",
        [brand, generationReference, revision, sourceDigest],
      );
      if (activated.rowCount !== 1) return unavailable();
      const savedState = await state(tx, value);
      await tx.query("RELEASE SAVEPOINT catalog_product_search_build", []);
      return Object.freeze({ status: "Built", generation: value, state: savedState });
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT catalog_product_search_build", []);
      await tx.query("RELEASE SAVEPOINT catalog_product_search_build", []);
      throw error;
    }
  };
  const registrations = eventTypes.map((eventType) =>
    Object.freeze({
      consumerName: "catalog.product-search-projection:v1",
      consumerVersion: 1,
      eventType,
      schemaVersions: [1],
      ownerModule: "@rms/catalog",
      tenantScope: "brand",
      ordering: "aggregate",
      sideEffect: "replace_product_search_projection",
      replaySafe: true,
      handler: async ({ transaction, envelope }) => {
        const active = await current(transaction);
        if (active && (await state(transaction, active)) === "Current")
          return { status: "completed", resultHash: active.sourceDigest.slice(7) };
        const result = await build(
          transaction,
          {
            operationReference: envelope.eventId,
            actorReference: actor,
            observedAt: options.clock.now(),
          },
          "Event",
        );
        return { status: "completed", resultHash: result.generation.sourceDigest.slice(7) };
      },
    } satisfies ConsumerRegistration),
  );
  const consume = async (tx: ConsumerTransaction, value: DomainEventEnvelope) => {
    const event = sourceEnvelope(value);
    await authorize(tx, parseCatalogInstant(options.clock.now()));
    await verifyEvent(tx, event);
    const registration = registrations.find((item) => item.eventType === event.eventType);
    if (!registration) return invalid();
    await tx.query("SAVEPOINT catalog_product_search_event", []);
    try {
      const outcome = await consumeEventInTransaction(tx, registration, event);
      await tx.query("RELEASE SAVEPOINT catalog_product_search_event", []);
      return outcome;
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT catalog_product_search_event", []);
      await tx.query("RELEASE SAVEPOINT catalog_product_search_event", []);
      throw error;
    }
  };
  const classificationSource = async (
    tx: ProductLifecycleTransaction,
  ): Promise<ProductClassificationSourceSnapshot> => {
    await requireCategoryCurrentReads(tx);
    await authorize(
      tx,
      parseCatalogInstant(options.clock.now()),
      "CATALOG_PRODUCT_CATEGORY_SOURCE_READ",
    );
    const selected = await current(tx);
    if (!selected || selected.productCount > 10000 || (await state(tx, selected)) !== "Current")
      return unavailable();
    const products: Record<string, unknown>[] = [],
      checksums: Record<string, unknown>[] = [];
    let last: string | null = null,
      assignmentCount = 0;
    while (true) {
      const page = await rows(
        tx,
        classificationPageSql,
        [brand, selected.generationReference, last, 200],
        200,
      );
      if (page.length === 0) break;
      for (const value of page) {
        const row = productListRecord(value, [
          "product_id",
          "source_json",
          "row_digest",
          "list_digest",
        ]);
        const source = productListRecord(row.source_json, [
          "productReference",
          "brandReference",
          "internalCode",
          "productType",
          "lifecycle",
          "aggregateVersion",
          "createdAt",
          "createdByActorReference",
          "updatedAt",
          "updatedByActorReference",
          "productVersionReference",
          "configuration",
          "draftUpdatedAt",
          "defaultLocale",
          "localizedNames",
          "taxClassificationReference",
          "skuCount",
          "activeSkuCount",
          "skuSearch",
          ...(Object.hasOwn(row.source_json as object, "categoryClassification")
            ? ["categoryClassification"]
            : []),
        ]);
        const reference = parseCatalogReference(row.product_id);
        if (
          reference !== source.productReference ||
          source.brandReference !== brand ||
          source.configuration !== "Draft" ||
          (last !== null && reference <= last) ||
          digest(source) !== row.row_digest ||
          typeof row.list_digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(row.list_digest)
        )
          return unavailable();
        const classification = Object.hasOwn(source, "categoryClassification")
          ? parseProductCategoryClassification(source.categoryClassification)
          : undefined;
        assignmentCount += classification?.categoryReferences.length ?? 0;
        if (assignmentCount > productClassificationMaximumAssignments) return unavailable();
        products.push({
          productReference: reference,
          productVersionReference: parseCatalogReference(source.productVersionReference),
          lifecycle: parseProductLifecycle(source.lifecycle),
          ...(classification === undefined ? {} : { categoryClassification: classification }),
        });
        checksums.push({
          productReference: reference,
          rowDigest: row.row_digest,
          listDigest: row.list_digest,
        });
        if (products.length > selected.productCount || products.length > options.maximumProducts)
          return unavailable();
        last = reference;
      }
    }
    if (
      products.length !== selected.productCount ||
      digest({
        brandReference: brand,
        sourceRevision: selected.sourceRevision,
        coverage: "CatalogProductDraftV1",
        rows: checksums,
      }) !== selected.sourceDigest
    )
      return unavailable();
    return parseProductClassificationSourceSnapshot({
      generation: selected,
      observedAt: options.clock.now(),
      products,
    });
  };
  const combinedCategorySources = async (tx: ProductLifecycleTransaction) => {
    const categoryOptions = options.categorySource;
    if (!categoryOptions) return unavailable();
    const products = await classificationSource(tx);
    const categories = await createPostgresCategorySourceStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      transactions: { run: (work) => work(tx) },
      authority: categoryOptions.authority,
      clock: options.clock,
      maximumCategoryNodes: categoryOptions.maximumCategoryNodes,
      maximumSourceCommits: categoryOptions.maximumSourceCommits,
    }).loadSnapshot();
    await authorize(
      tx,
      parseCatalogInstant(options.clock.now()),
      "CATALOG_PRODUCT_CATEGORY_SOURCE_READ",
    );
    if ((await state(tx, products.generation)) !== "Current") return unavailable();
    return { products, categories };
  };
  const treeQuery = async (
    requestedLocale: unknown,
    filters: ReturnType<typeof parseCatalogCategoryTreeFilters> | null,
  ): Promise<CatalogCategoryTreeView | CatalogCategoryTreeQueryView> => {
    const locale = categoryTreeLocale(requestedLocale);
    const holder = options.categorySource?.treeAuthority;
    const menuAuthority = options.categorySource?.menuAuthority;
    if (typeof holder?.holdUntilTransactionCompletes !== "function") return unavailable();
    try {
      return await options.transactions.run(async (tx) => {
        await holder.holdUntilTransactionCompletes(
          tx,
          Object.freeze({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            purposeCode: "CATALOG_CATEGORY_TREE_VIEW_READ",
            permission: "catalog.manage",
            capability: "catalog.cat_category_tree",
            referencedCapability: "catalog.cat_product_list",
            requiredFields:
              menuAuthority === undefined ? categoryTreeViewFields : categoryTreeMenuViewFields,
            observedAt: parseCatalogInstant(options.clock.now()),
          }),
        );
        const menu =
          menuAuthority === undefined
            ? undefined
            : await createPostgresMenuCategorySourceStore({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                transactions: { run: async (work) => work(tx) },
                authority: menuAuthority,
                clock: options.clock,
              }).loadSnapshot();
        const { products, categories } = await combinedCategorySources(tx);
        const result =
          filters === null
            ? deriveCatalogCategoryTreeView(products, categories, locale, menu)
            : deriveCatalogCategoryTreeQueryView(products, categories, locale, filters, menu);
        const view = "tree" in result ? result.tree : result;
        const completed = parseCatalogInstant(options.clock.now());
        if (
          view.projection.asOfUtc > completed ||
          Date.parse(completed) - Date.parse(view.projection.asOfUtc) > 5000 ||
          Date.parse(completed) - Date.parse(view.source.products.asOfUtc) > 30000 ||
          (view.source.menu !== undefined &&
            Date.parse(completed) - Date.parse(view.source.menu.asOfUtc) > 5000)
        )
          return unavailable();
        return result;
      });
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return unavailable();
    }
  };
  return Object.freeze({
    async loadCategoryTreeView(requestedLocale: unknown): Promise<CatalogCategoryTreeView> {
      const result = await treeQuery(requestedLocale, null);
      if ("tree" in result) return unavailable();
      return result;
    },
    async loadCategoryTreeQuery(
      requestedLocale: unknown,
      filterValue: unknown,
    ): Promise<CatalogCategoryTreeQueryView> {
      const filters = parseCatalogCategoryTreeFilters(filterValue);
      const result = await treeQuery(requestedLocale, filters);
      if (!("tree" in result)) return unavailable();
      return result;
    },
    async loadClassificationSnapshot(): Promise<ProductClassificationSourceSnapshot> {
      try {
        return await options.transactions.run(classificationSource);
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
    async loadCategoryProductView(): Promise<CatalogCategoryProductView> {
      const holder = options.categorySource?.viewAuthority;
      if (typeof holder?.holdUntilTransactionCompletes !== "function") return unavailable();
      try {
        return await options.transactions.run(async (tx) => {
          await holder.holdUntilTransactionCompletes(
            tx,
            Object.freeze({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              purposeCode: "CATALOG_CATEGORY_PRODUCT_VIEW_READ",
              permission: "catalog.manage",
              capability: "catalog.cat_category_tree",
              referencedCapability: "catalog.cat_product_list",
              requiredFields: categoryProductViewFields,
              observedAt: parseCatalogInstant(options.clock.now()),
            }),
          );
          const { products, categories } = await combinedCategorySources(tx);
          return deriveCatalogCategoryProductView(products, categories);
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
    async rebuild(value: unknown): Promise<ProductSearchBuildResult> {
      const request = parseProductSearchBuildRequest(value);
      if (request.actorReference !== actor) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      try {
        return await options.transactions.run(async (tx) => {
          await authorize(tx, request.observedAt);
          return build(tx, request, "Rebuild");
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
    async loadCurrent(observedAt: unknown) {
      const instant = parseCatalogInstant(observedAt);
      try {
        return await options.transactions.run(async (tx) => {
          await authorize(tx, instant);
          const value = await current(tx);
          return value === null
            ? null
            : Object.freeze({ generation: value, state: await state(tx, value) });
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return unavailable();
      }
    },
    consume,
    services: Object.freeze(
      registrations.map((registration) =>
        Object.freeze({
          registration,
          consume: async (tx: ConsumerTransaction, event: DomainEventEnvelope) => {
            if (event.eventType !== registration.eventType) return invalid();
            return consume(tx, event);
          },
        }),
      ),
    ),
  });
}
