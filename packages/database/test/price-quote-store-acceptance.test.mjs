import { createOrderPricingSource } from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPriceQuote,
  createConfiguredPriceQuote,
  createPostgresConfiguredPriceQuoteStore,
  createPostgresConfiguredPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteRequestStore,
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
    const readRole = "wp2402_quote_read_" + context.runId;
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
      await admin.query("CREATE ROLE " + readRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + readRole);
      await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + readRole);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          readRole,
      );
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
      const historyRunner = {
        run: (work) =>
          runner.run(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY", []);
            await tx.query("SET LOCAL ROLE " + readRole, []);
            return work(tx);
          }),
      };
      const currentAt = new Date(Date.parse(quote.createdAt) + 30_000).toISOString();
      const baseEvidence = orderWriteFixture({ at: currentAt }).request.checkoutValidationEvidence;
      const binding = {
        ...scope,
        cartReference: quote.cartReference,
        cartVersion: quote.cartVersion,
        quoteReference: quote.quoteReference,
      };
      const evidence = {
        ...baseEvidence,
        ...binding,
        quoteVersion: quote.quoteVersion,
        quoteInputDigest: quote.inputDigest,
        validatedAt: currentAt,
        validUntil: quote.expiresAt,
        catalogLines: quote.lines.map((line) => ({
          cartItemReference: line.lineReference,
          sellableReference: line.sellableReference,
          productVersionReference: line.productVersionReference,
          menuVersionReference: line.menuVersionReference,
          validatedAt: currentAt,
        })),
        fulfillment: {
          ...baseEvidence.fulfillment,
          ...binding,
          checkedAt: currentAt,
          validUntil: quote.expiresAt,
        },
      };
      let currentTime = currentAt;
      const orderPricing = createOrderPricingSource({
        scope,
        history: createPostgresPriceQuoteHistoryReader(historyRunner, scope),
        clock: { now: () => currentTime },
      });
      const priceLines = await orderPricing.load({ evidence });
      assert.equal(priceLines[0].unitPrice.amountMinor, 9007199254740993n);
      assert.deepEqual(priceLines[0].total, quote.lines[0].total);
      assert.equal(priceLines[0].taxComponents.length, 2);
      assert.deepEqual(
        priceLines[0].taxComponents.map((part) => ({
          taxAmount: part.taxAmount,
          compound: part.compoundOnPriorTax,
          order: part.calculationOrder,
        })),
        quote.lines[0].taxLines.map((part) => ({
          taxAmount: part.taxAmount,
          compound: part.compoundOnPriorTax,
          order: part.calculationOrder,
        })),
      );
      await assert.rejects(
        orderPricing.load({
          evidence: { ...evidence, quoteInputDigest: "sha256:" + "f".repeat(64) },
        }),
        { code: "ORDER_PRICING_SOURCE_UNAVAILABLE" },
      );
      await assert.rejects(
        createOrderPricingSource({
          scope,
          history: createPostgresPriceQuoteHistoryReader(historyRunner, {
            ...scope,
            storeReference: id(997),
          }),
          clock: { now: () => currentTime },
        }).load({ evidence }),
        { code: "ORDER_PRICING_SOURCE_UNAVAILABLE" },
      );
      currentTime = quote.expiresAt;
      await assert.rejects(orderPricing.load({ evidence }), {
        code: "ORDER_PRICING_SOURCE_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { quotes: 1, lines: 1, taxes: 2, audits: 1 });
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
      const configuredInput = (quoteReference) => ({
        base: { ...largeInput, quoteReference },
        options: [
          {
            lineReference: source.lines[0].lineReference,
            bindingReference: id(31001),
            optionReference: id(31002),
            selectedQuantity: 3,
            taxBasis: "ParentSellable",
            taxClassificationReference: source.lines[0].taxContext.taxClassificationReference,
            rules: [
              {
                ruleReference: id(31003),
                versionReference: id(31004),
                snapshotDigest: source.inputDigest,
                brandReference: source.brandReference,
                bindingReference: id(31001),
                optionReference: id(31002),
                skuReference: source.lines[0].sellableReference,
                scopeKind: "Brand",
                scopeReference: null,
                channelCode: null,
                orderType: null,
                lifecycle: "Published",
                currencyMetadata: source.currencyMetadata,
                unitAmount: {
                  amountMinor: 125n,
                  currencyCode: source.currencyMetadata.currencyCode,
                },
                includedQuantity: 1,
                quantityBasis: "PerItemChoice",
                effectivePeriod: first.effectivePeriod,
                createdAt: source.createdAt,
              },
            ],
          },
        ],
      });
      const configured = createConfiguredPriceQuote(configuredInput(id(30000)));
      const configuredStore = createPostgresConfiguredPriceQuoteStore(runner, scope, references);
      const configuredReader = createPostgresConfiguredPriceQuoteHistoryReader(
        historyRunner,
        scope,
      );
      const configuredRequest = { quote: configured, audit: audit(configured, 32000) };
      const savedConfigured = await Promise.all([
        configuredStore.append(configuredRequest),
        configuredStore.append(configuredRequest),
      ]);
      assert.deepEqual(savedConfigured.map((r) => r.status).sort(), ["Created", "Existing"]);
      assert.deepEqual(await configuredReader.load(configured.quoteReference), configured);
      assert.equal(configured.lines[0].unitPrice.amountMinor, 9007199254741243n);
      assert.equal(configured.lines[0].optionPrices[0].amount.amountMinor, 500n);
      assert.deepEqual(await counts(), { quotes: 4, lines: 4, taxes: 8, audits: 4 });
      await assert.rejects(reader.load(configured.quoteReference), {
        code: "QUOTE_HISTORY_UNAVAILABLE",
      });
      assert.equal(
        await createPostgresConfiguredPriceQuoteHistoryReader(historyRunner, {
          ...scope,
          storeReference: id(33000),
        }).load(configured.quoteReference),
        null,
      );
      for (const patch of [
        { price_quote_id: id(33001), complete_snapshot_text: null },
        {
          price_quote_id: id(33002),
          complete_snapshot_text: JSON.stringify({ codecVersion: 1, snapshot: {} }),
        },
      ]) {
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_pricing.price_quote SELECT (jsonb_populate_record(NULL::rms_pricing.price_quote,to_jsonb(q)||$2::jsonb)).* FROM rms_pricing.price_quote q WHERE q.price_quote_id=$1",
            [configured.quoteReference, JSON.stringify(patch)],
          ),
          /price_quote_complete_snapshot_check/u,
        );
      }
      const lostQuote = createConfiguredPriceQuote(configuredInput(id(30001)));
      let lostAck = false;
      const lostRunner = {
        async run(work) {
          let wrote = false;
          const result = await runner.run((tx) =>
            work({
              query: async (sql, values) => {
                const result = await tx.query(sql, values);
                if (sql.startsWith("INSERT INTO rms_pricing.price_quote\n")) wrote = true;
                return result;
              },
            }),
          );
          if (wrote && !lostAck) {
            lostAck = true;
            throw new Error("synthetic configured Quote commit response loss");
          }
          return result;
        },
      };
      const recoveringStore = createPostgresConfiguredPriceQuoteStore(
        lostRunner,
        scope,
        references,
      );
      const lostRequest = { quote: lostQuote, audit: audit(lostQuote, 32001) };
      await assert.rejects(recoveringStore.append(lostRequest), {
        code: "QUOTE_WRITE_UNAVAILABLE",
      });
      assert.equal(lostAck, true);
      assert.deepEqual(await recoveringStore.append(lostRequest), {
        status: "Existing",
        quote: lostQuote,
      });
      assert.deepEqual(await counts(), { quotes: 5, lines: 5, taxes: 10, audits: 5 });
      const rollbackQuote = createConfiguredPriceQuote(configuredInput(id(30002)));
      await admin.query("REVOKE INSERT ON platform_audit.audit_record FROM " + role);
      await assert.rejects(
        configuredStore.append({
          quote: rollbackQuote,
          audit: audit(rollbackQuote, 32002),
        }),
        { code: "QUOTE_WRITE_UNAVAILABLE" },
      );
      await admin.query("GRANT INSERT ON platform_audit.audit_record TO " + role);
      assert.equal(await configuredReader.load(rollbackQuote.quoteReference), null);
      assert.deepEqual(await counts(), { quotes: 5, lines: 5, taxes: 10, audits: 5 });
      await admin.query("GRANT SELECT,INSERT ON rms_pricing.price_quote_request TO " + role);
      const requestReferences = {
        ...references,
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (left, right) => left === right,
      };
      let requestLostAck = false;
      const requestRunner = {
        async run(work) {
          let wrote = false;
          const result = await runner.run((tx) =>
            work({
              query: async (sql, values) => {
                const result = await tx.query(sql, values);
                if (sql.startsWith("INSERT INTO rms_pricing.price_quote_request")) wrote = true;
                return result;
              },
            }),
          );
          if (wrote && !requestLostAck) {
            requestLostAck = true;
            throw new Error("synthetic configured request commit response loss");
          }
          return result;
        },
      };
      const requests = createPostgresConfiguredPriceQuoteRequestStore(
        requestRunner,
        scope,
        requestReferences,
      );
      const requestQuote = createConfiguredPriceQuote(configuredInput(id(30003)));
      const requestInput = {
        operationReference: id(34000),
        guestSessionReference: id(34001),
        observedAt: requestQuote.createdAt,
        quote: requestQuote,
        audit: audit(requestQuote, 32003),
      };
      await assert.rejects(requests.append(requestInput), { code: "QUOTE_REQUEST_UNAVAILABLE" });
      assert.equal(requestLostAck, true);
      const anotherCandidate = createConfiguredPriceQuote(configuredInput(id(30004)));
      const recoveredRequest = await requests.append({
        ...requestInput,
        quote: anotherCandidate,
        audit: audit(anotherCandidate, 32004),
      });
      assert.deepEqual(recoveredRequest.quote, requestQuote);
      assert.equal(recoveredRequest.record.createdAt, requestQuote.createdAt);
      assert.equal(
        recoveredRequest.record.idempotencyExpiresAt,
        new Date(Date.parse(requestQuote.createdAt) + 86400000).toISOString(),
      );
      assert.equal(await configuredReader.load(anotherCandidate.quoteReference), null);
      const lookup = {
        operationReference: requestInput.operationReference,
        guestSessionReference: requestInput.guestSessionReference,
        cartReference: requestQuote.cartReference,
        cartVersion: requestQuote.cartVersion,
        observedAt: new Date(Date.parse(requestQuote.createdAt) + 1000).toISOString(),
      };
      assert.deepEqual(await requests.resolve(lookup), recoveredRequest);
      for (const patch of [
        { guestSessionReference: id(34002) },
        { cartReference: id(34002) },
        { cartVersion: requestQuote.cartVersion + 1 },
        { observedAt: recoveredRequest.record.idempotencyExpiresAt },
      ]) {
        await assert.rejects(requests.resolve({ ...lookup, ...patch }), {
          code: "QUOTE_REQUEST_CONFLICT",
        });
      }
      assert.deepEqual(await counts(), { quotes: 6, lines: 6, taxes: 12, audits: 6 });
      const abortedQuote = createConfiguredPriceQuote(configuredInput(id(30005)));
      await admin.query("REVOKE INSERT ON rms_pricing.price_quote_request FROM " + role);
      await assert.rejects(
        requests.append({
          ...requestInput,
          operationReference: id(34003),
          quote: abortedQuote,
          audit: audit(abortedQuote, 32005),
        }),
        { code: "QUOTE_REQUEST_UNAVAILABLE" },
      );
      await admin.query("GRANT INSERT ON rms_pricing.price_quote_request TO " + role);
      assert.equal(await configuredReader.load(abortedQuote.quoteReference), null);
      assert.deepEqual(await counts(), { quotes: 6, lines: 6, taxes: 12, audits: 6 });
      const concurrentQuote = createConfiguredPriceQuote(configuredInput(id(30006)));
      const concurrentRequest = {
        ...requestInput,
        operationReference: id(34004),
        quote: concurrentQuote,
        audit: audit(concurrentQuote, 32006),
      };
      const concurrentRequests = await Promise.all([
        requests.append(concurrentRequest),
        requests.append(concurrentRequest),
      ]);
      assert.deepEqual(concurrentRequests[0], concurrentRequests[1]);
      assert.deepEqual(concurrentRequests[0].quote, concurrentQuote);
      assert.deepEqual(await counts(), { quotes: 7, lines: 7, taxes: 14, audits: 7 });
      assert.equal(
        (await admin.query("SELECT count(*)::int AS count FROM rms_pricing.price_quote_request"))
          .rows[0].count,
        2,
      );
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + readRole);
      await admin.query("DROP ROLE IF EXISTS " + readRole);
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
}, 120_000);
