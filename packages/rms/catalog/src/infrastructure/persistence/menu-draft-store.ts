import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type {
  MenuOperationRecord,
  MenuRepositoryPort,
} from "../../application/ports/category-menu-ports.js";
import { parseMenuAggregate, type MenuAggregate } from "../../contracts/category-menu.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogReference,
} from "../../contracts/product.js";
import { createPostgresMenuDraftSource } from "./menu-draft-source.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

/**
 * WP-2423 / DEC-MENU-REVISION: Menu draft repository for `category-menu-service`. A Menu points at its
 * current version; `ReplaceDraft` rewrites that version's content while it has not been submitted,
 * `Revise` starts a new current version once it has been submitted or published. Operation records,
 * result snapshots and audits are append-only; all writes run in the caller's transaction in the
 * Brand scope.
 */
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export function createPostgresMenuDraftStore(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  now(): string;
  /** Current Brand authority for this Menu, checked before every read and write. */
  authorize(tx: ProductLifecycleTransaction, menuReference: string | null): Promise<boolean>;
}): MenuRepositoryPort {
  const brand = parseCatalogReference(options.brandReference);
  const scope = async (tx: ProductLifecycleTransaction, menu: string | null) => {
    if (!(await options.authorize(tx, menu))) fail("CATALOG_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  };
  const read = (tx: ProductLifecycleTransaction, menu: string, at: string) =>
    createPostgresMenuDraftSource({
      brandReference: brand,
      transactions: { run: (work) => work(tx) },
      authorize: async () => true,
    }).load(menu, at);
  const lock = (tx: ProductLifecycleTransaction, key: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
  const replay = async (
    tx: ProductLifecycleTransaction,
    operation: string,
  ): Promise<MenuOperationRecord | null> => {
    const rows = (
      await tx.query<{
        action_code: string;
        intent_digest: string;
        menu_id: string;
        result_aggregate_version: number;
        snapshot_json: unknown;
      }>(
        `SELECT r.action_code,r.intent_digest,r.menu_id::text menu_id,r.result_aggregate_version,s.snapshot_json
         FROM rms_catalog.menu_operation_record r
         JOIN rms_catalog.menu_operation_snapshot s ON s.operation_id=r.operation_id
          AND s.brand_id=r.brand_id AND s.menu_id=r.menu_id AND s.result_aggregate_version=r.result_aggregate_version
         WHERE r.brand_id=$1 AND r.operation_id=$2`,
        [brand, operation],
      )
    ).rows;
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row || rows.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(row.intent_digest))
      return fail();
    const aggregate = parseMenuAggregate(row.snapshot_json);
    if (
      aggregate.brandReference !== brand ||
      aggregate.menuReference !== row.menu_id ||
      aggregate.aggregateVersion !== row.result_aggregate_version
    )
      return fail();
    return Object.freeze({
      action: row.action_code as MenuOperationRecord["action"],
      operationReference: parseCatalogReference(operation),
      operationIntentHash: parseCatalogHash(row.intent_digest.slice(7)),
      aggregate,
    });
  };
  const submitted = async (tx: ProductLifecycleTransaction, version: string) =>
    (
      await tx.query<{ submitted: boolean }>(
        "SELECT rms_catalog.menu_version_submitted($1) submitted",
        [version],
      )
    ).rows[0]?.submitted === true;
  /** Inserts a version's content: Stores, channels, order types, sections and placements. */
  const insertContent = async (
    tx: ProductLifecycleTransaction,
    aggregate: MenuAggregate,
    version: { readonly insert: boolean; readonly revisionOf: string | null },
  ) => {
    const d = aggregate.draft,
      menu = aggregate.menuReference,
      versionReference = d.versionReference;
    if (version.insert)
      await tx.query(
        "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,base_menu_id,default_locale,localized_names_json,created_at,updated_at,revision_of_version_id) VALUES($1,$2,$3,'Draft',$4,$5,$6,$7,$8,$9)",
        [
          versionReference,
          menu,
          brand,
          d.baseMenuReference,
          d.defaultLocale,
          JSON.stringify(d.localizedNames),
          d.createdAt,
          d.updatedAt,
          version.revisionOf,
        ],
      );
    for (const store of d.storeReferences)
      await tx.query(
        "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
        [versionReference, menu, brand, store],
      );
    for (const channel of d.channelCodes)
      await tx.query(
        "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,$4)",
        [versionReference, menu, brand, channel],
      );
    for (const orderType of d.orderTypeCodes)
      await tx.query(
        "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,$4)",
        [versionReference, menu, brand, orderType],
      );
    for (const section of d.sections) {
      await tx.query(
        "INSERT INTO rms_catalog.menu_section(menu_section_id,menu_version_id,menu_id,brand_id,internal_code,localized_names_json,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          section.sectionReference,
          versionReference,
          menu,
          brand,
          section.internalCode,
          JSON.stringify(section.localizedNames),
          section.sortOrder,
        ],
      );
      for (const category of section.categoryReferences)
        await tx.query(
          "INSERT INTO rms_catalog.menu_section_category(menu_section_id,menu_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
          [section.sectionReference, menu, brand, category],
        );
      for (const p of section.placements)
        await tx.query(
          "INSERT INTO rms_catalog.sellable_placement(placement_id,menu_section_id,menu_id,brand_id,sku_id,sellable_type,presentation_role,sort_order,pinned,localized_name_overrides_json,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Sku',$6,$7,$8,$9,$10,$11)",
          [
            p.placementReference,
            section.sectionReference,
            menu,
            brand,
            p.sellableReference,
            p.presentationRole,
            p.sortOrder,
            p.pinned,
            JSON.stringify(p.localizedNameOverrides),
            p.createdAt,
            p.createdByActorReference,
          ],
        );
    }
  };
  const deleteContent = async (tx: ProductLifecycleTransaction, menu: string, version: string) => {
    const sections = `SELECT menu_section_id FROM rms_catalog.menu_section WHERE menu_version_id=$1 AND menu_id=$2 AND brand_id=$3`;
    await tx.query(
      `DELETE FROM rms_catalog.sellable_placement WHERE menu_section_id IN (${sections}) AND menu_id=$2 AND brand_id=$3`,
      [version, menu, brand],
    );
    await tx.query(
      `DELETE FROM rms_catalog.menu_section_category WHERE menu_section_id IN (${sections}) AND menu_id=$2 AND brand_id=$3`,
      [version, menu, brand],
    );
    for (const table of [
      "menu_section",
      "menu_version_store",
      "menu_version_channel",
      "menu_version_order_type",
    ])
      await tx.query(
        `DELETE FROM rms_catalog.${table} WHERE menu_version_id=$1 AND menu_id=$2 AND brand_id=$3`,
        [version, menu, brand],
      );
  };
  const record = async (
    tx: ProductLifecycleTransaction,
    value: MenuOperationRecord,
    audit: AppendAuditRecordInput,
  ) => {
    const a = value.aggregate;
    await tx.query(
      "INSERT INTO rms_catalog.menu_operation_record(operation_id,brand_id,menu_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        value.operationReference,
        brand,
        a.menuReference,
        value.action,
        "sha256:" + value.operationIntentHash,
        a.aggregateVersion,
        a.updatedAt,
      ],
    );
    await tx.query(
      "INSERT INTO rms_catalog.menu_operation_snapshot(operation_id,brand_id,menu_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
      [
        value.operationReference,
        brand,
        a.menuReference,
        a.aggregateVersion,
        a.updatedAt,
        JSON.stringify(a),
      ],
    );
    await appendAuditRecordInTransaction(tx, audit);
  };
  /** The written Menu must read back exactly as the operation's result. */
  const confirm = async (tx: ProductLifecycleTransaction, expected: MenuAggregate) => {
    const saved = await read(tx, expected.menuReference, expected.updatedAt);
    // Stores, channels, order types and categories are sets; sections and placements follow sort order.
    const normal = (a: MenuAggregate) => ({
      ...a,
      draft: {
        ...a.draft,
        storeReferences: [...a.draft.storeReferences].sort(),
        channelCodes: [...a.draft.channelCodes].sort(),
        orderTypeCodes: [...a.draft.orderTypeCodes].sort(),
        sections: [...a.draft.sections]
          .sort((x, y) => x.sortOrder - y.sortOrder)
          .map((section) => ({
            ...section,
            categoryReferences: [...section.categoryReferences].sort(),
            placements: [...section.placements].sort((x, y) => x.sortOrder - y.sortOrder),
          })),
      },
    });
    if (
      saved === null ||
      canonicalizeRfc8785(normal(saved.aggregate)) !== canonicalizeRfc8785(normal(expected))
    )
      fail();
  };
  const checkAudit = (audit: AppendAuditRecordInput, aggregate: MenuAggregate, code: string) => {
    const valid = validateAuditRecord(audit, Date.parse(aggregate.updatedAt));
    if (
      valid.brandId !== brand ||
      valid.storeId !== undefined ||
      valid.actor.type === "System" ||
      valid.targetType !== "CatalogMenu" ||
      valid.targetId !== aggregate.menuReference ||
      valid.actionCode !== code ||
      valid.occurredAt !== aggregate.updatedAt
    )
      fail("CATALOG_PERMISSION_DENIED");
    return valid;
  };

  return Object.freeze<MenuRepositoryPort>({
    resolveOperation: (reference) =>
      options.transactions.run(async (tx) => {
        await scope(tx, null);
        const operation = parseCatalogReference(reference);
        await lock(tx, "CatalogMenuOperation:" + brand + ":" + operation);
        return replay(tx, operation);
      }),
    load: (reference) =>
      options.transactions.run(async (tx) => {
        const menu = parseCatalogReference(reference);
        await scope(tx, menu);
        return (await read(tx, menu, options.now()))?.aggregate ?? null;
      }),
    codeAvailable: (input) =>
      options.transactions.run(async (tx) => {
        await scope(tx, input.excludingMenuReference);
        if (parseCatalogReference(input.brandReference) !== brand)
          fail("CATALOG_PERMISSION_DENIED");
        await lock(tx, "CatalogMenuCodes:" + brand);
        const rows = (
          await tx.query<{ available: boolean }>(
            "SELECT NOT EXISTS(SELECT 1 FROM rms_catalog.menu WHERE brand_id=$1 AND internal_code=$2 AND ($3::uuid IS NULL OR menu_id<>$3)) available",
            [brand, parseCatalogCode(input.internalCode), input.excludingMenuReference],
          )
        ).rows;
        return rows[0]?.available === true;
      }),
    inspectBase: (input) =>
      options.transactions.run(async (tx) => {
        const menu = parseCatalogReference(input.menuReference);
        await scope(tx, menu);
        const base =
          input.baseMenuReference === null
            ? null
            : ((await read(tx, parseCatalogReference(input.baseMenuReference), options.now()))
                ?.aggregate ?? null);
        const isBase = (
          await tx.query<{ base: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM rms_catalog.menu_version WHERE brand_id=$1 AND base_menu_id=$2) base",
            [brand, menu],
          )
        ).rows[0];
        return { base, menuIsBase: isBase?.base === true };
      }),
    create: (input) =>
      options.transactions.run(async (tx) => {
        const aggregate = parseMenuAggregate(input.record.aggregate);
        const value = { ...input.record, aggregate };
        if (value.action !== "Create" || aggregate.brandReference !== brand)
          fail("CATALOG_INPUT_INVALID");
        const audit = checkAudit(input.audit, aggregate, "CATALOG_MENU_CREATE");
        await scope(tx, aggregate.menuReference);
        await lock(tx, "CatalogMenuOperation:" + brand + ":" + value.operationReference);
        const prior = await replay(tx, value.operationReference);
        if (prior !== null) {
          if (canonicalizeRfc8785(prior) !== canonicalizeRfc8785(value))
            fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        await tx.query(
          "INSERT INTO rms_catalog.menu(menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at,current_version_id) VALUES($1,$2,$3,1,$4,$5,$4,$6)",
          [
            aggregate.menuReference,
            brand,
            aggregate.internalCode,
            aggregate.createdAt,
            aggregate.createdByActorReference,
            aggregate.draft.versionReference,
          ],
        );
        await insertContent(tx, aggregate, { insert: true, revisionOf: null });
        await record(tx, value, audit);
        await scope(tx, aggregate.menuReference);
        await confirm(tx, aggregate);
        return value;
      }),
    commit: (input) =>
      options.transactions.run(async (tx) => {
        const aggregate = parseMenuAggregate(input.record.aggregate);
        const value = { ...input.record, aggregate };
        if (
          (value.action !== "ReplaceDraft" && value.action !== "Revise") ||
          aggregate.brandReference !== brand ||
          aggregate.aggregateVersion !== input.expectedAggregateVersion + 1
        )
          fail("CATALOG_INPUT_INVALID");
        const audit = checkAudit(
          input.audit,
          aggregate,
          value.action === "Revise" ? "CATALOG_MENU_REVISE" : "CATALOG_MENU_REPLACEDRAFT",
        );
        const menu = aggregate.menuReference;
        await scope(tx, menu);
        await lock(tx, "CatalogMenuOperation:" + brand + ":" + value.operationReference);
        const prior = await replay(tx, value.operationReference);
        if (prior !== null) {
          if (canonicalizeRfc8785(prior) !== canonicalizeRfc8785(value))
            fail("CATALOG_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        await lock(tx, "CatalogMenu:" + brand + ":" + menu);
        const current = await read(tx, menu, aggregate.updatedAt);
        if (
          current === null ||
          current.aggregate.aggregateVersion !== input.expectedAggregateVersion
        )
          return fail("CATALOG_VERSION_CONFLICT");
        const currentVersion = current.aggregate.draft.versionReference;
        const isSubmitted = await submitted(tx, currentVersion);
        if (value.action === "ReplaceDraft") {
          // A submitted version is frozen: start a revision first.
          if (isSubmitted || aggregate.draft.versionReference !== currentVersion)
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          await deleteContent(tx, menu, currentVersion);
          await tx.query(
            "UPDATE rms_catalog.menu_version SET base_menu_id=$4,default_locale=$5,localized_names_json=$6,updated_at=$7 WHERE menu_version_id=$1 AND menu_id=$2 AND brand_id=$3",
            [
              currentVersion,
              menu,
              brand,
              aggregate.draft.baseMenuReference,
              aggregate.draft.defaultLocale,
              JSON.stringify(aggregate.draft.localizedNames),
              aggregate.draft.updatedAt,
            ],
          );
          await insertContent(tx, aggregate, { insert: false, revisionOf: null });
        } else {
          // A revision starts only from a submitted or published version.
          if (!isSubmitted || aggregate.draft.versionReference === currentVersion)
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          await insertContent(tx, aggregate, { insert: true, revisionOf: currentVersion });
        }
        const updated = await tx.query(
          "UPDATE rms_catalog.menu SET aggregate_version=$3,updated_at=$4,current_version_id=$5 WHERE menu_id=$1 AND brand_id=$2 AND aggregate_version=$6",
          [
            menu,
            brand,
            aggregate.aggregateVersion,
            aggregate.updatedAt,
            aggregate.draft.versionReference,
            input.expectedAggregateVersion,
          ],
        );
        if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
        await record(tx, value, audit);
        await scope(tx, menu);
        await confirm(tx, aggregate);
        return value;
      }),
  });
}
