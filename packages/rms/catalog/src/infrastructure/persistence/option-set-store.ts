import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type {
  OptionSetOperationRecord,
  OptionSetPorts,
} from "../../application/ports/option-set-ports.js";
import { parseOptionSetAggregate, type OptionSetAggregate } from "../../domain/option-set.js";
import { CatalogError, parseCatalogHash, parseCatalogReference } from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

/**
 * WP-2423 slice 4: Option Set repository for `option-set-service` in the Brand back office. One
 * editable version per set is changed in place (pilot simplification, as Products); each operation
 * appends its record, the exact result snapshot and an Audit in the caller's transaction.
 */
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const aggregateSql = `SELECT jsonb_build_object(
  'optionSetReference',os.option_set_id,'brandReference',os.brand_id,'internalCode',os.internal_code,
  'lifecycle',os.lifecycle,'aggregateVersion',os.aggregate_version,
  'draft',jsonb_build_object('versionReference',v.option_set_version_id,'status',v.status,
    'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,
    'localizedDescriptions',v.localized_descriptions_json,'displayStyle',v.display_style,
    'minimumSelection',v.minimum_selection,'maximumSelection',v.maximum_selection,
    'allowRepeatedOption',v.allow_repeated_option,'perOptionMaximumQuantity',v.per_option_maximum_quantity,
    'maximumTotalQuantity',v.maximum_total_quantity,
    'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionReference',o.option_id,
      'optionSetReference',o.option_set_id,'brandReference',o.brand_id,'stableCode',o.stable_code,
      'lifecycle',o.lifecycle,'localizedNames',o.localized_names_json,
      'localizedDescriptions',o.localized_descriptions_json,'sortOrder',o.sort_order,
      'defaultEligible',o.default_eligible,'triggeredOptionSetReference',o.triggered_option_set_id,
      'conflictOptionReferences',COALESCE((SELECT jsonb_agg(c.conflict_option_id ORDER BY c.conflict_option_id)
        FROM rms_catalog.option_conflict c WHERE c.option_id=o.option_id AND c.brand_id=o.brand_id),'[]'::jsonb),
      'createdAt',${iso("o.created_at")},'createdByActorReference',o.created_by_actor_id)
      ORDER BY o.sort_order,o.option_id)
      FROM rms_catalog.option o WHERE o.option_set_version_id=v.option_set_version_id AND o.brand_id=v.brand_id),'[]'::jsonb),
    'createdAt',${iso("v.created_at")},'updatedAt',${iso("v.updated_at")}),
  'createdAt',${iso("os.created_at")},'createdByActorReference',os.created_by_actor_id,
  'updatedAt',${iso("os.updated_at")}) AS aggregate
 FROM rms_catalog.option_set os JOIN rms_catalog.option_set_version v
  ON v.option_set_id=os.option_set_id AND v.brand_id=os.brand_id AND v.status='Draft'`;
const brandScope = (tx: ProductLifecycleTransaction, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);

/** The Brand's Option Sets with their current editable version, by internal code. */
export async function listBrandOptionSets(
  tx: ProductLifecycleTransaction,
  scope: { readonly brandReference: string },
): Promise<readonly OptionSetAggregate[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  const { rows } = await tx.query<{ aggregate: unknown }>(
    `${aggregateSql} WHERE os.brand_id=$1 ORDER BY os.internal_code LIMIT 500`,
    [brand],
  );
  return Object.freeze(rows.map((row) => parseOptionSetAggregate(row.aggregate)));
}

export function createPostgresOptionSetRepository(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  /** Current authority for the write, checked before every read and write. */
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}): OptionSetPorts["repository"] {
  const brand = parseCatalogReference(options.brandReference);
  const scoped = <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) =>
    options.transactions.run(async (tx) => {
      if (!(await options.authorize(tx))) fail("CATALOG_PERMISSION_DENIED");
      await brandScope(tx, brand);
      return work(tx);
    });
  const load = async (tx: ProductLifecycleTransaction, reference: string) => {
    const { rows } = await tx.query<{ aggregate: unknown }>(
      `${aggregateSql} WHERE os.brand_id=$1 AND os.option_set_id=$2`,
      [brand, reference],
    );
    const row = rows[0];
    return row === undefined ? null : parseOptionSetAggregate(row.aggregate);
  };
  const readOperation = async (
    tx: ProductLifecycleTransaction,
    operation: string,
  ): Promise<OptionSetOperationRecord | null> => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT r.action_code,r.intent_digest,r.result_aggregate_version,r.option_set_id::text set_id,s.record_json
         FROM rms_catalog.option_set_operation_record r
         LEFT JOIN rms_catalog.option_set_operation_snapshot s ON s.operation_id=r.operation_id
        WHERE r.brand_id=$1 AND r.operation_id=$2`,
      [brand, operation],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const record = row.record_json as OptionSetOperationRecord | null;
    if (record === null || typeof record !== "object") return fail();
    const aggregate = parseOptionSetAggregate(record.aggregate);
    if (
      record.operationReference !== operation ||
      record.action !== row.action_code ||
      "sha256:" + record.operationIntentHash !== row.intent_digest ||
      aggregate.optionSetReference !== row.set_id ||
      aggregate.aggregateVersion !== Number(row.result_aggregate_version) ||
      aggregate.brandReference !== brand
    )
      return fail();
    return Object.freeze({
      action: record.action,
      operationReference: parseCatalogReference(record.operationReference),
      operationIntentHash: parseCatalogHash(record.operationIntentHash),
      aggregate,
    });
  };
  const checkAudit = (audit: AppendAuditRecordInput, record: OptionSetOperationRecord) => {
    const valid = validateAuditRecord(audit, Date.parse(record.aggregate.updatedAt));
    if (
      valid.brandId !== brand ||
      valid.storeId !== undefined ||
      valid.targetType !== "CatalogOptionSet" ||
      valid.targetId !== record.aggregate.optionSetReference ||
      valid.actionCode !== `CATALOG_OPTION_SET_${record.action.toUpperCase()}` ||
      valid.actor.type === "System"
    )
      return fail("CATALOG_PERMISSION_DENIED");
    return valid;
  };
  const lock = (tx: ProductLifecycleTransaction, reference: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CatalogOptionSetOperation:" + brand + ":" + reference,
    ]);
  /** Writes the version's options (in place: options are never removed) and their conflicts. */
  const writeOptions = async (tx: ProductLifecycleTransaction, aggregate: OptionSetAggregate) => {
    const { draft } = aggregate;
    // Sort orders are unique per version: move existing ones out of the way first.
    await tx.query(
      "UPDATE rms_catalog.option SET sort_order=sort_order+100000 WHERE brand_id=$1 AND option_set_version_id=$2",
      [brand, draft.versionReference],
    );
    for (const option of draft.options) {
      const values = [
        option.optionReference,
        draft.versionReference,
        aggregate.optionSetReference,
        brand,
        option.stableCode,
        option.lifecycle,
        JSON.stringify(option.localizedNames),
        JSON.stringify(option.localizedDescriptions),
        option.sortOrder,
        option.defaultEligible,
        option.triggeredOptionSetReference,
        option.createdAt,
        option.createdByActorReference,
      ];
      const updated = await tx.query(
        `UPDATE rms_catalog.option SET lifecycle=$6,localized_names_json=$7::jsonb,localized_descriptions_json=$8::jsonb,
           sort_order=$9,default_eligible=$10,triggered_option_set_id=$11
         WHERE option_id=$1 AND option_set_version_id=$2 AND option_set_id=$3 AND brand_id=$4 AND stable_code=$5
           AND created_at=$12 AND created_by_actor_id=$13`,
        values,
      );
      if (updated.rowCount === 0)
        await tx.query(
          `INSERT INTO rms_catalog.option(option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,
             localized_names_json,localized_descriptions_json,sort_order,default_eligible,triggered_option_set_id,created_at,created_by_actor_id)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
          values,
        );
    }
    await tx.query(
      "DELETE FROM rms_catalog.option_conflict WHERE brand_id=$1 AND option_set_id=$2",
      [brand, aggregate.optionSetReference],
    );
    for (const option of draft.options)
      for (const conflict of option.conflictOptionReferences)
        await tx.query(
          "INSERT INTO rms_catalog.option_conflict(option_id,conflict_option_id,option_set_id,brand_id) VALUES($1,$2,$3,$4)",
          [option.optionReference, conflict, aggregate.optionSetReference, brand],
        );
  };
  const versionValues = (aggregate: OptionSetAggregate) => {
    const { draft } = aggregate;
    return [
      draft.versionReference,
      aggregate.optionSetReference,
      brand,
      draft.defaultLocale,
      JSON.stringify(draft.localizedNames),
      JSON.stringify(draft.localizedDescriptions),
      draft.displayStyle,
      draft.minimumSelection,
      draft.maximumSelection,
      draft.allowRepeatedOption,
      draft.perOptionMaximumQuantity,
      draft.maximumTotalQuantity,
      draft.createdAt,
      draft.updatedAt,
    ];
  };
  const append = async (
    tx: ProductLifecycleTransaction,
    record: OptionSetOperationRecord,
    audit: AppendAuditRecordInput,
  ) => {
    await tx.query(
      "INSERT INTO rms_catalog.option_set_operation_record(operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        record.operationReference,
        brand,
        record.aggregate.optionSetReference,
        record.action,
        "sha256:" + record.operationIntentHash,
        record.aggregate.aggregateVersion,
        record.aggregate.updatedAt,
      ],
    );
    await tx.query(
      "INSERT INTO rms_catalog.option_set_operation_snapshot(operation_id,brand_id,option_set_id,record_json) VALUES($1,$2,$3,$4::jsonb)",
      [
        record.operationReference,
        brand,
        record.aggregate.optionSetReference,
        canonicalizeRfc8785(JSON.parse(JSON.stringify(record)) as never),
      ],
    );
    await appendAuditRecordInTransaction(tx, audit);
  };
  const confirm = async (tx: ProductLifecycleTransaction, record: OptionSetOperationRecord) => {
    const saved = await readOperation(tx, record.operationReference);
    const current = await load(tx, record.aggregate.optionSetReference);
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
          "SELECT 1 FROM rms_catalog.option_set WHERE brand_id=$1 AND internal_code=$2 AND ($3::uuid IS NULL OR option_set_id<>$3::uuid)",
          [brand, input.internalCode, input.excludingOptionSetReference],
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
          "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            aggregate.optionSetReference,
            brand,
            aggregate.internalCode,
            aggregate.lifecycle,
            aggregate.aggregateVersion,
            aggregate.createdAt,
            aggregate.createdByActorReference,
            aggregate.updatedAt,
          ],
        );
        await tx.query(
          `INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,
             localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,
             allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at)
           VALUES($1,$2,$3,'Draft',$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`,
          versionValues(aggregate),
        );
        await writeOptions(tx, aggregate);
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
        const updated = await tx.query(
          "UPDATE rms_catalog.option_set SET lifecycle=$3,aggregate_version=$4,updated_at=$5 WHERE brand_id=$1 AND option_set_id=$2 AND aggregate_version=$6",
          [
            brand,
            aggregate.optionSetReference,
            aggregate.lifecycle,
            aggregate.aggregateVersion,
            aggregate.updatedAt,
            input.expectedAggregateVersion,
          ],
        );
        if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
        if (record.action === "ReplaceDraft") {
          const version = await tx.query(
            `UPDATE rms_catalog.option_set_version SET default_locale=$4,localized_names_json=$5::jsonb,
               localized_descriptions_json=$6::jsonb,display_style=$7,minimum_selection=$8,maximum_selection=$9,
               allow_repeated_option=$10,per_option_maximum_quantity=$11,maximum_total_quantity=$12,updated_at=$14
             WHERE option_set_version_id=$1 AND option_set_id=$2 AND brand_id=$3 AND status='Draft' AND created_at=$13`,
            versionValues(aggregate),
          );
          if (version.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          await writeOptions(tx, aggregate);
        }
        await append(tx, record, audit);
        return confirm(tx, record);
      }),
  });
}
