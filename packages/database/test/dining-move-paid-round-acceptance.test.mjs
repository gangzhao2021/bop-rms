import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createDiningTable,
  createPostgresDiningCheckoutCommitmentStore,
  listDiningSessionTableLabels,
  sealDiningCheckoutCommitment,
} from "../../rms/dining/src/index.ts";
import { evaluateIntactReservationPaymentRule } from "../../rms/inventory/src/index.ts";
import {
  createOrderNumberAllocation,
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPaymentAcceptanceWaitStore,
  createPostgresOrderPaymentOutcomeStore,
  listStorePaidOrderBatches,
} from "../../rms/ordering/src/index.ts";
import { createPostgresCapturedBatchPaymentSource } from "../../rms/payment/src/index.ts";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { createMerchantDiningTableMove } from "../../../apps/api/src/merchant-dining-table-move.ts";
import { createMerchantDiningTableCommand } from "../../../apps/api/src/merchant-dining-table-command.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { createOrderPaidContextSource } from "../../../apps/api/src/order-paid-context-source.ts";
import { createOrderPaidOutcomeSource } from "../../../apps/api/src/order-paid-outcome-source.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalMerchantAcceptance } from "../../../tooling/environment/pilot-merchant-acceptance.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { snapshotBegin, snapshotQuery } from "../test-support/snapshot-read-runner.mjs";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import {
  journeyRound,
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
 * WP-2423 M04 (simulation dessert-midnight 2026-11-04; v15 07b7a1b7 2026-11-06): staff moved a table
 * while a round was paid and not yet accepted. Accepting it failed every time, and the Store's
 * payment worker stopped on it, so rounds and pickups accepted later got no kitchen ticket for 8 to
 * 19 minutes. A paid round goes with its party: under the restricted NOBYPASSRLS API role holding
 * the rendered pilot grants, with real merchant sessions,
 * - round 1, paid online (owner-seeded Order/Payment history; Dining seals its commitment and
 *   Inventory finalizes the submission through their owner code), is recorded as paid and awaiting
 *   acceptance by Ordering's payment consumer as the pilot worker wires it;
 * - staff move the party with the merchant Move command (A to B, or A to B to C); per case the
 *   payment is captured before the move or after it (started at A, captured after the move: a new
 *   payment for the round is still refused, the one started is recorded);
 * - staff accept the round from Orders (the pilot's acceptance command) at the new table, the
 *   worker's resume confirms it for the kitchen and the kitchen's Ordering source resolves it; the
 *   wait leaves the worker's queue; Orders and the kitchen ticket name the table the party sits at.
 * WP-2423 table-move-payment (v15 fabf0261, 2026-11-06): accepting failed 5 of 5 times when the
 * party moved to a table seated less often than the one it left (a table's assignment number was
 * compared with another table's), and a payment open during the move could not complete. Also:
 * - MovedToLowerVersionTable: the source table was seated 40 times, the target is fresh;
 * - MovedAwayAndBack: A to B, A cleaned, B back to A;
 * - PaymentOpenDuringMove: the payment started at A completes after the move (its admission
 *   gate is current at B, for the same amount), including a Move landing inside that gate.
 */
it.each([
  "CapturedBeforeMove",
  "MovedTwice",
  "MovedToLowerVersionTable",
  "MovedAwayAndBack",
  "PaymentOpenDuringMove",
])(
  "a paid round not yet accepted goes with its party to another table and reaches the kitchen (%s)",
  async (variant) => {
    await withIsolatedDatabase(
      { caseId: "wp2423_mv_" + variant.toLowerCase().slice(0, 8) },
      async (context) => {
        const admin = new Client(context.clientConfig);
        await admin.connect();
        const api = "wp2423_mv_" + context.runId,
          worker = "wp2423_mv_w_" + context.runId;
        assert.match(api, /^wp2423_mv_[a-f0-9]+$/u);
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
          // The payment still open during the move was asked for within its 30-minute window.
          const r1At = variant === "PaymentOpenDuringMove" ? -12 : -40;
          const R1 = journeyRound({ at: time(minutes(r1At)), prefix: "01a00001" });
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
            async run(work, snapshot = false) {
              const client = new Client(context.clientConfig);
              await client.connect();
              try {
                await client.query(snapshot ? snapshotBegin : "BEGIN");
                await client.query("SET LOCAL ROLE " + role);
                await client.query("SET LOCAL lock_timeout='10s'");
                await client.query("SET LOCAL statement_timeout='20s'");
                const send = (sql, values) => {
                  queryCount.value += 1;
                  return client.query(sql, values === undefined ? [] : values);
                };
                const result = await work({ query: snapshot ? snapshotQuery(send) : send });
                await client.query("COMMIT");
                return result;
              } catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
              } finally {
                await client.end();
              }
            },
            /** WP-2423: polled merchant reads (Orders) run as the pilot's snapshot read. */
            runSnapshot(work) {
              return this.run(work, true);
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
            // v15 窗边 1 号 had been seated 40 times; the table the party moves to is fresh.
            ...(variant === "MovedToLowerVersionTable"
              ? { tableVersion: 40, assignmentVersion: 40 }
              : {}),
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
          const requested1 = time(minutes(r1At + 1));
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

          // ── Staff: front of house with the table operation and acceptance.
          const frontOfHouse = id(0x700);
          const staffSession = await seedMerchantAcceptanceSession({
            admin,
            runner: transactions(),
            scope: ownerScope,
            actor: frontOfHouse,
            at: now(),
            extraPermissions: ["dining.operate", "kitchen.operate"],
          });
          const session = { sessionCookie: staffSession.sessionCookie, csrf: staffSession.csrf };

          /** The guest's payment is captured and Ordering's payment consumer records it. */
          const capture = async () => {
            await seedJourneyPayment(admin, {
              scope,
              providerAccountReference: provider,
              round: R1,
              refs: pay1,
              outcome: "Succeeded",
              requestedAt: requested1,
              occurredAt: time(minutes(r1At + 2)),
              totalMinor: roundTotal,
            });
            const event = (
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
            const waited = await transactions().run((tx) => paymentConsumer.consume(tx, event));
            assert.equal(waited.result.status, "AwaitingOrderAcceptance");
            assert.equal(
              waited.result.disposition.orderBatchReference,
              R1.batch.orderBatchReference,
            );
            return event;
          };

          // ── The Store's other free tables, each with its table code (owner seed, TEST labels).
          const freeTable = async (suffix, label) => {
            const reference = scope.storeReference.slice(0, 24) + "0000000" + suffix;
            const table = createDiningTable({
              ...ownerScope,
              tableReference: reference,
              stableLabel: label,
              areaReference: dining.table.areaReference,
              areaCode: "ROOM",
              capacity: 4,
              accessibilityAttributes: [],
              lifecycle: "Published",
              qrStatus: "Active",
              qrVersion: 1,
              operationalState: "Available",
              blockReasonCode: null,
              activeDiningSessionReference: null,
              aggregateVersion: 1,
              createdAt: time(-minutes(60)),
              observedAt: time(-minutes(60)),
            });
            await admin.query(
              "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
              [
                reference,
                tenant,
                scope.brandReference,
                scope.storeReference,
                JSON.stringify(table),
                time(-minutes(60)),
              ],
            );
            return reference;
          };
          const tableA = dining.table.tableReference;
          const tableB = await freeTable("0b001", "TEST-B");
          const tableC = await freeTable("0c001", "TEST-C");
          const tableVersion = async (table) =>
            Number(
              (
                await one("SELECT version FROM rms_dining.dining_table WHERE table_id=$1", [table])
              )[0].version,
            );
          // TEST-ONLY dining credentials (the pilot's are internal, keyed per environment).
          const joinKey = randomBytes(32);
          const diningCredentials = {
            generateReference: fresh,
            generateJoinCredential: (kind) =>
              kind === "HumanCode"
                ? String(randomInt(0, 1000000)).padStart(6, "0")
                : randomBytes(16).toString("base64url"),
            hashJoinCredential: (kind, value) =>
              createHmac("sha256", joinKey).update(`DiningJoin:${kind}:${value}`).digest("hex"),
            hashOperationIntent: (value) => createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
          };
          /** Staff move the party from `from` to `to` on the Tables page (the merchant command). */
          const move = async (from, to) => {
            const result = await createMerchantDiningTableMove({
              persistence: { ...staffSession.persistence, now },
              authentication: staffSession.authentication,
              newReference: fresh,
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
              credentials: diningCredentials,
              pepperVersion: 1,
            })({
              ...session,
              command: {
                action: "Move",
                operationReference: fresh(),
                tableReference: from,
                expectedTableVersion: await tableVersion(from),
                targetTableReference: to,
                expectedTargetTableVersion: await tableVersion(to),
              },
            });
            assert.equal(result.status, "Applied");
            assert.equal(result.tableReference, to);
          };

          // ── The order queue (Orders, Home's count) and the acceptance command, as the pilot
          // composes them.
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
          const accept = await createInternalMerchantAcceptance(
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
          const unresolved = () => transactions().run((tx) => waits.listUnresolved(tx, 100, null));

          /** Staff mark the table the party left as cleaned (Tables: "Cleaned"). */
          const cleaned = async (table) =>
            createMerchantDiningTableCommand({
              persistence: { ...staffSession.persistence, now },
              authentication: staffSession.authentication,
              newReference: fresh,
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            })({
              ...session,
              command: {
                action: "ClearBlock",
                tableReference: table,
                expectedAggregateVersion: await tableVersion(table),
                operationReference: fresh(),
                reasonCode: null,
              },
            });
          /** The pilot's payment admission gate for round 1 (what confirm, resume and retry call). */
          const paymentGate = (runner = transactions()) =>
            createPostgresDiningCheckoutCommitmentStore(runner, ownerScope, {
              now,
            }).withPaymentPending(commitment1, async (_tx, current) => current);

          // ── The move, per case.
          let event1;
          if (variant === "PaymentOpenDuringMove") {
            // The guest's payment sheet was opened at table A; staff move the party while the
            // guest confirms, inside the gate itself. A to B lands after the gate's first read of
            // where the party sits and before its locks: the gate locks A and the session, finds
            // the party gone and reads again. B to C then starts as the gate's second read is
            // answered and takes table B before waiting for the session: the gate gives back A and
            // the session before it locks B (a Move locks table before session), so neither waits
            // on the other (review 2026-11-06: holding the session here deadlocked with the Move).
            let reads = 0;
            let second = null;
            const racing = {
              run: (work) =>
                transactions().run((tx) =>
                  work({
                    async query(sql, values) {
                      const result = await tx.query(sql, values);
                      if (
                        sql.startsWith("SELECT session_snapshot AS session") &&
                        !sql.includes("FOR UPDATE")
                      ) {
                        reads += 1;
                        if (reads === 1) await move(tableA, tableB);
                        if (reads === 2) {
                          let settled = false;
                          second = move(tableB, tableC).finally(() => {
                            settled = true;
                          });
                          // Until the Move has finished or waits for a lock (holding table B).
                          for (let wait = 0; !settled && wait < 200; wait += 1) {
                            const [{ waiting }] = await one(
                              "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
                            );
                            if (waiting > 0) break;
                            await new Promise((resolve) => setTimeout(resolve, 25));
                          }
                        }
                      }
                      return result;
                    },
                  }),
                ),
            };
            const current = await paymentGate(racing);
            await second;
            assert.equal(reads, 3);
            assert.equal(current.commitmentReference, commitment1);
            assert.equal(current.tableReference, tableA);
            assert.equal(current.state, "PaymentPending");
            // ... and the payment already started is captured once, recorded, awaits acceptance.
            event1 = await capture();
            assert.equal((await paymentGate()).commitmentReference, commitment1);
          } else {
            event1 = await capture();
            if (variant === "MovedAwayAndBack") {
              await move(tableA, tableB);
              await cleaned(tableA);
              await move(tableB, tableA);
            } else {
              await move(tableA, tableB);
              if (variant === "MovedTwice") await move(tableB, tableC);
            }
          }
          const seatedAt =
            variant === "MovedTwice" || variant === "PaymentOpenDuringMove"
              ? tableC
              : variant === "MovedAwayAndBack"
                ? tableA
                : tableB;
          const seatedLabel =
            seatedAt === tableC ? "TEST-C" : seatedAt === tableA ? "SYNTHETIC-JOURNEY" : "TEST-B";
          assert.deepEqual(
            (await unresolved()).map((value) => value),
            [event1.eventId],
          );
          // A round prepared at the table the party left can no longer be sent from it (review
          // 2026-11-06): Dining answers that the table moved, so the phone starts checkout again
          // at the party's table instead of retrying the same checkout until it lapses.
          await assert.rejects(
            createPostgresDiningCheckoutCommitmentStore(transactions(), ownerScope, {
              now,
            }).withCurrentFacts(commitment1, async () => true),
            { code: "DINING_CHECKOUT_STORE_TABLE_MOVED" },
          );

          // ── Staff accept the paid round at its new table, from the Orders page.
          const before = await queued();
          assert.equal(before.batches[0].canRequestAcceptance, true);
          // Tables, Orders and the kitchen ticket name the table the party sits at now.
          assert.equal(before.summary.tableLabel, seatedLabel);
          const result = await accept({
            ...session,
            command: {
              acceptanceReference: fresh(),
              operationReference: fresh(),
              orderReference,
              orderBatchReference: R1.batch.orderBatchReference,
              expectedOrderVersion: before.currentVersion,
            },
          });
          assert.deepEqual(result, {
            status: "Created",
            acceptedOrderVersion: before.currentVersion + 1,
          });

          // ── Until the worker releases it, Orders and Tables say it is being sent (never "sent"),
          // and a minute after acceptance that it has not reached the kitchen (Home counts it).
          const releasing = await transactions().run((tx) =>
            listStorePaidOrderBatches(tx, scope, [orderReference]),
          );
          assert.equal(releasing.acceptedNotReleased.has(R1.batch.orderBatchReference), true);
          const sending = (await queued()).batches[0];
          assert.equal(sending.kitchenRelease.state, "Sending");
          const minuteLater = createPersistentMerchantOrderQueue({
            persistence: {
              ...staffSession.persistence,
              now: () =>
                new Date(Date.parse(sending.kitchenRelease.acceptedAt) + 61_000).toISOString(),
            },
            quoteVersion: 1,
            acceptanceConfigured: true,
          });
          const late = (
            await minuteLater({
              sessionCookie: staffSession.sessionCookie,
              afterOrderReference: null,
              orderReference,
            })
          ).items[0].batches[0];
          assert.equal(late.kitchenRelease.state, "NotInKitchen");
          assert.equal(late.automaticRefundLate, false);

          // ── The worker releases it to the kitchen: Ordering confirms the payment at the
          // acceptance version, and the kitchen's Ordering source resolves the round.
          const confirmed = await transactions().run((tx) =>
            paymentConsumer.resumePending(tx, event1),
          );
          assert.equal(confirmed.disposition.disposition, "Confirmed");
          assert.equal(confirmed.disposition.orderBatchReference, R1.batch.orderBatchReference);
          assert.deepEqual(await unresolved(), []);
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
          assert.equal(kitchenSource.orderBatchReference, R1.batch.orderBatchReference);
          assert.equal(kitchenSource.items.length, items1.length);
          // The kitchen ticket's table label is the session's current table.
          const labels = await transactions().run((tx) =>
            listDiningSessionTableLabels(tx, scope, [dining.session.diningSessionReference]),
          );
          assert.equal(labels.get(dining.session.diningSessionReference), seatedLabel);
          const after = await queued();
          assert.equal(after.batches[0].acceptanceStatus, "Accepted");
          // Released: the round reads as in the kitchen, and nothing is left to warn about.
          assert.equal(after.batches[0].kitchenRelease, null);
          assert.equal(
            (
              await transactions().run((tx) =>
                listStorePaidOrderBatches(tx, scope, [orderReference]),
              )
            ).acceptedNotReleased.size,
            0,
          );
          assert.equal(after.summary.tableLabel, seatedLabel);
          // The table the party left waits for cleaning and holds nobody.
          const [left] = await one(
            "SELECT table_snapshot->>'activeDiningSessionReference' AS seated FROM rms_dining.dining_table WHERE table_id=$1",
            [variant === "MovedAwayAndBack" ? tableB : tableA],
          );
          assert.equal(left.seated, null);
          // Money: the round was paid once, for what it was sent at; nothing refunded or adjusted.
          const [paid] = await one(
            "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent WHERE order_id=$1) AS intents,(SELECT sum(total_minor)::text FROM rms_payment.payment_intent WHERE order_id=$1) AS total",
            [orderReference],
          );
          assert.deepEqual(paid, { intents: 1, total: String(roundTotal) });
          assert.equal(
            (
              await one(
                "SELECT table_snapshot->>'activeDiningSessionReference' AS seated FROM rms_dining.dining_table WHERE table_id=$1",
                [seatedAt],
              )
            )[0].seated,
            dining.session.diningSessionReference,
          );
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
