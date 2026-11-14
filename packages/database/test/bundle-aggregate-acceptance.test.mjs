import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";

import {
  createPostgresProductBundleSourceStore,
  productBundleSourceFields,
} from "../../rms/catalog/src/index.ts";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fc000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T17:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic Bundle" });

async function prove(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const role = `wp2100_${context.runId}`;
  try {
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO rms_catalog.bundle
       (bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LUNCH','Draft',1,$3,$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_version
       (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,price_mode,currency_code,fixed_amount_minor,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Fixed','CAD',1299,$5,$5)`,
      [id(3), id(1), id(2), names, at],
    );
    await admin.query("COMMIT");
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_group
       (group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,
        minimum_selection,maximum_selection,sort_order)
       VALUES ($1,$2,$3,$4,'MAIN',$5::jsonb,1,1,0)`,
      [id(5), id(3), id(1), id(2), names],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_sellable
       (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
       VALUES ($1,$2,$3,$4,$5,'Sku')`,
      [id(5), id(3), id(1), id(2), id(6)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.bundle_component_sellable
         (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
         VALUES ($1,$2,$3,$4,$5,'Bundle')`,
        [id(5), id(3), id(1), id(2), id(7)],
      ),
      /bundle_component_sellable_sellable_type_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.bundle_version
         (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,
          localized_descriptions_json,price_mode,fixed_amount_minor,created_at,updated_at)
         VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Fixed',100,$5,$5)`,
        [id(8), id(1), id(2), names, at],
      ),
      /bundle_version_price_shape/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_operation_record
       (operation_id,brand_id,bundle_id,action_code,intent_digest,result_aggregate_version,outbox_event_id,occurred_at)
       VALUES ($1,$2,$3,'Create',$4,1,$5,$6)`,
      [id(10), id(2), id(1), `sha256:${"a".repeat(64)}`, id(11), at],
    );
    await admin.query(
      "UPDATE rms_catalog.bundle_operation_record SET result_aggregate_version=2 WHERE operation_id=$1",
      [id(10)],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT result_aggregate_version FROM rms_catalog.bundle_operation_record WHERE operation_id=$1",
          [id(10)],
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
    assert.equal((await admin.query("SELECT * FROM rms_catalog.bundle")).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.bundle")).rowCount, 1);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.bundle_component_sellable")).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.bundle_operation_record")).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
    // WP-2409: actual Bundle reference source. Authority is explicitly synthetic,
    // not evidence of production IAM/policy or held writer/source semantics.
    await admin.query(
      `INSERT INTO rms_catalog.product
      (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
      VALUES($1,$2,'SYNTHETIC_TARGET','PreparedFood','Draft',1,$3,$4,$3)`,
      [id(40), id(2), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_version
      (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at)
      VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
      [id(41), id(40), id(2), names, at],
    );
    for (const [sku, code] of [
      [6, "SYNTHETIC_FIRST"],
      [42, "SYNTHETIC_OTHER"],
    ]) {
      const selections = [{ dimensionReference: id(60), valueReference: id(sku === 6 ? 61 : 62) }];
      await admin.query(
        `INSERT INTO rms_catalog.sku
        (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id)
        VALUES($1,$2,$3,$4,$5,'Draft',$6::jsonb,$10::jsonb,$7,'EACH',1,$8,$9)`,
        [
          id(sku),
          id(40),
          id(2),
          id(41),
          code,
          names,
          `sha256:${sha256Hex(canonicalizeRfc8785(selections))}`,
          at,
          id(4),
          JSON.stringify(selections),
        ],
      );
    }
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_sellable
      (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
      VALUES($1,$2,$3,$4,$5,'Product')`,
      [id(5), id(3), id(1), id(2), id(40)],
    );
    // Immutable historical Published version differs from the current Draft pointer.
    await admin.query(
      `INSERT INTO rms_catalog.bundle_version
      (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,
       price_mode,currency_code,fixed_amount_minor,validation_digest,created_at,updated_at,published_at)
      VALUES($1,$2,$3,'Published','en-CA',$4::jsonb,$4::jsonb,'Fixed','CAD',1299,$5,$6,$6,$6)`,
      [id(45), id(1), id(2), names, `sha256:${"c".repeat(64)}`, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_group
      (group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,minimum_selection,maximum_selection,sort_order)
      VALUES($1,$2,$3,$4,'HISTORICAL_MAIN',$5::jsonb,1,1,0)`,
      [id(46), id(45), id(1), id(2), names],
    );
    for (const [sellable, type] of [
      [40, "Product"],
      [42, "Sku"],
    ]) {
      await admin.query(
        `INSERT INTO rms_catalog.bundle_component_sellable
        (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [id(46), id(45), id(1), id(2), id(sellable), type],
      );
    }
    const sourceReader = `${role}_source`;
    await admin.query(
      `CREATE ROLE ${sourceReader} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO ${sourceReader}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${sourceReader}`,
    );
    await admin.query(`GRANT SELECT ON rms_catalog.product,rms_catalog.sku,rms_catalog.bundle,rms_catalog.bundle_version,
      rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable TO ${sourceReader}`);
    await admin.query(
      "SELECT set_config('bop.brand_id','',false),set_config('bop.store_id','',false)",
    );
    const request = {
      purposeCode: "CATALOG_LIFECYCLE_REVIEW",
      brandReference: id(2),
      actorReference: id(4),
      productReference: id(40),
      skuReference: null,
      operationReference: id(47),
      expectedAggregateVersion: 1,
      originalProductVersionReference: id(41),
      beforeLifecycle: "Draft",
      targetLifecycle: "Archived",
      reasonCode: "SYNTHETIC_TEST",
      activeSkuCount: 0,
    };
    let authorityCalls = 0,
      deniedAt = 0,
      sourceReads = 0;
    const options = {
      tenantReference: id(48),
      brandReference: id(2),
      actorReference: id(4),
      clock: { now: () => new Date().toISOString() },
      transactions: {
        async run(action) {
          await admin.query("BEGIN READ ONLY");
          try {
            await admin.query(`SET LOCAL ROLE ${sourceReader}`);
            const result = await action({
              async query(sql, values) {
                if (sql.includes("targetExists")) sourceReads++;
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
          assert.equal(input.tenantReference, id(48));
          assert.equal(input.actorReference, id(4));
          assert.equal(input.request.brandReference, id(2));
          assert.equal(input.request.productReference, id(40));
          assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ");
          assert.equal(input.permission, "catalog.manage");
          assert.deepEqual(input.requiredFields, productBundleSourceFields);
          if (authorityCalls === deniedAt) throw new Error("synthetic authority denied");
        },
      },
    };
    const source = createPostgresProductBundleSourceStore(options),
      all = await source.loadSnapshot(request);
    assert.equal(all.coverage, "Complete");
    assert.equal(all.consistency, "StatementSnapshot");
    assert.equal(authorityCalls, 2);
    assert.deepEqual(all.skuReferences, [id(6), id(42)]);
    assert.equal(all.references.length, 4);
    assert.equal(all.references.filter((r) => r.isCurrentVersion).length, 2);
    assert.equal(
      all.references.filter((r) => !r.isCurrentVersion && r.versionStatus === "Published").length,
      2,
    );
    assert.equal(
      all.references.every((r) => r.lifecycle === "Draft"),
      true,
    );
    assert.equal(
      all.references.find((r) => r.bundleVersionReference === id(45)).validationDigest,
      `sha256:${"c".repeat(64)}`,
    );
    const first = await source.loadSnapshot({ ...request, skuReference: id(6) });
    assert.equal(first.references.length, 3);
    assert.equal(
      first.references.some((r) => r.sellableReference === id(42)),
      false,
    );
    assert.equal(first.references.filter((r) => r.sellableType === "Product").length, 2);
    await assert.rejects(source.loadSnapshot({ ...request, productReference: id(999) }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    await assert.rejects(source.loadSnapshot({ ...request, skuReference: id(999) }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    const before = sourceReads;
    deniedAt = authorityCalls + 1;
    await assert.rejects(source.loadSnapshot(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    assert.equal(sourceReads, before);
    deniedAt = authorityCalls + 2;
    await assert.rejects(source.loadSnapshot(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    assert.equal(sourceReads, before + 1);
    deniedAt = 0;
    await admin.query(
      "UPDATE rms_catalog.bundle SET aggregate_version=2,lifecycle=$2 WHERE bundle_id=$1",
      [id(1), "Archived"],
    );
    const changed = await source.loadSnapshot(request);
    assert.notEqual(changed.digest, all.digest);
    assert.equal(
      changed.references.every((r) => r.lifecycle === "Archived"),
      true,
    );
    assert.equal(changed.references.filter((r) => r.versionStatus === "Published").length, 2);
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
        await admin.query("SELECT has_table_privilege($1,'rms_catalog.bundle','UPDATE') allowed", [
          sourceReader,
        ])
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await admin.query("SELECT current_version_id FROM rms_catalog.bundle WHERE bundle_id=$1", [
          id(1),
        ])
      ).rows[0].current_version_id,
      id(3),
    );
    // Deliberately malformed synthetic root: source rejects Draft current version
    // with Published root, instead of reporting valid/current sale or empty impact.
    await admin.query(
      "UPDATE rms_catalog.bundle SET lifecycle='Published',aggregate_version=3 WHERE bundle_id=$1",
      [id(1)],
    );
    await assert.rejects(source.loadSnapshot(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await admin.query(`DROP OWNED BY ${sourceReader}`);
    await admin.query(`DROP ROLE ${sourceReader}`);
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Bundle persistence, immutable history and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "bundle", root }, prove);
}, 120_000);
