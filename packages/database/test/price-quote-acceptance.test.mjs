import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fd000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const digest = (c) => `sha256:${c.repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1103_${context.runId}`;
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
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 1);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_line`)).rowCount, 1);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote_tax_line`)).rowCount, 1);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.price_quote`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("pins immutable Quote snapshots and exact Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "price_quote", root }, prove);
}, 120_000);

it("reads complete historical Quote evidence with exact Store isolation and no legacy reconstruction", async () => {
  const { createPriceQuote, encodePriceQuoteSnapshot, createPostgresPriceQuoteHistoryReader } =
    await import("../../rms/pricing/src/index.ts");
  const { input } = await import("../../rms/pricing/src/tests/price-quote.fixture.ts");
  await withIsolatedDatabase({ caseId: "wp2256_quote_history", root }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2256_${context.runId}`;
    assert.match(role, /^wp2256_[a-f0-9]+$/u);
    await admin.connect();
    let active = 0;
    try {
      const source = input();
      const entry = source.priceBook.entries[0];
      assert.ok(entry);
      const quote = createPriceQuote({
        ...source,
        priceBook: {
          ...source.priceBook,
          entries: [{ ...entry, amount: { ...entry.amount, amountMinor: 9007199254740993n } }],
        },
      });
      const encoded = encodePriceQuoteSnapshot(quote);
      async function insert(value, text) {
        await admin.query(
          `INSERT INTO rms_pricing.price_quote
          (price_quote_id,quote_version,brand_id,store_id,cart_id,cart_version,input_digest,currency_code,
           currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,subtotal_minor,
           discount_minor,tax_minor,fee_minor,total_minor,applied_promotion_references_json,warnings_json,
           blocking_reasons_json,created_at,expires_at,complete_snapshot_text)
          VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21)`,
          [
            value.quoteReference,
            value.brandReference,
            value.storeReference,
            value.cartReference,
            value.cartVersion,
            value.inputDigest,
            value.currencyMetadata.currencyCode,
            value.currencyMetadata.metadataVersion,
            value.currencyMetadata.metadataVersionReference,
            value.currencyMetadata.metadataDigest,
            value.subtotal.amountMinor.toString(),
            value.discount.amountMinor.toString(),
            value.tax.amountMinor.toString(),
            value.fee.amountMinor.toString(),
            value.total.amountMinor.toString(),
            JSON.stringify(value.appliedPromotionReferences),
            JSON.stringify(value.warnings),
            JSON.stringify(value.blockingReasons),
            value.createdAt,
            value.expiresAt,
            text,
          ],
        );
      }
      await insert(quote, encoded);
      const legacy = { ...quote, quoteReference: id(100) };
      await insert(legacy, null);
      const mismatched = { ...quote, quoteReference: id(101) };
      await insert(
        { ...mismatched, cartVersion: mismatched.cartVersion + 1 },
        encodePriceQuoteSnapshot(mismatched),
      );
      const fractional = { ...quote, quoteReference: id(102) };
      await insert(
        { ...fractional, createdAt: fractional.createdAt.replace(".000Z", ".000001Z") },
        encodePriceQuoteSnapshot(fractional),
      );
      for (const text of [
        "{}",
        '{"codecVersion":2,"snapshot":{}}',
        '{"codecVersion":1,"snapshot":null}',
        "[]",
      ]) {
        await assert.rejects(
          insert({ ...quote, quoteReference: id(200) }, text),
          /price_quote_complete_snapshot_check/u,
        );
      }
      await assert.rejects(
        insert({ ...quote, quoteReference: id(200) }, "not JSON"),
        /invalid input syntax for type json/u,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_pricing.price_quote SET complete_snapshot_text=$1 WHERE price_quote_id=$2",
            [encoded, legacy.quoteReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_pricing.price_quote SET complete_snapshot_text=NULL WHERE price_quote_id=$1",
            [quote.quoteReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query("DELETE FROM rms_pricing.price_quote WHERE price_quote_id=$1", [
            quote.quoteReference,
          ])
        ).rowCount,
        0,
      );
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(`GRANT SELECT ON rms_pricing.price_quote TO ${role}`);
      const runner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          active++;
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${role}`);
            const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
            active--;
          }
        },
      };
      const scope = { brandReference: quote.brandReference, storeReference: quote.storeReference };
      const reader = createPostgresPriceQuoteHistoryReader(runner, scope);
      const result = await reader.load(quote.quoteReference);
      assert.deepEqual(result, quote);
      assert.equal(result.lines[0].unitPrice.amountMinor, 9007199254740993n);
      assert.equal(result.expiresAt, source.expiresAt);
      assert.ok(Object.isFrozen(result.lines[0].taxLines[0].explanation));
      assert.equal(await reader.load(id(999)), null);
      for (const candidate of [legacy, mismatched, fractional]) {
        await assert.rejects(reader.load(candidate.quoteReference), {
          code: "QUOTE_HISTORY_UNAVAILABLE",
          message: "price quote history is unavailable",
        });
      }
      for (const foreign of [
        { ...scope, storeReference: id(998) },
        { ...scope, brandReference: id(997) },
      ]) {
        assert.equal(
          await createPostgresPriceQuoteHistoryReader(runner, foreign).load(quote.quoteReference),
          null,
        );
      }
      assert.equal(active, 0);
      const stored = (
        await admin.query(
          "SELECT complete_snapshot_text FROM rms_pricing.price_quote WHERE price_quote_id=$1",
          [quote.quoteReference],
        )
      ).rows[0];
      assert.equal(stored.complete_snapshot_text, encoded);
      assert.equal(
        (
          await admin.query(
            "SELECT complete_snapshot_text FROM rms_pricing.price_quote WHERE price_quote_id=$1",
            [legacy.quoteReference],
          )
        ).rows[0].complete_snapshot_text,
        null,
      );
    } finally {
      assert.equal(active, 0);
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
}, 120_000);
