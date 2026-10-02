import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../../domain/inventory-item.js";
import {
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  inventoryConfigurationReferenceMaximumRows,
  parseInventoryConfigurationReferenceRequest,
  buildInventoryConfigurationReferenceSnapshot,
  type InventoryConfigurationReferenceRequest,
  type InventoryConfigurationReferenceSnapshot,
} from "../../contracts/configuration-reference-source.js";
export interface InventoryConfigurationReferenceTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}
export interface InventoryConfigurationReferenceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: InventoryConfigurationReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: InventoryConfigurationReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: InventoryConfigurationReferenceRequest;
        readonly requiredPermissions: typeof inventoryConfigurationReferencePermissions;
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof inventoryConfigurationReferenceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
function row(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  if (!Array.isArray(rows) || rows.length !== 1) return fail();
  const entry = Object.getOwnPropertyDescriptor(rows, "0")?.value;
  if (
    !entry ||
    Object.getPrototypeOf(entry) !== Object.prototype ||
    Reflect.ownKeys(entry).length !== 1
  )
    return fail();
  const d = Object.getOwnPropertyDescriptor(entry, key);
  if (!d?.enumerable || !("value" in d)) return fail();
  return d.value;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const sourceLimit = inventoryConfigurationReferenceMaximumRows + 1;
const select = `SELECT jsonb_build_object(
'generation',(SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2),
'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'counts',jsonb_build_object('items',(SELECT count(item_id)::text FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2),'versions',(SELECT count(item_id)::text FROM rms_inventory.inventory_item_version WHERE tenant_id=$1 AND brand_id=$2),'operations',(SELECT count(operation_id)::text FROM rms_inventory.inventory_item_operation WHERE tenant_id=$1 AND brand_id=$2)),
'items',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('tenantReference',c.tenant_id,'brandReference',c.brand_id,'itemReference',c.item_id,'itemType',c.item_type,'createdAt',${utc("c.created_at")},'precise',date_trunc('milliseconds',c.created_at)=c.created_at AND c.created_at<=statement_timestamp()) value FROM rms_inventory.inventory_item c WHERE c.tenant_id=$1 AND c.brand_id=$2 ORDER BY c.item_id LIMIT ${sourceLimit}) bounded),
'versions',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('tenantReference',c.tenant_id,'brandReference',c.brand_id,'itemReference',c.item_id,'itemVersion',c.version::text,'itemType',c.snapshot_json->>'itemType','lifecycle',c.snapshot_json->>'lifecycle','recordedAt',${utc("c.recorded_at")},'precise',date_trunc('milliseconds',c.recorded_at)=c.recorded_at AND c.recorded_at<=statement_timestamp() AND c.snapshot_json->>'tenantReference'=c.tenant_id::text AND c.snapshot_json->>'brandReference'=c.brand_id::text AND c.snapshot_json->>'itemReference'=c.item_id::text AND c.snapshot_json->>'aggregateVersion'=c.version::text AND c.snapshot_json->>'updatedAt'=${utc("c.recorded_at")}) value FROM rms_inventory.inventory_item_version c WHERE c.tenant_id=$1 AND c.brand_id=$2 ORDER BY c.item_id,c.version LIMIT ${sourceLimit}) bounded),
'operations',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('tenantReference',c.tenant_id,'brandReference',c.brand_id,'itemReference',c.item_id,'itemVersion',c.version::text,'operationReference',c.operation_id,'action',c.action) value FROM rms_inventory.inventory_item_operation c WHERE c.tenant_id=$1 AND c.brand_id=$2 ORDER BY c.operation_id LIMIT ${sourceLimit}) bounded)) source`;
/** Supported Inventory writers are fenced through caller COMMIT. Callback must not mutate
 * Inventory sources or acquire per-Item writer locks; bind the runner to the caller UoW after the owning Product holder. */
export function createPostgresInventoryConfigurationReferenceSourceStore(
  options: InventoryConfigurationReferenceOptions,
) {
  const tenantReference = parseInventoryReference(options.tenantReference),
    brand = parseInventoryReference(options.brandReference),
    actor = parseInventoryReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: InventoryConfigurationReferenceRequest,
      work: (snapshot: InventoryConfigurationReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseInventoryConfigurationReferenceRequest(input);
        if (
          request.tenantReference !== tenantReference ||
          request.brandReference !== brand ||
          request.actorReference !== actor
        )
          return fail();
        let calls = 0,
          completed: { readonly value: T } | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                requiredPermissions: inventoryConfigurationReferencePermissions,
                requiredScope: "FullBrandScope",
                requiredFields: inventoryConfigurationReferenceFields,
                observedAt: parseInventoryInstant(options.clock.now()),
              }),
            );
          await authorize();
          if (
            row(
              await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
              "isolation",
            ) !== "read committed"
          )
            return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [tenantReference, brand],
          );
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
            "InventoryCatalogReferenceV1:" + tenantReference + ":" + brand,
          ]);
          const source = buildInventoryConfigurationReferenceSnapshot(
            row(await tx.query(select, [tenantReference, brand]), "source"),
            request,
            options.clock.now(),
          );
          await authorize();
          completed = Object.freeze({ value: await work(source) });
          await authorize();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenantReference, brand],
          );
          const current = row(
            await tx.query(
              "SELECT jsonb_build_object('generation',COALESCE((SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2),'0')) AS header",
              [tenantReference, brand],
            ),
            "header",
          );
          if (
            !current ||
            typeof current !== "object" ||
            Object.getPrototypeOf(current) !== Object.prototype ||
            Reflect.ownKeys(current).length !== 1 ||
            Object.getOwnPropertyDescriptor(current, "generation")?.value !== source.generation
          )
            return fail();
          const at = parseInventoryInstant(options.clock.now());
          if (at < source.observedAt || Date.parse(at) - Date.parse(source.observedAt) > 5000)
            return fail();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
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
