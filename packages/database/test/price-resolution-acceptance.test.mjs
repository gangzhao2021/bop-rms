import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fa000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const digest = (character) => `sha256:${character.repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1102_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.price_book
       (price_book_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'CAD_BASE',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_version
       (price_book_version_id,price_book_id,brand_id,version_number,snapshot_digest,lifecycle,currency_code,
        currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at)
       VALUES ($1,$2,$3,1,$4,'Published','CAD',1,$5,$6,$7)`,
      [id(4), id(1), id(2), digest("a"), id(5), digest("b"), at],
    );
    await admin.query(
      `UPDATE rms_pricing.price_book SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE price_book_id=$3`,
      [id(4), "2026-08-02T16:01:00.000Z", id(1)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_entry
       (price_entry_id,price_book_version_id,price_book_id,brand_id,sellable_id,scope_kind,scope_id,
        channel_code,order_type,amount_minor,currency_code,effective_from,effective_time_zone,reason_code)
       VALUES ($1,$2,$3,$4,$5,'Brand',NULL,NULL,NULL,1299,'CAD',$6,'America/Toronto','SYNTHETIC_BASE'),
              ($7,$2,$3,$4,$5,'Store',$8,'CUSTOMER_WEB','Pickup',1399,'CAD',$6,'America/Toronto','SYNTHETIC_STORE')`,
      [id(6), id(4), id(1), id(2), id(7), at, id(8), id(9)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_operation_record
       (operation_id,price_book_id,brand_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at)
       VALUES ($1,$2,$3,'Publish',$4,2,$5,$6)`,
      [id(10), id(1), id(2), digest("c"), id(4), at],
    );

    await admin.query(
      `UPDATE rms_pricing.price_entry SET amount_minor=999 WHERE price_entry_id=$1`,
      [id(6)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT amount_minor::text FROM rms_pricing.price_entry WHERE price_entry_id=$1`,
          [id(6)],
        )
      ).rows[0].amount_minor,
      "1299",
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_pricing.price_book_version WHERE price_book_version_id=$1`,
          [id(4)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_pricing.price_book_operation_record WHERE operation_id=$1`,
          [id(10)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.price_entry
         (price_entry_id,price_book_version_id,price_book_id,brand_id,sellable_id,scope_kind,amount_minor,currency_code,effective_from,effective_time_zone,reason_code)
         VALUES ($1,$2,$3,$4,$5,'Store',100,'CAD',$6,'America/Toronto','INVALID')`,
        [id(11), id(4), id(1), id(2), id(7), at],
      ),
      /price_entry_scope_check/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing, platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_pricing TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_book`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_book`)).rowCount, 1);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_entry`)).rowCount, 2);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_book`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("pins Price Book versions, immutable entries and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "price_resolution", root }, prove);
}, 120_000);
