import { exerciseConfiguredJourneyQuote } from "../test-support/customer-configured-journey-quote.mjs";
import {
  createCustomerPickupSessionOrderSubmission,
  createCustomerConfiguredPickupSessionOrderSubmission,
} from "../../../apps/api/src/customer-session-order-submission.ts";
import { createPostgresCheckoutSessionAllocationStore } from "../../rms/ordering/src/index.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import {
  createCustomerPickupSessionValidation,
  createCustomerConfiguredPickupSessionValidation,
} from "../../../apps/api/src/customer-pickup-session-validation.ts";
import { exerciseSubmissionInventoryPayment } from "../test-support/submission-inventory-payment.mjs";
import { createPostgresSubmissionFinalValidationStore } from "../../rms/inventory/src/index.ts";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { exerciseCustomerCheckoutDetails } from "../test-support/customer-checkout-details.mjs";
import { exerciseCustomerOrderHttp } from "../test-support/customer-order-http.mjs";
import { deriveConfiguredPaymentPreparationAmounts } from "../../rms/payment/src/index.ts";
import { createCustomerConfiguredPickupSessionTipSelection } from "../../../apps/api/src/customer-session-tip-selection.ts";
import { createCustomerConfiguredPickupPaymentAuthorization } from "../../../apps/api/src/customer-pickup-payment-authorization.ts";
import {
  createPostgresConfiguredPriceQuoteStore,
  createPostgresConfiguredPriceQuoteHistoryReader,
} from "../../rms/pricing/src/index.ts";
import {
  createPostgresConfiguredCartQuoteStore,
  createPostgresConfiguredCartQuoteReader,
  parseConfiguredCartQuoteAttachment,
} from "../../rms/ordering/src/index.ts";
import { createPostgresCatalogOrderSnapshotSource } from "../../rms/catalog/src/index.ts";
import { createCustomerConfiguredOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import { createCustomerConfiguredPickupOrderSubmissionComposition } from "../../../apps/api/src/customer-pickup-order-submission-composition.ts";
import { createCustomerConfiguredPickupCapacitySources } from "../../../apps/api/src/customer-pickup-capacity-sources.ts";
import { createCustomerOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import { createSubmissionPricingFixture } from "../test-support/submission-pricing-fixture.mjs";
import { createPostgresPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import { seedCheckoutCatalog, cartCatalogTables } from "../test-support/cart-catalog-seed.mjs";
import {
  createPostgresCurrentSelectionFactsStore,
  resolveCurrentCatalogSelectionRules,
  createPostgresCatalogSelectionService,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresKillSwitchQueryStore,
  createFeatureControlDefinition,
} from "../../bop/feature-control/src/index.ts";
import { createCustomerPickupPaymentAuthorization } from "../../../apps/api/src/customer-pickup-payment-authorization.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import {
  createPostgresCartQuoteStore,
  createPostgresCartQueryStore,
  createPostgresCartQuoteReader,
  createPostgresInventoryFinalizedOrderCreationRepository,
  parseCartQuoteAttachment,
} from "../../rms/ordering/src/index.ts";
import {
  createPostgresGuestSessionEntryStore,
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
} from "../../bop/identity/src/index.ts";
import { createPostgresAsapCapacityStore } from "../../rms/fulfillment/src/index.ts";
import { createCustomerPickupCapacitySources } from "../../../apps/api/src/customer-pickup-capacity-sources.ts";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
} from "../../../apps/api/src/customer-pickup-checkout-composition.ts";
import { createCustomerPickupOrderSubmissionComposition } from "../../../apps/api/src/customer-pickup-order-submission-composition.ts";
import {
  createPostgresPaymentTipSelectionStore,
  createCustomerPaymentKillSwitch,
  verifyPaymentProviderAdmission,
  derivePaymentPreparationAmounts,
} from "../../rms/payment/src/index.ts";
import { createCustomerPickupSessionTipSelection } from "../../../apps/api/src/customer-session-tip-selection.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "prepares Pickup through persisted Identity, Cart, Quote and shared capacity with original recovery (configured=%s, positive=%s)",
  async (configured, positive) => {
    await withIsolatedDatabase({ caseId: "wp2402_pickup" }, async (env) => {
      const checkoutJourney = { tenantReference: id(1) };
      const admin = new Client(env.clientConfig);
      await admin.connect();
      const at = new Date(Date.now() - 1000).toISOString();
      let observedAt = at;
      const shift = (ms) => new Date(Date.parse(at) + ms).toISOString();
      const f = orderWriteFixture({ at, namespace: "01902402" });
      const cart = f.cart,
        scope = f.scope;
      const roles = ["i", "o", "f", "p", "k", "c", "q", "r"].map(
        (s) => "wp2402_pickup_" + s + "_" + env.runId,
      );
      let active = 0,
        lost = false,
        orderLost = false,
        sealLost = false,
        tipLost = false,
        sequence = 100000;
      let failOrderAudit = false,
        orderAuditFailed = false;
      const runner = (role, loseAck = false, loseOrderAck = false, loseTipAck = false) => ({
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
          const client = new Client(env.clientConfig);
          await client.connect();
          active++;
          let committed = false,
            wrote = false,
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
                if (sql.startsWith("INSERT INTO rms_fulfillment.capacity_asap_commitment"))
                  wrote = true;
                if (
                  sql.startsWith("INSERT INTO rms_fulfillment.capacity_asap_commitment") &&
                  values.includes("PaymentPending")
                )
                  wroteSeal = true;
                if (sql.startsWith("INSERT INTO rms_ordering.order_header")) wroteOrder = true;
                if (sql.startsWith("INSERT INTO rms_payment.payment_tip_selection"))
                  wroteTip = true;
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
            if (loseAck && wrote && !lost) {
              lost = true;
              throw new Error("synthetic lost capacity acknowledgement");
            }
            if (loseAck && wroteSeal && !sealLost) {
              sealLost = true;
              throw new Error("synthetic lost seal acknowledgement");
            }
            if (loseOrderAck && wroteOrder && !orderLost) {
              orderLost = true;
              throw new Error("synthetic lost Order acknowledgement");
            }
            if (loseTipAck && wroteTip && !tipLost) {
              tipLost = true;
              throw new Error("synthetic lost tip acknowledgement");
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
          await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
          await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + role);
          await admin.query(
            "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
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
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_ordering,platform_audit,platform_eventing TO " + roles[1],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_revision,rms_ordering.order_batch,rms_ordering.order_item,rms_ordering.order_number_allocation,rms_ordering.order_capacity_link,platform_eventing.outbox_event TO " +
            roles[1],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_number_counter TO " + roles[1],
        );
        await admin.query("GRANT SELECT,UPDATE ON rms_ordering.cart TO " + roles[1]);
        await admin.query(
          "GRANT SELECT ON rms_ordering.cart_line,rms_ordering.cart_quote_expiry_record TO " +
            roles[1],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line TO " +
            roles[1],
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment,platform_audit TO " + roles[2]);
        await admin.query("GRANT SELECT,UPDATE ON rms_fulfillment.capacity_slot TO " + roles[2]);
        await admin.query(
          "GRANT SELECT ON rms_fulfillment.capacity_slot_configuration,rms_fulfillment.capacity_hold,rms_fulfillment.capacity_hold_terminal,rms_fulfillment.capacity_allocation,rms_fulfillment.capacity_allocation_terminal TO " +
            roles[2],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_fulfillment.capacity_asap_commitment TO " + roles[2],
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
        await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_audit TO " + roles[6]);
        await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + roles[6]);
        await admin.query(
          "GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,platform_audit.audit_record TO " +
            roles[6],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + roles[6],
        );
        await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + roles[7]);
        await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + roles[7]);
        const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
        const sessionCredential = credentials.generateCredential("Session"),
          csrfCredential = credentials.generateCredential("Csrf");
        const guest = createGuestSessionRecord({
          session: {
            sessionReference: cart.createdByActorReference,
            status: "Active",
            version: 1,
            ...scope,
            publicStoreReference: id(90000),
            publicTableReference: null,
            channel: "Pickup",
            locale: "en-CA",
            qrReference: id(90001),
            qrRevocationVersion: 1,
            diningState: "ContextOnly",
            diningSessionReference: null,
            diningParticipantReference: null,
            createdAt: shift(-3_600_000),
            lastSeenAt: shift(-3_600_000),
            idleExpiresAt: shift(10_800_000),
            absoluteExpiresAt: shift(82_800_000),
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          },
          sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
          csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
          operationReference: id(90002),
          operationIntentHash: credentials.hashOperationIntent("synthetic Pickup entry"),
        });
        const sessions = createPostgresGuestSessionEntryStore(runner(roles[0]), scope);
        await sessions.create({ record: guest });
        await seedSubmissionCart(admin, f);
        // Explicit synthetic original binding history for the existing seeded Cart/Guest.
        await admin.query("GRANT SELECT ON rms_ordering.cart_binding_record TO " + roles[1]);
        await admin.query(
          `INSERT INTO rms_ordering.cart_binding_record
          (operation_id,revision,brand_id,store_id,cart_id,guest_session_id,predecessor_session_id,acknowledged_at,prepared_at,valid_until,activated_at)
          VALUES ($1,1,$2,$3,$4,$5,$6,$7,$7,$7::timestamptz+interval '15 minutes',NULL),
                 ($1,2,$2,$3,$4,$5,$6,$7,$7,$7::timestamptz+interval '15 minutes',$7)`,
          [
            id(99000),
            scope.brandReference,
            scope.storeReference,
            cart.cartReference,
            guest.session.sessionReference,
            id(99001),
            cart.createdAt,
          ],
        );
        const { attached, catalogId } = await seedCheckoutCatalog(admin, id, at, cart, scope);
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
          expiresAt: shift(60000),
          reasonCode: "SYNTHETIC_SAFETY",
        });
        const catalog = createPostgresCatalogSelectionService(
          runner(roles[5]),
          {
            ...scope,
            menuReference: catalogId(1),
            sourceChannel: cart.sourceChannel,
            orderType: "Pickup",
            channelCode: attached.catalogChannelCode,
            orderTypeCode: attached.catalogOrderTypeCode,
          },
          {
            clock: { now: () => observedAt },
            killSwitch: { loadEvidence: async (request) => safety(request, "KillSwitch", "Clear") },
            inventory: {
              loadEvidence: async (request) => safety(request, "Inventory", "Available"),
            },
          },
        );
        await admin.query(
          "UPDATE rms_catalog.product_version SET tax_classification_id=$1 WHERE product_version_id=$2",
          [
            f.request.record.items[0].catalog.taxClassificationReference,
            attached.productVersionReference,
          ],
        );

        const pricing = f.request.record.items[0].pricing;
        await admin.query(
          "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO " +
            roles[7],
        );
        let quoteConfiguration;
        const pricedQuote = await createSubmissionPricingFixture(cart, pricing, shift(300000), {
          admin,
          readerTransactions: runner(roles[7]),
          configured,
          captureConfiguration: (value) => {
            quoteConfiguration = value;
          },
        });
        let quote = (configured ? parseConfiguredCartQuoteAttachment : parseCartQuoteAttachment)({
          operationReference: id(90003),
          operationIntentHash: hash(
            "AttachQuote:" +
              JSON.stringify({
                cartReference: cart.cartReference,
                expectedCartVersion: cart.aggregateVersion,
                operationReference: id(90003),
                requestedAt: at,
              }),
          ),
          guestSessionReference: cart.createdByActorReference,
          ...scope,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: f.request.checkoutValidationEvidence.quoteReference,
          quoteVersion: configured ? 2 : 1,
          quoteInputDigest: pricing.quoteInputDigest,
          currencyCode: "CAD",
          currencyMetadataVersion: pricing.currencyMetadataVersion,
          currencyMetadataVersionReference: pricing.currencyMetadataVersionReference,
          subtotal: pricedQuote.subtotal,
          discount: pricedQuote.discount,
          tax: pricedQuote.tax,
          fee: pricedQuote.fee,
          total: pricedQuote.total,
          lines: cart.items.map((item) => ({
            lineReference: item.cartItemReference,
            sellableReference: item.sellableReference,
            productVersionReference: item.catalogSelectionEvidence.productVersionReference,
            menuVersionReference: item.catalogSelectionEvidence.menuVersionReference,
            quantity: item.quantity,
          })),
          warnings: [],
          quoteCreatedAt: pricedQuote.createdAt,
          quoteExpiresAt: shift(300000),
          attachedAt: at,
          idempotencyExpiresAt: shift(86400000),
        });
        const audit = (n, actionCode, targetType, targetId, reasonCode, occurredAt) => ({
          auditId: id(n),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode,
          targetType,
          targetId,
          reasonCode,
          occurredAt,
          correlationId: id(n + 10000),
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        });
        if (configured) {
          quote = await exerciseConfiguredJourneyQuote({
            admin,
            runner,
            roles,
            journey: checkoutJourney,
            scope,
            cart,
            id,
            configuration: quoteConfiguration,
            credentials,
            sessionCredential,
            csrfCredential,
            sessions,
            now: () => observedAt,
            hash,
            operationReference: id(90003),
            catalogScope: {
              menuReference: catalogId(1),
              sourceChannel: cart.sourceChannel,
              channelCode: attached.catalogChannelCode,
              orderTypeCode: attached.catalogOrderTypeCode,
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
          await (
            configured ? createPostgresConfiguredPriceQuoteStore : createPostgresPriceQuoteStore
          )(runner(roles[6]), scope, {
            generateReference: () => id(++sequence),
          }).append({
            quote: pricedQuote,
            audit: audit(
              90030,
              "PRICING_QUOTE_CREATE",
              "PricingPriceQuote",
              pricedQuote.quoteReference,
              "AUTHORIZED_CART_QUOTE",
              pricedQuote.createdAt,
            ),
          });
          await (
            configured ? createPostgresConfiguredCartQuoteStore : createPostgresCartQuoteStore
          )(runner(roles[1]), scope, {
            hashIntent: hash,
            equals: (a, b) => a === b,
          }).attach({
            attachment: quote,
            expectedCartVersion: cart.aggregateVersion,
            audit: audit(
              90006,
              "ORDERING_CART_ATTACH_QUOTE",
              "OrderingCart",
              cart.cartReference,
              "AUTHORIZED_CART_QUOTE",
              at,
            ),
          });
        }
        await admin.query(
          "INSERT INTO rms_fulfillment.capacity_slot (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date) VALUES ($1,$2,$3,'Pickup',$4,$5,'UTC',$6)",
          [
            scope.brandReference,
            scope.storeReference,
            id(90007),
            shift(-60000),
            shift(1800000),
            at.slice(0, 10),
          ],
        );
        await admin.query(
          "INSERT INTO rms_fulfillment.capacity_slot_configuration (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,1,$4)",
          [scope.brandReference, scope.storeReference, id(90007), shift(-120000)],
        );
        const sources = (
          configured
            ? createCustomerConfiguredPickupCapacitySources
            : createCustomerPickupCapacitySources
        )({
          scope,
          orderingTransactions: runner(roles[1]),
          capacityTransactions: runner(roles[2]),
          unitPolicy: { resolve: async () => ({ mode: "PerFulfillment", ruleVersion: 1 }) },
          now: () => observedAt,
        });
        const repository = createPostgresAsapCapacityStore(runner(roles[2], true), scope, {
          now: () => observedAt,
        });
        const preparation = {
          scope,
          session: { credentials, store: sessions, binding: { validate: async () => "Current" } },
          sources,
          capacity: {
            repository,
            audit: {
              prepare: async (record) =>
                audit(
                  ++sequence,
                  "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase(),
                  "FulfillmentAsapCapacity",
                  record.allocationReference,
                  "AUTHORIZED_CHECKOUT_CAPACITY",
                  record.paymentRequestedAt ?? record.preparedAt,
                ),
            },
          },
          references: {
            generate: (purpose) => (purpose === "PaymentOperation" ? id(99102) : id(++sequence)),
          },
          now: () => observedAt,
        };
        const composition = createCustomerPickupCheckoutComposition(preparation);
        const input = {
          sessionCredential,
          csrfCredential,
          intent: {
            submissionReference: id(90008),
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            quoteReference: quote.quoteReference,
          },
        };
        await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + roles[1]);
        await admin.query("GRANT SELECT ON bop_identity.guest_session TO " + roles[1]);
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.checkout_session_allocation,rms_ordering.checkout_session_record TO " +
            roles[1],
        );
        const allocationRecord = {
          ...scope,
          guestSessionReference: String(guest.session.sessionReference),
          createOperationReference: id(99100),
          checkoutSessionReference: id(99101),
          submissionReference: input.intent.submissionReference,
          paymentOperationReference: id(99102),
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: configured ? 2 : 1,
          allocatedAt: at,
        };
        const sessionRequest = {
          createOperationReference: allocationRecord.createOperationReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: configured ? 2 : 1,
        };
        const sessionAccessOptions = {
          scope,
          transactions: runner(roles[1]),
          credentials,
          binding: () => preparation.session.binding,
          now: () => new Date().toISOString(),
        };
        const access = createCustomerCheckoutSessionAuthorization(sessionAccessOptions, {
          sessionCredential,
          csrfCredential,
          cartReference: cart.cartReference,
        });
        const allocationAuthority = await access.authorize(
          sessionRequest,
          new Date().toISOString(),
        );
        assert(allocationAuthority);
        const allocationAudit = (record) =>
          audit(
            ++sequence,
            "ORDERING_CHECKOUT_SESSION_ALLOCATE",
            "CheckoutSession",
            record.checkoutSessionReference,
            "AUTHORIZED_CHECKOUT_CREATE",
            record.allocatedAt,
          );
        const persistedAllocation = await createPostgresCheckoutSessionAllocationStore(
          runner(roles[1]),
          scope,
          {
            authorize: access.authorizeInTransaction,
            audit: allocationAudit,
          },
        ).allocate(allocationRecord, allocationAuthority);
        assert.deepEqual(persistedAllocation, allocationRecord);
        await assert.rejects(composition.prepare({ ...input, csrfCredential: "x".repeat(43) }));
        const result = await composition.prepareForOrdering(input);
        assert.equal(lost, true);
        assert.equal(result.status, "Existing");
        assert.equal(result.record.units, 1);
        assert.equal(result.record.guestSessionReference, guest.session.sessionReference);
        assert.deepEqual((await composition.prepare(input)).record, result.record);
        const counts = await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_fulfillment.capacity_asap_commitment) AS records,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='FULFILLMENT_ASAP_CAPACITY_PREPARED') AS audits",
        );
        assert.deepEqual(counts.rows[0], { records: 1, audits: 1 });
        const cartReader = createPostgresCartQueryStore(runner(roles[1]), scope);
        const quoteReader = (
          configured ? createPostgresConfiguredCartQuoteReader : createPostgresCartQuoteReader
        )(runner(roles[1]), scope);

        const orderOptions = {
          preparation,
          checkout: {
            repository: {
              loadCart: (ref) => cartReader.load(ref),
              loadQuote: (ref) =>
                quoteReader.loadLatest({
                  cartReference: ref,
                  cartVersion: cart.aggregateVersion,
                  observedAt,
                }),
            },
            references: { hashIntent: hash },
            catalog,
          },
          ordering: {
            source: (configured
              ? createCustomerConfiguredOrderSourceComposition
              : createCustomerOrderSourceComposition)({
              scope,
              cartTransactions: runner(roles[1]),
              catalogTransactions: runner(roles[5]),
              pricingTransactions: runner(roles[7]),
              catalogScope: {
                menuReference: catalogId(1),
                sourceChannel: cart.sourceChannel,
                orderType: "Pickup",
                channelCode: attached.catalogChannelCode,
                orderTypeCode: attached.catalogOrderTypeCode,
              },
              catalogSafety: {
                killSwitch: {
                  loadEvidence: async (request) => safety(request, "KillSwitch", "Clear"),
                },
                inventory: {
                  loadEvidence: async (request) => safety(request, "Inventory", "Available"),
                },
              },
              catalogReferences: { generate: () => id(++sequence), hash },
              clock: { now: () => observedAt },
            }),
            businessDate: { resolve: async () => f.request.businessDateResolution },
            audit: {
              create: async (request) => ({
                ...f.request.audit,
                auditId: id(++sequence),
                targetId: request.order.orderReference,
                occurredAt: request.observedAt,
              }),
            },
            references: {
              generate: () => id(++sequence),
              hashIntent: hash,
              equals: (a, b) => a === b,
            },
          },
          repository: (link, authorization) =>
            createPostgresInventoryFinalizedOrderCreationRepository(
              { query: runner(roles[1]), write: runner(roles[1], false, true) },
              scope,
              link,
              configured ? 2 : 1,
              {
                now: preparation.now,
                policies: checkoutDetails.policies,
                authorization: checkoutDetails.wrapAuthorization(authorization),
              },
              inventory,
            ),
        };
        if (configured) {
          orderOptions.checkout.history = createPostgresConfiguredPriceQuoteHistoryReader(
            runner(roles[7]),
            scope,
          );
          orderOptions.checkout.pricingChannelCode =
            pricedQuote.lines[0].optionPrices[0].context.channelCode;
          orderOptions.checkout.snapshots = createPostgresCatalogOrderSnapshotSource(
            runner(roles[5]),
            {
              ...scope,
              menuReference: catalogId(1),
              sourceChannel: cart.sourceChannel,
              orderType: "Pickup",
              channelCode: attached.catalogChannelCode,
              orderTypeCode: attached.catalogOrderTypeCode,
            },
            {
              clock: { now: () => observedAt },
              killSwitch: {
                loadEvidence: async (request) => safety(request, "KillSwitch", "Clear"),
              },
              inventory: {
                loadEvidence: async (request) => safety(request, "Inventory", "Available"),
              },
            },
            { generate: () => id(++sequence), hash },
          );
        }

        const sessionValidation = (
          configured
            ? createCustomerConfiguredPickupSessionValidation
            : createCustomerPickupSessionValidation
        )({ preparation, checkout: orderOptions.checkout });
        const sessionAllocation = persistedAllocation;
        const sessionValidationInput = {
          sessionCredential,
          csrfCredential,
          allocation: sessionAllocation,
          request: {
            createOperationReference: sessionAllocation.createOperationReference,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            quoteReference: quote.quoteReference,
            quoteVersion: configured ? 2 : 1,
          },
        };
        const sessionEvidence = await sessionValidation(sessionValidationInput);
        assert.equal(
          sessionEvidence.fulfillment.evidenceReference,
          result.record.allocationReference,
        );
        assert.equal(sessionEvidence.quoteVersion, configured ? 2 : 1);
        assert.equal(
          sessionEvidence.validationReference,
          sessionAllocation.checkoutSessionReference,
        );
        await assert.rejects(
          sessionValidation({
            ...sessionValidationInput,
            allocation: {
              ...sessionAllocation,
              paymentOperationReference: id(99103),
            },
          }),
        );

        const sessionCreator = createCustomerCheckoutSessionComposition({
          ...sessionAccessOptions,
          quoteVersion: configured ? 2 : 1,
          nextReference: () => id(++sequence),
          allocationAudit,
          audit: (record) =>
            audit(
              ++sequence,
              "ORDERING_CHECKOUT_SESSION_CREATE",
              "CheckoutSession",
              record.checkoutSessionReference,
              "AUTHORIZED_CHECKOUT_CREATE",
              record.createdAt,
            ),
          validate: sessionValidation,
        });
        const sessionEnvelope = { sessionCredential, csrfCredential, command: sessionRequest };
        const createdSession = await sessionCreator.create(sessionEnvelope);
        assert.equal(createdSession.status, "Created");
        assert.equal(createdSession.session.submissionReference, result.record.submissionReference);
        assert.equal(
          createdSession.session.paymentOperationReference,
          result.record.paymentOperationReference,
        );
        assert.equal(
          createdSession.session.checkoutSessionReference,
          persistedAllocation.checkoutSessionReference,
        );
        const recoveredSession = await sessionCreator.create(sessionEnvelope);
        assert.equal(recoveredSession.status, "AlreadyCreated");
        assert.deepEqual(recoveredSession.session, createdSession.session);
        const sessionCounts = await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) AS allocations,(SELECT count(*)::int FROM rms_ordering.checkout_session_record) AS sessions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code IN ('ORDERING_CHECKOUT_SESSION_ALLOCATE','ORDERING_CHECKOUT_SESSION_CREATE')) AS audits",
        );
        assert.deepEqual(sessionCounts.rows[0], { allocations: 1, sessions: 1, audits: 2 });
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.checkout_details_record TO " + roles[1],
        );
        await admin.query(
          "GRANT SELECT,INSERT ON rms_ordering.order_checkout_details_link TO " + roles[1],
        );
        const checkoutDetails = await exerciseCustomerCheckoutDetails({
          journey: checkoutJourney,
          mode: "Pickup",
          scope,
          quoteVersion: configured ? 2 : 1,
          cart,
          quote,
          credentials: { sessionCredential, csrfCredential },
          sessionTransactions: runner(roles[0]),
          cartTransactions: runner(roles[1]),
          detailsTransactions: runner(roles[1]),
          session: preparation.session,
          now: preparation.now,
        });
        // Isolated fixture grants; not a production runtime permission policy.
        await admin.query(
          "GRANT USAGE ON SCHEMA rms_inventory,rms_recipe,bop_workflow,bop_publishing TO " +
            roles[1],
        );
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rms_inventory,rms_recipe,bop_workflow,bop_publishing TO " +
            roles[1],
        );
        const ownerScope = { tenantReference: id(1), ...scope };
        assert.equal(checkoutJourney.tenantReference, ownerScope.tenantReference);
        const inventoryRunner = () => runner(roles[1]);
        const stock = await seedSubmissionInventoryStock({
          admin,
          runner: inventoryRunner,
          ownerScope,
          actorReference: guest.session.sessionReference,
          at,
          datedLot: configured,
        });
        await seedSubmissionInventoryRecipe({
          admin,
          scope: ownerScope,
          actorReference: guest.session.sessionReference,
          at,
          cart,
          stock,
        });
        const workflow = await seedSubmissionInventoryWorkflow({
          runner: inventoryRunner,
          scope: ownerScope,
          actorReference: guest.session.sessionReference,
          at,
          orderType: "Pickup",
        });
        let inventoryReference = 500000,
          inventoryCalls = 0,
          failInventory = false;
        const actualInventory = createCustomerSubmissionInventoryFinalizer({
          scope: ownerScope,
          stockSiteReference: stock.stockSiteReference,
          workflow,
          authorize: async (_tx, input) => input.actorReference === guest.session.sessionReference,
          resolveExpiryCutoff: stock.resolveExpiryCutoff,
          generateReference: () => id(++inventoryReference),
          audit: {
            reasonCode: "SYNTHETIC_SUBMISSION",
            sourceChannel: "CUSTOMER_PWA",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
        const inventory = {
          async finalize(input) {
            inventoryCalls++;
            await actualInventory.finalize(input);
            if (failInventory) throw new Error("synthetic failure after actual Inventory writes");
          },
        };
        const inventoryState = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_set) AS sets," +
                "(SELECT count(*)::int FROM rms_inventory.submission_final_validation) AS finals," +
                "(SELECT reserved::text FROM rms_inventory.stock_balance WHERE account_id=$1) AS reserved",
              [stock.accountReference],
            )
          ).rows[0];
        const orderService = (
          configured
            ? createCustomerConfiguredPickupOrderSubmissionComposition
            : createCustomerPickupOrderSubmissionComposition
        )(orderOptions);
        const orderInput = {
          sessionCredential,
          csrfCredential,
          submissionReference: input.intent.submissionReference,
          cartReference: cart.cartReference,
          expectedCartVersion: cart.aggregateVersion,
          quoteReference: quote.quoteReference,
        };
        await assert.rejects(
          orderService.create({ ...orderInput, csrfCredential: "x".repeat(43) }),
        );
        await admin.query("UPDATE rms_catalog.sku SET lifecycle='Archived' WHERE sku_id=$1", [
          cart.items[0].sellableReference,
        ]);
        await assert.rejects(orderService.create(orderInput));
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0].n,
          0,
        );
        assert.equal(orderLost, false);
        await admin.query("UPDATE rms_catalog.sku SET lifecycle='Active' WHERE sku_id=$1", [
          cart.items[0].sellableReference,
        ]);
        const currentFacts = await createPostgresCurrentSelectionFactsStore(
          runner(roles[5]),
          scope,
        ).load({
          ...scope,
          sourceChannel: cart.sourceChannel,
          orderType: "Pickup",
          menuReference: catalogId(1),
          channelCode: attached.catalogChannelCode,
          orderTypeCode: attached.catalogOrderTypeCode,
          sellableReference: cart.items[0].sellableReference,
          observedAt,
        });
        assert(currentFacts, "restored SKU must have current published facts");
        assert.equal(resolveCurrentCatalogSelectionRules(currentFacts.bindings).length, 1);
        const currentSelection = await catalog.validateSelection({
          ...scope,
          sourceChannel: cart.sourceChannel,
          orderType: "Pickup",
          sellableReference: cart.items[0].sellableReference,
          optionSelections: cart.items[0].optionSelections,
          observedAt,
        });
        assert.equal(
          currentSelection.status,
          "Accepted",
          currentSelection.status === "Rejected" ? currentSelection.reason : "accepted",
        );
        for (const policyMode of [
          "Missing",
          "Foreign",
          "Expired",
          "Changed",
          "Denied",
          "ChangedIdentity",
        ]) {
          checkoutDetails.setPolicy(policyMode);
          await assert.rejects(orderService.create(orderInput));
          assert.equal(
            (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0]
              .n,
            0,
          );
        }
        checkoutDetails.setPolicy("DatabaseExpired");
        await assert.rejects(orderService.create(orderInput), {
          code: "ORDER_CREATE_VALIDATION_EXPIRED",
        });
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.order_header")).rows[0].n,
          0,
        );
        checkoutDetails.setPolicy("Ready");
        assert.equal(inventoryCalls, 0);
        failInventory = true;
        await assert.rejects(orderService.create(orderInput));
        failInventory = false;
        assert.equal(inventoryCalls, 1);
        assert.deepEqual(await inventoryState(), { sets: 0, finals: 0, reserved: "0" });
        failOrderAudit = true;
        await assert.rejects(orderService.create(orderInput));
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
            ? createCustomerConfiguredPickupSessionOrderSubmission
            : createCustomerPickupSessionOrderSubmission
        )(sessionAccessOptions, orderOptions);
        const sessionOrderInput = {
          sessionCredential,
          csrfCredential,
          checkoutSessionReference: createdSession.session.checkoutSessionReference,
        };
        await assert.rejects(
          sessionOrders.create({ ...sessionOrderInput, submissionReference: id(999) }),
          { code: "INPUT_INVALID" },
        );
        const httpOrder = await exerciseCustomerOrderHttp({
          journey: checkoutJourney,
          runtimeOptions: {
            scope,
            sessionTransactions: runner(roles[0]),
            cartTransactions: runner(roles[1]),
            session: preparation.session,
            now: preparation.now,
          },
          expectedTotal: pricedQuote.total.amountMinor.toString(),
          orderType: "Pickup",
          create: async (command) => {
            const response = await sessionOrders.create({
              ...sessionOrderInput,
              sessionCredential: command.sessionCredential,
              csrfCredential: command.csrfCredential,
            });
            return { status: response.status, record: response.record };
          },
          quoteVersion: configured ? 2 : 1,
          input: orderInput,
        });
        assert.equal(orderLost, true);
        await checkoutDetails.replaceForRecovery();
        const recovered = await sessionOrders.create(sessionOrderInput);
        assert.deepEqual(recovered.session, createdSession.session);
        assert.equal(recovered.status, "AlreadyCreated");
        assert.equal(inventoryCalls, 3, "recovery must not reserve again");
        const inventoryAfterRecovery = await inventoryState();
        assert.equal(inventoryAfterRecovery.sets, 1);
        assert.equal(inventoryAfterRecovery.finals, 1);
        assert.equal(
          BigInt(inventoryAfterRecovery.reserved),
          cart.items.reduce((sum, item) => sum + BigInt(item.quantity), 0n),
          "fixture consumes one KG for each EACH sale unit",
        );

        const currentInventory = createPostgresSubmissionFinalValidationStore(
          runner(roles[1]),
          ownerScope,
          {
            authorize: async (_tx, input) =>
              input.actorReference === guest.session.sessionReference,
            resolveCurrent: async () => {
              throw new Error("read-only fixture does not produce new final records");
            },
          },
        );
        const fencedInventory = await currentInventory.withCurrent(
          {
            submissionReference: orderInput.submissionReference,
            actorReference: guest.session.sessionReference,
            observedAt: new Date().toISOString(),
          },
          async (tx, facts) => {
            assert.equal(facts.record.orderReference, recovered.record.order.orderReference);
            assert.equal(facts.reservations.length, 1);
            assert.equal(facts.accounts.length, 1);
            assert.equal(facts.accounts[0].accountReference, stock.accountReference);
            assert.equal(facts.accounts[0].holdStatus, "Available");
            assert.equal(facts.accounts[0].expiryDate, stock.expiryDate);
            assert.equal(facts.accounts[0].lotReference, stock.lotReference);
            assert.equal(facts.reservations[0].accountReference, stock.accountReference);
            assert.equal(
              facts.reservations[0].reservation.remainingQuantity,
              inventoryAfterRecovery.reserved,
            );
            assert.equal(facts.reservations[0].reservation.releasedQuantity, "0");
            assert.equal(facts.reservations[0].reservation.consumedQuantity, "0");
            const actualContext = await tx.query(
              "SELECT current_setting('bop.store_id') AS store",
              [],
            );
            assert.equal(actualContext.rows[0].store, scope.storeReference);
            await admin.query("BEGIN");
            try {
              await assert.rejects(
                admin.query(
                  "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE NOWAIT",
                  [ownerScope.tenantReference, scope.brandReference, stock.itemReference],
                ),
                { code: "55P03" },
              );
            } finally {
              await admin.query("ROLLBACK");
            }
            return facts;
          },
        );
        assert.equal(fencedInventory.record.submissionReference, orderInput.submissionReference);
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

        assert.equal(recovered.record.order.orderReference, result.record.orderReference);
        assert.equal(
          recovered.record.order.batches[0].orderBatchReference,
          result.record.orderBatchReference,
        );
        assert.equal(recovered.record.order.orderType, "Pickup");
        assert.deepEqual(recovered.record.items[0].pricing.total, pricedQuote.lines[0].total);
        assert.equal(
          recovered.record.items[0].pricing.priceResolution.priceBookDigest,
          pricedQuote.lines[0].resolvedPrice.snapshotDigest,
        );
        assert.equal(
          recovered.record.items[0].pricing.taxConfigurationVersionReference,
          pricedQuote.lines[0].taxResolution.versionReference,
        );
        assert.equal(recovered.record.items[0].pricing.quoteInputDigest, pricedQuote.inputDigest);

        assert.deepEqual(recovered.record.items[0].catalog.localizedNames, { "en-CA": "Latte" });
        assert.deepEqual(recovered.record.items[0].catalog.options[0].localizedNames, {
          "en-CA": "Synthetic option",
        });
        assert.equal(
          recovered.record.items[0].catalog.skuReference,
          cart.items[0].sellableReference,
        );
        assert.equal(recovered.record.items[0].catalog.productReference, catalogId(40));

        const orderCounts = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_ordering.order_header) AS orders,(SELECT count(*)::int FROM rms_ordering.order_capacity_link) AS links,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderCreated') AS events,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_ORDER_CREATE') AS audits",
            )
          ).rows[0];
        assert.deepEqual(await orderCounts(), { orders: 1, links: 1, events: 1, audits: 1 });
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
          { now: () => observedAt },
        );
        const tips = (
          configured
            ? createCustomerConfiguredPickupSessionTipSelection
            : createCustomerPickupSessionTipSelection
        )(sessionAccessOptions, {
          submission: orderOptions,
          tip: {
            repository: tipStore,
            audit: {
              create: async (record) =>
                audit(
                  ++sequence,
                  "PAYMENT_TIP_SELECT",
                  "PaymentTipSelection",
                  record.selectionReference,
                  "AUTHORIZED_PAYMENT_TIP_SELECT",
                  record.selectedAt,
                ),
            },
          },
        });
        const tipInput = {
          sessionCredential,
          csrfCredential,
          checkoutSessionReference: createdSession.session.checkoutSessionReference,
          selectionReference: id(90010),
          tip: { amountMinor: 175n, currencyCode: "CAD" },
        };
        await assert.rejects(tips.select({ ...tipInput, csrfCredential: "x".repeat(43) }));
        const selected = await tips.select(tipInput);
        assert.deepEqual(selected.session, createdSession.session);
        assert.equal(tipLost, true);
        assert.equal(selected.status, "Existing");
        assert.equal(
          selected.record.paymentOperationReference,
          result.record.paymentOperationReference,
        );
        assert.equal(selected.record.tip.amountMinor, 175n);
        await assert.rejects(
          tips.select({ ...tipInput, tip: { amountMinor: 176n, currencyCode: "CAD" } }),
        );
        const tipCounts = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_payment.payment_tip_selection) AS records,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_TIP_SELECT') AS audits",
            )
          ).rows[0];
        assert.deepEqual(await tipCounts(), { records: 1, audits: 1 });
        observedAt = new Date(Date.now() - 1).toISOString();
        assert(observedAt > at);
        const { session: paymentSession, ...sealed } =
          await sessionOrders.preparePaymentClock(sessionOrderInput);
        assert.deepEqual(paymentSession, createdSession.session);
        assert.equal(sealLost, true);
        assert.deepEqual(sealed.order, recovered.record);
        assert.equal(sealed.clock.state, "PaymentPending");
        assert.equal(sealed.clock.paymentRequestedAt, observedAt);
        assert.equal(
          sealed.clock.capacityExpiresAt,
          new Date(Date.parse(observedAt) + 1800000).toISOString(),
        );
        const sealCounts = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_fulfillment.capacity_asap_commitment WHERE state='PaymentPending') AS records,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='FULFILLMENT_ASAP_CAPACITY_PAYMENTPENDING') AS audits",
            )
          ).rows[0];
        assert.deepEqual(await sealCounts(), { records: 1, audits: 1 });
        const amounts = (
          configured ? deriveConfiguredPaymentPreparationAmounts : derivePaymentPreparationAmounts
        )({
          order: sealed.order,
          selection: selected.record,
          paymentOperationReference: sealed.clock.paymentOperationReference,
          requestedAt: sealed.clock.paymentRequestedAt,
        });
        assert.equal(amounts.orderAllocation.amountMinor, pricedQuote.total.amountMinor);
        assert.equal(amounts.total.amountMinor, pricedQuote.total.amountMinor + 175n);
        const claimAccess = (
          configured
            ? createCustomerConfiguredPickupPaymentAuthorization
            : createCustomerPickupPaymentAuthorization
        )(
          {
            preparation,
            ordering: orderOptions.repository(pickupOrderCapacityLinkFromHistory(result.record)),
          },
          { sessionCredential, csrfCredential },
        );
        await exerciseSubmissionInventoryPayment({
          journey: checkoutJourney,
          positive,
          sessionPayment: {
            access: sessionAccessOptions,
            orders: sessionOrders,
            tips: tips,
            input: tipInput,
          },
          admin,
          runner: runner(roles[1]),
          role: roles[1],
          scope: ownerScope,
          stock,
          order: sealed.order,
          clock: sealed.clock,
          amounts,
          selection: selected.record,
          quoteVersion: configured ? 2 : 1,
          paymentWorkflow: workflow.payment,
          at: observedAt,
          authorize: async (_tx, request) => {
            const access = await claimAccess.authorize({
              action: "CreatePaymentIntent",
              submissionReference: request.submissionReference,
              paymentOperationReference: sealed.clock.paymentOperationReference,
              observedAt: preparation.now(),
            });
            return access !== null && access.guestSessionReference === request.actorReference;
          },
        });

        await assert.rejects(tips.select({ ...tipInput, selectionReference: id(90011) }));
        observedAt = shift(360000);
        assert.deepEqual((await composition.prepare(input)).record, sealed.clock);
        const { session: replaySession, ...replayedClock } =
          await sessionOrders.preparePaymentClock(sessionOrderInput);
        assert.deepEqual(replaySession, createdSession.session);
        assert.deepEqual(replayedClock, sealed);
        assert.deepEqual(await sealCounts(), { records: 1, audits: 1 });
        await assert.rejects(composition.prepareForOrdering(input));
        assert.deepEqual((await composition.authorizePayment(input)).record, sealed.clock);
        assert.deepEqual((await tips.select(tipInput)).record, selected.record);
        assert.deepEqual(await tipCounts(), { records: 1, audits: 1 });
        assert.deepEqual((await orderService.create(orderInput)).record, recovered.record);
        assert.deepEqual(await orderCounts(), { orders: 1, links: 1, events: 1, audits: 1 });

        await admin.query("GRANT USAGE ON SCHEMA bop_feature_control TO " + roles[4]);
        await admin.query("GRANT SELECT ON bop_feature_control.kill_switch_version TO " + roles[4]);
        const paymentAccess = (
          configured
            ? createCustomerConfiguredPickupPaymentAuthorization
            : createCustomerPickupPaymentAuthorization
        )(
          {
            preparation,
            ordering: orderOptions.repository(pickupOrderCapacityLinkFromHistory(result.record)),
          },
          { sessionCredential, csrfCredential },
        );
        const accessRequest = {
          action: "CreatePaymentIntent",
          submissionReference: result.record.submissionReference,
          paymentOperationReference: result.record.paymentOperationReference,
          observedAt,
        };
        assert.deepEqual(await paymentAccess.authorize(accessRequest), {
          action: "CreatePaymentIntent",
          guestSessionReference: guest.session.sessionReference,
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
            effectiveFrom: observedAt,
            effectiveUntil: null,
            reviewAt: observedAt,
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
              observedAt,
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
            clock: { now: () => observedAt },
            rollout: { bucketForGuest: () => 0 },
          },
          {
            paymentOperationReference: accessRequest.paymentOperationReference,
            submissionReference: accessRequest.submissionReference,
          },
        );
        const safetyRequest = () => ({
          action: "CreatePaymentIntent",
          key: "payment.provider.admission",
          ...scope,
          evaluatedAt: observedAt,
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
        observedAt = sealed.clock.capacityExpiresAt;
        await assert.rejects(composition.authorizePayment(input));
        assert.deepEqual((await composition.prepare(input)).record, sealed.clock);
        await sessions.revoke({
          selectorHash: guest.sessionSelectorHash,
          expectedVersion: 1,
          reason: "RiskChanged",
          observedAt,
          operationReference: id(90009),
          operationIntentHash: credentials.hashOperationIntent("synthetic revoke"),
        });
        assert.equal(await paymentAccess.authorize({ ...accessRequest, observedAt }), null);
        await assert.rejects(
          paymentSafety.evaluate(safetyRequest()),
          /customer payment safety unavailable/,
        );
        await assert.rejects(composition.prepare(input));
        await assert.rejects(orderService.create(orderInput));
        await assert.rejects(sessionOrders.create(sessionOrderInput));
        await assert.rejects(sessionOrders.preparePaymentClock(sessionOrderInput));
        await assert.rejects(orderService.preparePaymentClock(orderInput));
        await assert.rejects(composition.authorizePayment(input));
        await assert.rejects(tips.select(tipInput));
        assert.equal(active, 0);
      } finally {
        await checkoutJourney.runtime?.shutdown("SIGTERM");
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
