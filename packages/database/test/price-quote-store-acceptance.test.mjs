import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPriceQuote,
  createPostgresPriceQuoteStore,
  createPostgresPriceQuoteHistoryReader,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

it("atomically appends complete Quote facts and Audit with concurrent replay and rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2257_quote_store" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2257_${context.runId}`;
    assert.match(role, /^wp2257_[a-f0-9]+$/u);
    const failures = [];
    let active = 0;
    let next = 1000;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_pricing,platform_helpers,platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      const source = input();
      const first = source.priceBook.entries[0];
      assert.ok(first);
      const firstRule = source.taxConfiguration.rules[0];
      assert.ok(firstRule);
      const largeInput = {
        ...source,
        taxConfiguration: {
          ...source.taxConfiguration,
          rules: [
            firstRule,
            {
              ...firstRule,
              ruleReference: id(950),
              taxComponentCode: "SYNTHETIC_SECOND",
              rate: "0.05",
              calculationOrder: 2,
              compoundOnPriorTax: true,
            },
          ],
        },
        priceBook: {
          ...source.priceBook,
          entries: [{ ...first, amount: { ...first.amount, amountMinor: 9007199254740993n } }],
        },
      };
      const quote = createPriceQuote(largeInput);
      const scope = { brandReference: quote.brandReference, storeReference: quote.storeReference };
      const runner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          active++;
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            const result = await action({
              query: async (sql, values) => {
                try {
                  return await client.query(sql, [...values]);
                } catch (error) {
                  failures.push({
                    stage: sql.startsWith("INSERT INTO rms_pricing.price_quote\n")
                      ? "root"
                      : "query",
                    code: /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : "unknown",
                  });
                  throw error;
                }
              },
            });
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
      const references = { generateReference: () => id(next++) };
      const store = createPostgresPriceQuoteStore(runner, scope, references);
      const reader = createPostgresPriceQuoteHistoryReader(runner, scope);
      function audit(value, n) {
        return {
          auditId: id(n),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PRICING_QUOTE_CREATE",
          targetType: "PricingPriceQuote",
          targetId: value.quoteReference,
          reasonCode: "AUTHORIZED_CART_QUOTE",
          correlationId: id(n + 100),
          occurredAt: value.createdAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        };
      }
      async function counts() {
        return (
          await admin.query(`SELECT
          (SELECT count(*)::integer FROM rms_pricing.price_quote) AS quotes,
          (SELECT count(*)::integer FROM rms_pricing.price_quote_line) AS lines,
          (SELECT count(*)::integer FROM rms_pricing.price_quote_tax_line) AS taxes,
          (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      }
      const request = { quote, audit: audit(quote, 700) };
      const outcomes = await Promise.allSettled([store.append(request), store.append(request)]);
      assert.ok(
        outcomes.every((result) => result.status === "fulfilled"),
        JSON.stringify(failures),
      );
      const results = outcomes.map((result) => result.value);
      assert.deepEqual(results.map((result) => result.status).sort(), ["Created", "Existing"]);
      assert.deepEqual(results[0].quote, quote);
      assert.deepEqual(results[1].quote, quote);
      assert.deepEqual(await counts(), { quotes: 1, lines: 1, taxes: 2, audits: 1 });
      assert.deepEqual(await reader.load(quote.quoteReference), quote);
      const storedTaxes = (
        await admin.query(
          `SELECT t.rule_version_id,t.tax_component_code,t.tax_classification_id,
        t.treatment,t.rate_decimal,t.price_inclusion,t.rounding_mode,t.calculation_order,t.compound_on_prior_tax,
        t.tax_minor::text,t.currency_code,l.source_cart_line_id FROM rms_pricing.price_quote_tax_line t
        JOIN rms_pricing.price_quote_line l ON l.price_quote_line_id=t.price_quote_line_id
        WHERE t.price_quote_id=$1 ORDER BY t.calculation_order`,
          [quote.quoteReference],
        )
      ).rows;
      assert.deepEqual(
        storedTaxes,
        quote.lines[0].taxLines.map((line) => ({
          rule_version_id: line.ruleReference,
          tax_component_code: line.explanation.taxComponentCode,
          tax_classification_id: line.explanation.taxClassificationReference,
          treatment: line.explanation.treatment,
          rate_decimal: line.explanation.rate,
          price_inclusion: line.explanation.priceInclusion,
          rounding_mode: line.explanation.roundingMode,
          calculation_order: line.calculationOrder,
          compound_on_prior_tax: line.compoundOnPriorTax,
          tax_minor: line.taxAmount.amountMinor.toString(),
          currency_code: line.taxAmount.currencyCode,
          source_cart_line_id: quote.lines[0].lineReference,
        })),
      );
      const allocated = next;
      assert.equal((await store.append(request)).status, "Existing");
      assert.equal(next, allocated);
      const conflict = createPriceQuote({ ...largeInput, cartVersion: quote.cartVersion + 1 });
      await assert.rejects(store.append({ quote: conflict, audit: audit(conflict, 701) }), {
        code: "QUOTE_SNAPSHOT_CONFLICT",
      });
      assert.deepEqual(await counts(), { quotes: 1, lines: 1, taxes: 2, audits: 1 });

      const second = createPriceQuote({ ...largeInput, quoteReference: id(800) });
      assert.equal(
        (await store.append({ quote: second, audit: audit(second, 702) })).status,
        "Created",
      );
      const mapping = (
        await admin.query(
          `SELECT price_quote_line_id,source_cart_line_id,unit_price_minor::text FROM rms_pricing.price_quote_line ORDER BY price_quote_line_id`,
        )
      ).rows;
      assert.equal(mapping.length, 2);
      assert.notEqual(mapping[0].price_quote_line_id, mapping[1].price_quote_line_id);
      for (const line of mapping) {
        assert.equal(line.source_cart_line_id, quote.lines[0].lineReference);
        assert.notEqual(line.price_quote_line_id, line.source_cart_line_id);
        assert.equal(line.unit_price_minor, "9007199254740993");
      }
      await assert.rejects(
        admin.query(
          `INSERT INTO rms_pricing.price_quote_line
        SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote_line,
          to_jsonb(l)||jsonb_build_object('price_quote_line_id',$1::text))).*
        FROM rms_pricing.price_quote_line l WHERE l.price_quote_line_id=$2`,
          [id(990), mapping[0].price_quote_line_id],
        ),
        /price_quote_line_source_unique/u,
      );
      const third = createPriceQuote({ ...largeInput, quoteReference: id(801) });
      const thirdRequest = { quote: third, audit: audit(third, 703) };
      await admin.query(`REVOKE INSERT ON rms_pricing.price_quote_tax_line FROM ${role}`);
      await assert.rejects(store.append(thirdRequest), {
        code: "QUOTE_WRITE_UNAVAILABLE",
        message: "price quote could not be saved",
      });
      assert.equal(await reader.load(third.quoteReference), null);
      assert.deepEqual(await counts(), { quotes: 2, lines: 2, taxes: 4, audits: 2 });
      await admin.query(`GRANT INSERT ON rms_pricing.price_quote_tax_line TO ${role}`);
      const headSql =
        "SELECT next_sequence::text,encode(last_record_hash,'hex') AS hash FROM platform_audit.audit_chain_head";
      const beforeHead = (await admin.query(headSql)).rows;
      await admin.query(`REVOKE INSERT ON platform_audit.audit_record FROM ${role}`);
      await assert.rejects(store.append(thirdRequest), {
        code: "QUOTE_WRITE_UNAVAILABLE",
        message: "price quote could not be saved",
      });
      assert.deepEqual((await admin.query(headSql)).rows, beforeHead);
      assert.equal(await reader.load(third.quoteReference), null);
      assert.deepEqual(await counts(), { quotes: 2, lines: 2, taxes: 4, audits: 2 });
      await admin.query(`GRANT INSERT ON platform_audit.audit_record TO ${role}`);
      assert.equal((await store.append(thirdRequest)).status, "Created");
      assert.deepEqual(await counts(), { quotes: 3, lines: 3, taxes: 6, audits: 3 });
      assert.equal((await admin.query(headSql)).rows[0].next_sequence, "4");
      const foreign = createPostgresPriceQuoteStore(
        runner,
        { ...scope, storeReference: id(999) },
        references,
      );
      await assert.rejects(foreign.append(request), { code: "QUOTE_WRITE_UNAVAILABLE" });
      await assert.rejects(
        foreign.append({
          quote: { ...quote, storeReference: id(999) },
          audit: { ...audit(quote, 704), storeId: id(999) },
        }),
        { code: "QUOTE_WRITE_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(), { quotes: 3, lines: 3, taxes: 6, audits: 3 });
      assert.equal(
        await createPostgresPriceQuoteHistoryReader(runner, {
          ...scope,
          brandReference: id(998),
        }).load(quote.quoteReference),
        null,
      );
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
}, 120_000);
