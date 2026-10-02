import { seedOptionPriceRule } from "../test-support/option-price-seed.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCurrentOptionPriceStore,
  createPostgresOptionPriceReferenceSourceStore,
  createPostgresCurrentConfiguredQuoteService,
  resolveOptionPrice,
  createOptionPriceRuleSnapshot,
} from "../../rms/pricing/src/index.ts";
import { fixture, id } from "../../rms/ordering/src/tests/configured-cart-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { input as baseQuoteInput } from "../../rms/ordering/src/tests/order-pricing-quote.fixture.ts";
import { seedPriceBook } from "../test-support/price-book-seed.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";
const { Client } = pg;

it("reads current scoped Option prices with exact money, precedence, history and expiry", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_option_price" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_option_" + context.runId;
    assert.match(role, /^wp2402_option_[a-f0-9]+$/u);
    let created = false,
      active = 0;
    const f = fixture(),
      resolved = f.quote.lines[0].optionPrices[0];
    const original = resolved.rule,
      at = f.observedAt;
    const scope = { brandReference: f.cart.brandReference, storeReference: f.cart.storeReference };
    const currency = f.quote.currencyMetadata;
    const instant = (ms) => new Date(Date.parse(at) + ms).toISOString();
    const utc = (value) => ({
      instant: value,
      localDateTime: value.slice(0, -1),
      utcOffsetMinutes: 0,
    });
    const base = createOptionPriceRuleSnapshot({
      ...original,
      skuReference: null,
      effectivePeriod: { timeZone: "UTC", effectiveFrom: utc(at), effectiveUntil: null },
    });
    const query = {
      bindingReference: base.bindingReference,
      optionReference: base.optionReference,
      skuReference: resolved.skuReference,
      storeGroupReference: null,
      regionReference: null,
      channelCode: resolved.context.channelCode,
      orderType: "Pickup",
      observedAt: at,
    };
    let afterQuery = async () => undefined,
      isolation = "REPEATABLE READ",
      readOnly = true;
    const runner = {
      async run(action) {
        const client = new Client({
          ...context.clientConfig,
          query_timeout: 5000,
          connectionTimeoutMillis: 2000,
        });
        await client.connect();
        active++;
        try {
          await client.query(
            "BEGIN ISOLATION LEVEL " + isolation + (readOnly ? " READ ONLY" : " READ WRITE"),
          );
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL statement_timeout='5s'");
          const result = await action({
            query: async (sql, values) => {
              const result = await client.query(sql, [...values]);
              await afterQuery(sql);
              return result;
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
    const version = (value, number = 1) => seedOptionPriceRule(admin, value, id(9000), number);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      created = true;
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO " +
          role,
      );
      const reader = createPostgresCurrentOptionPriceStore(runner, scope, currency);
      assert.deepEqual(await reader.load(query), []);
      await version(base);
      assert.deepEqual(await reader.load(query), [base]);
      assert.equal(
        resolveOptionPrice(await reader.load(query), resolved.context).amount.amountMinor,
        500n,
      );
      // All policies below are synthetic, but every price/tax rule is read from PostgreSQL.
      const originalInput = baseQuoteInput();
      const source = {
        ...originalInput,
        lines: originalInput.lines.map((line) => ({
          ...line,
          priceContext: { ...line.priceContext, orderType: "Pickup" },
          taxContext: { ...line.taxContext, orderType: "Pickup" },
        })),
        taxConfiguration: {
          ...originalInput.taxConfiguration,
          rules: originalInput.taxConfiguration.rules.map((rule) => ({
            ...rule,
            orderType: "Pickup",
          })),
        },
      };
      await seedPriceBook(admin, source.priceBook, id(9000));
      await seedTaxConfiguration(admin, source.taxConfiguration, id(9000));
      await admin.query(
        "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO " +
          role,
      );
      const { priceBook, taxConfiguration, currencyMetadata, ...baseRequest } = source;
      let now = at;
      const service = createPostgresCurrentConfiguredQuoteService(runner, {
        scope,
        priceBookReference: priceBook.priceBookReference,
        taxConfigurationReference: taxConfiguration.configurationReference,
        currencyMetadata,
        evidence: {
          load: async () => ({
            registrationEvidence: taxConfiguration.registrationEvidence,
            professionalEvidence: taxConfiguration.professionalEvidence,
          }),
        },
        clock: { now: () => now },
      });
      const request = {
        base: baseRequest,
        options: [
          {
            lineReference: source.lines[0].lineReference,
            bindingReference: base.bindingReference,
            optionReference: base.optionReference,
            selectedQuantity: 3,
            taxBasis: "ParentSellable",
            taxClassificationReference: source.lines[0].taxContext.taxClassificationReference,
          },
        ],
      };
      const configured = await service.create(request);
      assert.equal(configured.quoteVersion, 2);
      assert.equal(configured.total.amountMinor, 2825n);
      assert.equal(
        configured.lines[0].optionPrices[0].rule.versionReference,
        base.versionReference,
      );
      await assert.rejects(
        () =>
          service.create({
            ...request,
            options: [
              {
                ...request.options[0],
                optionReference: id(79999),
              },
            ],
          }),
        { code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE" },
      );
      await assert.rejects(
        () =>
          service.create({
            ...request,
            options: [
              {
                ...request.options[0],
                rules: [base],
              },
            ],
          }),
        { code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE" },
      );
      isolation = "READ COMMITTED";
      await assert.rejects(() => service.create(request), {
        code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE",
      });
      isolation = "REPEATABLE READ";
      readOnly = false;
      await assert.rejects(() => service.create(request), {
        code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE",
      });
      readOnly = true;
      let concurrentRule;
      afterQuery = async (sql) => {
        if (!sql.includes("FROM rms_pricing.price_book")) return;
        afterQuery = async () => undefined;
        concurrentRule = await version({
          ...base,
          ruleReference: id(71000),
          versionReference: id(71001),
          scopeKind: "Store",
          scopeReference: scope.storeReference,
          unitAmount: { ...base.unitAmount, amountMinor: 250n },
        });
      };
      const coherent = await service.create(request);
      assert.ok(concurrentRule);
      assert.equal(coherent.total.amountMinor, 2825n);
      assert.equal((await service.create(request)).total.amountMinor, 3390n);
      await version({ ...concurrentRule, versionReference: id(71002), lifecycle: "Archived" }, 2);
      afterQuery = async (sql) => {
        if (sql.includes("FROM rms_pricing.option_price_rule")) now = source.expiresAt;
      };
      await assert.rejects(() => service.create(request), {
        code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE",
      });
      afterQuery = async () => undefined;
      now = at;
      const store = await version({
        ...base,
        ruleReference: id(100),
        versionReference: id(101),
        scopeKind: "Store",
        scopeReference: scope.storeReference,
        unitAmount: { ...base.unitAmount, amountMinor: 9007199254740993n },
      });
      assert.equal(
        resolveOptionPrice(await reader.load(query), resolved.context).amount.amountMinor,
        36028797018963972n,
      );
      const qualified = await version({
        ...store,
        ruleReference: id(110),
        versionReference: id(111),
        channelCode: query.channelCode,
        unitAmount: { ...base.unitAmount, amountMinor: 250n },
      });
      assert.equal(
        resolveOptionPrice(await reader.load(query), resolved.context).rule.ruleReference,
        qualified.ruleReference,
      );
      const conflict = await version({
        ...qualified,
        ruleReference: id(120),
        versionReference: id(121),
      });
      assert.equal((await reader.load(query)).length, 4);
      await assert.rejects(() => service.create(request), {
        code: "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE",
      });
      assert.throws(
        () => resolveOptionPrice([base, store, qualified, conflict], resolved.context),
        { code: "OPTION_PRICE_CONFLICT" },
      );
      const observedConflict = await reader.load(query);
      assert.throws(() => resolveOptionPrice(observedConflict, resolved.context), {
        code: "OPTION_PRICE_CONFLICT",
      });
      await version({ ...conflict, versionReference: id(122), lifecycle: "Archived" }, 2);
      assert.equal(
        resolveOptionPrice(await reader.load(query), resolved.context).rule.ruleReference,
        qualified.ruleReference,
      );
      await version({ ...qualified, versionReference: id(112), lifecycle: "Archived" }, 2);
      await version({ ...store, versionReference: id(102), lifecycle: "Archived" }, 2);
      const nextBase = await version(
        {
          ...base,
          versionReference: id(62_001),
          unitAmount: { ...base.unitAmount, amountMinor: 150n },
        },
        2,
      );
      assert.deepEqual(await reader.load(query), [nextBase]);
      assert.equal(
        (
          await admin.query(
            "SELECT unit_amount_minor::text AS amount,lifecycle FROM rms_pricing.option_price_rule_version WHERE option_price_rule_version_id=$1",
            [base.versionReference],
          )
        ).rows[0].amount,
        "125",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT lifecycle FROM rms_pricing.option_price_rule_version WHERE option_price_rule_version_id=$1",
            [store.versionReference],
          )
        ).rows[0].lifecycle,
        "Published",
      );
      const group = await version({
        ...base,
        ruleReference: id(130),
        versionReference: id(131),
        scopeKind: "StoreGroup",
        scopeReference: id(132),
      });
      const region = await version({
        ...base,
        ruleReference: id(140),
        versionReference: id(141),
        scopeKind: "Region",
        scopeReference: id(142),
      });
      const contextual = { ...query, storeGroupReference: id(132), regionReference: id(142) };
      assert.equal((await reader.load(contextual)).length, 3);
      assert.equal(
        resolveOptionPrice(await reader.load(contextual), {
          ...resolved.context,
          storeGroupReference: id(132),
          regionReference: id(142),
        }).rule.ruleReference,
        group.ruleReference,
      );
      assert.equal(
        resolveOptionPrice(await reader.load({ ...query, regionReference: id(142) }), {
          ...resolved.context,
          regionReference: id(142),
        }).rule.ruleReference,
        region.ruleReference,
      );
      const skuOnly = await version({
        ...base,
        ruleReference: id(150),
        versionReference: id(151),
        skuReference: id(152),
      });
      assert.ok(
        !(await reader.load(query)).some((rule) => rule.ruleReference === skuOnly.ruleReference),
      );
      const otherStore = createPostgresCurrentOptionPriceStore(
        runner,
        { ...scope, storeReference: id(999) },
        currency,
      );
      assert.deepEqual(await otherStore.load(query), [nextBase]);
      assert.deepEqual(await reader.load({ ...query, bindingReference: id(999) }), []);
      assert.deepEqual(await reader.load({ ...query, optionReference: id(999) }), []);
      assert.deepEqual(
        await createPostgresCurrentOptionPriceStore(
          runner,
          { ...scope, brandReference: id(999) },
          currency,
        ).load(query),
        [],
      );
      await assert.rejects(
        createPostgresCurrentOptionPriceStore(runner, scope, {
          ...currency,
          metadataVersion: 2,
        }).load(query),
        { code: "CURRENT_OPTION_PRICE_UNAVAILABLE" },
      );
      await assert.rejects(reader.load({ ...query, observedAt: instant(-1) }), {
        code: "CURRENT_OPTION_PRICE_UNAVAILABLE",
      });
      for (const sql of [
        "UPDATE rms_pricing.option_price_rule_version SET included_quantity=0 WHERE option_price_rule_version_id=$1",
        "DELETE FROM rms_pricing.option_price_rule_version WHERE option_price_rule_version_id=$1",
      ])
        await assert.rejects(admin.query(sql, [base.versionReference]), { code: "55000" });
      await assert.rejects(admin.query("TRUNCATE rms_pricing.option_price_rule_version CASCADE"), {
        code: "55000",
      });
      await admin.query(
        "UPDATE rms_pricing.option_price_rule SET updated_at=created_at + interval '1 microsecond' WHERE option_price_rule_id=$1",
        [base.ruleReference],
      );
      await assert.rejects(reader.load({ ...query, observedAt: instant(1000) }), {
        code: "CURRENT_OPTION_PRICE_UNAVAILABLE",
      });
      await admin.query(
        "UPDATE rms_pricing.option_price_rule SET updated_at=created_at WHERE option_price_rule_id=$1",
        [base.ruleReference],
      );
      const expiring = await version(
        {
          ...nextBase,
          versionReference: id(62002),
          effectivePeriod: { ...nextBase.effectivePeriod, effectiveUntil: utc(instant(1000)) },
        },
        3,
      );
      assert.deepEqual(await reader.load({ ...query, observedAt: instant(999) }), [expiring]);
      assert.deepEqual(await reader.load({ ...query, observedAt: instant(1000) }), []);
      await version({ ...expiring, versionReference: id(62003), lifecycle: "Draft" }, 4);
      assert.deepEqual(await reader.load(query), []);
      const foreign = await version({
        ...base,
        ruleReference: id(160),
        versionReference: id(161),
        brandReference: id(162),
      });
      const visible = await runner.run(async (tx) => {
        await tx.query("SELECT set_config('bop.brand_id',$1,true)", [scope.brandReference]);
        return (
          await tx.query("SELECT option_price_rule_id FROM rms_pricing.option_price_rule", [])
        ).rows;
      });
      assert.ok(!visible.some((row) => row.option_price_rule_id === foreign.ruleReference));
      // Source profile reads actual complete owning bindings/history; authority is synthetic.
      isolation = "READ COMMITTED";
      let holds = 0,
        deniedAt = 0,
        queryCount = 0;
      afterQuery = async () => {
        queryCount++;
      };
      const impactRequest = {
        purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
        brandReference: scope.brandReference,
        actorReference: id(9000),
        operationReference: id(80000),
        catalogIntentDigest: "sha256:" + "a".repeat(64),
      };
      const impact = createPostgresOptionPriceReferenceSourceStore({
        tenantReference: id(80001),
        brandReference: scope.brandReference,
        actorReference: id(9000),
        transactions: runner,
        clock: { now: () => new Date().toISOString() },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            void tx;
            assert.equal(input.permission, "pricing.price-book.manage");
            assert.deepEqual(input.request, impactRequest);
            if (++holds === deniedAt) throw new Error("synthetic authority denied");
          },
        },
      });
      const pendingId = id(80200);
      await admin.query(
        "INSERT INTO rms_pricing.option_price_rule(option_price_rule_id,brand_id,binding_id,option_id,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
        [pendingId, scope.brandReference, id(80201), id(80202), base.createdAt, id(9000)],
      );
      const futureFrom = new Date(Date.now() + 86400000).toISOString();
      await version({
        ...base,
        ruleReference: id(80100),
        versionReference: id(80101),
        skuReference: id(80102),
        scopeKind: "StoreGroup",
        scopeReference: id(80103),
        effectivePeriod: { timeZone: "UTC", effectiveFrom: utc(futureFrom), effectiveUntil: null },
      });
      const snapshot = await impact.loadSnapshot(impactRequest);
      assert.equal(holds, 2);
      assert.equal(snapshot.profile, "OptionPriceBindings");
      assert.equal(snapshot.consistency, "StatementSnapshot");
      assert.equal(
        snapshot.roots.length,
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_pricing.option_price_rule WHERE brand_id=$1",
            [scope.brandReference],
          )
        ).rows[0].n,
      );
      assert.equal(
        snapshot.versions.length,
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_pricing.option_price_rule_version WHERE brand_id=$1",
            [scope.brandReference],
          )
        ).rows[0].n,
      );
      assert.ok(
        snapshot.roots.some(
          (r) => r.ruleReference === pendingId && r.currentVersionReference === null,
        ),
      );
      assert.ok(!snapshot.versions.some((v) => v.ruleReference === pendingId));
      assert.ok(!snapshot.roots.some((r) => r.ruleReference === foreign.ruleReference));
      assert.equal(
        snapshot.versions.find((v) => v.versionReference === base.versionReference)
          .isCurrentVersion,
        false,
      );
      assert.equal(
        snapshot.versions.find((v) => v.versionReference === id(62003)).lifecycle,
        "Draft",
      );
      assert.equal(
        snapshot.versions.find((v) => v.versionReference === id(62002)).temporalStatus,
        "Expired",
      );
      assert.equal(
        snapshot.versions.find((v) => v.versionReference === id(80101)).temporalStatus,
        "Future",
      );
      assert.equal(
        snapshot.versions.find((v) => v.versionReference === skuOnly.versionReference).skuReference,
        id(152),
      );
      assert.ok(snapshot.versions.some((v) => v.scopeKind === "Region"));
      assert.ok(snapshot.versions.some((v) => v.scopeKind === "StoreGroup"));
      assert.equal(JSON.stringify(snapshot).includes("unitAmount"), false);
      assert.equal(JSON.stringify(snapshot).includes("includedQuantity"), false);
      assert.equal(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'rms_catalog.product','SELECT') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal((await impact.loadSnapshot(impactRequest)).digest, snapshot.digest);
      await version({
        ...base,
        ruleReference: id(80300),
        versionReference: id(80301),
        lifecycle: "Archived",
      });
      const changed = await impact.loadSnapshot(impactRequest);
      assert.notEqual(changed.digest, snapshot.digest);
      deniedAt = holds + 1;
      queryCount = 0;
      await assert.rejects(impact.loadSnapshot(impactRequest), {
        code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE",
      });
      assert.equal(queryCount, 0);
      deniedAt = holds + 2;
      await assert.rejects(impact.loadSnapshot(impactRequest), {
        code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE",
      });
      deniedAt = 0;
      assert.equal((await impact.loadSnapshot(impactRequest)).digest, changed.digest);
      await admin.query(
        "UPDATE rms_pricing.option_price_rule SET updated_at=created_at+interval '1 microsecond' WHERE option_price_rule_id=$1",
        [pendingId],
      );
      await assert.rejects(impact.loadSnapshot(impactRequest), {
        code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE",
      });
      await admin.query(
        "UPDATE rms_pricing.option_price_rule SET updated_at=created_at WHERE option_price_rule_id=$1",
        [pendingId],
      );
      assert.equal((await impact.loadSnapshot(impactRequest)).digest, changed.digest);
      afterQuery = async () => undefined;
      assert.equal(active, 0);
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
});
