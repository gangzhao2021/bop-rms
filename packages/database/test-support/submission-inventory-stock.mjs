import assert from "node:assert/strict";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createHash } from "node:crypto";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
/** Actual Item command/Audit and synthetic received-stock fixture in an isolated database. */
export async function seedSubmissionInventoryStock({
  admin,
  runner,
  ownerScope,
  actorReference,
  at,
  datedLot = false,
}) {
  const scope = {
    tenantReference: ownerScope.tenantReference,
    brandReference: ownerScope.brandReference,
  };
  const id = (n) =>
    n === 1
      ? scope.tenantReference
      : n === 2
        ? scope.brandReference
        : n === 3
          ? actorReference
          : n === 300
            ? ownerScope.storeReference
            : "01909995-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  let sequence = 100;
  const now = at;
  const lotReference = datedLot ? id(304) : null;
  // Explicit synthetic instant, never a Store calendar-day default.
  const expiryCutoff = datedLot ? new Date(Date.parse(at) + 600000).toISOString() : null;
  const expiryDate = expiryCutoff?.slice(0, 10) ?? null;
  let expiryReads = 0;
  const create = {
    ...scope,
    actorReference: id(3),
    purpose: "InventoryItemManagement",
    permission: "inventory.manage",
    operationReference: id(10),
    occurredAt: now,
    action: "Create",
    payload: {
      internalCode: "SYNTHETIC_ITEM",
      itemType: "RawMaterial",
      localizedNames: { en: "Synthetic item" },
      baseUnit: {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 2,
        ledgerPrecision: 4,
        roundingMode: "HalfEven",
      },
      trackingPolicy: {
        stockTrackingEnabled: true,
        lotTrackingMode: datedLot ? "LotExpiryRequired" : "NoLot",
        defaultShelfLifeDays: datedLot ? 1 : null,
        expiryWarningDays: datedLot ? 0 : null,
        issuePolicy: datedLot ? "FEFO" : "FIFO",
        negativeStockPolicy: "Block",
      },
    },
  };
  function ports() {
    return {
      authorization: {
        async authorize() {
          return { authorized: true };
        },
      },
      references: {
        generate: () => id(sequence++),
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
      audit: {
        async create({ command, after }) {
          return {
            auditId: id(sequence++),
            brandId: command.brandReference,
            actor: { type: "User", reference: command.actorReference },
            actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
            targetType: "InventoryItem",
            targetId: after.itemReference,
            reasonCode: "AUTHORIZED_CHANGE",
            correlationId: command.operationReference,
            occurredAt: command.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          };
        },
      },
      repository: createPostgresInventoryItemStore(runner(), scope),
    };
  }

  const recovered = await executeInventoryItemCommand(create, ports());
  await executeInventoryItemCommand(
    {
      ...create,
      operationReference: id(11),
      action: "Activate",
      payload: {
        itemReference: recovered.item.itemReference,
        expectedVersion: 1,
        reasonCode: "READY",
      },
    },
    ports(),
  );
  await admin.query(
    "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at,lot_id,expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8,$9,$10)",
    [
      id(1),
      id(2),
      id(300),
      id(301),
      id(302),
      id(303),
      recovered.item.itemReference,
      now,
      lotReference,
      expiryDate,
    ],
  );
  await admin.query(
    "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
    [id(1), id(2), id(300), id(303)],
  );
  const movement = {
    movementReference: id(400),
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: recovered.item.itemReference,
    movementType: "Receive",
    quantityDelta: "100",
    unitCode: "KG",
    baseQuantityDelta: "100",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: null,
    destinationScope: { scopeType: "Location", scopeReference: id(302) },
    lotReference,
    expiryDate,
    businessSourceType: "SYNTHETIC_RECEIPT",
    businessSourceReference: id(401),
    reasonCode: "SYNTHETIC_TEST",
    performedBy: id(3),
    occurredAt: now,
    before: {
      onHand: "0",
      reserved: "0",
      available: "0",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 1,
    },
    after: {
      onHand: "100",
      reserved: "0",
      available: "100",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 2,
    },
    auditReference: id(402),
    correctsMovementReference: null,
  };
  async function receive(tx) {
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [id(1), id(2), id(300)],
    );
    await tx.query(
      "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive',100,$6,$7,$8)",
      [id(1), id(2), id(300), id(303), id(400), movement, id(402), now],
    );
    await appendAuditRecordInTransaction(tx, {
      auditId: id(402),
      brandId: id(2),
      storeId: id(300),
      actor: { type: "User", reference: id(3) },
      actionCode: "INVENTORY_RECEIVE",
      targetType: "StockMovement",
      targetId: id(400),
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(403),
      occurredAt: now,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "SYNTHETIC_AUDIT",
      retentionPolicyVersion: 1,
    });
  }

  await runner().run(receive);
  return {
    itemReference: recovered.item.itemReference,
    configurationOperationReference: id(11),
    stockSiteReference: id(301),
    accountReference: id(303),
    lotReference,
    expiryDate,
    expiryCutoff,
    expiryReadCount: () => expiryReads,
    async resolveExpiryCutoff(tx, input) {
      assert(datedLot, "NoLot must not resolve expiry");
      assert.equal(input.storeReference, ownerScope.storeReference);
      assert.equal(input.accountReference, id(303));
      assert.equal(input.expiryDate, expiryDate);
      assert(input.observedAt >= at);
      const context = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
      assert.equal(context.rows[0].store, ownerScope.storeReference);
      expiryReads++;
      return expiryCutoff;
    },
  };
}
