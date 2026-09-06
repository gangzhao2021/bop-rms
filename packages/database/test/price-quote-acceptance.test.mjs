import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { readMigrationCatalog } from "../src/catalog.ts";
import { runMigrationCommand } from "../src/runner.ts";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fd000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const digest = (c) => `sha256:${c.repeat(64)}`;
const migrationId = "1200_007_alter_quote_line_identity";
const snapshotMigrationId = "1200_008_alter_quote_snapshot";

// Database causes can contain SQL and bind values; retain only the synthetic test phase.
function controlledFailure(phase) {
  return new Error(`WP2225_${phase}_FAILED`);
}

async function denied(action, expectedCode) {
  let code;
  try {
    await action();
  } catch (error) {
    code = error?.code;
  }
  assert.equal(code, expectedCode);
}

async function applyCatalog(context, catalog) {
  const result = await runMigrationCommand({
    catalog,
    command: "apply",
    config: { ...context.clientConfig, environment: "test" },
    confirmTarget: `test:${context.databaseName}`,
  });
  if (result.diagnostics.some((diagnostic) => diagnostic.code === "MIGRATION_OUT_OF_ORDER")) {
    throw new Error("WP2225_MIGRATION_OUT_OF_ORDER");
  }
  assert.equal(result.diagnostics.length, 0);
  return result;
}

async function prove(context, catalog) {
  const admin = new Client(context.clientConfig);
  const role = `wp2225_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.price_quote
       (price_quote_id,quote_version,brand_id,store_id,cart_id,cart_version,input_digest,currency_code,
        currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,subtotal_minor,
        discount_minor,tax_minor,fee_minor,total_minor,applied_promotion_references_json,warnings_json,
        blocking_reasons_json,created_at,expires_at)
       VALUES ($1,1,$2,$3,$4,7,$5,'CAD',1,$6,$7,1000,0,130,0,1130,'[]','[]','[]',$8,$9)`,
      [id(1), id(2), id(3), id(4), digest("a"), id(5), digest("b"), at, "2026-08-02T16:05:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_quote_line
       (price_quote_line_id,price_quote_id,brand_id,store_id,sellable_id,product_version_id,menu_version_id,
        quantity,currency_code,unit_price_minor,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
        price_book_id,price_book_version_id,price_book_snapshot_digest,price_entry_id,tax_configuration_id,
        tax_configuration_version_id,tax_configuration_snapshot_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,'CAD',1000,1000,0,130,0,1130,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id(6),
        id(1),
        id(2),
        id(3),
        id(7),
        id(8),
        id(9),
        id(10),
        id(11),
        digest("c"),
        id(12),
        id(13),
        id(14),
        digest("d"),
      ],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_quote_tax_line
       (price_quote_tax_line_id,price_quote_id,price_quote_line_id,brand_id,store_id,rule_version_id,
        tax_component_code,tax_classification_id,treatment,rate_decimal,price_inclusion,rounding_mode,
        calculation_order,compound_on_prior_tax,tax_minor,currency_code)
       VALUES ($1,$2,$3,$4,$5,$6,'SYNTHETIC_TAX',$7,'Taxable','0.13','Exclusive','HalfUp',1,false,130,'CAD')`,
      [id(15), id(1), id(6), id(2), id(3), id(16), id(17)],
    );
    const history = async () =>
      (
        await admin.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(q) - 'snapshot_json') FROM rms_pricing.price_quote q) AS quotes,
        (SELECT jsonb_agg(to_jsonb(l)) FROM rms_pricing.price_quote_line l) AS lines,
        (SELECT jsonb_agg(to_jsonb(t)) FROM rms_pricing.price_quote_tax_line t) AS taxes`)
      ).rows;
    const before = await history();
    if (catalog) {
      assert.deepEqual((await applyCatalog(context, catalog)).applied, [
        migrationId,
        snapshotMigrationId,
      ]);
      assert.deepEqual(await history(), before);
      assert.equal(
        (await admin.query(`SELECT snapshot_json FROM rms_pricing.price_quote`)).rows[0]
          .snapshot_json,
        null,
      );
      assert.deepEqual((await applyCatalog(context, catalog)).applied, []);
    }

    // A new immutable quote retains the same Cart line and tax component.
    await admin.query(
      `INSERT INTO rms_pricing.price_quote
      SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote,
        to_jsonb(q) || jsonb_build_object('price_quote_id', $1::text))).*
      FROM rms_pricing.price_quote q WHERE price_quote_id=$2`,
      [id(30), id(1)],
    );
    const copyLine = (quote) =>
      admin.query(
        `INSERT INTO rms_pricing.price_quote_line
      SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote_line,
        to_jsonb(l) || jsonb_build_object('price_quote_id', $1::text))).*
      FROM rms_pricing.price_quote_line l WHERE price_quote_id=$2`,
        [id(quote), id(1)],
      );
    const copyTax = (row, quote, store = 3) =>
      admin.query(
        `INSERT INTO rms_pricing.price_quote_tax_line
      SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote_tax_line,
        to_jsonb(t) || jsonb_build_object('price_quote_tax_line_id', $1::text,
              'price_quote_id', $2::text, 'store_id', $3::text,
              'tax_component_code', $5::text))).*
      FROM rms_pricing.price_quote_tax_line t WHERE price_quote_tax_line_id=$4`,
        [
          id(row),
          id(quote),
          id(store),
          id(15),
          store === 3 ? "SYNTHETIC_TAX" : "SYNTHETIC_FOREIGN",
        ],
      );
    await denied(() => copyTax(31, 30), "23503");
    await copyLine(30);
    await copyTax(31, 30);
    await denied(() => copyLine(30), "23505");
    await denied(() => copyTax(32, 30), "23505");
    await denied(() => copyTax(33, 30, 99), "23503");
    await denied(() => copyLine(99), "23503");
    for (const table of ["price_quote", "price_quote_line", "price_quote_tax_line"]) {
      assert.equal(
        (await admin.query(`UPDATE rms_pricing.${table} SET currency_code='USD'`)).rowCount,
        0,
      );
      assert.equal((await admin.query(`DELETE FROM rms_pricing.${table}`)).rowCount, 0);
      assert.equal(
        (await admin.query(`SELECT count(*)::int AS n FROM rms_pricing.${table}`)).rows[0].n,
        2,
      );
    }
    await admin.query(`UPDATE rms_pricing.price_quote SET total_minor=1 WHERE price_quote_id=$1`, [
      id(1),
    ]);
    assert.equal(
      (
        await admin.query(
          `SELECT total_minor::text FROM rms_pricing.price_quote WHERE price_quote_id=$1`,
          [id(1)],
        )
      ).rows[0].total_minor,
      "1130",
    );
    assert.equal(
      (
        await admin.query(`DELETE FROM rms_pricing.price_quote_line WHERE price_quote_line_id=$1`, [
          id(6),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_pricing.price_quote_tax_line WHERE price_quote_tax_line_id=$1`,
          [id(15)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.price_quote
         (price_quote_id,quote_version,brand_id,store_id,cart_id,cart_version,input_digest,currency_code,
          currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,subtotal_minor,
          discount_minor,tax_minor,fee_minor,total_minor,applied_promotion_references_json,warnings_json,
          blocking_reasons_json,created_at,expires_at)
         VALUES ($1,1,$2,$3,$4,1,$5,'CAD',1,$6,$7,100,0,13,0,1,'[]','[]','[]',$8,$9)`,
        [
          id(20),
          id(2),
          id(3),
          id(21),
          digest("e"),
          id(22),
          digest("f"),
          at,
          "2026-08-02T16:05:00.000Z",
        ],
      ),
      /price_quote_total_check/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_pricing TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(3)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 2);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_line`)).rowCount, 2);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_tax_line`)).rowCount, 2);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 0);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_line`)).rowCount, 0);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_tax_line`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(3)]);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_line`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("permits immutable requote lines on a fresh database without weakening scoped constraints", async () => {
  await withIsolatedDatabase({ caseId: "wp2225_fresh_quote", root }, async (context) => {
    try {
      await prove(context);
    } catch {
      throw new Error("WP2225_FRESH_CONSTRAINTS_FAILED");
    }
  });
}, 120_000);

it("upgrades existing Quote history and permits scoped immutable requote lines", async () => {
  await withIsolatedDatabase({ caseId: "wp2225_quote", root }, async (context) => {
    const admin = new Client(context.clientConfig);
    const databaseName = `bop_rms_test_${context.runId}_wp2225_upgrade`;
    assert.match(databaseName, /^[a-z0-9_]+$/u);
    const upgrade = {
      ...context,
      databaseName,
      clientConfig: { ...context.clientConfig, database: databaseName },
    };
    await admin.connect();
    let phase = "BOOTSTRAP";
    try {
      await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
      const catalog = await readMigrationCatalog(root);
      assert.equal(catalog.diagnostics.length, 0);
      await applyCatalog(upgrade, {
        ...catalog,
        migrations: catalog.migrations.filter(
          (migration) => migration.id !== migrationId && migration.id !== snapshotMigrationId,
        ),
      });
      phase = "UPGRADE_AND_REQUOTE";
      await prove(upgrade, catalog);
    } catch (error) {
      if (error instanceof Error && error.message === "WP2225_MIGRATION_OUT_OF_ORDER") throw error;
      throw controlledFailure(phase);
    } finally {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });
}, 120_000);
