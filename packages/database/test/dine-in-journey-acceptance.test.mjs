import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createDiningTable,
  parseDiningSession,
  createDiningCartParticipationQuery,
  createDiningGuestBindingQuery,
  createPostgresDiningCheckoutCommitmentStore,
  createPostgresDiningCheckoutHoldSource,
  createPostgresDiningPublicTableReader,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  acquireOrderDispositionFence,
  CartError,
  createDiningCartSelectionService,
  createPostgresDiningOrderPreparationSource,
  createOrderNumberAllocation,
  createPostgresAdditionalDiningExecutionReader,
  createPostgresDiningCartReplacementStore,
  createPostgresDiningCartSelectionStore,
  createPostgresDiningCartSuccessionSource,
  createPostgresOrderStatusProjectionStore,
  createPostgresOrderBatchIdentitySource,
  createPostgresOrderSubmittedConsumer,
  parseAdditionalDiningBatchSnapshot,
  orderCancelledEventMatchesRecord,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../../apps/api/src/customer-additional-dining-history-authorization.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createDiningCheckoutExpiryDispatcher } from "../../../apps/api/src/dining-checkout-expiry-dispatcher.ts";
import { createCustomerOrderStatusRead } from "../../../apps/api/src/customer-order-status-read.ts";
import { createCustomerDiningSessionRead } from "../../../apps/api/src/customer-dining-session-read.ts";
import { CustomerDiningSessionHandler } from "../../../apps/api/src/customer-dining-session.ts";
import { parseDiningSessionView } from "../../../apps/customer-pwa/src/dining/dining-session-client.ts";
import { createPostgresKitchenReworkStore } from "../../rms/kitchen/src/index.ts";
import { createPaymentProviderSnapshot } from "../../rms/payment/src/index.ts";
import { createInternalBatchCancellationDispatcher } from "../../../tooling/environment/pilot-batch-cancellation-dispatcher.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { createMerchantDiningTables } from "../../../apps/api/src/merchant-dining-tables.ts";
import { createMerchantDiningOrderProgress } from "../../../apps/api/src/merchant-dining-order-progress.ts";
import { createMerchantKitchenQuery } from "../../../apps/api/src/merchant-kitchen-query.ts";
import { createMerchantPickupQuery } from "../../../apps/api/src/merchant-pickup-query.ts";
import { createPersistentMerchantTaskInbox } from "../../../apps/api/src/persistent-merchant-task-inbox.ts";
import { createMerchantDiningTaskSource } from "../../../apps/api/src/merchant-dining-task-source.ts";
import { createTaskRecord } from "../../bop/task/src/index.ts";
import { parseOrderStatusView } from "../../../apps/customer-pwa/src/order-status/order-status-controller.ts";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { createGuestSession } from "../../bop/identity/src/index.ts";
import {
  EARLIER_CART_ITEMS_CLEARED,
  createCustomerDiningCartPort,
} from "../../../apps/api/src/customer-dining-cart-composition.ts";
import { fenceDiningCartReplacement } from "../../../apps/api/src/dining-cart-replacement-authorization.ts";
import { createDiningCartReplacementSettlement } from "../../../apps/api/src/dining-cart-replacement-settlement.ts";
import {
  unpaidCancelledBatches,
  unpaidCancelledTotal,
} from "../../../apps/merchant-web/src/CurrentOrderQueuePage.tsx";
import { createInternalCartExpiryPorts } from "../../../tooling/environment/pilot-cart-expiry.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  createIdentityActor,
  generateHotp,
  totpTimeStep,
  verifyTotp,
} from "../../bop/identity/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-reconciliation-runtime.ts";
import { createPostgresOrdinaryRefundPositionSource } from "../../rms/payment/src/infrastructure/ordinary-refund-position-source.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import { createMerchantMfaStepUp } from "../../../apps/api/src/merchant-mfa-step-up.ts";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import { createMerchantOrdinaryRefundApproval } from "../../../apps/api/src/merchant-ordinary-refund-approval.ts";
import { createMerchantOrdinaryRefundItems } from "../../../apps/api/src/merchant-ordinary-refund-items.ts";
import { createMerchantOrdinaryRefundCommand } from "../../../apps/api/src/merchant-ordinary-refund-command.ts";
import { createMerchantOrdinaryRefundSendCommand } from "../../../apps/api/src/merchant-ordinary-refund-send-command.ts";
import { createOriginalReceiptIssuance } from "../../../apps/api/src/original-receipt-issuance.ts";
import { createRefundReceiptIssuance } from "../../../apps/api/src/refund-receipt-issuance.ts";
import { createPostgresReceiptOrderSource } from "../../rms/ordering/src/index.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { standardRefundRoleMapping } from "../../../tooling/environment/pilot-refund-role-mapping.mjs";
import { exerciseReceiptTemplate } from "../test-support/receipt-template.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import {
  journeyRound,
  seedJourneyAcceptance,
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
  seedJourneyStorePublication,
} from "../test-support/dine-in-journey-seed.mjs";

// Only the merchant session lookup for the refund staff is a test double: the cookie names which
// synthetic staff member is signed in at the selected Store. Any other cookie (the order queue's
// real encrypted session) goes to the real scope resolution.
const signedIn = vi.hoisted(() => ({ cookies: new Set(), scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createMerchantStoreScope: (source) => {
      let real = null;
      return async (tx, cookie, action, ...rest) => {
        if (signedIn.cookies.has(cookie)) return signedIn.scopeFor(tx, cookie, action);
        real ??= actual.createMerchantStoreScope(source);
        return real(tx, cookie, action, ...rest);
      };
    },
  };
});

const { Client } = pg;
const id = (n) => "01a0ff00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const minutes = (n) => n * 60_000;
let references = 0x9000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");
const [provider, systemActor, staff, workflowOperator, workflowApprover, approvalEvidence] = [
  1, 2, 3, 4, 5, 6,
].map(id);
const now = () => new Date().toISOString();
/** A clock running at real speed from `start` (the journey's injectable clock). */
const clockFrom = (start) => {
  const origin = Date.now(),
    base = Date.parse(start);
  return () => new Date(base + (Date.now() - origin)).toISOString();
};

/**
 * WP-2423 cross-feature dine-in journey (live pilot defects appeared only in combinations). One
 * table Order runs through: a paid and accepted first round; a second round whose payment fails and
 * which the System cancels after its payment window (stock returned); the customer status and the
 * merchant queue after that; the order-status projection consumer over every round; the table Cart
 * timing out and a non-Host participant continuing the table on a new Cart; a third round after the
 * cancellation; an escalated refund of the first round from an earlier business day; receipts.
 *
 * Code under test runs as a restricted NOBYPASSRLS role holding exactly the rendered pilot API
 * grants (matrix plus approved additions). Test-only stand-ins and owner-seeded facts are named
 * where they occur.
 */
it("runs a multi-round dine-in table through unpaid-round cancellation, cart timeout, a later round, refund and receipts", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_dine_journey" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_dj_" + context.runId,
      worker = "wp2423_dj_w_" + context.runId;
    assert.match(api, /^wp2423_dj_[a-f0-9]+$/u);
    const setupRoles = [];
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BOP_PILOT_ENVIRONMENT", undefined);
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      // ── Shared identities: the ordering write fixture's dine-in Order, Store and table guest.
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const R1 = journeyRound({ at: time(-minutes(130)), prefix: "01a00001" });
      const R2 = journeyRound({ at: time(-minutes(80)), prefix: "01a00002" });
      const scope = R1.f.scope;
      const tenant = scope.brandReference.slice(0, 24) + "000000000900";
      const ownerScope = { tenantReference: tenant, ...scope };
      const orderReference = R1.f.request.record.order.orderReference;
      const guestSession = R1.f.request.record.guestSessionReference;
      const paymentScope = { ...scope, providerAccountReference: provider, environment: "Test" };

      /** Statements the restricted role ran (the merchant reads' query budgets below). */
      const queryCount = { value: 0 };
      /**
       * One restricted-role transaction on its own connection. The pilot runs the API and the
       * business worker under the rendered `api` grants (the `worker` principal holds a handful of
       * Ordering grants only), so every composition here uses that role.
       */
      function transactions(role = api, { guc = false, before = null, rollback = false } = {}) {
        return {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN");
              // Test-only: owner-side facts changed inside this transaction only (rolled back).
              if (before !== null) await before(client);
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='10s'");
              await client.query("SET LOCAL statement_timeout='20s'");
              if (guc)
                await client.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, scope.brandReference, scope.storeReference],
                );
              // Same rule as the application runner: one query at a time per transaction.
              let inFlight = 0;
              const result = await work({
                query: async (sql, values) => {
                  if (inFlight > 0)
                    throw Object.assign(new Error("concurrent query"), {
                      code: "TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY",
                    });
                  inFlight += 1;
                  queryCount.value += 1;
                  try {
                    return await client.query(sql, values === undefined ? [] : [...values]);
                  } finally {
                    inFlight -= 1;
                  }
                },
              });
              await client.query(rollback ? "ROLLBACK" : "COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK").catch(() => undefined);
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }
      /** Owner client transactions for test-only setup through real owner stores. */
      const ownerRunner = () => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            const result = await work({ query: (sql, values) => client.query(sql, values) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      });
      const one = async (sql, values = []) => (await admin.query(sql, values)).rows;
      const stockReserved = async (account) =>
        (
          await one(
            "SELECT reserved::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
            [account],
          )
        )[0].reserved;

      // ── Platform Workflow release for the unpaid-round cancellation, installed by the operator
      // tool's own apply step (WP-2423 Q6), as on the pilot.
      // Installed before service started (the System acts on it from then on).
      const releaseAt = base - minutes(200);
      const operation = (() => {
        const hex = releaseAt.toString(16).padStart(12, "0");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`;
      })();
      await admin.query("BEGIN");
      const release = await applyWorkflowRelease(
        admin,
        {
          purposeCode: "UnpaidDineInBatchCancellation",
          tenantReference: tenant,
          brandReference: scope.brandReference,
          operatorReference: workflowOperator,
          approvedByReference: workflowApprover,
          approvalEvidenceReference: approvalEvidence,
          operationReference: operation,
        },
        () => releaseAt + 1000,
      );
      await admin.query("COMMIT");
      assert.equal(release.status, "Applied");

      // ── Table: Active Session, Host H (the fixture guest) and a second participant P.
      const participantP = id(0x601);
      const dining = await seedJourneyDining({
        client: admin,
        scope: ownerScope,
        round: R1,
        startedAt: time(-minutes(150)),
        guestParticipant: participantP,
      });
      // The Host's Guest session bound to the table (actual Identity/Dining owners).
      const guest = await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: {
          ...dining,
          participant: dining.host,
          link: { paymentOperationReference: id(0x100) },
        },
        at: time(-minutes(140)),
      });
      // WP-2423 Q8: participant P's own Guest session at the same table (actual owners). P reads
      // the Host's rounds as "another guest"'s and (DEC-DINING-ANY-PARTICIPANT-SUBMIT) submits and
      // pays round 3 without being the Host.
      const guestSessionP = id(0x602);
      const tableGuestP = await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: { ...dining, participant: dining.guest },
        at: time(-minutes(139)),
        second: { idPrefix: "01909993-0000-7000-8000-", sessionReference: guestSessionP },
      });

      // Inventory: one tracked item, 100 KG received; recipe for the menu item; Workflow.
      const stock = await seedSubmissionInventoryStock({
        admin,
        runner: ownerRunner,
        ownerScope,
        actorReference: guestSession,
        at: time(-minutes(145)),
      });
      await seedSubmissionInventoryRecipe({
        admin,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(145)),
        cart: R2.f.cart,
        stock,
      });
      const inventoryWorkflow = await seedSubmissionInventoryWorkflow({
        runner: ownerRunner,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(145)),
        orderType: "DineIn",
      });

      // ── 1. Round 1: ordered, paid, accepted (owner-seeded history, as the owners record it).
      const r1 = R1.f.request.record,
        items1 = R1.items();
      await seedAcceptanceOrderHistory(admin, {
        ...r1,
        items: items1,
        orderNumberAllocation: createOrderNumberAllocation({
          orderReference,
          allocatedAt: r1.createdAt,
          sequence: 1n,
          businessDateResolution: R1.f.request.businessDateResolution,
        }),
      });
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: { items: items1, batch: R1.batch },
        prefix: "01a10001",
      });
      const roundTotal = items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
      const paymentRefs = (n, op) => ({
        paymentIntent: id(n + 1),
        attempt: id(n + 2),
        observation: id(n + 3),
        webhook: id(n + 4),
        transaction: id(n + 5),
        paymentEvent: id(n + 6),
        projection: id(n + 7),
        preparation: id(n + 8),
        commitment: id(n + 9),
        paymentOperation: op ?? id(n + 10),
        providerIntent: "pi_SYNTHETICJOURNEY" + n.toString(16),
        providerEvent: "evt_SYNTHETICJOURNEY" + n.toString(16),
        acceptance: id(n + 11),
        acceptanceOperation: id(n + 12),
        acceptanceWorkflow: id(n + 13),
        acceptanceTransition: id(n + 14),
        disposition: id(n + 15),
        correlation: id(n + 16),
        confirmation: id(n + 17),
        confirmedEvent: id(n + 18),
        ticket: id(n + 19),
        sourceEvidence: id(n + 20),
        workPlan: id(n + 21),
        station: id(n + 22),
        routing: id(n + 23),
        preparationStep: id(n + 24),
        workItems: [id(n + 30), id(n + 31)],
      });
      const pay1 = paymentRefs(0x1000);
      const paid1At = time(-minutes(128));
      await seedJourneyPayment(admin, {
        scope,
        providerAccountReference: provider,
        round: R1,
        refs: pay1,
        outcome: "Succeeded",
        requestedAt: time(-minutes(129)),
        occurredAt: paid1At,
        totalMinor: roundTotal,
      });
      await seedJourneyAcceptance(admin, {
        scope,
        round: R1,
        items: items1,
        refs: pay1,
        staff,
        version: 1,
        previousRevision: r1.submissionReference,
        acceptedAt: time(-minutes(127)),
        kitchenAt: time(-minutes(126)),
      });

      // ── 2. Round 2: ordered by the Host through the actual Ordering writer (Dining commitment
      // seal and Inventory reservation in the same transaction). The transaction clock is set to
      // the round's own instant (test-only clock injection at the transaction boundary).
      await seedSubmissionCart(admin, R2.f);
      const pay2 = paymentRefs(0x2000);
      const link2 = await dining.prepare(R2, { paymentOperationReference: pay2.paymentOperation });
      const evidence2 = R2.evidence(link2),
        items2 = R2.items(evidence2);
      await seedJourneyCheckout(admin, {
        round: R2,
        evidence: evidence2,
        link: link2,
        references: {
          createOperation: id(0x2101),
          checkoutSession: id(0x2102),
          details: id(0x2103),
          detailsOperation: id(0x2104),
        },
      });
      const additional = (round, items, expectedOrderVersion, batchSequence) =>
        parseAdditionalDiningBatchSnapshot({
          orderReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          diningSessionReference: dining.session.diningSessionReference,
          guestSessionReference: round.f.request.record.guestSessionReference,
          originalOrderCreatedAt: r1.createdAt,
          expectedOrderVersion,
          batchSequence,
          snapshotVersion: 1,
          batch: round.batch,
          items,
        });
      const snapshot2 = additional(R2, items2, 2, 2);
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: snapshot2,
        prefix: "01a10002",
      });
      const submittedEvents = new Map();
      const submissionStore = createCustomerAdditionalDiningSubmissionStore({
        ...scope,
        // Test-only Identity stand-in: the two seated guests' Guest sessions.
        authorize: async (_tx, candidate) =>
          [guestSession, guestSessionP].includes(candidate.guestSessionReference),
        audit: async (candidate) => ({
          auditId: fresh(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "ORDERING_ADDITIONAL_BATCH_SUBMIT",
          targetType: "OrderingOrderBatch",
          targetId: candidate.batch.orderBatchReference,
          reasonCode: "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
          correlationId: fresh(),
          occurredAt: candidate.batch.submittedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
        eventReference: (candidate) => {
          const reference = fresh();
          submittedEvents.set(candidate.batch.orderBatchReference, reference);
          return reference;
        },
        // Test-only stand-ins, as in the existing writer acceptance: the current checkout-policy
        // source requires no policies and the Identity/CSRF/Checkout recheck (`validateCurrent`) is
        // not composed. The Dining current gate, Inventory finalization and Dining seal are real.
        currentPolicies: async (_tx, request) => ({
          ...scope,
          orderType: "DineIn",
          checkedAt: request.observedAt,
          validUntil: new Date(Date.parse(request.observedAt) + minutes(5)).toISOString(),
          required: [],
        }),
        validateCurrent: async () => undefined,
        inventory: {
          scope: ownerScope,
          stockSiteReference: stock.stockSiteReference,
          // Test-only Workflow resource gate: either seated guest may submit the table's Cart.
          workflow: {
            ...inventoryWorkflow,
            gates: {
              ...inventoryWorkflow.gates,
              authorizeResource: async (tx, request) =>
                inventoryWorkflow.gates.authorizeResource(tx, {
                  ...request,
                  actorReference:
                    request.actorReference === guestSessionP
                      ? guestSession
                      : request.actorReference,
                }),
            },
          },
          authorize: async (_tx, input) =>
            [guestSession, guestSessionP].includes(input.actorReference),
          resolveExpiryCutoff: stock.resolveExpiryCutoff,
          generateReference: fresh,
          audit: {
            reasonCode: "SYNTHETIC_SUBMISSION",
            sourceChannel: "CUSTOMER_PWA",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        },
        diningSealAudit: async (record) => dining.audit(record),
      });
      /** Append one round; `clockAt` answers the writer's transaction clock (test-only).
       * `options` may change owner facts first and roll the whole attempt back (test-only). */
      const submit = (snapshot, link, evidence, clockAt = null, options = {}) =>
        transactions(api, options).run(async (tx) => {
          let tick = 0;
          const clocked = {
            query: (sql, values) =>
              clockAt !== null && sql === "SELECT clock_timestamp() AS observed_at"
                ? Promise.resolve({
                    rows: [{ observed_at: new Date(Date.parse(clockAt) + 50 * tick++) }],
                    rowCount: 1,
                  })
                : tx.query(sql, values),
          };
          return submissionStore.append({
            transaction: clocked,
            snapshot,
            capacityLink: link,
            checkoutValidationEvidence: evidence,
          });
        });
      const reservedBefore = await stockReserved(stock.accountReference);
      const submitted2 = await submit(
        snapshot2,
        link2,
        evidence2,
        new Date(Date.parse(R2.batch.submittedAt) + 1000).toISOString(),
      );
      assert.equal(submitted2.status, "Created");
      const reservedRound2 = await stockReserved(stock.accountReference);
      assert.ok(Number(reservedRound2) > Number(reservedBefore), reservedRound2);
      const commitment = async (submission) =>
        createPostgresDiningCheckoutCommitmentStore(ownerRunner(), ownerScope, {
          now,
        }).loadSubmission(submission);
      const sealed2 = await commitment(R2.batch.submissionReference);
      assert.equal(sealed2.state, "PaymentPending");
      // WP-2423 abandoned payment (v15 DEMO-02 round 1): payment requested at the seal; the guest
      // opened the card payment (the Provider intent exists) and left without confirming it.
      await seedJourneyPayment(admin, {
        scope,
        providerAccountReference: provider,
        round: R2,
        refs: { ...pay2, commitment: sealed2.commitmentReference },
        outcome: "Open",
        requestedAt: sealed2.paymentRequestedAt,
        occurredAt: sealed2.paymentRequestedAt,
        totalMinor: roundTotal,
      });

      // ── 4a. The order-status projection consumer takes round 2: the pilot worker's consumer
      // (tooling/environment/pilot-order-submitted.mjs) with the same ports, except the history
      // quote version follows this fixture (v1 snapshots; the pilot writes configured v2 ones).
      const same = (q) =>
        q.brandReference === scope.brandReference && q.storeReference === scope.storeReference;
      const orderStatusConsumer = createPostgresOrderSubmittedConsumer({
        projection: {
          ...scope,
          authorize: async (_tx, q) => same(q),
          validateCurrentSource: async (_tx, p) => same(p.snapshot),
        },
        authorization: {
          authorize: async (_tx, event) =>
            event.tenantId === scope.brandReference && event.storeId === scope.storeReference,
        },
        history: { quoteVersion: 1, locale: "en-CA" },
        references: { generateGeneration: fresh, now },
        freshness: async (tx, snapshot) => {
          const batch = snapshot.batches.at(-1);
          const identity = await createPostgresOrderBatchIdentitySource({
            ...scope,
            authorize: async () => true,
          }).load(tx, {
            orderReference: snapshot.orderReference,
            orderBatchReference: batch.orderBatchReference,
            observedAt: now(),
          });
          if (!identity || identity.kind !== "Additional")
            throw new Error("ORDER_SUBMITTED_IDENTITY_UNAVAILABLE");
          const execution = await createPostgresAdditionalDiningExecutionReader({
            ...scope,
            authorize: async (_tx, q) =>
              same(q) && q.submissionReference === identity.submissionReference,
          }).loadBySubmission({
            transaction: tx,
            submissionReference: identity.submissionReference,
            observedAt: now(),
          });
          if (!execution) throw new Error("ORDER_SUBMITTED_EXECUTION_UNAVAILABLE");
          return execution.orderVersion === snapshot.sourceVersion ? "Fresh" : "Stale";
        },
      });
      const consume = (eventReference) =>
        transactions(api, { guc: true }).run(async (tx) => {
          const envelope = await loadOutboxEnvelope(tx, eventReference);
          assert.ok(envelope, "OrderSubmitted event " + eventReference);
          return orderStatusConsumer.consume(tx, envelope);
        });
      const event2 = submittedEvents.get(R2.batch.orderBatchReference);
      assert.deepEqual(await consume(event2), { status: "processed" });

      // ── 2b. After the payment window the System asks the Provider about the open payment, cancels
      // the attempt the guest never confirmed, records it as not completed and cancels round 2
      // (pilot worker compositions), returning its stock in the same transaction.
      // The worker runs one minute after the window ends (journey clock: round 2 was ordered 80
      // minutes ago).
      const windowClock = clockFrom(
        new Date(Date.parse(sealed2.capacityExpiresAt) + minutes(1)).toISOString(),
      );
      const expiry = createDiningCheckoutExpiryDispatcher({
        scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
        transactions: transactions(api),
        authorize: async () => true,
        authorizeDiscovery: async (_tx, at) => at <= windowClock(),
        now: windowClock,
        newReference: fresh,
        pageSize: 10,
      });
      assert.equal(await expiry.runOnce(), 1);
      const expiries = () =>
        one(
          "SELECT order_batch_id::text AS batch,status FROM rms_ordering.order_batch_checkout_expiry WHERE order_id=$1 ORDER BY evidence_version",
          [orderReference],
        );
      assert.deepEqual(await expiries(), [
        { batch: R2.batch.orderBatchReference, status: "AwaitingPaymentResolution" },
      ]);
      // Test-only Provider stand-in with the simulator's semantics: the intent the guest never
      // confirmed answers RequiresCustomerAction until it is cancelled (idempotently).
      const providerCalls = [];
      let providerCancelledAt = null;
      const providerSnapshot = (request) =>
        createPaymentProviderSnapshot({
          kind: "Snapshot",
          context: request.context,
          providerIntentReference: pay2.providerIntent,
          providerTransactionReference: null,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          status: providerCancelledAt === null ? "RequiresCustomerAction" : "Cancelled",
          requestedAmount: { amountMinor: roundTotal, currencyCode: "CAD" },
          authorizedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          capturedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          refundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
          observedAt: providerCancelledAt ?? windowClock(),
          evidenceDigest:
            "sha256:" +
            createHash("sha256")
              .update(pay2.providerIntent + ":" + String(providerCancelledAt))
              .digest("hex"),
        });
      const simulatedProvider = async () => ({
        adapter: {
          retrieveIntent: async (request) => {
            providerCalls.push(["retrieve", request.providerIntentReference]);
            return providerSnapshot(request);
          },
          cancelIntent: async (request) => {
            providerCalls.push(["cancel", request.idempotencyKey]);
            providerCancelledAt ??= windowClock();
            return providerSnapshot(request);
          },
        },
        readTerminalOccurrence: async () => ({
          status: "Cancelled",
          occurredAt: providerCancelledAt,
        }),
        close: () => undefined,
      });
      const cancellation = await createInternalBatchCancellationDispatcher(
        {
          scope,
          now: windowClock,
          transactions: transactions(api),
          publicProfile: { binding: { tenantReference: tenant, validUntil: time(minutes(600)) } },
          credentials: { reference: fresh },
        },
        {
          loadWorkflow: async () => ({
            environment: "InternalTest",
            database: context.clientConfig.database,
            scope: ownerScope,
            definition: release.plan.published,
          }),
          expectedDatabaseName: context.clientConfig.database,
          systemActorReference: systemActor,
          providerAccountReference: provider,
          createSimulatedProvider: simulatedProvider,
        },
      );
      // At the deadline the round has a started payment and no outcome: nothing is cancelled yet;
      // Payment cancels the never-confirmed attempt with the Provider and records it as failed.
      assert.equal(await cancellation.runOnce(), 0);
      assert.deepEqual(providerCalls, [
        ["retrieve", pay2.providerIntent],
        ["cancel", "cancel-abandoned:" + pay2.attempt],
      ]);
      assert.deepEqual(
        await one(
          "SELECT terminal_outcome AS outcome,failure_reason AS reason,authoritative_source AS source FROM rms_payment.payment_terminal_fact WHERE payment_intent_id=$1",
          [pay2.paymentIntent],
        ),
        [{ outcome: "Failed", reason: "Cancelled", source: "ProviderRetrieval" }],
      );
      // The next sweep records the failed payment as the round's latest expiry evidence; then the
      // round is cancelled as "payment not completed".
      assert.equal(await expiry.runOnce(), 1);
      assert.deepEqual(await expiries(), [
        { batch: R2.batch.orderBatchReference, status: "AwaitingPaymentResolution" },
        { batch: R2.batch.orderBatchReference, status: "PaymentFailed" },
      ]);
      assert.equal(await cancellation.runOnce(), 1);
      const cancelled = await one(
        "SELECT order_batch_id::text AS batch,cancelled_order_version AS version FROM rms_ordering.order_batch_checkout_cancellation WHERE order_id=$1",
        [orderReference],
      );
      assert.deepEqual(cancelled, [{ batch: R2.batch.orderBatchReference, version: 4 }]);
      assert.equal(await stockReserved(stock.accountReference), reservedBefore);
      // Another scan finds nothing more to cancel.
      assert.equal(await cancellation.runOnce(), 0);
      // WP-2423 item 5: the cancellation published the Order's OrderCancelled event in the same
      // transaction, at the cancelled Order version, stating exactly the stored cancellation.
      const cancelledEvents = await one(
        "SELECT event_id::text AS id,aggregate_version::int AS version,actor_type,payload_json AS payload,aggregate_id::text AS aggregate FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled' AND aggregate_id=$1",
        [orderReference],
      );
      assert.equal(cancelledEvents.length, 1);
      assert.equal(cancelledEvents[0].version, 4);
      assert.equal(cancelledEvents[0].actor_type, "System");
      assert.equal(cancelledEvents[0].payload.orderBatchReference, R2.batch.orderBatchReference);
      assert.equal(cancelledEvents[0].payload.reasonCode, "PAYMENT_NOT_COMPLETED");
      assert.equal(
        await transactions(api).run((tx) =>
          orderCancelledEventMatchesRecord(tx, ownerScope, {
            aggregateId: orderReference,
            aggregateVersion: 4n,
            payload: cancelledEvents[0].payload,
          }),
        ),
        true,
      );

      // ── 3. The customer's order status: round 2 shown as cancelled because unpaid.
      const guestBinding = (transaction) => ({
        validate: async (session, observedAt) => {
          const evidence = await createDiningGuestBindingQuery({
            scope,
            now: () => observedAt,
            repository: createPostgresDiningGuestBindingStore(
              { run: (work) => work(transaction) },
              ownerScope,
            ),
          }).resolve({
            purpose: "GuestSessionBinding",
            diningSessionReference: session.diningSessionReference,
            participantReference: session.diningParticipantReference,
            tableReference: dining.table.tableReference,
          });
          return evidence ? "Current" : "Unavailable";
        },
      });
      // WP-2423 Q8: the table view (CUST-DINE-IN-SESSION) as the pilot composes it from the same
      // order-status configuration, under the restricted API role.
      const tableRead = createCustomerDiningSessionRead({
        scope,
        transactions: transactions(api),
        credentials: guest.identity.session.credentials,
        diningScope: ownerScope,
        paymentScope,
        itemRefundScope: {
          tenantReference: tenant,
          providerAccountReference: provider,
          environment: "Test",
        },
        now,
        binding: guestBinding,
      });
      const tableOf = (who) =>
        tableRead.read({
          sessionCredential: who.sessionCredential,
          csrfCredential: who.csrfCredential,
        });
      const roundsOf = (view) =>
        view.rounds.map((round) => [
          round.roundNumber,
          round.orderedBy,
          round.status,
          round.payment,
        ]);
      const statusRead = createCustomerOrderStatusRead({
        scope,
        transactions: transactions(api),
        credentials: guest.identity.session.credentials,
        diningScope: ownerScope,
        paymentScope,
        now,
        binding: (transaction) => ({
          validate: async (session, observedAt) => {
            const evidence = await createDiningGuestBindingQuery({
              scope,
              now: () => observedAt,
              repository: createPostgresDiningGuestBindingStore(
                { run: (work) => work(transaction) },
                ownerScope,
              ),
            }).resolve({
              purpose: "GuestSessionBinding",
              diningSessionReference: session.diningSessionReference,
              participantReference: session.diningParticipantReference,
              tableReference: dining.table.tableReference,
            });
            return evidence ? "Current" : "Unavailable";
          },
        }),
      });
      const status = await statusRead.read({
        sessionCredential: guest.sessionCredential,
        csrfCredential: guest.csrfCredential,
        orderReference,
      });
      // v15 2026-10-16 regression: a payment outcome (or acceptance) takes the Order's disposition
      // fence, then locks the Dining table row FOR UPDATE. The guest's status read on reopening
      // the payment result used to read that row FOR SHARE first and then wait for the fence, and
      // one of the two died in a deadlock (40P01, the 503s). The read now queues on the fence
      // before touching the row, so both finish.
      {
        // As the pilot composes it: the guest's binding check reads the Dining table row through
        // Dining's public table reader (FOR SHARE) inside the read's transaction.
        const pilotStatusRead = createCustomerOrderStatusRead({
          scope,
          transactions: transactions(api),
          credentials: guest.identity.session.credentials,
          diningScope: ownerScope,
          paymentScope,
          now,
          binding: (transaction) => ({
            validate: async (session, observedAt) => {
              const table = await createPostgresDiningPublicTableReader({
                transaction,
                scope: ownerScope,
                authorize: async () => true,
              }).read({
                tableReference: dining.table.tableReference,
                purpose: "GuestSessionBinding",
                observedAt,
              });
              if (table === null) return "Unavailable";
              const evidence = await createDiningGuestBindingQuery({
                scope,
                now: () => observedAt,
                repository: createPostgresDiningGuestBindingStore(
                  { run: (work) => work(transaction) },
                  ownerScope,
                ),
              }).resolve({
                purpose: "GuestSessionBinding",
                diningSessionReference: session.diningSessionReference,
                participantReference: session.diningParticipantReference,
                tableReference: dining.table.tableReference,
              });
              return evidence ? "Current" : "Unavailable";
            },
          }),
        });
        assert.equal(
          (
            await pilotStatusRead.read({
              sessionCredential: guest.sessionCredential,
              csrfCredential: guest.csrfCredential,
              orderReference,
            })
          ).order.orderReference,
          orderReference,
        );
        const holder = new Client(context.clientConfig);
        await holder.connect();
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "OrderingOrderDisposition:" +
              scope.brandReference +
              ":" +
              scope.storeReference +
              ":" +
              orderReference,
          ]);
          const reading = pilotStatusRead
            .read({
              sessionCredential: guest.sessionCredential,
              csrfCredential: guest.csrfCredential,
              orderReference,
            })
            .then(
              (view) => ({ view }),
              (error) => ({ error }),
            );
          // The read is waiting for a lock the holder has.
          for (let tries = 0; ; tries++) {
            const [{ waiting }] = await one(
              "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND pid<>$1",
              [holder.processID],
            );
            if (waiting > 0) break;
            assert.ok(tries < 200, "the status read never waited for the Order fence");
            await delay(25);
          }
          await holder.query(
            "SELECT table_id FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
            [tenant, scope.brandReference, scope.storeReference, dining.table.tableReference],
          );
          await holder.query("COMMIT");
          const outcome = await reading;
          assert.equal(outcome.error, undefined, String(outcome.error?.code ?? outcome.error));
          assert.equal(outcome.view.order.orderReference, orderReference);
        } finally {
          await holder.query("ROLLBACK").catch(() => undefined);
          await holder.end();
        }
      }
      assert.deepEqual(
        status.sources.unpaidCancellations?.map((e) => e.orderBatchReference),
        [R2.batch.orderBatchReference],
      );
      // Round 2 is not charged and never reaches the kitchen; the customer screen's total (the PWA
      // parser and its unpaid-round rule) counts round 1 only.
      // WP-2423 abandoned payment: the not-completed attempt's PaymentFailed event reaches the
      // payment status projection through the worker's consumer (not run here); the round already
      // reads as cancelled and has no cancellation time left.
      assert.deepEqual(status.sources.batchPayments, [
        { orderBatchReference: R2.batch.orderBatchReference, status: "Awaiting", cancelsAt: null },
      ]);
      assert.deepEqual(
        status.sources.kitchen.batches.map((b) => b.orderBatchReference),
        [R1.batch.orderBatchReference],
      );
      const view = parseOrderStatusView(status, orderReference);
      const unpaid = new Set([
        ...(view.sources?.unpaidCancellations?.map((e) => e.orderBatchReference) ?? []),
        ...(view.sources?.batchPayments
          ?.filter((e) => e.cancelsAt !== null)
          .map((e) => e.orderBatchReference) ?? []),
      ]);
      const customerTotal = view.order.batches
        .filter((batch) => !unpaid.has(batch.orderBatchReference))
        .flatMap((batch) => batch.items)
        .reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n);
      assert.equal(customerTotal, roundTotal);
      // WP-2423 D5: under the restricted API role the read carries every shown item's frozen
      // price before tax and its tax; items (pre-tax) + tax reconcile to the same total.
      const prices = new Map(view.sources?.itemPrices?.map((e) => [e.orderItemReference, e]));
      const shownItems = view.order.batches.flatMap((batch) => batch.items);
      assert.equal(prices.size, shownItems.length);
      const charged = view.order.batches
        .filter((batch) => !unpaid.has(batch.orderBatchReference))
        .flatMap((batch) => batch.items);
      const pricedSubtotal = charged.reduce(
        (sum, item) => sum + prices.get(item.orderItemReference).subtotal.amountMinor,
        0n,
      );
      const pricedTax = charged.reduce(
        (sum, item) => sum + prices.get(item.orderItemReference).tax.amountMinor,
        0n,
      );
      assert.ok(pricedTax > 0n);
      assert.ok(pricedSubtotal < customerTotal);
      assert.equal(pricedSubtotal + pricedTax, customerTotal);

      // ── 3a. WP-2423 Q8: the table view after round 2's automatic cancellation. The Host sees both
      // rounds as theirs; participant P sees the same rounds as another guest's. Nothing is due.
      const hostTable = await tableOf(guest);
      assert.equal(hostTable.tableLabel, "SYNTHETIC-JOURNEY");
      assert.equal(hostTable.orderNumber, status.order.orderNumber);
      assert.deepEqual(roundsOf(hostTable), [
        [1, "You", "Queued", "Paid"],
        [2, "You", "NotPaidCancelled", "NotCharged"],
      ]);
      assert.ok(hostTable.rounds[1].items.every((item) => item.cancelled));
      assert.deepEqual(hostTable.summary, {
        paid: { amountMinor: roundTotal, currencyCode: "CAD" },
        refunded: { amountMinor: 0n, currencyCode: "CAD" },
        refundPending: { amountMinor: 0n, currencyCode: "CAD" },
        due: { amountMinor: 0n, currencyCode: "CAD" },
        // WP-2423 D5: what the table ordered, before tax and with tax, as the receipt prints it;
        // the never-paid round 2 is not included and the total is the amount paid.
        ordered: {
          subtotal: { amountMinor: pricedSubtotal, currencyCode: "CAD" },
          tax: { amountMinor: pricedTax, currencyCode: "CAD" },
          total: { amountMinor: roundTotal, currencyCode: "CAD" },
        },
      });
      // Round 1's items print before tax; its subtotal + tax is the unchanged round total.
      assert.equal(hostTable.rounds[0].subtotal.amountMinor, pricedSubtotal);
      assert.equal(hostTable.rounds[0].tax.amountMinor, pricedTax);
      assert.equal(hostTable.rounds[0].itemsTotal.amountMinor, roundTotal);
      assert.equal(
        hostTable.rounds[0].items.reduce((sum, item) => sum + item.priceBeforeTax.amountMinor, 0n),
        pricedSubtotal,
      );
      assert.equal(
        hostTable.rounds[0].items.reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n),
        roundTotal,
      );
      const otherTable = await tableOf(tableGuestP);
      assert.deepEqual(
        roundsOf(otherTable),
        roundsOf(hostTable).map(([n, , st, pay]) => [n, "AnotherGuest", st, pay]),
      );
      assert.deepEqual(otherTable.summary, hostTable.summary);
      // No guest, participant or session reference leaves the composition.
      const tableJson = JSON.stringify(otherTable, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      for (const reference of [
        guestSession,
        id(0x602),
        participantP,
        dining.session.diningSessionReference,
        orderReference,
      ])
        assert.ok(!tableJson.includes(reference), reference);
      // The guest never names a session or table, and a stale CSRF is refused.
      await assert.rejects(
        tableRead.read({
          sessionCredential: guest.sessionCredential,
          csrfCredential: guest.csrfCredential,
          diningSessionReference: dining.session.diningSessionReference,
        }),
        { code: "ORDER_STATUS_INPUT_INVALID" },
      );
      await assert.rejects(
        tableRead.read({
          sessionCredential: guest.sessionCredential,
          csrfCredential: guest.wrongCsrf,
        }),
        { code: "ORDER_STATUS_PERMISSION_DENIED" },
      );

      // ── 3b. The merchant order queue (persistent composition, real encrypted staff session).
      const queueSession = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(api),
        scope: ownerScope,
        actor: id(0x700),
        at: now(),
        // The other merchant reads store tablets poll, measured below (query budgets).
        extraPermissions: [
          "dining.operate",
          "dining.item.serve",
          "kitchen.operate",
          "fulfillment.operate",
          "workflow.operate",
          "task.claim",
          "dining.session.close",
          // Closing a table from Tables also needs closing its Order (the page then reads each
          // open session's Order, measured below).
          "order.close",
        ],
      });
      const queue = createPersistentMerchantOrderQueue({
        persistence: { ...queueSession.persistence, now },
        quoteVersion: 1,
        acceptanceConfigured: true,
      });
      const queued = await queue({
        sessionCookie: queueSession.sessionCookie,
        afterOrderReference: null,
        orderReference,
      });
      const [queuedOrder] = queued.items;
      assert.equal(queuedOrder.orderReference, orderReference);
      // WP-2423 Q21: the queue carries the Store business date the Order was submitted under.
      assert.equal(
        queuedOrder.businessDate,
        (
          await one(
            "SELECT business_date::text AS business_date FROM rms_ordering.order_header WHERE order_id=$1",
            [orderReference],
          )
        )[0].business_date,
      );
      assert.deepEqual(
        queuedOrder.batches.map((b) => [b.orderBatchReference, b.acceptanceStatus, b.paymentDue]),
        [
          [R1.batch.orderBatchReference, "Accepted", null],
          [R2.batch.orderBatchReference, "Cancelled", null],
        ],
      );
      assert.equal(queuedOrder.awaitingPayment, false);
      // WP-2423: staff see what the table paid online — round 1 only (round 2 was never paid).
      assert.deepEqual(queuedOrder.paidOnline, {
        amountMinor: String(roundTotal),
        currencyCode: "CAD",
      });
      // The detail lists every line; the merchant screen's rule takes the unpaid round off the total.
      const unpaidRounds = unpaidCancelledBatches(queued);
      assert.deepEqual([...unpaidRounds], [R2.batch.orderBatchReference]);
      assert.deepEqual(unpaidCancelledTotal(queued.lines, unpaidRounds), {
        cancelled: { amountMinor: String(roundTotal), currencyCode: "CAD" },
        remaining: { amountMinor: String(roundTotal), currencyCode: "CAD" },
      });

      // ── 3c. Query budgets (WP-2423) for the merchant reads store tablets poll every few
      // seconds: the caller's Session, Store and permission are resolved in full at the start of
      // the read and once more before the reply, never again inside every owner read (that cost
      // ~30 queries per owner read and grew with every order, table and task on the screen).
      const staffSession = {
        sessionCookie: queueSession.sessionCookie,
        csrf: queueSession.csrf,
      };
      const merchantPersistence = { ...queueSession.persistence, now };
      const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
      // Test-only: Dining unpaid-batch exception Tasks on the table's session, in the Store's
      // Task queue (Task owner rows; the Task inbox reads them through its real owner reads).
      const taskQueue = fresh(),
        taskAt = new Date(Date.now() - minutes(1)).toISOString();
      const insertTask = (record, operation, expectedVersion) =>
        admin.query(
          "INSERT INTO bop_task.task_version(task_id,brand_id,store_id,version,expected_version,operation_code,idempotency_key,request_digest,mutation_digest,audit_id,source_type,source_id,task_type,status,occurred_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'DINING_SESSION',$10,$11,$12,$13,$14::jsonb)",
          [
            record.taskReference,
            scope.brandReference,
            scope.storeReference,
            record.version,
            expectedVersion,
            operation,
            fresh(),
            "sha256:" + "a".repeat(64),
            fresh(),
            dining.session.diningSessionReference,
            record.taskType,
            record.status,
            record.updatedAt,
            JSON.stringify(record),
          ],
        );
      for (let n = 0; n < 5; n += 1) {
        const open = createTaskRecord({
          taskReference: fresh(),
          scope: { kind: "Store", ...scope },
          source: {
            sourceType: "DINING_SESSION",
            sourceReference: dining.session.diningSessionReference,
            snapshotDigest: "sha256:" + "a".repeat(64),
          },
          taskType: "DINING_UNPAID_BATCH_EXCEPTION",
          severityCode: "CRITICAL",
          priorityCode: "NORMAL",
          status: "Open",
          assignmentHistory: [],
          currentAssignment: null,
          claimHistory: [],
          currentClaim: null,
          dueAt: new Date(Date.now() + minutes(60)).toISOString(),
          escalationPolicyReference: fresh(),
          escalationHistory: [],
          terminalOutcome: null,
          version: 1,
          createdAt: taskAt,
          updatedAt: taskAt,
        });
        await insertTask(open, "Create", 1);
        const assignment = {
          assignmentReference: fresh(),
          target: { kind: "Queue", reference: taskQueue },
          assignedBy: id(0x700),
          assignedAt: taskAt,
          reasonCode: "TEST_ASSIGNMENT",
        };
        await insertTask(
          createTaskRecord({
            ...open,
            status: "Assigned",
            version: 2,
            assignmentHistory: [assignment],
            currentAssignment: assignment,
          }),
          "Assign",
          1,
        );
      }
      const merchantReads = {
        orderQueue: () =>
          queue({ sessionCookie: staffSession.sessionCookie, afterOrderReference: null }),
        orderDetail: () =>
          queue({
            sessionCookie: staffSession.sessionCookie,
            afterOrderReference: null,
            orderReference,
          }),
        diningTables: () =>
          createMerchantDiningTables({
            persistence: merchantPersistence,
            authentication: queueSession.authentication,
            tableAvailabilityCommandEnabled: true,
          })({ ...staffSession, query: { afterTableReference: null, limit: 100 } }),
        diningOrderProgress: () =>
          createMerchantDiningOrderProgress({
            persistence: merchantPersistence,
            authentication: queueSession.authentication,
            locale: "en-CA",
          })({ ...staffSession, query: { orderReference } }),
        // The journey builds no kitchen queue projection (the pilot worker does), so the board's
        // read is measured up to its projection read, which answers "no active queue" here.
        kitchenUntilProjection: () =>
          createMerchantKitchenQuery({
            persistence: merchantPersistence,
            authentication: queueSession.authentication,
            sha256,
          })({
            ...staffSession,
            query: {
              kind: "List",
              filters: {
                orderReference: null,
                ticketReference: null,
                workItemReference: null,
                stationReference: null,
                status: null,
              },
              cursor: null,
              limit: 50,
            },
          }).then(
            () => assert.fail("no kitchen queue projection in the journey"),
            (error) => assert.equal(error.code, "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE"),
          ),
        pickup: () =>
          createMerchantPickupQuery({
            persistence: merchantPersistence,
            authentication: queueSession.authentication,
            // Test-only: this dine-in Store has no pickups, so no source is ever validated.
            store: { sha256, validateCurrentSource: async () => false },
            installContext: async () => undefined,
          })({
            ...staffSession,
            query: { afterFulfillmentReference: null, limit: 50, includeCompleted: false },
          }),
        taskInbox: () =>
          createPersistentMerchantTaskInbox({
            persistence: merchantPersistence,
            queues: [
              {
                ...ownerScope,
                queueReference: taskQueue,
                effectiveFrom: time(-minutes(600)),
                effectiveUntil: time(minutes(600)),
              },
            ],
            authorizeSource: createMerchantDiningTaskSource(merchantPersistence),
          })(staffSession.sessionCookie, { afterTaskReference: null }),
      };
      const queries = {};
      for (const [name, read] of Object.entries(merchantReads)) {
        queryCount.value = 0;
        const value = await read();
        queries[name] = queryCount.value;
        if (name === "taskInbox") assert.equal(value.items.length, 5, "task inbox items");
        // v15 2026-10-16: serving progress carries each line's options and note (Ordering's own
        // order lines, read under the restricted API role) so identical lines can be told apart.
        if (name === "diningOrderProgress")
          for (const item of value.items) {
            assert.ok(Array.isArray(item.options), "serving progress options");
            assert.ok(item.customerNote === null || typeof item.customerNote === "string");
          }
      }
      // Measured 2026-10-14 (before → after): order queue 349 → 168, order detail 384 → 170,
      // tables 156 → 87, dining order progress 652 → 100, kitchen up to its projection read
      // 130 → 38, pickup 105 → 59, Task inbox with five Dining Tasks 486 → 170.
      // 2026-10-15: the staff-round, round-date and close-session additions had raised tables to
      // 135 (one full permission resolution per offered action) and the queue/detail to 180/182;
      // the offered actions now come from one permission read with the read's own, and card-machine
      // payments are read once per page: tables 65 (with the session-Order read for closing),
      // order queue 131, order detail 133.
      const budgets = {
        orderQueue: 160,
        orderDetail: 160,
        diningTables: 80,
        diningOrderProgress: 130,
        kitchenUntilProjection: 60,
        pickup: 75,
        taskInbox: 210,
      };
      for (const [name, budget] of Object.entries(budgets))
        assert.ok(queries[name] <= budget, "merchant read queries " + JSON.stringify(queries));

      // ── 3d. Tables scale with the page, not with each open table (WP-2423): the same read with
      // a second occupied table (test-only owner rows, rolled back) costs no more queries. A store
      // has 20–40 tables polled every few seconds, so a per-table owner read would multiply.
      const secondTable = async (client) => {
        const tableReference = scope.storeReference.slice(0, 24) + "00000000a0f1";
        const sessionReference = scope.storeReference.slice(0, 24) + "00000000a0f2";
        const startedAt = time(-minutes(20));
        const session = parseDiningSession({
          diningSessionReference: sessionReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          tableReference,
          tableAssignmentVersion: 1,
          phase: "Active",
          version: 2,
          startedByActorReference: id(0x6f1),
          startedAt,
          hostParticipantReference: id(0x6f2),
        });
        const table = createDiningTable({
          ...ownerScope,
          tableReference,
          stableLabel: "SYNTHETIC-SECOND",
          areaReference: tableReference.slice(0, 24) + "00000000a0f3",
          areaCode: "ROOM",
          capacity: 2,
          accessibilityAttributes: [],
          lifecycle: "Published",
          qrStatus: "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: sessionReference,
          aggregateVersion: 1,
          createdAt: startedAt,
          observedAt: startedAt,
        });
        await client.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [
            tableReference,
            tenant,
            scope.brandReference,
            scope.storeReference,
            JSON.stringify(table),
            startedAt,
          ],
        );
        await client.query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
          [
            sessionReference,
            tenant,
            scope.brandReference,
            scope.storeReference,
            tableReference,
            JSON.stringify(session),
            startedAt,
          ],
        );
      };
      const tablesWith = async (before) => {
        queryCount.value = 0;
        const view = await createMerchantDiningTables({
          persistence: {
            ...merchantPersistence,
            transactions: transactions(api, { before, rollback: true }),
          },
          authentication: queueSession.authentication,
          tableAvailabilityCommandEnabled: true,
        })({ ...staffSession, query: { afterTableReference: null, limit: 100 } });
        return { view, queries: queryCount.value };
      };
      const oneTable = await tablesWith(null);
      const twoTables = await tablesWith(secondTable);
      assert.equal(oneTable.view.items.filter((t) => t.session !== null).length, 1);
      assert.equal(twoTables.view.items.filter((t) => t.session !== null).length, 2);
      assert.equal(twoTables.view.canCloseSessions, true);
      assert.ok(
        twoTables.queries - oneTable.queries <= 2,
        "tables read queries by open tables " +
          JSON.stringify({ one: oneTable.queries, two: twoTables.queries }),
      );

      // ── 4b. Redelivery of round 2's event after the cancellation is a completed duplicate.
      assert.deepEqual(await consume(event2), { status: "duplicate_completed" });

      // ── 5. The table Cart idles past its timeout and the pilot cart-expiry worker expires it.
      // One minute after the idle timeout (journey clock), then the guest returns a minute later.
      const cartClock = clockFrom(
        new Date(Date.parse(R2.batch.submittedAt) + minutes(61)).toISOString(),
      );
      const cartExpiry = createInternalCartExpiryPorts({
        scope,
        transactions: transactions(api),
        now: cartClock,
        publicProfile: { binding: { tenantReference: tenant, validUntil: time(minutes(600)) } },
      });
      const due = await cartExpiry.discover(10, null);
      assert.deepEqual(
        due.map((candidate) => candidate.cartReference),
        [R2.batch.sourceCartReference],
      );
      assert.equal(await cartExpiry.expire(due[0]), "Applied");
      const cartState = async (cart) =>
        (
          await one(
            "SELECT lifecycle_status AS status,aggregate_version AS version,(SELECT count(*)::int FROM rms_ordering.cart_line l WHERE l.cart_id=c.cart_id) AS lines FROM rms_ordering.cart c WHERE cart_id=$1",
            [cart],
          )
        )[0];
      assert.equal((await cartState(R2.batch.sourceCartReference)).status, "Expired");

      // A non-Host participant opens the table Cart to add an item: the timed-out Cart is
      // replaced (customer dining cart composition with replacement). Test-only Identity stand-in:
      // the guest credential resolves to P's current Dining-bound guest record.
      const R3cart = journeyRound({ at: now(), prefix: "01a00003" }).batch.sourceCartReference;
      const guestP = "G".repeat(40) + "PPP";
      const guestRecordP = {
        sessionReference: id(0x611),
        status: "Active",
        version: 1,
        ...scope,
        publicStoreReference: id(0x612),
        publicTableReference: id(0x613),
        channel: "DineIn",
        locale: "en-CA",
        qrReference: id(0x614),
        qrRevocationVersion: 1,
        diningState: "DiningBound",
        diningSessionReference: dining.session.diningSessionReference,
        diningParticipantReference: participantP,
        createdAt: time(-minutes(149)),
        lastSeenAt: time(-minutes(40)),
        idleExpiresAt: time(minutes(200)),
        absoluteExpiresAt: time(minutes(1291)),
        orderClosedAt: null,
        closureExpiresAt: null,
        rotatedFromGuestSessionReference: null,
        revocationReason: null,
        revokedAt: null,
      };
      const cartAudit = (actionCode, reasonCode) => (d) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: actionCode ?? "ORDERING_DINING_CART_" + d.action.toUpperCase(),
        targetType: "OrderingCart",
        targetId: d.cartReference,
        reasonCode,
        correlationId: d.operationReference,
        occurredAt: d.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const cartPolicy = {
        policyVersionReference: R2.f.cart.lifecycle.policyVersionReference,
        policyDigest: R2.f.cart.lifecycle.policyDigest,
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: time(-minutes(1440)),
        validUntil: time(minutes(1440)),
      };
      const cartRunner = transactions(api);
      const selection = createDiningCartSelectionService({
        scope,
        now: cartClock,
        sessions: {
          resolve: async (input) => {
            if (input.sessionCredential !== guestP) throw new CartError("CART_PERMISSION_DENIED");
            return createGuestSession(guestRecordP);
          },
        },
        participation: createDiningCartParticipationQuery({
          scope,
          repository: createPostgresDiningParticipationStore(cartRunner, ownerScope),
          now: cartClock,
        }),
        selection: createPostgresDiningCartSelectionStore(cartRunner, {
          scope,
          sourceChannel: "Qr",
          policy: cartPolicy,
          generateReference: fresh,
          now: cartClock,
          audit: cartAudit(null, "AUTHORIZED_CART_SELECTION"),
        }),
      });
      const settlement = createDiningCartReplacementSettlement({
        scope: paymentScope,
        now: cartClock,
        authorize: async () => true,
      });
      const successorReferences = [R3cart];
      const replacement = createPostgresDiningCartReplacementStore(cartRunner, {
        scope,
        policy: cartPolicy,
        generateReference: () => successorReferences.shift() ?? fresh(),
        now: cartClock,
        audit: cartAudit("ORDERING_DINING_CART_REPLACE", "AUTHORIZED_CART_REPLACEMENT"),
        authorizeAndFence: (tx, command) =>
          fenceDiningCartReplacement({ run: (work) => work(tx) }, ownerScope, command, cartClock()),
        settlementClear: (tx, cart, at) => settlement.clear(tx, cart, at),
      });
      const succession = createPostgresDiningCartSuccessionSource(cartRunner, scope);
      const cartPort = createCustomerDiningCartPort({
        selection: {
          select: (command) =>
            selection.select({
              sessionCredential: command.sessionCredential,
              operationReference: command.operationReference,
            }),
        },
        // Test-only presentation stand-in: the selected Cart as an empty Active view.
        query: {
          read: async ({ cartReference }) => ({
            schemaVersion: 1,
            cart: {
              cartReference,
              version: 1,
              orderType: "DineIn",
              serviceMode: "DineIn",
              context: { brandName: "Synthetic", storeName: "Synthetic" },
              lifecycle: { status: "Active", idleExpiresAt: time(60), absoluteExpiresAt: time(60) },
              items: [],
              quote: null,
              warnings: [],
            },
          }),
        },
        continuation: {
          previous: async () =>
            succession.previous({ diningSessionReference: dining.session.diningSessionReference }),
          replacement: {
            replace: (input) =>
              replacement.replace({
                ...scope,
                operationReference: input.operationReference,
                diningSessionReference: dining.session.diningSessionReference,
                guestSessionReference: guestRecordP.sessionReference,
                participantReference: participantP,
                previousCartReference: input.previousCartReference,
                expectedCartVersion: input.expectedCartVersion,
                observedAt: cartClock(),
              }),
          },
        },
      });
      const opened = await cartPort.createCart({
        guestCredential: guestP,
        csrfCredential: "C".repeat(43),
        operationReference: fresh(),
        requestedAt: cartClock(),
      });
      assert.ok(["Applied", "Current"].includes(opened.status), opened.status);
      assert.equal(opened.view.cart.cartReference, R3cart);
      // Round 2's lines left the Cart when it was ordered: nothing unordered was cleared.
      assert.equal(opened.view.cart.warnings.includes(EARLIER_CART_ITEMS_CLEARED), false);
      const replaced = await one(
        "SELECT previous_cart_id::text AS previous,cart_id::text AS cart,participant_id::text AS participant FROM rms_ordering.dining_cart_replacement WHERE dining_session_id=$1",
        [dining.session.diningSessionReference],
      );
      assert.deepEqual(replaced, [
        { previous: R2.batch.sourceCartReference, cart: R3cart, participant: participantP },
      ]);
      assert.deepEqual(await cartState(R3cart), { status: "Active", version: 1, lines: 0 });

      // Test-only stand-in for the cart edits (catalog add-to-cart is outside this journey): the
      // Host's round-3 lines are written onto the successor Cart by the owner, as four edits.
      // DEC-DINING-ANY-PARTICIPANT-SUBMIT: participant P (not the Host) submits and pays round 3.
      const R3 = journeyRound({
        at: new Date(Date.now() + 1500).toISOString(),
        prefix: "01a00003",
        submitter: guestSessionP,
      });
      assert.equal(R3.batch.sourceCartReference, R3cart);
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=$2,updated_at=$3 WHERE cart_id=$1",
        [R3cart, R3.f.cart.aggregateVersion, cartClock()],
      );
      for (const item of R3.f.cart.items)
        await admin.query(
          "INSERT INTO rms_ordering.cart_line (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,customer_note,catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12)",
          [
            item.cartItemReference,
            R3cart,
            scope.brandReference,
            scope.storeReference,
            item.sellableReference,
            item.quantity,
            JSON.stringify(item.optionSelections),
            item.customerNote,
            JSON.stringify(item.catalogSelectionEvidence),
            item.addedByActorReference,
            item.addedByParticipantReference,
            item.addedAt,
          ],
        );

      // ── 5b. Round 3 after the System cancellation: the actual Ordering writer at the current
      // transaction clock, expected version 4 (Initial, Acceptance, AdditionalBatch, cancellation).
      const pay3 = paymentRefs(0x3000);
      const link3 = await dining.prepare(R3, {
        paymentOperationReference: pay3.paymentOperation,
        participant: dining.guest,
      });
      // DEC-DINING-ANY-PARTICIPANT-SUBMIT: P's checkout now holds this Cart version. Dining's public
      // hold read (pilot API grants) tells the Host until when, and tells P nothing is in the way.
      const holdSource = createPostgresDiningCheckoutHoldSource(transactions(api), ownerScope);
      const holdOf = (participantReference, cartVersion, observedAt = now()) =>
        holdSource.read({
          diningSessionReference: dining.session.diningSessionReference,
          cartReference: R3.batch.sourceCartReference,
          cartVersion,
          participantReference,
          observedAt,
        });
      // An unsealed checkout holds the table for at most a minute (the customer's Continue prepares
      // and pays in one action); a failed or abandoned attempt then stops blocking the others.
      const preparedAt3 = R3.f.request.checkoutValidationEvidence.fulfillment.checkedAt;
      const heldUntil3 = new Date(
        Math.min(
          Date.parse(R3.f.request.checkoutValidationEvidence.fulfillment.validUntil),
          Date.parse(preparedAt3) + 60_000,
        ),
      ).toISOString();
      assert.deepEqual(await holdOf(dining.host.participantReference, R3.batch.sourceCartVersion), {
        heldUntil: heldUntil3,
      });
      assert.equal(await holdOf(participantP, R3.batch.sourceCartVersion), null);
      // The hold ends by itself at the checkout's deadline: no stale lock.
      assert.equal(
        await holdOf(dining.host.participantReference, R3.batch.sourceCartVersion, heldUntil3),
        null,
      );
      // The Host's own checkout of the same Cart version is refused by Dining (nothing written);
      // P's checkout is untouched.
      const hostAttempt = journeyRound({
        at: R3.f.request.checkoutValidationEvidence.fulfillment.checkedAt,
        prefix: "01a00004",
      });
      await assert.rejects(
        dining.prepare(
          {
            ...hostAttempt,
            batch: {
              ...hostAttempt.batch,
              sourceCartReference: R3.batch.sourceCartReference,
              sourceCartVersion: R3.batch.sourceCartVersion,
            },
          },
          { paymentOperationReference: id(0x3201) },
        ),
        { code: "DINING_CHECKOUT_HELD", heldUntil: heldUntil3 },
      );
      assert.equal(
        (
          await one(
            "SELECT count(*)::int AS n FROM rms_dining.dining_checkout_commitment WHERE submission_id=$1",
            [hostAttempt.batch.submissionReference],
          )
        )[0].n,
        0,
      );
      const evidence3 = R3.evidence(link3),
        items3 = R3.items(evidence3);
      await seedJourneyCheckout(admin, {
        round: R3,
        evidence: evidence3,
        link: link3,
        references: {
          createOperation: id(0x3101),
          checkoutSession: id(0x3102),
          details: id(0x3103),
          detailsOperation: id(0x3104),
        },
      });
      const snapshot3 = additional(R3, items3, 4, 3);
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: snapshot3,
        prefix: "01a10003",
      });
      while (Date.now() <= Date.parse(R3.batch.submittedAt) + 50) await delay(50);
      // Test-only: mark a participant as having left the table inside the attempt's own
      // transaction (owner write, then the restricted role), and roll the attempt back.
      const leaves = (participant) => async (client) => {
        await client.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const left = await client.query(
          "UPDATE rms_dining.dining_participant SET status='Left',version=2,participant_snapshot=participant_snapshot||jsonb_build_object('status','Left','version',2,'leftAt',$2::text) WHERE participant_id=$1",
          [participant, now()],
        );
        assert.equal(left.rowCount, 1);
      };
      const reservedBefore3 = await stockReserved(stock.accountReference);
      // A guest who has left the table can no longer submit what they started: the Dining gate
      // refuses it under the pilot API grants and nothing is written.
      await assert.rejects(
        submit(snapshot3, link3, evidence3, null, {
          before: leaves(participantP),
          rollback: true,
        }),
      );
      // The Host leaving does not stop the rest of the table: P's submission goes through (the
      // attempt is rolled back so the journey continues with the Host still seated).
      const withoutHost = await submit(snapshot3, link3, evidence3, null, {
        before: leaves(dining.host.participantReference),
        rollback: true,
      });
      assert.equal(withoutHost.status, "Created");
      assert.equal(await stockReserved(stock.accountReference), reservedBefore3);
      assert.equal(
        (await commitment(R3.batch.submissionReference)).state,
        "Prepared",
        "rolled-back attempts leave the commitment unsealed",
      );
      const submitted3 = await submit(snapshot3, link3, evidence3);
      assert.equal(submitted3.status, "Created");
      // Once P's round is submitted the Cart moves to a new version that nobody holds.
      assert.equal(
        await holdOf(dining.host.participantReference, R3.batch.sourceCartVersion + 1),
        null,
      );

      // ── 5c'. WP-2423 lock order (v15 deadlocks 2026-10-13/14): two connections at once. Staff
      // acceptance and payment outcomes take the Order's disposition fence and then lock the
      // table row FOR UPDATE through Dining's checkout commitment; a guest's next-round read of
      // the current Order authorizes through the guest's table (the identity check reads the row
      // FOR SHARE). The guest side must take the fence first, so the two wait instead of
      // deadlocking. Real Ordering fence, Ordering preparation source, Dining stores; the guest's
      // identity check is stood in by Dining's public table reader it uses (test-only).
      let fenced, proceed;
      const holdsFence = new Promise((resolve) => (fenced = resolve)),
        go = new Promise((resolve) => (proceed = resolve));
      const staffSide = transactions(api).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await acquireOrderDispositionFence(tx, { ...scope, orderReference });
        fenced();
        await go;
        return createPostgresDiningCheckoutCommitmentStore(
          { run: (work) => work(tx) },
          ownerScope,
          {
            now,
          },
        ).withCurrentFacts(link3.commitmentReference, async (_tx, facts) => facts.commitment.state);
      });
      await holdsFence;
      const guestSide = transactions(api).run((tx) =>
        createPostgresDiningOrderPreparationSource({
          ...scope,
          authorize: async (inner) =>
            (await createPostgresDiningPublicTableReader({
              transaction: inner,
              scope: ownerScope,
              authorize: async () => true,
            }).read({
              tableReference: dining.table.tableReference,
              purpose: "GuestSessionBinding",
              observedAt: now(),
            })) !== null,
        }).resolve({
          transaction: tx,
          ...scope,
          orderReference,
          diningSessionReference: dining.session.diningSessionReference,
          guestSessionReference: guestSessionP,
          observedAt: now(),
        }),
      );
      await delay(500); // the guest side is now waiting
      proceed();
      const [staffResult, guestResult] = await Promise.allSettled([staffSide, guestSide]);
      assert.equal(staffResult.status, "fulfilled", String(staffResult.reason?.code));
      assert.equal(staffResult.value, "PaymentPending");
      assert.equal(guestResult.status, "fulfilled", String(guestResult.reason?.code));
      assert.equal(guestResult.value.orderReference, orderReference);
      // Round 3 reserves the same stock round 2 had reserved (round 2's was returned).
      assert.equal(await stockReserved(stock.accountReference), reservedRound2);
      assert.deepEqual(await cartState(R3cart), {
        status: "Active",
        version: R3.f.cart.aggregateVersion + 1,
        lines: 0,
      });
      const revisions = await one(
        "SELECT kind,version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version",
        [orderReference],
      );
      assert.deepEqual(
        revisions.map((r) => r.kind),
        ["Initial", "Acceptance", "AdditionalBatch", "BatchCancellation", "AdditionalBatch"],
      );
      const sealed3 = await commitment(R3.batch.submissionReference);
      // The seal and the payment belong to the submitter P, not the Host.
      assert.equal(sealed3.state, "PaymentPending");
      assert.equal(sealed3.participantReference, participantP);
      assert.equal(sealed3.guestSessionReference, guestSessionP);
      // The payment claim's history authority (the actual composition, pilot API grants) admits P
      // for round 3 and refuses the Host, who did not submit it.
      const historyOf = (who) =>
        transactions(api).run((tx) =>
          createCustomerAdditionalDiningHistoryAuthorization(
            { scope: ownerScope, identity: () => who.identity },
            { sessionCredential: who.sessionCredential, csrfCredential: who.csrfCredential },
          )(tx, { ...scope, submissionReference: R3.batch.submissionReference }),
        );
      assert.equal(await historyOf(tableGuestP), true);
      assert.equal(await historyOf(guest), false);
      await delay(1100);
      const paid3At = new Date(Date.parse(sealed3.paymentRequestedAt) + 500).toISOString();
      await seedJourneyPayment(admin, {
        scope,
        providerAccountReference: provider,
        round: R3,
        refs: { ...pay3, commitment: sealed3.commitmentReference },
        outcome: "Succeeded",
        requestedAt: sealed3.paymentRequestedAt,
        occurredAt: paid3At,
        totalMinor: roundTotal,
      });
      await seedJourneyAcceptance(admin, {
        scope,
        round: R3,
        items: items3,
        refs: pay3,
        staff,
        version: 5,
        previousRevision: R3.batch.submissionReference,
        acceptedAt: new Date(Date.parse(paid3At) + 100).toISOString(),
        kitchenAt: new Date(Date.parse(paid3At) + 200).toISOString(),
      });
      await delay(300);

      // ── 4c. The projection consumer takes round 3 (after the cancellation revision).
      const event3 = submittedEvents.get(R3.batch.orderBatchReference);
      assert.deepEqual(await consume(event3), { status: "processed" });
      const projected = await transactions(api).run((tx) =>
        createPostgresOrderStatusProjectionStore({
          ...scope,
          authorize: async () => true,
          validateCurrentSource: async () => false,
        }).load({ transaction: tx, orderReference }),
      );
      assert.deepEqual(
        projected.snapshot.batches.map((b) => b.orderBatchReference),
        [R1.batch.orderBatchReference, R2.batch.orderBatchReference, R3.batch.orderBatchReference],
      );
      // ── 4d. WP-2423 Q8: round 3 on the table view for both guests; the table has paid twice.
      const hostAfter3 = await tableOf(guest);
      assert.deepEqual(roundsOf(hostAfter3), [
        [1, "You", "Queued", "Paid"],
        [2, "You", "NotPaidCancelled", "NotCharged"],
        [3, "AnotherGuest", "Queued", "Paid"],
      ]);
      assert.equal(hostAfter3.summary.paid.amountMinor, 2n * roundTotal);
      assert.equal(hostAfter3.summary.due.amountMinor, 0n);
      assert.deepEqual(
        roundsOf(await tableOf(tableGuestP)).map(([n, who]) => [n, who]),
        [
          [1, "AnotherGuest"],
          [2, "AnotherGuest"],
          [3, "You"],
        ],
      );

      // No consumer failure, retry or dead letter for any OrderSubmitted event of the Order.
      assert.deepEqual(
        await one(
          "SELECT (SELECT count(*)::int FROM platform_eventing.dead_letter_item) AS dead,(SELECT count(*)::int FROM platform_eventing.consumer_retry_schedule) AS retries",
        ),
        [{ dead: 0, retries: 0 }],
      );

      // ── 5c. The guest's receipt once round 3 is paid: it covers the charged rounds (1 and 3)
      // and never the unpaid, cancelled round 2.
      await admin.query(
        "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic journey issuer','Synthetic Journey Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
        [id(0xb01), id(0xb02), id(0xb03), id(0xb04), id(0xb05), id(0xb06), time(-minutes(300))],
      );
      await admin.query(
        "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
        [id(0xb07), scope.brandReference, scope.storeReference, id(0xb01), time(-minutes(300))],
      );
      // The template is published by its own setup role (pilot API grants plus what the helper
      // grants for authoring); issuance below reads it under the pilot API grants only.
      const templateRole = "wp2423_dj_t_" + context.runId,
        templateWorker = "wp2423_dj_tw_" + context.runId;
      for (const name of [templateRole, templateWorker]) {
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
        setupRoles.push(name);
      }
      await admin.query(renderPilotAclSql(matrices, { api: templateRole, worker: templateWorker }));
      const templateSource = await exerciseReceiptTemplate({
        admin,
        runner: transactions(templateRole),
        role: templateRole,
        scope,
        at: time(-minutes(200)),
        tenantReference: tenant,
      });
      const receiptScope = {
        ...ownerScope,
        providerAccountReference: provider,
        environment: "Test",
      };
      const receiptAudit = (actionReason) => async (record, operationReference) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DIGITAL_RECEIPT_APPEND",
        targetType: "DigitalReceipt",
        targetId: record.recordReference,
        reasonCode: actionReason,
        correlationId: operationReference,
        occurredAt: record.recordedAt,
        sourceChannel: "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const original = await transactions(api).run((tx) =>
        createOriginalReceiptIssuance({
          sources: {
            scope: receiptScope,
            authorize: async () => true,
            order: (t2, input) =>
              createPostgresReceiptOrderSource({ ...scope, authorize: async () => true })(
                t2,
                input,
              ),
            template: (t2) => templateSource(t2),
          },
          authorize: async () => true,
          identities: () => ({
            recordReference: fresh(),
            receiptReference: fresh(),
            operationReference: fresh(),
          }),
          audit: receiptAudit("SYNTHETIC_RECEIPT_RETRIEVAL"),
        })(tx, { orderReference, observedAt: now(), freshAfter: paid1At }),
      );
      assert.equal(original.status, "Created");
      assert.equal(original.record.kind, "Original");
      assert.deepEqual(
        original.record.snapshot.lines.map((line) => line.lineReference),
        [items1[0].orderItemReference, items3[0].orderItemReference],
      );
      assert.equal(original.record.snapshot.total.amountMinor, 2n * roundTotal);
      assert.equal(original.record.snapshot.paymentStatus, "Paid");

      // ── 6. Escalated refund of round 1 on a later business day. Workforce: real Membership,
      // Store assignment, roles, permission grants and MFA (verified two hours ago, so only a
      // step-up is recent). Only the merchant session lookup is a test double (cookie -> staff).
      const from = time(-minutes(240)),
        until = time(minutes(600));
      const [manager, owner] = [id(0x801), id(0x802)];
      const brandFact = createBrand({
        brandReference: scope.brandReference,
        code: "SYNTHETIC_JOURNEY",
        displayName: "Synthetic Journey Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      const storeFact = createStore({
        storeReference: scope.storeReference,
        brandReference: scope.brandReference,
        code: "SYNTHETIC_JOURNEY",
        displayName: "Synthetic Journey Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: from,
        updatedAt: from,
      });
      const roleSets = {
        manager: {
          id: id(0x810),
          code: "store_manager",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.request",
            "payment.refund.execute",
          ],
        },
        owner: {
          id: id(0x811),
          code: "store_owner",
          actions: [
            "merchant.access",
            "workflow.operate",
            "payment.refund.approve",
            "payment.refund.execute",
          ],
        },
      };
      let permissionNumber = 0x850;
      for (const r of Object.values(roleSets)) {
        await admin.query(
          "INSERT INTO bop_permission.role VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [r.id, scope.brandReference, scope.storeReference, r.code, from, until],
        );
        for (const action of r.actions) {
          let permission = (
            await one(
              "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
              [action],
            )
          )[0]?.permission_id;
          if (!permission) {
            permission = id(permissionNumber++);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
              [permission, action, from],
            );
          }
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
            [
              id(permissionNumber++),
              r.id,
              permission,
              scope.brandReference,
              scope.storeReference,
              from,
              until,
            ],
          );
        }
      }
      for (const [i, [actor, held]] of [
        [manager, roleSets.manager],
        [owner, roleSets.owner],
      ].entries()) {
        const n = 0x900 + i * 0x10;
        await admin.query(
          "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
          [id(n), actor, scope.brandReference, id(n + 1), from, until],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
          [id(n + 2), id(n), actor, scope.brandReference, scope.storeReference, from, until],
        );
        await admin.query(
          "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
          [
            id(n + 3),
            held.id,
            id(n),
            id(n + 2),
            actor,
            scope.brandReference,
            scope.storeReference,
            from,
            until,
          ],
        );
        await admin.query(
          "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
          [actor, id(n + 6), time(-minutes(120))],
        );
      }
      const currentActor = async (_tx, reference, authenticatedAt) => {
        assert.ok([manager, owner].includes(reference));
        return createIdentityActor({
          actorType: "User",
          actorReference: reference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        });
      };
      const cookies = { manager, owner };
      signedIn.cookies = new Set(Object.keys(cookies));
      signedIn.scopeFor = async (tx, cookie, action) => {
        const actorReference = cookies[cookie];
        const resolvedAt = now();
        const actor = await currentActor(tx, actorReference, from);
        const decide = async (requested) => {
          try {
            const at = now();
            const result = await createMerchantWorkforcePermissionSource({
              resolveContext: async () => ({
                tenantReference: tenant,
                context: createTenantContext(actor, brandFact, storeFact, at),
              }),
            })(tx, { ...ownerScope, actorReference, observedAt: at, permissionCode: requested });
            return result.decision;
          } catch {
            return null;
          }
        };
        return {
          selected: { tenantReference: tenant },
          context: createTenantContext(actor, brandFact, storeFact, resolvedAt),
          store: storeFact,
          actorReference,
          sessionReference: id(0xa00 + Object.keys(cookies).indexOf(cookie)),
          // As the real Store scope: these are browser sign-ins, not kitchen display Sessions,
          // so the kitchen display profile limit allows every action (the roles still decide).
          kdsOperatorProfileAllows: (requested) =>
            kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
          allowed: async () => (await decide(action))?.effect === "Allow",
          authorizeAction: decide,
        };
      };
      const session = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });

      // Synthetic test-only Store configuration: the business day starts between round 1's
      // capture and now, so round 1 was paid on the previous business date.
      const boundary =
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "America/Toronto",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(base - minutes(100))) + ":00";
      const { businessDate, storeOptions } = await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        publishedAt: time(-minutes(300)),
        businessDayStart: boundary,
        prefix: "01a20000",
      });

      // Simulated Stripe (InternalTest): the real refund adapter over a fake transport.
      const providerRefunds = [];
      let providerSends = 0;
      const stripe = createStripeOrdinaryRefundAdapter({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        environment: "Test",
        apiVersion: "2024-06-20",
        secretKey: "sk_test_SYNTHETICONLY",
        connectedAccount: null,
        now,
        fetch: async (url, init) => {
          if (init.method === "GET") {
            const intent = new URL(String(url)).searchParams.get("payment_intent");
            return globalThis.Response.json({
              object: "list",
              url: "/v1/refunds",
              has_more: false,
              data: providerRefunds.filter((refund) => refund.payment_intent === intent),
            });
          }
          const body = new globalThis.URLSearchParams(String(init.body));
          const refund = {
            object: "refund",
            id: "re_SYNTHETICJOURNEY" + String(providerRefunds.length + 1).padStart(4, "0"),
            payment_intent: body.get("payment_intent"),
            amount: Number(body.get("amount")),
            currency: "cad",
            status: "succeeded",
            created: Math.floor(Date.now() / 1000),
            metadata: { bop_refund_binding: body.get("metadata[bop_refund_binding]") },
          };
          providerRefunds.push(refund);
          return globalThis.Response.json(refund);
        },
      });

      // The merchant refund commands, composed as the pilot API composes them.
      const persistence = { transactions: transactions(api), now };
      const authentication = {
        authorize: async (input) => ({
          sessionReference: id(0xa00 + Object.keys(cookies).indexOf(input.sessionCookie)),
        }),
      };
      const roleMappingFor = async () => standardRefundRoleMapping;
      const workforceFor = (actorReference, sessionContext, current) => ({
        resolveContext: createInternalRefundWorkforceContext({
          expected: ownerScope,
          persistence: { currentActor },
          sessionActorReference: actorReference,
          sessionContext,
          current,
        }),
        resolveRoleMapping: roleMappingFor,
        stepUp: true,
      });
      const refundAudit = {
        reasonCode: "REFUND_REQUEST_EXECUTION",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      };
      const prepare = createMerchantOrdinaryRefundCommand({
        persistence,
        authentication,
        audit: refundAudit,
        resolveConfiguration: async (_tx, selected, authority) => ({
          providerAccountReference: provider,
          environment: "Test",
          workforce: workforceFor(
            selected.actorReference,
            async () => authority.context,
            async () => authority.authorize(),
          ),
          store: storeOptions,
        }),
      });
      const send = createMerchantOrdinaryRefundSendCommand({
        persistence,
        authentication,
        audit: refundAudit,
        resolveConfiguration: async ({ actorReference, resolveAuthority }) => ({
          providerAccountReference: provider,
          environment: "Test",
          workforce: workforceFor(
            actorReference,
            async (tx) => (await resolveAuthority(tx)).context,
            async (tx) => {
              await resolveAuthority(tx);
              return true;
            },
          ),
          store: storeOptions,
          provider: {
            refundPayment: async (request) => {
              providerSends++;
              return stripe.refundPayment(request);
            },
          },
          generateObservationIdentity: () => ({
            observationReference: fresh(),
            auditReference: fresh(),
          }),
        }),
      });
      const escalatedConfiguration = async (_tx, selected, authority) => ({
        providerAccountReference: provider,
        environment: "Test",
        businessDate,
        workforce: workforceFor(
          selected.actorReference,
          async () => authority.context,
          async () => authority.authorize(),
        ),
      });
      const approve = createMerchantOrdinaryRefundApproval({
        persistence,
        authentication,
        resolveConfiguration: escalatedConfiguration,
        prepare,
        send,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const refundItems = createMerchantOrdinaryRefundItems({
        persistence,
        authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping: standardRefundRoleMapping,
        }),
        newReference: fresh,
        locale: "en-CA",
      });
      const request = createMerchantOrdinaryRefundRequest({
        persistence,
        authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
          roleMapping: standardRefundRoleMapping,
        }),
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
        businessDate,
      });
      // TEST-ONLY authenticator secrets, generated per run and kept in memory only.
      const secrets = new Map([manager, owner].map((a) => [a, randomBytes(20)]));
      const stepUp = createMerchantMfaStepUp({
        persistence,
        authentication,
        method: "InternalTestTotp",
        verify: async ({ actorReference, code, atMilliseconds }) =>
          verifyTotp({ secret: secrets.get(actorReference), code, atMilliseconds }),
        newReference: fresh,
        retentionPolicyCode: "SECURITY_AUDIT",
        retentionPolicyVersion: 1,
      });
      const codeFor = (actor) => generateHotp(secrets.get(actor), totpTimeStep(Date.now()));

      const round1Refund = {
        orderReference,
        requestReference: fresh(),
        operationReference: fresh(),
        expectedClaimVersion: 0,
        reasonCode: "WRONG_ITEM",
        items: items1.map((item) => ({
          orderBatchReference: R1.batch.orderBatchReference,
          orderItemReference: item.orderItemReference,
          quantity: item.quantity,
        })),
      };
      const preview = await request.preview({ ...session("manager"), command: round1Refund });
      assert.equal(preview.amountMinor, String(roundTotal));
      assert.equal(preview.approvalRequired, true);
      assert.deepEqual(preview.escalationReasons, ["DifferentBusinessDate"]);
      // The unpaid round can never be refunded: it was not charged.
      await assert.rejects(
        request.preview({
          ...session("manager"),
          command: {
            ...round1Refund,
            items: items2.map((item) => ({
              orderBatchReference: R2.batch.orderBatchReference,
              orderItemReference: item.orderItemReference,
              quantity: item.quantity,
            })),
          },
        }),
        /ORDINARY_REFUND_REQUEST_UNAVAILABLE/u,
      );
      const refundable = await refundItems({
        ...session("manager"),
        query: { orderReference },
      });
      // Staff see round 2 as never charged: nothing of it can be refunded.
      assert.deepEqual(
        refundable.items.map((item) => [
          item.orderBatchReference,
          item.unclaimedQuantity,
          item.paymentCaptured,
        ]),
        [
          [R1.batch.orderBatchReference, 2, true],
          [R2.batch.orderBatchReference, 0, false],
          [R3.batch.orderBatchReference, 2, true],
        ],
      );
      assert.equal(
        (
          await stepUp({
            ...session("manager"),
            command: { purpose: "RefundRequest", code: codeFor(manager) },
          })
        ).status,
        "Verified",
      );
      const recorded = await request({ ...session("manager"), command: round1Refund });
      assert.equal(recorded.status, "Created");
      assert.equal(recorded.approvalRequired, true);
      assert.equal(
        (
          await stepUp({
            ...session("owner"),
            command: { purpose: "RefundApproval", code: codeFor(owner) },
          })
        ).status,
        "Verified",
      );
      const approval = {
        orderReference,
        requestReference: round1Refund.requestReference,
        approvalReference: fresh(),
      };
      const approved = await approve({ ...session("owner"), command: approval });
      assert.equal(approved.status, "Approved");
      assert.deepEqual(
        approved.payments.map((p) => [p.paymentAttemptReference, p.state]),
        [[pay1.attempt, "SendRecorded"]],
      );
      assert.equal(providerSends, 1);
      assert.deepEqual(
        providerRefunds.map((r) => [r.payment_intent, r.amount, r.status]),
        [[pay1.providerIntent, Number(roundTotal), "succeeded"]],
      );
      // Retrying the approval never sends again.
      assert.equal((await approve({ ...session("owner"), command: approval })).replayed, true);
      assert.equal(providerSends, 1);

      // ── 7. Payment position: the confirmed refund counts once; round 3 is untouched.
      const positionOf = (refs) =>
        transactions(api).run((tx) =>
          createPostgresOrdinaryRefundPositionSource({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            authorize: async () => true,
          })(tx, {
            orderReference,
            paymentTransactionReference: refs.transaction,
            paymentIntentReference: refs.paymentIntent,
            paymentAttemptReference: refs.attempt,
            observedAt: now(),
          }),
        );
      const reconcile = createPostgresOrdinaryRefundReconciliationRuntime({
        scope: ownerScope,
        providerAccountReference: provider,
        environment: "Test",
        authorize: async () => true,
        transactions: transactions(api),
        provider: { lookupRefund: (input) => stripe.lookupRefund(input) },
      });
      assert.equal(
        (
          await reconcile({
            orderReference,
            operationReference: approved.payments[0].operationReference,
            observationReference: fresh(),
            auditReference: fresh(),
          })
        ).status,
        "AlreadyConfirmed",
      );
      const position1 = await positionOf(pay1);
      assert.equal(position1.confirmedMinor, roundTotal);
      assert.equal(position1.pendingMinor, 0n);
      const position3 = await positionOf(pay3);
      assert.equal(position3.confirmedMinor, 0n);
      assert.equal(position3.pendingMinor, 0n);
      // WP-2423 Q8: the table view shows the confirmed refund once, for every guest at the table.
      const afterRefund = await tableOf(tableGuestP);
      const { ordered: orderedAfterRefund, ...moneyAfterRefund } = afterRefund.summary;
      assert.deepEqual(moneyAfterRefund, {
        paid: { amountMinor: 2n * roundTotal, currencyCode: "CAD" },
        refunded: { amountMinor: roundTotal, currencyCode: "CAD" },
        refundPending: { amountMinor: 0n, currencyCode: "CAD" },
        due: { amountMinor: 0n, currencyCode: "CAD" },
      });
      assert.equal(orderedAfterRefund.total.amountMinor, 2n * roundTotal);
      assert.equal(
        orderedAfterRefund.subtotal.amountMinor + orderedAfterRefund.tax.amountMinor,
        2n * roundTotal,
      );
      // WP-2423: the Orders page detail shows staff the same paid and refunded amounts, read as
      // the restricted merchant role through Payment's order financial position.
      const refundedDetail = await createPersistentMerchantOrderQueue({
        persistence: { ...queueSession.persistence, now },
        quoteVersion: 1,
        acceptanceConfigured: true,
        resolveRefundConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
        }),
      })({ sessionCookie: queueSession.sessionCookie, afterOrderReference: null, orderReference });
      assert.deepEqual(refundedDetail.items[0].paidOnline, {
        amountMinor: String(2n * roundTotal),
        currencyCode: "CAD",
      });
      assert.deepEqual(refundedDetail.paymentPosition, {
        refundedMinor: String(roundTotal),
        refundPendingMinor: "0",
      });
      // The Orders list row reads the same position (its order has a refund), so the row and the
      // detail agree without the row being opened.
      const refundedList = await createPersistentMerchantOrderQueue({
        persistence: { ...queueSession.persistence, now },
        quoteVersion: 1,
        acceptanceConfigured: true,
        resolveRefundConfiguration: async () => ({
          providerAccountReference: provider,
          environment: "Test",
        }),
      })({ sessionCookie: queueSession.sessionCookie, afterOrderReference: null });
      assert.deepEqual(
        refundedList.items.find((item) => item.orderReference === orderReference)?.paymentPosition,
        { refundedMinor: String(roundTotal), refundPendingMinor: "0" },
      );
      // A guest who has left the table no longer reads it; the Host still does.
      await admin.query(
        "UPDATE rms_dining.dining_participant SET status='Left',version=2,participant_snapshot=participant_snapshot||jsonb_build_object('status','Left','version',2,'leftAt',$2::text) WHERE participant_id=$1",
        [participantP, now()],
      );
      await assert.rejects(tableOf(tableGuestP), { code: "ORDER_STATUS_PERMISSION_DENIED" });
      assert.equal((await tableOf(guest)).rounds.length, 3);

      const refundReceipt = await transactions(api).run((tx) =>
        createRefundReceiptIssuance({
          scope: receiptScope,
          authorize: async () => true,
          authorizeSources: async () => true,
          authorizeOrder: async () => true,
          identities: () => ({ recordReference: fresh(), operationReference: fresh() }),
          audit: receiptAudit("PAYMENT_REFUND_STATUS_CHANGED"),
        })(tx, { orderReference, observedAt: now(), freshAfter: paid1At }),
      );
      assert.equal(refundReceipt.status, "Created");
      assert.equal(refundReceipt.record.kind, "Refund");
      assert.equal(refundReceipt.record.previousRecordReference, original.record.recordReference);
      assert.equal(refundReceipt.record.snapshot.paymentStatus, "PartiallyRefunded");
      assert.equal(refundReceipt.record.snapshot.refundedTotal.amountMinor, roundTotal);
      assert.equal(refundReceipt.record.snapshot.total.amountMinor, 2n * roundTotal);
      assert.deepEqual(refundReceipt.record.snapshot.lines, original.record.snapshot.lines);
      assert.ok(
        refundReceipt.record.snapshot.lines.every(
          (line) => line.lineReference !== items2[0].orderItemReference,
        ),
      );

      // ── 8. WP-2423 Q26: the kitchen remakes a finished round-3 dish; the table is told which.
      // Test-only stand-in: the owner marks round 3's first work item Completed (kitchen
      // completion is covered by the Kitchen suites). The remake itself is the actual Kitchen
      // rework command under the restricted API role.
      const remadeAt = now();
      await admin.query(
        "UPDATE rms_kitchen.kitchen_work_item SET status='Completed',completed_quantity=required_quantity,version=version+1,updated_at=$2 WHERE kitchen_work_item_id=$1",
        [pay3.workItems[0], remadeAt],
      );
      const rework = createPostgresKitchenReworkStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        nextReference: fresh,
      });
      const remade = await transactions(api).run((tx) =>
        rework.execute(tx, {
          command: {
            action: "CreateKitchenRework",
            idempotencyKey: fresh(),
            originalWorkItemReference: pay3.workItems[0],
            reasonCode: "DROPPED",
            note: null,
            quantity: 1,
            correlationReference: fresh(),
          },
          actorReference: staff,
          occurredAt: now(),
        }),
      );
      assert.equal(remade.status, "Applied");
      // The guest's table view, through the actual HTTP handler's serialization (JSON on the wire).
      const tableHandler = new CustomerDiningSessionHandler({
        allowedOrigin: "https://synthetic-journey.invalid",
        port: tableRead,
      }).handler();
      const wire = await new Promise((resolve, reject) => {
        const response = {
          statusCode: 0,
          setHeader: () => undefined,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(body) {
            resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(body)) });
            return this;
          },
        };
        Promise.resolve(
          tableHandler(
            {
              get: (name) => (name === "sec-fetch-site" ? "same-origin" : undefined),
              query: {},
              body: undefined,
              headers: {
                cookie: "__Host-bop-guest=" + guest.sessionCredential,
                "x-csrf-token": guest.csrfCredential,
              },
            },
            response,
            reject,
          ),
        ).catch(reject);
      });
      assert.equal(wire.status, 200);
      const round3 = wire.body.session.rounds[2];
      const remadeName = round3.items.find((item) => item.beingRemade === true)?.displayName;
      assert.equal(
        round3.items.filter((item) => Object.hasOwn(item, "beingRemade")).length,
        1,
        "only the remade dish is marked",
      );
      assert.ok(round3.items.every((item) => item.beingRemade === undefined || item.beingRemade));
      assert.ok(
        Object.values(items3[0].catalog.localizedNames).includes(remadeName),
        "the remade dish is round 3's first item",
      );
      // A dish being made again is neither ready nor served; earlier rounds are not marked.
      assert.ok(!["Ready", "Served"].includes(round3.status));
      for (const round of wire.body.session.rounds.slice(0, 2))
        assert.ok(round.items.every((item) => !Object.hasOwn(item, "beingRemade")));
      // The PWA's own decoder accepts the wire view and keeps the mark.
      assert.equal(
        parseDiningSessionView(wire.body).rounds[2].items.filter((item) => item.beingRemade).length,
        1,
      );
      const wireJson = JSON.stringify(wire.body);
      for (const reference of [remade.item.reworkReference, pay3.workItems[0], orderReference])
        assert.ok(!wireJson.includes(reference), reference);
      assert.doesNotMatch(wireJson, /DROPPED|rework/u);
    } finally {
      vi.unstubAllEnvs();
      signedIn.cookies = new Set();
      signedIn.scopeFor = null;
      for (const name of [api, worker, ...setupRoles]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
