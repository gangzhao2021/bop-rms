import { seedAdditionalOriginalQuote } from "../test-support/additional-original-quote.mjs";
import { exerciseAdditionalDiningPayment } from "../test-support/additional-dining-payment.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { createCustomerAdditionalDiningSubmissionRuntime } from "../../../apps/api/src/customer-additional-dining-submission-runtime.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { seedAdditionalDiningCommitment } from "../test-support/additional-dining-commitment.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import {
  createOrderNumberAllocation,
  createOrderItemSnapshots,
  parseCheckoutValidationEvidence,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";

const id = (n) => "01909996-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it.each([false, true])(
  "atomically appends and recovers (refund result write fault=%s)",
  async (refundObservationFault) => {
    await withIsolatedDatabase(
      { caseId: refundObservationFault ? "wp2402_refund_fault" : "wp2402_add_writer" },
      async (context) => {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          const at = new Date(Date.now() - 1000).toISOString();
          const f = orderWriteFixture({ at, dineIn: true });
          const ownerScope = { ...f.scope, tenantReference: id(900) };
          const dining = await seedAdditionalDiningCommitment(client, f, ownerScope);
          const evidence = parseCheckoutValidationEvidence({
            ...f.request.checkoutValidationEvidence,
            fulfillment: {
              ...f.request.checkoutValidationEvidence.fulfillment,
              evidenceDigest: dining.link.ownerSnapshotDigest,
            },
          });
          f.request.checkoutValidationEvidence = evidence;
          f.snapshotInput = { ...f.snapshotInput, checkoutValidationEvidence: evidence };
          const r = {
            ...f.request.record,
            items: createOrderItemSnapshots({
              ...f.snapshotInput,
              lines: f.snapshotInput.lines.map((line) => ({
                ...line,
                catalog: { ...line.catalog, skuReference: line.catalog.sellableReference },
                pricing: {
                  ...line.pricing,
                  taxComponents: line.pricing.taxComponents.map((component) => ({
                    ...component,
                    jurisdictionCode: "CA-ON",
                  })),
                },
              })),
            }),
          };
          const initial = orderWriteFixture({
            at: new Date(Date.parse(at) - 60000).toISOString(),
            dineIn: true,
          });
          // Keep the Order/session/actors, but give the initial batch independent source identities.
          const priorBatch = initial.request.record.order.batches[0];
          const replaced = new Set([
            priorBatch.orderBatchReference,
            priorBatch.submissionReference,
            priorBatch.sourceCartReference,
            priorBatch.quoteReference,
            priorBatch.checkoutValidationReference,
            ...initial.request.record.items.flatMap((item) => [
              item.orderItemReference,
              item.cartItemReference,
            ]),
          ]);
          const remap = (v) => {
            if (typeof v === "string" && replaced.has(v)) return "01909995" + v.slice(8);
            if (Array.isArray(v)) return v.map(remap);
            if (v !== null && typeof v === "object")
              return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)]));
            return v;
          };
          const prior = remap(initial.request.record);
          await seedAcceptanceOrderHistory(client, {
            ...prior,
            orderNumberAllocation: createOrderNumberAllocation({
              orderReference: prior.order.orderReference,
              allocatedAt: prior.createdAt,
              sequence: 1n,
              businessDateResolution: initial.request.businessDateResolution,
            }),
          });
          await seedSubmissionCart(client, f);
          const snapshot = parseAdditionalDiningBatchSnapshot({
            orderReference: r.order.orderReference,
            brandReference: r.order.brandReference,
            storeReference: r.order.storeReference,
            diningSessionReference: r.order.diningSessionReference,
            guestSessionReference: r.guestSessionReference,
            originalOrderCreatedAt: prior.createdAt,
            expectedOrderVersion: 1,
            batchSequence: 2,
            snapshotVersion: 1,
            batch: r.order.batches[0],
            items: r.items,
          });
          const link = dining.link;
          const checkout = {
            schemaVersion: 1,
            checkoutSessionReference: id(1),
            createOperationReference: id(2),
            submissionReference: snapshot.batch.submissionReference,
            paymentOperationReference: link.paymentOperationReference,
            validation: f.request.checkoutValidationEvidence,
            createdAt: at,
          };
          const details = {
            schemaVersion: 1,
            detailsReference: id(3),
            detailsVersion: 1,
            ...f.scope,
            guestSessionReference: r.guestSessionReference,
            cartReference: f.cart.cartReference,
            cartVersion: f.cart.aggregateVersion,
            quoteReference: snapshot.batch.quoteReference,
            quoteVersion: 1,
            orderType: "DineIn",
            pickupContact: null,
            receipt: { choice: "InSession", email: null },
            policies: [],
            recordedAt: at,
          };
          await client.query(
            "INSERT INTO rms_ordering.checkout_session_record (brand_id,store_id,checkout_session_id,create_operation_id,submission_id,payment_operation_id,guest_session_id,cart_id,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
            [
              r.order.brandReference,
              r.order.storeReference,
              id(1),
              id(2),
              snapshot.batch.submissionReference,
              link.paymentOperationReference,
              r.guestSessionReference,
              f.cart.cartReference,
              JSON.stringify(checkout),
              at,
            ],
          );
          await client.query(
            "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8)",
            [
              r.order.brandReference,
              r.order.storeReference,
              id(3),
              id(4),
              r.guestSessionReference,
              f.cart.cartReference,
              JSON.stringify(details),
              at,
            ],
          );
          const runner = () => ({
            async run(work) {
              const connection = new pg.Client(context.clientConfig);
              await connection.connect();
              try {
                await connection.query("BEGIN");
                const result = await work({
                  query: (sql, values) => connection.query(sql, values),
                });
                await connection.query("COMMIT");
                return result;
              } catch (error) {
                await connection.query("ROLLBACK");
                throw error;
              } finally {
                await connection.end();
              }
            },
          });
          await seedAdditionalOriginalQuote({ runner, scope: ownerScope, snapshot });
          const stock = await seedSubmissionInventoryStock({
            admin: client,
            runner,
            ownerScope,
            actorReference: r.guestSessionReference,
            at,
          });
          await seedSubmissionInventoryRecipe({
            admin: client,
            scope: ownerScope,
            actorReference: r.guestSessionReference,
            at,
            cart: f.cart,
            stock,
          });
          const workflow = await seedSubmissionInventoryWorkflow({
            runner,
            scope: ownerScope,
            actorReference: r.guestSessionReference,
            at,
            orderType: "DineIn",
          });
          let reference = 100000;
          const inventory = {
            scope: ownerScope,
            stockSiteReference: stock.stockSiteReference,
            workflow,
            authorize: async (_tx, input) => input.actorReference === r.guestSessionReference,
            resolveExpiryCutoff: stock.resolveExpiryCutoff,
            generateReference: () => id(++reference),
            audit: {
              reasonCode: "SYNTHETIC_SUBMISSION",
              sourceChannel: "CUSTOMER_PWA",
              retentionPolicyCode: "SYNTHETIC_AUDIT",
              retentionPolicyVersion: 1,
            },
          };
          const inventoryState = async () =>
            (
              await client.query(
                "SELECT (SELECT count(*)::int FROM rms_inventory.stock_reservation_set) AS sets,(SELECT count(*)::int FROM rms_inventory.submission_final_validation) AS finals,(SELECT reserved::text FROM rms_inventory.stock_balance WHERE account_id=$1) AS reserved",
                [stock.accountReference],
              )
            ).rows[0];
          const diningState = async () =>
            (
              await client.query(
                "SELECT version,state FROM rms_dining.dining_checkout_commitment ORDER BY version",
              )
            ).rows;
          let rejectFinalization = true;
          let finalizations = 0;
          let revokeAfterWrite = false;
          let authorityCalls = 0;
          let afterSealFailures = 0;
          const tx = {
            async query(sql, values) {
              if (
                rejectFinalization &&
                sql.startsWith("INSERT INTO platform_eventing.outbox_event")
              ) {
                const state = await diningState();
                assert.deepEqual(
                  state.map((row) => row.state),
                  ["Prepared", "PaymentPending"],
                );
                assert.equal((await inventoryState()).finals, 1);
                afterSealFailures++;
                throw new Error("synthetic outbox write failure after owner finalization");
              }
              return client.query(sql, values);
            },
          };
          const storeOptions = {
            ...f.scope,
            authorize: async () => !(revokeAfterWrite && ++authorityCalls === 3),
            audit: async () => ({
              ...f.request.audit,
              actionCode: "ORDERING_ADDITIONAL_BATCH_SUBMIT",
              targetType: "OrderingOrderBatch",
              targetId: snapshot.batch.orderBatchReference,
              reasonCode: "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
            }),
            eventReference: () => id(5),
            currentPolicies: async (_tx, request) => ({
              ...f.scope,
              orderType: "DineIn",
              checkedAt: request.observedAt,
              validUntil: f.request.checkoutValidationEvidence.validUntil,
              required: [],
            }),
            inventory,
            diningSealAudit: async (record) => dining.audit(record),
            validateCurrent: async (transaction, candidate, actualLink, context) => {
              finalizations++;
              assert.equal(transaction, tx);
              assert.deepEqual(candidate, snapshot);
              assert.deepEqual(actualLink, link);
              assert.equal(context.cart.cartReference, f.cart.cartReference);
            },
          };
          const store = createCustomerAdditionalDiningSubmissionStore(storeOptions);
          const append = async () => {
            authorityCalls = 0;
            await client.query("BEGIN");
            try {
              const result = await store.append({
                transaction: tx,
                snapshot,
                capacityLink: link,
                checkoutValidationEvidence: f.request.checkoutValidationEvidence,
              });
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          };
          const guest = await seedAdditionalDiningGuest({ client, runner, f, dining, at });
          const runtime = createCustomerAdditionalDiningSubmissionRuntime({
            ...storeOptions,
            transactions: runner(),
            identity: () => guest.identity,
            validateCurrent: async (_transaction, candidate, actualLink) => {
              finalizations++;
              assert.deepEqual(candidate, snapshot);
              assert.deepEqual(actualLink, link);
            },
          });
          const submit = (csrfCredential = guest.csrfCredential) =>
            runtime.submit({
              sessionCredential: guest.sessionCredential,
              csrfCredential,
              snapshot,
              checkoutValidationEvidence: evidence,
              capacityLink: link,
              tipSelectionReference: guest.tipSelectionReference,
            });
          const counts = async () =>
            (
              await client.query(
                "SELECT (SELECT count(*)::int FROM rms_ordering.order_submission_record) AS submissions,(SELECT count(*)::int FROM rms_ordering.order_batch) AS batches,(SELECT count(*)::int FROM rms_ordering.order_revision) AS revisions,(SELECT count(*)::int FROM rms_ordering.additional_dining_batch_record) AS additional,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_ADDITIONAL_BATCH_SUBMIT') AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderSubmitted') AS events,(SELECT count(*)::int FROM rms_ordering.cart_line) AS lines",
              )
            ).rows[0];
          const before = await counts();
          const inventoryBefore = await inventoryState();
          const diningBefore = await diningState();
          await assert.rejects(append());
          assert.equal(finalizations, 1);
          assert.equal(afterSealFailures, 1);
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await inventoryState(), inventoryBefore);
          assert.deepEqual(await diningState(), diningBefore);
          rejectFinalization = false;
          revokeAfterWrite = true;
          await assert.rejects(append());
          assert.equal(authorityCalls, 3);
          assert.equal(finalizations, 2);
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await inventoryState(), inventoryBefore);
          assert.deepEqual(await diningState(), diningBefore);
          assert.equal(
            (await client.query("SELECT aggregate_version FROM rms_ordering.cart")).rows[0]
              .aggregate_version,
            f.cart.aggregateVersion,
          );
          revokeAfterWrite = false;
          await assert.rejects(submit(guest.wrongCsrf));
          assert.deepEqual(await counts(), before);
          assert.deepEqual(await inventoryState(), inventoryBefore);
          assert.deepEqual(await diningState(), diningBefore);
          assert.equal((await submit()).status, "Created");
          const committed = await counts();
          const inventoryCommitted = await inventoryState();
          const diningCommitted = await diningState();
          assert.deepEqual(
            diningCommitted.map((row) => row.state),
            ["Prepared", "PaymentPending"],
          );
          assert.equal(inventoryCommitted.sets, 1);
          assert.equal(inventoryCommitted.finals, 1);
          assert(BigInt(inventoryCommitted.reserved) > 0n);
          assert.deepEqual(committed, {
            submissions: 2,
            batches: 2,
            revisions: 2,
            additional: 1,
            audits: 1,
            events: 1,
            lines: 0,
          });
          assert.equal(
            (await client.query("SELECT aggregate_version FROM rms_ordering.cart")).rows[0]
              .aggregate_version,
            f.cart.aggregateVersion + 1,
          );
          assert.equal((await submit()).status, "Existing");
          assert.equal(finalizations, 3);
          assert.deepEqual(await counts(), committed);
          assert.deepEqual(await inventoryState(), inventoryCommitted);
          assert.deepEqual(await diningState(), diningCommitted);
          await exerciseAdditionalDiningPayment({
            refundObservationFault,
            client,
            runner,
            scope: ownerScope,
            stock,
            initial: prior,
            snapshot,
            guest,
            workflow,
          });
        } finally {
          await client.end();
        }
      },
    );
  },
);
