import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  allocateOrdinaryRefundFromQuote,
  createConfiguredPriceQuote,
  createPostgresConfiguredPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteStore,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT (coordinator 2026-10-30, Owner authorized): a quote's tax is
 * charged per tax type on the whole quote and allocated to its lines by largest remainder. TEST:
 * three $1.05 dishes at 13% are charged 41¢ tax (each line rounded alone would be 42¢). Stored and
 * read back through the real Pricing owner store as a restricted role; a refund of one dish returns
 * exactly its allocated tax; a quote recorded under the earlier per-line rule reads and refunds
 * exactly as recorded.
 */
it("charges one rounding of tax per quote, refunds its allocation, and keeps earlier quotes as recorded", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_quote_tax" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_qtax_" + context.runId;
    const readRole = "wp2423_qtax_read_" + context.runId;
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
      await admin.query("CREATE ROLE " + readRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + readRole);
      await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + readRole);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          readRole,
      );
      const base = input();
      const line = base.lines[0];
      assert.ok(line);
      const threeAtOneOhFive = (quoteReference) => ({
        base: {
          ...base,
          quoteReference,
          priceBook: {
            ...base.priceBook,
            entries: base.priceBook.entries.map((entry) => ({
              ...entry,
              amount: { ...entry.amount, amountMinor: 105n },
            })),
          },
          lines: [70, 71, 72].map((n) => ({ ...line, lineReference: id(n), quantity: 1 })),
        },
        options: [],
      });
      const scope = { brandReference: base.brandReference, storeReference: base.storeReference };
      const runner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            const result = await action({
              query: (sql, values) => client.query(sql, [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const historyRunner = {
        run: (work) =>
          runner.run(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY", []);
            await tx.query("SET LOCAL ROLE " + readRole, []);
            return work(tx);
          }),
      };
      const store = createPostgresConfiguredPriceQuoteStore(runner, scope, {
        generateReference: () => id(next++),
      });
      const reader = createPostgresConfiguredPriceQuoteHistoryReader(historyRunner, scope);
      const audit = (quote, n) => ({
        auditId: id(n),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PRICING_QUOTE_CREATE",
        targetType: "PricingPriceQuote",
        targetId: quote.quoteReference,
        reasonCode: "AUTHORIZED_CART_QUOTE",
        correlationId: id(n + 100),
        occurredAt: quote.createdAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "SYNTHETIC_RETENTION",
        retentionPolicyVersion: 1,
      });
      const stored = async (quoteReference) =>
        (
          await admin.query(
            "SELECT q.tax_minor::text tax,(SELECT array_agg(l.tax_minor::text ORDER BY l.price_quote_line_id) FROM rms_pricing.price_quote_line l WHERE l.price_quote_id=q.price_quote_id) lines FROM rms_pricing.price_quote q WHERE q.price_quote_id=$1",
            [quoteReference],
          )
        ).rows[0];
      const refundOf = (quote, lineIndex) =>
        allocateOrdinaryRefundFromQuote(quote, {
          tipAmountMinor: 0n,
          items: quote.lines.map((entry, index) => ({
            orderItemReference: id(500 + index),
            quoteLineReference: entry.lineReference,
            quantity: entry.quantity,
            occupiedUnitOrdinals: [],
            refundQuantity: index === lineIndex ? 1 : 0,
          })),
        });

      // A new quote: 41¢ tax, allocated 14¢ + 14¢ + 13¢ (stored by the owner as the API role).
      const quote = createConfiguredPriceQuote(threeAtOneOhFive(id(30000)));
      assert.equal((await store.append({ quote, audit: audit(quote, 32000) })).status, "Created");
      const read = await reader.load(quote.quoteReference);
      assert.deepEqual(read, quote);
      assert.equal(read.subtotal.amountMinor, 315n);
      assert.equal(read.tax.amountMinor, 41n);
      assert.equal(read.total.amountMinor, 356n);
      assert.deepEqual(await stored(quote.quoteReference), {
        tax: "41",
        lines: ["14", "14", "13"],
      });
      // Refunding one dish returns exactly the tax allocated to it.
      const refund = refundOf(read, 2);
      assert.equal(
        JSON.stringify(refund, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(
          '"taxAmountMinor":"13"',
        ),
        true,
        JSON.stringify(refund, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );

      // A quote recorded under the earlier rule (each line rounded alone) stays exactly as recorded.
      const legacy = globalThis.structuredClone(
        createConfiguredPriceQuote(threeAtOneOhFive(id(30001))),
      );
      for (const entry of legacy.lines) {
        entry.taxLines[0].taxAmount = { ...entry.taxLines[0].taxAmount, amountMinor: 14n };
        entry.tax = { ...entry.tax, amountMinor: 14n };
        entry.total = { ...entry.total, amountMinor: entry.subtotal.amountMinor + 14n };
      }
      legacy.tax = { ...legacy.tax, amountMinor: 42n };
      legacy.total = { ...legacy.total, amountMinor: 357n };
      assert.equal(
        (await store.append({ quote: legacy, audit: audit(legacy, 32100) })).status,
        "Created",
      );
      const legacyRead = await reader.load(legacy.quoteReference);
      assert.equal(legacyRead.tax.amountMinor, 42n);
      assert.deepEqual(await stored(legacy.quoteReference), {
        tax: "42",
        lines: ["14", "14", "14"],
      });
      const legacyRefund = refundOf(legacyRead, 2);
      assert.equal(
        JSON.stringify(legacyRefund, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ).includes('"taxAmountMinor":"14"'),
        true,
      );
    } finally {
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.query(`DROP OWNED BY ${readRole}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${readRole}`).catch(() => undefined);
      await admin.end();
    }
  });
});
