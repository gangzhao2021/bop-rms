import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
import { createPostgresProductSearchGenerationStore } from "./product-search-generation-store.js";
import {
  type CatalogCategoryProductView,
  selectCatalogCategoryProducts,
} from "../../contracts/product-category-source.js";
import { categorySourceRevision } from "../../contracts/category-source.js";
import { CatalogError } from "../../contracts/product.js";
/** Explicit public source/field/Phase holders; no default source access or Role grants.
 * The owning source store uses the same outer transaction as the list query. */
export type CatalogProductListCategorySource = Pick<
  Parameters<typeof createPostgresProductSearchGenerationStore>[0],
  "tenantReference" | "authorization" | "maximumProducts"
> & {
  readonly categorySource: NonNullable<
    Parameters<typeof createPostgresProductSearchGenerationStore>[0]["categorySource"]
  >;
};
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { holdProductSourceBarrier } from "./product-source-producer.js";
import {
  parseProductSearchGeneration,
  productSearchRevision,
  type ProductSearchGeneration,
} from "../../contracts/product-search-generation.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  parseLocalizedNames,
  parseProductLifecycle,
} from "../../contracts/product.js";
import {
  CatalogProductListError,
  catalogProductListCategoryFields,
  parseCatalogProductListRequest,
  parseCatalogProductListView,
  productListRecord,
  productListArray,
  productListCopy,
  productListType,
  type CatalogProductListRequest,
  type CatalogProductListItem,
  type CatalogProductListCategory,
  type CatalogProductListCategoryOptions,
  type CatalogProductListSort,
} from "../../contracts/product-list.js";
export interface CatalogProductListTransactionRunner {
  run<T>(
    work: (tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
}
export interface CatalogProductListAuthorization {
  /** Current Tenant/session/Actor/field/phase authority held through owner read COMMIT. */
  withAuthorizedProductList<T>(
    input: CatalogProductListRequest & {
      readonly brandReference: string;
      readonly storeReference: string | null;
      readonly permission: "catalog.manage";
      readonly capability: "catalog.cat_product_list";
      readonly requiredCategoryFields: readonly [] | typeof catalogProductListCategoryFields;
    },
    work: () => Promise<T>,
  ): Promise<T>;
}
const fail = (code: CatalogProductListError["code"] = "Unavailable"): never => {
  throw new CatalogProductListError(code);
};
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
function select(sort: CatalogProductListSort, direction: "ASC" | "DESC") {
  // Closed server-owned expressions only; request values never become SQL identifiers.
  const columns = {
    name: ['display_name COLLATE "C"', '$5::text COLLATE "C"'],
    updatedAt: ["updated_at", "$5::timestamptz"],
    createdAt: ["created_at", "$5::timestamptz"],
    internalCode: ['internal_code COLLATE "C"', '$5::text COLLATE "C"'],
    lifecycle: ['lifecycle COLLATE "C"', '$5::text COLLATE "C"'],
    activeSkuCount: ["active_sku_count::bigint", "$5::bigint"],
  } as const;
  const [column, token] = columns[sort];
  const relation = direction === "ASC" ? ">" : "<";
  const order = `priority,${column} ${direction},product_id ASC`;
  return `WITH source AS (SELECT r.product_id,r.brand_id,r.list_json,r.list_digest,
 COALESCE(r.list_json->'localizedNames'->>$18,r.list_json->'localizedNames'->>(r.list_json->>'defaultLocale')) display_name,
 r.list_json->>'internalCode' internal_code,r.list_json->>'productType' product_type,r.list_json->>'lifecycle' lifecycle,
 (r.list_json->>'updatedAt')::timestamptz updated_at,(r.list_json->>'createdAt')::timestamptz created_at,
 (r.list_json->>'activeSkuCount')::bigint active_sku_count
 FROM rms_catalog.product_search_row r WHERE r.brand_id=$1 AND r.generation_id=$17),
 matched AS (SELECT *,CASE WHEN $8::text IS NOT NULL AND (lower(internal_code)=lower($8) OR EXISTS(SELECT 1 FROM jsonb_array_elements(list_json->'skuSearch') s WHERE lower(s->>'skuCode')=lower($8))) THEN 0 ELSE 1 END priority
 FROM source WHERE ($9::boolean OR lifecycle<>'Archived')
 AND ($2::text IS NULL OR internal_code ILIKE $10 ESCAPE '\\' OR EXISTS(SELECT 1 FROM jsonb_each_text(list_json->'localizedNames') n WHERE n.value ILIKE $2 ESCAPE '\\') OR EXISTS(SELECT 1 FROM jsonb_array_elements(list_json->'skuSearch') s WHERE s->>'skuCode' ILIKE $10 ESCAPE '\\' OR EXISTS(SELECT 1 FROM jsonb_each_text(s->'localizedNames') n WHERE n.value ILIKE $2 ESCAPE '\\')))
 AND ($3::text IS NULL OR lifecycle=$3) AND ($4::text IS NULL OR product_type=$4)
 AND ($20::uuid[] IS NULL OR product_id=ANY($20::uuid[]))
 AND ($12::boolean IS NULL OR $12=(active_sku_count>0))
 AND ($19::text IS NULL OR NOT (list_json->'localizedNames' ? $19::text))
 AND ($13::timestamptz IS NULL OR updated_at >= $13) AND ($14::timestamptz IS NULL OR updated_at < $14)
 AND ($15::timestamptz IS NULL OR created_at >= $15) AND ($16::timestamptz IS NULL OR created_at < $16)),
 page AS (SELECT * FROM matched WHERE $5::text IS NULL OR priority>$11 OR (priority=$11 AND (${column}${relation}${token} OR (${column}=${token} AND product_id>$6::uuid)))
 ORDER BY ${order} LIMIT $7)
 SELECT ${utc("statement_timestamp()")} AS "asOfUtc",COALESCE((SELECT jsonb_agg(jsonb_build_object('data',list_json,'checksum',list_digest,'priority',priority) ORDER BY ${order}) FROM page),'[]'::jsonb) AS items`;
}
const number = (value: unknown, min = 0) => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return fail();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) return fail();
  return n;
};
const sourceSort = (
  item: Pick<CatalogProductListItem, CatalogProductListSort>,
  sort: CatalogProductListSort,
): string | number => item[sort];
const compareSort = (left: string | number, right: string | number) => {
  if (typeof left !== typeof right) return fail();
  if (typeof left === "string" && typeof right === "string")
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  return left === right ? 0 : left < right ? -1 : 1;
};
export function createPostgresCatalogProductListQueryStore(options: {
  readonly runner: CatalogProductListTransactionRunner;
  readonly scope: { readonly brandReference: string; readonly storeReference: string | null };
  readonly authorization: CatalogProductListAuthorization;
  readonly clock: { now(): string };
  /** Explicit server configuration only. No default/generated secret. Copy prevents later mutation. */
  readonly cursorKey: Uint8Array;
  readonly categorySource?: CatalogProductListCategorySource;
}) {
  const brand = parseCatalogReference(options.scope.brandReference),
    store =
      options.scope.storeReference === null
        ? null
        : parseCatalogReference(options.scope.storeReference);
  if (
    !(options.cursorKey instanceof Uint8Array) ||
    options.cursorKey.length < 32 ||
    options.cursorKey.length > 64
  )
    return fail("Invalid");
  const key = Buffer.from(options.cursorKey);
  const sign = (payload: string) =>
    createHmac("sha256", key).update("catalog.product-list.cursor.v4\0").update(payload).digest();
  return Object.freeze({
    async load(value: unknown) {
      let known: CatalogProductListError | undefined;
      try {
        const request = parseCatalogProductListRequest(value),
          started = parseCatalogInstant(options.clock.now());
        if (
          request.observedAt > started ||
          Date.parse(started) - Date.parse(request.observedAt) > 30_000
        )
          return fail("Stale");
        const bound = {
          actorReference: request.actorReference,
          purposeCode: request.purposeCode,
          locale: request.locale,
          search: request.search,
          categoryReference: request.categoryReference ?? null,
          categoryCoverage:
            options.categorySource === undefined ? "Unconfigured" : "PublicSourceV1",
          lifecycle: request.lifecycle,
          productType: request.productType,
          limit: request.limit,
          includeArchived: request.includeArchived,
          hasActiveSku: request.hasActiveSku,
          missingTranslationLocale: request.missingTranslationLocale,
          updatedFrom: request.updatedFrom,
          updatedUntil: request.updatedUntil,
          createdFrom: request.createdFrom,
          createdUntil: request.createdUntil,
          sort: request.sort,
          direction: request.direction,
        };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify({ brand, store, tie: "product_id_ASC", ...bound }))
          .digest("hex");
        let sortValue: string | null = null,
          priority = 1,
          reference: string | null = null,
          pin: ProductSearchGeneration | null = null;
        let categoryPin: { readonly revision: string; readonly digest: string } | null = null;
        if (request.cursor !== null) {
          const parts = request.cursor.split(".");
          if (parts.length !== 2) return fail("Invalid");
          const [payload, signature] = parts;
          if (!payload || !signature) return fail("Invalid");
          const encoded = Buffer.from(signature, "base64url"),
            expected = sign(payload);
          if (
            encoded.length !== expected.length ||
            encoded.toString("base64url") !== signature ||
            !timingSafeEqual(encoded, expected)
          )
            return fail("Invalid");
          const bytes = Buffer.from(payload, "base64url");
          if (bytes.toString("base64url") !== payload) return fail("Invalid");
          const token = productListRecord(JSON.parse(bytes.toString("utf8")), [
            "version",
            "scope",
            "issuedAt",
            "sortValue",
            "priority",
            "reference",
            "generation",
            "categorySource",
          ]);
          if (token.version !== 4 || token.scope !== fingerprint) return fail("Invalid");
          if (token.categorySource !== null) {
            const source = productListRecord(token.categorySource, ["revision", "digest"]);
            if (typeof source.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(source.digest))
              return fail("Invalid");
            categoryPin = Object.freeze({
              revision: categorySourceRevision(source.revision),
              digest: source.digest,
            });
          }
          if ((options.categorySource !== undefined) !== (categoryPin !== null))
            return fail("Invalid");
          pin = parseProductSearchGeneration(token.generation);
          if (pin.brandReference !== brand) return fail("Invalid");
          const issuedAt = parseCatalogInstant(token.issuedAt);
          if (
            issuedAt > request.observedAt ||
            Date.parse(request.observedAt) - Date.parse(issuedAt) > 300_000
          )
            return fail("Stale");
          try {
            if (request.sort === "updatedAt" || request.sort === "createdAt")
              sortValue = parseCatalogInstant(token.sortValue);
            else if (request.sort === "name")
              sortValue =
                parseLocalizedNames({ [request.locale]: token.sortValue }, request.locale)[
                  request.locale
                ] ?? fail("Invalid");
            else if (request.sort === "internalCode") sortValue = parseCatalogCode(token.sortValue);
            else if (request.sort === "lifecycle")
              sortValue = parseProductLifecycle(token.sortValue);
            else sortValue = String(number(token.sortValue));
          } catch {
            return fail("Invalid");
          }
          if (token.priority !== 0 && token.priority !== 1) return fail("Invalid");
          priority = token.priority;
          reference = parseCatalogReference(token.reference);
        }
        let calls = 0;
        const result = await options.authorization.withAuthorizedProductList(
          Object.freeze({
            ...request,
            brandReference: brand,
            storeReference: store,
            permission: "catalog.manage",
            capability: "catalog.cat_product_list",
            requiredCategoryFields:
              options.categorySource !== undefined || request.categoryReference != null
                ? catalogProductListCategoryFields
                : Object.freeze([] as const),
          }),
          async () => {
            if (++calls !== 1) return fail();
            try {
              return await options.runner.run(async (tx) => {
                await tx.query(
                  "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
                  [brand],
                );
                await holdProductSourceBarrier(tx, brand);
                const meta = await tx.query(
                  `SELECT jsonb_build_object('generationReference',g.generation_id,'brandReference',g.brand_id,'sourceRevision',g.source_revision::text,'sourceDigest',g.source_digest,'projectedAt',${utc("g.projected_at")},'productCount',g.product_count,'coverage',g.source_coverage,'partial',g.is_partial) generation,
                  COALESCE(h.source_revision,0)::text revision,(SELECT count(*)::text FROM rms_catalog.product_search_row r WHERE r.brand_id=g.brand_id AND r.generation_id=g.generation_id) count
                  FROM rms_catalog.product_search_activation a JOIN rms_catalog.product_search_generation g ON g.brand_id=a.brand_id AND g.generation_id=a.generation_id AND g.source_revision=a.source_revision AND g.source_digest=a.source_digest
                  LEFT JOIN rms_catalog.product_source_head h ON h.brand_id=g.brand_id WHERE a.brand_id=$1`,
                  [brand],
                );
                if (!meta || typeof meta !== "object") return fail();
                const descriptorMeta = Object.getOwnPropertyDescriptor(meta, "rows");
                if (!descriptorMeta || !("value" in descriptorMeta)) return fail();
                const metadata = productListArray(productListCopy(descriptorMeta.value), 1);
                if (metadata.length !== 1) return fail();
                const selected = productListRecord(metadata[0], [
                  "generation",
                  "revision",
                  "count",
                ]);
                const generation = parseProductSearchGeneration(selected.generation);
                const checkedAt = parseCatalogInstant(options.clock.now());
                if (
                  generation.brandReference !== brand ||
                  number(selected.count) !== generation.productCount
                )
                  return fail();
                if (
                  productSearchRevision(selected.revision) !== generation.sourceRevision ||
                  generation.projectedAt > checkedAt ||
                  Date.parse(checkedAt) - Date.parse(generation.projectedAt) > 30_000
                )
                  return fail("Stale");
                if (pin && canonicalizeRfc8785(pin) !== canonicalizeRfc8785(generation))
                  return fail("Stale");
                let categorySource: { readonly revision: string; readonly digest: string } | null =
                  null;
                let memberships: ReadonlyMap<
                  string,
                  { readonly productVersionReference: string; readonly lifecycle: string }
                > | null = null;
                let classificationView: CatalogCategoryProductView | null = null;
                if (options.categorySource !== undefined || request.categoryReference != null) {
                  if (!options.categorySource) return fail();
                  const view = await createPostgresProductSearchGenerationStore({
                    ...options.categorySource,
                    brandReference: brand,
                    actorReference: request.actorReference,
                    // Borrow the exact driver identity so authority hosts retain the outer
                    // COMMIT checks. Source adapters independently descriptor-validate
                    // every unknown driver result; this assertion grants no SQL access.
                    transactions: { run: (work) => work(tx as ProductLifecycleTransaction) },
                    clock: options.clock,
                  }).loadCategoryProductView();
                  if (
                    canonicalizeRfc8785(view.productGeneration) !== canonicalizeRfc8785(generation)
                  )
                    return fail("Stale");
                  classificationView = view;
                  categorySource = Object.freeze({
                    revision: view.categorySource.revision,
                    digest: view.categorySource.digest,
                  });
                  if (
                    categoryPin &&
                    canonicalizeRfc8785(categoryPin) !== canonicalizeRfc8785(categorySource)
                  )
                    return fail("Stale");
                  if (request.categoryReference != null)
                    memberships = new Map(
                      selectCatalogCategoryProducts(
                        view,
                        request.categoryReference,
                        request.includeArchived,
                      ).map((row) => [row.productReference, row]),
                    );
                }
                const classificationRows = new Map(
                  classificationView?.products.map((row) => [row.productReference, row]) ?? [],
                );
                const categoryRows = new Map(
                  classificationView?.categories.map((row) => [row.categoryReference, row]) ?? [],
                );
                const categoryOptions: CatalogProductListCategoryOptions =
                  classificationView === null ||
                  classificationView.unknownClassificationProductCount !== 0
                    ? Object.freeze({ status: "Unavailable" })
                    : Object.freeze({
                        status: "Known",
                        configuration: "Draft",
                        source: Object.freeze({
                          revision: classificationView.categorySource.revision,
                          digest: classificationView.categorySource.digest,
                          asOfUtc: classificationView.categorySource.observedAt,
                        }),
                        items: Object.freeze(
                          classificationView.categories
                            .map((node) => {
                              const nameLocale = Object.hasOwn(node.localizedNames, request.locale)
                                ? request.locale
                                : node.defaultLocale;
                              return Object.freeze({
                                categoryReference: node.categoryReference,
                                internalCode: node.internalCode,
                                name: node.localizedNames[nameLocale] ?? fail(),
                                nameLocale,
                                localeFallback: nameLocale !== request.locale,
                                lifecycle: node.lifecycle,
                              });
                            })
                            .sort(
                              (left, right) =>
                                compareSort(left.name, right.name) ||
                                compareSort(left.internalCode, right.internalCode) ||
                                compareSort(left.categoryReference, right.categoryReference),
                            ),
                        ),
                      });
                const primaryCategory = (
                  productReference: string,
                  versionReference: string,
                  lifecycle: string,
                ): CatalogProductListCategory => {
                  if (classificationView === null) return Object.freeze({ status: "Unavailable" });
                  const product = classificationRows.get(productReference);
                  if (
                    !product ||
                    product.productVersionReference !== versionReference ||
                    product.lifecycle !== lifecycle
                  )
                    return fail();
                  if (product.categoryClassification === undefined)
                    return Object.freeze({ status: "Unavailable" });
                  let primary: Extract<CatalogProductListCategory, { status: "Known" }>["primary"] =
                    null;
                  if (product.categoryClassification.primaryCategoryReference !== null) {
                    const node = categoryRows.get(
                      product.categoryClassification.primaryCategoryReference,
                    );
                    if (!node) return fail();
                    const nameLocale = Object.hasOwn(node.localizedNames, request.locale)
                      ? request.locale
                      : node.defaultLocale;
                    primary = Object.freeze({
                      categoryReference: node.categoryReference,
                      name: node.localizedNames[nameLocale] ?? fail(),
                      nameLocale,
                      localeFallback: nameLocale !== request.locale,
                    });
                  }
                  return Object.freeze({
                    status: "Known",
                    configuration: "Draft",
                    primary,
                    matchedCategoryReference: request.categoryReference ?? null,
                    source: Object.freeze({
                      revision: classificationView.categorySource.revision,
                      digest: classificationView.categorySource.digest,
                      asOfUtc: classificationView.categorySource.observedAt,
                    }),
                  });
                };
                const pattern =
                  request.search === null
                    ? null
                    : `%${request.search.replace(/[\\%_]/gu, "\\$&")}%`;
                const raw = await tx.query(select(request.sort, request.direction), [
                  brand,
                  pattern,
                  request.lifecycle,
                  request.productType,
                  sortValue,
                  reference,
                  request.limit + 1,
                  request.search,
                  request.includeArchived,
                  pattern === null ? null : pattern.slice(1),
                  priority,
                  request.hasActiveSku,
                  request.updatedFrom,
                  request.updatedUntil,
                  request.createdFrom,
                  request.createdUntil,
                  generation.generationReference,
                  request.locale,
                  request.missingTranslationLocale,
                  memberships === null ? null : [...memberships.keys()],
                ]);
                if (!raw || typeof raw !== "object") return fail();
                const descriptor = Object.getOwnPropertyDescriptor(raw, "rows");
                if (!descriptor || !("value" in descriptor)) return fail();
                const rows = productListArray(productListCopy(descriptor.value), 1);
                if (rows.length !== 1) return fail();
                const envelope = productListRecord(rows[0], ["asOfUtc", "items"]),
                  asOfUtc = parseCatalogInstant(envelope.asOfUtc),
                  completed = parseCatalogInstant(options.clock.now());
                if (completed < started || asOfUtc < started || asOfUtc > completed) return fail();
                const seen = new Set<string>();
                let previous:
                  { reference: string; value: string | number; priority: number } | undefined =
                  sortValue !== null && reference !== null
                    ? {
                        reference,
                        priority,
                        value: request.sort === "activeSkuCount" ? number(sortValue) : sortValue,
                      }
                    : undefined;
                const items = productListArray(envelope.items, request.limit + 1).map((value) => {
                  const entry = productListRecord(value, ["data", "checksum", "priority"]);
                  if (entry.checksum !== "sha256:" + sha256Hex(canonicalizeRfc8785(entry.data)))
                    return fail();
                  const data = productListRecord(entry.data, [
                    "productReference",
                    "brandReference",
                    "internalCode",
                    "productType",
                    "lifecycle",
                    "aggregateVersion",
                    "updatedAt",
                    "createdAt",
                    "draftUpdatedAt",
                    "productVersionReference",
                    "defaultLocale",
                    "localizedNames",
                    "skuCount",
                    "activeSkuCount",
                    "precise",
                    "skuSearch",
                  ]);
                  const { skuSearch, ...fields } = data;
                  for (const item of productListArray(skuSearch, 100)) {
                    const sku = productListRecord(item, ["skuCode", "localizedNames"]);
                    parseCatalogCode(sku.skuCode);
                    parseLocalizedNames(sku.localizedNames, data.defaultLocale);
                  }
                  const row = productListRecord({ ...fields, priority: entry.priority }, [
                    "productReference",
                    "brandReference",
                    "internalCode",
                    "productType",
                    "lifecycle",
                    "aggregateVersion",
                    "updatedAt",
                    "createdAt",
                    "draftUpdatedAt",
                    "productVersionReference",
                    "defaultLocale",
                    "localizedNames",
                    "skuCount",
                    "activeSkuCount",
                    "precise",
                    "priority",
                  ]);
                  if (
                    row.brandReference !== brand ||
                    (row.priority !== 0 && row.priority !== 1) ||
                    row.precise !== true ||
                    parseCatalogInstant(row.draftUpdatedAt) > generation.projectedAt
                  )
                    return fail();
                  const ref = parseCatalogReference(row.productReference),
                    updatedAt = parseCatalogInstant(row.updatedAt),
                    createdAt = parseCatalogInstant(row.createdAt),
                    skuCount = number(row.skuCount),
                    activeSkuCount = number(row.activeSkuCount);
                  if (
                    seen.has(ref) ||
                    updatedAt > generation.projectedAt ||
                    createdAt > updatedAt ||
                    activeSkuCount > skuCount ||
                    (request.hasActiveSku !== null &&
                      request.hasActiveSku !== activeSkuCount > 0) ||
                    (request.updatedFrom !== null && updatedAt < request.updatedFrom) ||
                    (request.updatedUntil !== null && updatedAt >= request.updatedUntil) ||
                    (request.createdFrom !== null && createdAt < request.createdFrom) ||
                    (request.createdUntil !== null && createdAt >= request.createdUntil)
                  )
                    return fail();
                  if (memberships !== null) {
                    const member = memberships.get(ref);
                    if (
                      !member ||
                      member.productVersionReference !== row.productVersionReference ||
                      member.lifecycle !== row.lifecycle
                    )
                      return fail();
                  }
                  seen.add(ref);
                  const names = parseLocalizedNames(row.localizedNames, row.defaultLocale),
                    nameLocale = Object.hasOwn(names, request.locale)
                      ? request.locale
                      : String(row.defaultLocale),
                    unavailable = Object.freeze({ status: "Unavailable" as const });
                  if (
                    request.missingTranslationLocale !== null &&
                    Object.hasOwn(names, request.missingTranslationLocale)
                  )
                    return fail();
                  const view = Object.freeze({
                    productReference: ref,
                    internalCode: parseCatalogCode(row.internalCode),
                    name: names[nameLocale] ?? fail(),
                    nameLocale,
                    localeFallback: nameLocale !== request.locale,
                    productType: productListType(row.productType),
                    lifecycle: parseProductLifecycle(row.lifecycle),
                    aggregateVersion: number(row.aggregateVersion, 1),
                    updatedAt,
                    createdAt,
                    source: Object.freeze({
                      productVersionReference: parseCatalogReference(row.productVersionReference),
                      configuration: "Draft",
                    }),
                    skuCount,
                    activeSkuCount,
                    category: primaryCategory(
                      ref,
                      String(row.productVersionReference),
                      String(row.lifecycle),
                    ),
                    menuCount: unavailable,
                    availability: unavailable,
                    storeCoverage: unavailable,
                    tax: unavailable,
                    updatedBy: unavailable,
                  });
                  const selected = sourceSort(view, request.sort);
                  if (previous) {
                    const comparison = compareSort(selected, previous.value);
                    if (
                      Number(row.priority) < previous.priority ||
                      (row.priority === previous.priority &&
                        ((request.direction === "ASC" ? comparison < 0 : comparison > 0) ||
                          (comparison === 0 && ref <= previous.reference)))
                    )
                      return fail();
                  }
                  previous = { reference: ref, value: selected, priority: Number(row.priority) };
                  return Object.freeze({ view, priority: row.priority });
                });
                let nextCursor: string | null = null;
                if (items.length > request.limit) {
                  const last = items[request.limit - 1];
                  if (!last) return fail();
                  const payload = Buffer.from(
                    JSON.stringify({
                      version: 4,
                      scope: fingerprint,
                      issuedAt: generation.projectedAt,
                      generation,
                      categorySource,
                      sortValue: String(sourceSort(last.view, request.sort)),
                      priority: last.priority,
                      reference: last.view.productReference,
                    }),
                  ).toString("base64url");
                  nextCursor = payload + "." + sign(payload).toString("base64url");
                }
                return parseCatalogProductListView({
                  projection: {
                    name: "catalog_product_search_v1",
                    version: 1,
                    asOfUtc: generation.projectedAt,
                    stale: Date.parse(completed) - Date.parse(generation.projectedAt) > 30_000,
                    partial: true,
                  },
                  scope: { brandReference: brand, storeReference: store },
                  locale: request.locale,
                  hasMore: nextCursor !== null,
                  items: items.slice(0, request.limit).map((item) => item.view),
                  nextCursor,
                  categoryOptions,
                });
              });
            } catch (error) {
              if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") {
                known = new CatalogProductListError("Denied");
                throw known;
              }
              if (error instanceof CatalogProductListError) {
                known =
                  error.code === "Invalid" ? new CatalogProductListError("Unavailable") : error;
                throw known;
              }
              throw error;
            }
          },
        );
        if (calls !== 1) return fail();
        return result;
      } catch (error) {
        if (known) throw known;
        if (error instanceof CatalogProductListError) throw error;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          return fail("Denied");
        return fail();
      }
    },
  });
}
