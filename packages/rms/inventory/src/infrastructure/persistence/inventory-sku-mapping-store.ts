import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../../domain/inventory-item.js";
import {
  parseInventorySkuMappingCommand,
  parseInventorySkuMappingCurrentItem,
  type InventorySkuMappingCommand,
  type InventorySkuMappingHeldSku,
  type InventorySkuMappingVersion,
} from "../../domain/inventory-sku-mapping.js";
import {
  inventorySkuMappingWriteFields,
  inventorySkuMappingIntentDigest,
  planInventorySkuMapping,
  recoverInventorySkuMapping,
  verifyInventorySkuMappingVersion,
} from "../../contracts/inventory-sku-mapping.js";
import type { InventoryConfigurationReferenceTransaction } from "./configuration-reference-source-store.js";

export const inventorySkuMappingWritePermissions = Object.freeze([
  "inventory.item.update",
  "catalog.sku.read",
] as const);
export interface InventorySkuMappingStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: InventoryConfigurationReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    /** Current permission, fine-field, full Brand and Phase lease, including replay;
     * the physical connection must retain the authority fence through COMMIT. */
    holdUntilTransactionCompletes(
      tx: InventoryConfigurationReferenceTransaction,
      input: {
        readonly command: InventorySkuMappingCommand;
        readonly requiredPermissions: typeof inventorySkuMappingWritePermissions;
        readonly requiredFields: typeof inventorySkuMappingWriteFields;
        readonly requiredScope: "FullBrandScope";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly catalog: {
    /** Owning public Catalog contract, not caller-supplied facts. Hold the current
     * Product/SKU/configuration and current sku.read/Phase authority on this same
     * RC physical UoW through COMMIT. Acquire Catalog locks before invoking work;
     * after work must not acquire additional Catalog writer locks. */
    withHeldCurrentSku<T>(
      tx: InventoryConfigurationReferenceTransaction,
      input: {
        readonly command: InventorySkuMappingCommand;
        readonly mappingIntentDigest: string;
      },
      work: (source: InventorySkuMappingHeldSku) => Promise<T>,
    ): Promise<T>;
  };
  readonly audit: { create(version: InventorySkuMappingVersion): AppendAuditRecordInput };
}
export interface InventorySkuMappingWriteResult {
  readonly version: InventorySkuMappingVersion;
  readonly outcome: "Applied" | "AlreadyApplied";
}
const fail = (
  code: InventoryItemError["code"] = "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new InventoryItemError(code);
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function single(value: unknown): unknown | null {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return fail();
  if (d.value.length === 0) return null;
  const entry = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!entry || !("value" in entry)) return fail();
  return entry.value;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const selectVersion = `SELECT jsonb_build_object(
 'tenantReference',tenant_id,'brandReference',brand_id,'mappingReference',mapping_id,'itemReference',item_id,
 'mappingVersion',mapping_version,'sourceItemVersion',item_version,'sourceConfigurationOperationReference',configuration_operation_id,
 'action',action,'target',CASE WHEN action='Clear' THEN NULL ELSE jsonb_build_object('productReference',product_id,'productVersionReference',product_version_id,'skuReference',sku_id,'catalogConfigurationDigest',catalog_configuration_digest) END,
 'operationReference',operation_id,'mappingIntentDigest',intent_digest,'actorReference',actor_id,'occurredAt',${utc("occurred_at")},'reasonCode',reason_code) AS record,audit_json AS audit
 FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1 AND brand_id=$2`;
const selectItem = `SELECT jsonb_build_object('tenantReference',i.tenant_id,'brandReference',i.brand_id,'itemReference',i.item_id,'itemType',i.item_type,
 'lifecycle',v.snapshot_json->>'lifecycle','itemVersion',v.version,'configurationOperationReference',o.operation_id,'recordedAt',${utc("v.recorded_at")},
 'coverage','CurrentConfiguration','observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")}) AS source,
 (date_trunc('milliseconds',v.recorded_at)=v.recorded_at AND v.recorded_at<=statement_timestamp() AND v.snapshot_json->>'tenantReference'=i.tenant_id::text
 AND v.snapshot_json->>'brandReference'=i.brand_id::text AND v.snapshot_json->>'itemReference'=i.item_id::text
 AND v.snapshot_json->>'itemType'=i.item_type AND v.snapshot_json->>'aggregateVersion'=v.version::text AND v.snapshot_json->>'updatedAt'=${utc("v.recorded_at")}) AS precise
 FROM rms_inventory.inventory_item i JOIN LATERAL (SELECT version,snapshot_json,recorded_at FROM rms_inventory.inventory_item_version WHERE tenant_id=i.tenant_id AND brand_id=i.brand_id AND item_id=i.item_id ORDER BY version DESC LIMIT 1) v ON true
 JOIN rms_inventory.inventory_item_operation o ON o.tenant_id=i.tenant_id AND o.brand_id=i.brand_id AND o.item_id=i.item_id AND o.version=v.version
 WHERE i.tenant_id=$1 AND i.brand_id=$2 AND i.item_id=$3`;
function checkedAudit(value: unknown, v: InventorySkuMappingVersion): AppendAuditRecordInput {
  const raw = closed(value, [
    "auditId",
    "brandId",
    "actor",
    "actionCode",
    "targetType",
    "targetId",
    "reasonCode",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "dataClassification",
    "retentionPolicyCode",
    "retentionPolicyVersion",
  ]);
  for (const field of [
    "auditId",
    "brandId",
    "actionCode",
    "targetType",
    "targetId",
    "reasonCode",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "dataClassification",
    "retentionPolicyCode",
  ])
    if (typeof raw[field] !== "string") return fail();
  if (
    typeof raw.retentionPolicyVersion !== "number" ||
    !Number.isSafeInteger(raw.retentionPolicyVersion) ||
    raw.retentionPolicyVersion < 1
  )
    return fail();
  const actor = closed(raw.actor, ["type", "reference"]);
  if (actor.type !== "User" || typeof actor.reference !== "string") return fail();
  const a = validateAuditRecord({ ...raw, actor: { ...actor } }, Date.parse(v.occurredAt));
  if (
    a.brandId !== v.brandReference ||
    a.actor.type !== "User" ||
    a.actor.reference !== v.actorReference ||
    a.actionCode !== "INVENTORY_SKU_MAPPING_" + v.action.toUpperCase() ||
    a.targetType !== "InventorySkuMapping" ||
    a.targetId !== v.mappingReference ||
    a.correlationId !== v.operationReference ||
    a.occurredAt !== v.occurredAt ||
    a.reasonCode !== v.reasonCode ||
    a.dataClassification !== "Internal"
  )
    return fail();
  return Object.freeze({ ...a, actor: Object.freeze({ ...a.actor }) });
}
/** Inventory-owned append-only mapping writer. An absent Catalog lease/authority
 * dependency fails closed; this factory does not configure a normal runtime. */
export function createPostgresInventorySkuMappingStore(options: InventorySkuMappingStoreOptions) {
  const tenant = parseInventoryReference(options.tenantReference),
    brand = parseInventoryReference(options.brandReference),
    actor = parseInventoryReference(options.actorReference);
  return Object.freeze({
    async execute(input: InventorySkuMappingCommand): Promise<InventorySkuMappingWriteResult> {
      const command = parseInventorySkuMappingCommand(input);
      if (
        command.tenantReference !== tenant ||
        command.brandReference !== brand ||
        command.actorReference !== actor
      )
        return fail("INVENTORY_ITEM_PERMISSION_DENIED");
      try {
        let calls = 0;
        let completed: InventorySkuMappingWriteResult | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                command,
                requiredPermissions: inventorySkuMappingWritePermissions,
                requiredFields: inventorySkuMappingWriteFields,
                requiredScope: "FullBrandScope",
                observedAt: parseInventoryInstant(options.clock.now()),
              }),
            );
          const bind = () =>
            tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
              [tenant, brand],
            );
          await authorize();
          if (
            closed(
              single(
                await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
              ),
              ["isolation"],
            ).isolation !== "read committed"
          )
            return fail();
          await bind();
          const decode = (value: unknown) => {
            const r = closed(value, ["record", "audit"]),
              v = verifyInventorySkuMappingVersion(r.record);
            if (v.tenantReference !== tenant || v.brandReference !== brand) return fail();
            checkedAudit(r.audit, v);
            return v;
          };
          const replay = async () => {
            const r = single(
              await tx.query(selectVersion + " AND operation_id=$3", [
                tenant,
                brand,
                command.operationReference,
              ]),
            );
            return r === null ? null : recoverInventorySkuMapping(command, decode(r));
          };
          const recovered = await replay();
          if (recovered) {
            await authorize();
            await bind();
            completed = Object.freeze({ version: recovered, outcome: "AlreadyApplied" });
            return completed;
          }
          let observedAt: string | undefined;
          let catalogCalls = 0,
            inner: InventorySkuMappingWriteResult | undefined;
          const write = async (
            sku: InventorySkuMappingHeldSku | null,
          ): Promise<InventorySkuMappingWriteResult> => {
            if (++catalogCalls !== 1) return fail();
            await authorize();
            await bind();
            // FK insertion takes KEY SHARE on the Item. Acquire it before the
            // Brand fence: normal Item writers take FOR UPDATE before that fence.
            const parent = closed(
              single(
                await tx.query(
                  "SELECT item_id AS item FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR KEY SHARE",
                  [tenant, brand, command.itemReference],
                ),
              ),
              ["item"],
            );
            if (parent.item !== command.itemReference) return fail();
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "InventoryCatalogReferenceV1:" + tenant + ":" + brand,
            ]);
            // Recheck after the global Inventory fence: a concurrent retry may have committed.
            const prior = await replay();
            if (prior) {
              inner = Object.freeze({ version: prior, outcome: "AlreadyApplied" });
              return inner;
            }
            const stored = single(
              await tx.query(
                selectVersion + " AND item_id=$3 ORDER BY mapping_version DESC LIMIT 1",
                [tenant, brand, command.itemReference],
              ),
            );
            const previous = stored === null ? null : decode(stored);
            if (previous && previous.itemReference !== command.itemReference) return fail();
            const r = closed(
              single(await tx.query(selectItem, [tenant, brand, command.itemReference])),
              ["source", "precise"],
            );
            if (r.precise !== true) return fail();
            const item = parseInventorySkuMappingCurrentItem(r.source);
            const version = planInventorySkuMapping(
              command,
              previous,
              item,
              sku,
              options.clock.now(),
            );
            observedAt = item.observedAt;
            const linkage = closed(
              single(
                await tx.query(
                  `SELECT EXISTS(SELECT 1 FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1 AND brand_id=$2 AND mapping_id=$3 AND item_id<>$4) OR ($5::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(item_id) item_id,sku_id FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1 AND brand_id=$2 ORDER BY item_id,mapping_version DESC) latest WHERE latest.sku_id=$5 AND latest.item_id<>$4)) AS conflict`,
                  [
                    tenant,
                    brand,
                    version.mappingReference,
                    version.itemReference,
                    version.target?.skuReference ?? null,
                  ],
                ),
              ),
              ["conflict"],
            );
            if (linkage.conflict === true) return fail("INVENTORY_ITEM_CONFLICT");
            if (linkage.conflict !== false) return fail();
            const audit = checkedAudit(options.audit.create(version), version);
            await authorize();
            await bind();
            await appendAuditRecordInTransaction(tx, audit);
            const inserted = closed(
              single(
                await tx.query(
                  "INSERT INTO rms_inventory.item_sku_mapping_version (tenant_id,brand_id,item_id,mapping_id,mapping_version,item_version,configuration_operation_id,action,product_id,product_version_id,sku_id,catalog_configuration_digest,operation_id,intent_digest,actor_id,occurred_at,reason_code,audit_id,audit_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING mapping_version AS version",
                  [
                    tenant,
                    brand,
                    version.itemReference,
                    version.mappingReference,
                    version.mappingVersion,
                    version.sourceItemVersion,
                    version.sourceConfigurationOperationReference,
                    version.action,
                    version.target?.productReference ?? null,
                    version.target?.productVersionReference ?? null,
                    version.target?.skuReference ?? null,
                    version.target?.catalogConfigurationDigest ?? null,
                    version.operationReference,
                    version.mappingIntentDigest,
                    version.actorReference,
                    version.occurredAt,
                    version.reasonCode,
                    audit.auditId,
                    JSON.stringify(audit),
                  ],
                ),
              ),
              ["version"],
            );
            if (inserted.version !== version.mappingVersion) return fail();
            inner = Object.freeze({ version, outcome: "Applied" });
            return inner;
          };
          const held =
            command.action === "Clear"
              ? await write(null)
              : await options.catalog.withHeldCurrentSku(
                  tx,
                  Object.freeze({
                    command,
                    mappingIntentDigest: inventorySkuMappingIntentDigest(command),
                  }),
                  write,
                );
          if (catalogCalls !== 1 || !inner || held !== inner) return fail();
          await authorize();
          await bind();
          if (inner.outcome === "Applied") {
            const now = parseInventoryInstant(options.clock.now());
            if (
              !observedAt ||
              now < observedAt ||
              Date.parse(now) - Date.parse(observedAt) > 5000 ||
              now < command.occurredAt ||
              Date.parse(now) - Date.parse(command.occurredAt) > 5000
            )
              return fail();
            const finalItemRow = closed(
              single(await tx.query(selectItem, [tenant, brand, command.itemReference])),
              ["source", "precise"],
            );
            if (finalItemRow.precise !== true) return fail();
            const finalItem = parseInventorySkuMappingCurrentItem(finalItemRow.source);
            if (
              finalItem.tenantReference !== tenant ||
              finalItem.brandReference !== brand ||
              finalItem.itemReference !== command.itemReference ||
              finalItem.itemVersion !== command.expectedItemVersion ||
              finalItem.configurationOperationReference !==
                command.configurationOperationReference ||
              finalItem.lifecycle === "Archived" ||
              finalItem.itemType !== "FinishedGood"
            )
              return fail();
            const finalMapping = single(
              await tx.query(
                selectVersion + " AND item_id=$3 ORDER BY mapping_version DESC LIMIT 1",
                [tenant, brand, command.itemReference],
              ),
            );
            if (
              finalMapping === null ||
              decode(finalMapping).operationReference !== command.operationReference
            )
              return fail();
          }
          completed = inner;
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed;
      } catch (error) {
        if (
          error instanceof InventoryItemError &&
          [
            "INVENTORY_ITEM_PERMISSION_DENIED",
            "INVENTORY_ITEM_CONFLICT",
            "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT",
          ].includes(error.code)
        )
          throw error;
        return fail();
      }
    },
  });
}
