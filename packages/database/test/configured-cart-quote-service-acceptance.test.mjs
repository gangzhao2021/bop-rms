import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { fixture as runtimeEntryFixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerConfiguredOrderSourceComposition } from "../../../apps/api/src/customer-order-source-composition.ts";
import {
  createConfiguredOrderItemSnapshots,
  encodeConfiguredOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
} from "../../rms/ordering/src/index.ts";
import {
  createPostgresCatalogSelectionService,
  createPostgresCatalogOrderSnapshotSource,
} from "../../rms/catalog/src/index.ts";
import {
  createConfiguredCheckoutValidationService,
  createPostgresCartQueryStore,
} from "../../rms/ordering/src/index.ts";
import { createConfiguredOrderPricingSource } from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { createPostgresConfiguredPriceQuoteHistoryReader } from "../../rms/pricing/src/index.ts";
import { prepareConfiguredQuotePolicies } from "../test-support/configured-quote-policies.mjs";
import {
  createCustomerConfiguredQuoteWithPoliciesComposition,
  createCustomerConfiguredQuoteHttpComposition,
} from "../../../apps/api/src/customer-configured-quote-composition.ts";
import { prepareConfiguredQuoteEntry } from "../test-support/configured-quote-entry.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createGuestSession } from "../../bop/identity/src/index.ts";
import { createPostgresConfiguredCartQuoteStore } from "../../rms/ordering/src/index.ts";
import { fixture, id } from "../../rms/ordering/src/tests/configured-cart-quote.fixture.ts";
import { createPostgresConfiguredPriceQuoteRequestStore } from "../../rms/pricing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;

it.each([false, true])(
  "recovers configured Quote and Cart commits for Dining=%s",
  async (dining) => {
    await withIsolatedDatabase(
      { caseId: dining ? "wp2402_cq_dining" : "wp2402_cq_pickup" },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        const roles = ["wp2402_cqo_" + context.runId, "wp2402_cqp_" + context.runId];
        const createdRoles = [];
        const f = fixture(dining),
          cart = f.cart,
          quote = { ...f.quote, quoteReference: id(900) };
        const scope = { brandReference: cart.brandReference, storeReference: cart.storeReference };
        let currentAt = f.observedAt,
          next = 10000;
        let losePricing = true,
          loseAttachment = true,
          failAttachmentAudit = false;
        let active = 0,
          auditFailures = 0,
          candidateCalls = 0;
        let entry, policy, runtime;
        let mismatchedCandidate = false;
        const references = {
          generateReference: () => id(next++),
          hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          equals: (left, right) => left === right,
        };
        function audit(target, reference, observedAt) {
          return {
            auditId: id(next++),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode:
              target === "PricingPriceQuote"
                ? "PRICING_QUOTE_CREATE"
                : "ORDERING_CART_ATTACH_QUOTE",
            targetType: target,
            targetId: reference,
            reasonCode: "AUTHORIZED_CART_QUOTE",
            correlationId: id(next++),
            occurredAt: observedAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "SYNTHETIC_RETENTION",
            retentionPolicyVersion: 1,
          };
        }
        function runner(pricing) {
          return {
            async run(action) {
              const client = new Client({
                ...context.clientConfig,
                query_timeout: 5000,
                connectionTimeoutMillis: 2000,
              });
              await client.connect();
              active++;
              let committed = false,
                wrote = false;
              try {
                await client.query("BEGIN");
                await client.query("SET LOCAL ROLE " + roles[pricing ? 1 : 0]);
                await client.query("SET LOCAL lock_timeout='5s'");
                await client.query("SET LOCAL statement_timeout='5s'");
                const value = await action({
                  async query(sql, values) {
                    if (
                      !pricing &&
                      failAttachmentAudit &&
                      sql.startsWith("UPDATE platform_audit.audit_chain_head")
                    ) {
                      auditFailures++;
                      throw new Error("synthetic attachment Audit failure");
                    }
                    if (
                      sql.startsWith(
                        pricing
                          ? "INSERT INTO rms_pricing.price_quote_request"
                          : "INSERT INTO rms_ordering.cart_quote_attachment",
                      )
                    )
                      wrote = true;
                    return client.query(sql, [...values]);
                  },
                });
                await client.query("COMMIT");
                committed = true;
                if (wrote && (pricing ? losePricing : loseAttachment)) {
                  if (pricing) losePricing = false;
                  else loseAttachment = false;
                  throw new Error("synthetic lost commit acknowledgement");
                }
                return value;
              } catch (error) {
                if (!committed) await client.query("ROLLBACK");
                throw error;
              } finally {
                await client.end();
                active--;
              }
            },
          };
        }
        try {
          for (const role of roles) {
            assert.match(role, /^wp2402_cq[op]_[a-f0-9]+$/u);
            await admin.query(
              "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
            );
            createdRoles.push(role);
            await admin.query("GRANT USAGE ON SCHEMA platform_helpers,platform_audit TO " + role);
            await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
            await admin.query(
              "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
                role,
            );
            await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
            await admin.query(
              "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role,
            );
          }
          await admin.query("GRANT USAGE ON SCHEMA rms_ordering TO " + roles[0]);
          await admin.query("GRANT SELECT,UPDATE ON rms_ordering.cart TO " + roles[0]);
          await admin.query(
            "GRANT SELECT ON rms_ordering.cart_line,rms_ordering.cart_quote_expiry_record TO " +
              roles[0],
          );
          await admin.query(
            "GRANT SELECT,INSERT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line TO " +
              roles[0],
          );
          await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + roles[1]);
          await admin.query(
            "GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,rms_pricing.price_quote_request TO " +
              roles[1],
          );
          await admin.query(
            "INSERT INTO rms_ordering.cart (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11,$12,$13,$14,$15,$16)",
            [
              cart.cartReference,
              cart.brandReference,
              cart.storeReference,
              cart.orderType,
              cart.sourceChannel,
              cart.diningSessionReference,
              cart.createdByActorReference,
              cart.aggregateVersion,
              cart.createdAt,
              cart.updatedAt,
              cart.lifecycle.policyVersionReference,
              cart.lifecycle.policyDigest,
              cart.lifecycle.idleTimeoutSeconds,
              cart.lifecycle.absoluteTimeoutSeconds,
              cart.lifecycle.idleExpiresAt,
              cart.lifecycle.absoluteExpiresAt,
            ],
          );
          for (const line of cart.items)
            await admin.query(
              "INSERT INTO rms_ordering.cart_line (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at,catalog_selection_evidence_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)",
              [
                line.cartItemReference,
                cart.cartReference,
                cart.brandReference,
                cart.storeReference,
                line.sellableReference,
                line.quantity,
                JSON.stringify(line.optionSelections),
                line.addedByActorReference,
                line.addedByParticipantReference,
                line.addedAt,
                JSON.stringify(line.catalogSelectionEvidence),
              ],
            );
          const guest = createGuestSession({
            ...scope,
            sessionReference: id(65),
            version: 1,
            status: "Active",
            publicStoreReference: id(80),
            publicTableReference: dining ? id(81) : null,
            channel: cart.orderType,
            locale: "en-CA",
            qrReference: id(82),
            qrRevocationVersion: 1,
            diningState: dining ? "DiningBound" : "ContextOnly",
            diningSessionReference: cart.diningSessionReference,
            diningParticipantReference: dining ? id(68) : null,
            createdAt: f.observedAt,
            lastSeenAt: f.observedAt,
            idleExpiresAt: "2026-08-02T20:00:00.000Z",
            absoluteExpiresAt: "2026-08-03T16:00:00.000Z",
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          });
          const requests = createPostgresConfiguredPriceQuoteRequestStore(
            runner(true),
            scope,
            references,
          );
          const attachments = createPostgresConfiguredCartQuoteStore(
            runner(false),
            scope,
            references,
          );
          await admin.query("GRANT SELECT ON rms_ordering.cart_binding_record TO " + roles[0]);
          entry = await prepareConfiguredQuoteEntry({
            context,
            admin,
            f,
            guest,
            now: () => currentAt,
            references,
          });
          policy = await prepareConfiguredQuotePolicies({ context, admin, f });
          const compositionOptions = {
            scope,
            sessions: entry.sessions,
            now: () => currentAt,
            references,
            ...(dining
              ? { orderType: "DineIn", participation: entry.participation }
              : { orderType: "Pickup" }),
            cartTransactions: runner(false),
            attachmentTransactions: runner(false),
            pricingTransactions: runner(true),
            pricingReferences: references,
            catalogTransactions: entry.catalogTransactions,
            catalogScope: entry.catalogScope,
            catalogSafety: entry.catalogSafety,
            catalogReferences: entry.catalogReferences,
            pricingChannelCode: f.pricingChannelCode,
            audit: (input) => audit("OrderingCart", cart.cartReference, input.observedAt),
            policyTransactions: policy.transactions,
            policies: policy.policies,
            quoteRequest: async (_input, identity) => {
              candidateCalls++;
              return {
                ...policy.request,
                base: {
                  ...policy.request.base,
                  quoteReference: identity.operationReference,
                  ...(mismatchedCandidate ? { cartReference: id(999991) } : {}),
                },
              };
            },
            quoteAudit: async (candidate) =>
              audit("PricingPriceQuote", candidate.quoteReference, candidate.createdAt),
            expiryAudit: (record) => ({
              ...audit("OrderingCart", record.cartReference, record.expiredAt),
              actionCode: "ORDERING_CART_QUOTE_EXPIRE",
              reasonCode: "QUOTE_VALIDITY_ENDED",
            }),
          };
          const service = createCustomerConfiguredQuoteWithPoliciesComposition(compositionOptions);
          const port = createCustomerConfiguredQuoteHttpComposition(compositionOptions);
          await admin.query(
            "GRANT SELECT,INSERT ON rms_ordering.cart_quote_expiry_record TO " + roles[0],
          );
          const unusedChannel = {
            quoteCart: async () => {
              throw new Error("wrong quote channel");
            },
          };
          const unusedEntry = runtimeEntryFixture().options;
          runtime = createLocalCustomerRuntime({
            scope,
            entry: { ...unusedEntry, session: { ...unusedEntry.session, ...entry.sessionOptions } },
            sessionTransactions: entry.sessionTransactions,
            menuTransactions: entry.catalogTransactions,
            menuStores: { resolvePublic: async () => null },
            cartTransactions: runner(false),
            configuredCartQuote: dining
              ? { pickup: unusedChannel, dining: port }
              : { pickup: port, dining: unusedChannel },
            allowedOrigin: "https://customer.example.test",
            now: () => currentAt,
            uuidV7Factory: references.generateReference,
            runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
          });
          await runtime.listen();
          const address = runtime.server.address();
          assert.ok(address && typeof address === "object");
          const send = async (operationReference = id(900), csrf = entry.csrfCredential) => {
            const response = await globalThis.fetch(
              "http://127.0.0.1:" + address.port + "/api/v1/carts/" + cart.cartReference + "/quote",
              {
                method: "POST",
                headers: {
                  origin: "https://customer.example.test",
                  "sec-fetch-site": "same-origin",
                  "content-type": "application/json",
                  cookie: "__Host-bop-guest=" + entry.sessionCredential,
                  "x-csrf-token": csrf,
                  "idempotency-key": operationReference,
                },
                body: JSON.stringify({ cartVersion: cart.aggregateVersion }),
              },
            );
            assert.equal(response.headers.get("cache-control"), "no-store");
            return { status: response.status, body: await response.json() };
          };

          const command = {
            cartReference: cart.cartReference,
            expectedCartVersion: cart.aggregateVersion,
            operationReference: id(900),
            sessionCredential: entry.sessionCredential,
            csrfCredential: entry.csrfCredential,
          };
          const counts = async () =>
            (
              await admin.query(
                "SELECT (SELECT count(*)::integer FROM rms_pricing.price_quote) AS quotes,(SELECT count(*)::integer FROM rms_pricing.price_quote_request) AS requests,(SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment) AS attachments,(SELECT count(*)::integer FROM platform_audit.audit_record) AS audits",
              )
            ).rows[0];
          await assert.rejects(service.attach({ ...command, csrfCredential: "x".repeat(43) }), {
            code: "CART_PERMISSION_DENIED",
          });
          assert.equal(candidateCalls, 0);
          assert.deepEqual(await counts(), { quotes: 0, requests: 0, attachments: 0, audits: 0 });
          assert.equal((await send()).status, 503);
          assert.deepEqual(await counts(), { quotes: 1, requests: 1, attachments: 0, audits: 1 });
          assert.equal(candidateCalls, 1);
          assert.equal(entry.catalogReads(), 0);
          assert.equal((await send()).status, 503);
          assert.deepEqual(await counts(), { quotes: 1, requests: 1, attachments: 1, audits: 2 });
          const httpQuote = await send();
          assert.equal(httpQuote.status, 201);
          assert.equal(httpQuote.body.quote.quoteVersion, 2);
          assert.deepEqual(httpQuote.body.quote.total, { amountMinor: "2825", currency: "CAD" });
          assert.equal(JSON.stringify(httpQuote.body).includes("optionPrices"), false);
          assert.equal(JSON.stringify(httpQuote.body).includes(guest.sessionReference), false);
          const original = await attachments.resolveOperation(command.operationReference);
          assert.ok(original);
          assert.equal(original.quoteVersion, 2);
          assert.deepEqual(original.total, quote.total);
          const recovered = await Promise.all([service.attach(command), service.attach(command)]);
          assert.ok(recovered.every((result) => result.status === "AlreadyAttached"));
          assert.deepEqual(recovered[0].attachment, original);
          assert.deepEqual(recovered[1].attachment, original);
          assert.equal(candidateCalls, 1);
          assert.ok(entry.catalogReads() > 0);
          const persisted = await requests.resolve({
            operationReference: command.operationReference,
            guestSessionReference: guest.sessionReference,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            observedAt: currentAt,
          });
          assert.deepEqual(persisted.quote, quote);
          assert.equal(persisted.quote.lines[0].optionPrices[0].rule.bindingReference, id(62));
          // Actual Checkout producer; fulfillment/Store/Inventory readiness stays explicit synthetic evidence.
          const originalEvidence = orderWriteFixture({ at: currentAt }).request
            .checkoutValidationEvidence;
          const binding = {
            ...scope,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            quoteReference: quote.quoteReference,
            orderType: cart.orderType,
            sourceChannel: cart.sourceChannel,
          };
          const expectedConfiguredEvidence = {
            ...originalEvidence,
            ...binding,
            quoteVersion: 2,
            quoteInputDigest: quote.inputDigest,
            guestSessionReference: guest.sessionReference,
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
              ...originalEvidence.fulfillment,
              ...binding,
              checkedAt: currentAt,
              validUntil: quote.expiresAt,
            },
          };
          const catalogScope = { ...entry.catalogScope, ...scope, orderType: cart.orderType };
          const safety = { ...entry.catalogSafety, clock: { now: () => currentAt } };
          const checkout = createConfiguredCheckoutValidationService({
            authorization: {
              authorize: async ({ observedAt }) => {
                await service.attach(command); // existing current Pickup/Dining entry authorization
                return {
                  guestSession: await entry.sessions.authorize({
                    sessionCredential: entry.sessionCredential,
                    csrfCredential: entry.csrfCredential,
                    observedAt,
                  }),
                };
              },
            },
            repository: {
              loadCart: createPostgresCartQueryStore(runner(false), scope).load,
              loadQuote: async () => attachments.resolveOperation(command.operationReference),
            },
            catalog: createPostgresCatalogSelectionService(
              entry.catalogTransactions,
              catalogScope,
              safety,
            ),
            snapshots: createPostgresCatalogOrderSnapshotSource(
              entry.catalogTransactions,
              catalogScope,
              safety,
              entry.catalogReferences,
            ),
            history: createPostgresConfiguredPriceQuoteHistoryReader(runner(true), scope),
            pricingChannelCode: f.pricingChannelCode,
            now: () => currentAt,
            references,
            fulfillment: { validate: async () => expectedConfiguredEvidence.fulfillment },
          });
          const configuredEvidence = await checkout.validate({
            validationReference: expectedConfiguredEvidence.validationReference,
            cartReference: cart.cartReference,
            expectedCartVersion: cart.aggregateVersion,
            quoteReference: quote.quoteReference,
            requestedAt: currentAt,
          });
          assert.equal(configuredEvidence.quoteVersion, 2);
          assert.equal(configuredEvidence.guestSessionReference, guest.sessionReference);
          const orderPrices = await createConfiguredOrderPricingSource({
            scope,
            history: createPostgresConfiguredPriceQuoteHistoryReader(runner(true), scope),
            clock: { now: () => currentAt },
          }).load({ evidence: configuredEvidence });
          assert.equal(orderPrices[0].quoteVersion, 2);
          assert.equal(orderPrices[0].priceResolution.unitPrice.amountMinor, 1000n);
          assert.equal(orderPrices[0].unitPrice.amountMinor, 1250n);
          assert.equal(orderPrices[0].total.amountMinor, 2825n);
          assert.equal(orderPrices[0].optionPrices[0].chargedQuantity, 4n);
          assert.equal(
            orderPrices[0].optionPrices[0].ruleVersionReference,
            persisted.quote.lines[0].optionPrices[0].rule.versionReference,
          );

          const orderSource = createCustomerConfiguredOrderSourceComposition({
            scope,
            cartTransactions: runner(false),
            catalogTransactions: entry.catalogTransactions,
            pricingTransactions: runner(true),
            catalogScope,
            catalogSafety: entry.catalogSafety,
            catalogReferences: entry.catalogReferences,
            clock: { now: () => currentAt },
          });
          const loadedOrderSource = await orderSource.load({ evidence: configuredEvidence });
          const actualCart = loadedOrderSource.cart;
          const itemInputs = loadedOrderSource.lines.map((line) => ({
            ...line,
            orderItemReference: id(next++),
          }));
          assert.deepEqual(itemInputs[0].pricing, orderPrices[0]);
          const transactionItems = createConfiguredOrderItemSnapshots({
            orderReference: id(next++),
            orderBatchReference: id(next++),
            snapshotCapturedAt: currentAt,
            checkoutValidationEvidence: configuredEvidence,
            cart: actualCart,
            lines: itemInputs,
          });
          assert.equal(transactionItems[0].catalog.options[0].quantity, 3);
          const encodedItem = encodeConfiguredOrderItemSnapshot(transactionItems[0]);
          // Actual PostgreSQL JSONB conversion; not an Order table write.
          const wireItem = (await admin.query("SELECT $1::jsonb AS snapshot", [encodedItem]))
            .rows[0].snapshot;
          assert.equal(wireItem.pricing.optionPrices[0].chargedQuantity, "4");
          assert.deepEqual(decodeConfiguredOrderItemSnapshot(wireItem), transactionItems[0]);
          const retryCommand = { ...command, operationReference: id(901) };
          failAttachmentAudit = true;
          await assert.rejects(service.attach(retryCommand), {
            code: "CART_DEPENDENCY_UNAVAILABLE",
          });
          assert.equal(await attachments.resolveOperation(retryCommand.operationReference), null);
          assert.deepEqual(await counts(), { quotes: 2, requests: 2, attachments: 1, audits: 3 });
          assert.equal(auditFailures, 1);
          failAttachmentAudit = false;
          assert.equal((await service.attach(retryCommand)).status, "Attached");
          assert.deepEqual(await counts(), { quotes: 2, requests: 2, attachments: 2, audits: 4 });
          mismatchedCandidate = true;
          await assert.rejects(service.attach({ ...command, operationReference: id(902) }), {
            code: "CART_QUOTE_INVALID",
          });
          assert.deepEqual(await counts(), { quotes: 2, requests: 2, attachments: 2, audits: 4 });
          mismatchedCandidate = false;
          await admin.query("UPDATE rms_catalog.sku SET lifecycle='Archived' WHERE sku_id=$1", [
            cart.items[0].sellableReference,
          ]);
          await assert.rejects(orderSource.load({ evidence: configuredEvidence }), {
            code: "ORDER_SUBMISSION_SOURCE_UNAVAILABLE",
          });
          const withheld = { ...command, operationReference: id(903) };
          await assert.rejects(service.attach(withheld), { code: "CART_DEPENDENCY_UNAVAILABLE" });
          assert.equal(await attachments.resolveOperation(withheld.operationReference), null);
          assert.deepEqual(await counts(), { quotes: 3, requests: 3, attachments: 2, audits: 5 });
          await admin.query("UPDATE rms_catalog.sku SET lifecycle='Active' WHERE sku_id=$1", [
            cart.items[0].sellableReference,
          ]);
          const beforeRecovery = candidateCalls;
          assert.equal((await service.attach(withheld)).status, "Attached");
          assert.equal(candidateCalls, beforeRecovery);
          assert.deepEqual(await counts(), { quotes: 3, requests: 3, attachments: 3, audits: 6 });
          const shortQuote = {
            ...quote,
            quoteReference: id(904),
            expiresAt: new Date(Date.parse(f.observedAt) + 1).toISOString(),
          };
          await requests.append({
            operationReference: id(904),
            guestSessionReference: guest.sessionReference,
            observedAt: f.observedAt,
            quote: shortQuote,
            audit: audit("PricingPriceQuote", shortQuote.quoteReference, shortQuote.createdAt),
          });
          currentAt = shortQuote.expiresAt;
          const expired = await send(id(904));
          assert.equal(expired.status, 410);
          assert.equal(expired.body.error.code, "quote_operation_expired");
          assert.deepEqual(await send(id(904)), expired);
          assert.deepEqual(await counts(), { quotes: 4, requests: 4, attachments: 3, audits: 8 });
          const beforeExpiry = {
            candidateCalls,
            catalogReads: entry.catalogReads(),
            policyReads: policy.reads(),
          };
          currentAt = quote.expiresAt;
          assert.deepEqual((await service.attach(command)).attachment, original);
          assert.deepEqual(
            { candidateCalls, catalogReads: entry.catalogReads(), policyReads: policy.reads() },
            beforeExpiry,
          );
          assert.deepEqual(await send(), httpQuote);
          await entry.revoke();
          assert.equal((await send()).status, 404);
          assert.equal((await send(id(904))).status, 404);
          await assert.rejects(service.attach(command), { code: "CART_PERMISSION_DENIED" });
          assert.deepEqual(await counts(), { quotes: 4, requests: 4, attachments: 3, audits: 8 });
          assert.equal(active, 0);
        } finally {
          if (runtime) await runtime.shutdown("SIGTERM");
          await policy?.cleanup();
          await entry?.cleanup();
          for (const role of createdRoles.reverse()) {
            await admin.query("DROP OWNED BY " + role);
            await admin.query("DROP ROLE " + role);
          }
          await admin.end();
        }
      },
    );
  },
);
