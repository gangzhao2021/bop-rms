import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { InventoryItemPorts } from "../../application/ports/inventory-item-ports.js";
import type {
  InventoryItemAction,
  InventoryItemCommandRecord,
} from "../../contracts/inventory-item-command.js";
import {
  InventoryItemError,
  parseInventoryReference,
  type InventoryItemAggregate,
} from "../../domain/inventory-item.js";
import { parseInventoryItemSnapshot } from "../../domain/inventory-item-snapshot.js";

export interface InventoryItemTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface InventoryItemTransactionRunner {
  /** Own a READ COMMITTED transaction, commit/rollback and connection/context cleanup. */
  run<T>(action: (transaction: InventoryItemTransaction) => Promise<T>): Promise<T>;
}
const actionCodes: Readonly<Record<InventoryItemAction, string>> = {
  Create: "INVENTORY_ITEM_CREATE",
  Update: "INVENTORY_ITEM_UPDATE",
  Activate: "INVENTORY_ITEM_ACTIVATE",
  Deactivate: "INVENTORY_ITEM_DEACTIVATE",
  Archive: "INVENTORY_ITEM_ARCHIVE",
  Restore: "INVENTORY_ITEM_RESTORE",
  SetReorderPolicy: "INVENTORY_ITEM_SET_REORDER_POLICY",
};
function fail(code: InventoryItemError["code"] = "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE"): never {
  throw new InventoryItemError(code);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > 1
  )
    return fail();
  return descriptor.value as unknown[];
}
function boundedRows(value: unknown, maximum: number): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > maximum
  )
    return fail();
  return descriptor.value as unknown[];
}
function action(value: unknown): InventoryItemAction {
  if (typeof value !== "string" || !Object.hasOwn(actionCodes, value)) return fail();
  return value as InventoryItemAction;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
}
function audit(
  value: unknown,
  item: InventoryItemAggregate,
  operation: string,
  kind: InventoryItemAction,
) {
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
  const actor = closed(raw.actor, ["type", "reference"]);
  const record = validateAuditRecord(
    { ...raw, actor: Object.freeze({ ...actor }) },
    Date.parse(item.updatedAt),
  );
  if (
    record.brandId !== item.brandReference ||
    record.targetType !== "InventoryItem" ||
    record.targetId !== item.itemReference ||
    record.correlationId !== operation ||
    record.occurredAt !== item.updatedAt ||
    record.actionCode !== actionCodes[kind] ||
    record.actor.type === "System" ||
    record.actor.reference !== item.updatedBy ||
    record.dataClassification !== "Internal"
  )
    return fail();
  return Object.freeze(record);
}

/** Internal owner repository; authorize every command/query before invoking this capability. */
export function createPostgresInventoryItemStore(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string }>,
): InventoryItemPorts["repository"] & {
  /** Internal submission fence; hold the transaction through dependent writes. */
  loadForUpdate(reference: string): Promise<InventoryItemAggregate | null>;
  /**
   * True once any Store opened a stock account for the item, even before its first movement (which
   * marks the item itself, 1900_005); the account fixes the unit, so administration treats both alike.
   */
  stockAccountsOpened(reference: string): Promise<boolean>;
  /** True while any Store of the Brand holds, reserves or expects the item (archive guard). */
  stockExposure(reference: string): Promise<boolean>;
  /** INV-ITEM-LIST: current versions ordered by internal code, keyset paged. */
  list(input: {
    readonly search: string | null;
    readonly lifecycle: InventoryItemAggregate["lifecycle"] | null;
    readonly afterInternalCode: string | null;
    readonly limit: number;
  }): Promise<{ readonly items: readonly InventoryItemAggregate[]; readonly hasMore: boolean }>;
} {
  const scope = closed(scopeInput, ["tenantReference", "brandReference"]);
  const tenant = parseInventoryReference(scope.tenantReference),
    brand = parseInventoryReference(scope.brandReference);
  function bind(item: InventoryItemAggregate) {
    if (item.tenantReference !== tenant || item.brandReference !== brand)
      return fail("INVENTORY_ITEM_PERMISSION_DENIED");
    return item;
  }
  async function run<T>(work: (tx: InventoryItemTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        return work(tx);
      });
    } catch (error) {
      if (error instanceof InventoryItemError) throw error;
      return fail();
    }
  }
  function decode(value: unknown, reference?: string) {
    const row = closed(value, ["snapshot", "version", "recordedAt"]);
    const item = bind(parseInventoryItemSnapshot(row.snapshot));
    if (
      row.version !== String(item.aggregateVersion) ||
      row.recordedAt !== item.updatedAt ||
      (reference !== undefined && reference !== item.itemReference)
    )
      return fail();
    return item;
  }
  async function load(tx: InventoryItemTransaction, reference: string) {
    const result = rows(
      await tx.query(
        `SELECT snapshot_json AS snapshot,version::text AS version,
       to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
       FROM rms_inventory.inventory_item_version WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 ORDER BY version DESC LIMIT 1`,
        [tenant, brand, reference],
      ),
    );
    return result.length === 0 ? null : decode(result[0], reference);
  }
  async function resolve(
    tx: InventoryItemTransaction,
    operation: string,
  ): Promise<InventoryItemCommandRecord | null> {
    const result = rows(
      await tx.query(
        `SELECT o.operation_id AS operation,o.item_id AS item,o.version::text AS version,
       o.intent_hash AS hash,o.action,o.audit_id AS "auditId",o.audit_json AS audit,v.snapshot_json AS snapshot,
       to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
       FROM rms_inventory.inventory_item_operation o JOIN rms_inventory.inventory_item_version v
       ON v.tenant_id=o.tenant_id AND v.brand_id=o.brand_id AND v.item_id=o.item_id AND v.version=o.version
       WHERE o.tenant_id=$1 AND o.brand_id=$2 AND o.operation_id=$3`,
        [tenant, brand, operation],
      ),
    );
    if (result.length === 0) return null;
    const row = closed(result[0], [
      "operation",
      "item",
      "version",
      "hash",
      "action",
      "auditId",
      "audit",
      "snapshot",
      "recordedAt",
    ]);
    const item = decode(
      { snapshot: row.snapshot, version: row.version, recordedAt: row.recordedAt },
      parseInventoryReference(row.item),
    );
    const kind = action(row.action),
      originalAudit = audit(row.audit, item, operation, kind);
    if (row.operation !== operation || row.auditId !== originalAudit.auditId) return fail();
    return Object.freeze({
      operationReference: parseInventoryReference(operation),
      intentHash: hash(row.hash),
      action: kind,
      item,
      outcome: "AlreadyApplied",
      audit: originalAudit,
    });
  }
  return Object.freeze({
    resolveOperation: (operation) => run((tx) => resolve(tx, parseInventoryReference(operation))),
    load: (reference) => run((tx) => load(tx, parseInventoryReference(reference))),
    stockAccountsOpened: (reference) =>
      run(async (tx) => {
        const item = parseInventoryReference(reference);
        return (
          rows(
            await tx.query(
              "SELECT 1 FROM rms_inventory.item_stock_exposure WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 LIMIT 1",
              [tenant, brand, item],
            ),
          ).length === 1
        );
      }),
    loadForUpdate: (reference) => {
      const itemReference = parseInventoryReference(reference);
      return run(async (tx) => {
        const locked = rows(
          await tx.query(
            "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
            [tenant, brand, itemReference],
          ),
        );
        return locked.length === 0 ? null : load(tx, itemReference);
      });
    },
    internalCodeExists: (input) =>
      run(async (tx) => {
        const raw = closed(input, ["brandReference", "normalizedCode", "excludingItemReference"]);
        if (raw.brandReference !== brand) return fail("INVENTORY_ITEM_PERMISSION_DENIED");
        if (
          typeof raw.normalizedCode !== "string" ||
          !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(raw.normalizedCode)
        )
          return fail("INVENTORY_ITEM_INVALID");
        const excluding =
          raw.excludingItemReference === null
            ? null
            : parseInventoryReference(raw.excludingItemReference);
        return (
          rows(
            await tx.query(
              "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND internal_code=$3 AND ($4::uuid IS NULL OR item_id<>$4)",
              [tenant, brand, raw.normalizedCode, excluding],
            ),
          ).length === 1
        );
      }),
    stockExposure: (reference) =>
      run(async (tx) => {
        const item = parseInventoryReference(reference);
        return (
          rows(
            await tx.query(
              "SELECT 1 FROM rms_inventory.item_stock_exposure WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 AND exposed LIMIT 1",
              [tenant, brand, item],
            ),
          ).length === 1
        );
      }),
    list: (input) =>
      run(async (tx) => {
        const raw = closed(input, ["search", "lifecycle", "afterInternalCode", "limit"]);
        const limit = raw.limit;
        if (
          !Number.isSafeInteger(limit) ||
          (limit as number) < 1 ||
          (limit as number) > 200 ||
          (raw.search !== null && (typeof raw.search !== "string" || raw.search.length > 80)) ||
          (raw.lifecycle !== null &&
            !["Active", "Inactive", "Archived"].includes(String(raw.lifecycle))) ||
          (raw.afterInternalCode !== null &&
            (typeof raw.afterInternalCode !== "string" ||
              !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(raw.afterInternalCode)))
        )
          return fail("INVENTORY_ITEM_INVALID");
        const pattern =
          raw.search === null || (raw.search as string).trim() === ""
            ? null
            : "%" + (raw.search as string).trim().replace(/[\\%_]/gu, (c) => "\\" + c) + "%";
        const result = boundedRows(
          await tx.query(
            `SELECT v.snapshot_json AS snapshot,v.version::text AS version,
               to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
             FROM rms_inventory.inventory_item i
             JOIN LATERAL (SELECT * FROM rms_inventory.inventory_item_version x
               WHERE x.tenant_id=i.tenant_id AND x.brand_id=i.brand_id AND x.item_id=i.item_id
               ORDER BY x.version DESC LIMIT 1) v ON true
             WHERE i.tenant_id=$1 AND i.brand_id=$2
               AND ($3::text IS NULL OR i.internal_code > $3)
               AND ($4::text IS NULL OR v.snapshot_json->>'lifecycle' = $4)
               AND ($5::text IS NULL OR i.internal_code ILIKE $5 OR EXISTS (SELECT 1 FROM jsonb_each_text(v.snapshot_json->'localizedNames') n WHERE n.value ILIKE $5))
             ORDER BY i.internal_code COLLATE "C" LIMIT $6`,
            [tenant, brand, raw.afterInternalCode, raw.lifecycle, pattern, (limit as number) + 1],
          ),
          (limit as number) + 1,
        );
        const items = result.slice(0, limit as number).map((row) => decode(row));
        return Object.freeze({
          items: Object.freeze(items),
          hasMore: result.length > (limit as number),
        });
      }),
    commit: (input) =>
      run(async (tx) => {
        const raw = closed(input, [
          "operationReference",
          "intentHash",
          "action",
          "item",
          "outcome",
          "audit",
        ]);
        const operation = parseInventoryReference(raw.operationReference),
          intentHash = hash(raw.intentHash),
          kind = action(raw.action);
        const item = bind(parseInventoryItemSnapshot(raw.item)),
          recordAudit = audit(raw.audit, item, operation, kind);
        if (raw.outcome !== "Applied" || (kind === "Create") !== (item.aggregateVersion === 1))
          return fail("INVENTORY_ITEM_INVALID");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "InventoryItem:" + tenant + ":" + brand + ":" + operation,
        ]);
        const prior = await resolve(tx, operation);
        if (prior !== null) {
          if (prior.intentHash !== intentHash || prior.action !== kind)
            return fail("INVENTORY_ITEM_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        if (kind === "Create") {
          const inserted = rows(
            await tx.query(
              "INSERT INTO rms_inventory.inventory_item (tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING item_id",
              [
                tenant,
                brand,
                item.itemReference,
                item.internalCode,
                item.itemType,
                item.createdAt,
                item.createdBy,
              ],
            ),
          );
          if (inserted.length !== 1) return fail("INVENTORY_ITEM_CONFLICT");
        } else {
          const locked = rows(
            await tx.query(
              "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
              [tenant, brand, item.itemReference],
            ),
          );
          if (locked.length !== 1) return fail("INVENTORY_ITEM_NOT_FOUND");
          const current = await load(tx, item.itemReference);
          if (
            current === null ||
            current.aggregateVersion !== item.aggregateVersion - 1 ||
            current.updatedAt > item.updatedAt
          )
            return fail("INVENTORY_ITEM_CONFLICT");
        }
        await tx.query(
          "INSERT INTO rms_inventory.inventory_item_version (tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            tenant,
            brand,
            item.itemReference,
            item.aggregateVersion,
            JSON.stringify(item),
            item.updatedAt,
          ],
        );
        await appendAuditRecordInTransaction(tx, recordAudit);
        await tx.query(
          "INSERT INTO rms_inventory.inventory_item_operation (tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id,audit_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            tenant,
            brand,
            operation,
            item.itemReference,
            item.aggregateVersion,
            intentHash,
            kind,
            recordAudit.auditId,
            JSON.stringify(recordAudit),
          ],
        );
        return Object.freeze({
          operationReference: operation,
          intentHash,
          action: kind,
          item,
          outcome: "Applied",
          audit: recordAudit,
        });
      }),
  });
}
