import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createDiningCartParticipationQuery,
  createDiningGuestBindingQuery,
  createPostgresDiningCheckoutCommitmentStore,
  createPostgresDiningCheckoutHoldSource,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  CartError,
  createDiningCartSelectionService,
  createOrderNumberAllocation,
  createPostgresAdditionalDiningExecutionReader,
  createPostgresDiningCartReplacementStore,
  createPostgresDiningCartSelectionStore,
  createPostgresDiningCartSuccessionSource,
  createPostgresOrderStatusProjectionStore,
  createPostgresOrderBatchIdentitySource,
  createPostgresOrderSubmittedConsumer,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../../apps/api/src/customer-additional-dining-history-authorization.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createDiningCheckoutExpiryDispatcher } from "../../../apps/api/src/dining-checkout-expiry-dispatcher.ts";
import { createCustomerOrderStatusRead } from "../../../apps/api/src/customer-order-status-read.ts";
import { createCustomerDiningSessionRead } from "../../../apps/api/src/customer-dining-session-read.ts";
import { createInternalBatchCancellationDispatcher } from "../../../tooling/environment/pilot-batch-cancellation-dispatcher.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
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
import { randomBytes } from "node:crypto";
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
              const result = await work({
                query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
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
      // Payment requested at the seal; the customer's card is declined two minutes later.
      await seedJourneyPayment(admin, {
        scope,
        providerAccountReference: provider,
        round: R2,
        refs: { ...pay2, commitment: sealed2.commitmentReference },
        outcome: "Failed",
        requestedAt: sealed2.paymentRequestedAt,
        occurredAt: new Date(Date.parse(sealed2.paymentRequestedAt) + minutes(2)).toISOString(),
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

      // ── 2b. After the payment window the System records the failed payment and cancels round 2
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
      const expiries = await one(
        "SELECT order_batch_id::text AS batch,status FROM rms_ordering.order_batch_checkout_expiry WHERE order_id=$1",
        [orderReference],
      );
      assert.deepEqual(expiries, [
        { batch: R2.batch.orderBatchReference, status: "PaymentFailed" },
      ]);
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
        },
      );
      assert.equal(await cancellation.runOnce(), 1);
      const cancelled = await one(
        "SELECT order_batch_id::text AS batch,cancelled_order_version AS version FROM rms_ordering.order_batch_checkout_cancellation WHERE order_id=$1",
        [orderReference],
      );
      assert.deepEqual(cancelled, [{ batch: R2.batch.orderBatchReference, version: 4 }]);
      assert.equal(await stockReserved(stock.accountReference), reservedBefore);
      // Another scan finds nothing more to cancel.
      assert.equal(await cancellation.runOnce(), 0);

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
      assert.deepEqual(
        status.sources.unpaidCancellations?.map((e) => e.orderBatchReference),
        [R2.batch.orderBatchReference],
      );
      // Round 2 is not charged and never reaches the kitchen; the customer screen's total (the PWA
      // parser and its unpaid-round rule) counts round 1 only.
      assert.deepEqual(status.sources.batchPayments, [
        { orderBatchReference: R2.batch.orderBatchReference, status: "Failed", cancelsAt: null },
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
      });
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
      assert.deepEqual(
        queuedOrder.batches.map((b) => [b.orderBatchReference, b.acceptanceStatus, b.paymentDue]),
        [
          [R1.batch.orderBatchReference, "Accepted", null],
          [R2.batch.orderBatchReference, "Cancelled", null],
        ],
      );
      assert.equal(queuedOrder.awaitingPayment, false);
      // The detail lists every line; the merchant screen's rule takes the unpaid round off the total.
      const unpaidRounds = unpaidCancelledBatches(queued);
      assert.deepEqual([...unpaidRounds], [R2.batch.orderBatchReference]);
      assert.deepEqual(unpaidCancelledTotal(queued.lines, unpaidRounds), {
        cancelled: { amountMinor: String(roundTotal), currencyCode: "CAD" },
        remaining: { amountMinor: String(roundTotal), currencyCode: "CAD" },
      });

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
      const heldUntil3 = R3.f.request.checkoutValidationEvidence.fulfillment.validUntil;
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
      assert.deepEqual(afterRefund.summary, {
        paid: { amountMinor: 2n * roundTotal, currencyCode: "CAD" },
        refunded: { amountMinor: roundTotal, currencyCode: "CAD" },
        refundPending: { amountMinor: 0n, currencyCode: "CAD" },
        due: { amountMinor: 0n, currencyCode: "CAD" },
      });
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
