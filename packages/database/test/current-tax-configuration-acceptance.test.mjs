import { seedPriceBook } from "../test-support/price-book-seed.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCurrentTaxConfigurationStore,
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
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
