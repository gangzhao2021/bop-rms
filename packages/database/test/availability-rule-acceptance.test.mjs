import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresAvailabilityQueryStore,
  resolveStoreAvailability,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f7100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-01T16:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic" });
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1023_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_catalog.product (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'LATTE','PreparedFood','Active',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_version (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
      [id(4), id(1), id(2), names, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sku (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,'LATTE-EACH','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)`,
      [id(5), id(1), id(2), id(4), names, `sha256:${"a".repeat(64)}`, at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'LATTE_STORE',1,'Active',$3,$4,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,$5,NULL,'Available',10,'CATALOG_ALLOWED',$5,$6,$5)`,
      [id(6), id(2), id(5), id(7), at, id(3)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'CROSS_BRAND',1,'Active',$3,'[]'::jsonb,'[]'::jsonb,$4,NULL,'Available',1,'BAD_SCOPE',$4,$5,$4)`,
        [id(10), id(11), id(5), at, id(3)],
      ),
      /availability_rule_sku_fk/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'BAD',1,'Active',$3,'[]'::jsonb,'[]'::jsonb,$4,$4,'Available',1,'BAD',$4,$5,$4)`,
        [id(8), id(2), id(5), at, id(3)],
      ),
      /availability_rule_period_check/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule_operation_record (operation_id,brand_id,availability_rule_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES ($1,$2,$3,'Create',$4,1,$5)`,
      [id(9), id(2), id(6), `sha256:${"b".repeat(64)}`, at],
    );
    await admin.query(
      `UPDATE rms_catalog.availability_rule_operation_record SET result_aggregate_version=2 WHERE operation_id=$1`,
      [id(9)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT result_aggregate_version FROM rms_catalog.availability_rule_operation_record WHERE operation_id=$1`,
          [id(9)],
        )
      ).rows[0].result_aggregate_version,
      1,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_catalog.availability_rule`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_catalog.availability_rule`)).rowCount, 1);
    await admin.query(`RESET ROLE`);
    // Actual owner adapter: only the availability table is granted to this separate reader.
    const reader = `${role}_read`;
    await admin.query(
      `CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${reader}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${reader}`,
    );
    await admin.query(`GRANT SELECT ON rms_catalog.availability_rule TO ${reader}`);
    await admin.query(
      "SELECT set_config('bop.brand_id','',false), set_config('bop.store_id','',false)",
    );
    const variants = [
      [20, null, "Active", "[]", "[]", at, null, "Available"],
      [21, id(70), "Active", "[]", "[]", at, null, "Available"],
      [22, id(7), "Inactive", "[]", "[]", at, null, "Available"],
      [23, id(7), "Active", '["WEB"]', "[]", at, null, "Available"],
      [24, id(7), "Active", "[]", '["PICKUP"]', at, null, "Available"],
      [25, id(7), "Active", "[]", "[]", "2026-08-01T15:00:00.000Z", at, "Available"],
      [26, id(7), "Active", "[]", "[]", "2026-08-01T17:00:00.000Z", null, "Available"],
      [27, id(7), "Active", "[]", "[]", at, null, "Unavailable"],
    ];
    for (const [n, store, lifecycle, channels, orders, from, until, decision] of variants) {
      await admin.query(
        `INSERT INTO rms_catalog.availability_rule
        SELECT $1,brand_id,$2,aggregate_version,$3,sku_id,$4,$5::jsonb,$6::jsonb,$7::timestamptz,
          $8::timestamptz,$9,priority,reason_code,created_at,created_by_actor_id,updated_at
        FROM rms_catalog.availability_rule WHERE availability_rule_id=$10`,
        [id(n), `SYNTHETIC_${n}`, lifecycle, store, channels, orders, from, until, decision, id(6)],
      );
    }
    const runner = {
      async run(action) {
        await admin.query("BEGIN READ ONLY");
        try {
          await admin.query(`SET LOCAL ROLE ${reader}`);
          assert.equal(
            (await admin.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
            "on",
          );
          const result = await action({ query: (sql, values) => admin.query(sql, [...values]) });
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      },
    };
    const scope = { brandReference: id(2), storeReference: id(7) };
    const request = {
      ...scope,
      sellableReference: id(5),
      channelCode: "DINE_IN",
      orderTypeCode: "TABLE_SERVICE",
      observedAt: at,
    };
    const store = createPostgresAvailabilityQueryStore(runner, scope);
    const rules = await store.loadCurrentRules(request);
    assert.deepEqual(
      rules.map((rule) => rule.ruleReference),
      [id(6), id(20), id(27)],
    );
    assert.equal(
      resolveStoreAvailability({
        ...scope,
        sellableReference: id(5),
        channelCode: "DINE_IN",
        orderTypeCode: "TABLE_SERVICE",
        at,
        rules,
        safetyEvidence: [],
      }).status,
      "Indeterminate",
    );
    const otherScope = { brandReference: id(2), storeReference: id(71) };
    assert.deepEqual(
      (
        await createPostgresAvailabilityQueryStore(runner, otherScope).loadCurrentRules({
          ...request,
          ...otherScope,
        })
      ).map((rule) => rule.ruleReference),
      [id(20)],
    );
    const foreignScope = { brandReference: id(80), storeReference: id(7) };
    assert.deepEqual(
      await createPostgresAvailabilityQueryStore(runner, foreignScope).loadCurrentRules({
        ...request,
        ...foreignScope,
      }),
      [],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT current_setting('bop.brand_id',true) AS brand, current_setting('bop.store_id',true) AS store",
        )
      ).rows[0].brand,
      "",
    );
    assert.equal(
      (await admin.query("SELECT current_setting('bop.store_id',true) AS store")).rows[0].store,
      "",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'rms_catalog.availability_rule','INSERT') AS allowed",
          [reader],
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'rms_catalog.product','SELECT') AS allowed",
          [reader],
        )
      ).rows[0].allowed,
      false,
    );
    await admin.query(`DROP OWNED BY ${reader}`);
    await admin.query(`DROP ROLE ${reader}`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces Store Availability Overlay persistence boundaries", async () => {
  await withIsolatedDatabase({ caseId: "availability", root }, prove);
}, 120_000);
