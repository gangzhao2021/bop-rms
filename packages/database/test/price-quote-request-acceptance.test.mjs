import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPriceQuote,
  createPostgresPriceQuoteRequestStore,
  createPostgresPriceQuoteHistoryReader,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
it("commits one original Quote per scoped request and rolls back all facts when request history fails", async () => {
  await withIsolatedDatabase({ caseId: "wp2258_quote_request" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2258_${context.runId}`;
    assert.match(role, /^wp2258_[a-f0-9]+$/u);
    let active = 0;
    let next = 1000;
    const failures = [];
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
        `GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,rms_pricing.price_quote_request,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      const source = input();
      const first = createPriceQuote(source);
      const second = createPriceQuote({ ...source, quoteReference: id(800) });
      const scope = { brandReference: first.brandReference, storeReference: first.storeReference };
      const observedAt = "2026-08-02T16:00:01.000Z";
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
                  failures.push(/^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : "unknown");
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
      const references = {
        generateReference: () => id(next++),
        hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
        equals: (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
      };
      const store = createPostgresPriceQuoteRequestStore(runner, scope, references);
      const history = createPostgresPriceQuoteHistoryReader(runner, scope);
      const lookup = {
        operationReference: id(1),
        guestSessionReference: id(2),
        cartReference: first.cartReference,
        cartVersion: first.cartVersion,
        observedAt,
      };
      function audit(quote, n) {
        return {
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
        };
      }
      function request(quote, n, operationReference = lookup.operationReference) {
        return {
          operationReference,
          guestSessionReference: lookup.guestSessionReference,
          observedAt,
          quote,
          audit: audit(quote, n),
        };
      }
      async function counts() {
        return (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_pricing.price_quote) AS quotes,
        (SELECT count(*)::integer FROM rms_pricing.price_quote_line) AS lines,
        (SELECT count(*)::integer FROM rms_pricing.price_quote_tax_line) AS taxes,
        (SELECT count(*)::integer FROM rms_pricing.price_quote_request) AS requests,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      }
      assert.equal(await store.resolve(lookup), null);
      const settled = await Promise.allSettled([
        store.append(request(first, 700)),
        store.append(request(second, 701)),
      ]);
      assert.ok(
        settled.every((r) => r.status === "fulfilled"),
        JSON.stringify(failures),
      );
      const results = settled.map((r) => r.value);
      assert.deepEqual(results[0], results[1]);
      const original = results[0];
      assert.ok(
        [first.quoteReference, second.quoteReference].includes(original.quote.quoteReference),
      );
      assert.equal(original.record.quoteOutcome, "Created");
      assert.deepEqual(await counts(), { quotes: 1, lines: 1, taxes: 1, requests: 1, audits: 1 });
      const loser = original.quote.quoteReference === first.quoteReference ? second : first;
      assert.equal(await history.load(loser.quoteReference), null);
      const allocated = next;
      const later = { ...lookup, observedAt: "2026-08-02T18:00:00.000Z" };
      assert.deepEqual(await store.resolve(later), original);
      assert.deepEqual(
        await store.append({ ...request(loser, 702), observedAt: later.observedAt }),
        original,
      );
      assert.equal(next, allocated);
      assert.equal(original.quote.expiresAt, first.expiresAt);
      for (const changed of [
        { guestSessionReference: id(9) },
        { cartReference: id(9) },
        { cartVersion: 99 },
        { observedAt: "2026-08-03T16:00:01.000Z" },
      ]) {
        await assert.rejects(store.resolve({ ...lookup, ...changed }), {
          code: "QUOTE_REQUEST_CONFLICT",
        });
      }
      assert.equal(
        await createPostgresPriceQuoteRequestStore(
          runner,
          { ...scope, storeReference: id(9) },
          references,
        ).resolve(lookup),
        null,
      );
      assert.equal(
        await createPostgresPriceQuoteRequestStore(
          runner,
          { ...scope, brandReference: id(9) },
          references,
        ).resolve(lookup),
        null,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_pricing.price_quote_request SET quote_id=$1 WHERE operation_id=$2",
            [loser.quoteReference, lookup.operationReference],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query("DELETE FROM rms_pricing.price_quote_request WHERE operation_id=$1", [
            lookup.operationReference,
          ])
        ).rowCount,
        0,
      );
      const third = createPriceQuote({ ...source, quoteReference: id(801) });
      const thirdRequest = request(third, 703, id(3));
      const headSql =
        "SELECT next_sequence::text,encode(last_record_hash,'hex') AS hash FROM platform_audit.audit_chain_head";
      const head = (await admin.query(headSql)).rows;
      await admin.query(`REVOKE INSERT ON rms_pricing.price_quote_request FROM ${role}`);
      await assert.rejects(store.append(thirdRequest), {
        code: "QUOTE_REQUEST_UNAVAILABLE",
        message: "price quote request is unavailable",
      });
      assert.deepEqual(await counts(), { quotes: 1, lines: 1, taxes: 1, requests: 1, audits: 1 });
      assert.deepEqual((await admin.query(headSql)).rows, head);
      assert.equal(await history.load(third.quoteReference), null);
      await admin.query(`GRANT INSERT ON rms_pricing.price_quote_request TO ${role}`);
      assert.equal((await store.append(thirdRequest)).quote.quoteReference, third.quoteReference);
      const current = await store.append(request(original.quote, 704, id(4)));
      assert.equal(current.record.quoteOutcome, "Existing");
      assert.deepEqual(await counts(), { quotes: 2, lines: 2, taxes: 2, requests: 3, audits: 2 });
      await admin.query(`SET ROLE ${role}`);
      assert.equal(
        (await admin.query("SELECT * FROM rms_pricing.price_quote_request")).rowCount,
        0,
      );
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [scope.brandReference, scope.storeReference],
      );
      assert.equal(
        (await admin.query("SELECT * FROM rms_pricing.price_quote_request")).rowCount,
        3,
      );
      await admin.query("SELECT set_config('bop.store_id',$1,false)", [id(999)]);
      assert.equal(
        (await admin.query("SELECT * FROM rms_pricing.price_quote_request")).rowCount,
        0,
      );
      await admin.query("RESET ROLE");
      assert.equal(active, 0);
    } finally {
      try {
        assert.equal(active, 0);
        await admin.query("RESET ROLE");
        await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      } finally {
        await admin.end();
      }
    }
  });
}, 120_000);
