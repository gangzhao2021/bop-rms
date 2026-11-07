import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  applyStockPlaceCommand,
  createPostgresStockPlaceStore,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedSyntheticInventoryItems } from "../test-support/recipe-inventory-observation.mjs";

const { Client } = pg;
const id = (n) => "01909a04-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** WP-2423 / DEC-INV-LOCATIONS: Inventory owner persistence for Stock Sites and Locations. */
it("keeps Store stock places versioned, audited, idempotent and guarded by remaining stock", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stock_place" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_place_" + context.runId;
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const actor = id(4);
    let sequence = 100;
    const next = () => id(++sequence);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.stock_site,rms_inventory.stock_site_version,rms_inventory.storage_location,rms_inventory.storage_location_version,rms_inventory.stock_place_operation,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_inventory.stock_account,rms_inventory.stock_balance TO " + role,
      );
      const runner = (storeId = scope.storeReference) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const value = await work(client);
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
        storeId,
      });
      const places = createPostgresStockPlaceStore(runner(), scope);
      const execute = async (current, command, minute, operationReference = next()) => {
        const ctx = { ...scope, actorReference: actor, occurredAt: at(minute) };
        const candidate = applyStockPlaceCommand(current, command, ctx);
        const kind = command.kind;
        const target =
          kind === "StorageLocation" ? candidate.locationReference : candidate.stockSiteReference;
        return places.commit({
          operationReference,
          command,
          candidate,
          audit: {
            auditId: next(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: actor },
            actionCode: "INVENTORY_STOCK_PLACE_" + command.action.toUpperCase(),
            targetType: kind,
            targetId: target,
            reasonCode: "STORE_INVENTORY_SETUP",
            correlationId: operationReference,
            occurredAt: at(minute),
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
      };
      const site = id(10),
        main = id(20),
        fridge = id(21);
      await execute(
        null,
        {
          kind: "StockSite",
          action: "Create",
          stockSiteReference: site,
          payload: {
            siteKind: "Store",
            code: "STORE",
            isDefault: true,
            localizedNames: { en: "Store" },
          },
        },
        0,
      );
      const location = (reference, code, isDefault, temperatureZone, sortOrder) => ({
        kind: "StorageLocation",
        action: "Create",
        locationReference: reference,
        payload: {
          stockSiteReference: site,
          code,
          isDefault,
          localizedNames: { en: code },
          temperatureZone,
          sortOrder,
        },
      });
      await execute(null, location(main, "DRY", true, "Ambient", 0), 1);
      const createFridge = location(fridge, "FRIDGE", false, "Chilled", 1);
      const fridgeOperation = next();
      const created = await execute(null, createFridge, 2, fridgeOperation);
      assert.equal(created.status, "Applied");
      assert.equal(
        (await execute(null, createFridge, 2, fridgeOperation)).status,
        "AlreadyApplied",
      );
      await assert.rejects(
        execute(
          null,
          { ...createFridge, payload: { ...createFridge.payload, sortOrder: 5 } },
          2,
          fridgeOperation,
        ),
        { code: "STOCK_PLACE_IDEMPOTENCY_CONFLICT" },
      );
      await assert.rejects(execute(null, location(id(22), "FRIDGE", false, "Chilled", 2), 3), {
        code: "STOCK_PLACE_CONFLICT",
      });
      const listed = await places.list();
      assert.deepEqual(
        listed.locations.map((l) => [l.code, l.temperatureZone, l.isDefault]),
        [
          ["DRY", "Ambient", true],
          ["FRIDGE", "Chilled", false],
        ],
      );
      assert.equal(listed.sites.length, 1);

      const current = (reference) => places.load("StorageLocation", reference);
      await assert.rejects(
        execute(
          await current(main),
          { kind: "StorageLocation", action: "Deactivate", expectedVersion: 1 },
          4,
        ),
        { code: "STOCK_PLACE_DEFAULT_REQUIRED" },
      );

      // Stock still held at the fridge blocks deactivation in the database itself.
      const account = id(30);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation TO " +
          role,
      );
      await seedSyntheticInventoryItems({
        admin,
        role,
        runner: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query(
                "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
                [scope.tenantReference, scope.brandReference],
              );
              const value = await work({ query: (sql, values) => admin.query(sql, [...values]) });
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
        id,
        at: at(5),
        scope: { ...scope, stockSiteReference: site },
        next,
        items: [{ itemReference: id(31), operationReference: id(33), onHand: "1" }],
      });
      await admin.query("RESET ROLE");
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8)",
        [...Object.values(scope), site, fridge, account, id(31), at(5)],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
        [...Object.values(scope), account],
      );
      // Stock enters and leaves only through ledger movements (Receive, then an Adjustment).
      const balance = (onHand, version) => ({
        onHand,
        reserved: "0",
        available: onHand,
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: version,
      });
      const move = async (type, delta, before, after, minute) => {
        const movement = next(),
          auditId = next();
        const outgoing = delta.startsWith("-");
        const record = {
          movementReference: movement,
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          itemReference: id(31),
          movementType: type,
          quantityDelta: delta,
          unitCode: "KG",
          baseQuantityDelta: delta,
          baseUnitCode: "KG",
          conversionMultiplier: "1",
          sourceScope: outgoing ? { scopeType: "Location", scopeReference: fridge } : null,
          destinationScope: outgoing ? null : { scopeType: "Location", scopeReference: fridge },
          lotReference: null,
          expiryDate: null,
          businessSourceType: "SYNTHETIC_TEST",
          businessSourceReference: next(),
          reasonCode: "SYNTHETIC_TEST",
          performedBy: actor,
          occurredAt: at(minute),
          before,
          after,
          auditReference: auditId,
          correctsMovementReference: null,
        };
        await admin.query("BEGIN");
        try {
          await admin.query(
            "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              ...Object.values(scope),
              account,
              movement,
              after.ledgerVersion,
              type,
              delta,
              record,
              auditId,
              at(minute),
            ],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      await move("Receive", "2", balance("0", 1), balance("2", 2), 5);
      assert.ok((await places.locationsHoldingStock()).includes(fridge));
      await assert.rejects(
        execute(
          await current(fridge),
          { kind: "StorageLocation", action: "Deactivate", expectedVersion: 1 },
          6,
        ),
        { code: "STOCK_PLACE_CONFLICT" },
      );
      // A Waste larger than on hand, and an Adjustment that would go negative, are refused.
      await assert.rejects(move("Waste", "-3", balance("2", 2), balance("-1", 3), 6));
      await move("Adjustment", "-2", balance("2", 2), balance("0", 3), 6);
      assert.ok(!(await places.locationsHoldingStock()).includes(fridge));
      const off = await execute(
        await current(fridge),
        { kind: "StorageLocation", action: "Deactivate", expectedVersion: 1 },
        7,
      );
      assert.equal(off.place.lifecycle, "Inactive");
      // No new stock account may be opened at an inactive location.
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8)",
          [...Object.values(scope), site, fridge, id(32), id(31), at(8)],
        ),
        /not active/u,
      );
      const audits = (
        await admin.query(
          "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'INVENTORY_STOCK_PLACE_%'",
        )
      ).rows[0].n;
      assert.equal(audits, 4);
      // Another Store sees nothing.
      const elsewhere = createPostgresStockPlaceStore(runner(id(99)), {
        ...scope,
        storeReference: id(99),
      });
      assert.deepEqual(await elsewhere.list(), { sites: [], locations: [] });
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
