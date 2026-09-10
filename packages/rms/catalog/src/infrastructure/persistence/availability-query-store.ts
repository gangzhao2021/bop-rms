import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import {
  parseAvailabilityRule,
  type AvailabilityRuleAggregate,
} from "../../contracts/availability.js";

export interface AvailabilityQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface AvailabilityQueryTransactionRunner {
  /** Use a dedicated read-only transaction and clear local context before releasing the connection. */
  run<T>(action: (transaction: AvailabilityQueryTransaction) => Promise<T>): Promise<T>;
}
export interface AvailabilityRuleQueryInput {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sellableReference: string;
  readonly channelCode: string;
  readonly orderTypeCode: string;
  readonly observedAt: string;
}

const select = `SELECT jsonb_build_object(
  'ruleReference', availability_rule_id, 'brandReference', brand_id,
  'internalCode', internal_code, 'aggregateVersion', aggregate_version,
  'lifecycle', lifecycle, 'sellableReference', sku_id, 'sellableType', 'Sku',
  'storeReference', store_id, 'channelCodes', channel_codes_json,
  'orderTypeCodes', order_type_codes_json,
  'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'effectiveUntil', to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'decision', decision, 'priority', priority, 'reasonCode', reason_code,
  'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'createdByActorReference', created_by_actor_id,
  'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS rule FROM rms_catalog.availability_rule
WHERE brand_id = $1 AND (store_id IS NULL OR store_id = $2) AND sku_id = $3
  AND lifecycle = 'Active' AND effective_from <= $6::timestamptz
  AND (effective_until IS NULL OR effective_until > $6::timestamptz)
  AND (channel_codes_json = '[]'::jsonb OR channel_codes_json @> jsonb_build_array($4::text))
  AND (order_type_codes_json = '[]'::jsonb OR order_type_codes_json @> jsonb_build_array($5::text))
ORDER BY availability_rule_id`;

function closed(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
    result[field] = descriptor.value;
  }
  return result;
}

/** Internal owner read port; caller authorizes scope. Rules alone grant no sale authority. */
export function createPostgresAvailabilityQueryStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const fixed = closed(scope, ["brandReference", "storeReference"]);
  const brand = parseCatalogReference(fixed.brandReference);
  const store = parseCatalogReference(fixed.storeReference);
  return Object.freeze({
    async loadCurrentRules(
      value: AvailabilityRuleQueryInput,
    ): Promise<readonly AvailabilityRuleAggregate[]> {
      try {
        const raw = closed(value, [
          "brandReference",
          "storeReference",
          "sellableReference",
          "channelCode",
          "orderTypeCode",
          "observedAt",
        ]);
        if (
          parseCatalogReference(raw.brandReference) !== brand ||
          parseCatalogReference(raw.storeReference) !== store
        )
          throw new Error();
        const sku = parseCatalogReference(raw.sellableReference);
        const channel = parseCatalogCode(raw.channelCode);
        const orderType = parseCatalogCode(raw.orderTypeCode);
        const observedAt = parseCatalogInstant(raw.observedAt);
        const values = Object.freeze([brand, store, sku, channel, orderType, observedAt]);
        return await runner.run(async (transaction) => {
          // Existing rule RLS is Brand-only. The SELECT independently enforces Store applicability.
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(select, values);
          if (
            result === null ||
            typeof result !== "object" ||
            !("rows" in result) ||
            !Array.isArray(result.rows)
          )
            throw new Error();
          const rules = result.rows.map((row: { rule?: unknown } | null) => {
            const rule = parseAvailabilityRule(row?.rule);
            if (
              rule.brandReference !== brand ||
              rule.sellableReference !== sku ||
              rule.sellableType !== "Sku" ||
              (rule.storeReference !== null && rule.storeReference !== store) ||
              rule.lifecycle !== "Active" ||
              rule.effectiveFrom > observedAt ||
              (rule.effectiveUntil !== null && rule.effectiveUntil <= observedAt) ||
              rule.updatedAt > observedAt ||
              (rule.channelCodes.length > 0 && !rule.channelCodes.includes(channel)) ||
              (rule.orderTypeCodes.length > 0 && !rule.orderTypeCodes.includes(orderType))
            )
              throw new Error();
            return rule;
          });
          if (new Set(rules.map((rule) => rule.ruleReference)).size !== rules.length)
            throw new Error();
          return Object.freeze(rules);
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
