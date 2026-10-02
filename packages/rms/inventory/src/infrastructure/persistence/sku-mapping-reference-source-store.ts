import { InventoryItemError, parseInventoryInstant } from "../../domain/inventory-item.js";
import {
  inventoryConfigurationReferencePermissions,
  inventoryConfigurationReferenceMaximumRows,
  type InventoryConfigurationReferenceRequest,
} from "../../contracts/configuration-reference-source.js";
import {
  buildInventorySkuMappingReferenceSnapshot,
  inventorySkuMappingReferenceFields,
  type InventorySkuMappingReferenceSnapshot,
} from "../../contracts/sku-mapping-reference-source.js";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  type InventoryConfigurationReferenceOptions,
  type InventoryConfigurationReferenceTransaction,
} from "./configuration-reference-source-store.js";
export interface InventorySkuMappingReferenceSourceOptions extends Omit<
  InventoryConfigurationReferenceOptions,
  "authority"
> {
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: InventoryConfigurationReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: InventoryConfigurationReferenceRequest;
        readonly requiredPermissions: typeof inventoryConfigurationReferencePermissions;
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof inventorySkuMappingReferenceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const select = `SELECT jsonb_build_object('generation',(SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2),
'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'count',(SELECT count(item_id)::text FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1 AND brand_id=$2),
'mappings',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('tenantReference',tenant_id,'brandReference',brand_id,'mappingReference',mapping_id,'itemReference',item_id,'mappingVersion',mapping_version::text,'sourceItemVersion',item_version::text,'sourceConfigurationOperationReference',configuration_operation_id,'action',action,
 'target',CASE WHEN action='Clear' THEN NULL ELSE jsonb_build_object('productReference',product_id,'productVersionReference',product_version_id,'skuReference',sku_id,'catalogConfigurationDigest',catalog_configuration_digest) END,
 'operationReference',operation_id,'mappingIntentDigest',intent_digest,'occurredAt',${utc("occurred_at")},'precise',date_trunc('milliseconds',occurred_at)=occurred_at AND occurred_at<=statement_timestamp()) value FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1 AND brand_id=$2 ORDER BY item_id,mapping_version LIMIT ${inventoryConfigurationReferenceMaximumRows + 1}) bounded)) source`;
/** Extend the owning configuration snapshot inside its existing physical shared
 * Inventory fence. No private Catalog reads, and no raw Audit/Actor/Item payload. */
export function createPostgresInventorySkuMappingReferenceSourceStore(
  options: InventorySkuMappingReferenceSourceOptions,
) {
  return Object.freeze({
    async withCurrentSnapshot<T>(
      request: InventoryConfigurationReferenceRequest,
      work: (source: InventorySkuMappingReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        let transaction: InventoryConfigurationReferenceTransaction | undefined;
        const base = createPostgresInventoryConfigurationReferenceSourceStore({
          ...options,
          transactions: {
            run: (callback) =>
              options.transactions.run(async (tx) => {
                transaction = tx;
                return callback(tx);
              }),
          },
          authority: {
            holdUntilTransactionCompletes: (tx, input) =>
              options.authority.holdUntilTransactionCompletes(tx, {
                ...input,
                requiredFields: inventorySkuMappingReferenceFields,
              }),
          },
        });
        return await base.withCurrentSnapshot(request, async (configuration) => {
          if (!transaction) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(transaction ?? fail(), {
              tenantReference: configuration.request.tenantReference,
              request: configuration.request,
              requiredPermissions: inventoryConfigurationReferencePermissions,
              requiredFields: inventorySkuMappingReferenceFields,
              requiredScope: "FullBrandScope",
              observedAt: parseInventoryInstant(options.clock.now()),
            });
          const result = await transaction.query(select, [
            configuration.request.tenantReference,
            configuration.request.brandReference,
          ]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          if (!rows || !("value" in rows) || !Array.isArray(rows.value) || rows.value.length !== 1)
            return fail();
          const entry = Object.getOwnPropertyDescriptor(rows.value, "0")?.value;
          if (
            !entry ||
            Object.getPrototypeOf(entry) !== Object.prototype ||
            Reflect.ownKeys(entry).length !== 1
          )
            return fail();
          const source = Object.getOwnPropertyDescriptor(entry, "source");
          if (!source?.enumerable || !("value" in source)) return fail();
          const snapshot = buildInventorySkuMappingReferenceSnapshot(
            source.value,
            configuration,
            configuration.request,
            options.clock.now(),
          );
          await authorize();
          const response = await work(snapshot);
          await authorize();
          const now = parseInventoryInstant(options.clock.now());
          if (now < snapshot.observedAt || Date.parse(now) - Date.parse(snapshot.observedAt) > 5000)
            return fail();
          return response;
        });
      } catch (error) {
        if (
          error instanceof InventoryItemError &&
          error.code === "INVENTORY_ITEM_PERMISSION_DENIED"
        )
          throw error;
        return fail();
      }
    },
  });
}
