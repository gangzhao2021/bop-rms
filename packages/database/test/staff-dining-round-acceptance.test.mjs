import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createDiningGuestBindingQuery,
  createPostgresDiningCheckoutCommitmentStore,
  createPostgresDiningGuestBindingStore,
} from "../../rms/dining/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createPostgresReceiptOrderSource,
  createOrderNumberAllocation,
  createPostgresAdditionalDiningExecutionReader,
  createPostgresOrderBatchIdentitySource,
  createPostgresOrderSubmittedConsumer,
  createPostgresStaffDiningRoundEntryStore,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import {
  createCardMachinePaymentEnvelope,
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundApprovalQueueRuntime,
  createPostgresPaymentReceiptCoverageSource,
  createPostgresStoreSalesPaymentLedger,
} from "../../rms/payment/src/index.ts";
import {
  createIdentityActor,
  generateHotp,
  totpTimeStep,
  verifyTotp,
} from "../../bop/identity/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createMerchantWorkforcePermissionSource } from "../../../apps/api/src/merchant-workforce-authority-source.ts";
import { createMerchantMfaStepUp } from "../../../apps/api/src/merchant-mfa-step-up.ts";
import { kdsOperatorProfileAllows } from "../../../apps/api/src/merchant-kds-operator-profile.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import { createMerchantOrdinaryRefundApproval } from "../../../apps/api/src/merchant-ordinary-refund-approval.ts";
import { createMerchantOrdinaryRefundItems } from "../../../apps/api/src/merchant-ordinary-refund-items.ts";
import { createMerchantOrdinaryRefundStatus } from "../../../apps/api/src/merchant-ordinary-refund-status.ts";
import { createMerchantRefundPaymentContext } from "../../../apps/api/src/merchant-refund-payment-context.ts";
import { createMerchantCardMachineOrdinaryRefund } from "../../../apps/api/src/merchant-card-machine-ordinary-refund.ts";
import { hasDigitalReceipt } from "../../../apps/api/src/refund-receipt-issuance.ts";
import { createInternalRefundWorkforceContext } from "../../../tooling/environment/pilot-refund-workforce.mjs";
import { standardRefundRoleMapping } from "../../../tooling/environment/pilot-refund-role-mapping.mjs";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createCustomerAdditionalDiningPaymentAdmission } from "../../../apps/api/src/customer-additional-dining-payment-store.ts";
import { createCustomerDiningSessionRead } from "../../../apps/api/src/customer-dining-session-read.ts";
import {
  createMerchantCardMachinePayment,
  withPaidBatchAcceptance,
} from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { createMerchantOrderAcceptanceCommand } from "../../../apps/api/src/merchant-order-acceptance-command.ts";
import { createMerchantAcceptanceConfigurationResolver } from "../../../apps/api/src/merchant-acceptance-configuration-resolver.ts";
import { createOriginalReceiptIssuance } from "../../../apps/api/src/original-receipt-issuance.ts";
import { createAdditionalReceiptIssuance } from "../../../apps/api/src/additional-receipt-issuance.ts";
import { createInternalAdditionalReceiptConsumer } from "../../../tooling/environment/pilot-additional-receipt-consumer.mjs";
import { exerciseReceiptTemplate } from "../test-support/receipt-template.mjs";
import { assertLateRoundBusinessDate } from "../test-support/round-business-date-assertions.mjs";
import { createMerchantStaffDiningRound } from "../../../apps/api/src/merchant-staff-dining-round.ts";
import { readStaffDiningRoundPaymentPreparation } from "../../../apps/api/src/staff-dining-round-payment-preparation.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { kitchenPreparation } from "../../../apps/api/src/merchant-kitchen-query.ts";
import { createOrderCapturedPaymentSource } from "../../../apps/api/src/order-captured-payment-source.ts";
import { createAdditionalOrderPaidContextSource } from "../../../apps/api/src/additional-order-paid-context-source.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import {
  journeyRound,
  seedJourneyAcceptance,
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
  seedJourneyStorePublication,
} from "../test-support/dine-in-journey-seed.mjs";

// WP-2423 item 4: only the merchant session lookup of the refund staff (manager, owner) is a test
// double, as in the dine-in journey; every other cookie (the real encrypted staff sessions) goes to
// the real scope resolution.
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
let references = 0xa000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND). A table whose first round a guest paid online gets a
 * second round entered by staff for guests who don't use a phone. The round is submitted by the
 * staff command's table guest through the actual Ordering additional-round writer (Dining gate and
 * seal, Inventory reservation), exactly as a guest's round. Then, under the restricted
 * NOBYPASSRLS API role holding the rendered pilot grants (matrix plus approved additions) and real
 * merchant sessions (membership, role, permission grants, encrypted session): the Ordering staff
 * record (audit, replay, conflict, append-only, other Store), the staff command's permission
 * refusal, the order queue and table view before payment (awaiting card-machine payment, never
 * cancelled automatically), the card-machine payment of the round through the dine-in additional
 * payment admission (wrong amount, other Store, missing permission refused), the paid round as
 * Ordering's payment consumer reads it, and the "Entered by staff" marks on the order queue, the
 * kitchen and the guests' table view.
 *
 * Not covered here: the customer cart, sold-out, quote and checkout steps the command drives (the
 * same owner ports the customer acceptance tests run; their use by the command is unit-tested),
 * and the acceptance-to-kitchen-ticket step after payment (unchanged code behind the paid context
 * checked here, accepted in the dine-in journey and additional-round acceptance tests).
 */
it("enters a dine-in round by staff, takes its card-machine payment and marks it on every screen", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_round" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_sr_" + context.runId,
      worker = "wp2423_sr_w_" + context.runId;
    assert.match(api, /^wp2423_sr_[a-f0-9]+$/u);
    vi.stubEnv("NODE_ENV", "development");
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

      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const R1 = journeyRound({ at: time(-minutes(40)), prefix: "01a00001" });
      // The staff command's table guest submits round 2 (its own Guest session at the table).
      const staffGuest = id(0x602);
      const R2 = journeyRound({ at: time(-minutes(5)), prefix: "01a00002", submitter: staffGuest });
      const scope = R1.f.scope;
      const tenant = scope.brandReference.slice(0, 24) + "000000000900";
      const ownerScope = { tenantReference: tenant, ...scope };
      const orderReference = R1.f.request.record.order.orderReference;
      const guestSession = R1.f.request.record.guestSessionReference;
      const provider = id(1);
      const paymentScope = { ...scope, providerAccountReference: provider, environment: "Test" };

      /** One restricted-role transaction on its own connection (the pilot API's grants). */
      const transactions = ({ guc = false } = {}) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
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
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      });
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

      // ── The table: Host H (the fixture guest) and the staff command's table guest S.
      const dining = await seedJourneyDining({
        client: admin,
        scope: ownerScope,
        round: R1,
        startedAt: time(-minutes(50)),
        guestParticipant: id(0x601),
      });
      const host = await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: {
          ...dining,
          participant: dining.host,
          link: { paymentOperationReference: id(0x100) },
        },
        at: time(-minutes(45)),
      });
      await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: { ...dining, participant: dining.guest },
        at: time(-minutes(44)),
        second: { idPrefix: "01909993-0000-7000-8000-", sessionReference: staffGuest },
      });
      const stock = await seedSubmissionInventoryStock({
        admin,
        runner: ownerRunner,
        ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
      });
      await seedSubmissionInventoryRecipe({
        admin,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
        cart: R2.f.cart,
        stock,
      });
      const inventoryWorkflow = await seedSubmissionInventoryWorkflow({
        runner: ownerRunner,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
        orderType: "DineIn",
      });

      // ── Round 1: a guest's round, paid online and accepted (owner-seeded history).
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
      const refs = (n) => ({
        paymentIntent: id(n + 1),
        attempt: id(n + 2),
        observation: id(n + 3),
        webhook: id(n + 4),
        transaction: id(n + 5),
        paymentEvent: id(n + 6),
        projection: id(n + 7),
        preparation: id(n + 8),
        commitment: id(n + 9),
        paymentOperation: id(n + 10),
        providerIntent: "pi_SYNTHETICSTAFF" + n.toString(16),
        providerEvent: "evt_SYNTHETICSTAFF" + n.toString(16),
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
      const pay1 = refs(0x1000);
      await seedJourneyPayment(admin, {
        scope,
        providerAccountReference: provider,
        round: R1,
        refs: pay1,
        outcome: "Succeeded",
        requestedAt: time(-minutes(39)),
        occurredAt: time(-minutes(38)),
        totalMinor: roundTotal,
      });
      await seedJourneyAcceptance(admin, {
        scope,
        round: R1,
        items: items1,
        refs: pay1,
        staff: id(3),
        version: 1,
        previousRevision: r1.submissionReference,
        acceptedAt: time(-minutes(37)),
        kitchenAt: time(-minutes(36)),
      });

      // ── Staff sessions: front of house with staff ordering and the table operation, one
      // without staff ordering, and one at another Store of the Brand (real authorization).
      const frontOfHouse = id(0x700);
      const staffSession = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: ownerScope,
        actor: frontOfHouse,
        at: now(),
        extraPermissions: ["ordering.order.create_staff", "dining.operate", "kitchen.operate"],
      });
      const noOrdering = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: ownerScope,
        actor: id(0x701),
        at: now(),
        extraPermissions: ["dining.operate"],
        referencePrefix: "01909966",
        sessionReferencePrefix: "01909965",
      });
      const otherStore = { ...ownerScope, storeReference: id(0x7ff) };
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_OTHER_STORE','Synthetic Other Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [otherStore.storeReference, scope.brandReference, time(-minutes(60))],
      );
      const elsewhere = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: otherStore,
        actor: id(0x702),
        at: now(),
        extraPermissions: ["ordering.order.create_staff", "dining.operate"],
        referencePrefix: "01909964",
        sessionReferencePrefix: "01909963",
      });

      // The staff command refuses a member without staff ordering before touching the table.
      const pipelineTouched = [];
      const untouchable = new Proxy(
        {},
        {
          get: (_target, name) => async () => {
            pipelineTouched.push(String(name));
            throw new Error("the table must not be touched");
          },
        },
      );
      const staffCommand = (session) =>
        createMerchantStaffDiningRound({
          persistence: { ...session.persistence, now },
          authentication: session.authentication,
          pipeline: untouchable,
          nextReference: fresh,
        })({
          sessionCookie: session.sessionCookie,
          csrf: session.csrf,
          command: {
            operationReference: fresh(),
            tableReference: dining.table.tableReference,
            lines: [
              { sellableReference: id(0x900), quantity: 1, optionSelections: [], note: null },
            ],
            tip: { kind: "None" },
            recordedAfterOutage: false,
          },
        });
      await assert.rejects(staffCommand(noOrdering), { code: "STAFF_ROUND_PERMISSION_DENIED" });
      assert.deepEqual(pipelineTouched, []);

      // ── Round 2: the staff command's table guest S submits the table Cart through the actual
      // Ordering writer, on a Dining commitment S prepared (any seated participant may).
      await seedSubmissionCart(admin, R2.f);
      const pay2 = refs(0x2000);
      const link2 = await dining.prepare(R2, {
        paymentOperationReference: pay2.paymentOperation,
        participant: dining.guest,
      });
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
      const snapshot2 = parseAdditionalDiningBatchSnapshot({
        orderReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningSessionReference: dining.session.diningSessionReference,
        guestSessionReference: staffGuest,
        originalOrderCreatedAt: r1.createdAt,
        expectedOrderVersion: 2,
        batchSequence: 2,
        snapshotVersion: 1,
        batch: R2.batch,
        items: items2,
      });
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: snapshot2,
        prefix: "01a10002",
      });
      let submittedEvent = null;
      const submitted = await transactions().run((tx) =>
        createCustomerAdditionalDiningSubmissionStore({
          ...scope,
          authorize: async (_tx, candidate) =>
            [guestSession, staffGuest].includes(candidate.guestSessionReference),
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
          eventReference: () => {
            submittedEvent = fresh();
            return submittedEvent;
          },
          // Test-only stand-ins as in the dine-in journey: no policies required and the
          // Identity/CSRF recheck not composed. Dining gate, Inventory and the seal are real.
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
            workflow: {
              ...inventoryWorkflow,
              gates: {
                ...inventoryWorkflow.gates,
                authorizeResource: async (innerTx, request) =>
                  inventoryWorkflow.gates.authorizeResource(innerTx, {
                    ...request,
                    actorReference:
                      request.actorReference === staffGuest ? guestSession : request.actorReference,
                  }),
              },
            },
            authorize: async (_tx, input) =>
              [guestSession, staffGuest].includes(input.actorReference),
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
        }).append({
          // The writer's transaction clock at the round's own instant (test-only clock injection).
          transaction: {
            query: (sql, values) =>
              sql === "SELECT clock_timestamp() AS observed_at"
                ? Promise.resolve({
                    rows: [{ observed_at: new Date(Date.parse(R2.batch.submittedAt) + 1000) }],
                    rowCount: 1,
                  })
                : tx.query(sql, values),
          },
          snapshot: snapshot2,
          capacityLink: link2,
          checkoutValidationEvidence: evidence2,
        }),
      );
      assert.equal(submitted.status, "Created");
      // The order-status projection takes the round (the pilot worker's consumer and ports).
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
      assert.deepEqual(
        await transactions({ guc: true }).run(async (tx) =>
          orderStatusConsumer.consume(tx, await loadOutboxEnvelope(tx, submittedEvent)),
        ),
        { status: "processed" },
      );
      const sealed = await createPostgresDiningCheckoutCommitmentStore(ownerRunner(), ownerScope, {
        now,
      }).loadSubmission(R2.batch.submissionReference);
      assert.equal(sealed.state, "PaymentPending");
      // The tip choice staff keyed with the round (Payment's record, as the tip step writes it).
      const tipSelection = id(0x2201);
      const tipMinor = 150n;
      await admin.query(
        "INSERT INTO rms_payment.payment_tip_selection (selection_id,brand_id,store_id,payment_operation_id,submission_id,cart_id,cart_version,quote_id,guest_session_id,tip_minor,currency_code,selected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD',$11)",
        [
          tipSelection,
          scope.brandReference,
          scope.storeReference,
          sealed.paymentOperationReference,
          R2.batch.submissionReference,
          R2.batch.sourceCartReference,
          R2.batch.sourceCartVersion,
          R2.batch.quoteReference,
          staffGuest,
          tipMinor,
          R2.batch.submittedAt,
        ],
      );

      // ── The Ordering staff record: who entered the round, for which table and session.
      const entries = (selected = ownerScope) =>
        createPostgresStaffDiningRoundEntryStore({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
          authorize: async () => true,
        });
      const operation = id(0x2301),
        auditReference = id(0x2302);
      const entry = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        operationReference: operation,
        intentHash: "sha256:" + "a".repeat(64),
        actorReference: frontOfHouse,
        tableReference: dining.table.tableReference,
        diningSessionReference: dining.session.diningSessionReference,
        guestSessionReference: staffGuest,
        tipSelectionReference: tipSelection,
        recordedAfterOutage: false,
        createdAt: R2.batch.submittedAt,
        auditReference,
      };
      const recorded = await transactions().run((tx) => entries().record(tx, entry));
      assert.equal(recorded.status, "Created");
      assert.equal(
        (await transactions().run((tx) => entries().record(tx, entry))).status,
        "AlreadyRecorded",
      );
      await assert.rejects(
        transactions().run((tx) =>
          entries().record(tx, { ...entry, intentHash: "sha256:" + "b".repeat(64) }),
        ),
        { code: "STAFF_DINING_ROUND_IDEMPOTENCY_CONFLICT" },
      );
      assert.deepEqual(
        await one(
          "SELECT action_code,target_type,target_id::text,reason_code,actor_type,actor_reference::text AS actor FROM platform_audit.audit_record WHERE audit_id=$1",
          [auditReference],
        ),
        [
          {
            action_code: "ORDERING_STAFF_DINING_ROUND_STARTED",
            target_type: "DiningSession",
            target_id: dining.session.diningSessionReference,
            reason_code: "STAFF_DINING_ROUND",
            actor_type: "User",
            actor: frontOfHouse,
          },
        ],
      );
      await assert.rejects(
        admin.query("UPDATE rms_ordering.staff_dining_round_entry SET recorded_after_outage=true"),
        /append-only/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_ordering.staff_dining_round_entry"),
        /append-only/u,
      );
      const batch = await transactions().run((tx) => entries().loadBatch(tx, staffGuest));
      assert.equal(String(batch.orderBatchReference), R2.batch.orderBatchReference);
      assert.equal(String(batch.submissionReference), R2.batch.submissionReference);
      // Another Store of the Brand sees nothing of it (row-level security on the Store scope).
      assert.equal(
        await transactions().run((tx) => entries(otherStore).loadByOperation(tx, operation)),
        null,
      );
      assert.equal(
        (await transactions().run((tx) => entries(otherStore).listByOrders(tx, [orderReference])))
          .size,
        0,
      );

      // ── What staff charge: the round's quote total plus the tip, from owner records only.
      const prepared = await transactions().run((tx) =>
        readStaffDiningRoundPaymentPreparation(
          tx,
          { scope: ownerScope, now, nextPreparationReference: fresh, authorize: async () => true },
          {
            submissionReference: R2.batch.submissionReference,
            guestSessionReference: staffGuest,
            tipSelectionReference: tipSelection,
          },
        ),
      );
      const round2Total = items2.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
      assert.equal(prepared.additional, true);
      assert.equal(prepared.preparation.orderAllocation.amountMinor, round2Total);
      assert.equal(prepared.preparation.tip.amountMinor, tipMinor);
      assert.equal(prepared.preparation.total.amountMinor, round2Total + tipMinor);
      assert.equal(prepared.paymentOperationReference, sealed.paymentOperationReference);

      // ── Before payment: the order queue and the table read it as entered by staff and awaiting
      // payment, never as a failed payment. WP-2423 item 5: no payment was started for it, so staff
      // are told when it is cancelled if nobody records the card-machine payment.
      const queue = createPersistentMerchantOrderQueue({
        persistence: { ...staffSession.persistence, now },
        quoteVersion: 1,
        acceptanceConfigured: true,
      });
      const queued = async () =>
        (
          await queue({
            sessionCookie: staffSession.sessionCookie,
            afterOrderReference: null,
            orderReference,
          })
        ).items[0];
      const before = await queued();
      assert.deepEqual(
        before.batches.map((b) => [b.sequence, b.staffRound, b.paymentDue]),
        [
          [1, null, null],
          [
            2,
            // D5: Orders shows what to charge, so the payment can be recorded from there.
            {
              recordedAfterOutage: false,
              paidOnCardMachine: null,
              amountDueMinor: String(round2Total + tipMinor),
            },
            { status: "Awaiting", cancelsAt: before.batches[1]?.paymentDue?.cancelsAt },
          ],
        ],
      );
      // The Orders list polled by every tablet leaves the amount out (the order's own read above
      // builds it, from five owners' records, when staff open the payment form).
      const listedRound = (
        await queue({ sessionCookie: staffSession.sessionCookie, afterOrderReference: null })
      ).items
        .find((item) => item.orderReference === orderReference)
        ?.batches.find((b) => b.sequence === 2);
      assert.deepEqual(listedRound?.staffRound, {
        recordedAfterOutage: false,
        paidOnCardMachine: null,
        amountDueMinor: null,
      });
      assert.match(String(before.batches[1]?.paymentDue?.cancelsAt), /^\d{4}-\d\d-\d\dT.*Z$/u);
      assert.ok(Date.parse(before.batches[1].paymentDue.cancelsAt) > Date.parse(now()));
      const tableRead = createCustomerDiningSessionRead({
        scope,
        transactions: transactions(),
        credentials: host.identity.session.credentials,
        diningScope: ownerScope,
        paymentScope,
        itemRefundScope: {
          tenantReference: tenant,
          providerAccountReference: provider,
          environment: "Test",
        },
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
      const table = () =>
        tableRead.read({
          sessionCredential: host.sessionCredential,
          csrfCredential: host.csrfCredential,
        });
      const rounds = (view) =>
        view.rounds.map((round) => [
          round.roundNumber,
          round.orderedBy,
          round.status,
          round.payment,
        ]);
      assert.deepEqual(rounds(await table()), [
        [1, "You", "Queued", "Paid"],
        [2, "Staff", "AwaitingPayment", "Awaiting"],
      ]);

      // ── The card-machine payment of the round (dine-in later-round payment admission).
      const admission = ({ scope: selected, preparation, allowed, kind }) => {
        assert.equal(kind, "DiningAdditional");
        const authorize = async (_tx, value) =>
          value.submissionReference === String(preparation.submissionReference) &&
          value.actorReference === String(preparation.guestSessionReference) &&
          (await allowed());
        return createCustomerAdditionalDiningPaymentAdmission({
          scope: selected,
          quoteVersion: 1,
          authorizeHistory: async (tx, value) =>
            value.submissionReference === String(preparation.submissionReference) &&
            (await authorize(tx, {
              submissionReference: value.submissionReference,
              actorReference: String(preparation.guestSessionReference),
            })),
          inventory: {
            workflow: inventoryWorkflow.payment,
            authorize,
            authorizeOverride: async () => false,
            resolveExpiryCutoff: stock.resolveExpiryCutoff,
          },
        });
      };
      const cardPayment = (session) =>
        createMerchantCardMachinePayment({
          persistence: { ...session.persistence, now },
          authentication: session.authentication,
          admission,
          environment: "Test",
          nextReference: fresh,
        });
      const payInput = (session, overrides = {}) => ({
        sessionCookie: session.sessionCookie,
        csrf: session.csrf,
        command: {
          operationReference: id(0x2401),
          orderReference,
          orderBatchReference: R2.batch.orderBatchReference,
          expectedTotalMinor: String(round2Total + tipMinor),
          slipReference: "AUTH 771204",
          takenAt: null,
          ...overrides,
        },
      });
      const counts = async () =>
        (
          await one(
            "SELECT (SELECT count(*)::int FROM rms_payment.card_machine_payment) AS payments,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='PaymentSucceeded') AS events",
          )
        )[0];
      const start = await counts();
      await assert.rejects(
        cardPayment(staffSession)(payInput(staffSession, { expectedTotalMinor: "1" })),
        {
          code: "CARD_MACHINE_AMOUNT_CHANGED",
          totalMinor: String(round2Total + tipMinor),
        },
      );
      await assert.rejects(cardPayment(noOrdering)(payInput(noOrdering)), {
        code: "CARD_MACHINE_PERMISSION_DENIED",
      });
      await assert.rejects(cardPayment(elsewhere)(payInput(elsewhere)), {
        code: "CARD_MACHINE_NOT_FOUND",
      });
      assert.deepEqual(await counts(), start);
      const paid = await cardPayment(staffSession)(payInput(staffSession));
      assert.equal(paid.status, "Recorded");
      assert.equal(paid.amountMinor, String(round2Total + tipMinor));
      assert.equal(paid.recordingReason, "AtCounter");
      assert.deepEqual(await counts(), {
        payments: start.payments + 1,
        events: start.events + 1,
      });
      assert.equal(
        (await cardPayment(staffSession)(payInput(staffSession))).status,
        "AlreadyRecorded",
      );
      await assert.rejects(
        cardPayment(staffSession)(payInput(staffSession, { operationReference: id(0x2402) })),
        { code: "CARD_MACHINE_ALREADY_PAID" },
      );

      // Ordering's payment consumer reads the round as a paid later round of the table Order.
      const saved = await transactions().run((tx) =>
        createPostgresCardMachinePaymentStore({
          scope: ownerScope,
          authorize: async () => true,
        }).loadByOperation(tx, id(0x2401)),
      );
      const event = await transactions().run(
        async (tx) =>
          (
            await createOrderCapturedPaymentSource({
              scope: paymentScope,
              now,
              authorize: async () => true,
            }).resolve(tx, createCardMachinePaymentEnvelope(saved))
          ).terminal.event,
      );
      assert.equal(event.eventType, "PaymentSucceeded");
      const paidContext = await transactions().run((tx) =>
        createAdditionalOrderPaidContextSource({
          scope: paymentScope,
          tenantReference: tenant,
          quoteVersion: 1,
          now,
          authorize: async () => true,
          authorizeOrder: async (_tx, request) =>
            request.submissionReference === R2.batch.submissionReference,
          authorizeInventory: async (_tx, input) => input.actorReference === staffGuest,
        }).resolve(tx, event),
      );
      assert.equal(
        String(paidContext.execution.snapshot.batch.orderBatchReference),
        R2.batch.orderBatchReference,
      );
      assert.equal(paidContext.execution.batchPhase, "Submitted");
      assert.equal(paidContext.payment.intent.paymentMethod, "StoreCardMachine");

      // ── After payment: "Entered by staff" and the card-machine payment on every screen.
      const after = await queued();
      assert.deepEqual(after.batches[1].staffRound, {
        recordedAfterOutage: false,
        amountDueMinor: null,
        paidOnCardMachine: {
          amountMinor: String(round2Total + tipMinor),
          takenAt: String(saved.takenAt),
        },
      });
      const view = await table();
      assert.deepEqual(rounds(view)[1].slice(0, 2), [2, "Staff"]);
      assert.equal(view.rounds[1].payment, "Paid");
      assert.equal(view.summary.paid.amountMinor, roundTotal + round2Total + tipMinor);
      const kitchen = await transactions().run((tx) =>
        kitchenPreparation(tx, scope, [
          {
            workItemReference: pay1.workItems[0],
            orderReference,
            orderBatchReference: R1.batch.orderBatchReference,
          },
          {
            workItemReference: id(0x2501),
            orderReference,
            orderBatchReference: R2.batch.orderBatchReference,
          },
        ]),
      );
      assert.equal(kitchen.get(pay1.workItems[0]).orderLabel.enteredByStaff, false);
      assert.equal(kitchen.get(id(0x2501)).orderLabel.enteredByStaff, true);
      assert.equal(kitchen.get(id(0x2501)).orderLabel.orderType, "DineIn");

      // WP-2423 D4: the staff round is its own business day's work. The Order opened with round 1;
      // a business day that started between the two rounds (the table left open overnight) lists
      // the Order with that day's orders, and the Tables page finds the session's one Order.
      const opened = (
        await one(
          "SELECT business_date::text AS day FROM rms_ordering.order_header WHERE order_id=$1",
          [orderReference],
        )
      )[0].day;
      const nextDay = new Date(Date.parse(opened + "T12:00:00Z") + 86_400_000)
        .toISOString()
        .slice(0, 10);
      await transactions({ guc: true }).run((tx) =>
        assertLateRoundBusinessDate(tx, scope, {
          orderReference,
          initialBatchReference: R1.batch.orderBatchReference,
          laterBatchReference: R2.batch.orderBatchReference,
          openedBusinessDate: opened,
          todayStartsAt: new Date(
            (Date.parse(r1.createdAt) + Date.parse(R2.batch.submittedAt)) / 2,
          ).toISOString(),
          todayBusinessDate: nextDay,
          diningSessionReference: dining.session.diningSessionReference,
        }),
      );

      await exerciseServerSideAcceptance({
        one,
        scope,
        orderReference,
        R2,
        paymentScope,
        tenant,
        staffSession,
        frontOfHouse,
        inventoryWorkflow,
        staffGuest,
        queued,
        record: cardPayment(staffSession),
        payInput: payInput(staffSession),
      });

      await exerciseCardMachinePartialRefund({
        admin,
        one,
        transactions,
        tenant,
        scope,
        ownerScope,
        provider,
        orderReference,
        rounds: { R1, R2, items1, items2, roundTotal, round2Total, tipMinor },
        saved,
        staffSession,
        elsewhere,
        time,
      });

      await exerciseCardMachineRoundReceipt({
        admin,
        context,
        // The pilot's business consumers run on the API role's grants (consumer inbox included).
        worker: api,
        tenant,
        scope,
        ownerScope,
        provider,
        orderReference,
        items1,
        items2,
        saved,
        paid1At: time(-minutes(38)),
        onlineIntent: pay1.paymentIntent,
        time,
      });
    } finally {
      vi.unstubAllEnvs();
      signedIn.cookies = new Set();
      signedIn.scopeFor = null;
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

/**
 * WP-2423 item 4 (DEC-COUNTER-PAYMENT-RECORD, partial refunds): the round staff entered and that
 * was paid on the Store's card machine is refunded by item, with the same rules as an online
 * refund, under the restricted API role and real Payment/Ordering/Pricing owners. A manager refunds
 * one unit (no approval needed: same business day, under CAD 100, within 24 hours): the request is
 * allocated from the original quote (tax and tip share), never prepared or sent to a Provider, and
 * recorded once made on the machine (slip reference, never a card number; replay, refusal of a
 * second record, of staff who don't handle refunds and of another Store). After the business day
 * changes the rest of the round needs the owner's approval (both people re-verify): recording the
 * machine refund before it is refused; the approval sends nothing and asks staff to record it;
 * then the cumulative refund equals what the machine took and nothing more can be requested. The
 * payment page, request status, approval list, receipt coverage, day-end settlement and the sales
 * ledger (by item with tax) all count the machine refunds on the day they were made.
 */
async function exerciseCardMachinePartialRefund({
  admin,
  one,
  transactions,
  tenant,
  scope,
  ownerScope,
  provider,
  orderReference,
  rounds: { R1, R2, items1, items2, roundTotal, round2Total, tipMinor },
  saved,
  staffSession,
  elsewhere,
  time,
}) {
  const id = (n) => "01a3ff00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  let n = 0xa000;
  const fresh = () =>
    Date.now()
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/u, "$1-$2") +
    "-7000-8000-" +
    (n++).toString(16).padStart(12, "0");
  const now = () => new Date().toISOString();
  const minutes = (m) => m * 60_000;
  const from = time(-minutes(240)),
    until = new Date(Date.now() + minutes(600)).toISOString();
  const [manager, owner] = [id(0x801), id(0x802)];
  const brandFact = createBrand({
    brandReference: scope.brandReference,
    code: "SYNTHETIC_STAFF_ROUND",
    displayName: "Synthetic Brand",
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
    code: "SYNTHETIC_STAFF_ROUND",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: from,
    updatedAt: from,
  });
  // The catalog's store manager and owner roles (the pilot's refund role mapping).
  const roleSets = {
    manager: {
      id: id(0x810),
      code: "store_manager",
      actions: ["merchant.access", "payment.refund.request", "payment.refund.execute"],
    },
    owner: {
      id: id(0x811),
      code: "store_owner",
      actions: ["merchant.access", "payment.refund.approve", "payment.refund.execute"],
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
    const m = 0x900 + i * 0x10;
    await admin.query(
      "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [id(m), actor, scope.brandReference, id(m + 1), from, until],
    );
    await admin.query(
      "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(m + 2), id(m), actor, scope.brandReference, scope.storeReference, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
      [
        id(m + 3),
        held.id,
        id(m),
        id(m + 2),
        actor,
        scope.brandReference,
        scope.storeReference,
        from,
        until,
      ],
    );
    await admin.query(
      "INSERT INTO bop_identity.workforce_mfa_status (actor_id,status,provider_evidence_id,verified_at,reset_at,version) VALUES ($1,'TotpVerified',$2,$3,NULL,1)",
      [actor, id(m + 6), time(-minutes(120))],
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
      kdsOperatorProfileAllows: (requested) =>
        kdsOperatorProfileAllows({ policy: { code: "WorkforceStandard" } }, requested),
      allowed: async () => (await decide(action))?.effect === "Allow",
      authorizeAction: decide,
    };
  };
  const session = (who) => ({ sessionCookie: who, csrf: "synthetic-csrf" });

  // Synthetic test-only Store configuration whose business day starts in about a minute: the round
  // was paid on the business day before that start; the first refund is made on the same day.
  const boundaryAt = Math.ceil((Date.now() + 50_000) / 60_000) * 60_000;
  const boundary =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Toronto",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(boundaryAt)) + ":00";
  const { businessDate } = await seedJourneyStorePublication({
    client: admin,
    scope: ownerScope,
    publishedAt: time(-minutes(300)),
    businessDayStart: boundary,
    prefix: "01a30000",
  });

  const persistence = { transactions: transactions(), now };
  const authentication = {
    authorize: async (input) => ({
      sessionReference: id(0xa00 + Object.keys(cookies).indexOf(input.sessionCookie)),
    }),
  };
  const refundConfiguration = async () => ({
    providerAccountReference: provider,
    environment: "Test",
    roleMapping: standardRefundRoleMapping,
  });
  const workforceFor = (actorReference, sessionContext, current) => ({
    resolveContext: createInternalRefundWorkforceContext({
      expected: ownerScope,
      persistence: { currentActor },
      sessionActorReference: actorReference,
      sessionContext,
      current,
    }),
    resolveRoleMapping: async () => standardRefundRoleMapping,
    stepUp: true,
  });
  const request = createMerchantOrdinaryRefundRequest({
    persistence,
    authentication,
    resolveConfiguration: refundConfiguration,
    newAuditReference: fresh,
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
    businessDate,
  });
  const refundItems = createMerchantOrdinaryRefundItems({
    persistence,
    authentication,
    resolveConfiguration: refundConfiguration,
    newReference: fresh,
    locale: "en-CA",
  });
  const status = createMerchantOrdinaryRefundStatus({
    persistence,
    authentication,
    resolveConfiguration: refundConfiguration,
  });
  const paymentPage = createMerchantRefundPaymentContext({
    persistence,
    authentication,
    resolveConfiguration: refundConfiguration,
  });
  const providerCalls = [];
  const approve = createMerchantOrdinaryRefundApproval({
    persistence,
    authentication,
    resolveConfiguration: async (_tx, selected, authority) => ({
      providerAccountReference: provider,
      environment: "Test",
      businessDate,
      workforce: workforceFor(
        selected.actorReference,
        async () => authority.context,
        async () => authority.authorize(),
      ),
    }),
    // A card-machine refund is never prepared or sent to the payment provider.
    prepare: async () => {
      providerCalls.push("prepare");
      throw new Error("must not prepare");
    },
    send: async () => {
      providerCalls.push("send");
      throw new Error("must not send");
    },
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const receipts = [];
  const machineRefund = (selected = { persistence, authentication }) =>
    createMerchantCardMachineOrdinaryRefund({
      persistence: selected.persistence,
      authentication: selected.authentication,
      resolveConfiguration: refundConfiguration,
      businessDate,
      nextReference: fresh,
      // The pilot's port: a refund version follows only when the Order has a digital receipt.
      issueRefundReceipt: async ({ orderReference: order }) => {
        const has = await transactions().run((tx) =>
          hasDigitalReceipt(tx, { ...scope, orderReference: order, authorize: async () => true }),
        );
        receipts.push(has);
        return has ? "Issued" : "NoDigitalReceipt";
      },
    });
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
  const queue = () =>
    transactions().run((tx) =>
      createPostgresOrdinaryRefundApprovalQueueRuntime({
        scope: ownerScope,
        providerAccountReference: provider,
        environment: "Test",
        authorize: async () => true,
        businessDate,
      })(tx, { observedAt: now() }),
    );
  const captured = round2Total + tipMinor;
  const line = (item, quantity, batch = R2.batch) => ({
    orderBatchReference: batch.orderBatchReference,
    orderItemReference: item.orderItemReference,
    quantity,
  });
  const machineRows = () =>
    one(
      "SELECT source_kind,source_id::text AS source,amount_minor::text AS amount,slip_reference FROM rms_payment.card_machine_refund ORDER BY recorded_at,card_machine_refund_id",
    );
  const providerRows = async (requestReference) =>
    (
      await one(
        "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_operation WHERE request_id=$1)+(SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch WHERE request_id=$1) AS n",
        [requestReference],
      )
    )[0].n;

  // ── The payment page: the round was paid on the card machine; nothing refunded yet.
  const page = await paymentPage({
    ...session("manager"),
    query: { paymentIntentReference: saved.paymentIntentReference },
  });
  assert.deepEqual(
    [
      page.paymentMethod,
      page.paymentState,
      page.capturedAmountMinor,
      page.confirmedRefundMinor,
      page.pendingRefundMinor,
      page.canRequest,
    ],
    ["CardMachine", "Captured", String(captured), "0", "0", true],
  );
  // Another Store of the Brand never reads it (row-level security on the Store scope).
  await assert.rejects(
    createMerchantRefundPaymentContext({
      persistence: { ...elsewhere.persistence, now },
      authentication: elsewhere.authentication,
      resolveConfiguration: refundConfiguration,
    })({
      sessionCookie: elsewhere.sessionCookie,
      csrf: elsewhere.csrf,
      query: { paymentIntentReference: saved.paymentIntentReference },
    }),
  );
  const listed = await refundItems({ ...session("manager"), query: { orderReference } });
  assert.deepEqual(
    [...new Set(listed.items.map((item) => [item.orderBatchReference, item.paymentMethod].join()))],
    [R1.batch.orderBatchReference + ",Online", R2.batch.orderBatchReference + ",CardMachine"],
  );

  // ── Request A: one unit of the round's first item (no approval needed).
  const itemA = items2[0];
  const commandA = {
    orderReference,
    requestReference: fresh(),
    operationReference: fresh(),
    expectedClaimVersion: 0,
    reasonCode: "QUALITY_ISSUE",
    items: [line(itemA, 1)],
  };
  // Items paid online and on the card machine are never refunded in one request.
  await assert.rejects(
    request.preview({
      ...session("manager"),
      command: { ...commandA, items: [line(itemA, 1), line(items1[0], 1, R1.batch)] },
    }),
  );
  const previewA = await request.preview({ ...session("manager"), command: commandA });
  assert.equal(previewA.approvalRequired, false);
  assert.deepEqual(previewA.escalationReasons, []);
  const amountA = BigInt(previewA.amountMinor);
  assert.ok(amountA > 0n && amountA < captured);
  assert.ok(BigInt(previewA.components.taxAmountMinor) > 0n, "the refund carries its tax");
  assert.equal(
    Object.values(previewA.components).reduce((sum, value) => sum + BigInt(value), 0n),
    amountA,
  );
  const recordedA = await request({ ...session("manager"), command: commandA });
  assert.equal(recordedA.status, "Created");
  assert.equal(recordedA.approvalRequired, false);
  const statusA = async () =>
    (
      await status({
        ...session("manager"),
        query: { orderReference, operationReference: commandA.operationReference },
      })
    ).payments;
  assert.deepEqual(
    (await statusA()).map((p) => [
      p.method,
      p.state,
      p.pendingMinor,
      p.executionOperationReference,
    ]),
    [["CardMachine", "NotDispatched", String(amountA), null]],
  );
  const pending = await paymentPage({
    ...session("manager"),
    query: { paymentIntentReference: saved.paymentIntentReference },
  });
  assert.deepEqual(
    [pending.confirmedRefundMinor, pending.pendingRefundMinor],
    ["0", String(amountA)],
  );
  // Recording the machine refund: who handles refunds only, never a card number.
  const recordA = (overrides = {}, who = "manager") => ({
    ...session(who),
    command: {
      operationReference: id(0xb01),
      orderReference,
      requestReference: commandA.requestReference,
      slipReference: "REF 5521",
      refundedAt: null,
      ...overrides,
    },
  });
  await assert.rejects(
    machineRefund({
      persistence: { ...staffSession.persistence, now },
      authentication: staffSession.authentication,
    })({ ...recordA(), sessionCookie: staffSession.sessionCookie, csrf: staffSession.csrf }),
    { code: "CARD_MACHINE_REFUND_PERMISSION_DENIED" },
  );
  await assert.rejects(machineRefund()(recordA({ slipReference: "4111 1111 1111 1111" })), {
    code: "CARD_MACHINE_REFUND_INPUT_INVALID",
  });
  await assert.rejects(
    machineRefund()(recordA({ refundedAt: new Date(Date.now() - minutes(60)).toISOString() })),
    { code: "CARD_MACHINE_REFUND_INPUT_INVALID" },
  );
  assert.deepEqual(await machineRows(), []);
  const madeA = await machineRefund()(recordA());
  assert.deepEqual(
    [madeA.status, madeA.amountMinor, madeA.receipt],
    ["Recorded", String(amountA), "NoDigitalReceipt"],
  );
  assert.equal((await machineRefund()(recordA())).status, "AlreadyRecorded");
  await assert.rejects(machineRefund()(recordA({ operationReference: id(0xb02) })), {
    code: "CARD_MACHINE_REFUND_NOTHING_OWED",
  });
  assert.deepEqual(await machineRows(), [
    {
      source_kind: "OrdinaryRefund",
      source: commandA.requestReference,
      amount: String(amountA),
      slip_reference: "REF 5521",
    },
  ]);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='PAYMENT_CARD_MACHINE_REFUND_RECORDED' AND actor_reference=$1",
        [manager],
      )
    )[0].n,
    1,
  );
  assert.equal(await providerRows(commandA.requestReference), 0);
  assert.deepEqual(
    (await statusA()).map((p) => [p.method, p.state, p.confirmedMinor, p.pendingMinor]),
    [["CardMachine", "Confirmed", String(amountA), "0"]],
  );
  await assert.rejects(
    admin.query("UPDATE rms_payment.card_machine_refund SET slip_reference=NULL"),
    /append-only/u,
  );
  // The receipt coverage counts the machine refund on the card-machine round (a refund version of
  // a dine-in receipt reads it); the online round is unchanged.
  const coverage = await transactions().run((tx) =>
    createPostgresPaymentReceiptCoverageSource({
      scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
      authorize: async () => true,
    }).resolve(tx, {
      orderReference,
      observedAt: now(),
      freshAfter: time(-minutes(60)),
      expectedBatches: [
        { orderBatchReference: R1.batch.orderBatchReference, orderAllocationMinor: roundTotal },
        { orderBatchReference: R2.batch.orderBatchReference, orderAllocationMinor: round2Total },
      ],
    }),
  );
  assert.deepEqual(
    coverage.batches.map((b) => [
      b.orderBatchReference,
      b.captured.amountMinor,
      b.refunded.amountMinor,
      b.pendingRefund.amountMinor,
    ]),
    [
      [R1.batch.orderBatchReference, roundTotal, 0n, 0n],
      [R2.batch.orderBatchReference, captured, amountA, 0n],
    ],
  );
  // The record and its replay both checked for a digital receipt (a replay retries a version that
  // could not be issued); this table's guests have none yet.
  assert.deepEqual(receipts, [false, false]);

  // ── The business day changes: the rest of the round now needs the owner's approval.
  assert.ok(Date.now() < boundaryAt, "request A was made before the business day changed");
  await delay(boundaryAt + 2_000 - Date.now());
  const remaining = items2
    .map((item) => [
      item,
      item.orderItemReference === itemA.orderItemReference ? item.quantity - 1 : item.quantity,
    ])
    .filter(([, quantity]) => quantity > 0);
  const commandB = {
    orderReference,
    requestReference: fresh(),
    operationReference: fresh(),
    expectedClaimVersion: 1,
    reasonCode: "STORE_ERROR",
    items: remaining.map(([item, quantity]) => line(item, quantity)),
  };
  const previewB = await request.preview({ ...session("manager"), command: commandB });
  assert.equal(previewB.approvalRequired, true);
  assert.ok(previewB.escalationReasons.includes("DifferentBusinessDate"));
  // Cumulative: the rest of the round and of its tip, never more than the machine took.
  assert.equal(BigInt(previewB.amountMinor) + amountA, captured);
  assert.equal(
    (
      await stepUp({
        ...session("manager"),
        command: { purpose: "RefundRequest", code: codeFor(manager) },
      })
    ).status,
    "Verified",
  );
  const recordedB = await request({ ...session("manager"), command: commandB });
  assert.equal(recordedB.approvalRequired, true);
  const recordB = (overrides = {}) => ({
    ...session("manager"),
    command: {
      operationReference: id(0xb03),
      orderReference,
      requestReference: commandB.requestReference,
      slipReference: null,
      refundedAt: null,
      ...overrides,
    },
  });
  // Not before the approval.
  await assert.rejects(machineRefund()(recordB()), {
    code: "CARD_MACHINE_REFUND_APPROVAL_REQUIRED",
  });
  const waiting = (await queue()).filter((e) => e.requestReference === commandB.requestReference);
  assert.deepEqual(
    waiting.map((e) => [e.state, e.paymentMethod]),
    [["AwaitingApproval", "CardMachine"]],
  );
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
    requestReference: commandB.requestReference,
    approvalReference: fresh(),
  };
  const approved = await approve({ ...session("owner"), command: approval });
  assert.deepEqual(
    approved.payments.map((p) => p.state),
    ["RecordOnCardMachine"],
  );
  assert.equal((await approve({ ...session("owner"), command: approval })).replayed, true);
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(
    (await queue())
      .filter((e) => e.requestReference === commandB.requestReference)
      .map((e) => [e.state, e.paymentMethod]),
    [["Approved", "CardMachine"]],
  );
  const madeB = await machineRefund()(recordB());
  assert.equal(madeB.status, "Recorded");
  assert.equal(madeB.amountMinor, previewB.amountMinor);
  assert.equal(await providerRows(commandB.requestReference), 0);
  assert.deepEqual(
    (await queue()).filter((e) => e.requestReference === commandB.requestReference),
    [],
  );
  const done = await paymentPage({
    ...session("manager"),
    query: { paymentIntentReference: saved.paymentIntentReference },
  });
  assert.deepEqual([done.confirmedRefundMinor, done.pendingRefundMinor], [String(captured), "0"]);
  // Nothing is left to request on the round.
  await assert.rejects(
    request.preview({
      ...session("manager"),
      command: {
        ...commandA,
        requestReference: fresh(),
        operationReference: fresh(),
        expectedClaimVersion: 2,
      },
    }),
  );

  // ── Day end and reports: both machine refunds, on the business days they were made.
  const cards = createPostgresCardMachinePaymentStore({
    scope: ownerScope,
    authorize: async () => true,
  });
  const day = await transactions().run((tx) =>
    cards.summarize(tx, {
      from: time(-minutes(120)),
      to: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  assert.deepEqual([day.refundCount, day.refundedMinor], [2, captured]);
  const today = await transactions().run((tx) =>
    cards.summarize(tx, {
      from: new Date(boundaryAt).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  assert.deepEqual([today.refundCount, today.refundedMinor], [1, captured - amountA]);
  const ledger = await transactions().run((tx) =>
    createPostgresStoreSalesPaymentLedger({
      scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
      authorize: async () => true,
    })(tx, {
      startsAt: time(-minutes(120)),
      endsAt: new Date(Date.now() + 1_000).toISOString(),
      observedAt: new Date(Date.now() + 2_000).toISOString(),
    }),
  );
  const machine = ledger.refunds.filter((r) => r.channel === "CardMachine");
  assert.equal(machine.length, 2);
  assert.equal(
    machine[0].items.reduce((sum, item) => sum + item.taxMinor, 0n),
    BigInt(previewA.components.taxAmountMinor),
  );
  assert.equal(
    machine.reduce(
      (sum, r) =>
        sum +
        r.items.reduce(
          (total, item) =>
            total + item.netMinor + item.taxMinor + item.tipMinor + item.serviceChargeMinor,
          0n,
        ),
      0n,
    ),
    captured,
  );
}

/**
 * WP-2423 D1: the round paid on the card machine is accepted by the server with its payment
 * record, at the table Order's current version (past 1: round 1 was accepted and round 2 added,
 * while the Order header still reads 1), by the staff member who recorded it and under the restricted API role — the
 * page that sent it plays no part. A stale version from a page is a conflict (409 on the route),
 * never a permission refusal; a retry of the payment record reports the acceptance already made.
 */
async function exerciseServerSideAcceptance({
  one,
  scope,
  orderReference,
  R2,
  paymentScope,
  tenant,
  staffSession,
  frontOfHouse,
  inventoryWorkflow,
  staffGuest,
  queued,
  record,
  payInput,
}) {
  let n = 0xd100;
  const fresh = () =>
    Date.now()
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/u, "$1-$2") +
    "-7000-8000-" +
    (n++).toString(16).padStart(12, "0");
  const now = () => new Date().toISOString();
  const header = await one(
    "SELECT aggregate_version::int AS version FROM rms_ordering.order_header WHERE order_id=$1",
    [orderReference],
  );
  assert.equal(header[0].version, 1);
  const before = await queued();
  // The table Order moved past the header's version with round 1's acceptance and round 2.
  const version = before.currentVersion;
  assert.ok(version > 1);
  assert.equal(before.batches[1].acceptanceStatus, "NotAccepted");
  const accept = createMerchantOrderAcceptanceCommand({
    persistence: { ...staffSession.persistence, now },
    authentication: staffSession.authentication,
    generateAuditReference: fresh,
    audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
    resolveConfiguration: (tx, selected, command) =>
      createMerchantAcceptanceConfigurationResolver({
        now,
        authorize: async (_tx, value) =>
          value.brandReference === scope.brandReference &&
          value.storeReference === scope.storeReference &&
          value.actorReference === frontOfHouse,
        resolvePolicy: async () => ({
          paymentScope,
          additional: {
            quoteVersion: 1,
            acceptance: {
              action: "Accept",
              purposeCode: inventoryWorkflow.payment.purposeCode,
              permissionCode: "order.accept",
            },
            workflowVersionReference: inventoryWorkflow.payment.workflowVersionReference,
            reasonCode: "SYNTHETIC_TEST",
            context: createAdditionalOrderPaidContextSource({
              scope: paymentScope,
              tenantReference: tenant,
              quoteVersion: 1,
              now,
              authorize: async (_tx, event) => event.payload.orderReference === orderReference,
              authorizeOrder: async (_tx, current) =>
                current.submissionReference === R2.batch.submissionReference,
              authorizeInventory: async (_tx, input) => input.actorReference === staffGuest,
            }),
            // As the pilot's gates: the resource is this Order at the version the command names.
            gates: {
              authorizeResource: async (_tx, request) =>
                request.actorReference === frontOfHouse &&
                request.resourceReference === orderReference &&
                request.resourceVersion === command.expectedOrderVersion,
              authorizeAction: async () => true,
              evaluateRule: async () => true,
              authorizeOverride: async () => false,
            },
          },
        }),
      })(tx, selected, command),
  });
  const session = { sessionCookie: staffSession.sessionCookie, csrf: staffSession.csrf };
  const seen = (expectedOrderVersion) => ({
    ...session,
    command: {
      acceptanceReference: fresh(),
      operationReference: fresh(),
      orderReference,
      orderBatchReference: R2.batch.orderBatchReference,
      expectedOrderVersion,
    },
  });
  // The page's version from the Order header (the live defect) is a conflict, not a refusal.
  await assert.rejects(accept(seen(1)), { code: "ORDER_ACCEPTANCE_VERSION_CONFLICT" });
  const acceptances = async () =>
    (
      await one(
        "SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
        [R2.batch.orderBatchReference],
      )
    )[0].n;
  assert.equal(await acceptances(), 0);
  // The payment record (a retry of the same operation) brings the server-side acceptance.
  const paid = withPaidBatchAcceptance(record, { accept, nextReference: fresh });
  const first = await paid(payInput);
  assert.equal(first.status, "AlreadyRecorded");
  assert.equal(first.acceptance, "Accepted");
  assert.equal(await acceptances(), 1);
  assert.deepEqual(
    await one(
      "SELECT expected_order_version::int AS expected,accepted_order_version::int AS accepted,actor_id::text AS actor FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
      [R2.batch.orderBatchReference],
    ),
    [{ expected: version, accepted: version + 1, actor: frontOfHouse }],
  );
  const after = await queued();
  assert.equal(after.currentVersion, version + 1);
  assert.equal(after.batches[1].acceptanceStatus, "Accepted");
  // Replay: reported as accepted, nothing new written.
  assert.equal((await paid(payInput)).acceptance, "Accepted");
  assert.equal(await acceptances(), 1);
  // Someone else accepting it again from a stale page is told it was already accepted.
  await assert.rejects(accept(seen(version)), { code: "ORDER_ACCEPTANCE_ALREADY_ACCEPTED" });
}

/**
 * WP-2423 D2: the pilot's additional-receipt consumer takes the PaymentSucceeded of a later round
 * paid on the Store's card machine (it went to dead letters on v15) and issues the table's receipt
 * covering the online round and the card-machine round, under the restricted pilot API role.
 * Provider observation refresh is a recorded stand-in here (it has no Provider work for a
 * card-machine round; tooling/environment/pilot-receipt-observations.test.mjs covers it).
 */
async function exerciseCardMachineRoundReceipt({
  admin,
  context,
  worker,
  tenant,
  scope,
  ownerScope,
  provider,
  orderReference,
  items1,
  items2,
  saved,
  paid1At,
  onlineIntent,
  time,
}) {
  let n = 0xd200;
  const id = (k) => "01a4ff00-0000-7000-8000-" + k.toString(16).padStart(12, "0");
  const fresh = () =>
    Date.now()
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/u, "$1-$2") +
    "-7000-8000-" +
    (n++).toString(16).padStart(12, "0");
  const now = () => new Date().toISOString();
  const runAs = (role) => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        // The pilot consumer's Store scope (consumer inbox row-level security).
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, scope.brandReference, scope.storeReference],
        );
        const result = await work({
          query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  });
  await admin.query(
    "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic staff round issuer','Synthetic Staff Round Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
    [id(1), id(2), id(3), id(4), id(5), id(6), time(-minutes(300))],
  );
  await admin.query(
    "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
    [id(7), scope.brandReference, scope.storeReference, id(1), time(-minutes(300))],
  );
  const templateRole = "wp2423_sr_t_" + context.runId,
    templateWorker = "wp2423_sr_tw_" + context.runId;
  try {
    for (const name of [templateRole, templateWorker])
      await admin.query(
        "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
    const root = new URL("../../../docs/spec/", import.meta.url);
    const matrices = await Promise.all(
      ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
        JSON.parse(await readFile(new URL(file, root), "utf8")),
      ),
    );
    await admin.query(renderPilotAclSql(matrices, { api: templateRole, worker: templateWorker }));
    const templateSource = await exerciseReceiptTemplate({
      admin,
      runner: runAs(templateRole),
      role: templateRole,
      scope,
      at: time(-minutes(200)),
      tenantReference: tenant,
    });
    const sources = {
      scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
      authorize: async () => true,
      order: (tx, input) =>
        createPostgresReceiptOrderSource({ ...scope, authorize: async () => true })(tx, input),
      template: (tx) => templateSource(tx),
    };
    const issuance = {
      sources,
      authorize: async () => true,
      identities: () => ({
        recordReference: fresh(),
        receiptReference: fresh(),
        operationReference: fresh(),
      }),
      audit: async (record, operationReference) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DIGITAL_RECEIPT_APPEND",
        targetType: "DigitalReceipt",
        targetId: record.recordReference,
        reasonCode: "SYNTHETIC_RECEIPT",
        correlationId: operationReference,
        occurredAt: record.recordedAt,
        sourceChannel: "SYSTEM",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    };
    const refreshed = [];
    const consumer = createInternalAdditionalReceiptConsumer(
      {
        scope,
        now,
        publicProfile: { binding: { validUntil: new Date(Date.now() + 3_600_000).toISOString() } },
      },
      {
        providerAccountReference: provider,
        // As the pilot's refresh: the online round's Provider is asked again (a fresh snapshot
        // equal to the last one); the card-machine round has nothing to ask.
        refreshObservations: async (_resources, event) => {
          refreshed.push(event.payload.orderReference);
          await admin.query(
            "INSERT INTO rms_payment.payment_provider_observation SELECT (jsonb_populate_record(NULL::rms_payment.payment_provider_observation, to_jsonb(o) || jsonb_build_object('provider_observation_id',$1::text,'provider_observed_at',$2::text,'recorded_at',$2::text))).* FROM rms_payment.payment_provider_observation o WHERE o.payment_intent_id=$3 AND o.observation_kind='Snapshot' ORDER BY o.provider_observed_at DESC LIMIT 1",
            [fresh(), new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), onlineIntent],
          );
        },
        createReceipt: async (_resources, runner) => ({
          issueOriginal: (request) =>
            runner.run((tx) => createOriginalReceiptIssuance(issuance)(tx, request)),
          issueAdditional: (request) =>
            runner.run((tx) => createAdditionalReceiptIssuance(issuance)(tx, request)),
        }),
      },
    );
    const envelope = createCardMachinePaymentEnvelope(saved);
    assert.ok(paid1At < envelope.occurredAt);
    const consumed = await runAs(worker).run((tx) => consumer.consume(tx, envelope));
    assert.equal(consumed.status, "processed");
    assert.deepEqual(refreshed, [orderReference]);
    const receipts = await admin.query(
      "SELECT kind,receipt_record_json AS record FROM rms_ordering.digital_receipt_record WHERE order_id=$1 ORDER BY version",
      [orderReference],
    );
    // The table had no receipt yet (round 1's own consumer is not run here), so the consumer
    // issues it covering every charged round; either way the latest version holds both rounds.
    assert.ok(receipts.rows.length >= 1, "the table's receipt");
    const latest = receipts.rows.at(-1).record.snapshot;
    const lines = new Set(latest.lines.map((line) => line.lineReference));
    for (const item of [...items1, ...items2]) assert.ok(lines.has(item.orderItemReference));
    // A replay of the same event does nothing new.
    await runAs(worker).run((tx) => consumer.consume(tx, envelope));
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM rms_ordering.digital_receipt_record WHERE order_id=$1",
          [orderReference],
        )
      ).rows[0].n,
      receipts.rows.length,
    );
  } finally {
    for (const name of [templateRole, templateWorker]) {
      await admin.query("DROP OWNED BY " + name).catch(() => undefined);
      await admin.query("DROP ROLE " + name).catch(() => undefined);
    }
  }
}
