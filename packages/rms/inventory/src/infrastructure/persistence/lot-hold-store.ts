import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import { parseLotHoldCommand } from "../../application/lot-expiry-service.js";
import type { LotExpiryPorts } from "../../application/ports/lot-expiry-ports.js";
import type { LotHoldCommand, LotHoldCommandRecord } from "../../contracts/lot-expiry.js";
import { LotHoldError } from "../../domain/lot-hold.js";
import { parseLotHoldSnapshot } from "../../domain/lot-hold-snapshot.js";
import { parseStockScope } from "../../domain/stock-movement.js";
import {
  parseInventoryReference,
  parseInventoryDecimal,
  compareInventoryDecimals,
} from "../../domain/inventory-item.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";
function fail(code: LotHoldError["code"] = "LOT_HOLD_DEPENDENCY_UNAVAILABLE"): never {
  throw new LotHoldError(code);
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
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return fail();
  return d.value as unknown[];
}
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function normalize(value: unknown): LotHoldCommandRecord {
  const raw = closed(value, [
    "operationReference",
    "intentHash",
    "action",
    "command",
    "hold",
    "audit",
    "outcome",
  ]);
  const command = parseLotHoldCommand(raw.command),
    hold = parseLotHoldSnapshot(raw.hold);
  if (
    raw.operationReference !== command.operationReference ||
    raw.action !== command.action ||
    typeof raw.intentHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(raw.intentHash) ||
    !["Applied", "AlreadyApplied"].includes(String(raw.outcome)) ||
    command.tenantReference !== hold.tenantReference ||
    command.brandReference !== hold.brandReference ||
    command.actorReference !== hold.updatedBy ||
    command.occurredAt !== hold.updatedAt ||
    command.payload.itemReference !== hold.itemReference ||
    command.payload.locationReference !== hold.locationReference ||
    command.payload.lotReference !== hold.lotReference ||
    !same(command.payload.stockScope, hold.stockScope) ||
    command.payload.expectedVersion !== hold.aggregateVersion - 1 ||
    (command.action === "Quarantine") !== (hold.status === "Quarantined")
  )
    return fail();
  const last = hold.decisions.at(-1);
  if (
    !last ||
    last.reasonCode !== command.payload.reasonCode ||
    last.complianceDecisionReference !== command.payload.complianceDecisionReference
  )
    return fail();
  const auditRaw = closed(raw.audit, [
    "auditId",
    "brandId",
    "storeId",
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
  const actor = closed(auditRaw.actor, ["type", "reference"]);
  const audit = validateAuditRecord(
    { ...auditRaw, actor: Object.freeze({ ...actor }) },
    Date.parse(hold.updatedAt),
  );
  if (
    audit.actor.type === "System" ||
    audit.actor.reference !== command.actorReference ||
    audit.brandId !== hold.brandReference ||
    audit.targetType !== "LotHold" ||
    audit.targetId !== hold.holdReference ||
    audit.occurredAt !== hold.updatedAt ||
    audit.correlationId !== command.operationReference ||
    audit.reasonCode !== command.payload.reasonCode ||
    audit.actionCode !== "INVENTORY_LOT_" + command.action.toUpperCase() ||
    audit.dataClassification !== "Internal"
  )
    return fail();
  return Object.freeze({
    operationReference: command.operationReference,
    intentHash: raw.intentHash,
    action: command.action,
    command,
    hold,
    audit: Object.freeze(audit),
    outcome: raw.outcome as "Applied" | "AlreadyApplied",
  });
}
/** Internal owner capability; executeLotHold authorizes and resolves public Compliance evidence. */
export function createPostgresLotHoldStore(
  runner: InventoryItemTransactionRunner,
  scopeInput: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
): Readonly<{ repository: LotExpiryPorts["repository"]; snapshot: LotExpiryPorts["snapshot"] }> {
  const raw = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = parseInventoryReference(raw.tenantReference),
    brand = parseInventoryReference(raw.brandReference),
    store = parseInventoryReference(raw.storeReference);
  async function run<T>(work: (tx: InventoryItemTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        return work(tx);
      });
    } catch (error) {
      if (error instanceof LotHoldError) throw error;
      return fail();
    }
  }
  function bind(record: LotHoldCommandRecord) {
    if (
      record.hold.tenantReference !== tenant ||
      record.hold.brandReference !== brand ||
      record.audit.storeId !== store
    )
      return fail("LOT_HOLD_PERMISSION_DENIED");
    if (
      record.hold.stockScope.scopeType === "Store" &&
      record.hold.stockScope.scopeReference !== store
    )
      return fail("LOT_HOLD_PERMISSION_DENIED");
    return record;
  }
  async function account(
    tx: InventoryItemTransaction,
    input: {
      tenantReference: unknown;
      brandReference: unknown;
      stockScope: unknown;
      locationReference: unknown;
      lotReference: unknown;
    },
    lock = false,
  ) {
    if (input.tenantReference !== tenant || input.brandReference !== brand)
      return fail("LOT_HOLD_PERMISSION_DENIED");
    const scope = parseStockScope(input.stockScope),
      location = parseInventoryReference(input.locationReference),
      lot = parseInventoryReference(input.lotReference);
    const found = rows(
      await tx.query(
        "SELECT account_id AS account,item_id AS item,stock_site_id AS site,expiry_date::text AS expiry FROM rms_inventory.stock_account WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND location_id=$4 AND lot_id=$5" +
          (lock ? " FOR UPDATE" : ""),
        [tenant, brand, store, location, lot],
      ),
    );
    if (found.length === 0) return null;
    const row = closed(found[0], ["account", "item", "site", "expiry"]);
    if (
      (scope.scopeType === "Store" && scope.scopeReference !== store) ||
      (scope.scopeType === "StockSite" && scope.scopeReference !== row.site) ||
      (scope.scopeType === "Location" && scope.scopeReference !== location)
    )
      return fail("LOT_HOLD_PERMISSION_DENIED");
    return {
      account: parseInventoryReference(row.account),
      item: parseInventoryReference(row.item),
      expiry: row.expiry,
      location,
      lot,
      scope,
    };
  }
  function decode(value: unknown) {
    const row = closed(value, ["record", "version", "occurredAt"]);
    const record = bind(normalize(row.record));
    if (
      row.version !== String(record.hold.aggregateVersion) ||
      row.occurredAt !== record.hold.updatedAt
    )
      return fail();
    return record;
  }
  const columns = `record_json AS record,version::text AS version,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"`;
  async function latest(tx: InventoryItemTransaction, accountId: string) {
    const found = rows(
      await tx.query(
        "SELECT " +
          columns +
          " FROM rms_inventory.stock_lot_hold_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4 ORDER BY version DESC LIMIT 1",
        [tenant, brand, store, accountId],
      ),
    );
    return found.length === 0 ? null : decode(found[0]);
  }
  async function resolve(tx: InventoryItemTransaction, reference: string) {
    const found = rows(
      await tx.query(
        "SELECT " +
          columns +
          " FROM rms_inventory.stock_lot_hold_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, reference],
      ),
    );
    return found.length === 0
      ? null
      : Object.freeze({ ...decode(found[0]), outcome: "AlreadyApplied" as const });
  }
  async function balance(tx: InventoryItemTransaction, accountId: string, lock = false) {
    const found = rows(
      await tx.query(
        "SELECT on_hand::text AS on_hand,reserved::text AS reserved,ledger_version::text AS version FROM rms_inventory.stock_balance WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4" +
          (lock ? " FOR UPDATE" : ""),
        [tenant, brand, store, accountId],
      ),
    );
    if (found.length !== 1) return fail();
    const row = closed(found[0], ["on_hand", "reserved", "version"]);
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) return fail();
    return {
      onHand: parseInventoryDecimal(row.on_hand),
      reserved: parseInventoryDecimal(row.reserved),
      balanceVersion: version,
    };
  }
  const repository: LotExpiryPorts["repository"] = {
    resolveOperation: (reference) => run((tx) => resolve(tx, parseInventoryReference(reference))),
    load: (input) =>
      run(async (tx) => {
        const selected = await account(tx, input);
        return selected === null ? null : ((await latest(tx, selected.account))?.hold ?? null);
      }),
    commit: (input) =>
      run(async (tx) => {
        const record = bind(normalize(input));
        if (record.outcome !== "Applied") return fail();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "LotHold:" + tenant + ":" + brand + ":" + store + ":" + record.operationReference,
        ]);
        const prior = await resolve(tx, record.operationReference);
        if (prior) {
          if (prior.intentHash !== record.intentHash || !same(prior.command, record.command))
            return fail("LOT_HOLD_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        const lock = rows(
          await tx.query(
            "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
            [tenant, brand, record.hold.itemReference],
          ),
        );
        if (lock.length !== 1) return fail("LOT_HOLD_NOT_FOUND");
        const selected = await account(tx, record.hold, true);
        if (
          !selected ||
          selected.item !== record.hold.itemReference ||
          selected.expiry !== record.hold.expiryDate
        )
          return fail("LOT_HOLD_NOT_FOUND");
        const current = await latest(tx, selected.account);
        if (
          (current?.hold.aggregateVersion ?? 0) !== record.hold.aggregateVersion - 1 ||
          (current !== null &&
            (current.hold.holdReference !== record.hold.holdReference ||
              !same(record.hold.decisions.slice(0, -1), current.hold.decisions)))
        )
          return fail("LOT_HOLD_CONFLICT");
        const quantity = await balance(tx, selected.account, true);
        if (
          quantity.balanceVersion !== record.hold.balanceVersion ||
          compareInventoryDecimals(quantity.onHand, record.hold.onHand) !== 0 ||
          compareInventoryDecimals(quantity.reserved, record.hold.reserved) !== 0
        )
          return fail("LOT_HOLD_CONFLICT");
        await appendAuditRecordInTransaction(tx, record.audit);
        await tx.query(
          "INSERT INTO rms_inventory.stock_lot_hold_version (tenant_id,brand_id,store_id,account_id,hold_id,version,operation_id,intent_hash,status,audit_id,record_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            tenant,
            brand,
            store,
            selected.account,
            record.hold.holdReference,
            record.hold.aggregateVersion,
            record.operationReference,
            record.intentHash,
            record.hold.status,
            record.audit.auditId,
            JSON.stringify(record),
            record.hold.updatedAt,
          ],
        );
        return Object.freeze({ ...record, audit: input.audit });
      }),
  };
  return Object.freeze({
    repository: Object.freeze(repository),
    snapshot: Object.freeze({
      inspect: (input: LotHoldCommand) =>
        run(async (tx) => {
          const command = parseLotHoldCommand(input);
          const selected = await account(
            tx,
            {
              tenantReference: command.tenantReference,
              brandReference: command.brandReference,
              stockScope: command.payload.stockScope,
              locationReference: command.payload.locationReference,
              lotReference: command.payload.lotReference,
            },
            true,
          );
          if (!selected || selected.item !== command.payload.itemReference)
            return fail("LOT_HOLD_NOT_FOUND");
          const current = await latest(tx, selected.account),
            quantity = await balance(tx, selected.account);
          return Object.freeze({
            tenantReference: tenant,
            brandReference: brand,
            stockScope: selected.scope,
            locationReference: selected.location,
            itemReference: selected.item,
            lotReference: selected.lot,
            expiryDate: selected.expiry,
            ...quantity,
            holdReference: current?.hold.holdReference ?? null,
            holdVersion: current?.hold.aggregateVersion ?? 0,
            holdStatus: current?.hold.status ?? "Available",
          });
        }),
    }),
  });
}
