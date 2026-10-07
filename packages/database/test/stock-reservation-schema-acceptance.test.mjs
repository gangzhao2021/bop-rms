import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryReservation,
  advanceInventoryReservation,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("binds reservation ownership to movements and rolls back attempts to spend another reservation", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_reserve" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_stock_" + context.runId;
    assert.match(role, /^wp2402_stock_[a-f0-9]+$/u);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_inventory,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement,rms_inventory.stock_reservation_version TO " +
          role,
      );
      // DEC-INV-LOCATIONS: opening an account checks the registered active location.
      await admin.query(
        "GRANT SELECT ON rms_inventory.stock_site_version,rms_inventory.storage_location_version TO " +
          role,
      );
      await admin.query("GRANT SELECT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query("GRANT SELECT,INSERT ON rms_inventory.inventory_item_version TO " + role);
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC','RawMaterial',$4,$5)",
        [id(1), id(2), id(6), at, id(9)],
      );
      const item = {
        tenantReference: id(1),
        brandReference: id(2),
        itemReference: id(6),
        aggregateVersion: 1,
        updatedAt: at,
        createdAt: at,
        createdBy: id(9),
        internalCode: "SYNTHETIC",
        itemType: "RawMaterial",
      };
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,1,$4,$5)",
        [id(1), id(2), id(6), item, at],
      );
      async function scoped(work, scope = [id(1), id(2), id(3)]) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            scope,
          );
          const result = await work(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      }
      await ensureSyntheticStockPlace(admin, {
        tenantId: id(1),
        brandId: id(2),
        storeId: id(3),
        stockSiteId: id(4),
        locationId: id(5),
        at,
      });
      await scoped(async (client) => {
        await client.query(
          "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,lot_id,expiry_date,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,NULL,NULL,'KG',6,$8)",
          [id(1), id(2), id(3), id(4), id(5), id(7), id(6), at],
        );
        await client.query(
          "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
          [id(1), id(2), id(3), id(7)],
        );
      });
      const balance = (ledgerVersion, onHand, reserved, available) => ({
        ledgerVersion,
        onHand,
        reserved,
        available,
        inTransit: "0",
        unitCode: "KG",
      });
      function append(client, n, type, delta, before, after, extra = {}) {
        const record = {
          movementReference: id(n),
          tenantReference: id(1),
          brandReference: id(2),
          itemReference: id(6),
          movementType: type,
          quantityDelta: delta,
          unitCode: "KG",
          baseQuantityDelta: delta,
          baseUnitCode: "KG",
          conversionMultiplier: "1",
          sourceScope: { scopeType: "Location", scopeReference: id(5) },
          destinationScope: null,
          lotReference: null,
          expiryDate: null,
          businessSourceType: "SYNTHETIC",
          businessSourceReference: id(8),
          reasonCode: "SYNTHETIC_TEST",
          performedBy: id(9),
          occurredAt: at,
          before,
          after,
          auditReference: id(n + 100),
          correctsMovementReference: null,
          ...extra,
        };
        return client.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            id(1),
            id(2),
            id(3),
            id(7),
            id(n),
            after.ledgerVersion,
            type,
            delta,
            record,
            id(n + 100),
            at,
          ],
        );
      }

      const binding = (n) => ({
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        stockSiteReference: id(4),
        locationReference: id(5),
        itemReference: id(6),
        lotReference: null,
        submissionReference: id(n + 1000),
        cartReference: id(n + 2000),
        cartVersion: 1,
        quoteReference: id(n + 3000),
        demandReference: id(n + 4000),
        demandDigest: "sha256:" + "a".repeat(64),
      });
      const unit = {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 2,
        ledgerPrecision: 6,
        roundingMode: "HalfEven",
      };
      const first = createInventoryReservation({
        reservationReference: id(50),
        binding: binding(50),
        unit,
        quantity: "6",
        occurredAt: at,
      });
      const second = createInventoryReservation({
        reservationReference: id(60),
        binding: binding(60),
        unit,
        quantity: "2",
        occurredAt: at,
      });
      function save(client, record, action, n, movement) {
        return client.query(
          "INSERT INTO rms_inventory.stock_reservation_version (tenant_id,brand_id,store_id,account_id,reservation_id,version,operation_id,intent_hash,action,submission_id,demand_id,movement_id,audit_id,snapshot_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            id(1),
            id(2),
            id(3),
            id(7),
            record.reservationReference,
            record.version,
            id(n + 500),
            "sha256:" + "a".repeat(64),
            action,
            record.binding.submissionReference,
            record.binding.demandReference,
            movement === null ? null : id(movement),
            id(n + 100),
            record,
            at,
          ],
        );
      }
      function move(client, n, type, delta, before, after, reservation) {
        return append(client, n, type, delta, before, after, {
          businessSourceType: "INVENTORY_RESERVATION",
          businessSourceReference: reservation.reservationReference,
        });
      }
      const zero = balance(1, "0", "0", "0"),
        received = balance(2, "10", "0", "10"),
        firstHeld = balance(3, "10", "6", "4"),
        bothHeld = balance(4, "10", "8", "2"),
        releasedBalance = balance(5, "10", "6", "4"),
        consumedBalance = balance(6, "6", "2", "4");
      await scoped((client) => append(client, 20, "Receive", "10", zero, received));
      await scoped(async (client) => {
        await move(client, 21, "Reserve", "6", received, firstHeld, first);
        await save(client, first, "Reserve", 21, 21);
      });
      await scoped(async (client) => {
        await move(client, 22, "Reserve", "2", firstHeld, bothHeld, second);
        await save(client, second, "Reserve", 22, 22);
      });
      // Aggregate reserved is 8, but this reservation owns only 6.
      await assert.rejects(
        scoped(async (client) => {
          await move(client, 23, "Consume", "-7", bothHeld, balance(5, "3", "1", "2"), first);
          await save(
            client,
            { ...first, version: 2, remainingQuantity: "-1", consumedQuantity: "7" },
            "Consume",
            23,
            23,
          );
        }),
        { code: "23514" },
      );
      const release = advanceInventoryReservation(first, {
        reservationReference: first.reservationReference,
        binding: first.binding,
        expectedVersion: 1,
        action: "Release",
        quantity: "2",
        occurredAt: at,
      });
      await assert.rejects(
        scoped(async (client) => {
          await move(client, 24, "Release", "-2", bothHeld, releasedBalance, second);
          await save(client, release, "Release", 24, 24);
        }),
        { code: "23514" },
      );
      await scoped(async (client) => {
        await move(client, 25, "Release", "-2", bothHeld, releasedBalance, first);
        await save(client, release, "Release", 25, 25);
      });
      const started = advanceInventoryReservation(release, {
        reservationReference: first.reservationReference,
        binding: first.binding,
        expectedVersion: 2,
        action: "StartProduction",
        quantity: null,
        occurredAt: at,
      });
      await scoped((client) => save(client, started, "StartProduction", 26, null));
      await assert.rejects(
        scoped(async (client) => {
          await move(
            client,
            27,
            "Release",
            "-1",
            releasedBalance,
            balance(6, "10", "5", "5"),
            first,
          );
          await save(
            client,
            { ...started, version: 4, remainingQuantity: "3", releasedQuantity: "3" },
            "Release",
            27,
            27,
          );
        }),
        { code: "23514" },
      );
      const consumed = advanceInventoryReservation(started, {
        reservationReference: first.reservationReference,
        binding: first.binding,
        expectedVersion: 3,
        action: "Consume",
        quantity: "4",
        occurredAt: at,
      });
      await scoped(async (client) => {
        await move(client, 28, "Consume", "-4", releasedBalance, consumedBalance, first);
        await save(client, consumed, "Consume", 28, 28);
      });
      await assert.rejects(scoped((client) => save(client, started, "StartProduction", 26, null)));
      const state = await scoped((client) =>
        client.query(
          "SELECT on_hand::text,reserved::text,ledger_version::text FROM rms_inventory.stock_balance",
        ),
      );
      assert.deepEqual(state.rows, [{ on_hand: "6", reserved: "2", ledger_version: "6" }]);
      const history = await scoped((client) =>
        client.query(
          "SELECT reservation_id,version::text,snapshot_json->>'remainingQuantity' AS remaining FROM rms_inventory.stock_reservation_version ORDER BY reservation_id,version",
        ),
      );
      assert.equal(history.rows.length, 5);
      assert.deepEqual(history.rows.at(-1), {
        reservation_id: second.reservationReference,
        version: "1",
        remaining: "2",
      });
      for (const foreign of [
        [id(90), id(2), id(3)],
        [id(1), id(90), id(3)],
        [id(1), id(2), id(90)],
      ])
        assert.equal(
          (
            await scoped(
              (client) => client.query("SELECT * FROM rms_inventory.stock_reservation_version"),
              foreign,
            )
          ).rowCount,
          0,
        );
      await assert.rejects(
        scoped((client) => client.query("DELETE FROM rms_inventory.stock_reservation_version")),
        { code: "55000" },
      );
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
