import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
import { createCustomerRecipeInventoryObservation } from "../../../apps/api/src/customer-recipe-inventory-observation.ts";
import { ensureSyntheticStockPlace } from "./stock-place.mjs";

/** Actual Catalog/Recipe/Inventory reads. Scope approval and starting stock are
 * explicitly synthetic isolated fixtures, not a real Store receipt or approval.
 */
export async function seedRecipeObservationInventory({
  admin,
  role,
  runner,
  id,
  at,
  saleInput,
  requirements,
}) {
  let sequence = 30000;
  const next = () => id(++sequence);
  const scope = {
    tenantReference: id(29990),
    brandReference: id(2),
    storeReference: saleInput.storeReference,
    stockSiteReference: id(29991),
  };
  await admin.query("RESET ROLE");
  try {
    await admin.query("GRANT USAGE ON SCHEMA rms_inventory,platform_audit TO " + role);
    await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    await admin.query(
      "GRANT SELECT ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_lot_hold_version TO " +
        role,
    );

    const version = (
      await admin.query("SELECT product_version_id FROM rms_catalog.sku WHERE sku_id=$1", [
        saleInput.skuReference,
      ])
    ).rows[0].product_version_id;
    const pins = new Map(requirements.map((r) => [r.itemReference, r.itemVersionReference]));
    for (const [item, operation] of pins) {
      const required = requirements.filter((r) => r.itemReference === item);
      assert(
        required.every((r) => r.unitDimension === "Mass" && r.itemVersionReference === operation),
      );
    }
    await seedSyntheticInventoryItems({
      admin,
      role,
      runner,
      id,
      at,
      scope,
      next,
      items: [...pins].map(([itemReference, operationReference]) => ({
        itemReference,
        operationReference,
        onHand: "100",
      })),
    });
    return { scope, version, pins };
  } finally {
    await admin.query("SET ROLE " + role);
  }
}

export async function exerciseRecipeInventoryObservation(options) {
  const { admin, role, id, at, saleInput } = options;
  const { scope, version, pins } = await seedRecipeObservationInventory(options);
  try {
    await admin.query("SET ROLE " + role);
    const transactions = {
      async run(work) {
        await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const value = await work({ query: (sql, values) => admin.query(sql, [...values]) });
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      },
    };
    let allowed = true;
    const source = createCustomerRecipeInventoryObservation({
      scope,
      transactions,
      authorize: async () => allowed,
      resolveExpiryCutoff: async () => {
        throw new Error("NoLot fixture");
      },
    });
    const input = {
      sellableReference: saleInput.skuReference,
      productVersionReference: version,
      quantity: 2,
      selections: saleInput.selections,
      observedAt: at,
    };
    assert.equal((await source.observe(input)).status, "Available");
    assert.equal((await source.observe({ ...input, quantity: 999 })).status, "Unavailable");
    await assert.rejects(
      source.observe({
        ...input,
        selections: [
          {
            ...input.selections[0],
            optionReference: id(39999),
          },
        ],
      }),
      { code: "CUSTOMER_INVENTORY_OBSERVATION_UNAVAILABLE" },
    );
    allowed = false;
    await assert.rejects(source.observe(input), {
      code: "CUSTOMER_INVENTORY_OBSERVATION_UNAVAILABLE",
    });
    await admin.query("RESET ROLE");
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM rms_inventory.stock_reservation_version"))
        .rows[0].n,
      0,
    );
    const balances = (
      await admin.query("SELECT on_hand::text,reserved::text FROM rms_inventory.stock_balance")
    ).rows;
    assert.equal(balances.length, pins.size);
    assert(balances.every((b) => b.on_hand === "100" && b.reserved === "0"));
  } finally {
    await admin.query("SET ROLE " + role);
  }
}

/** Synthetic isolated Inventory Items, each Active with one Location account received to `onHand`.
 * Not a real Store receipt; tests own the scope, references and audit identities. */
export async function seedSyntheticInventoryItems({
  admin,
  role,
  runner,
  id,
  at,
  scope,
  next,
  items,
}) {
  const itemScope = {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
  };
  const accounts = [];
  for (const { itemReference: item, operationReference: operation, onHand } of items) {
    await admin.query("SET ROLE " + role);
    const ports = {
      authorization: { authorize: async () => ({ authorized: true }) },
      references: {
        generate: () => item,
        hashIntent: (text) => "sha256:" + createHash("sha256").update(text).digest("hex"),
        equals: (a, b) => a === b,
      },
      audit: {
        create: async ({ command, after }) => ({
          auditId: next(),
          brandId: scope.brandReference,
          actor: { type: "User", reference: id(3) },
          actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
          targetType: "InventoryItem",
          targetId: after.itemReference,
          reasonCode: "SYNTHETIC_RECIPE_SETUP",
          correlationId: command.operationReference,
          occurredAt: at,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        }),
      },
      repository: createPostgresInventoryItemStore(runner, itemScope),
    };
    const common = {
      ...itemScope,
      actorReference: id(3),
      purpose: "InventoryItemManagement",
      permission: "inventory.manage",
      occurredAt: at,
    };
    await executeInventoryItemCommand(
      {
        ...common,
        action: "Create",
        operationReference: next(),
        payload: {
          internalCode: "OBS_ITEM_" + item.slice(-8).toUpperCase(),
          itemType: "RawMaterial",
          localizedNames: { en: "Synthetic observation ingredient" },
          baseUnit: {
            unitCode: "KG",
            dimension: "Mass",
            displayPrecision: 2,
            ledgerPrecision: 4,
            roundingMode: "HalfEven",
          },
          trackingPolicy: {
            stockTrackingEnabled: true,
            lotTrackingMode: "NoLot",
            defaultShelfLifeDays: null,
            expiryWarningDays: null,
            issuePolicy: "FIFO",
            negativeStockPolicy: "Block",
          },
        },
      },
      ports,
    );
    await executeInventoryItemCommand(
      {
        ...common,
        action: "Activate",
        operationReference: operation,
        payload: { itemReference: item, expectedVersion: 1, reasonCode: "READY" },
      },
      ports,
    );
    await admin.query("RESET ROLE");
    const account = next(),
      location = next(),
      movement = next(),
      audit = next();
    await ensureSyntheticStockPlace(admin, {
      tenantId: scope.tenantReference,
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      stockSiteId: scope.stockSiteReference,
      locationId: location,
      at,
    });
    await admin.query(
      "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8)",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        scope.stockSiteReference,
        location,
        account,
        item,
        at,
      ],
    );
    await admin.query(
      "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
      [scope.tenantReference, scope.brandReference, scope.storeReference, account],
    );
    const balance = (n, v) => ({
      onHand: n,
      reserved: "0",
      available: n,
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: v,
    });
    const record = {
      movementReference: movement,
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      itemReference: item,
      movementType: "Receive",
      quantityDelta: onHand,
      unitCode: "KG",
      baseQuantityDelta: onHand,
      baseUnitCode: "KG",
      conversionMultiplier: "1",
      sourceScope: null,
      destinationScope: { scopeType: "Location", scopeReference: location },
      lotReference: null,
      expiryDate: null,
      businessSourceType: "SYNTHETIC_RECEIPT",
      businessSourceReference: next(),
      reasonCode: "SYNTHETIC_TEST",
      performedBy: id(3),
      occurredAt: at,
      before: balance("0", 1),
      after: balance(onHand, 2),
      auditReference: audit,
      correctsMovementReference: null,
    };
    await admin.query("BEGIN");
    try {
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive',$9,$6,$7,$8)",
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          account,
          movement,
          record,
          audit,
          at,
          onHand,
        ],
      );
      await appendAuditRecordInTransaction(
        { query: (sql, values) => admin.query(sql, [...values]) },
        {
          auditId: audit,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: id(3) },
          actionCode: "INVENTORY_RECEIVE",
          targetType: "StockMovement",
          targetId: movement,
          reasonCode: "SYNTHETIC_TEST",
          correlationId: next(),
          occurredAt: at,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        },
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    accounts.push({ itemReference: item, accountReference: account });
  }
  return accounts;
}
