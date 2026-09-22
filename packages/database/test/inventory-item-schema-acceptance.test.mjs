import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("enforces Inventory identity, contiguous immutable versions and Tenant/Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_inv_item" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_inventory_" + context.runId;
    assert.match(role, /^wp2402_inventory_[a-f0-9]+$/u);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_inventory,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA rms_inventory TO " +
          role,
      );
      async function scoped(action, tenant = id(1), brand = id(2)) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
            [tenant, brand],
          );
          const result = await action(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      }
      const now = "2026-09-11T10:00:00.000Z";
      const snapshot = (version) => ({
        tenantReference: id(1),
        brandReference: id(2),
        itemReference: id(3),
        aggregateVersion: version,
        updatedAt: now,
        internalCode: "SYNTHETIC_ITEM",
        itemType: "RawMaterial",
        createdBy: id(4),
        createdAt: now,
      });
      const insert = (client, version, change = {}) =>
        client.query(
          "INSERT INTO rms_inventory.inventory_item_version (tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [id(1), id(2), id(3), version, { ...snapshot(version), ...change }, now],
        );
      await scoped(async (client) => {
        await client.query(
          "INSERT INTO rms_inventory.inventory_item VALUES ($1,$2,$3,'SYNTHETIC_ITEM','RawMaterial',$4,$5)",
          [id(1), id(2), id(3), now, id(4)],
        );
        await insert(client, 1);
        await client.query(
          "INSERT INTO rms_inventory.inventory_item_operation (tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES ($1,$2,$3,$4,1,$5,'Create',$6)",
          [id(1), id(2), id(5), id(3), "sha256:" + "a".repeat(64), id(6)],
        );
      });
      await assert.rejects(
        scoped((client) => insert(client, 3)),
        { code: "23514" },
      );
      await assert.rejects(
        scoped((client) => insert(client, 2, { internalCode: "CHANGED" })),
        { code: "23514" },
      );
      const results = await Promise.allSettled([
        scoped((client) => insert(client, 2)),
        scoped((client) => insert(client, 2)),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      for (const table of [
        "inventory_item",
        "inventory_item_version",
        "inventory_item_operation",
      ]) {
        for (const scope of [
          [id(9), id(2)],
          [id(1), id(9)],
          ["", id(2)],
        ]) {
          const result = await scoped(
            (client) => client.query("SELECT * FROM rms_inventory." + table),
            ...scope,
          );
          assert.equal(result.rowCount, 0);
        }
        await assert.rejects(
          scoped((client) => client.query("DELETE FROM rms_inventory." + table)),
          { code: "55000" },
        );
        await assert.rejects(
          scoped((client) => client.query("TRUNCATE rms_inventory." + table + " CASCADE")),
          { code: "55000" },
        );
      }
      await assert.rejects(
        scoped((client) =>
          client.query("UPDATE rms_inventory.inventory_item_version SET snapshot_json='{}'"),
        ),
        { code: "55000" },
      );
      // RLS hides the identity from the BEFORE INSERT sequence trigger.
      await assert.rejects(
        scoped((client) => insert(client, 3), id(9)),
        { code: "P0002" },
      );
      const versions = await scoped((client) =>
        client.query(
          "SELECT version::text FROM rms_inventory.inventory_item_version ORDER BY version",
        ),
      );
      assert.deepEqual(versions.rows, [{ version: "1" }, { version: "2" }]);
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
