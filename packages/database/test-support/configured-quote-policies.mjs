import assert from "node:assert/strict";
import pg from "pg";
import { input } from "../../rms/ordering/src/tests/order-pricing-quote.fixture.ts";
import { seedPriceBook } from "./price-book-seed.mjs";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";
import { seedOptionPriceRule } from "./option-price-seed.mjs";
const { Client } = pg;

/** Actual restricted policy reads with synthetic commercial/tax configuration only. */
export async function prepareConfiguredQuotePolicies({ context, admin, f }) {
  const role = "wp2402_cqr_" + context.runId;
  assert.match(role, /^wp2402_cqr_[a-f0-9]+$/u);
  let created = false,
    active = 0,
    reads = 0;
  const cleanup = async () => {
    assert.equal(active, 0);
    if (created) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      created = false;
    }
  };
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
      "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO " +
        role,
    );
    const original = input(),
      orderType = f.cart.orderType;
    const source = {
      ...original,
      lines: original.lines.map((line) => ({
        ...line,
        priceContext: { ...line.priceContext, orderType },
        taxContext: { ...line.taxContext, orderType },
      })),
      taxConfiguration: {
        ...original.taxConfiguration,
        rules: original.taxConfiguration.rules.map((rule) => ({ ...rule, orderType })),
      },
    };
    const { priceBook, taxConfiguration, currencyMetadata, ...base } = source;
    await seedPriceBook(admin, priceBook, f.cart.createdByActorReference);
    await seedTaxConfiguration(admin, taxConfiguration, f.cart.createdByActorReference);
    for (const line of f.quote.lines)
      for (const option of line.optionPrices)
        await seedOptionPriceRule(admin, option.rule, f.cart.createdByActorReference);
    return {
      cleanup,
      reads: () => reads,
      policies: {
        priceBookReference: priceBook.priceBookReference,
        taxConfigurationReference: taxConfiguration.configurationReference,
        currencyMetadata,
        evidence: {
          load: async () => ({
            registrationEvidence: taxConfiguration.registrationEvidence,
            professionalEvidence: taxConfiguration.professionalEvidence,
          }),
        },
      },
      request: {
        base,
        options: f.quote.lines.flatMap((line) =>
          line.optionPrices.map((option) => ({
            lineReference: line.lineReference,
            bindingReference: option.rule.bindingReference,
            optionReference: option.rule.optionReference,
            selectedQuantity: option.selectedQuantity,
            taxBasis: option.taxBasis,
            taxClassificationReference: option.taxClassificationReference,
          })),
        ),
      },
      transactions: {
        async run(action) {
          const client = new Client({
            ...context.clientConfig,
            query_timeout: 5000,
            connectionTimeoutMillis: 2000,
          });
          await client.connect();
          active++;
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL statement_timeout='5s'");
            const value = await action({
              query: async (sql, values) => {
                reads++;
                return client.query(sql, [...values]);
              },
            });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
            active--;
          }
        },
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
