import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresConfiguredOrderCreationStore,
  createCapacityLinkedOrderCreationService,
  createPostgresCapacityLinkedOrderCreationRepository,
  createPostgresOrderCreationQueryStore,
  createOrderCreatedEnvelope,
  parseConfiguredOrderItemTransactionSnapshot,
} from "../../rms/ordering/src/index.ts";
import {
  orderWriteFixture,
  orderCapacityLinkFixture,
} from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { orderCreatedSourceInput } from "../../rms/ordering/src/application/order-created-source.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
function fixture(dining, suffix) {
  const f = orderWriteFixture({ namespace: "019024" + suffix, dineIn: dining });
  const original = f.request.record.items[0],
    price = original.pricing,
    selected = original.catalog.options[0];
  assert.equal(original.quantity, 2);
  assert.equal(selected.quantity, 1);
  const reference = (n) => f.scope.brandReference.slice(0, -12) + n.toString(16).padStart(12, "0");
  const option = {
    ruleReference: reference(710),
    ruleVersionReference: reference(711),
    ruleDigest: price.quoteInputDigest,
    bindingReference: selected.bindingReference,
    optionReference: selected.optionReference,
    brandReference: f.scope.brandReference,
    storeReference: f.scope.storeReference,
    sellableReference: original.catalog.sellableReference,
    storeGroupReference: null,
    regionReference: null,
    channelCode: price.priceResolution.channelCode ?? "PILOT_CHANNEL",
    orderType: f.cart.orderType,
    ruleSkuReference: original.catalog.sellableReference,
    scopeKind: "Brand",
    scopeReference: null,
    ruleChannelCode: null,
    ruleOrderType: null,
    priority: 8,
    selectedQuantity: 1,
    includedQuantity: 0,
    chargedQuantityPerItem: 1,
    chargedQuantity: 2n,
    quantityBasis: "PerItemChoice",
    unitPrice: { amountMinor: 125n, currencyCode: "CAD" },
    subtotal: { amountMinor: 250n, currencyCode: "CAD" },
    taxBasis: "ParentSellable",
    taxClassificationReference: original.catalog.taxClassificationReference,
    effectiveFrom: price.priceResolution.effectiveFrom,
    effectiveUntil: price.priceResolution.effectiveUntil,
    ruleCreatedAt: price.quotedAt,
  };
  const item = parseConfiguredOrderItemTransactionSnapshot({
    ...original,
    catalog: { ...original.catalog, skuReference: original.catalog.sellableReference },
    pricing: {
      ...price,
      quoteVersion: 2,
      optionPrices: [option],
      unitPrice: { amountMinor: 1125n, currencyCode: "CAD" },
      subtotal: { amountMinor: 2250n, currencyCode: "CAD" },
      tax: { amountMinor: 293n, currencyCode: "CAD" },
      total: { amountMinor: 2543n, currencyCode: "CAD" },
      taxComponents: price.taxComponents.map((component) => ({
        ...component,
        taxAmount: { amountMinor: 293n, currencyCode: "CAD" },
      })),
    },
  });
  const record = { ...f.request.record, items: [item] };
  return {
    ...f,
    request: {
      ...f.request,
      record,
      checkoutValidationEvidence: { ...f.request.checkoutValidationEvidence, quoteVersion: 2 },
      event: createOrderCreatedEnvelope({
        eventReference: f.request.event.eventId,
        correlationReference: f.request.audit.correlationId,
        sourceSnapshotDigest: hash(
          orderCreatedSourceInput(record, f.request.businessDateResolution),
        ),
        businessDate: f.request.businessDateResolution.businessDate,
        record,
      }),
    },
  };
}
it.each([false, true])(
  "persists and recovers configured Order transaction for Dining=%s",
  async (dining) => {
    await withIsolatedDatabase(
      { caseId: dining ? "wp2402_co_dine" : "wp2402_co_pick" },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        const role = "wp2402_co_" + context.runId;
        assert.match(role, /^wp2402_co_[a-f0-9]+$/u);
        let created = false,
          active = 0;
        const runner = (fault = {}) => ({
          async run(action) {
            const client = new Client({
              ...context.clientConfig,
              query_timeout: 10000,
              connectionTimeoutMillis: 2000,
            });
            await client.connect();
            active++;
            let committed = false;
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL statement_timeout='10s'");
              const result = await action({
                query: async (sql, values) => {
                  if (fault.audit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
                    throw new Error("synthetic Audit fault");
                  const result = await client.query(sql, [...values]);
                  if (fault.afterCartClear && sql.startsWith("DELETE FROM rms_ordering.cart_line"))
                    throw new Error("synthetic failure after Cart line clear");
                  if (
                    fault.afterCartAdvance &&
                    sql.startsWith("UPDATE rms_ordering.cart SET aggregate_version")
                  )
                    throw new Error("synthetic failure after Cart version advance");
                  return result;
                },
              });
              await client.query("COMMIT");
              committed = true;
              if (fault.commit) throw new Error("synthetic lost commit acknowledgement");
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
        const counts = async (f) =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_ordering.order_header WHERE brand_id=$1) AS orders,(SELECT count(*)::int FROM rms_ordering.order_revision WHERE brand_id=$1) AS revisions,(SELECT count(*)::int FROM rms_ordering.order_item WHERE brand_id=$1) AS items,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1) AS events",
              [f.scope.brandReference],
            )
          ).rows[0];
        try {
          await admin.query(
            "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
          );
          created = true;
          await admin.query(
            "GRANT USAGE ON SCHEMA rms_ordering,platform_helpers,platform_audit,platform_eventing TO " +
              role,
          );
          await admin.query(
            "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
              role,
          );
          await admin.query("GRANT SELECT,UPDATE ON rms_ordering.cart TO " + role);
          await admin.query("GRANT SELECT,DELETE ON rms_ordering.cart_line TO " + role);
          await admin.query(
            "GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_number_counter,platform_audit.audit_chain_head TO " +
              role,
          );
          await admin.query(
            "GRANT SELECT,INSERT ON rms_ordering.order_number_allocation,rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_revision,rms_ordering.order_batch,rms_ordering.order_item,rms_ordering.order_capacity_link,platform_audit.audit_record,platform_eventing.outbox_event TO " +
              role,
          );
          const f = fixture(dining, "10");
          await seedSubmissionCart(admin, f);
          await assert.rejects(
            createPostgresConfiguredOrderCreationStore(runner({ commit: true }), f.scope).append(
              f.request,
            ),
            { code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE" },
          );
          assert.deepEqual(await counts(f), {
            orders: 1,
            revisions: 1,
            items: 1,
            audits: 1,
            events: 1,
          });
          const writer = createPostgresConfiguredOrderCreationStore(runner(), f.scope);
          const replay = await Promise.all([writer.append(f.request), writer.append(f.request)]);
          assert.ok(replay.every((value) => value.status === "Existing"));
          assert.deepEqual(replay[0].record.items, f.request.record.items);
          const reader = createPostgresOrderCreationQueryStore(runner(), f.scope, 2);
          assert.deepEqual(
            await reader.resolveSubmission(f.request.record.submissionReference),
            replay[0].record,
          );
          assert.deepEqual(await counts(f), {
            orders: 1,
            revisions: 1,
            items: 1,
            audits: 1,
            events: 1,
          });
          const root = (
            await admin.query(
              "SELECT revision_id,version,expected_version,previous_revision_id,initial_submission_id,kind FROM rms_ordering.order_revision WHERE order_id=$1",
              [f.request.record.order.orderReference],
            )
          ).rows;
          assert.deepEqual(root, [
            {
              revision_id: f.request.record.submissionReference,
              version: 1,
              expected_version: 0,
              previous_revision_id: null,
              initial_submission_id: f.request.record.submissionReference,
              kind: "Initial",
            },
          ]);
          assert.equal(
            (
              await admin.query(
                "UPDATE rms_ordering.order_revision SET version=2 WHERE revision_id=$1",
                [f.request.record.submissionReference],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await admin.query("DELETE FROM rms_ordering.order_revision WHERE revision_id=$1", [
                f.request.record.submissionReference,
              ])
            ).rowCount,
            0,
          );
          const wire = (
            await admin.query(
              "SELECT transaction_snapshot_json FROM rms_ordering.order_item WHERE order_id=$1",
              [f.request.record.order.orderReference],
            )
          ).rows[0].transaction_snapshot_json;
          assert.equal(wire.pricing.optionPrices[0].chargedQuantity, "2");
          assert.equal(wire.pricing.total.amountMinor, "2543");
          await assert.rejects(
            createPostgresOrderCreationQueryStore(runner(), f.scope).resolveSubmission(
              f.request.record.submissionReference,
            ),
          );
          assert.equal(
            await createPostgresOrderCreationQueryStore(
              runner(),
              { ...f.scope, storeReference: f.scope.brandReference },
              2,
            ).resolveSubmission(f.request.record.submissionReference),
            null,
          );
          const failed = fixture(dining, "11");
          await seedSubmissionCart(admin, failed);
          await assert.rejects(
            createPostgresConfiguredOrderCreationStore(
              runner({ audit: true }),
              failed.scope,
            ).append(failed.request),
          );
          assert.deepEqual(await counts(failed), {
            orders: 0,
            revisions: 0,
            items: 0,
            audits: 0,
            events: 0,
          });
          const recovered = await createPostgresConfiguredOrderCreationStore(
            runner(),
            failed.scope,
          ).append(failed.request);
          assert.equal(recovered.status, "Created");
          assert.equal(recovered.record.orderNumberAllocation.sequence, 1n);
          assert.deepEqual(await counts(failed), {
            orders: 1,
            revisions: 1,
            items: 1,
            audits: 1,
            events: 1,
          });

          if (dining) {
            for (const [index, fault] of [
              { afterCartClear: true },
              { afterCartAdvance: true },
            ].entries()) {
              const clearing = fixture(true, String(30 + index));
              await seedSubmissionCart(admin, clearing);
              const cartState = async () =>
                (
                  await admin.query(
                    "SELECT aggregate_version,updated_at,idle_expires_at,(SELECT count(*)::int FROM rms_ordering.cart_line l WHERE l.cart_id=c.cart_id) AS lines FROM rms_ordering.cart c WHERE c.cart_id=$1",
                    [clearing.cart.cartReference],
                  )
                ).rows[0];
              const before = await cartState();
              await assert.rejects(
                createPostgresConfiguredOrderCreationStore(runner(fault), clearing.scope).append(
                  clearing.request,
                ),
              );
              assert.deepEqual(await cartState(), before);
              assert.deepEqual(await counts(clearing), {
                orders: 0,
                revisions: 0,
                items: 0,
                audits: 0,
                events: 0,
              });
              const recoveredClear = await createPostgresConfiguredOrderCreationStore(
                runner(),
                clearing.scope,
              ).append(clearing.request);
              assert.equal(recoveredClear.status, "Created");
              assert.equal(recoveredClear.record.orderNumberAllocation.sequence, 1n);
              const after = await cartState();
              assert.equal(after.aggregate_version, before.aggregate_version + 1);
              assert.equal(after.lines, 0);
              const replayClear = await createPostgresConfiguredOrderCreationStore(
                runner(),
                clearing.scope,
              ).append(clearing.request);
              assert.equal(replayClear.status, "Existing");
              assert.deepEqual(await cartState(), after);
              assert.deepEqual(await counts(clearing), {
                orders: 1,
                revisions: 1,
                items: 1,
                audits: 1,
                events: 1,
              });
            }
          }

          // Synthetic readiness and Guest ports exercise the actual v2 application + owner writer.
          // Current persisted Identity/Catalog/Pricing composition remains a separate journey gate.
          for (const loseAck of [true, false]) {
            const submitted = fixture(dining, loseAck ? "12" : "13");
            await seedSubmissionCart(admin, submitted);
            const record = submitted.request.record,
              evidence = submitted.request.checkoutValidationEvidence;
            const reference = (n) =>
              submitted.scope.brandReference.slice(0, -12) + n.toString(16).padStart(12, "0");
            const guest = {
              sessionReference: evidence.guestSessionReference,
              status: "Active",
              version: 1,
              brandReference: submitted.scope.brandReference,
              storeReference: submitted.scope.storeReference,
              publicStoreReference: reference(750),
              publicTableReference: dining ? reference(751) : null,
              channel: dining ? "DineIn" : "Pickup",
              locale: "en-CA",
              qrReference: reference(752),
              qrRevocationVersion: 1,
              diningState: dining ? "DiningBound" : "ContextOnly",
              diningSessionReference: record.order.diningSessionReference,
              diningParticipantReference: dining
                ? submitted.cart.items[0].addedByParticipantReference
                : null,
              createdAt: record.createdAt,
              lastSeenAt: record.createdAt,
              idleExpiresAt: new Date(Date.parse(record.createdAt) + 4 * 3600000).toISOString(),
              absoluteExpiresAt: new Date(Date.parse(record.createdAt) + 86400000).toISOString(),
              orderClosedAt: null,
              closureExpiresAt: null,
              rotatedFromGuestSessionReference: null,
              revocationReason: null,
              revokedAt: null,
            };
            let authorized = true,
              checkoutCalls = 0;
            const link = orderCapacityLinkFixture(submitted);
            const command = {
              submissionReference: record.submissionReference,
              cartReference: submitted.cart.cartReference,
              expectedCartVersion: submitted.cart.aggregateVersion,
              quoteReference: evidence.quoteReference,
              requestedAt: record.createdAt,
            };
            const service = (fault = {}) =>
              createCapacityLinkedOrderCreationService(
                {
                  clock: { now: () => new Date().toISOString() },
                  authorization: {
                    authorize: async () => (authorized ? { guestSession: guest } : null),
                  },
                  checkout: {
                    validate: async () => {
                      checkoutCalls++;
                      return evidence;
                    },
                  },
                  source: {
                    load: async () => ({
                      cart: submitted.cart,
                      lines: record.items.map((item) => ({
                        cartItemReference: item.cartItemReference,
                        catalog: item.catalog,
                        pricing: item.pricing,
                      })),
                    }),
                  },
                  businessDate: { resolve: async () => submitted.request.businessDateResolution },
                  references: {
                    generate: (purpose) =>
                      ({
                        CheckoutValidation: evidence.validationReference,
                        Order: record.order.orderReference,
                        OrderBatch: record.order.batches[0].orderBatchReference,
                        OrderItem: record.items[0].orderItemReference,
                        Event: submitted.request.event.eventId,
                      })[purpose],
                    hashIntent: hash,
                    equals: (a, b) => a === b,
                  },
                  audit: { create: async () => submitted.request.audit },
                  repository: createPostgresCapacityLinkedOrderCreationRepository(
                    {
                      query: runner(),
                      write: runner(fault),
                    },
                    submitted.scope,
                    link,
                    2,
                  ),
                },
                link,
                2,
              );
            if (loseAck)
              await assert.rejects(service({ commit: true }).create(command), {
                code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
              });
            else {
              const created = await service().create(command);
              assert.equal(created.status, "Created");
              assert.deepEqual(created.record.items, record.items);
            }
            assert.deepEqual(await counts(submitted), {
              orders: 1,
              revisions: 1,
              items: 1,
              audits: 1,
              events: 1,
            });
            const applicationReplay = await service().create(command);
            assert.equal(applicationReplay.status, "AlreadyCreated");
            assert.deepEqual(applicationReplay.record.items, record.items);
            assert.equal(checkoutCalls, 1);
            authorized = false;
            await assert.rejects(service().create(command), {
              code: "ORDER_CREATE_PERMISSION_DENIED",
            });
            assert.equal(checkoutCalls, 1);
            assert.deepEqual(await counts(submitted), {
              orders: 1,
              revisions: 1,
              items: 1,
              audits: 1,
              events: 1,
            });
            assert.equal(active, 0);
          }
        } finally {
          if (created) {
            await admin.query("DROP OWNED BY " + role);
            await admin.query("DROP ROLE " + role);
          }
          await admin.end();
        }
      },
    );
  },
);
