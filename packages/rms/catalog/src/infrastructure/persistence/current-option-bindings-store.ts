import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
  parseProductOptionBinding,
} from "../../contracts/product.js";
import {
  parseOptionSetAggregate,
  validateProductOptionBinding,
} from "../../contracts/option-set.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";
function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid option source");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    throw new Error("invalid option source");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid option source");
    result[field] = d.value;
  }
  return result;
}
const select = `SELECT jsonb_build_object('brandReference',s.brand_id,
'sellableReference',s.sku_id,
'productReference',s.product_id,
'productVersionReference',s.product_version_id,
'channelCode',$4::text,
'observedAt',to_char($5::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'bindings',COALESCE((SELECT jsonb_agg(CASE WHEN os.created_at <= $5::timestamptz AND os.updated_at <= $5::timestamptz
 AND v.created_at <= $5::timestamptz AND v.updated_at <= $5::timestamptz
 AND date_trunc('milliseconds',os.created_at)=os.created_at
 AND date_trunc('milliseconds',os.updated_at)=os.updated_at
 AND date_trunc('milliseconds',v.created_at)=v.created_at
 AND date_trunc('milliseconds',v.updated_at)=v.updated_at
 AND NOT EXISTS (SELECT 1 FROM rms_catalog.option t WHERE t.option_set_version_id=v.option_set_version_id
  AND t.option_set_id=v.option_set_id AND t.brand_id=v.brand_id
  AND (t.created_at > $5::timestamptz OR date_trunc('milliseconds',t.created_at)<>t.created_at))
 THEN jsonb_build_object('binding',jsonb_build_object('bindingReference',b.binding_id,
'optionSetReference',b.option_set_id,
'optionSetVersionReference',b.option_set_version_id,
'purpose',b.purpose,
'sortOrder',b.sort_order,
'enabledOptionReferences',COALESCE((SELECT jsonb_agg(x.option_id ORDER BY x.option_id) FROM rms_catalog.product_option_binding_option x WHERE x.binding_id=b.binding_id AND x.product_id=b.product_id AND x.brand_id=b.brand_id),'[]'::jsonb),
'defaultSelections',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionReference',x.option_id,'quantity',x.default_quantity) ORDER BY x.option_id) FROM rms_catalog.product_option_binding_option x WHERE x.binding_id=b.binding_id AND x.product_id=b.product_id AND x.brand_id=b.brand_id AND x.default_quantity IS NOT NULL),'[]'::jsonb),
'minimumSelectionOverride',b.minimum_selection_override,
'maximumSelectionOverride',b.maximum_selection_override,
'storeOverrideAllowed',b.store_override_allowed,
'includedSkuReferences',COALESCE((SELECT jsonb_agg(x.sku_id ORDER BY x.sku_id) FROM rms_catalog.product_option_binding_sku_scope x WHERE x.binding_id=b.binding_id AND x.product_id=b.product_id AND x.brand_id=b.brand_id AND x.scope_kind='Include'),'[]'::jsonb),
'excludedSkuReferences',COALESCE((SELECT jsonb_agg(x.sku_id ORDER BY x.sku_id) FROM rms_catalog.product_option_binding_sku_scope x WHERE x.binding_id=b.binding_id AND x.product_id=b.product_id AND x.brand_id=b.brand_id AND x.scope_kind='Exclude'),'[]'::jsonb),
'channelCodes',COALESCE((SELECT jsonb_agg(x.channel_code ORDER BY x.channel_code) FROM rms_catalog.product_option_binding_channel x WHERE x.binding_id=b.binding_id AND x.product_id=b.product_id AND x.brand_id=b.brand_id),'[]'::jsonb)),'optionSet',jsonb_build_object('optionSetReference',os.option_set_id,
'brandReference',os.brand_id,
'internalCode',os.internal_code,
'lifecycle',os.lifecycle,
'aggregateVersion',os.aggregate_version,
'draft',jsonb_build_object('versionReference',v.option_set_version_id,
'status',v.status,
'defaultLocale',v.default_locale,
'localizedNames',v.localized_names_json,
'localizedDescriptions',v.localized_descriptions_json,
'displayStyle',v.display_style,
'minimumSelection',v.minimum_selection,
'maximumSelection',v.maximum_selection,
'allowRepeatedOption',v.allow_repeated_option,
'perOptionMaximumQuantity',v.per_option_maximum_quantity,
'maximumTotalQuantity',v.maximum_total_quantity,
'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionReference',o.option_id,
'optionSetReference',o.option_set_id,
'brandReference',o.brand_id,
'stableCode',o.stable_code,
'lifecycle',o.lifecycle,
'localizedNames',o.localized_names_json,
'localizedDescriptions',o.localized_descriptions_json,
'sortOrder',o.sort_order,
'defaultEligible',o.default_eligible,
'triggeredOptionSetReference',o.triggered_option_set_id,
'conflictOptionReferences',COALESCE((SELECT jsonb_agg(c.conflict_option_id ORDER BY c.conflict_option_id) FROM rms_catalog.option_conflict c WHERE c.option_id=o.option_id AND c.option_set_id=o.option_set_id AND c.brand_id=o.brand_id),'[]'::jsonb),
'createdAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdByActorReference',o.created_by_actor_id) ORDER BY o.sort_order,o.option_id) FROM rms_catalog.option o WHERE o.option_set_version_id=v.option_set_version_id AND o.option_set_id=v.option_set_id AND o.brand_id=v.brand_id),'[]'::jsonb),
'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
'createdAt',to_char(os.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdByActorReference',os.created_by_actor_id,
'updatedAt',to_char(os.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ELSE NULL END ORDER BY b.sort_order,b.binding_id)
 FROM rms_catalog.product_option_binding b
 JOIN rms_catalog.option_set_version v ON v.option_set_version_id=b.option_set_version_id AND v.option_set_id=b.option_set_id AND v.brand_id=b.brand_id
 JOIN rms_catalog.option_set os ON os.option_set_id=v.option_set_id AND os.brand_id=v.brand_id
 WHERE b.product_version_id=s.product_version_id AND b.product_id=s.product_id AND b.brand_id=s.brand_id
 AND NOT EXISTS (SELECT 1 FROM rms_catalog.product_option_binding_sku_scope x WHERE x.binding_id=b.binding_id AND x.brand_id=b.brand_id AND x.product_id=b.product_id AND x.sku_id=s.sku_id AND x.scope_kind='Exclude')
 AND (NOT EXISTS (SELECT 1 FROM rms_catalog.product_option_binding_sku_scope x WHERE x.binding_id=b.binding_id AND x.brand_id=b.brand_id AND x.product_id=b.product_id AND x.scope_kind='Include')
   OR EXISTS (SELECT 1 FROM rms_catalog.product_option_binding_sku_scope x WHERE x.binding_id=b.binding_id AND x.brand_id=b.brand_id AND x.product_id=b.product_id AND x.scope_kind='Include' AND x.sku_id=s.sku_id))
 AND (NOT EXISTS (SELECT 1 FROM rms_catalog.product_option_binding_channel x WHERE x.binding_id=b.binding_id AND x.brand_id=b.brand_id AND x.product_id=b.product_id)
   OR EXISTS (SELECT 1 FROM rms_catalog.product_option_binding_channel x WHERE x.binding_id=b.binding_id AND x.brand_id=b.brand_id AND x.product_id=b.product_id AND x.channel_code=$4))
),'[]'::jsonb)) AS source
FROM rms_catalog.sku s
JOIN rms_catalog.product_version p ON p.product_version_id=s.product_version_id AND p.product_id=s.product_id AND p.brand_id=s.brand_id
WHERE s.brand_id=$1 AND s.sku_id=$2 AND s.product_version_id=$3
AND s.created_at <= $5::timestamptz AND p.created_at <= $5::timestamptz AND p.updated_at <= $5::timestamptz`;
/** Complete current binding facts; Draft labels are not menu publication or sale authority. */
export function createPostgresCurrentOptionBindingsStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string }>,
) {
  const brand = parseCatalogReference(closed(scope, ["brandReference"]).brandReference);
  return Object.freeze({
    async load(value: {
      readonly sellableReference: string;
      readonly productVersionReference: string;
      readonly channelCode: string;
      readonly observedAt: string;
    }) {
      try {
        const raw = closed(value, [
          "sellableReference",
          "productVersionReference",
          "channelCode",
          "observedAt",
        ]);
        const sku = parseCatalogReference(raw.sellableReference),
          version = parseCatalogReference(raw.productVersionReference),
          channel = parseCatalogCode(raw.channelCode),
          at = parseCatalogInstant(raw.observedAt);
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await tx.query(select, [brand, sku, version, channel, at]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) throw new Error("ambiguous option source");
          if (rows.length === 0) return null;
          const data = closed(closed(rows[0], ["source"]).source, [
            "brandReference",
            "sellableReference",
            "productReference",
            "productVersionReference",
            "channelCode",
            "observedAt",
            "bindings",
          ]);
          if (
            parseCatalogReference(data.brandReference) !== brand ||
            parseCatalogReference(data.sellableReference) !== sku ||
            parseCatalogReference(data.productVersionReference) !== version ||
            parseCatalogCode(data.channelCode) !== channel ||
            parseCatalogInstant(data.observedAt) !== at ||
            !Array.isArray(data.bindings) ||
            data.bindings.length > 100
          )
            throw new Error("incoherent option source");
          const bindings = Object.freeze(
            data.bindings.map((value) => {
              const pair = closed(value, ["binding", "optionSet"]);
              const binding = parseProductOptionBinding(pair.binding),
                optionSet = parseOptionSetAggregate(pair.optionSet);
              validateProductOptionBinding(binding, optionSet);
              if (
                optionSet.brandReference !== brand ||
                optionSet.updatedAt > at ||
                optionSet.createdAt > at ||
                optionSet.draft.createdAt > at ||
                optionSet.draft.updatedAt > at ||
                optionSet.draft.options.some((option) => option.createdAt > at) ||
                (binding.channelCodes.length > 0 && !binding.channelCodes.includes(channel)) ||
                binding.excludedSkuReferences.includes(sku) ||
                (binding.includedSkuReferences.length > 0 &&
                  !binding.includedSkuReferences.includes(sku))
              )
                throw new Error("incoherent option source");
              return Object.freeze({ binding, optionSet });
            }),
          );
          if (
            new Set(bindings.map((pair) => pair.binding.bindingReference)).size !== bindings.length
          )
            throw new Error("duplicate binding");
          return Object.freeze({
            brandReference: brand,
            sellableReference: sku,
            productReference: parseCatalogReference(data.productReference),
            productVersionReference: version,
            channelCode: channel,
            observedAt: at,
            bindings,
          });
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

/** Current complete OptionSet version for Product Draft validation in the caller transaction. */
export function createPostgresProductOptionSetSource(options: {
  brandReference: string;
  authorize(): Promise<boolean>;
  transaction: {
    query<Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
  };
}) {
  const brand = parseCatalogReference(options.brandReference);
  return {
    async resolveVersion(input: {
      brandReference: string;
      optionSetReference: string;
      optionSetVersionReference: string;
    }) {
      if (parseCatalogReference(input.brandReference) !== brand || !(await options.authorize()))
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const set = parseCatalogReference(input.optionSetReference);
      const version = parseCatalogReference(input.optionSetVersionReference);
      const tx = options.transaction;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [brand],
      );
      // Keep option/version content stable through validation and the caller's Draft commit.
      await tx.query(
        "LOCK TABLE rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict IN SHARE MODE",
        [],
      );
      const result = await tx.query<{ value: unknown }>(
        `SELECT jsonb_build_object('optionSetReference',os.option_set_id,
'brandReference',os.brand_id,
'internalCode',os.internal_code,
'lifecycle',os.lifecycle,
'aggregateVersion',os.aggregate_version,
'draft',jsonb_build_object('versionReference',v.option_set_version_id,
'status',v.status,
'defaultLocale',v.default_locale,
'localizedNames',v.localized_names_json,
'localizedDescriptions',v.localized_descriptions_json,
'displayStyle',v.display_style,
'minimumSelection',v.minimum_selection,
'maximumSelection',v.maximum_selection,
'allowRepeatedOption',v.allow_repeated_option,
'perOptionMaximumQuantity',v.per_option_maximum_quantity,
'maximumTotalQuantity',v.maximum_total_quantity,
'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionReference',o.option_id,
'optionSetReference',o.option_set_id,
'brandReference',o.brand_id,
'stableCode',o.stable_code,
'lifecycle',o.lifecycle,
'localizedNames',o.localized_names_json,
'localizedDescriptions',o.localized_descriptions_json,
'sortOrder',o.sort_order,
'defaultEligible',o.default_eligible,
'triggeredOptionSetReference',o.triggered_option_set_id,
'conflictOptionReferences',COALESCE((SELECT jsonb_agg(c.conflict_option_id ORDER BY c.conflict_option_id) FROM rms_catalog.option_conflict c WHERE c.option_id=o.option_id AND c.option_set_id=o.option_set_id AND c.brand_id=o.brand_id),'[]'::jsonb),
'createdAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdByActorReference',o.created_by_actor_id) ORDER BY o.sort_order,o.option_id) FROM rms_catalog.option o WHERE o.option_set_version_id=v.option_set_version_id AND o.option_set_id=v.option_set_id AND o.brand_id=v.brand_id),'[]'::jsonb),
'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
'createdAt',to_char(os.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdByActorReference',os.created_by_actor_id,
'updatedAt',to_char(os.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS value
 FROM rms_catalog.option_set os
 JOIN rms_catalog.option_set_version v ON v.option_set_id=os.option_set_id AND v.brand_id=os.brand_id
 WHERE os.brand_id=$1 AND os.option_set_id=$2 AND v.option_set_version_id=$3`,
        [brand, set, version],
      );
      if (!(await options.authorize())) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return parseOptionSetAggregate(result.rows[0]?.value);
    },
  };
}
