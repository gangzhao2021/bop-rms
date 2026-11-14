import {
  parseInventoryProductPublicationReferenceRequestV2,
  type InventoryProductPublicationReferenceRequestV2,
} from "../../contracts/product-publication-reference-request-v2.js";
import {
  buildInventoryProductPublicationConfigurationReferenceSnapshotV2,
  inventoryProductPublicationConfigurationReferenceFieldsV2,
  type InventoryProductPublicationConfigurationReferenceSnapshotV2,
} from "../../contracts/configuration-reference-source.js";
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

export interface InventoryProductPublicationConfigurationReferenceOptionsV2 extends Omit<
  InventoryConfigurationReferenceOptions,
  "authority"
> {
  readonly actorKind: "User" | "System";
  readonly registerBeforeCommit: (
    tx: InventoryConfigurationReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: InventoryConfigurationReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User" | "System";
        readonly request: InventoryProductPublicationReferenceRequestV2;
        readonly requiredPermissions: typeof inventoryConfigurationReferencePermissions;
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof inventoryProductPublicationConfigurationReferenceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
export function createPostgresInventoryProductPublicationConfigurationReferenceSourceV2(
  options: InventoryProductPublicationConfigurationReferenceOptionsV2,
) {
  const tenant = parseInventoryReference(options.tenantReference),
    brand = parseInventoryReference(options.brandReference),
    actor = parseInventoryReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    authority = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: InventoryProductPublicationReferenceRequestV2,
      work: (
        snapshot: InventoryProductPublicationConfigurationReferenceSnapshotV2,
        tx: InventoryConfigurationReferenceTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      let calls = 0,
        completed: { readonly value: T } | undefined,
        transaction: InventoryConfigurationReferenceTransaction | undefined,
        poisoned = false,
        finalCheck: (() => void) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        const request = parseInventoryProductPublicationReferenceRequestV2(input);
        if (
          typeof work !== "function" ||
          request.tenantReference !== tenant ||
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          request.actorKind !== kind
        )
          return fail();
        const result = await run(async (tx) => {
          if (++calls !== 1 || !tx || typeof tx !== "object" || typeof tx.query !== "function")
            return poison();
          transaction = tx;
          // A caught nested refusal must taint this actual enclosing transaction.
          if (active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          const originalQuery = tx.query,
            queryPort = originalQuery.bind(tx);
          let latest = request.observedAt,
            ready = false,
            guardCalls = 0,
            source: InventoryProductPublicationConfigurationReferenceSnapshotV2 | undefined;
          const check = () => {
            let at: string;
            try {
              at = parseInventoryInstant(now());
            } catch {
              return poison();
            }
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== originalQuery ||
              at < latest ||
              at >= request.validUntil
            )
              return poison();
            latest = at;
            return at;
          };
          const assertFinal = () => {
            if (!ready || !source) return poison();
            check();
          };
          finalCheck = assertFinal;
          const query: InventoryConfigurationReferenceTransaction["query"] = async <
            R extends Record<string, unknown>,
          >(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            const result = await queryPort<R>(sql, values);
            check();
            return result;
          };
          const authorize = async () => {
            const observedAt = check();
            if (
              (await authority(
                tx,
                Object.freeze({
                  tenantReference: tenant,
                  actorKind: kind,
                  request,
                  requiredPermissions: inventoryConfigurationReferencePermissions,
                  requiredScope: "FullBrandScope",
                  requiredFields: inventoryProductPublicationConfigurationReferenceFieldsV2,
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          const context = () =>
            query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          const verifyGeneration = async () => {
            if (!source) return poison();
            await context();
            const current = row(
              await query(
                "SELECT COALESCE((SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2),'0') AS generation",
                [tenant, brand],
              ),
              "generation",
            );
            if (current !== source.generation) return poison();
          };
          try {
            // Install before the first holder/read/clock check: a swallowed
            // early failure must still poison the enclosing transaction.
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1) return poison();
                    assertFinal();
                    await authorize();
                    await verifyGeneration();
                    assertFinal();
                  } catch (error) {
                    poisoned = true;
                    failed.add(tx);
                    throw error;
                  }
                },
                assertFinal,
              )) !== undefined
            )
              return poison();
            check();
            await authorize();
            if (
              row(
                await query("SELECT current_setting('transaction_isolation') AS isolation", []),
                "isolation",
              ) !== "read committed"
            )
              return poison();
            await context();
            await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "InventoryCatalogReferenceV1:" + tenant + ":" + brand,
            ]);
            source = buildInventoryProductPublicationConfigurationReferenceSnapshotV2(
              row(await query(select, [tenant, brand]), "source"),
              request,
              check(),
            );
            await authorize();
            const value = await work(source, tx);
            check();
            await authorize();
            await verifyGeneration();
            check();
            ready = true;
            completed = Object.freeze({ value });
            return completed;
          } catch (error) {
            poisoned = true;
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (
          poisoned ||
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !transaction ||
          failed.has(transaction) ||
          !finalCheck
        )
          return poison();
        finalCheck();
        return completed.value;
      } catch (error) {
        if (transaction) failed.add(transaction);
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
