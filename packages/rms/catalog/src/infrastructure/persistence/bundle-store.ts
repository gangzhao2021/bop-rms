import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type { BundleOperationRecord, BundlePorts } from "../../application/ports/bundle-ports.js";
import { parseBundleAggregate, type BundleAggregate } from "../../domain/bundle.js";
import { CatalogError, parseCatalogHash, parseCatalogReference } from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO: the Bundle repository for `bundle-service` in
 * the Brand back office, and the records of a combo compiled for orders (2000_115). A Bundle
 * version is written once (a revision is a new version); publishing sets its status in place.
 * Each operation appends its record, its exact result and an Audit in the caller's transaction.
 * A slot's dishes are kept in reference order (the order guests see is the choice group's).
 */
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const aggregateSql = `SELECT jsonb_build_object(
  'bundleReference',b.bundle_id,'brandReference',b.brand_id,'internalCode',b.internal_code,
  'lifecycle',b.lifecycle,'aggregateVersion',b.aggregate_version,
  'currentVersion',jsonb_build_object('versionReference',v.bundle_version_id,'status',v.status,
    'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,
    'localizedDescriptions',v.localized_descriptions_json,'priceMode',v.price_mode,
    'fixedPrice',CASE WHEN v.currency_code IS NULL THEN NULL ELSE jsonb_build_object(
      'currencyCode',v.currency_code,'amountMinor',v.fixed_amount_minor::text) END,
    'componentGroups',COALESCE((SELECT jsonb_agg(jsonb_build_object('groupReference',g.group_id,
      'stableCode',g.stable_code,'localizedNames',g.localized_names_json,
      'minimumSelection',g.minimum_selection,'maximumSelection',g.maximum_selection,
      'eligibleSellables',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sellableReference',c.sellable_id,'sellableType',c.sellable_type,
        'upgradePrice',CASE WHEN c.upgrade_currency_code IS NULL THEN NULL ELSE jsonb_build_object(
          'currencyCode',c.upgrade_currency_code,'amountMinor',c.upgrade_amount_minor::text) END)
        ORDER BY c.sellable_id)
        FROM rms_catalog.bundle_component_sellable c
        WHERE c.group_id=g.group_id AND c.brand_id=g.brand_id),'[]'::jsonb),
      'optionSetVersionReference',g.option_set_version_id) ORDER BY g.sort_order)
      FROM rms_catalog.bundle_component_group g
      WHERE g.bundle_version_id=v.bundle_version_id AND g.brand_id=v.brand_id),'[]'::jsonb),
    'availabilityRuleReferences',COALESCE((SELECT jsonb_agg(a.availability_rule_id ORDER BY a.availability_rule_id)
      FROM rms_catalog.bundle_availability_rule a
      WHERE a.bundle_version_id=v.bundle_version_id AND a.brand_id=v.brand_id),'[]'::jsonb),
    'validationDigest',CASE WHEN v.validation_digest IS NULL THEN NULL ELSE substr(v.validation_digest,8) END,
    'createdAt',${iso("v.created_at")},'updatedAt',${iso("v.updated_at")},
    'publishedAt',CASE WHEN v.published_at IS NULL THEN NULL ELSE ${iso("v.published_at")} END),
  'createdAt',${iso("b.created_at")},'createdByActorReference',b.created_by_actor_id,
  'updatedAt',${iso("b.updated_at")}) AS aggregate
 FROM rms_catalog.bundle b JOIN rms_catalog.bundle_version v
  ON v.bundle_version_id=b.current_version_id AND v.bundle_id=b.bundle_id AND v.brand_id=b.brand_id`;
const brandScope = (tx: ProductLifecycleTransaction, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);

/** The Brand's Bundles with their current version, by internal code. */
export async function listBrandBundles(
  tx: ProductLifecycleTransaction,
  scope: { readonly brandReference: string },
): Promise<readonly BundleAggregate[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  const { rows } = await tx.query<{ aggregate: unknown }>(
    `${aggregateSql} WHERE b.brand_id=$1 ORDER BY b.internal_code LIMIT 500`,
    [brand],
  );
  return Object.freeze(rows.map((row) => parseBundleAggregate(row.aggregate)));
}

export interface BundleComboRecords {
  readonly dishes: readonly {
    readonly bundleReference: string;
    readonly productReference: string;
    readonly skuReference: string;
  }[];
  readonly choices: readonly {
    readonly bundleReference: string;
    readonly groupCode: string;
    readonly optionSetReference: string;
    readonly optionReference: string;
    readonly dishSkuReference: string;
  }[];
  /** Bundle versions listed alone at the Brand's one store. */
  readonly listedVersions: readonly string[];
  /**
   * v15 2026-10-29: dishes a combo save made but did not record before it stopped — the products
   * that offer the combo's own choice groups (each made for that combo alone), one size each.
   */
  readonly unrecordedDishes: readonly {
    readonly bundleReference: string;
    readonly productReference: string;
    readonly skuReference: string;
  }[];
}

/** What the Brand's combos are compiled into, and which of their versions were listed. */
export async function listBundleComboRecords(
  tx: ProductLifecycleTransaction,
  scope: { readonly brandReference: string },
): Promise<BundleComboRecords> {
  const brand = parseCatalogReference(scope.brandReference);
  const dishes = await tx.query<{ bundle: string; product: string; sku: string }>(
    "SELECT bundle_id::text bundle,product_id::text product,sku_id::text sku FROM rms_catalog.bundle_combo_dish WHERE brand_id=$1 ORDER BY recorded_at,bundle_id",
    [brand],
  );
  const choices = await tx.query<Record<string, string>>(
    "SELECT bundle_id::text bundle,group_code code,option_set_id::text set,option_id::text option,dish_sku_id::text dish FROM rms_catalog.bundle_combo_choice WHERE brand_id=$1 ORDER BY recorded_at,option_id",
    [brand],
  );
  const listed = await tx.query<{ version: string }>(
    "SELECT bundle_version_id::text version FROM rms_catalog.bundle_single_store_listing WHERE brand_id=$1",
    [brand],
  );
  const unrecorded = await tx.query<{ bundle: string; product: string; sku: string }>(
    `SELECT DISTINCT c.bundle_id::text bundle,b.product_id::text product,s.sku_id::text sku
       FROM rms_catalog.bundle_combo_choice c
       JOIN rms_catalog.product_option_binding b ON b.brand_id=c.brand_id AND b.option_set_id=c.option_set_id
       JOIN rms_catalog.sku s ON s.brand_id=b.brand_id AND s.product_id=b.product_id
      WHERE c.brand_id=$1 AND NOT EXISTS (
        SELECT 1 FROM rms_catalog.bundle_combo_dish d WHERE d.brand_id=c.brand_id AND d.bundle_id=c.bundle_id)
      ORDER BY 1,2,3`,
    [brand],
  );
  return Object.freeze({
    unrecordedDishes: unrecorded.rows.map((row) => ({
      bundleReference: row.bundle,
      productReference: row.product,
      skuReference: row.sku,
    })),
    dishes: dishes.rows.map((row) => ({
      bundleReference: row.bundle,
      productReference: row.product,
      skuReference: row.sku,
    })),
    choices: choices.rows.map((row) => ({
      bundleReference: String(row.bundle),
      groupCode: String(row.code),
      optionSetReference: String(row.set),
      optionReference: String(row.option),
      dishSkuReference: String(row.dish),
    })),
    listedVersions: listed.rows.map((row) => row.version),
  });
}

/** The dish a combo is compiled into (recorded once). */
export async function recordBundleComboDish(
  tx: ProductLifecycleTransaction,
  input: {
    readonly brandReference: string;
    readonly bundleReference: string;
    readonly productReference: string;
    readonly skuReference: string;
    readonly actorReference: string;
    readonly recordedAt: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO rms_catalog.bundle_combo_dish(brand_id,bundle_id,product_id,sku_id,actor_id,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (brand_id,bundle_id) DO NOTHING`,
    [
      parseCatalogReference(input.brandReference),
      parseCatalogReference(input.bundleReference),
      parseCatalogReference(input.productReference),
      parseCatalogReference(input.skuReference),
      parseCatalogReference(input.actorReference),
      input.recordedAt,
    ],
  );
  const { rows } = await tx.query(
    "SELECT 1 FROM rms_catalog.bundle_combo_dish WHERE brand_id=$1 AND bundle_id=$2 AND sku_id=$3",
    [input.brandReference, input.bundleReference, input.skuReference],
  );
  if (rows.length !== 1) fail("CATALOG_VERSION_CONFLICT");
}

/** Which dish each new choice of a combo slot stands for (each recorded once). */
export async function recordBundleComboChoices(
  tx: ProductLifecycleTransaction,
  input: {
    readonly brandReference: string;
    readonly bundleReference: string;
    readonly actorReference: string;
    readonly recordedAt: string;
    readonly choices: readonly {
      readonly groupCode: string;
      readonly optionSetReference: string;
      readonly optionReference: string;
      readonly dishSkuReference: string;
    }[];
  },
): Promise<void> {
  for (const choice of input.choices) {
    await tx.query(
      `INSERT INTO rms_catalog.bundle_combo_choice(brand_id,option_id,option_set_id,bundle_id,group_code,dish_sku_id,actor_id,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (brand_id,option_id) DO NOTHING`,
      [
        parseCatalogReference(input.brandReference),
        parseCatalogReference(choice.optionReference),
        parseCatalogReference(choice.optionSetReference),
        parseCatalogReference(input.bundleReference),
        choice.groupCode,
        parseCatalogReference(choice.dishSkuReference),
        parseCatalogReference(input.actorReference),
        input.recordedAt,
      ],
    );
    const { rows } = await tx.query(
      "SELECT 1 FROM rms_catalog.bundle_combo_choice WHERE brand_id=$1 AND option_id=$2 AND bundle_id=$3 AND dish_sku_id=$4",
      [
        input.brandReference,
        choice.optionReference,
        input.bundleReference,
        choice.dishSkuReference,
      ],
    );
    // A choice never changes the dish it stands for.
    if (rows.length !== 1) fail("CATALOG_VERSION_CONFLICT");
  }
}

/** A combo version listed alone at the Brand's one store (the database checks there is one). */
export async function recordBundleSingleStoreListing(
  tx: ProductLifecycleTransaction,
  input: {
    readonly brandReference: string;
    readonly operationReference: string;
    readonly bundleReference: string;
    readonly versionReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly listedAt: string;
    readonly auditReference: string;
    /** DEC-BRAND-MULTI-STORE segment 9: at a Brand with several Stores, by its Owner. */
    readonly approvalMode?: "SingleStoreListing" | "BrandOwnerListing";
  },
): Promise<void> {
  const mode = input.approvalMode ?? "SingleStoreListing";
  if (mode !== "SingleStoreListing" && mode !== "BrandOwnerListing")
    throw new Error("BUNDLE_LISTING_MODE_INVALID");
  await tx.query(
    `INSERT INTO rms_catalog.bundle_single_store_listing(brand_id,operation_id,bundle_id,bundle_version_id,approval_mode,
       listing_store_id,actor_id,listed_at,audit_id)
     VALUES($1,$2,$3,$4,$9,$5,$6,$7,$8)`,
    [
      parseCatalogReference(input.brandReference),
      parseCatalogReference(input.operationReference),
      parseCatalogReference(input.bundleReference),
      parseCatalogReference(input.versionReference),
      parseCatalogReference(input.storeReference),
      parseCatalogReference(input.actorReference),
      input.listedAt,
      parseCatalogReference(input.auditReference),
      mode,
    ],
  );
}

/** Every dish a combo offers is a size the Brand sells (active, of an active product). */
export async function bundleSellablesActive(
  tx: ProductLifecycleTransaction,
  input: { readonly brandReference: string; readonly skuReferences: readonly string[] },
): Promise<boolean> {
  const brand = parseCatalogReference(input.brandReference);
  const skus = [...new Set(input.skuReferences.map(parseCatalogReference))];
  if (skus.length === 0) return false;
  await brandScope(tx, brand);
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int n FROM rms_catalog.sku s JOIN rms_catalog.product p
       ON p.product_id=s.product_id AND p.brand_id=s.brand_id
      WHERE s.brand_id=$1 AND s.sku_id=ANY($2::uuid[]) AND s.lifecycle='Active' AND p.lifecycle='Active'`,
    [brand, skus],
  );
  return rows[0]?.n === skus.length;
}

export function createPostgresBundleRepository(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  /** Current authority for the write, checked before every read and write. */
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
  /** The Outbox identity of an operation's event (the event itself is in the snapshot). */
  eventReference(operationReference: string): string;
}): BundlePorts["repository"] {
  const brand = parseCatalogReference(options.brandReference);
  const scoped = <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) =>
    options.transactions.run(async (tx) => {
      if (!(await options.authorize(tx))) fail("CATALOG_PERMISSION_DENIED");
      await brandScope(tx, brand);
      return work(tx);
    });
  const load = async (tx: ProductLifecycleTransaction, reference: string) => {
    const { rows } = await tx.query<{ aggregate: unknown }>(
      `${aggregateSql} WHERE b.brand_id=$1 AND b.bundle_id=$2`,
      [brand, reference],
    );
    const row = rows[0];
    return row === undefined ? null : parseBundleAggregate(row.aggregate);
  };
  const readOperation = async (
    tx: ProductLifecycleTransaction,
    operation: string,
  ): Promise<BundleOperationRecord | null> => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT r.action_code,r.intent_digest,r.result_aggregate_version,r.bundle_id::text bundle_id,s.record_json
         FROM rms_catalog.bundle_operation_record r
         LEFT JOIN rms_catalog.bundle_operation_snapshot s ON s.operation_id=r.operation_id
        WHERE r.brand_id=$1 AND r.operation_id=$2`,
      [brand, operation],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const record = row.record_json as BundleOperationRecord | null;
    if (record === null || typeof record !== "object") return fail();
    const aggregate = parseBundleAggregate(record.aggregate);
    if (
      record.operationReference !== operation ||
      record.action !== row.action_code ||
      "sha256:" + record.operationIntentHash !== row.intent_digest ||
      aggregate.bundleReference !== row.bundle_id ||
      aggregate.aggregateVersion !== Number(row.result_aggregate_version) ||
      aggregate.brandReference !== brand
    )
      return fail();
    const event = record.event as Partial<BundleOperationRecord["event"]> | null;
    if (event === null || typeof event !== "object") return fail();
    return Object.freeze({
      action: record.action,
      operationReference: parseCatalogReference(record.operationReference),
      operationIntentHash: parseCatalogHash(record.operationIntentHash),
      aggregate,
      // The snapshot is canonical (sorted keys); the event keeps the service's field order.
      event: Object.freeze({
        eventType: event.eventType as BundleOperationRecord["event"]["eventType"],
        aggregateReference: event.aggregateReference as never,
        versionReference: event.versionReference as never,
        aggregateVersion: event.aggregateVersion as number,
        brandReference: event.brandReference as never,
        lifecycle: event.lifecycle as BundleAggregate["lifecycle"],
        validationDigest: (event.validationDigest ?? null) as never,
        occurredAt: event.occurredAt as never,
      }),
    });
  };
  const checkAudit = (audit: AppendAuditRecordInput, record: BundleOperationRecord) => {
    const valid = validateAuditRecord(audit, Date.parse(record.aggregate.updatedAt));
    if (
      valid.brandId !== brand ||
      valid.storeId !== undefined ||
      valid.targetType !== "CatalogBundle" ||
      valid.targetId !== record.aggregate.bundleReference ||
      valid.actionCode !== `CATALOG_BUNDLE_${record.action.toUpperCase()}` ||
      valid.actor.type === "System"
    )
      return fail("CATALOG_PERMISSION_DENIED");
    return valid;
  };
  const lock = (tx: ProductLifecycleTransaction, reference: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CatalogBundleOperation:" + brand + ":" + reference,
    ]);
  /** Writes a new version with its slots and dishes. */
  const writeVersion = async (tx: ProductLifecycleTransaction, aggregate: BundleAggregate) => {
    const version = aggregate.currentVersion;
    await tx.query(
      `INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,
         localized_names_json,localized_descriptions_json,price_mode,currency_code,fixed_amount_minor,created_at,updated_at)
       VALUES($1,$2,$3,'Draft',$4,$5::jsonb,$6::jsonb,$7,$8,$9::numeric,$10,$11)`,
      [
        version.versionReference,
        aggregate.bundleReference,
        brand,
        version.defaultLocale,
        JSON.stringify(version.localizedNames),
        JSON.stringify(version.localizedDescriptions),
        version.priceMode,
        version.fixedPrice?.currencyCode ?? null,
        version.fixedPrice?.amountMinor ?? null,
        version.createdAt,
        version.updatedAt,
      ],
    );
    for (const [sortOrder, group] of version.componentGroups.entries()) {
      await tx.query(
        `INSERT INTO rms_catalog.bundle_component_group(group_id,bundle_version_id,bundle_id,brand_id,stable_code,
           localized_names_json,minimum_selection,maximum_selection,option_set_version_id,sort_order)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
        [
          group.groupReference,
          version.versionReference,
          aggregate.bundleReference,
          brand,
          group.stableCode,
          JSON.stringify(group.localizedNames),
          group.minimumSelection,
          group.maximumSelection,
          group.optionSetVersionReference,
          sortOrder,
        ],
      );
      for (const item of group.eligibleSellables)
        await tx.query(
          `INSERT INTO rms_catalog.bundle_component_sellable(group_id,bundle_version_id,bundle_id,brand_id,sellable_id,
             sellable_type,upgrade_currency_code,upgrade_amount_minor)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric)`,
          [
            group.groupReference,
            version.versionReference,
            aggregate.bundleReference,
            brand,
            item.sellableReference,
            item.sellableType,
            item.upgradePrice?.currencyCode ?? null,
            item.upgradePrice?.amountMinor ?? null,
          ],
        );
    }
  };
  const append = async (
    tx: ProductLifecycleTransaction,
    record: BundleOperationRecord,
    audit: AppendAuditRecordInput,
  ) => {
    await tx.query(
      "INSERT INTO rms_catalog.bundle_operation_record(operation_id,brand_id,bundle_id,action_code,intent_digest,result_aggregate_version,outbox_event_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        record.operationReference,
        brand,
        record.aggregate.bundleReference,
        record.action,
        "sha256:" + record.operationIntentHash,
        record.aggregate.aggregateVersion,
        parseCatalogReference(options.eventReference(record.operationReference)),
        record.aggregate.updatedAt,
      ],
    );
    await tx.query(
      "INSERT INTO rms_catalog.bundle_operation_snapshot(operation_id,brand_id,bundle_id,record_json) VALUES($1,$2,$3,$4::jsonb)",
      [
        record.operationReference,
        brand,
        record.aggregate.bundleReference,
        canonicalizeRfc8785(JSON.parse(JSON.stringify(record)) as never),
      ],
    );
    await appendAuditRecordInTransaction(tx, audit);
  };
  const confirm = async (tx: ProductLifecycleTransaction, record: BundleOperationRecord) => {
    const saved = await readOperation(tx, record.operationReference);
    const current = await load(tx, record.aggregate.bundleReference);
    const same = (value: unknown) =>
      canonicalizeRfc8785(JSON.parse(JSON.stringify(value)) as never);
    if (
      saved === null ||
      current === null ||
      same(current) !== same(record.aggregate) ||
      same(saved.aggregate) !== same(record.aggregate)
    )
      return fail();
    return saved;
  };
  return Object.freeze({
    resolveOperation: (operation) =>
      scoped((tx) => readOperation(tx, parseCatalogReference(operation))),
    load: (reference) => scoped((tx) => load(tx, parseCatalogReference(reference))),
    codeAvailable: (input) =>
      scoped(async (tx) => {
        if (input.brandReference !== brand) return fail("CATALOG_PERMISSION_DENIED");
        const { rows } = await tx.query(
          "SELECT 1 FROM rms_catalog.bundle WHERE brand_id=$1 AND internal_code=$2 AND ($3::uuid IS NULL OR bundle_id<>$3::uuid)",
          [brand, input.internalCode, input.excludingBundleReference],
        );
        return rows.length === 0;
      }),
    create: (input) =>
      scoped(async (tx) => {
        const { record } = input;
        const { aggregate } = record;
        if (record.action !== "Create" || aggregate.brandReference !== brand) return fail();
        const audit = checkAudit(input.audit, record);
        await lock(tx, record.operationReference);
        if ((await readOperation(tx, record.operationReference)) !== null)
          return fail("CATALOG_IDEMPOTENCY_CONFLICT");
        await tx.query(
          "INSERT INTO rms_catalog.bundle(bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            aggregate.bundleReference,
            brand,
            aggregate.internalCode,
            aggregate.lifecycle,
            aggregate.aggregateVersion,
            aggregate.currentVersion.versionReference,
            aggregate.createdAt,
            aggregate.createdByActorReference,
            aggregate.updatedAt,
          ],
        );
        await writeVersion(tx, aggregate);
        await append(tx, record, audit);
        return confirm(tx, record);
      }),
    commit: (input) =>
      scoped(async (tx) => {
        const { record } = input;
        const { aggregate } = record;
        if (
          record.action === "Create" ||
          aggregate.brandReference !== brand ||
          aggregate.aggregateVersion !== input.expectedAggregateVersion + 1
        )
          return fail();
        const audit = checkAudit(input.audit, record);
        await lock(tx, record.operationReference);
        if ((await readOperation(tx, record.operationReference)) !== null)
          return fail("CATALOG_IDEMPOTENCY_CONFLICT");
        const before = await load(tx, aggregate.bundleReference);
        if (before === null) return fail("CATALOG_UNAVAILABLE");
        const version = aggregate.currentVersion;
        if (record.action === "ReplaceDraft") {
          if (version.versionReference === before.currentVersion.versionReference)
            return fail("CATALOG_VERSION_CONFLICT");
          await writeVersion(tx, aggregate);
        } else if (record.action === "Publish") {
          if (version.versionReference !== before.currentVersion.versionReference) return fail();
          const published = await tx.query(
            `UPDATE rms_catalog.bundle_version SET status='Published',validation_digest=$4,updated_at=$5,published_at=$6
              WHERE bundle_version_id=$1 AND bundle_id=$2 AND brand_id=$3 AND status='Draft'`,
            [
              version.versionReference,
              aggregate.bundleReference,
              brand,
              "sha256:" + String(version.validationDigest),
              version.updatedAt,
              version.publishedAt,
            ],
          );
          if (published.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
        } else if (version.versionReference !== before.currentVersion.versionReference)
          return fail();
        const updated = await tx.query(
          "UPDATE rms_catalog.bundle SET lifecycle=$3,aggregate_version=$4,current_version_id=$5,updated_at=$6 WHERE brand_id=$1 AND bundle_id=$2 AND aggregate_version=$7",
          [
            brand,
            aggregate.bundleReference,
            aggregate.lifecycle,
            aggregate.aggregateVersion,
            version.versionReference,
            aggregate.updatedAt,
            input.expectedAggregateVersion,
          ],
        );
        if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
        await append(tx, record, audit);
        return confirm(tx, record);
      }),
  });
}
