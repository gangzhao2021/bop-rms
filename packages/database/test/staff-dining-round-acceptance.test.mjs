import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "../../rms/payment/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createCustomerAdditionalDiningPaymentAdmission } from "../../../apps/api/src/customer-additional-dining-payment-store.ts";
import { createCustomerDiningSessionRead } from "../../../apps/api/src/customer-dining-session-read.ts";
import { createMerchantCardMachinePayment } from "../../../apps/api/src/merchant-card-machine-payment.ts";
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
} from "../test-support/dine-in-journey-seed.mjs";

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
      // payment, never as a failed payment that will be cancelled (nothing cancels it).
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
            { recordedAfterOutage: false, paidOnCardMachine: null },
            { status: "Awaiting", cancelsAt: null },
          ],
        ],
      );
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
    } finally {
      vi.unstubAllEnvs();
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
