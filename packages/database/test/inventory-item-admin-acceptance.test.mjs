import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const id = (n) => "01909a0f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
const kg = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 3,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
const tracking = {
  stockTrackingEnabled: true,
  lotTrackingMode: "NoLot",
  defaultShelfLifeDays: null,
  expiryWarningDays: null,
  issuePolicy: "FIFO",
  negativeStockPolicy: "Block",
};

/** WP-2423: Inventory Item administration over the Brand list, ledger exposure and unit lock. */
it("lists, searches and guards Inventory Items by the ledger's Brand-wide stock exposure", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_item_admin" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000;
    const next = () => id(++sequence);
    const scope = { tenantReference: id(1), brandReference: id(2) };
    const [storeA, storeB] = [id(3), id(4)];
    const actor = id(5);
    try {
      const runner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            const value = await work(admin);
            await admin.query("COMMIT");
            return value;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const store = createPostgresInventoryItemStore(runner, scope);
      const requested = [];
      let minute = 0;
      const execute = (action, payload) =>
        executeInventoryItemCommand(
          {
            ...scope,
            actorReference: actor,
            purpose: "InventoryItemManagement",
            operationReference: next(),
            occurredAt: at(++minute),
            action,
            payload,
          },
          {
            authorization: {
              authorize: async (request) => {
                requested.push(request.permission);
                return { authorized: true };
              },
            },
            audit: {
              create: async ({ command, after }) => ({
                auditId: next(),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
                targetType: "InventoryItem",
                targetId: after.itemReference,
                reasonCode: "SYNTHETIC_CHANGE",
                correlationId: command.operationReference,
                occurredAt: command.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_STANDARD",
                retentionPolicyVersion: 1,
              }),
            },
            references: {
              generate: next,
              hashIntent: (value) =>
                "sha256:" + Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64),
              equals: (left, right) => left === right,
            },
            repository: store,
          },
        );
      const create = (code, name) =>
        execute("Create", {
          internalCode: code,
          itemType: "RawMaterial",
          localizedNames: { en: name },
          baseUnit: kg,
          trackingPolicy: tracking,
        });
      const milk = (await create("MILK", "Whole milk")).item;
      await create("BEAN-ESP", "Espresso beans");
      await create("CUP_12", "12 oz cup");
      await create("SUGAR", "Cane sugar 100%_pure");

      const page1 = await store.list({
        search: null,
        lifecycle: null,
        afterInternalCode: null,
        limit: 2,
      });
      assert.deepEqual(
        page1.items.map((item) => item.internalCode),
        ["BEAN-ESP", "CUP_12"],
      );
      assert.equal(page1.hasMore, true);
      const page2 = await store.list({
        search: null,
        lifecycle: null,
        afterInternalCode: "CUP_12",
        limit: 2,
      });
      assert.deepEqual(
        page2.items.map((item) => item.internalCode),
        ["MILK", "SUGAR"],
      );
      assert.equal(page2.hasMore, false);
      const search = async (text) =>
        (
          await store.list({ search: text, lifecycle: null, afterInternalCode: null, limit: 50 })
        ).items.map((item) => item.internalCode);
      assert.deepEqual(await search("milk"), ["MILK"]);
      assert.deepEqual(await search("espresso"), ["BEAN-ESP"]);
      // LIKE wildcards are literal and locale keys are not searched.
      assert.deepEqual(await search("%_"), ["SUGAR"]);
      assert.deepEqual(await search("en"), []);

      await execute("Activate", {
        itemReference: milk.itemReference,
        expectedVersion: 1,
        reasonCode: "READY",
      });
      assert.deepEqual(
        (
          await store.list({
            search: null,
            lifecycle: "Active",
            afterInternalCode: null,
            limit: 50,
          })
        ).items.map((item) => item.internalCode),
        ["MILK"],
      );

      // Open stock at Store B only: the Brand-wide exposure sees it although balances are Store-scoped.
      for (const [storeId, site, location, account] of [
        [storeA, id(10), id(11), id(12)],
        [storeB, id(20), id(21), id(22)],
      ]) {
        await ensureSyntheticStockPlace(admin, {
          tenantId: scope.tenantReference,
          brandId: scope.brandReference,
          storeId,
          stockSiteId: site,
          locationId: location,
          at: at(10),
        });
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
          [scope.tenantReference, scope.brandReference, storeId],
        );
        await admin.query(
          "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8)",
          [
            scope.tenantReference,
            scope.brandReference,
            storeId,
            site,
            location,
            account,
            milk.itemReference,
            at(10),
          ],
        );
        await admin.query(
          "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,$5::numeric,0,0)",
          [scope.tenantReference, scope.brandReference, storeId, account, "0"],
        );
      }
      // Stock enters and leaves only through ledger movements.
      const balance = (onHand, version) => ({
        onHand,
        reserved: "0",
        available: onHand,
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: version,
      });
      const move = async (type, delta, before, after, minuteOf) => {
        const movement = next(),
          auditId = next(),
          outgoing = delta.startsWith("-");
        await admin.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            scope.tenantReference,
            scope.brandReference,
            storeB,
            id(22),
            movement,
            after.ledgerVersion,
            type,
            delta,
            {
              movementReference: movement,
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              itemReference: milk.itemReference,
              movementType: type,
              quantityDelta: delta,
              unitCode: "KG",
              baseQuantityDelta: delta,
              baseUnitCode: "KG",
              conversionMultiplier: "1",
              sourceScope: outgoing ? { scopeType: "Location", scopeReference: id(21) } : null,
              destinationScope: outgoing ? null : { scopeType: "Location", scopeReference: id(21) },
              lotReference: null,
              expiryDate: null,
              businessSourceType: "SYNTHETIC_TEST",
              businessSourceReference: next(),
              reasonCode: "SYNTHETIC_TEST",
              performedBy: actor,
              occurredAt: at(minuteOf),
              before,
              after,
              auditReference: auditId,
              correctsMovementReference: null,
            },
            auditId,
            at(minuteOf),
          ],
        );
      };
      await admin.query("SELECT set_config('bop.store_id',$1,false)", [storeB]);
      await move("Receive", "2.5", balance("0", 1), balance("2.5", 2), 20);
      await admin.query("SELECT set_config('bop.store_id','',false)");
      assert.equal(await store.stockExposure(milk.itemReference), true);
      const loaded = await store.load(milk.itemReference);
      // The first Receive marked the item through the ledger trigger (a new item version); the
      // zero-balance account at Store A alone already counts as an opened account.
      assert.equal(loaded.hasMovementHistory, true);
      assert.equal(await store.stockAccountsOpened(milk.itemReference), true);
      const version = loaded.aggregateVersion;
      minute = 40; // later than the movement that wrote the latest item version
      // With stock recorded, the base unit is locked and a tracking change needs a migration plan.
      const update = (baseUnit, trackingPolicy, version) =>
        execute("Update", {
          itemReference: milk.itemReference,
          expectedVersion: version,
          localizedNames: { en: "Whole milk 3.25%" },
          baseUnit,
          trackingPolicy,
          migrationPlanReference: null,
        });
      requested.length = 0;
      await assert.rejects(
        update({ ...kg, unitCode: "L", dimension: "Volume" }, tracking, version),
        {
          code: "INVENTORY_ITEM_BASE_UNIT_LOCKED",
        },
      );
      assert.deepEqual(requested, ["inventory.item.update", "inventory.item.unit.manage"]);
      await assert.rejects(
        update(kg, { ...tracking, negativeStockPolicy: "ManagerOverride" }, version),
        {
          code: "INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED",
        },
      );
      const renamed = await update(kg, tracking, version);
      assert.equal(renamed.item.localizedNames.en, "Whole milk 3.25%");

      // Store B's stock leaves through an Adjustment; the exposure follows the balance itself.
      await admin.query("SELECT set_config('bop.store_id',$1,false)", [storeB]);
      await move("Adjustment", "-2.5", balance("2.5", 2), balance("0", 3), 55);
      await admin.query("SELECT set_config('bop.store_id','',false)");
      assert.equal(await store.stockExposure(milk.itemReference), false);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });
});
