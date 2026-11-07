import { seedPriceBook } from "../test-support/price-book-seed.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCurrentTaxConfigurationStore,
  createPostgresTaxConfigurationReferenceSourceStore,
  parseTaxConfigurationReferenceSourceSnapshot,
  createPostgresCurrentQuoteService,
  createPriceQuote,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedTaxConfiguration } from "../test-support/tax-configuration-seed.mjs";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("reads scoped persisted tax rules only with complete matching current evidence", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_tax_source" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_tax_source_" + context.runId;
    assert.match(role, /^wp2402_tax_source_[a-f0-9]+$/u);
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO " +
          role,
      );
      const fixture = input(),
        tax = fixture.taxConfiguration;
      await seedTaxConfiguration(admin, tax, id(900));
      let transactionMode = "BEGIN READ ONLY";
      let afterTaxRead = null;
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query(transactionMode);
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: async (sql, values) => {
                const value = await client.query(sql, [...values]);
                if (afterTaxRead !== null && sql.includes("FROM rms_pricing.tax_configuration b")) {
                  const callback = afterTaxRead;
                  afterTaxRead = null;
                  await callback();
                }
                return value;
              },
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
      const scope = { brandReference: tax.brandReference, storeReference: tax.storeReference };
      const complete = {
        registrationEvidence: tax.registrationEvidence,
        professionalEvidence: tax.professionalEvidence,
      };
      let supplied = complete,
        calls = 0;
      const evidence = {
        load: async (request) => {
          calls++;
          assert.equal(request.versionReference, tax.versionReference);
          assert.equal(request.snapshotDigest, tax.snapshotDigest);
          assert.equal(request.storeReference, tax.storeReference);
          return supplied;
        },
      };
      const reader = createPostgresCurrentTaxConfigurationStore(
        runner,
        scope,
        tax.currencyMetadata,
        evidence,
      );
      const request = {
        configurationReference: tax.configurationReference,
        observedAt: fixture.createdAt,
      };
      const loaded = await reader.load(request);
      assert.deepEqual(loaded, tax);
      assert.deepEqual(
        createPriceQuote({ ...fixture, taxConfiguration: loaded }),
        createPriceQuote(fixture),
      );
      assert.equal(loaded.rules[0].rate, tax.rules[0].rate);
      await admin.query(
        "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry TO " +
          role,
      );
      await seedPriceBook(admin, fixture.priceBook, id(910));
      const quoteRequest = { ...fixture };
      delete quoteRequest.priceBook;
      delete quoteRequest.taxConfiguration;
      delete quoteRequest.currencyMetadata;
      const quoteService = createPostgresCurrentQuoteService(runner, {
        scope,
        priceBookReference: fixture.priceBook.priceBookReference,
        taxConfigurationReference: tax.configurationReference,
        currencyMetadata: fixture.currencyMetadata,
        evidence,
        clock: { now: () => fixture.createdAt },
      });
      const quoteError = { code: "CURRENT_PRICE_BOOK_QUOTE_UNAVAILABLE" };
      const evidenceCalls = calls;
      await assert.rejects(quoteService.create(quoteRequest), quoteError);
      assert.equal(calls, evidenceCalls);
      transactionMode = "BEGIN ISOLATION LEVEL REPEATABLE READ";
      await assert.rejects(quoteService.create(quoteRequest), quoteError);
      assert.equal(calls, evidenceCalls);
      transactionMode = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
      afterTaxRead = async () => {
        await admin.query(
          "INSERT INTO rms_pricing.price_book_version (price_book_version_id,price_book_id,brand_id,version_number,snapshot_digest,lifecycle,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at) SELECT $1,price_book_id,brand_id,2,snapshot_digest,'Draft',currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at FROM rms_pricing.price_book_version WHERE price_book_version_id=$2",
          [id(911), fixture.priceBook.versionReference],
        );
        await admin.query(
          "UPDATE rms_pricing.price_book SET current_version_id=$1,aggregate_version=2 WHERE price_book_id=$2",
          [id(911), fixture.priceBook.priceBookReference],
        );
      };
      assert.deepEqual(await quoteService.create(quoteRequest), createPriceQuote(fixture));
      assert.equal(afterTaxRead, null);
      await assert.rejects(quoteService.create(quoteRequest), quoteError);
      transactionMode = "BEGIN READ ONLY";
      const before = calls;
      assert.equal(
        await createPostgresCurrentTaxConfigurationStore(
          runner,
          { ...scope, storeReference: id(901) },
          tax.currencyMetadata,
          evidence,
        ).load(request),
        null,
      );
      assert.equal(
        await createPostgresCurrentTaxConfigurationStore(
          runner,
          { ...scope, brandReference: id(902) },
          tax.currencyMetadata,
          evidence,
        ).load(request),
        null,
      );
      assert.equal(calls, before);
      const error = { code: "CURRENT_TAX_CONFIGURATION_UNAVAILABLE" };
      supplied = null;
      await assert.rejects(reader.load(request), error);
      supplied = {
        ...complete,
        registrationEvidence: { ...complete.registrationEvidence, status: "Unverified" },
      };
      await assert.rejects(reader.load(request), error);
      supplied = {
        ...complete,
        professionalEvidence: {
          ...complete.professionalEvidence,
          professionalReviewReference: id(903),
        },
      };
      await assert.rejects(reader.load(request), error);
      supplied = {
        ...complete,
        professionalEvidence: {
          ...complete.professionalEvidence,
          reviewedAt: new Date(Date.parse(fixture.createdAt) + 1).toISOString(),
        },
      };
      await assert.rejects(reader.load(request), error);
      supplied = complete;
      await assert.rejects(
        reader.load({ ...request, observedAt: tax.registrationEvidence.validUntil }),
        error,
      );
      await assert.rejects(
        createPostgresCurrentTaxConfigurationStore(
          runner,
          scope,
          { ...tax.currencyMetadata, metadataVersion: 2 },
          evidence,
        ).load(request),
        error,
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET updated_at=$1 WHERE tax_configuration_id=$2",
        [new Date(Date.parse(fixture.createdAt) + 1).toISOString(), tax.configurationReference],
      );
      assert.equal(await reader.load(request), null);
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET updated_at=$1 WHERE tax_configuration_id=$2",
        [fixture.createdAt, tax.configurationReference],
      );
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration_version (tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_time_zone,created_at) SELECT $1,tax_configuration_id,brand_id,store_id,2,snapshot_digest,'Draft',jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_time_zone,created_at FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=$2",
        [id(904), tax.versionReference],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1,aggregate_version=2 WHERE tax_configuration_id=$2",
        [id(904), tax.configurationReference],
      );
      assert.equal(await reader.load(request), null);
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_pricing.tax_configuration_version"))
          .rows[0].n,
        2,
      );
      // Actual selected-Store reference history, synthetic authority; no legal/tax applicability evidence claim.
      const refAt = new Date().toISOString(),
        future = new Date(Date.now() + 86400000).toISOString();
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_time_zone,created_at) SELECT $1,tax_configuration_id,brand_id,store_id,3,snapshot_digest,'Draft',jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,$2,effective_time_zone,$3 FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=$4",
        [id(7001), future, refAt, tax.versionReference],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET aggregate_version=3,updated_at=$1 WHERE tax_configuration_id=$2",
        [refAt, tax.configurationReference],
      );
      for (const [ref, store, code] of [
        [id(7002), tax.storeReference, "SYNTHETIC_PENDING"],
        [id(7003), id(7099), "SYNTHETIC_FOREIGN_STORE"],
      ])
        await admin.query(
          "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
          [ref, tax.brandReference, store, code, refAt, id(900)],
        );
      const referenceRequest = {
        purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
        brandReference: tax.brandReference,
        storeReference: tax.storeReference,
        actorReference: id(900),
        operationReference: id(7090),
        catalogIntentDigest: "sha256:" + "a".repeat(64),
      };
      let holds = 0,
        denyAt = 0;
      const source = createPostgresTaxConfigurationReferenceSourceStore({
        tenantReference: id(7091),
        brandReference: tax.brandReference,
        storeReference: tax.storeReference,
        actorReference: id(900),
        transactions: runner,
        clock: { now: () => new Date().toISOString() },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            void tx;
            assert.deepEqual(input.request, referenceRequest);
            assert.equal(input.permission, "pricing.tax-config.manage");
            if (++holds === denyAt) throw new Error("synthetic authority denied");
          },
        },
      });
      const references = await source.loadSnapshot(referenceRequest);
      assert.equal(holds, 2);
      assert.equal(references.roots.length, 2);
      assert.equal(references.versions.length, 3);
      assert.equal(references.crossStoreCoverage, "Unavailable");
      assert.ok(references.roots.every((r) => r.storeReference === tax.storeReference));
      assert.deepEqual(
        references.versions
          .find((v) => v.versionReference === tax.versionReference)
          .rules.map((r) => r.ruleReference)
          .sort(),
        tax.rules.map((r) => r.ruleReference).sort(),
      );
      assert.equal(
        references.versions.find((v) => v.versionReference === id(904)).isCurrentVersion,
        true,
      );
      assert.equal(
        references.versions.find((v) => v.versionReference === id(7001)).temporalStatus,
        "Future",
      );
      assert.equal(
        references.versions.find((v) => v.versionReference === id(7001)).rules.length,
        0,
      );
      assert.equal(
        references.roots.find((r) => r.configurationReference === id(7002)).currentVersionReference,
        null,
      );
      assert.deepEqual(
        parseTaxConfigurationReferenceSourceSnapshot(
          references,
          referenceRequest,
          new Date().toISOString(),
        ),
        references,
      );
      assert.equal(
        /professional|registration|tax_rate|receiptPresentation/.test(JSON.stringify(references)),
        false,
      );
      const unavailable = { code: "TAX_CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE" };
      await assert.rejects(
        source.loadSnapshot({ ...referenceRequest, storeReference: id(7099) }),
        unavailable,
      );
      denyAt = holds + 1;
      await assert.rejects(source.loadSnapshot(referenceRequest), unavailable);
      denyAt = holds + 2;
      await assert.rejects(source.loadSnapshot(referenceRequest), unavailable);
      denyAt = 0;
      assert.equal((await source.loadSnapshot(referenceRequest)).digest, references.digest);
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'SYNTHETIC_SUBMS',1,$4::timestamptz+interval '1 microsecond',$5,$4::timestamptz+interval '1 microsecond')",
        [id(7004), tax.brandReference, tax.storeReference, refAt, id(900)],
      );
      await assert.rejects(source.loadSnapshot(referenceRequest), unavailable);
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
