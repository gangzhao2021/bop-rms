import { exerciseConfiguredJourneyQuote } from "../test-support/customer-configured-journey-quote.mjs";
import { exerciseAdditionalDiningPayment } from "../test-support/additional-dining-payment.mjs";
import { exerciseDiningSecondBatchSubmission } from "../test-support/dining-second-batch-submission.mjs";
import { exerciseDiningPaidCartContinuation } from "../test-support/dining-paid-cart-continuation.mjs";
import { createPersistentAdditionalDiningPreparation } from "../../../apps/api/src/customer-additional-dining-preparation.ts";
import { createPostgresDiningOrderPreparationSource } from "../../rms/ordering/src/index.ts";
import {
  createCustomerDiningSessionTipSelection,
  createCustomerConfiguredDiningSessionTipSelection,
} from "../../../apps/api/src/customer-session-tip-selection.ts";
import {
  createCustomerDiningSessionOrderSubmission,
  createCustomerConfiguredDiningSessionOrderSubmission,
} from "../../../apps/api/src/customer-session-order-submission.ts";
import { createPostgresCheckoutSessionAllocationStore } from "../../rms/ordering/src/index.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import {
  createCustomerDiningSessionValidation,
  createCustomerConfiguredDiningSessionValidation,
} from "../../../apps/api/src/customer-dining-session-validation.ts";
import { exerciseSubmissionInventoryPayment } from "../test-support/submission-inventory-payment.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { exerciseCustomerCheckoutDetails } from "../test-support/customer-checkout-details.mjs";
import { exerciseCustomerOrderHttp } from "../test-support/customer-order-http.mjs";
import { deriveConfiguredPaymentPreparationAmounts } from "../../rms/payment/src/index.ts";
import { createCustomerConfiguredDiningTipSelectionComposition } from "../../../apps/api/src/customer-dining-tip-selection-composition.ts";
import { createCustomerConfiguredDiningPaymentAuthorization } from "../../../apps/api/src/customer-dining-payment-authorization.ts";
import {
  createPostgresConfiguredPriceQuoteStore,
  createPostgresConfiguredPriceQuoteHistoryReader,
} from "../../rms/pricing/src/index.ts";
import { createPostgresConfiguredCartQuoteStore } from "../../rms/ordering/src/index.ts";
import { createPostgresCatalogOrderSnapshotSource } from "../../rms/catalog/src/index.ts";
import { createCustomerConfiguredOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import { createCustomerConfiguredDiningOrderSubmissionComposition } from "../../../apps/api/src/customer-dining-order-submission-composition.ts";
import { exerciseDiningQuoteHttp } from "../test-support/dining-quote-http.mjs";
import { createCustomerOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import { createSubmissionPricingFixture } from "../test-support/submission-pricing-fixture.mjs";
import { createPostgresPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import { seedCheckoutCatalog, cartCatalogTables } from "../test-support/cart-catalog-seed.mjs";
import { createPostgresCatalogSelectionService } from "../../rms/catalog/src/index.ts";
import {
  createPostgresKillSwitchQueryStore,
  createFeatureControlDefinition,
} from "../../bop/feature-control/src/index.ts";
import { createCustomerDiningPaymentAuthorization } from "../../../apps/api/src/customer-dining-payment-authorization.ts";
import {
  createCustomerDiningCheckoutComposition,
  diningOrderCapacityLinkFromHistory,
} from "../../../apps/api/src/customer-dining-checkout-composition.ts";
import { createCustomerDiningTipSelectionComposition } from "../../../apps/api/src/customer-dining-tip-selection-composition.ts";
import {
  createCustomerPaymentKillSwitch,
  verifyPaymentProviderAdmission,
  createPostgresPaymentTipSelectionStore,
  derivePaymentPreparationAmounts,
} from "../../rms/payment/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import {
  orderSubmissionFixture,
  id,
} from "../../../apps/api/test-support/dining-order-submission-fixture.ts";
import { createCustomerDiningOrderSubmissionComposition } from "../../../apps/api/src/customer-dining-order-submission-composition.ts";
import {
  createPostgresGuestSessionEntryStore,
  createGuestSessionRecord,
} from "../../bop/identity/src/index.ts";
import {
  createDiningTable,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningCheckoutCommitmentStore,
} from "../../rms/dining/src/index.ts";
import {
  createPostgresCartQueryStore,
  createPostgresCartQuoteStore,
  createPostgresInventoryFinalizedOrderCreationRepository,
} from "../../rms/ordering/src/index.ts";
const { Client } = pg;

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "submits through persisted Identity, Dining, Cart/Quote and atomic Ordering and recovers the original after response loss (configured=%s, positive=%s)",
  async (configured, positive) => {
    await withIsolatedDatabase({ caseId: "wp2402_composed" }, async (env) => {
      const checkoutJourney = { tenantReference: id(1) };
      const admin = new Client(env.clientConfig);
      await admin.connect();
      const observedAt = new Date(Date.now() - 1000).toISOString();
      const before = (minutes) => new Date(Date.parse(observedAt) - minutes * 60_000).toISOString();
      const after = (instant, minutes) =>
        new Date(Date.parse(instant) + minutes * 60_000).toISOString();
      const f = orderSubmissionFixture(observedAt);
      const scope = { brandReference: id(2), storeReference: id(3) };
      const ownerScope = { tenantReference: id(1), ...scope };
      assert.equal(checkoutJourney.tenantReference, ownerScope.tenantReference);
      const roles = ["i", "d", "o", "p", "k", "c", "q", "r"].map(
        (suffix) => "wp2402_comp_" + suffix + "_" + env.runId,
      );
      let quoteHttp;
      let active = 0,
        lost = false,
        sealLost = false,
        tipLost = false;
      let failOrderAudit = false,
        orderAuditFailed = false;
      const runner = (role, loseOrderAck = false, loseSealAck = false, loseTipAck = false) => ({
        async acquire() {
          const client = new Client(env.clientConfig);
          await client.connect();
          active++;
          try {
            await client.query("SET ROLE " + role);
            await client.query("SET lock_timeout='5s'");
          } catch (error) {
            await client.end();
            active--;
            throw error;
          }
          let released = false;
          return {
            query: (sql, values) => client.query(sql, [...values]),
            release: async () => {
              if (released) return;
              released = true;
              try {
                await client.end();
              } finally {
                active--;
              }
            },
          };
        },

        async run(action) {
          const client = new Client({
            ...env.clientConfig,
            connectionTimeoutMillis: 2000,
            query_timeout: 10000,
          });
          await client.connect();
          active++;
          let committed = false,
            wroteOrder = false,
            wroteSeal = false,
            wroteTip = false;
          try {
            await client.query(
              role === roles[5] || role === roles[7]
                ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
                : role === roles[4]
                  ? "BEGIN READ ONLY"
                  : "BEGIN",
            );
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='5s'");
            const result = await action({
              query: async (sql, values) => {
                if (sql.startsWith("INSERT INTO rms_ordering.order_header")) wroteOrder = true;
                if (sql.startsWith("INSERT INTO rms_payment.payment_tip_selection"))
                  wroteTip = true;
                if (
                  sql.startsWith("INSERT INTO rms_dining.dining_checkout_commitment") &&
                  values[7] === 2
                )
                  wroteSeal = true;
                if (
                  failOrderAudit &&
                  wroteOrder &&
                  sql.startsWith("UPDATE platform_audit.audit_chain_head")
                ) {
                  orderAuditFailed = true;
                  throw new Error("synthetic Order Audit failure after detail link");
                }
                return client.query(sql, [...values]);
              },
            });
            await client.query("COMMIT");
            committed = true;
            if (loseTipAck && wroteTip && !tipLost) {
              tipLost = true;
              throw new Error("synthetic post-tip response loss");
            }
            if (loseSealAck && wroteSeal && !sealLost) {
              sealLost = true;
              throw new Error("synthetic post-seal response loss");
            }
            if (loseOrderAck && wroteOrder && !lost) {
              lost = true;
              throw new Error("synthetic post-commit response loss");
            }
            return result;
          } catch (error) {
            if (!committed) await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
            active--;
          }
        },
      });
      try {
        for (const role of roles) {
          assert.match(role, /^wp2402_comp_[idopkcqr]_[a-f0-9]+$/u);
          await admin.query(
            "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
          );
          await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + role);
          await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
          await admin.query(
            "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
              role,
          );
        }
        await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + roles[0]);
        await admin.query(
          "GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation TO " +
            roles[0],
        );
        await admin.query(
          "GRANT UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO " +
            roles[0],
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_dining,platform_audit TO " + roles[1]);
        await admin.query(
          "GRANT SELECT,UPDATE ON rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_participant TO " +
            roles[1],
        );
        await admin.query("GRANT SELECT ON rms_dining.dining_identity_admission TO " + roles[1]);
        await admin.query(
          "GRANT SELECT,INSERT ON rms_dining.dining_checkout_commitment TO " + roles[1],
        );
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_ordering,platform_eventing,platform_audit TO " + roles[2],
        );
        await admin.query("GRANT SELECT,UPDATE ON rms_ordering.cart TO " + roles[2]);
        await admin.query("GRANT DELETE ON rms_ordering.cart_line TO " + roles[2]);
        await admin.query(
          "GRANT SELECT ON rms_ordering.cart_line,rms_ordering.cart_quote_expiry_record TO " +
            roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line,rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_revision,rms_ordering.order_batch,rms_ordering.order_item,rms_ordering.order_number_allocation,rms_ordering.order_capacity_link,platform_eventing.outbox_event TO " +
            roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_number_counter TO " + roles[2],
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_payment,platform_audit TO " + roles[3]);
        await admin.query(
          "GRANT SELECT,INSERT ON rms_payment.payment_tip_selection TO " + roles[3],
        );
        for (const role of roles.slice(1, 4)) {
          await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
          await admin.query(
            "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role,
          );
        }
        await admin.query("GRANT USAGE ON SCHEMA bop_feature_control TO " + roles[4]);
        await admin.query("GRANT SELECT ON bop_feature_control.kill_switch_version TO " + roles[4]);
        await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_audit TO " + roles[6]);
        await admin.query(
          "GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,platform_audit.audit_record TO " +
            roles[6],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + roles[6],
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + roles[7]);
        await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + roles[7]);
        const snapshot = await f.options.preparation.dining.current.readCurrent({ observedAt });
        assert(snapshot);
        const session = { ...snapshot.session, startedAt: before(180) };
        const participant = { ...snapshot.participant, joinedAt: before(179) };
        const admission = { ...snapshot.admission, issuedAt: before(179), consumedAt: before(178) };
        const table = createDiningTable({
          ...ownerScope,
          tableReference: id(6),
          stableLabel: "SYNTHETIC-COMPOSED",
          areaReference: id(7000),
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle: "Published",
          qrStatus: "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: id(4),
          aggregateVersion: 7,
          createdAt: before(240),
          observedAt: before(180),
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
          [id(6), id(1), id(2), id(3), 7, JSON.stringify(table), table.createdAt, table.observedAt],
        );
        await admin.query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
          [
            id(4),
            id(1),
            id(2),
            id(3),
            id(6),
            5,
            "Active",
            JSON.stringify(session),
            session.startedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
          [id(8), id(1), id(2), id(3), id(4), 1, "Active", JSON.stringify(participant)],
        );
        await admin.query(
          "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
          [
            admission.admissionReference,
            id(1),
            id(2),
            id(3),
            id(4),
            id(8),
            2,
            "Consumed",
            JSON.stringify(admission),
          ],
        );

        const identity = createPostgresGuestSessionEntryStore(runner(roles[0]), scope);
        const credentials = f.options.preparation.session.credentials;
        const parentCredential = credentials.generateCredential("Session");
        const parentCsrf = credentials.generateCredential("Csrf");
        const original = f.identityRecord;
        const parentAt = before(180),
          boundAt = before(177);
        const parent = createGuestSessionRecord({
          ...original,
          session: {
            ...original.session,
            sessionReference: id(5000),
            version: 1,
            diningState: "ContextOnly",
            diningSessionReference: null,
            diningParticipantReference: null,
            rotatedFromGuestSessionReference: null,
            createdAt: parentAt,
            lastSeenAt: parentAt,
            idleExpiresAt: after(parentAt, 240),
            absoluteExpiresAt: after(parentAt, 1440),
          },
          sessionSelectorHash: credentials.hashCredential("Session", parentCredential),
          csrfSelectorHash: credentials.hashCredential("Csrf", parentCsrf),
          operationReference: id(5001),
        });
        await identity.create({ record: parent });
        const bound = createGuestSessionRecord({
          ...original,
          session: {
            ...original.session,
            version: 1,
            createdAt: boundAt,
            lastSeenAt: boundAt,
            idleExpiresAt: after(boundAt, 240),
            absoluteExpiresAt: after(boundAt, 1440),
            rotatedFromGuestSessionReference: parent.session.sessionReference,
          },
        });
        await identity.rotate({
          currentSelectorHash: parent.sessionSelectorHash,
          expectedVersion: 1,
          nextRecord: bound,
          reason: "BindingChanged",
          observedAt: boundAt,
        });
        f.options.preparation.session.store = identity;
        f.options.preparation.dining.current = createPostgresDiningGuestBindingStore(
          runner(roles[1]),
          ownerScope,
        );
        const commitment = createPostgresDiningCheckoutCommitmentStore(
          runner(roles[1]),
          ownerScope,
          {
            now: f.options.preparation.now,
          },
        );
        f.options.preparation.dining.repository = commitment;
        f.options.preparation.submissions = commitment;

        const cart = await f.options.checkout.repository.loadCart(id(11));
        let quote = await f.options.checkout.repository.loadQuote(id(11));
        assert(cart && quote);
        await seedSubmissionCart(admin, { cart });
        const source = f.options.ordering.source.load;
        const commercialFixture = await source({ evidence: null });
        const { attached: selectionEvidence, catalogId } = await seedCheckoutCatalog(
          admin,
          id,
          observedAt,
          cart,
          scope,
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + roles[5]);
        await admin.query(
          "GRANT SELECT ON " +
            cartCatalogTables.map((table) => "rms_catalog." + table).join(",") +
            " TO " +
            roles[5],
        );
        const safety = (request, kind, status) => ({
          kind,
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          sellableReference: request.sellableReference,
          status,
          observedAt: request.observedAt,
          expiresAt: after(observedAt, 1),
          reasonCode: "SYNTHETIC_SAFETY",
        });
        f.options.checkout.catalog = createPostgresCatalogSelectionService(
          runner(roles[5]),
          {
            ...scope,
            menuReference: catalogId(1),
            sourceChannel: cart.sourceChannel,
            orderType: "DineIn",
            channelCode: selectionEvidence.catalogChannelCode,
            orderTypeCode: selectionEvidence.catalogOrderTypeCode,
          },
          {
            clock: { now: f.options.preparation.now },
            killSwitch: { loadEvidence: async (request) => safety(request, "KillSwitch", "Clear") },
            inventory: {
              loadEvidence: async (request) => safety(request, "Inventory", "Available"),
            },
          },
        );
        await admin.query(
          "UPDATE rms_catalog.product_version SET tax_classification_id=$1 WHERE product_version_id=$2",
          [
            commercialFixture.lines[0].catalog.taxClassificationReference,
            selectionEvidence.productVersionReference,
          ],
        );
        await admin.query(
          "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO " +
            roles[7],
        );
        let quoteConfiguration;
        const pricedQuote = await createSubmissionPricingFixture(
          cart,
          commercialFixture.lines[0].pricing,
          quote.quoteExpiresAt,
          {
            admin,
            readerTransactions: runner(roles[7]),
            configured,
            captureConfiguration: (value) => {
              quoteConfiguration = value;
            },
          },
        );
        assert.equal(pricedQuote.quoteReference, quote.quoteReference);
        if (!configured) assert.deepEqual(pricedQuote.total, quote.total);
        else
          quote = {
            ...quote,
            quoteVersion: 2,
            subtotal: pricedQuote.subtotal,
            discount: pricedQuote.discount,
            tax: pricedQuote.tax,
            fee: pricedQuote.fee,
            total: pricedQuote.total,
          };
        if (!configured) {
          let priceReference = 230000;
          await (
            configured ? createPostgresConfiguredPriceQuoteStore : createPostgresPriceQuoteStore
          )(runner(roles[6]), scope, {
            generateReference: () => id(++priceReference),
          }).append({
            quote: pricedQuote,
            audit: {
              auditId: id(230100),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "PRICING_QUOTE_CREATE",
              targetType: "PricingPriceQuote",
              targetId: pricedQuote.quoteReference,
              reasonCode: "AUTHORIZED_CART_QUOTE",
              correlationId: id(230101),
              occurredAt: pricedQuote.createdAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "SYNTHETIC_RETENTION",
              retentionPolicyVersion: 1,
            },
          });
        }
        const hash = (v) => "sha256:" + createHash("sha256").update(v).digest("hex");
        const quoteStore = (
          configured ? createPostgresConfiguredCartQuoteStore : createPostgresCartQuoteStore
        )(runner(roles[2]), scope, {
          hashIntent: hash,
          equals: (a, b) => a === b,
        });
        const attached = {
          ...quote,
          operationIntentHash: hash(
            "AttachQuote:" +
              JSON.stringify({
                cartReference: quote.cartReference,
                expectedCartVersion: quote.cartVersion,
                operationReference: quote.operationReference,
                requestedAt: quote.attachedAt,
              }),
          ),
        };
        if (configured) {
          quote = await exerciseConfiguredJourneyQuote({
            admin,
            runner,
            roles,
            journey: checkoutJourney,
            scope,
            ownerScope,
            identity: f.options.preparation,
            cart,
            id,
            configuration: quoteConfiguration,
            credentials,
            sessions: identity,
            sessionCredential: f.orderInput.sessionCredential,
            csrfCredential: f.orderInput.csrfCredential,
            now: f.options.preparation.now,
            hash,
            operationReference: quote.operationReference,
            catalogScope: {
              menuReference: catalogId(1),
              sourceChannel: cart.sourceChannel,
              channelCode: selectionEvidence.catalogChannelCode,
              orderTypeCode: selectionEvidence.catalogOrderTypeCode,
            },
            catalogSafety: {
              killSwitch: {
                loadEvidence: async (request) => safety(request, "KillSwitch", "Clear"),
              },
              inventory: {
                loadEvidence: async (request) => safety(request, "Inventory", "Available"),
              },
            },
          });
        } else {
          await quoteStore.attach({
            attachment: attached,
            expectedCartVersion: cart.aggregateVersion,
            audit: {
              auditId: id(6000),
              brandId: id(2),
              storeId: id(3),
              actor: { type: "System" },
              actionCode: "ORDERING_CART_ATTACH_QUOTE",
              targetType: "OrderingCart",
              targetId: cart.cartReference,
              reasonCode: "AUTHORIZED_CART_QUOTE",
              correlationId: id(6001),
              occurredAt: quote.attachedAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            },
          });
        }
        if (!configured)
          quoteHttp = await exerciseDiningQuoteHttp({
            admin,
            runner,
            roles,
            f,
            cart,
            pricedQuote,
            scope,
            ownerScope,
            id,
          });
        const cartStore = createPostgresCartQueryStore(runner(roles[2]), scope);
        f.options.checkout.repository = {
          loadCart: (reference) => cartStore.load(reference),
          loadQuote: (reference) =>
            quoteStore.loadLatest({
              cartReference: reference,
              cartVersion: cart.aggregateVersion,
              observedAt: f.options.preparation.now(),
            }),
        };
        let catalogReference = 210000;

        const orderSourceOptions = {
          scope,
          cartTransactions: runner(roles[2]),
          catalogTransactions: runner(roles[5]),
          pricingTransactions: runner(roles[7]),
          catalogScope: {
            menuReference: catalogId(1),
            sourceChannel: cart.sourceChannel,
            orderType: "DineIn",
            channelCode: selectionEvidence.catalogChannelCode,
            orderTypeCode: selectionEvidence.catalogOrderTypeCode,
          },
          catalogSafety: {
            killSwitch: { loadEvidence: async (request) => safety(request, "KillSwitch", "Clear") },
            inventory: {
              loadEvidence: async (request) => safety(request, "Inventory", "Available"),
            },
          },
          catalogReferences: { generate: () => id(++catalogReference), hash },
          clock: { now: f.options.preparation.now },
        };
        f.options.ordering.source = (
          configured
            ? createCustomerConfiguredOrderSourceComposition
            : createCustomerOrderSourceComposition
        )(orderSourceOptions);
        if (configured) {
          f.options.checkout.history = createPostgresConfiguredPriceQuoteHistoryReader(
            runner(roles[7]),
            scope,
          );
          f.options.checkout.snapshots = createPostgresCatalogOrderSnapshotSource(
            runner(roles[5]),
            { ...orderSourceOptions.catalogScope, ...scope },
            { ...orderSourceOptions.catalogSafety, clock: orderSourceOptions.clock },
            orderSourceOptions.catalogReferences,
          );
          f.options.checkout.pricingChannelCode =
            pricedQuote.lines[0].optionPrices[0].context.channelCode;
        }
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.checkout_details_record TO " + roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.order_checkout_details_link TO " + roles[2],
        );
        const checkoutDetails = await exerciseCustomerCheckoutDetails({
          journey: checkoutJourney,
          mode: "DineIn",
          scope,
          quoteVersion: configured ? 2 : 1,
          cart,
          quote,
          credentials: {
            sessionCredential: f.orderInput.sessionCredential,
            csrfCredential: f.orderInput.csrfCredential,
          },
          sessionTransactions: runner(roles[0]),
          cartTransactions: runner(roles[2]),
          detailsTransactions: runner(roles[2]),
          identity: f.options.preparation,
          now: f.options.preparation.now,
        });

        // Actual Identity/Dining reads on the allocation/session transaction. Base Store/QR
        // context remains the existing explicitly synthetic fixture binding.
        await admin.query("GRANT USAGE ON SCHEMA bop_identity,rms_dining TO " + roles[2]);
        await admin.query(
          "GRANT SELECT ON bop_identity.guest_session,rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_participant,rms_dining.dining_identity_admission TO " +
            roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.checkout_session_allocation,rms_ordering.checkout_session_record TO " +
            roles[2],
        );
        const sessionClock = () => new Date().toISOString();
        const diningSessionAccessOptions = {
          scope,
          transactions: runner(roles[2]),
          credentials: f.options.preparation.session.credentials,
          now: sessionClock,
          binding: (tx) =>
            createCustomerDiningSessionBinding({
              scope,
              binding: f.options.preparation.session.binding,
              repository: createPostgresDiningGuestBindingStore(
                { run: async (work) => work(tx) },
                ownerScope,
              ),
              contexts: f.options.preparation.contexts,
              now: sessionClock,
            }),
        };
        const sessionAllocationProposal = {
          ...scope,
          guestSessionReference: String(bound.session.sessionReference),
          createOperationReference: id(99200),
          checkoutSessionReference: id(99201),
          submissionReference: f.orderInput.submissionReference,
          paymentOperationReference: id(99202),
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: configured ? 2 : 1,
          allocatedAt: observedAt,
        };
        const diningSessionRequest = {
          createOperationReference: sessionAllocationProposal.createOperationReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: configured ? 2 : 1,
        };
        const sessionAccess = createCustomerCheckoutSessionAuthorization(
          diningSessionAccessOptions,
          {
            sessionCredential: f.orderInput.sessionCredential,
            csrfCredential: f.orderInput.csrfCredential,
            cartReference: cart.cartReference,
          },
        );
        const sessionAuthority = await sessionAccess.authorize(
          diningSessionRequest,
          sessionClock(),
        );
        assert(sessionAuthority);
        let sessionReference = 99300;
        const sessionAudit = (record, actionCode, occurredAt) => ({
          auditId: id(++sessionReference),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode,
          reasonCode: "AUTHORIZED_CHECKOUT_CREATE",
          targetType: "CheckoutSession",
          targetId: record.checkoutSessionReference,
          occurredAt,
          correlationId: id(++sessionReference),
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        });
        const sessionAllocationAudit = (record) =>
          sessionAudit(record, "ORDERING_CHECKOUT_SESSION_ALLOCATE", record.allocatedAt);
        const persistedDiningAllocation = await createPostgresCheckoutSessionAllocationStore(
          runner(roles[2]),
          scope,
          { authorize: sessionAccess.authorizeInTransaction, audit: sessionAllocationAudit },
        ).allocate(sessionAllocationProposal, sessionAuthority);
        const originalReferences = f.options.preparation.references;
        f.options.preparation.references = {
          generate: (purpose) =>
            purpose === "PaymentOperation"
              ? persistedDiningAllocation.paymentOperationReference
              : originalReferences.generate(purpose),
        };
        const submit = configured
          ? createCustomerConfiguredDiningOrderSubmissionComposition
          : createCustomerDiningOrderSubmissionComposition;
        // Dedicated isolated-database test role; these fixture grants are not runtime role policy.
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_inventory,rms_recipe,bop_workflow,bop_publishing TO " +
            roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rms_inventory,rms_recipe,bop_workflow,bop_publishing TO " +
            roles[2],
        );
        const inventoryRunner = () => runner(roles[2]);
        const stock = await seedSubmissionInventoryStock({
          admin,
          runner: inventoryRunner,
          ownerScope,
          actorReference: bound.session.sessionReference,
          at: observedAt,
          datedLot: configured,
        });
        await seedSubmissionInventoryRecipe({
          admin,
          scope: ownerScope,
          actorReference: bound.session.sessionReference,
          at: observedAt,
          cart,
          stock,
        });
        const workflow = await seedSubmissionInventoryWorkflow({
          runner: inventoryRunner,
          scope: ownerScope,
          actorReference: bound.session.sessionReference,
          at: observedAt,
          orderType: "DineIn",
        });
        let inventoryReference = 500000;
        const actualInventory = createCustomerSubmissionInventoryFinalizer({
          scope: ownerScope,
          stockSiteReference: stock.stockSiteReference,
          workflow,
          authorize: async (_tx, input) => input.actorReference === bound.session.sessionReference,
          resolveExpiryCutoff: stock.resolveExpiryCutoff,
          generateReference: () => id(++inventoryReference),
          audit: {
            reasonCode: "SYNTHETIC_SUBMISSION",
            sourceChannel: "CUSTOMER_PWA",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
        const inventoryState = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_set) AS sets," +
                "(SELECT count(*)::int FROM rms_inventory.submission_final_validation) AS finals," +
                "(SELECT reserved::text FROM rms_inventory.stock_balance WHERE account_id=$1) AS reserved",
              [stock.accountReference],
            )
          ).rows[0];
        let failInventory = false;
        let inventoryCalls = 0;
        // Keep call-count/boundary assertions while executing actual owner persistence.
        const inventory = {
          async finalize(input) {
            inventoryCalls++;
            assert.equal(input.cart.cartReference, cart.cartReference);
            assert.equal(input.record.order.storeReference, scope.storeReference);
            assert.equal("orderNumberAllocation" in input.record, false);
            const facts = await input.transaction.query(
              "SELECT current_setting('bop.store_id') AS store_id, (SELECT count(*)::int FROM rms_ordering.order_header) AS orders",
              [],
            );
            assert.equal(facts.rows[0].store_id, scope.storeReference);
            assert.equal(facts.rows[0].orders, 0);
            await actualInventory.finalize(input);
            if (failInventory)
              throw new Error("synthetic failure after actual inventory finalization");
          },
        };
        f.options.repository = (link, authorization) =>
          createPostgresInventoryFinalizedOrderCreationRepository(
            {
              query: runner(roles[2]),
              write: runner(roles[2], true),
            },
            scope,
            link,
            configured ? 2 : 1,
            {
              now: f.options.preparation.now,
              policies: checkoutDetails.policies,
              authorization: checkoutDetails.wrapAuthorization(authorization),
            },
            inventory,
          );

        await admin.query("UPDATE rms_catalog.sku SET lifecycle='Archived' WHERE sku_id=$1", [
          cart.items[0].sellableReference,
        ]);
        await assert.rejects(submit(f.options).create(f.orderInput), {
          code: "CHECKOUT_ITEM_UNAVAILABLE",
        });
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0].n,
          0,
        );
        assert.equal(lost, false);
        await admin.query("UPDATE rms_catalog.sku SET lifecycle='Active' WHERE sku_id=$1", [
          cart.items[0].sellableReference,
        ]);

        const preparedSessionOwner = await commitment.loadSubmission(
          f.orderInput.submissionReference,
        );
        assert(preparedSessionOwner);
        const diningSessionAllocation = persistedDiningAllocation;
        const diningValidation = (
          configured
            ? createCustomerConfiguredDiningSessionValidation
            : createCustomerDiningSessionValidation
        )({ preparation: f.options.preparation, checkout: f.options.checkout });
        const diningValidationInput = {
          sessionCredential: f.orderInput.sessionCredential,
          csrfCredential: f.orderInput.csrfCredential,
          allocation: diningSessionAllocation,
          request: {
            createOperationReference: diningSessionAllocation.createOperationReference,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            quoteReference: quote.quoteReference,
            quoteVersion: configured ? 2 : 1,
          },
        };
        const diningEvidence = await diningValidation(diningValidationInput);
        assert.equal(
          diningEvidence.fulfillment.evidenceReference,
          preparedSessionOwner.commitmentReference,
        );
        assert.equal(diningEvidence.quoteVersion, configured ? 2 : 1);
        await assert.rejects(
          diningValidation({
            ...diningValidationInput,
            allocation: {
              ...diningSessionAllocation,
              paymentOperationReference: id(99203),
            },
          }),
        );

        const diningSessionCreator = createCustomerCheckoutSessionComposition({
          ...diningSessionAccessOptions,
          quoteVersion: configured ? 2 : 1,
          nextReference: () => id(++sessionReference),
          allocationAudit: sessionAllocationAudit,
          audit: (record) =>
            sessionAudit(record, "ORDERING_CHECKOUT_SESSION_CREATE", record.createdAt),
          validate: diningValidation,
        });
        const diningSessionEnvelope = {
          sessionCredential: f.orderInput.sessionCredential,
          csrfCredential: f.orderInput.csrfCredential,
          command: diningSessionRequest,
        };
        const diningCreated = await diningSessionCreator.create(diningSessionEnvelope);
        assert.equal(diningCreated.status, "Created");
        assert.equal(
          diningCreated.session.paymentOperationReference,
          preparedSessionOwner.paymentOperationReference,
        );
        assert.equal(
          diningCreated.session.submissionReference,
          preparedSessionOwner.submissionReference,
        );
        const diningRecovered = await diningSessionCreator.create(diningSessionEnvelope);
        assert.equal(diningRecovered.status, "AlreadyCreated");
        assert.deepEqual(diningRecovered.session, diningCreated.session);
        const diningSessionCounts = await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) AS allocations,(SELECT count(*)::int FROM rms_ordering.checkout_session_record) AS sessions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code IN ('ORDERING_CHECKOUT_SESSION_ALLOCATE','ORDERING_CHECKOUT_SESSION_CREATE')) AS audits",
        );
        assert.deepEqual(diningSessionCounts.rows[0], { allocations: 1, sessions: 1, audits: 2 });
        for (const policyMode of [
          "Missing",
          "Foreign",
          "Expired",
          "Changed",
          "Denied",
          "ChangedIdentity",
        ]) {
          checkoutDetails.setPolicy(policyMode);
          await assert.rejects(submit(f.options).create(f.orderInput));
          assert.equal(
            (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0]
              .n,
            0,
          );
        }
        checkoutDetails.setPolicy("DatabaseExpired");
        await assert.rejects(submit(f.options).create(f.orderInput), {
          code: "ORDER_CREATE_VALIDATION_EXPIRED",
        });
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0].n,
          0,
        );
        checkoutDetails.setPolicy("Ready");
        assert.equal(inventoryCalls, 0, "invalid catalog/policy must never reach Inventory");
        failInventory = true;
        await assert.rejects(submit(f.options).create(f.orderInput));
        assert.equal(inventoryCalls, 1);
        assert.deepEqual(await inventoryState(), { sets: 0, finals: 0, reserved: "0" });
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0].n,
          0,
        );
        failInventory = false;
        failOrderAudit = true;
        await assert.rejects(submit(f.options).create(f.orderInput));
        failOrderAudit = false;
        assert.equal(orderAuditFailed, true);
        assert.deepEqual(await inventoryState(), { sets: 0, finals: 0, reserved: "0" });
        assert.deepEqual(
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_ordering.order_header) AS orders,(SELECT count(*)::int FROM rms_ordering.order_checkout_details_link) AS links",
            )
          ).rows[0],
          { orders: 0, links: 0 },
        );
        const sessionOrders = (
          configured
            ? createCustomerConfiguredDiningSessionOrderSubmission
            : createCustomerDiningSessionOrderSubmission
        )(diningSessionAccessOptions, f.options);
        const sessionOrderInput = {
          sessionCredential: f.orderInput.sessionCredential,
          csrfCredential: f.orderInput.csrfCredential,
          checkoutSessionReference: diningCreated.session.checkoutSessionReference,
        };
        await assert.rejects(
          sessionOrders.create({ ...sessionOrderInput, paymentOperationReference: id(999) }),
          { code: "INPUT_INVALID" },
        );
        const httpOrder = await exerciseCustomerOrderHttp({
          journey: checkoutJourney,
          runtimeOptions: {
            scope,
            sessionTransactions: runner(roles[0]),
            cartTransactions: runner(roles[2]),
            identity: f.options.preparation,
            now: f.options.preparation.now,
          },
          expectedTotal: pricedQuote.total.amountMinor.toString(),
          orderType: "DineIn",
          create: async (command) => {
            const response = await sessionOrders.create({
              ...sessionOrderInput,
              sessionCredential: command.sessionCredential,
              csrfCredential: command.csrfCredential,
            });
            return { status: response.status, record: response.record };
          },
          quoteVersion: configured ? 2 : 1,
          input: f.orderInput,
        });
        assert.equal(lost, true);
        assert.equal(
          inventoryCalls,
          3,
          "Inventory runs for rejected attempt, rollback, and committed attempt only",
        );
        await assert.rejects(checkoutDetails.replaceForRecovery(), {
          code: "CART_VERSION_CONFLICT",
        });
        checkoutDetails.setPolicy("Expired");
        const recovered = await sessionOrders.create(sessionOrderInput);
        assert.deepEqual(recovered.session, diningCreated.session);
        assert.equal(recovered.status, "AlreadyCreated");
        assert.equal(inventoryCalls, 3, "original recovery must not repeat Inventory");
        const stockAfterRecovery = await inventoryState();
        assert.equal(stockAfterRecovery.sets, 1);
        assert.equal(stockAfterRecovery.finals, 1);
        assert.ok(Number(stockAfterRecovery.reserved) > 0);

        assert.equal(httpOrder.orderReference, recovered.record.order.orderReference);
        assert.equal(httpOrder.total.amountMinor, pricedQuote.total.amountMinor.toString());
        const detailsLink = (
          await admin.query(
            "SELECT order_id,details_id,details_version FROM rms_ordering.order_checkout_details_link",
          )
        ).rows;
        assert.deepEqual(detailsLink, [
          {
            order_id: httpOrder.orderReference,
            details_id: checkoutDetails.saved.snapshot.detailsReference,
            details_version: checkoutDetails.saved.snapshot.detailsVersion,
          },
        ]);

        assert.deepEqual(recovered.record.items[0].pricing.total, pricedQuote.lines[0].total);
        assert.equal(recovered.record.items[0].pricing.quoteInputDigest, pricedQuote.inputDigest);
        assert.equal(
          recovered.record.items[0].pricing.priceResolution.priceBookDigest,
          pricedQuote.lines[0].resolvedPrice.snapshotDigest,
        );
        assert.equal(
          recovered.record.items[0].pricing.taxConfigurationVersionReference,
          pricedQuote.lines[0].taxResolution.versionReference,
        );

        assert.deepEqual(recovered.record.items[0].catalog.localizedNames, { "en-CA": "Latte" });
        assert.deepEqual(recovered.record.items[0].catalog.options[0].localizedNames, {
          "en-CA": "Synthetic option",
        });
        assert.equal(recovered.record.items[0].catalog.productReference, catalogId(40));
        assert.equal(
          recovered.record.items[0].catalog.skuReference,
          cart.items[0].sellableReference,
        );

        await admin.query(
          "GRANT SELECT ON rms_ordering.additional_dining_batch_record,rms_ordering.order_acceptance_record,rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record,rms_ordering.order_batch_checkout_cancellation TO " +
            roles[2],
        );
        await admin.query(
          "GRANT UPDATE ON rms_ordering.order_header,rms_ordering.order_batch TO " + roles[2],
        );
        const parentSource = createPostgresDiningOrderPreparationSource({
          brandReference: recovered.record.order.brandReference,
          storeReference: recovered.record.order.storeReference,
          authorize: async () => true,
        });
        await runner(roles[2]).run(async (transaction) => {
          const query = {
            transaction,
            brandReference: recovered.record.order.brandReference,
            storeReference: recovered.record.order.storeReference,
            orderReference: recovered.record.order.orderReference,
            diningSessionReference: recovered.record.order.diningSessionReference,
            guestSessionReference: recovered.record.guestSessionReference,
            observedAt: recovered.record.createdAt,
          };
          const parent = await parentSource.resolve(query);
          assert.equal(parent.orderReference, recovered.record.order.orderReference);
          assert.equal(parent.orderVersion, 1);
          assert.equal(
            await parentSource.resolve({
              ...query,
              diningSessionReference: f.orderInput.submissionReference,
            }),
            null,
          );
        });
        const continuedCart = await admin.query(
          "SELECT aggregate_version,(SELECT count(*)::int FROM rms_ordering.cart_line l WHERE l.cart_id=c.cart_id) AS lines FROM rms_ordering.cart c WHERE c.cart_id=$1",
          [recovered.record.order.batches[0].sourceCartReference],
        );
        assert.equal(
          continuedCart.rows[0].aggregate_version,
          recovered.record.order.batches[0].sourceCartVersion + 1,
        );
        assert.equal(continuedCart.rows[0].lines, 0);
        const owner = await commitment.loadSubmission(f.orderInput.submissionReference);
        assert(owner);
        assert.equal(recovered.record.order.orderReference, owner.orderReference);
        const additionalPreparation = createPersistentAdditionalDiningPreparation({
          preparation: f.options.preparation,
          transactions: runner(roles[2]),
          authorizeOrder: async () => true,
        });
        const additionalInput = {
          sessionCredential: f.orderInput.sessionCredential,
          csrfCredential: f.orderInput.csrfCredential,
          orderReference: owner.orderReference,
          expectedOrderVersion: 1,
          intent: {
            submissionReference: owner.submissionReference,
            cartReference: owner.cartReference,
            cartVersion: owner.cartVersion,
            quoteReference: owner.quoteReference,
            sourceValidUntil: owner.preparationValidUntil,
          },
        };
        const currentPreparation = await additionalPreparation.prepareForOrdering(additionalInput);
        assert.equal(currentPreparation.record.orderReference, owner.orderReference);
        assert.equal(currentPreparation.record.commitmentReference, owner.commitmentReference);
        assert.equal(currentPreparation.expectedOrderVersion, 1);
        await assert.rejects(
          additionalPreparation.prepareForOrdering({
            ...additionalInput,
            expectedOrderVersion: 2,
          }),
        );

        assert.equal(
          recovered.record.order.batches[0].orderBatchReference,
          owner.orderBatchReference,
        );
        if (configured) {
          assert.equal(recovered.record.items[0].pricing.quoteVersion, 2);
          assert.equal(
            recovered.record.items[0].pricing.optionPrices[0].unitPrice.amountMinor,
            125n,
          );
        }
        const tipStore = createPostgresPaymentTipSelectionStore(
          runner(roles[3], false, false, true),
          scope,
          { now: f.options.preparation.now },
        );
        const tipOptions = {
          submission: f.options,
          tip: {
            repository: tipStore,
            audit: {
              create: async (record) => ({
                auditId: id(6200),
                brandId: id(2),
                storeId: id(3),
                actor: { type: "System" },
                actionCode: "PAYMENT_TIP_SELECT",
                targetType: "PaymentTipSelection",
                targetId: record.selectionReference,
                reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
                correlationId: id(6201),
                occurredAt: record.selectedAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
            },
          },
        };
        const { expectedCartVersion, ...submissionInput } = f.orderInput;
        const tipInput = {
          ...submissionInput,
          cartVersion: expectedCartVersion,
          selectionReference: id(6202),
          tip: { amountMinor: 175n, currencyCode: "CAD" },
        };
        const sessionTips = (
          configured
            ? createCustomerConfiguredDiningSessionTipSelection
            : createCustomerDiningSessionTipSelection
        )(diningSessionAccessOptions, tipOptions);
        const sessionTipInput = {
          sessionCredential: tipInput.sessionCredential,
          csrfCredential: tipInput.csrfCredential,
          checkoutSessionReference: diningCreated.session.checkoutSessionReference,
          selectionReference: tipInput.selectionReference,
          tip: tipInput.tip,
        };
        const selected = await sessionTips.select(sessionTipInput);
        assert.deepEqual(selected.session, diningCreated.session);
        await assert.rejects(
          sessionTips.select({
            ...sessionTipInput,
            tip: { amountMinor: 176n, currencyCode: "CAD" },
          }),
        );
        assert.equal(tipLost, true);
        assert.equal(selected.status, "Existing");
        assert.equal(selected.record.paymentOperationReference, owner.paymentOperationReference);
        assert.equal(selected.record.tip.amountMinor, 175n);
        const clockWriter = createPostgresDiningCheckoutCommitmentStore(
          runner(roles[1], false, true),
          ownerScope,
          { now: f.options.preparation.now },
        );
        f.options.clock = {
          repository: clockWriter,
          audit: {
            create: async (request) => ({
              ...(await f.options.preparation.dining.audit.create(request)),
              auditId: id(6100),
              actionCode: "DINING_CHECKOUT_SEAL",
            }),
          },
        };
        f.setTime(new Date().toISOString());
        const { session: paymentSession, ...firstClock } =
          await sessionOrders.preparePaymentClock(sessionOrderInput);
        assert.deepEqual(paymentSession, diningCreated.session);
        assert.equal(sealLost, true);
        assert.equal(firstClock.clock.state, "PaymentPending");
        const amounts = (
          configured ? deriveConfiguredPaymentPreparationAmounts : derivePaymentPreparationAmounts
        )({
          order: firstClock.order,
          selection: selected.record,
          paymentOperationReference: firstClock.clock.paymentOperationReference,
          requestedAt: firstClock.clock.paymentRequestedAt,
        });
        const originalAllocation = firstClock.order.items.reduce(
          (sum, item) => sum + item.pricing.total.amountMinor,
          0n,
        );
        assert.equal(amounts.orderAllocation.amountMinor, originalAllocation);
        assert.equal(amounts.total.amountMinor, originalAllocation + 175n);
        const claimAccess = (
          configured
            ? createCustomerConfiguredDiningPaymentAuthorization
            : createCustomerDiningPaymentAuthorization
        )(
          {
            preparation: f.options.preparation,
            ordering: f.options.repository(diningOrderCapacityLinkFromHistory(owner)),
          },
          {
            sessionCredential: f.orderInput.sessionCredential,
            csrfCredential: f.orderInput.csrfCredential,
          },
        );
        await exerciseSubmissionInventoryPayment({
          journey: checkoutJourney,
          positive,
          sessionPayment: {
            access: diningSessionAccessOptions,
            orders: sessionOrders,
            tips: sessionTips,
            input: sessionTipInput,
          },
          admin,
          runner: runner(roles[2]),
          role: roles[2],
          scope: ownerScope,
          stock,
          order: firstClock.order,
          clock: firstClock.clock,
          amounts,
          selection: selected.record,
          quoteVersion: configured ? 2 : 1,
          paymentWorkflow: workflow.payment,
          at: f.options.preparation.now(),
          authorize: async (_tx, request) => {
            const access = await claimAccess.authorize({
              action: "CreatePaymentIntent",
              submissionReference: request.submissionReference,
              paymentOperationReference: firstClock.clock.paymentOperationReference,
              observedAt: f.options.preparation.now(),
            });
            return access !== null && access.guestSessionReference === request.actorReference;
          },
        });

        if (positive) {
          f.setTime(new Date().toISOString());
          const continuation = await exerciseDiningPaidCartContinuation({
            admin,
            runner,
            roles,
            f,
            cart,
            scope,
            ownerScope,
            id,
            initialOrder: firstClock.order,
            initialQuote: quote,
          });
          if (configured) {
            const second = await exerciseDiningSecondBatchSubmission({
              admin,
              runner,
              roles,
              f,
              scope,
              ownerScope,
              id,
              continuation,
              sessionAccessOptions: diningSessionAccessOptions,
              initialOrder: firstClock.order,
              stock,
              workflow,
              orderSourceOptions,
            });
            f.setTime(new Date().toISOString());
            await exerciseAdditionalDiningPayment({
              journey: checkoutJourney,
              advanceClock: f.setTime,
              sessionPayment: second.sessionPayment,
              checkoutSession: second.checkout,
              combinedOrder: true,
              client: admin,
              runner: () => runner(roles[2]),
              scope: ownerScope,
              stock,
              initial: firstClock.order,
              snapshot: second.snapshot,
              guest: {
                identity: f.options.preparation,
                sessionCredential: f.orderInput.sessionCredential,
                csrfCredential: f.orderInput.csrfCredential,
                wrongCsrf: f.options.preparation.session.credentials.generateCredential("Csrf"),
                tipSelectionReference: second.tip.record.selectionReference,
              },
              workflow,
            });
          }
        }

        assert.equal(firstClock.order.order.orderReference, recovered.record.order.orderReference);
        assert.equal(
          Date.parse(firstClock.clock.capacityExpiresAt) -
            Date.parse(firstClock.clock.paymentRequestedAt),
          30 * 60_000,
        );
        const paymentAuthorityInput = {
          sessionCredential: f.orderInput.sessionCredential,
          csrfCredential: f.orderInput.csrfCredential,
          intent: {
            commitmentReference: owner.commitmentReference,
            cartReference: owner.cartReference,
            cartVersion: owner.cartVersion,
            quoteReference: owner.quoteReference,
            submissionReference: owner.submissionReference,
            orderReference: owner.orderReference,
            orderBatchReference: owner.orderBatchReference,
            paymentOperationReference: owner.paymentOperationReference,
            sourceValidUntil: owner.preparationValidUntil,
          },
        };
        f.setTime(after(observedAt, 6));
        assert.deepEqual(
          (
            await createCustomerDiningCheckoutComposition(f.options.preparation).authorizePayment(
              paymentAuthorityInput,
            )
          ).record,
          firstClock.clock,
        );

        const paymentAccess = (
          configured
            ? createCustomerConfiguredDiningPaymentAuthorization
            : createCustomerDiningPaymentAuthorization
        )(
          {
            preparation: f.options.preparation,
            ordering: f.options.repository(diningOrderCapacityLinkFromHistory(owner)),
          },
          {
            sessionCredential: f.orderInput.sessionCredential,
            csrfCredential: f.orderInput.csrfCredential,
          },
        );
        const paymentAccessRequest = {
          action: "CreatePaymentIntent",
          submissionReference: owner.submissionReference,
          paymentOperationReference: owner.paymentOperationReference,
          observedAt: f.options.preparation.now(),
        };
        assert.deepEqual(await paymentAccess.authorize(paymentAccessRequest), {
          action: "CreatePaymentIntent",
          guestSessionReference: bound.session.sessionReference,
          ...scope,
        });

        const switchDefinition = (version, phase) =>
          createFeatureControlDefinition({
            controlId: id(90020),
            key: "payment.provider.admission",
            version,
            ownerReference: id(90021),
            purposeCode: "PAYMENT_SAFETY",
            scope: { kind: "Store", ...scope },
            effectiveFrom: f.options.preparation.now(),
            effectiveUntil: null,
            reviewAt: f.options.preparation.now(),
            expiresAt: null,
            kind: "KillSwitch",
            defaultActive: true,
            mode: "BlockNew",
            inFlightPolicy: "AllowToComplete",
            recoveryPolicy: "Manual",
            recoveryStages: [],
            state: { phase },
          });
        const writeSwitch = async (version, phase) => {
          const d = switchDefinition(version, phase);
          await admin.query(
            "INSERT INTO bop_feature_control.kill_switch_version(brand_id,store_id,control_id,control_key,control_version,definition_json,recorded_at,audit_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
            [
              scope.brandReference,
              scope.storeReference,
              d.controlId,
              d.key,
              version,
              JSON.stringify(d),
              f.options.preparation.now(),
              id(90022),
            ],
          );
        };
        await writeSwitch(1, "Inactive");
        const paymentSafety = createCustomerPaymentKillSwitch(
          {
            authorization: paymentAccess,
            definitions: createPostgresKillSwitchQueryStore(runner(roles[4]), scope),
            scope,
            clock: { now: () => f.options.preparation.now() },
            rollout: { bucketForGuest: () => 0 },
          },
          {
            paymentOperationReference: paymentAccessRequest.paymentOperationReference,
            submissionReference: paymentAccessRequest.submissionReference,
          },
        );
        const safetyRequest = () => ({
          action: "CreatePaymentIntent",
          key: "payment.provider.admission",
          ...scope,
          evaluatedAt: f.options.preparation.now(),
        });
        assert.equal(
          verifyPaymentProviderAdmission(
            await paymentSafety.evaluate(safetyRequest()),
            safetyRequest(),
          ).inFlightPolicy,
          "AllowToComplete",
        );
        await writeSwitch(2, "Active");
        assert.equal(
          verifyPaymentProviderAdmission(
            await paymentSafety.evaluate(safetyRequest()),
            safetyRequest(),
          ),
          null,
        );
        await writeSwitch(3, "Inactive");

        const expiredReplay = await submit(f.options).create(f.orderInput);
        assert.deepEqual(expiredReplay, { status: recovered.status, record: recovered.record });
        const { session: clockReplaySession, ...recoveredClock } =
          await sessionOrders.preparePaymentClock(sessionOrderInput);
        assert.deepEqual(clockReplaySession, diningCreated.session);
        assert.deepEqual(recoveredClock, firstClock);
        assert.deepEqual(await sessionTips.select(sessionTipInput), selected);
        await assert.rejects(
          sessionTips.select({ ...sessionTipInput, selectionReference: id(6203) }),
        );
        await assert.rejects(
          (configured
            ? createCustomerConfiguredDiningTipSelectionComposition
            : createCustomerDiningTipSelectionComposition)(tipOptions).select({
            ...tipInput,
            selectionReference: id(6203),
          }),
        );
        assert.equal(
          Number(
            (await admin.query("SELECT count(*) AS count FROM rms_payment.payment_tip_selection"))
              .rows[0].count,
          ),
          configured && positive ? 2 : 1,
        );
        assert.equal(
          Number(
            (
              await admin.query(
                "SELECT count(*) AS count FROM platform_audit.audit_record WHERE action_code='PAYMENT_TIP_SELECT'",
              )
            ).rows[0].count,
          ),
          configured && positive ? 2 : 1,
        );
        const counts = await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.order_header) AS orders,(SELECT count(*)::int FROM rms_ordering.order_capacity_link) AS links,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderCreated') AS events,(SELECT count(*)::int FROM rms_dining.dining_checkout_commitment) AS commitments",
        );
        assert.deepEqual(counts.rows[0], {
          orders: 1,
          links: configured && positive ? 2 : 1,
          events: 1,
          commitments: configured && positive ? 4 : 2,
        });

        await identity.revoke({
          selectorHash: bound.sessionSelectorHash,
          expectedVersion: 1,
          reason: "RiskChanged",
          observedAt: f.options.preparation.now(),
          operationReference: id(6002),
          operationIntentHash: credentials.hashOperationIntent("synthetic composed revocation"),
        });
        if (quoteHttp !== undefined) await quoteHttp.assertRevoked();
        await assert.rejects(sessionOrders.create(sessionOrderInput));
        await assert.rejects(sessionOrders.preparePaymentClock(sessionOrderInput));
        await assert.rejects(sessionTips.select(sessionTipInput));
        assert.equal(await paymentAccess.authorize(paymentAccessRequest), null);
        await assert.rejects(
          paymentSafety.evaluate(safetyRequest()),
          /customer payment safety unavailable/,
        );
        await assert.rejects(submit(f.options).create(f.orderInput));
        await assert.rejects(
          (configured
            ? createCustomerConfiguredDiningTipSelectionComposition
            : createCustomerDiningTipSelectionComposition)(tipOptions).select(tipInput),
        );
        await assert.rejects(
          createCustomerDiningCheckoutComposition(f.options.preparation).authorizePayment(
            paymentAuthorityInput,
          ),
        );
        assert.equal(active, 0);
      } finally {
        await checkoutJourney.runtime?.shutdown("SIGTERM");
        if (quoteHttp !== undefined) await quoteHttp.close();
        await admin.query("ROLLBACK");
        assert.equal(active, 0);
        for (const role of [...roles].reverse()) {
          await admin.query("DROP OWNED BY " + role);
          await admin.query("DROP ROLE IF EXISTS " + role);
        }
        await admin.end();
      }
    });
  },
);
