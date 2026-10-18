import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createPostgresDiningCheckoutCommitmentStore,
  sealDiningCheckoutCommitment,
} from "../../rms/dining/src/index.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { evaluateIntactReservationPaymentRule } from "../../rms/inventory/src/index.ts";
import {
  createOrderNumberAllocation,
  createOrderPaymentOutcomeConsumerService,
  createPostgresAdditionalDiningExecutionReader,
  createPostgresOrderBatchIdentitySource,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPaymentAcceptanceWaitStore,
  createPostgresOrderPaymentOutcomeStore,
  createPostgresOrderSubmittedConsumer,
  createPostgresStaffDiningRoundEntryStore,
  listStorePaidDiningRoundsAwaitingAcceptance,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createPostgresCapturedBatchPaymentSource } from "../../rms/payment/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createCustomerAdditionalDiningPaymentAdmission } from "../../../apps/api/src/customer-additional-dining-payment-store.ts";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import {
  createMerchantCardMachinePayment,
  withPaidBatchAcceptance,
} from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { createOrderPaidContextSource } from "../../../apps/api/src/order-paid-context-source.ts";
import { createOrderPaidOutcomeSource } from "../../../apps/api/src/order-paid-outcome-source.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalMerchantAcceptance } from "../../../tooling/environment/pilot-merchant-acceptance.mjs";
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
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
} from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a6ff00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const minutes = (n) => n * 60_000;
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
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
 * WP-2423 (v15 2026-10-16, order 7): a table's first round was paid online but not yet accepted
 * when a second round existed; staff could not accept it (Orders showed no Accept, Home counted 0
 * awaiting acceptance, the kitchen never got it). Every paid round must be acceptable on its own, in
 * any order, whatever later rounds did. Under the restricted NOBYPASSRLS API role holding the
 * rendered pilot grants, with real merchant sessions:
 * - round 1 (a guest's round paid online; owner-seeded Order/Payment history, its Dining commitment
 *   sealed by the Dining owner store and its Inventory final validation by the real finalizer) is
 *   recorded as paid and awaiting acceptance by Ordering's payment consumer, as the pilot worker
 *   wires it (current dining version);
 * - round 2 is a staff-entered round submitted through the actual Ordering additional-round writer;
 *   then, per case, round 2 stays unpaid, is cancelled unpaid (owner seed of the cancellation the
 *   manager's command records), or is paid on the card machine first (the server-side acceptance
 *   staff rounds get);
 * - the order queue offers Accept for round 1 (and Home's count includes it); the merchant
 *   acceptance command, configured as the pilot configures it, accepts round 1 at the Order's
 *   current version; the paid round 2 is accepted too, in either order;
 * - Ordering's payment consumer then confirms round 1 for the kitchen, and the kitchen's Ordering
 *   source resolves round 1 at its acceptance version (what the kitchen consumer reads to create the
 *   ticket). Round 2's kitchen release is the unchanged additional-round path (dine-in journey).
 */
it.each(["Unpaid", "Cancelled", "PaidFirst"])(
  "accepts a table's paid first round while round 2 is %s, in either order",
  async (variant) => {
    await withIsolatedDatabase(
      { caseId: "wp2423_ro_" + variant.toLowerCase().slice(0, 6) },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        const api = "wp2423_ro_" + context.runId,
          worker = "wp2423_ro_w_" + context.runId;
        assert.match(api, /^wp2423_ro_[a-f0-9]+$/u);
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
          const staffGuest = id(0x602);
          const R2 = journeyRound({
            at: time(-minutes(5)),
            prefix: "01a00002",
            submitter: staffGuest,
          });
          const scope = R1.f.scope;
          const tenant = scope.brandReference.slice(0, 24) + "000000000900";
          const ownerScope = { tenantReference: tenant, ...scope };
          const orderReference = R1.f.request.record.order.orderReference;
          const guestSession = R1.f.request.record.guestSessionReference;
          const provider = id(1);
          const paymentScope = {
            ...scope,
            providerAccountReference: provider,
            environment: "Test",
          };

          /** Statements the restricted role ran (the acceptance query budget). */
          const queryCount = { value: 0 };
          /** One restricted-role transaction on its own connection (the pilot's grants). */
          const transactions = (role = api) => ({
            async run(work) {
              const client = new Client(context.clientConfig);
              await client.connect();
              try {
                await client.query("BEGIN");
                await client.query("SET LOCAL ROLE " + role);
                await client.query("SET LOCAL lock_timeout='10s'");
                await client.query("SET LOCAL statement_timeout='20s'");
                const result = await work({
                  query: (sql, values) => {
                    queryCount.value += 1;
                    return client.query(sql, values === undefined ? [] : values);
                  },
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

          // ── The table: the Host (the fixture guest) and the staff command's table guest.
          const dining = await seedJourneyDining({
            client: admin,
            scope: ownerScope,
            round: R1,
            startedAt: time(-minutes(50)),
            guestParticipant: id(0x601),
          });
          await seedAdditionalDiningGuest({
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
          const inventoryOptions = {
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
          };

          // ── Round 1: a guest's round, paid online, NOT accepted. Test-only owner seeds of the
          // Order and Payment history; Dining seals its commitment and Inventory finalizes the
          // submission through their owner code, as the round's checkout did.
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
          const commitment1 = R1.f.request.checkoutValidationEvidence.fulfillment.evidenceReference;
          const pay1 = {
            paymentIntent: id(0x1001),
            attempt: id(0x1002),
            observation: id(0x1003),
            webhook: id(0x1004),
            transaction: id(0x1005),
            paymentEvent: id(0x1006),
            projection: id(0x1007),
            preparation: id(0x1008),
            commitment: commitment1,
            paymentOperation: id(0x100a),
            providerIntent: "pi_SYNTHETICORDER1",
            providerEvent: "evt_SYNTHETICORDER1",
          };
          const requested1 = time(-minutes(39));
          await dining.prepare(R1, { paymentOperationReference: pay1.paymentOperation });
          const commitments = createPostgresDiningCheckoutCommitmentStore(
            ownerRunner(),
            ownerScope,
            { now: () => requested1 },
          );
          const prepared1 = await commitments.loadSubmission(R1.batch.submissionReference);
          const sealed1 = sealDiningCheckoutCommitment(
            prepared1,
            { session: dining.session, participant: dining.host },
            {
              ...Object.fromEntries(
                [
                  "commitmentReference",
                  "brandReference",
                  "storeReference",
                  "submissionReference",
                  "orderReference",
                  "orderBatchReference",
                  "cartReference",
                  "cartVersion",
                  "quoteReference",
                  "paymentOperationReference",
                  "guestSessionReference",
                  "intentHash",
                ].map((key) => [key, prepared1[key]]),
              ),
              acknowledgedAt: requested1,
            },
            requested1,
            requested1,
          );
          await commitments.append({
            record: sealed1,
            expectedVersion: 1,
            audit: dining.audit(sealed1),
          });
          await ownerRunner().run((tx) =>
            createCustomerSubmissionInventoryFinalizer(inventoryOptions).finalize({
              transaction: tx,
              cart: R1.f.cart,
              checkoutValidationEvidence: R1.f.request.checkoutValidationEvidence,
              observedAt: R1.batch.submittedAt,
              record: {
                submissionReference: r1.submissionReference,
                guestSessionReference: guestSession,
                items: items1,
                order: {
                  brandReference: scope.brandReference,
                  storeReference: scope.storeReference,
                  orderReference,
                  submittedByActorReference: R1.batch.submittedByActorReference,
                },
              },
            }),
          );
          await seedJourneyPayment(admin, {
            scope,
            providerAccountReference: provider,
            round: R1,
            refs: pay1,
            outcome: "Succeeded",
            requestedAt: requested1,
            occurredAt: time(-minutes(38)),
            totalMinor: roundTotal,
          });

          // ── Ordering's payment consumer, wired as the pilot worker wires it (current dining
          // version), records round 1 as paid and awaiting acceptance.
          const paidContext = createOrderPaidContextSource({
            currentDiningAcceptance: true,
            scope: paymentScope,
            tenantReference: tenant,
            quoteVersion: 1,
            now,
            authorize: async (_tx, event) => event.payload.orderReference === orderReference,
            authorizeOrder: async (_tx, value) => value.orderReference === orderReference,
            authorizeInventory: async () => true,
          });
          const consumerActor = id(0x800);
          let releasedAt = now();
          const outcomeSource = createOrderPaidOutcomeSource({
            context: paidContext,
            sha256: hash,
            release: {
              action: "ReleasePaidOrder",
              purposeCode: inventoryWorkflow.payment.purposeCode,
              permissionCode: "order.release",
              nextState: "Accepted",
            },
            generateDispositionReference: fresh,
            generateConfirmationReference: fresh,
            resolveWorkflow: async ({ context: current }) => {
              releasedAt = current.observedAt;
              const request = {
                ...ownerScope,
                actorReference: consumerActor,
                resourceReference: orderReference,
                resourceVersion:
                  current.currentDining?.current.orderVersion ??
                  current.acceptance.acceptedOrderVersion,
                purposeCode: inventoryWorkflow.payment.purposeCode,
                applicabilityCode: "DineIn",
                expectedVersionReference: inventoryWorkflow.payment.workflowVersionReference,
                currentState: current.currentDining?.current.canonicalPhase ?? "Accepted",
                action: "ReleasePaidOrder",
                observedAt: current.observedAt,
              };
              return {
                request,
                gates: {
                  authorizeResource: async (_tx, value) =>
                    value.resourceReference === orderReference &&
                    value.resourceVersion === request.resourceVersion,
                  authorizeAction: async () => true,
                  authorizeOverride: async () => false,
                  evaluateRule: async (_tx, value) =>
                    value.ruleReference ===
                      inventoryWorkflow.payment.intactReservationRuleReference &&
                    current.capacity !== null &&
                    current.inventory !== null &&
                    evaluateIntactReservationPaymentRule(current.inventory),
                },
              };
            },
          });
          const outcomes = createPostgresOrderPaymentOutcomeStore({
            ...scope,
            sha256: hash,
            audit: async ({ orderReference: order, correlationReference, outcome }) => ({
              auditId: fresh(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "ORDER_PAYMENT_DISPOSITION_RECORDED",
              targetType: "Order",
              targetId: order,
              correlationId: correlationReference,
              afterSummary: { outcome },
              reasonCode: "PAYMENT_CAPTURED",
              occurredAt: releasedAt,
              sourceChannel: "EVENT_CONSUMER",
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          });
          const waits = createPostgresOrderPaymentAcceptanceWaitStore({
            ...scope,
            sha256: hash,
            authorize: async () => true,
            validateCurrent: async (transaction, { event: paid, record: waiting }) => {
              const current = await outcomeSource.loadExact({
                transaction,
                paymentEvent: paid,
                brandReference: paid.tenantId,
                storeReference: paid.storeId,
                orderReference: paid.payload.orderReference,
                paymentTransactionReference: paid.payload.paymentTransactionReference,
                paymentIntentReference: paid.payload.paymentIntentReference,
                paymentAttemptReference: paid.payload.paymentAttemptReference,
                paymentEventReference: paid.eventId,
              });
              return (
                current?.disposition === "AwaitingAcceptance" &&
                current.orderBatchReference === waiting.orderBatchReference
              );
            },
            audit: async ({ event: paid, record: waiting }) => ({
              auditId: fresh(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "ORDER_PAYMENT_WAIT_RECORDED",
              targetType: "OrderPaymentWait",
              targetId: waiting.dispositionReference,
              correlationId: paid.correlationId,
              afterSummary: { outcome: "AwaitingAcceptance" },
              reasonCode: "ORDER_ACCEPTANCE_PENDING",
              occurredAt: waiting.evaluatedAt,
              sourceChannel: "EVENT_CONSUMER",
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          });
          const paymentConsumer = createOrderPaymentOutcomeConsumerService({
            authorization: { authorize: async () => true },
            source: outcomeSource,
            outcomes,
            references: { generate: fresh },
            digests: { sha256: hash },
            waiting: {
              record: async ({ transaction, event: paid, disposition }) =>
                (await waits.record(transaction, paid, disposition)).record,
              load: ({ transaction, event: paid }) => waits.load(transaction, paid),
            },
          });
          const event1 = (
            await transactions().run((tx) =>
              createPostgresCapturedBatchPaymentSource({
                scope: paymentScope,
                authorize: async () => true,
              }).load(tx, {
                orderReference,
                orderBatchReference: R1.batch.orderBatchReference,
                observedAt: now(),
              }),
            )
          ).paymentEvent;
          const waited = await transactions().run((tx) => paymentConsumer.consume(tx, event1));
          assert.equal(waited.result.status, "AwaitingOrderAcceptance");
          assert.equal(waited.result.disposition.orderBatchReference, R1.batch.orderBatchReference);

          // ── Staff: front of house with staff ordering, the table operation and acceptance.
          const frontOfHouse = id(0x700);
          const staffSession = await seedMerchantAcceptanceSession({
            admin,
            runner: transactions(),
            scope: ownerScope,
            actor: frontOfHouse,
            at: now(),
            extraPermissions: ["ordering.order.create_staff", "dining.operate", "kitchen.operate"],
          });

          // ── Round 2: the staff command's table guest submits the table Cart through the actual
          // Ordering writer while round 1 still waits for acceptance (Order at version 1).
          await seedSubmissionCart(admin, R2.f);
          const pay2Operation = id(0x200a);
          const link2 = await dining.prepare(R2, {
            paymentOperationReference: pay2Operation,
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
            expectedOrderVersion: 1,
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
              // Test-only stand-ins as in the staff round acceptance: no policies required and the
              // Identity/CSRF recheck not composed. Dining gate, Inventory and the seal are real.
              currentPolicies: async (_tx, request) => ({
                ...scope,
                orderType: "DineIn",
                checkedAt: request.observedAt,
                validUntil: new Date(Date.parse(request.observedAt) + minutes(5)).toISOString(),
                required: [],
              }),
              validateCurrent: async () => undefined,
              inventory: inventoryOptions,
              diningSealAudit: async (record) => dining.audit(record),
            }).append({
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
              const execution = await createPostgresAdditionalDiningExecutionReader({
                ...scope,
                authorize: async (_tx, q) =>
                  same(q) && q.submissionReference === identity.submissionReference,
              }).loadBySubmission({
                transaction: tx,
                submissionReference: identity.submissionReference,
                observedAt: now(),
              });
              return execution.orderVersion === snapshot.sourceVersion ? "Fresh" : "Stale";
            },
          });
          await transactions().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, scope.brandReference, scope.storeReference],
            );
            return orderStatusConsumer.consume(tx, await loadOutboxEnvelope(tx, submittedEvent));
          });
          // The tip staff keyed with the round and the Ordering staff record of who entered it.
          const tipSelection = id(0x2201);
          await admin.query(
            "INSERT INTO rms_payment.payment_tip_selection (selection_id,brand_id,store_id,payment_operation_id,submission_id,cart_id,cart_version,quote_id,guest_session_id,tip_minor,currency_code,selected_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'CAD',$10)",
            [
              tipSelection,
              scope.brandReference,
              scope.storeReference,
              pay2Operation,
              R2.batch.submissionReference,
              R2.batch.sourceCartReference,
              R2.batch.sourceCartVersion,
              R2.batch.quoteReference,
              staffGuest,
              R2.batch.submittedAt,
            ],
          );
          await transactions().run((tx) =>
            createPostgresStaffDiningRoundEntryStore({
              ...scope,
              authorize: async () => true,
            }).record(tx, {
              ...scope,
              operationReference: id(0x2301),
              intentHash: "sha256:" + "a".repeat(64),
              actorReference: frontOfHouse,
              tableReference: dining.table.tableReference,
              diningSessionReference: dining.session.diningSessionReference,
              guestSessionReference: staffGuest,
              tipSelectionReference: tipSelection,
              recordedAfterOutage: false,
              createdAt: R2.batch.submittedAt,
              auditReference: id(0x2302),
            }),
          );
          const round2Total = items2.reduce(
            (sum, item) => sum + item.pricing.total.amountMinor,
            0n,
          );

          // ── The order queue (Orders, Home's count and the chime read it).
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
          const listed = async () =>
            (
              await queue({ sessionCookie: staffSession.sessionCookie, afterOrderReference: null })
            ).items.find((item) => item.orderReference === orderReference);
          const offered = (item) =>
            item.batches.map((b) => [b.sequence, b.acceptanceStatus, b.canRequestAcceptance]);

          // ── The merchant acceptance command as the pilot composes it (its own configuration,
          // gates and owner checks), with the fixture's Quote v1 Orders and workflow.
          const pilotWorkflow = {
            environment: "InternalTest",
            database: "isolated",
            scope: ownerScope,
            workflow: {
              purposeCode: inventoryWorkflow.payment.purposeCode,
              payment: {
                workflowVersionReference: inventoryWorkflow.payment.workflowVersionReference,
              },
            },
          };
          const pilotAccept = await createInternalMerchantAcceptance(
            { scope: ownerScope, credentials: { reference: fresh }, now },
            { ...staffSession.persistence, now },
            staffSession.authentication,
            {
              loadPickupWorkflow: async () => pilotWorkflow,
              loadDiningWorkflow: async () => pilotWorkflow,
              expectedDatabaseName: "isolated",
              providerAccountReference: provider,
              quoteVersion: 1,
            },
          );
          /** Statements each acceptance ran (WP-2423 query budget below). */
          const acceptStatements = [];
          const accept = async (input, mode) => {
            const before = queryCount.value;
            try {
              return await pilotAccept(input, mode);
            } finally {
              acceptStatements.push(queryCount.value - before);
            }
          };
          const session = { sessionCookie: staffSession.sessionCookie, csrf: staffSession.csrf };
          /** Staff press Accept for `round` on the Orders page (the version they see). */
          const acceptFromOrders = async (round) => {
            const item = await queued();
            return accept({
              ...session,
              command: {
                acceptanceReference: fresh(),
                operationReference: fresh(),
                orderReference,
                orderBatchReference: round.orderBatchReference,
                expectedOrderVersion: item.currentVersion,
              },
            });
          };
          const accepted = async (round) =>
            (
              await one(
                "SELECT expected_order_version::int AS expected,accepted_order_version::int AS accepted FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
                [round.orderBatchReference],
              )
            )[0] ?? null;

          // The card-machine payment of round 2 with the server-side acceptance staff rounds get.
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
          const payRound2 = () =>
            withPaidBatchAcceptance(
              createMerchantCardMachinePayment({
                persistence: { ...staffSession.persistence, now },
                authentication: staffSession.authentication,
                admission,
                environment: "Test",
                nextReference: fresh,
              }),
              { accept: (input, mode) => accept(input, mode), nextReference: fresh },
            )({
              ...session,
              command: {
                operationReference: id(0x2401),
                orderReference,
                orderBatchReference: R2.batch.orderBatchReference,
                expectedTotalMinor: String(round2Total),
                slipReference: "AUTH 771205",
                takenAt: null,
              },
            });

          // ── Before: round 1 is paid and acceptable although round 2 exists (v15 order 7).
          const before = await queued();
          assert.equal(before.currentVersion, 2);
          assert.deepEqual(offered(before), [
            [1, "NotAccepted", true],
            [2, "NotAccepted", false],
          ]);
          assert.notEqual(before.batches[1].paymentDue, null);
          // The paid round says when it was paid (never refunded automatically; staff are warned
          // as it waits), on Orders and, through Ordering's own read, on the Tables page.
          assert.match(before.batches[0].awaitingAcceptanceSince, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
          assert.equal(before.batches[1].awaitingAcceptanceSince, null);
          const waitingRounds = await transactions().run((tx) =>
            listStorePaidDiningRoundsAwaitingAcceptance(tx, scope, [
              dining.session.diningSessionReference,
            ]),
          );
          assert.deepEqual(
            waitingRounds.map((round) => [round.orderBatchReference, round.roundNumber]),
            [[R1.batch.orderBatchReference, 1]],
          );
          assert.equal(waitingRounds[0].paidAt, before.batches[0].awaitingAcceptanceSince);
          // Home's count and the Orders list read the same capability.
          assert.equal((await listed()).batches[0].canRequestAcceptance, true);

          if (variant === "Cancelled") {
            // A manager cancelled the unpaid round 2 (test-only owner seed of the cancellation
            // the manager's command records, with its Order revision).
            const [{ at }] = await one("SELECT date_trunc('milliseconds',clock_timestamp()) AS at");
            const items = (
              await one(
                "SELECT array_agg(order_item_id::text ORDER BY order_item_id) AS ids FROM rms_ordering.order_item WHERE order_batch_id=$1",
                [R2.batch.orderBatchReference],
              )
            )[0].ids;
            await admin.query("SET session_replication_role = replica");
            try {
              await admin.query(
                "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) SELECT $1,$2,$3,b.brand_id,b.store_id,b.order_id,b.order_batch_id,b.submission_id,$4,NULL,NULL,2,3,b.submission_id,$5,$6,$7::uuid[],$8,'Cancelled','STAFF_CANCELLED_UNPAID' FROM rms_ordering.order_batch b WHERE b.order_batch_id=$9",
                [
                  id(0x3001),
                  id(0x3002),
                  tenant,
                  pay2Operation,
                  id(0x3003),
                  id(0x3004),
                  items,
                  at,
                  R2.batch.orderBatchReference,
                ],
              );
              await admin.query(
                "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) SELECT $1,brand_id,store_id,order_id,'BatchCancellation',3,2,$2,NULL,$3 FROM rms_ordering.order_batch WHERE order_batch_id=$4",
                [id(0x3001), R2.batch.submissionReference, at, R2.batch.orderBatchReference],
              );
            } finally {
              await admin.query("SET session_replication_role = origin");
            }
            const cancelled = await queued();
            assert.equal(cancelled.currentVersion, 3);
            assert.deepEqual(offered(cancelled), [
              [1, "NotAccepted", true],
              [2, "Cancelled", false],
            ]);
          }
          if (variant === "PaidFirst") {
            // Round 2 is paid on the card machine and accepted (server side) before round 1.
            const paid2 = await payRound2();
            assert.equal(paid2.status, "Recorded");
            assert.equal(paid2.acceptance, "Accepted");
            assert.deepEqual(await accepted(R2.batch), { expected: 2, accepted: 3 });
            const later = await queued();
            assert.equal(later.currentVersion, 3);
            assert.deepEqual(offered(later), [
              [1, "NotAccepted", true],
              [2, "Accepted", false],
            ]);
          }

          // ── Staff accept round 1 from the Orders page at the Order's current version.
          const version = (await queued()).currentVersion;
          // A page read before a later round changed the Order is told to refresh.
          await assert.rejects(
            accept({
              ...session,
              command: {
                acceptanceReference: fresh(),
                operationReference: fresh(),
                orderReference,
                orderBatchReference: R1.batch.orderBatchReference,
                expectedOrderVersion: 1,
              },
            }),
            { code: "ORDER_ACCEPTANCE_VERSION_CONFLICT" },
          );
          const result1 = await acceptFromOrders(R1.batch);
          assert.deepEqual(result1, { status: "Created", acceptedOrderVersion: version + 1 });
          assert.deepEqual(await accepted(R1.batch), { expected: version, accepted: version + 1 });
          const afterOne = await queued();
          assert.equal(afterOne.batches[0].acceptanceStatus, "Accepted");
          assert.equal(afterOne.batches[0].awaitingAcceptanceSince, null);
          assert.deepEqual(
            await transactions().run((tx) =>
              listStorePaidDiningRoundsAwaitingAcceptance(tx, scope, [
                dining.session.diningSessionReference,
              ]),
            ),
            [],
          );
          assert.equal(afterOne.batches[0].canRequestAcceptance, false);
          // Pressing Accept again (another tablet) is told it was already accepted.
          await assert.rejects(acceptFromOrders(R1.batch), {
            code: "ORDER_ACCEPTANCE_ALREADY_ACCEPTED",
          });

          if (variant === "Unpaid") {
            // Round 2 is paid afterwards and accepted at the version round 1's acceptance made.
            const paid2 = await payRound2();
            assert.equal(paid2.acceptance, "Accepted");
            assert.deepEqual(await accepted(R2.batch), { expected: 3, accepted: 4 });
          }
          const final = await queued();
          assert.deepEqual(
            offered(final),
            variant === "Cancelled"
              ? [
                  [1, "Accepted", false],
                  [2, "Cancelled", false],
                ]
              : [
                  [1, "Accepted", false],
                  [2, "Accepted", false],
                ],
          );
          assert.equal(
            final.batches.some((b) => b.canRequestAcceptance),
            false,
          );

          // ── Query budget (WP-2423, v15 order 9: each Accept took ~2.4 s). The caller is resolved
          // in full at the start and before the commit; the owner checks inside take the run's
          // guard, and the paid context is read once before the Order lock and once under it.
          // Measured 2026-10-16: 235 (round 1 from Orders) and 275 (round 2 after the card machine);
          // re-resolving the caller in every owner check cost 1,590 and 2,554.
          assert.ok(
            acceptStatements.every((count) => count <= 300),
            "acceptance statements " + JSON.stringify(acceptStatements),
          );

          // ── The kitchen gets round 1: Ordering confirms its payment at the acceptance version
          // and the kitchen's Ordering source resolves it (what the kitchen consumer reads).
          const confirmed = await transactions().run((tx) =>
            paymentConsumer.resumePending(tx, event1),
          );
          assert.equal(confirmed.disposition.disposition, "Confirmed");
          assert.equal(confirmed.disposition.orderBatchReference, R1.batch.orderBatchReference);
          assert.equal(Number(confirmed.disposition.sourceVersion), version + 1);
          const saved = await transactions().run((transaction) =>
            outcomes.loadByPaymentEvent({ transaction, paymentEventReference: event1.eventId }),
          );
          assert.ok(saved.orderConfirmedEvent);
          const kitchenSource = await transactions().run((transaction) =>
            createPostgresOrderKitchenSourceStore({
              ...scope,
              quoteVersion: 1,
              sha256: hash,
              authorize: async () => true,
            }).resolve({
              transaction,
              query: {
                ...scope,
                orderReference,
                orderBatchReference: R1.batch.orderBatchReference,
                confirmationReference: confirmed.disposition.confirmationReference,
                sourceEventReference: saved.orderConfirmedEvent.eventId,
                sourceAggregateVersion: BigInt(confirmed.disposition.sourceVersion),
                sourceSnapshotDigest: confirmed.disposition.sourceSnapshotDigest,
                observedAt: now(),
              },
            }),
          );
          assert.equal(kitchenSource.orderReference, orderReference);
          assert.equal(kitchenSource.orderBatchReference, R1.batch.orderBatchReference);
          assert.equal(kitchenSource.items.length, items1.length);
        } finally {
          vi.unstubAllEnvs();
          for (const name of [api, worker]) {
            await admin.query("DROP OWNED BY " + name).catch(() => undefined);
            await admin.query("DROP ROLE " + name).catch(() => undefined);
          }
          await admin.end();
        }
      },
    );
  },
);
