import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresAvailabilityQueryStore,
  createPostgresProductAvailabilitySourceStore,
  productAvailabilitySourceFields,
  createCurrentAvailabilityQueryService,
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
    // WP-2335: actual Catalog reader; injected safety records are synthetic owner-port fixtures.
    const syntheticSafety = (kind, evidenceScope, status) => ({
      kind,
      ...evidenceScope,
      sellableReference: id(5),
      status,
      observedAt: at,
      expiresAt: "2026-08-01T16:01:00.000Z",
      reasonCode: "SYNTHETIC_CLEAR",
    });
    const composed = (evidenceScope, inventoryStatus = "Available") =>
      createCurrentAvailabilityQueryService(
        {
          rules: createPostgresAvailabilityQueryStore(runner, evidenceScope),
          killSwitch: {
            async loadEvidence() {
              return syntheticSafety("KillSwitch", evidenceScope, "Clear");
            },
          },
          inventory: {
            async loadEvidence() {
              return inventoryStatus === null
                ? null
                : syntheticSafety("Inventory", evidenceScope, inventoryStatus);
            },
          },
          clock: {
            now() {
              return at;
            },
          },
        },
        evidenceScope,
      );
    assert.equal((await composed(scope).resolveCurrent(request)).reasonCode, "AMBIGUOUS_RULE");
    const scopedRequest = { ...request, ...otherScope };
    assert.deepEqual(await composed(otherScope).resolveCurrent(scopedRequest), {
      status: "Available",
      reasonCode: "CATALOG_ALLOWED",
      ruleReference: id(20),
      observedAt: at,
    });
    assert.equal(
      (await composed(otherScope, null).resolveCurrent(scopedRequest)).reasonCode,
      "EVIDENCE_MISSING",
    );
    assert.equal(
      (await composed(otherScope, "Unavailable").resolveCurrent(scopedRequest)).status,
      "Unavailable",
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
    // WP-2409: actual owner Product/SKU reference source across all Stores/states/time.
    // Authorization callback is synthetic; SQL/reference facts are actual persisted data.
    const impactReader = `${role}_impact`;
    await admin.query(
      `CREATE ROLE ${impactReader} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${impactReader}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${impactReader}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_catalog.product, rms_catalog.sku, rms_catalog.availability_rule TO ${impactReader}`,
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule
      (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,product_id,sellable_type,
       channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,created_at,created_by_actor_id,updated_at)
      VALUES($1,$2,'PRODUCT_IMPACT',1,'Draft',$3,'Product','[]'::jsonb,'[]'::jsonb,$4,'Unavailable',1,'SYNTHETIC_TEST',$5,$6,$5)`,
      [id(100), id(2), id(1), "2026-12-01T00:00:00.000Z", at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sku
      (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id)
      VALUES($1,$2,$3,$4,'LATTE-OTHER','Draft',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)`,
      [id(110), id(1), id(2), id(4), names, `sha256:${"c".repeat(64)}`, at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule
      (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,
       channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,created_at,created_by_actor_id,updated_at)
      VALUES($1,$2,'OTHER_SKU_IMPACT',1,'Draft',$3,'[]'::jsonb,'[]'::jsonb,$4,'Unavailable',1,'SYNTHETIC_TEST',$4,$5,$4)`,
      [id(111), id(2), id(110), at, id(3)],
    );
    let authorityCalls = 0,
      deniedAt = 0,
      impactReads = 0;
    const impactRequest = {
      purposeCode: "CATALOG_LIFECYCLE_REVIEW",
      brandReference: id(2),
      actorReference: id(3),
      productReference: id(1),
      skuReference: null,
      operationReference: id(101),
      expectedAggregateVersion: 1,
      originalProductVersionReference: id(4),
      beforeLifecycle: "Active",
      targetLifecycle: "Suspended",
      reasonCode: "SYNTHETIC_TEST",
      activeSkuCount: 1,
    };
    const impactOptions = {
      tenantReference: id(102),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      transactions: {
        async run(action) {
          await admin.query("BEGIN READ ONLY");
          try {
            await admin.query(`SET LOCAL ROLE ${impactReader}`);
            const result = await action({
              async query(sql, values) {
                if (sql.includes("targetExists")) impactReads++;
                return admin.query(sql, [...values]);
              },
            });
            await admin.query("COMMIT");
            return result;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      },
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          void tx;
          authorityCalls++;
          assert.equal(input.tenantReference, id(102));
          assert.equal(input.actorReference, id(3));
          assert.equal(input.request.brandReference, id(2));
          assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ");
          assert.equal(input.permission, "catalog.manage");
          assert.deepEqual(input.requiredFields, productAvailabilitySourceFields);
          if (authorityCalls === deniedAt)
            throw Object.assign(new Error("synthetic field denied"), { code: "SYNTHETIC_DENIED" });
        },
      },
    };
    const impact = createPostgresProductAvailabilitySourceStore(impactOptions);
    const all = await impact.loadSnapshot(impactRequest);
    assert.equal(all.coverage, "Complete");
    assert.equal(all.consistency, "StatementSnapshot");
    assert.deepEqual(
      all.references.map((r) => r.ruleReference),
      [id(6), ...variants.map(([n]) => id(n)), id(100), id(111)],
    );
    assert.deepEqual(all.skuReferences, [id(5), id(110)]);
    assert.equal(authorityCalls, 2);
    assert.equal(all.references.find((r) => r.ruleReference === id(21)).storeReference, id(70));
    assert.equal(all.references.find((r) => r.ruleReference === id(22)).lifecycle, "Inactive");
    assert.equal(all.references.find((r) => r.ruleReference === id(100)).sellableType, "Product");
    const skuImpact = await impact.loadSnapshot({ ...impactRequest, skuReference: id(5) });
    assert.equal(skuImpact.references.length, all.references.length - 1);
    assert.deepEqual(skuImpact.skuReferences, [id(5)]);
    assert.equal(
      skuImpact.references.some((r) => r.ruleReference === id(111)),
      false,
    );
    await assert.rejects(impact.loadSnapshot({ ...impactRequest, productReference: id(999) }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    await assert.rejects(impact.loadSnapshot({ ...impactRequest, skuReference: id(999) }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    const beforeRead = impactReads;
    deniedAt = authorityCalls + 1;
    await assert.rejects(impact.loadSnapshot(impactRequest), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(impactReads, beforeRead);
    deniedAt = authorityCalls + 2;
    await assert.rejects(impact.loadSnapshot(impactRequest), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(impactReads, beforeRead + 1);
    deniedAt = 0;
    const changedBefore = all.digest;
    await admin.query(
      "UPDATE rms_catalog.availability_rule SET aggregate_version=2 WHERE availability_rule_id=$1",
      [id(100)],
    );
    assert.notEqual((await impact.loadSnapshot(impactRequest)).digest, changedBefore);
    assert.equal(
      (
        await admin.query(
          "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
        )
      ).rows[0].brand,
      "",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege($1,'rms_catalog.availability_rule','UPDATE') allowed",
          [impactReader],
        )
      ).rows[0].allowed,
      false,
    );
    await admin.query(`DROP OWNED BY ${impactReader}`);
    await admin.query(`DROP ROLE ${impactReader}`);
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
