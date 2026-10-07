import {
  PublishingContractError,
  PublishingServiceError,
  createPostgresOptionPriceReviewOperationStore,
  parsePublishingOptionPriceReviewOperation,
  publishingOptionPriceReviewOperationDigest,
  optionPriceReviewOperationFields,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingCode,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
} from "../../bop/publishing/src/index.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  evaluatePermission,
  parsePolicyReference,
  parsePolicyVersion,
  parseEvidenceReference,
} from "../../bop/permission/src/index.ts";
import { validateAuditRecord, canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { seedOptionPriceRule } from "../test-support/option-price-seed.mjs";
import assert from "node:assert/strict";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCurrentOptionPriceStore,
  createPostgresOptionPriceReferenceSourceStore,
  createPostgresCurrentConfiguredQuoteService,
  resolveOptionPrice,
  createOptionPriceRuleSnapshot,
  createPostgresOptionPriceAuthoringStore,
  parseOptionPriceAuthoringCommand,
  OptionPriceAuthoringError,
  optionPriceAuthoringFields,
  optionPriceIntentDigest,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
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

it("commits actual OptionPrice authoring history, quotes, recovery and 014 coherence", async () => {
  await withIsolatedDatabase({ caseId: "option_price_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "option_price_write_" + context.runId;
    assert.match(role, /^option_price_write_[a-f0-9]+$/u);
    const tenant = id(91000),
      brand = id(91001),
      store = id(91002),
      actor = id(91003),
      rule = id(91004),
      binding = id(91005),
      option = id(91006),
      policyFamily = id(91007);
    const currency = fixture().quote.currencyMetadata;
    const start = new Date().toISOString(),
      effectiveStart = new Date(Date.parse(start) - 60000).toISOString();
    const content = {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: effectiveStart,
          localDateTime: effectiveStart.slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    };
    const create = parseOptionPriceAuthoringCommand({
      action: "CreateDraft",
      operationReference: id(91010),
      ruleReference: rule,
      expectedAggregateVersion: null,
      bindingReference: binding,
      optionReference: option,
      content,
    });
    let sequence = 92000,
      allowed = true,
      created = false,
      active = 0,
      sourceCalls = 0;
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_pricing.option_price_rule) roots,(SELECT count(*)::int FROM rms_pricing.option_price_rule_version) versions,(SELECT count(*)::int FROM rms_pricing.option_price_authoring_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
        )
      ).rows[0];
    // Component evidence: controlled full scope/field authority and policy packet,
    // actual PostgreSQL/RLS/Audit/Outbox/COMMIT. This is not ordinary IAM or policy acquisition.
    const run = async (
      work,
      {
        family = policyFamily,
        actualActor = actor,
        actualStore = store,
        afterWork,
        beforeQuery,
        afterQuery,
      } = {},
    ) => {
      const client = new Client({
        ...context.clientConfig,
        query_timeout: 5000,
        connectionTimeoutMillis: 2000,
      });
      await client.connect();
      active++;
      let transportFailure = null;
      const statementStage = (sql) => {
        const kind = /^(SELECT|INSERT|UPDATE|LOCK|SET)\b/u.exec(sql)?.[1] ?? "OTHER";
        const asset =
          [
            "rms_pricing.option_price_authoring_operation",
            "rms_pricing.option_price_rule_version",
            "rms_pricing.option_price_rule",
            "platform_audit.audit_chain_head",
            "platform_audit.audit_record",
            "platform_eventing.outbox_event",
          ].find((name) => sql.includes(name)) ?? "owning_helper";
        return kind + ":" + asset;
      };
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, actualStore],
        );
        const tx = {
            async query(sql, values) {
              if (beforeQuery) await beforeQuery(sql, values, client.processID);
              let result;
              try {
                result = await client.query(sql, [...values]);
              } catch (error) {
                transportFailure ??= {
                  code:
                    typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
                      ? error.code
                      : "UNCLASSIFIED",
                  stage: statementStage(sql),
                };
                throw error;
              }
              if (afterQuery) await afterQuery(sql, values, client.processID);
              return result;
            },
          },
          hooks = [];
        const observedAt = new Date().toISOString(),
          validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
        const owner = createPostgresOptionPriceAuthoringStore({
          transaction: tx,
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: actualStore,
          actorReference: actualActor,
          currencyMetadata: currency,
          originalObservedAt: observedAt,
          originalValidUntil: validUntil,
          clock: { now: () => new Date().toISOString() },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, brand);
              assert.equal(input.selectedStoreReference, actualStore);
              assert.equal(input.actorReference, actualActor);
              assert.equal(input.permission, "pricing.price-book.manage");
              assert.equal(input.purposeCode, "PRICING_OPTION_PRICE_AUTHORING");
              assert.deepEqual(input.requiredFields, optionPriceAuthoringFields);
              if (!allowed) throw new OptionPriceAuthoringError("OPTION_PRICE_PERMISSION_DENIED");
              return validUntil;
            },
          },
          publicationPolicyFamilyReference: family,
          publicationSource: {
            async withCurrentAuthorization(actual, input, callback) {
              assert.equal(actual, tx);
              assert.ok(input.state.draft);
              sourceCalls++;
              const now = new Date().toISOString();
              return callback({
                policy: {
                  profile: "PublishingOptionPricePublicationPolicyV1",
                  tenantReference: tenant,
                  brandReference: brand,
                  familyReference: family,
                  policyReference: id(91008),
                  policyVersion: 1,
                  approvalPolicy: "Required",
                  effectiveFrom: effectiveStart,
                  effectiveUntil: null,
                },
                currentPolicyPublicationReference: id(91009),
                draftVersionReference: input.state.draft.versionReference,
                draftSnapshotDigest: input.state.draft.snapshotDigest,
                draftAuthorActorReference: input.state.draftAuthorActorReference,
                approvalEvidenceReference: id(91011),
                approvedActorReference: id(91012),
                observedAt: now,
                validUntil,
              });
            },
          },
          references: { generate: () => id(sequence++) },
          audit: {
            create: ({
              auditReference,
              command,
              actorReference,
              brandReference,
              occurredAt,
              mode,
            }) =>
              validateAuditRecord({
                auditId: auditReference,
                brandId: brandReference,
                actor: { type: "User", reference: actorReference },
                actionCode:
                  mode === "Abandon"
                    ? "PRICING_OPTION_PRICE_RESOLVE"
                    : "PRICING_OPTION_PRICE_" + command.action.toUpperCase(),
                targetType: "PricingOptionPriceRule",
                targetId: command.ruleReference,
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: command.operationReference,
                occurredAt,
                sourceChannel: "INTERNAL_TEST",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
          },
          registerBeforeCommit: (actual, guard, final) => {
            assert.equal(actual, tx);
            hooks.push({ guard, final });
          },
        });
        const result = await work(owner, tx);
        if (afterWork) await afterWork(tx, result);
        // Deferred SQL coherence must be satisfied before final live source assertions.
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const hook of hooks) await hook.guard();
        for (const hook of hooks) hook.final();
        await client.query("COMMIT");
        owner.assertFinalized();
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        if (transportFailure !== null && error instanceof OptionPriceAuthoringError) {
          throw new Error(
            "Native OptionPrice SQL failure " +
              transportFailure.code +
              " at " +
              transportFailure.stage,
            { cause: error },
          );
        }
        throw error;
      } finally {
        await client.end();
        active--;
      }
    };
    const command = (action, operationReference, expectedAggregateVersion, extra = {}) =>
      parseOptionPriceAuthoringCommand({
        action,
        operationReference,
        ruleReference: rule,
        expectedAggregateVersion,
        bindingReference: null,
        optionReference: null,
        content: null,
        ...extra,
      });
    const priceRows = async () => {
      const reader = createPostgresCurrentOptionPriceStore(
        {
          run: async (work) => {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              await client.query("SET LOCAL ROLE " + role);
              const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        },
        { brandReference: brand, storeReference: store },
        currency,
      );
      return reader.load({
        bindingReference: binding,
        optionReference: option,
        skuReference: id(91013),
        storeGroupReference: null,
        regionReference: null,
        channelCode: "APP",
        orderType: "Pickup",
        observedAt: new Date().toISOString(),
      });
    };
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_pricing,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_pricing.option_price_authoring_operation_available(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_pricing.option_price_rule,rms_pricing.option_price_rule_version,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_pricing.option_price_authoring_operation,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      assert.deepEqual(
        await run((owner) =>
          owner.listForBinding({ bindingReference: binding, optionReference: option }),
        ),
        [],
      );
      const first = await run((owner) => owner.execute(create));
      assert.equal(first.outcome, "Committed");
      assert.equal(first.state.aggregateVersion, 1);
      assert.equal(first.state.draft.lifecycle, "Draft");
      assert.deepEqual(await priceRows(), []);
      assert.deepEqual(
        await run((owner) =>
          owner.listForBinding({ bindingReference: binding, optionReference: option }),
        ),
        [first.state],
      );
      assert.deepEqual(
        await run((owner) =>
          owner.listForBinding({ bindingReference: id(91110), optionReference: option }),
        ),
        [],
      );
      assert.deepEqual(
        await run((owner) =>
          owner.listForBinding({ bindingReference: binding, optionReference: id(91111) }),
        ),
        [],
      );
      const firstCounts = await counts();
      assert.deepEqual(await run((owner) => owner.execute(create)), first);
      assert.deepEqual(await counts(), firstCounts);
      await assert.rejects(
        run((owner) =>
          owner.execute({ ...create, content: { ...content, unitAmountMinor: "999" } }),
        ),
        { code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT" },
      );
      const beforeLate = await counts();
      try {
        await assert.rejects(
          run((owner) => owner.execute(command("Publish", id(91019), 1)), {
            afterWork: async () => {
              allowed = false;
            },
          }),
          { code: "OPTION_PRICE_PERMISSION_DENIED" },
        );
      } finally {
        allowed = true;
      }
      assert.deepEqual(await counts(), beforeLate);
      const publish1 = command("Publish", id(91020), 1),
        published = await run((owner) => owner.execute(publish1));
      assert.equal(published.state.currentPublished.unitAmount.amountMinor, 125n);
      assert.equal(published.state.draft, null);
      assert.deepEqual(
        await run((owner) =>
          owner.listForBinding({ bindingReference: binding, optionReference: option }),
        ),
        [published.state],
      );
      const oldQuote = resolveOptionPrice(await priceRows(), {
        brandReference: brand,
        storeReference: store,
        storeGroupReference: null,
        regionReference: null,
        bindingReference: binding,
        optionReference: option,
        skuReference: id(91013),
        channelCode: "APP",
        orderType: "Pickup",
        currencyMetadata: currency,
        evaluatedAt: new Date().toISOString(),
        selectedQuantity: 2,
        itemQuantity: 1,
      });
      const oldVersion = published.state.currentPublished.versionReference,
        sourceBefore = sourceCalls,
        publishCounts = await counts();
      assert.deepEqual(
        await run((owner) => owner.execute(publish1), { family: id(91100) }),
        published,
      );
      assert.equal(sourceCalls, sourceBefore);
      assert.deepEqual(await counts(), publishCounts);
      const nextDraft = command("CreateDraft", id(91021), 2, {
          bindingReference: binding,
          optionReference: option,
          content: { ...content, unitAmountMinor: "200" },
        }),
        draft2 = await run((owner) => owner.execute(nextDraft));
      assert.equal(draft2.state.currentPublished.versionReference, oldVersion);
      assert.equal((await priceRows())[0].versionReference, oldVersion);
      assert.equal(oldQuote.rule.versionReference, oldVersion);
      const discoveredDraft = await run((owner) =>
        owner.listForBinding({ bindingReference: binding, optionReference: option }),
      );
      assert.deepEqual(discoveredDraft, [draft2.state]);
      assert.equal(discoveredDraft[0].draft.versionReference, draft2.state.draft.versionReference);
      assert.equal(discoveredDraft[0].currentPublished.versionReference, oldVersion);
      const beforeLateList = await counts();
      try {
        await assert.rejects(
          run(
            (owner) => owner.listForBinding({ bindingReference: binding, optionReference: option }),
            {
              afterWork: async () => {
                allowed = false;
              },
            },
          ),
          { code: "OPTION_PRICE_PERMISSION_DENIED" },
        );
      } finally {
        allowed = true;
      }
      assert.deepEqual(await counts(), beforeLateList);
      const replacement = command("ReplaceDraft", id(91022), 3, {
          content: { ...content, unitAmountMinor: "225" },
        }),
        replaced = await run((owner) => owner.execute(replacement));
      assert.equal(replaced.state.aggregateVersion, 4);
      assert.equal(replaced.state.draft.unitAmount.amountMinor, 225n);
      const stable = await counts();
      await assert.rejects(
        run((owner) => owner.execute(command("ReplaceDraft", id(91023), 3, { content }))),
        { code: "OPTION_PRICE_VERSION_CONFLICT" },
      );
      assert.deepEqual(await counts(), stable);
      const publish2 = command("Publish", id(91024), 4),
        second = await run((owner) => owner.execute(publish2));
      assert.equal(second.state.aggregateVersion, 5);
      assert.equal((await priceRows())[0].unitAmount.amountMinor, 225n);
      assert.equal(oldQuote.rule.versionReference, oldVersion);
      assert.equal(oldQuote.amount.amountMinor, 125n);
      assert.equal(
        (
          await admin.query(
            "SELECT unit_amount_minor::text amount,lifecycle FROM rms_pricing.option_price_rule_version WHERE option_price_rule_version_id=$1",
            [oldVersion],
          )
        ).rows[0].amount,
        "125",
      );
      const archived = await run((owner) => owner.execute(command("Archive", id(91025), 5)));
      assert.equal(archived.state.aggregateVersion, 6);
      assert.equal(archived.state.currentPublished, null);
      assert.deepEqual(await priceRows(), []);
      const absent = command("ReplaceDraft", id(91026), 6, { content }),
        beforeAbandon = await counts(),
        abandoned = await run((owner) => owner.resolve(absent));
      assert.equal(abandoned.outcome, "Abandoned");
      assert.equal(abandoned.state, null);
      const afterAbandon = await counts();
      assert.equal(afterAbandon.originals, beforeAbandon.originals + 1);
      assert.equal(afterAbandon.audits, beforeAbandon.audits + 1);
      assert.equal(afterAbandon.events, beforeAbandon.events);
      assert.equal(afterAbandon.versions, beforeAbandon.versions);
      assert.deepEqual(await run((owner) => owner.resolve(absent)), abandoned);
      assert.deepEqual(await run((owner) => owner.execute(absent)), abandoned);
      assert.deepEqual(await counts(), afterAbandon);
      allowed = false;
      await assert.rejects(
        run((owner) => owner.readCurrent(rule)),
        { code: "OPTION_PRICE_PERMISSION_DENIED" },
      );
      allowed = true;
      await assert.rejects(
        run((owner) => owner.resolve(create), { actualActor: id(91101) }),
        { code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT" },
      );
      await assert.rejects(run((owner) => owner.resolve(create), { actualStore: id(91102) }));
      assert.deepEqual(await counts(), afterAbandon);
      const foreignCreate = parseOptionPriceAuthoringCommand({
        ...create,
        operationReference: id(93100),
        ruleReference: id(93101),
        bindingReference: id(93102),
        optionReference: id(93103),
      });
      await run((owner) => owner.execute(foreignCreate));
      const attackBaseline = await counts();
      // Raw 014 constraint attacks are negative SQL evidence, never fabricated
      // successful source/approval records. Every attack rolls back in finally.
      const attack = async (work, expectedCode, versionOnly = false) => {
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          let sqlstate = null;
          try {
            await work();
            if (versionOnly)
              await admin.query(
                "SET CONSTRAINTS rms_pricing.option_price_version_original_check IMMEDIATE",
              );
            await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
          } catch (error) {
            sqlstate =
              typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
                ? error.code
                : "UNCLASSIFIED";
          }
          assert.equal(sqlstate, expectedCode);
        } finally {
          await admin.query("ROLLBACK");
        }
        assert.deepEqual(await counts(), attackBaseline);
      };
      const cloneVersion = async (originalOperation) =>
        admin.query(
          "INSERT INTO rms_pricing.option_price_rule_version(option_price_rule_version_id,option_price_rule_id,brand_id,binding_id,option_id,version_number,snapshot_digest,lifecycle,sku_id,scope_kind,scope_id,channel_code,order_type,currency_code,currency_minor_unit_exponent,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,unit_amount_minor,included_quantity,quantity_basis,effective_from,effective_until,effective_time_zone,created_at,authoring_operation_id) SELECT $1,option_price_rule_id,brand_id,binding_id,option_id,100,snapshot_digest,lifecycle,sku_id,scope_kind,scope_id,channel_code,order_type,currency_code,currency_minor_unit_exponent,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,unit_amount_minor,included_quantity,quantity_basis,effective_from,effective_until,effective_time_zone,created_at,$2 FROM rms_pricing.option_price_rule_version WHERE option_price_rule_version_id=$3",
          [id(93000), originalOperation, first.state.latestVersion.versionReference],
        );
      await attack(() => cloneVersion(create.operationReference), "23514"); // historical/foreign terminal does not own this new version
      await attack(() => cloneVersion(foreignCreate.operationReference), "23514"); // different actual rule terminal cannot own this version
      await attack(() => cloneVersion(absent.operationReference), "23514"); // Abandoned cannot supply a committed version
      await attack(() => cloneVersion(id(93001)), "23514", true); // assert owning reverse coherence before the separately deferred missing-terminal FK
      const originalRow = (
        await admin.query(
          "SELECT * FROM rms_pricing.option_price_authoring_operation WHERE operation_id=$1",
          [create.operationReference],
        )
      ).rows[0];
      assert.ok(originalRow);
      await attack(async () => {
        const receipt = globalThis.structuredClone(originalRow.receipt_json),
          audit = globalThis.structuredClone(originalRow.audit_json);
        receipt.command.operationReference = id(93002);
        receipt.intentDigest = optionPriceIntentDigest(receipt.command);
        receipt.auditReference = id(93003);
        receipt.eventReference = id(93004);
        const missingVersion = optionPriceWireSnapshot(
          materializeOptionPriceVersion({
            command: receipt.command,
            current: null,
            brandReference: brand,
            versionReference: id(93005),
            occurredAt: receipt.occurredAt,
            currencyMetadata: currency,
          }),
        );
        receipt.state.latestVersion = missingVersion;
        receipt.state.draft = missingVersion;
        audit.auditId = id(93003);
        audit.correlationId = id(93002);
        await admin.query(
          "INSERT INTO rms_pricing.option_price_authoring_operation(operation_id,tenant_id,brand_id,selected_store_id,actor_id,option_price_rule_id,action_code,intent_digest,outcome,result_version_id,result_aggregate_version,receipt_json,record_digest,audit_id,audit_json,event_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,'CreateDraft',$7,'Committed',$8,1,$9::jsonb,$10,$11,$12::jsonb,$13,$14)",
          [
            id(93002),
            tenant,
            brand,
            store,
            actor,
            rule,
            receipt.intentDigest,
            id(93005),
            receipt,
            "sha256:" + sha256Hex(canonicalizeRfc8785(receipt)),
            id(93003),
            audit,
            id(93004),
            receipt.occurredAt,
          ],
        );
      }, "23514"); // forward terminal has no same-transaction owning version/root
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, id(91103), store],
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM rms_pricing.option_price_authoring_operation",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      // Real separate-client arbitration: success depends on observed PostgreSQL
      // blocked locks, not scheduling delays or sleep-based assertions.
      const signal = () => {
        let release;
        const promise = new Promise((resolve) => {
          release = resolve;
        });
        return { promise, release };
      };
      const finiteSignal = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((resolve, reject) => {
              void resolve;
              timer = setTimeout(() => reject(Error("Native lock arrival was not observed")), 1500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const blocked = async (pid, kind) => {
        const end = Date.now() + 1500;
        while (Date.now() < end) {
          const row = (
            await admin.query(
              "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype=$2) blocked",
              [pid, kind],
            )
          ).rows[0];
          if (row.blocked === true) return;
        }
        throw Error("Native PostgreSQL blocked-state proof missing");
      };
      for (const winning of ["execute", "resolve"]) {
        const base = winning === "execute" ? 94000 : 94100;
        const originalCommand = parseOptionPriceAuthoringCommand({
          ...create,
          operationReference: id(base),
          ruleReference: id(base + 1),
          bindingReference: id(base + 2),
          optionReference: id(base + 3),
        });
        const acquired = signal(),
          entered = signal(),
          release = signal(),
          before = await counts();
        const first = run((owner) => owner[winning](originalCommand), {
          afterQuery: async (sql, values) => {
            if (
              sql.startsWith("SELECT pg_advisory_xact_lock") &&
              values[0] === "PricingOptionPriceOperation:" + originalCommand.operationReference
            ) {
              acquired.release();
              await release.promise;
            }
          },
        });
        let second;
        try {
          await finiteSignal(acquired.promise);
          second = run(
            (owner) => owner[winning === "execute" ? "resolve" : "execute"](originalCommand),
            {
              beforeQuery: async (sql, values, pid) => {
                if (
                  sql.startsWith("SELECT pg_advisory_xact_lock") &&
                  values[0] === "PricingOptionPriceOperation:" + originalCommand.operationReference
                )
                  entered.release(pid);
              },
            },
          );
          const pid = await finiteSignal(entered.promise);
          await blocked(pid, "advisory");
          release.release();
          const results = await Promise.allSettled([first, second]);
          assert.equal(results[0].status, "fulfilled");
          const terminal = results[0].value;
          assert.equal(terminal.outcome, winning === "execute" ? "Committed" : "Abandoned");
          assert.equal(results[1].status, "fulfilled");
          assert.deepEqual(results[1].value, terminal);
          const after = await counts();
          assert.equal(after.originals, before.originals + 1);
          assert.equal(after.audits, before.audits + 1);
          assert.equal(after.events, before.events + (winning === "execute" ? 1 : 0));
          assert.equal(after.versions, before.versions + (winning === "execute" ? 1 : 0));
          assert.deepEqual(await run((owner) => owner.resolve(originalCommand)), terminal);
          assert.deepEqual(await counts(), after);
        } finally {
          release.release();
          await Promise.allSettled(second ? [first, second] : [first]);
        }
      }
      const collisionBinding = id(94200),
        collisionOption = id(94201);
      const collidingDrafts = [0, 1].map((index) =>
        parseOptionPriceAuthoringCommand({
          ...create,
          operationReference: id(94210 + index),
          ruleReference: id(94220 + index),
          bindingReference: collisionBinding,
          optionReference: collisionOption,
          content: { ...content, unitAmountMinor: String(300 + index) },
        }),
      );
      for (const draft of collidingDrafts) await run((owner) => owner.execute(draft));
      const publishes = collidingDrafts.map((draft, index) =>
        parseOptionPriceAuthoringCommand({
          action: "Publish",
          operationReference: id(94230 + index),
          ruleReference: draft.ruleReference,
          expectedAggregateVersion: 1,
          bindingReference: null,
          optionReference: null,
          content: null,
        }),
      );
      const acquired = signal(),
        entered = signal(),
        release = signal(),
        beforeCollision = await counts();
      const firstPublish = run((owner) => owner.execute(publishes[0]), {
        afterQuery: async (sql) => {
          if (sql.startsWith("LOCK TABLE rms_pricing") && sql.includes("SHARE ROW EXCLUSIVE")) {
            acquired.release();
            await release.promise;
          }
        },
      });
      let secondPublish;
      try {
        await finiteSignal(acquired.promise);
        secondPublish = run((owner) => owner.execute(publishes[1]), {
          beforeQuery: async (sql, values, pid) => {
            void values;
            if (sql.startsWith("LOCK TABLE rms_pricing") && sql.includes("SHARE ROW EXCLUSIVE"))
              entered.release(pid);
          },
        });
        const pid = await finiteSignal(entered.promise);
        await blocked(pid, "relation");
        release.release();
        const results = await Promise.allSettled([firstPublish, secondPublish]);
        assert.equal(results[0].status, "fulfilled");
        assert.equal(results[0].value.outcome, "Committed");
        assert.equal(results[1].status, "rejected");
        assert.equal(results[1].reason?.code, "OPTION_PRICE_CONFLICT");
        const after = await counts();
        assert.equal(after.originals, beforeCollision.originals + 1);
        assert.equal(after.audits, beforeCollision.audits + 1);
        assert.equal(after.events, beforeCollision.events + 1);
        assert.equal(after.versions, beforeCollision.versions + 1);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM rms_pricing.option_price_rule r JOIN rms_pricing.option_price_rule_version v ON v.option_price_rule_version_id=r.current_version_id WHERE r.brand_id=$1 AND r.binding_id=$2 AND r.option_id=$3 AND v.lifecycle='Published'",
              [brand, collisionBinding, collisionOption],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        release.release();
        await Promise.allSettled(secondPublish ? [firstPublish, secondPublish] : [firstPublish]);
      }
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

it("recovers actual Pricing review originals with 017 terminals and contended fences", async () => {
  await withIsolatedDatabase({ caseId: "price_review_native" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "price_review_" + context.runId;
    assert.match(role, /^price_review_[a-f0-9]+$/u);
    const tenant = id(96000),
      brand = id(96001),
      store = id(96002),
      author = id(96003),
      approver = id(96004),
      rule = id(96005),
      snapshot = id(96006),
      snapshotDigest = parsePublishingDigest("sha256:" + "a".repeat(64));
    const scope = createPublishingScope({
      kind: "Brand",
      brandReference: brand,
      storeReference: null,
    });
    let next = 97000,
      created = false,
      active = 0,
      allowed = true;
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM bop_publishing.option_price_review_operation) terminals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
        )
      ).rows[0];
    const command = (overrides = {}) =>
      parsePublishingOptionPriceReviewOperation({
        profile: "PublishingOptionPriceReviewOperationV1",
        tenantReference: tenant,
        brandReference: brand,
        selectedStoreReference: store,
        actorReference: author,
        reasonCode: "AUTHORIZED_OPERATION",
        action: "SubmitReview",
        operationReference: id(next++),
        ruleReference: rule,
        draftVersionReference: snapshot,
        draftSnapshotDigest: snapshotDigest,
        expectedAggregateVersion: 1,
        validationValidUntil: new Date(Date.now() + 4000).toISOString(),
        approvalValidUntil: null,
        expectedLifecycle: null,
        ...overrides,
      });
    // Synthetic component admission only. Public Permission/Publishing contracts,
    // actual PG locks/RLS/history/Audit are exercised; this is not normal IAM or policy acquisition.
    const tenantContext = (actor, at) =>
      createTenantContext(
        {
          actorType: "User",
          accountKind: "Workforce",
          actorReference: actor,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: at,
          recentMfaAt: null,
        },
        createBrand({
          brandReference: brand,
          code: "SYNTH_PRICE_REVIEW",
          displayName: "Synthetic review Brand",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Active",
          version: 1,
          createdAt: at,
          updatedAt: at,
        }),
        null,
        at,
      );
    const run = async (c, work, { beforeQuery, afterQuery, afterWork } = {}) => {
      const client = new Client({
        ...context.clientConfig,
        query_timeout: 5000,
        connectionTimeoutMillis: 2000,
      });
      await client.connect();
      active++;
      let sqlFailure = null;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL statement_timeout='5s'");
        const hooks = [],
          observedAt = new Date().toISOString(),
          validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
        const tx = {
          async query(sql, values) {
            if (beforeQuery) await beforeQuery(sql, values, client.processID);
            let result;
            try {
              result = await client.query(sql, [...values]);
            } catch (error) {
              sqlFailure ??= {
                code:
                  typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
                    ? error.code
                    : "UNCLASSIFIED",
                kind:
                  typeof error?.message === "string" && error.message.includes("row-level security")
                    ? "row_scope"
                    : typeof error?.message === "string" &&
                        error.message.startsWith("permission denied for")
                      ? "asset_permission"
                      : "statement",
                stage:
                  [
                    "bop_publishing.option_price_review_operation",
                    "bop_publishing.publishing_mutation_record",
                    "platform_audit.audit_record",
                    "platform_audit.audit_chain_head",
                  ].find((asset) => sql.includes(asset)) ?? "owning_helper",
              };
              throw error;
            }
            if (afterQuery) await afterQuery(sql, values, client.processID);
            return result;
          },
        };
        const source = createPostgresOptionPriceReviewOperationStore({
          tenantReference: tenant,
          brandReference: brand,
          selectedStoreReference: store,
          actorReference: c.actorReference,
          clock: { now: () => new Date().toISOString() },
          originalValidUntil: validUntil,
          registerBeforeCommit: (actual, guard, final) => {
            assert.equal(actual, tx);
            hooks.push({ guard, final });
          },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.deepEqual(input.command, c);
              assert.equal(input.permission, "pricing.price-book.manage");
              assert.equal(input.purposeCode, "PRICING_OPTION_PRICE_REVIEW_OPERATION");
              assert.deepEqual(input.requiredFields, optionPriceReviewOperationFields);
              if (!allowed) throw Error("SYNTHETIC_CURRENT_PERMISSION_DENIED");
              return { validUntil: input.validUntil };
            },
          },
          audit: {
            create: ({ command: original, observedAt: at }) =>
              validateAuditRecord({
                auditId: id(next++),
                brandId: brand,
                actor: { type: "User", reference: original.actorReference },
                actionCode: "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED",
                targetType: "PublishingOptionPriceReviewOperation",
                targetId: original.operationReference,
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: original.operationReference,
                occurredAt: at,
                sourceChannel: "INTERNAL_TEST",
                dataClassification: "Confidential",
                retentionPolicyCode: "AUDIT_SECURITY",
                retentionPolicyVersion: 1,
              }),
          },
        });
        const execute = async (operation, current, nextState, unitOfWork, evidence = {}) => {
          const at = new Date().toISOString(),
            nextRecord = createPublishingLifecycleRecord({ ...nextState, changedAt: at }),
            operationReference = operation === "CreateDraft" ? id(next++) : c.operationReference;
          return executePublishingMutation(
            {
              tenantContext: tenantContext(c.actorReference, at),
              operation,
              expectedVersion: current?.version ?? 1,
              current,
              next: nextRecord,
              idempotencyKey: parsePublishingReference(operationReference),
              auditId: parsePublishingReference(id(next++)),
              correlationId: parsePublishingReference(operationReference),
              occurredAt: at,
              sourceChannel: parsePublishingCode("INTERNAL_TEST"),
              ...evidence,
            },
            {
              authorization: {
                authorize: async (request) =>
                  evaluatePermission({
                    tenantContext: request.tenantContext,
                    action: request.action,
                    resourceScope: request.resourceScope,
                    policySnapshotReference: parsePolicyReference(id(96007)),
                    policyVersion: parsePolicyVersion(1),
                    evidence: [
                      {
                        source: "ExplicitAllow",
                        evidenceReference: parseEvidenceReference(id(96008)),
                        action: request.action,
                        actorReference: c.actorReference,
                        roleReference: null,
                        brandReference: brand,
                        storeReference: null,
                        effectiveFrom: observedAt,
                        effectiveUntil: validUntil,
                      },
                    ],
                  }),
              },
              unitOfWork: { commit: unitOfWork },
            },
          );
        };
        const result = await work({ source, tx, execute, observedAt });
        if (afterWork) await afterWork();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const hook of hooks) await hook.guard();
        for (const hook of hooks) hook.final();
        await client.query("COMMIT");
        source.assertFinalized(tx);
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          sqlFailure &&
          (error instanceof PublishingContractError || error instanceof PublishingServiceError)
        )
          throw new Error(
            "Native review SQL failure " +
              sqlFailure.code +
              " at " +
              sqlFailure.stage +
              " (" +
              sqlFailure.kind +
              ")",
            { cause: error },
          );
        throw error;
      } finally {
        await client.end();
        active--;
      }
    };
    const submit = async (c, options = {}) =>
      run(
        c,
        async ({ source, tx, execute }) => {
          const original = await source.inspectOriginalOperation(tx, c);
          if (original.outcome !== "Absent") return original;
          return source.withOriginalOperation(tx, c, async (held) => {
            if (held.outcome !== "Absent") return held;
            const at = new Date().toISOString(),
              draft = createPublishingLifecycleRecord({
                lifecycleId: parsePublishingReference(id(next++)),
                familyReference: parsePublishingReference(c.ruleReference),
                configurationType: parsePublishingCode("OPTION_PRICE_RULE"),
                purposeCode: parsePublishingCode("OPTION_PRICE_RULE_PUBLICATION"),
                snapshotReference: parsePublishingReference(c.draftVersionReference),
                snapshotDigest: c.draftSnapshotDigest,
                scope,
                version: parsePublishingVersion(1),
                state: "Draft",
                validationEvidenceReference: null,
                approvalEvidenceReference: null,
                createdAt: at,
                changedAt: at,
              });
            const made = await execute("CreateDraft", null, draft, (input) =>
              held.createDraft(input),
            );
            const checkedAt = new Date().toISOString(),
              validation = createPublishingValidationEvidence({
                evidenceReference: parsePublishingReference(id(next++)),
                snapshotReference: draft.snapshotReference,
                snapshotDigest: draft.snapshotDigest,
                scope,
                result: "Pass",
                checkedAt,
                validUntil: c.validationValidUntil,
                checkCodes: [parsePublishingCode("OPTION_PRICE_DRAFT")],
              });
            const review = createPublishingLifecycleRecord({
              ...made.lifecycle,
              state: "InReview",
              version: parsePublishingVersion(2),
              validationEvidenceReference: validation.evidenceReference,
              changedAt: checkedAt,
            });
            return execute("SubmitReview", made.lifecycle, review, (input) => held.commit(input), {
              validationEvidence: validation,
            });
          });
        },
        options,
      );
    const resolve = (c, options = {}) =>
      run(c, ({ source, tx }) => source.resolveOperation(tx, c), options);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA bop_publishing,platform_helpers,platform_audit TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),bop_publishing.option_price_review_operation_available(uuid) TO " +
          role,
      );
      // Existing Publishing SRE lock ACL; immutable history trigger still rejects UPDATE.
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON bop_publishing.option_price_review_operation,platform_audit.audit_record TO " +
          role,
      );
      const c = command(),
        first = await submit(c);
      assert.equal(first.lifecycle.state, "InReview");
      const stored = await resolve(c);
      assert.equal(stored.outcome, "Committed");
      assert.equal(stored.mutation.operation, "SubmitReview");
      const afterFirst = await counts();
      assert.deepEqual(await submit(c), stored);
      assert.deepEqual(await counts(), afterFirst);
      const approvalUntil = new Date(
        Math.min(Date.parse(c.validationValidUntil), Date.now() + 2000),
      ).toISOString();
      const approvalCommand = command({
        actorReference: approver,
        action: "Approve",
        operationReference: id(next++),
        validationValidUntil: c.validationValidUntil,
        approvalValidUntil: approvalUntil,
        expectedLifecycle: {
          lifecycleReference: first.lifecycle.lifecycleId,
          version: 2,
          state: "InReview",
          latestMutationOperationReference: c.operationReference,
        },
      });
      await run(approvalCommand, async ({ source, tx, execute }) => {
        assert.equal(
          (await source.inspectOriginalOperation(tx, approvalCommand)).outcome,
          "Absent",
        );
        return source.withOriginalOperation(tx, approvalCommand, async (held) => {
          if (held.outcome !== "Absent") throw Error("Actual Absent required");
          const at = new Date().toISOString(),
            evidence = createPublishingApprovalEvidence({
              evidenceReference: parsePublishingReference(id(next++)),
              reviewLifecycleId: first.lifecycle.lifecycleId,
              reviewVersion: first.lifecycle.version,
              snapshotReference: snapshot,
              snapshotDigest,
              scope,
              decision: "Accepted",
              approvedActorReference: approver,
              approvedAt: at,
              validUntil: approvalUntil,
            }),
            approved = createPublishingLifecycleRecord({
              ...first.lifecycle,
              state: "Approved",
              version: parsePublishingVersion(3),
              approvalEvidenceReference: evidence.evidenceReference,
              changedAt: at,
            });
          return execute("Approve", first.lifecycle, approved, (input) => held.commit(input), {
            approvalEvidence: evidence,
          });
        });
      });
      const originalApproval = await resolve(approvalCommand),
        afterApproval = await counts();
      assert.equal(originalApproval.outcome, "Committed");
      assert.equal(originalApproval.mutation.audit.actor.reference, approver);
      // Observe actual natural expiry, no frozen current clock or renewed business evidence.
      const expiryEnd = Date.now() + 5000;
      while (Date.now() < Date.parse(c.validationValidUntil) && Date.now() < expiryEnd)
        await admin.query("SELECT clock_timestamp() AS actual_clock");
      assert.ok(Date.now() >= Date.parse(c.validationValidUntil));
      assert.ok(Date.now() >= Date.parse(approvalUntil));
      assert.deepEqual(await resolve(approvalCommand), originalApproval);
      assert.deepEqual(await resolve(c), stored);
      assert.deepEqual(await counts(), afterApproval);
      const absent = command({ ruleReference: id(next++), draftVersionReference: id(next++) }),
        beforeAbandon = await counts(),
        abandoned = await resolve(absent);
      assert.equal(abandoned.outcome, "Abandoned");
      assert.deepEqual(await submit(absent), abandoned);
      assert.deepEqual(await resolve(absent), abandoned);
      const afterAbandon = await counts();
      assert.equal(afterAbandon.terminals, beforeAbandon.terminals + 1);
      assert.equal(afterAbandon.audits, beforeAbandon.audits + 1);
      assert.equal(afterAbandon.mutations, beforeAbandon.mutations);
      assert.equal(afterAbandon.events, 0);
      const rollback = command({ ruleReference: id(next++), draftVersionReference: id(next++) }),
        beforeRollback = await counts();
      try {
        await assert.rejects(
          submit(rollback, {
            afterWork: async () => {
              allowed = false;
            },
          }),
        );
      } finally {
        allowed = true;
      }
      assert.deepEqual(await counts(), beforeRollback);
      const broken = command({ ruleReference: id(next++), draftVersionReference: id(next++) });
      await assert.rejects(
        submit(broken, {
          beforeQuery: async (sql, values) => {
            if (
              sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record") &&
              values[7] === "SubmitReview"
            )
              throw Error("SYNTHETIC_FAILURE_AFTER_ACTUAL_DRAFT");
          },
        }),
      );
      assert.deepEqual(await counts(), beforeRollback);
      await assert.rejects(resolve({ ...c, actorReference: approver }));
      await assert.rejects(resolve({ ...c, selectedStoreReference: id(96099) }));
      assert.deepEqual(await counts(), beforeRollback);
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, id(96099)],
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM bop_publishing.option_price_review_operation",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      const attack = async (work) => {
        await admin.query("BEGIN");
        let code = null;
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          try {
            await work();
            await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
          } catch (error) {
            code =
              typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
                ? error.code
                : "UNCLASSIFIED";
          }
          assert.equal(code, "23514");
        } finally {
          await admin.query("ROLLBACK");
        }
        assert.deepEqual(await counts(), beforeRollback);
      };
      const rawMutation = async (operation, foreign = false) => {
        const clone = globalThis.structuredClone(stored.mutation);
        clone.idempotencyKey = operation;
        clone.audit.auditId = id(next++);
        clone.audit.correlationId = operation;
        clone.current.lifecycleId = id(next++);
        clone.next.lifecycleId = clone.current.lifecycleId;
        clone.next.familyReference = foreign ? id(next++) : clone.next.familyReference;
        clone.current.familyReference = clone.next.familyReference;
        clone.audit.targetId = clone.next.lifecycleId;
        const actual = parseRecordedPublishingMutation(clone);
        await admin.query(
          "INSERT INTO bop_publishing.publishing_mutation_record(tenant_id,brand_id,store_id,family_id,lifecycle_id,lifecycle_version,operation_id,operation_code,actor_id,audit_id,intent_hash,release_id,release_sequence,changed_at,mutation_json) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12::jsonb)",
          [
            tenant,
            brand,
            actual.next.familyReference,
            actual.next.lifecycleId,
            actual.next.version,
            actual.idempotencyKey,
            actual.operation,
            author,
            actual.audit.auditId,
            publishingRecordedMutationDigest(actual),
            actual.next.changedAt,
            actual,
          ],
        );
        return actual;
      };
      await attack(() => rawMutation(id(next++))); // matching reverse source without terminal
      await attack(() => rawMutation(absent.operationReference)); // permanent abandonment fences delayed writer
      const terminal = async (captured, mutation) =>
        admin.query(
          "INSERT INTO bop_publishing.option_price_review_operation(tenant_id,brand_id,selected_store_id,actor_id,operation_id,action_code,outcome_code,command_digest,command_json,recorded_at,audit_id,mutation_json,mutation_digest) VALUES($1,$2,$3,$4,$5,$6,'Committed',$7,$8::jsonb,$9,$10,$11::jsonb,$12)",
          [
            tenant,
            brand,
            store,
            captured.actorReference,
            captured.operationReference,
            captured.action,
            publishingOptionPriceReviewOperationDigest(captured),
            captured,
            mutation.audit.occurredAt,
            mutation.audit.auditId,
            mutation,
            publishingRecordedMutationDigest(mutation),
          ],
        );
      await attack(() =>
        terminal(command({ ...c, operationReference: c.operationReference }), stored.mutation),
      ); // historical mutation cannot provide same-tx terminal
      await attack(async () => {
        const op = id(next++),
          mutation = await rawMutation(op, true);
        await terminal(command({ ...c, operationReference: op }), mutation);
      }); // foreign rule source
      await attack(async () => {
        const op = id(next++),
          mutation = await rawMutation(op);
        await terminal(
          command({
            ...c,
            operationReference: op,
            draftSnapshotDigest: parsePublishingDigest("sha256:" + "b".repeat(64)),
          }),
          mutation,
        );
      }); // incoherent snapshot
      const signal = () => {
        let release;
        const promise = new Promise((resolveSignal) => {
          release = resolveSignal;
        });
        return { promise, release };
      };
      const finite = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((unused, reject) => {
              void unused;
              timer = setTimeout(() => reject(Error("Actual lock arrival absent")), 1500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const blocked = async (pid) => {
        const end = Date.now() + 1500;
        while (Date.now() < end) {
          if (
            (
              await admin.query(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='advisory') blocked",
                [pid],
              )
            ).rows[0].blocked === true
          )
            return;
        }
        throw Error("Actual blocked operation fence absent");
      };
      for (const winner of ["Submit", "Resolve"]) {
        const original = command({ ruleReference: id(next++), draftVersionReference: id(next++) }),
          before = await counts(),
          acquired = signal(),
          entered = signal(),
          release = signal();
        const exactKey =
          "PublishingOperation:" + tenant + ":" + brand + ":" + original.operationReference;
        const first = (winner === "Submit" ? submit : resolve)(original, {
          afterQuery: async (sql, values) => {
            if (sql.startsWith("SELECT pg_advisory_xact_lock") && values[0] === exactKey) {
              acquired.release();
              await release.promise;
            }
          },
        });
        let second;
        try {
          await finite(acquired.promise);
          second = (winner === "Submit" ? resolve : submit)(original, {
            beforeQuery: async (sql, values, pid) => {
              if (sql.startsWith("SELECT pg_advisory_xact_lock") && values[0] === exactKey)
                entered.release(pid);
            },
          });
          await blocked(await finite(entered.promise));
          release.release();
          const results = await Promise.allSettled([first, second]);
          assert.equal(results[0].status, "fulfilled");
          assert.equal(results[1].status, "fulfilled");
          const receipt = await resolve(original);
          assert.equal(receipt.outcome, winner === "Submit" ? "Committed" : "Abandoned");
          if (winner === "Submit") assert.deepEqual(results[1].value, receipt);
          else assert.deepEqual(results[0].value, results[1].value);
          const after = await counts();
          assert.equal(after.terminals, before.terminals + 1);
          assert.equal(after.mutations, before.mutations + (winner === "Submit" ? 2 : 0));
          assert.equal(after.audits, before.audits + (winner === "Submit" ? 2 : 1));
          assert.equal(after.events, 0);
        } finally {
          release.release();
          await Promise.allSettled(second ? [first, second] : [first]);
        }
      }
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
