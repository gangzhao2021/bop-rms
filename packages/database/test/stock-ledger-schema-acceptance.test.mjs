import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
it("serializes exact stock ledger changes, protects balances and isolates Store scope", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_stock" }, async (context) => {
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
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement TO " +
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
      const zero = balance(1, "0", "0", "0");
      const received = balance(2, "10.000001", "0", "10.000001");
      const reserved = balance(3, "10.000001", "6.000001", "4");
      const released = balance(4, "10.000001", "4", "6.000001");
      const consumed = balance(5, "6.000001", "0", "6.000001");
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
      await scoped((client) => append(client, 20, "Receive", "10.000001", zero, received));
      const competition = await Promise.allSettled([
        scoped((client) => append(client, 21, "Reserve", "6.000001", received, reserved)),
        scoped((client) => append(client, 22, "Reserve", "6.000001", received, reserved)),
      ]);
      assert.equal(competition.filter((result) => result.status === "fulfilled").length, 1);
      await scoped((client) => append(client, 23, "Release", "-2.000001", reserved, released));
      await scoped((client) => append(client, 24, "Consume", "-4", released, consumed));
      await assert.rejects(
        scoped((client) =>
          append(client, 25, "Consume", "-7", consumed, balance(6, "-0.999999", "0", "-0.999999")),
        ),
        { code: "23514" },
      );
      await assert.rejects(
        scoped((client) =>
          append(client, 26, "Receive", "1", consumed, balance(6, "7.000001", "0", "7.000001"), {
            sourceScope: { scopeType: "Location", scopeReference: id(99) },
          }),
        ),
        { code: "23514" },
      );
      await assert.rejects(
        scoped((client) => client.query("UPDATE rms_inventory.stock_balance SET on_hand=100")),
        { code: "55000" },
      );
      await assert.rejects(
        scoped((client) => client.query("DELETE FROM rms_inventory.stock_movement")),
        { code: "55000" },
      );
      await assert.rejects(
        scoped((client) => client.query("TRUNCATE rms_inventory.stock_balance")),
        { code: "55000" },
      );
      const actual = await scoped((client) =>
        client.query(
          "SELECT ledger_version::text,on_hand::text,reserved::text,available::text FROM rms_inventory.stock_balance",
        ),
      );
      assert.deepEqual(actual.rows, [
        { ledger_version: "5", on_hand: "6.000001", reserved: "0", available: "6.000001" },
      ]);
      const count = await scoped((client) =>
        client.query("SELECT count(*)::int AS n FROM rms_inventory.stock_movement"),
      );
      assert.equal(count.rows[0].n, 4);
      for (const table of ["stock_account", "stock_balance", "stock_movement"]) {
        for (const scope of [
          [id(90), id(2), id(3)],
          [id(1), id(90), id(3)],
          [id(1), id(2), id(90)],
        ]) {
          assert.equal(
            (await scoped((client) => client.query("SELECT * FROM rms_inventory." + table), scope))
              .rowCount,
            0,
          );
        }
      }
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
