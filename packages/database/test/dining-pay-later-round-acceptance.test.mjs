import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { parseDiningSession } from "../../rms/dining/src/index.ts";
import {
  createOrderNumberAllocation,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPayLaterConfirmationStore,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createDiningPayLaterRound } from "../../../apps/api/src/dining-pay-later-round.ts";
import {
  createMerchantDiningTableBillRead,
  createMerchantDiningTableSettle,
} from "../../../apps/api/src/merchant-dining-table-checkout.ts";
import { createMerchantDiningUnpaidDeparture } from "../../../apps/api/src/merchant-dining-unpaid-departure.ts";
import { createMerchantDiningUnpaidItemRemoval } from "../../../apps/api/src/merchant-dining-unpaid-item-removal.ts";
import { createMerchantDiningServeCommand } from "../../../apps/api/src/merchant-dining-serve-command.ts";
import { createDiningTableOnlinePayments } from "../../../apps/api/src/dining-table-online-payment.ts";
import { createMerchantDiningOrderProgress } from "../../../apps/api/src/merchant-dining-order-progress.ts";
import { createMerchantDiningTableClosePlan } from "../../../apps/api/src/merchant-dining-table-close-plan.ts";
import { createKitchenInventoryConsumption } from "../../../apps/api/src/kitchen-inventory-consumption.ts";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";
import { createMerchantDiningClosingCommand } from "../../../apps/api/src/merchant-dining-closing-command.ts";
import { createDiningOrderCloseConfiguration } from "../../../apps/api/src/dining-order-close-configuration.ts";
import {
  assessOrderSettlement,
  createPostgresOrderFinancialPosition,
  createPostgresPaymentCaptureWindowSource,
} from "../../rms/payment/src/index.ts";
import { createPostgresOrderPricedAmountSource } from "../../rms/ordering/src/index.ts";
import { createPostgresStoreSalesPaymentLedger } from "../../rms/payment/src/index.ts";
import {
  createMerchantDiningTableCashRefund,
  createMerchantDiningTablePaymentRead,
} from "../../../apps/api/src/merchant-dining-table-payment.ts";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
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
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyQuote,
} from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a0fe00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER. A table opened "pay later" (the Store's setting when it was
 * opened, captured by Dining). Its first round (a guest's) and a later round (submitted through the
 * actual Ordering additional-round writer) each go straight to the kitchen when sent, under the
 * restricted NOBYPASSRLS API role holding the rendered pilot grants: the published dining
 * workflow's Accept for the System, Ordering's automatic acceptance with its revision and audit,
 * the pay-later confirmation, the OrderConfirmed event the kitchen takes, and the kitchen source
 * that event resolves to (both rounds). Sending again returns the same round; the round is never
 * closed as "not paid in time"; the records are append-only; another Store sees none of it.
 *
 * Not covered here: the guest and staff command steps before the submission (cart, quote,
 * checkout; unit-tested and covered by the dine-in journey and staff round acceptance tests).
 */
it("sends each round of a pay-later table to the kitchen unpaid, once; the table pays", () =>
  journey("Paid"));
// v15 2026-10-27 (DEMO-02): the guests left without paying — a manager writes the bill off and the
// table closes, then waits for cleaning; it can never be paid as well.
it("a table the guests left without paying is written off and closes", () => journey("WrittenOff"));
// S4 (decisions 3-5): a guest pays the whole table on their phone; staff can't take another
// payment meanwhile; a failed payment is tried again; staff stop one a guest gave up on.
it("a guest pays the whole table on their phone, once, split by round", () =>
  journey("PaidOnline"));

async function journey(ending) {
  await withIsolatedDatabase(
    {
      caseId:
        ending === "Paid"
          ? "wp2423_paylater"
          : ending === "WrittenOff"
            ? "wp2423_plwo"
            : "wp2423_plon",
    },
    async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const api = "wp2423_plr_" + context.runId,
        worker = "wp2423_plr_w_" + context.runId;
      assert.match(api, /^wp2423_plr_[a-f0-9]+$/u);
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
        const R1 = journeyRound({ at: time(-minutes(40)), prefix: "01a00011" });
        const tableGuest = id(0x602);
        const R2 = journeyRound({
          at: time(-minutes(5)),
          prefix: "01a00012",
          submitter: tableGuest,
        });
        const scope = R1.f.scope;
        const tenant = scope.brandReference.slice(0, 24) + "000000000900";
        const ownerScope = { tenantReference: tenant, ...scope };
        const orderReference = R1.f.request.record.order.orderReference;
        const guestSession = R1.f.request.record.guestSessionReference;

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
              const result = await work({ query: (sql, values) => client.query(sql, values) });
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
        const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

        // ── The Store opens tables "pay later" (its Owner's setting); the table is opened after.
        await admin.query(
          "INSERT INTO rms_dining.store_dining_payment_timing (tenant_id,brand_id,store_id,version,payment_timing,operation_id,intent_hash,actor_id,changed_at) VALUES ($1,$2,$3,1,'PayLater',$4,$5,$6,$7)",
          [
            tenant,
            scope.brandReference,
            scope.storeReference,
            id(0x50),
            "a".repeat(64),
            id(0x51),
            time(-minutes(60)),
          ],
        );
        const dining = await seedJourneyDining({
          client: admin,
          scope: ownerScope,
          round: R1,
          startedAt: time(-minutes(50)),
          guestParticipant: id(0x601),
          // The table closes in the write-off ending: seated as the real open moved it on.
          tableVersion: 2,
        });
        const sessionReference = dining.session.diningSessionReference;
        assert.deepEqual(
          await rows(
            "SELECT payment_timing FROM rms_dining.dining_session_payment_timing WHERE session_id=$1",
            [sessionReference],
          ),
          [{ payment_timing: "PayLater" }],
        );
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
          second: { idPrefix: "01909993-0000-7000-8000-", sessionReference: tableGuest },
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
        // The Store's published dine-in workflow (its Accept is what the System goes through).
        const inventoryWorkflow = await seedSubmissionInventoryWorkflow({
          runner: ownerRunner,
          scope: ownerScope,
          actorReference: guestSession,
          at: time(-minutes(48)),
          orderType: "DineIn",
        });

        // ── Round 1: the guest's first round, submitted (owner-seeded history), not paid.
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
          prefix: "01a10011",
        });

        // Each round is sent when it is submitted (round 1 at its own time in the fixture's past).
        let clock = time(-minutes(38));
        const payLater = createDiningPayLaterRound({
          scope: ownerScope,
          // The fixture's Orders are priced with Quote v1 (the pilot prices with v2).
          quoteVersion: 1,
          workflow: {
            purposeCode: inventoryWorkflow.payment.purposeCode,
            applicabilityCode: "DineIn",
            workflowVersionReference: inventoryWorkflow.payment.workflowVersionReference,
          },
          now: () => clock,
          generateReference: fresh,
        });
        const send = (submissionReference, actorReference, operationReference = fresh()) =>
          transactions().run((tx) =>
            payLater.confirm(tx, {
              submissionReference,
              actorReference,
              operationReference,
              correlationReference: operationReference,
              authorize: async () => true,
            }),
          );
        assert.equal(
          await transactions().run((tx) => payLater.isPayLater(tx, sessionReference)),
          true,
        );

        // The round is sent: the System's acceptance, its revision, the confirmation and the event.
        const sent1 = await send(r1.submissionReference, guestSession);
        assert.equal(sent1.status, "Confirmed");
        const c1 = sent1.confirmation;
        assert.equal(String(c1.orderBatchReference), R1.batch.orderBatchReference);
        assert.equal(String(c1.diningSessionReference), sessionReference);
        assert.equal(c1.acceptedOrderVersion, 2);
        assert.deepEqual(
          await rows(
            "SELECT actor_type,reason_code,accepted_order_version FROM rms_ordering.order_acceptance_record WHERE acceptance_id=$1",
            [c1.acceptanceReference],
          ),
          [
            {
              actor_type: "System",
              reason_code: "PAY_LATER_SENT_TO_KITCHEN",
              accepted_order_version: 2,
            },
          ],
        );
        assert.deepEqual(
          (
            await rows(
              "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
              [orderReference],
            )
          )[0],
          { version: 2 },
        );
        // Nothing was paid: no payment disposition, and the round still owes its items.
        assert.deepEqual(
          await rows(
            "SELECT 1 FROM rms_ordering.order_payment_disposition_record WHERE order_id=$1",
            [orderReference],
          ),
          [],
        );
        const event1 = await transactions({ guc: true }).run((tx) =>
          loadOutboxEnvelope(tx, c1.orderConfirmedEventReference),
        );
        assert.equal(event1.eventType, "OrderConfirmed");
        assert.equal(event1.causationId, c1.acceptanceReference);
        assert.equal(event1.aggregateVersion, 2n);
        assert.deepEqual(event1.actor, { type: "System" });
        assert.equal(event1.payload.orderBatchReference, R1.batch.orderBatchReference);
        assert.deepEqual(
          (
            await rows(
              "SELECT action_code,actor_type,retention_policy_code FROM platform_audit.audit_record WHERE target_id=$1 AND action_code IN ('ORDER_ACCEPTED','ORDER_PAY_LATER_SENT_TO_KITCHEN') ORDER BY action_code",
              [orderReference],
            )
          ).map((row) => [row.action_code, row.actor_type, row.retention_policy_code]),
          [
            ["ORDER_ACCEPTED", "System", "FINANCIAL_COMPLIANCE"],
            ["ORDER_PAY_LATER_SENT_TO_KITCHEN", "System", "FINANCIAL_COMPLIANCE"],
          ],
        );
        // Sent again (a retry, or another guest's tap): the same round, never a second acceptance.
        const again = await send(r1.submissionReference, guestSession);
        assert.equal(again.status, "AlreadyConfirmed");
        assert.equal(again.confirmation.confirmationReference, c1.confirmationReference);
        assert.equal(
          (
            await rows(
              "SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record WHERE order_id=$1",
              [orderReference],
            )
          )[0].n,
          1,
        );
        // What the round adds to the table's bill (tax included), from its own items.
        assert.equal(
          await transactions().run((tx) =>
            payLater.roundTotalMinor(tx, {
              orderReference,
              orderBatchReference: R1.batch.orderBatchReference,
              authorize: async () => true,
            }),
          ),
          items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
        );

        // ── The kitchen takes the round from its OrderConfirmed event (the source it resolves to).
        const kitchenSource = (confirmation, event) =>
          transactions().run((tx) =>
            createPostgresOrderKitchenSourceStore({
              ...scope,
              quoteVersion: 1,
              sha256,
              authorize: async () => true,
            }).resolve({
              transaction: tx,
              query: {
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                orderReference,
                orderBatchReference: String(confirmation.orderBatchReference),
                confirmationReference: String(confirmation.confirmationReference),
                sourceEventReference: event.eventId,
                sourceAggregateVersion: event.aggregateVersion,
                sourceSnapshotDigest: String(confirmation.sourceSnapshotDigest),
                observedAt: now(),
              },
            }),
          );
        const source1 = await kitchenSource(c1, event1);
        assert.ok(source1, "the kitchen resolves the first pay-later round");
        assert.equal(String(source1.orderBatchReference), R1.batch.orderBatchReference);

        // ── S2: the table checks out and pays once (DEC-DINE-IN-PAY-LATER rules 3, 6).
        const provider = id(0x1);
        const staffPermissions = [
          "ordering.order.create_staff",
          "dining.operate",
          "dining.session.close",
          "order.close",
          "ordering.order.cancel",
          "dining.item.serve",
        ];
        const server = await seedMerchantAcceptanceSession({
          admin,
          runner: transactions(),
          scope: ownerScope,
          actor: id(0x700),
          at: now(),
          extraPermissions: staffPermissions,
        });
        const manager = await seedMerchantAcceptanceSession({
          admin,
          runner: transactions(),
          scope: ownerScope,
          actor: id(0x701),
          at: now(),
          extraPermissions: [...staffPermissions, "payment.refund.approve"],
          referencePrefix: "01909966",
          sessionReferencePrefix: "01909965",
        });
        const as = (who) => ({ sessionCookie: who.sessionCookie, csrf: who.csrf });
        const persistenceOf = (who) => ({ ...who.persistence, now });
        const bill = (who = server) =>
          createMerchantDiningTableBillRead({
            persistence: persistenceOf(who),
            authentication: who.authentication,
          })({ ...as(who), query: { diningSessionReference: sessionReference } });
        const settleWith = (who, command) =>
          createMerchantDiningTableSettle({
            persistence: persistenceOf(who),
            authentication: who.authentication,
            environment: "Test",
            nextReference: fresh,
          })({
            ...as(who),
            command: {
              operationReference: fresh(),
              diningSessionReference: sessionReference,
              method: "Cash",
              tip: { kind: "Percent", percent: 15 },
              tenderedMinor: "100000",
              slipReference: null,
              recordedAfterOutage: false,
              takenAt: null,
              ...command,
            },
          });
        const departure = (who, expectedOrderVersion) =>
          createMerchantDiningUnpaidDeparture({
            persistence: persistenceOf(who),
            authentication: who.authentication,
            resolveConfiguration: createDiningOrderCloseConfiguration({
              ...ownerScope,
              providerAccountReference: provider,
              environment: "Test",
            }),
            newReference: fresh,
            audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
          })({
            ...as(who),
            command: {
              orderReference,
              operationReference: fresh(),
              expectedOrderVersion,
              expectedClosureVersion: 0,
            },
          });

        // The table's checkout (Dining's closing command, as the merchant API composes it).
        const closing = (who, action) =>
          rows("SELECT version FROM rms_dining.dining_session WHERE session_id=$1", [
            sessionReference,
          ]).then(([row]) =>
            createMerchantDiningClosingCommand({
              // As the pilot composes it: with the Store's exception Task policy, so closing uses
              // the general evidence (unresolved money needs a manager Task). Its content is read
              // only when a Task must be opened, which none of these tables needs (test-only).
              exceptionTaskPolicy: { synthetic: "test-only exception task policy" },
              persistence: persistenceOf(who),
              authentication: who.authentication,
              providerAccountReference: provider,
              environment: "Test",
              newReference: fresh,
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            })({
              ...as(who),
              command: {
                action,
                diningSessionReference: sessionReference,
                operationReference: fresh(),
                expectedSessionVersion: Number(row.version),
              },
            }),
          );
        // ── Checkout started, then cancelled: the guests want more (DEC rule 3). Back to Active,
        // recorded with who did it; then the table orders round 2 and checkout starts again.
        assert.equal((await closing(server, "Begin")).phase, "Closing");
        const reopened = await closing(server, "Cancel");
        assert.equal(reopened.phase, "Active");
        assert.deepEqual(
          await rows(
            "SELECT actor_reference::text AS actor FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_CLOSING_CANCEL' AND target_id=$1",
            [sessionReference],
          ),
          [{ actor: id(0x700) }],
        );
        assert.equal(
          (
            await rows(
              "SELECT session_snapshot->>'phase' AS phase FROM rms_dining.dining_session WHERE session_id=$1",
              [sessionReference],
            )
          )[0].phase,
          "Active",
        );

        // ── Round 2: the table guest's later round through the actual Ordering writer.
        await seedSubmissionCart(admin, R2.f);
        const liveSession = parseDiningSession(
          (
            await rows(
              "SELECT session_snapshot FROM rms_dining.dining_session WHERE session_id=$1",
              [sessionReference],
            )
          )[0].session_snapshot,
        );
        const link2 = await dining.prepare(R2, {
          currentSession: liveSession,
          paymentOperationReference: id(0x2010),
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
          diningSessionReference: sessionReference,
          guestSessionReference: tableGuest,
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
          prefix: "01a10012",
        });
        const submitted = await transactions().run((tx) =>
          createCustomerAdditionalDiningSubmissionStore({
            ...scope,
            authorize: async (_tx, candidate) =>
              [guestSession, tableGuest].includes(candidate.guestSessionReference),
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
            eventReference: fresh,
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
                        request.actorReference === tableGuest
                          ? guestSession
                          : request.actorReference,
                    }),
                },
              },
              authorize: async (_tx, input) =>
                [guestSession, tableGuest].includes(input.actorReference),
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

        clock = now();
        const sent2 = await send(R2.batch.submissionReference, tableGuest);
        assert.equal(sent2.status, "Confirmed");
        const c2 = sent2.confirmation;
        assert.equal(String(c2.orderBatchReference), R2.batch.orderBatchReference);
        const event2 = await transactions({ guc: true }).run((tx) =>
          loadOutboxEnvelope(tx, c2.orderConfirmedEventReference),
        );
        assert.equal(event2.causationId, c2.acceptanceReference);
        const source2 = await kitchenSource(c2, event2);
        assert.ok(source2, "the kitchen resolves the later pay-later round");
        assert.equal(String(source2.orderBatchReference), R2.batch.orderBatchReference);

        // ── S3 (rule 2): a dish comes off the unpaid bill before the table pays — who and why, as
        // an append-only cancellation on the 'PayLater' basis; the table is never charged for it.
        const removal = (who, command) =>
          createMerchantDiningUnpaidItemRemoval({
            persistence: persistenceOf(who),
            authentication: who.authentication,
            nextReference: fresh,
            installContext: async (tx, selected) => {
              await tx.query(
                "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                [selected.tenantReference, selected.brandReference, selected.storeReference],
              );
            },
          })({
            ...as(who),
            command: {
              orderReference,
              orderBatchReference: R2.batch.orderBatchReference,
              orderItemReferences: [String(items2[0].orderItemReference)],
              reasonCode: "CUSTOMER_REQUEST",
              ...command,
            },
          });
        const versionNow = async () =>
          Number(
            (
              await rows(
                "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
                [orderReference],
              )
            )[0].version,
          );
        const removeOperation = fresh();
        const beforeRemoval = await versionNow();
        // Without the cancel permission nothing is written.
        const outsider = await seedMerchantAcceptanceSession({
          admin,
          runner: transactions(),
          scope: ownerScope,
          actor: id(0x702),
          at: now(),
          extraPermissions: ["dining.operate"],
          referencePrefix: "01909964",
          sessionReferencePrefix: "01909963",
        });
        await assert.rejects(
          removal(outsider, { expectedOrderVersion: beforeRemoval, operationReference: fresh() }),
          { code: "UNPAID_ITEM_REMOVAL_PERMISSION_DENIED" },
        );
        // A stale Order version is refused.
        await assert.rejects(
          removal(server, { expectedOrderVersion: beforeRemoval - 1, operationReference: fresh() }),
          { code: "UNPAID_ITEM_REMOVAL_VERSION_CONFLICT" },
        );
        const removed = await removal(server, {
          expectedOrderVersion: beforeRemoval,
          operationReference: removeOperation,
        });
        assert.equal(removed.status, "Removed");
        assert.equal(removed.cancelledOrderVersion, beforeRemoval + 1);
        // The same command again returns that removal; nothing is written twice.
        assert.equal(
          (
            await removal(server, {
              expectedOrderVersion: beforeRemoval,
              operationReference: removeOperation,
            })
          ).status,
          "AlreadyRemoved",
        );
        assert.deepEqual(
          await rows(
            "SELECT basis,reason_code,actor_id::text AS actor,payment_disposition_id,refund_request_id FROM rms_ordering.order_item_staff_cancellation WHERE order_id=$1",
            [orderReference],
          ),
          [
            {
              basis: "PayLater",
              reason_code: "CUSTOMER_REQUEST",
              actor: id(0x700),
              payment_disposition_id: null,
              refund_request_id: null,
            },
          ],
        );
        assert.equal(
          (
            await rows(
              "SELECT count(*)::int AS n FROM rms_ordering.order_revision WHERE order_id=$1 AND version=$2 AND kind='StaffItemCancellation'",
              [orderReference, beforeRemoval + 1],
            )
          )[0].n,
          1,
        );
        assert.equal(
          (
            await rows(
              "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORDER_ITEMS_REMOVED_FROM_UNPAID_BILL'",
            )
          )[0].n,
          1,
        );
        // Round 2's only dish came off: the whole round is off the bill (it owes nothing).
        assert.equal(items2.length, 1);
        const removedMinor = items2[0].pricing.total.amountMinor;
        // Paying before checkout started is refused: rounds can still be added.
        await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_NOT_STARTED" });
        // Checkout starts again with round 2 on the table.
        const begun = await closing(server, "Begin");
        assert.equal(begun.phase, "Closing");

        // The bill: round 1 owed with its items, before tax, tax and total; round 2 owes nothing.
        const round1Minor = items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
        const round2Minor =
          items2.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) - removedMinor;
        assert.equal(round2Minor, 0n);
        const open = await bill();
        assert.equal(open.paymentTiming, "PayLater");
        assert.equal(open.sessionPhase, "Closing");
        assert.equal(open.consistent, true);
        assert.deepEqual(
          open.rounds.map((round) => [round.roundNumber, round.totalMinor, round.paid]),
          [
            [1, round1Minor.toString(), false],
            [2, "0", false],
          ],
        );
        assert.equal(open.owed.totalMinor, (round1Minor + round2Minor).toString());
        assert.equal(open.settlement, null);
        const orderVersion = Number(
          (
            await rows(
              "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
              [orderReference],
            )
          )[0].version,
        );
        // "Left without paying" is a manager's decision; a server is refused, nothing written.
        await assert.rejects(departure(server, orderVersion), {
          code: "UNPAID_DEPARTURE_PERMISSION_DENIED",
        });
        // A manager can't write off a table whose dishes are not all served or resolved yet.
        await assert.rejects(departure(manager, orderVersion), (error) => {
          assert.equal(error.code, "UNPAID_DEPARTURE_NOT_READY");
          assert.ok(error.reasons.includes("EXECUTION_NOT_FINAL"), String(error.reasons));
          return true;
        });
        assert.deepEqual(
          await rows("SELECT 1 FROM rms_payment.order_unpaid_write_off WHERE order_id=$1", [
            orderReference,
          ]),
          [],
        );
        /**
         * The guests left without paying. The kitchen makes and staff serve round 1 (round 2 came
         * off the bill), a manager records the departure — Payment writes off exactly what is owed
         * and the Order closes on it — the bill and the close check say so, and the table closes
         * and waits for cleaning. The table can never be paid as well (2000_101).
         */
        async function writtenOffEnding() {
          // ── Kitchen: round 1's ticket, one queued work item per dish (test-only owner seed, as
          // the dine-in item cancellation acceptance seeds it), whose source evidence is the real
          // Ordering kitchen source of the pay-later round as it is now.
          const sourceQuery = {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            orderReference,
            orderBatchReference: String(c1.orderBatchReference),
            confirmationReference: String(c1.confirmationReference),
            sourceEventReference: event1.eventId,
            sourceAggregateVersion: event1.aggregateVersion,
            sourceSnapshotDigest: String(c1.sourceSnapshotDigest),
          };
          const sourceStore = createPostgresOrderKitchenSourceStore({
            ...scope,
            quoteVersion: 1,
            sha256,
            authorize: async () => true,
          });
          const issued = await transactions().run((tx) =>
            sourceStore.resolve({ transaction: tx, query: { ...sourceQuery, observedAt: now() } }),
          );
          assert.ok(issued);
          const kitchenAt = now();
          const ticket = fresh(),
            evidence = fresh(),
            plan = fresh(),
            correlation = fresh();
          await admin.query(
            "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,$17,$8,$9,$10,$11,$12,1,$13,$9,$15,1,$16,$14,1,'Open','System','System',$14,$14)",
            [
              ticket,
              scope.brandReference,
              scope.storeReference,
              orderReference,
              R1.batch.orderBatchReference,
              String(c1.confirmationReference),
              event1.eventId,
              String(c1.sourceSnapshotDigest),
              String(c1.confirmedAt),
              correlation,
              sha256("binding:" + ticket),
              evidence,
              issued.evidenceDigest,
              kitchenAt,
              plan,
              sha256("plan:" + ticket),
              event1.aggregateVersion,
            ],
          );
          const workItems = items1.map(() => fresh());
          for (const [j, item] of items1.entries())
            await admin.query(
              "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',$11,0,$12,$13,$14,$15,$16::jsonb,'[]'::jsonb,$17,$18,$19,1,$20,$21,1,$22,$23::jsonb,$24,'System','System',$25,$25)",
              [
                workItems[j],
                scope.brandReference,
                scope.storeReference,
                ticket,
                orderReference,
                R1.batch.orderBatchReference,
                String(item.orderItemReference),
                evidence,
                plan,
                j + 1,
                item.quantity,
                fresh(),
                fresh(),
                fresh(),
                fresh(),
                JSON.stringify({ "en-CA": "Synthetic dish " + (j + 1) }),
                sha256("line:" + j),
                fresh(),
                fresh(),
                sha256("routing"),
                fresh(),
                sha256("preparation"),
                JSON.stringify(["Synthetic preparation"]),
                sha256("execution:" + j),
                kitchenAt,
              ],
            );
          // ── The kitchen accepts, starts and completes each dish (the pilot kitchen lifecycle,
          // its current-source check over the real Ordering kitchen source); synthetic admission
          // and Expo decisions, as in the pilot kitchen command.
          const issuedSourceIsCurrent = async (tx) =>
            (
              await sourceStore.resolveIssued({
                transaction: tx,
                query: { ...sourceQuery, observedAt: new Date().toISOString() },
              })
            ).evidenceDigest === issued.evidenceDigest;
          const kitchenReferences = {
            next: fresh,
            derive(purpose, identity) {
              const digest = createHash("sha256")
                .update(purpose + identity)
                .digest("hex");
              return (
                "0190abcf-" +
                digest.slice(0, 4) +
                "-7" +
                digest.slice(4, 7) +
                "-8" +
                digest.slice(7, 10) +
                "-" +
                digest.slice(10, 22)
              );
            },
          };
          const cook = id(0x720);
          let active = null;
          const kitchenRunner = transactions({ guc: true });
          const kitchen = createKitchenWorkLifecycleService({
            trustedContext: {
              resolveAuthority: async () => ({
                actorReference: cook,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                observedAt: new Date().toISOString(),
              }),
            },
            correlationContext: { resolve: async () => ({ correlationReference: correlation }) },
            authorization: { authorize: async () => true },
            transactions: { withTransaction: (work) => kitchenRunner.run(work) },
            tenantContext: { install: async () => undefined },
            idempotency: {
              acquireFence: async ({ transaction, idempotencyKey }) => {
                await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                  scope.brandReference + ":" + scope.storeReference + ":" + idempotencyKey,
                ]);
              },
            },
            repository: createPostgresKitchenWorkLifecycleStore({
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              references: kitchenReferences,
              digests: { sha256 },
              authorize: async () => true,
              validateCurrentSource: (transaction) => issuedSourceIsCurrent(transaction),
            }),
            references: kitchenReferences,
            digests: { sha256 },
            clock: { now: () => new Date().toISOString() },
            admission: {
              resolve: async ({ command, acceptedOperationReference }) => ({
                decisionReference: fresh(),
                decisionVersion: 1,
                decisionDigest: sha256("synthetic admission"),
                producerContractVersion: 1,
                actorReference: command.actorReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                ticketReference: command.ticketReference,
                workItemReference: command.workItemReference,
                acceptedOperationReference,
                ticketVersion: BigInt(command.expectedTicketVersion),
                workItemVersion: BigInt(command.expectedWorkItemVersion),
                action: "StartKitchenWorkItem",
                purpose: "KitchenWorkExecution",
                outcome: "Allowed",
                evaluatedAt: new Date().toISOString(),
                validUntil: new Date(Date.now() + minutes(60)).toISOString(),
              }),
            },
            expo: {
              resolve: async () => ({
                decisionReference: fresh(),
                decisionVersion: 1,
                decisionDigest: sha256("synthetic Expo"),
                producerContractVersion: 1,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                purpose: "KitchenReadiness",
                mode: "Disabled",
                evaluatedAt: new Date().toISOString(),
                validUntil: new Date(Date.now() + minutes(60)).toISOString(),
              }),
            },
          });
          for (const [j, item] of items1.entries()) {
            const step = async (action, extra = {}) => {
              const [versions] = await rows(
                "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
                [workItems[j]],
              );
              active = {
                action,
                idempotencyKey: "pay-later-write-off-" + workItems[j] + "-" + action,
                actorReference: cook,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                ticketReference: ticket,
                workItemReference: workItems[j],
                orderItemReference: String(item.orderItemReference),
                expectedTicketVersion: versions.ticket,
                expectedWorkItemVersion: versions.item,
                correlationReference: correlation,
                ...extra,
              };
              return kitchen.execute(active);
            };
            assert.equal((await step("AcceptKitchenWorkItem")).outcome, "Accepted");
            assert.equal((await step("StartKitchenWorkItem")).outcome, "Started");
            assert.match(
              (await step("CompleteKitchenWorkItem", { quantityDelta: item.quantity })).outcome,
              /^Completed/u,
            );
          }
          void active;
          // Inventory uses the dishes from the Kitchen lifecycle Events (as the pilot consumers do).
          const consume = createKitchenInventoryConsumption({
            scope: ownerScope,
            nextReference: fresh,
            authorize: async () => true,
            retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
          });
          for (const event of await rows(
            "SELECT event_id::text AS id FROM platform_eventing.outbox_event WHERE event_type IN ('KitchenWorkStarted','KitchenItemCompleted') AND payload_json->>'orderReference'=$1 ORDER BY occurred_at,event_id",
            [orderReference],
          ))
            await transactions({ guc: true }).run(async (tx) =>
              consume(tx, await loadOutboxEnvelope(tx, event.id)),
            );

          // ── Staff serve round 1 while the table is checking out.
          const progress = () =>
            createMerchantDiningOrderProgress({
              persistence: persistenceOf(server),
              locale: "en-CA",
              authentication: server.authentication,
            })({ ...as(server), query: { orderReference } });
          const ready = await progress();
          const serve = createMerchantDiningServeCommand({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            reference: fresh,
            audit: {
              reasonCode: "DINING_ITEM_SERVED",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            },
          });
          for (const item of items1)
            await serve({
              ...as(server),
              command: {
                operationReference: fresh(),
                orderReference,
                orderItemReference: String(item.orderItemReference),
                quantity: item.quantity,
                expectedOrderVersion: ready.currentOrderVersion,
                expectedItemServiceVersion: 0,
                expectedSessionVersion: ready.sessionVersion,
                expectedTableAssignmentVersion: ready.tableAssignmentVersion,
              },
            });
          const served = await progress();
          // Round 1 served; round 2's dishes, taken off the bill before the table paid, are cancelled.
          assert.deepEqual(
            served.items.map((item) => [item.batchSequence, item.phase]),
            [
              [1, "Fulfilled"],
              [2, "Cancelled"],
            ],
          );

          // A write-off is exactly what is owed (Payment's own check), never a guess.
          await assert.rejects(
            admin.query(
              "INSERT INTO rms_payment.order_unpaid_write_off (write_off_id,tenant_id,brand_id,store_id,operation_id,dining_session_id,order_id,order_version,order_checkpoint,reason_code,currency_code,priced_order_total_minor,captured_order_allocation_minor,written_off_minor,requested_by_actor_id,approved_by_actor_id,order_evidence_digest,payment_evidence_digest,decided_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,2,$8,'GUEST_LEFT_UNPAID','CAD',1000,0,999,$9,$9,$10,$10,now(),$11)",
              [
                fresh(),
                tenant,
                scope.brandReference,
                scope.storeReference,
                fresh(),
                sessionReference,
                orderReference,
                fresh(),
                id(0x701),
                "sha256:" + "b".repeat(64),
                fresh(),
              ],
            ),
            /order_unpaid_write_off_amount/u,
          );

          // ── The guests left without paying: the manager records it; Payment writes off what is
          // owed and the Order closes on it.
          const left = await departure(manager, served.currentOrderVersion);
          assert.ok(left);
          const [writeOff] = await rows(
            "SELECT written_off_minor::text AS amount,approved_by_actor_id::text AS manager FROM rms_payment.order_unpaid_write_off WHERE order_id=$1",
            [orderReference],
          );
          assert.deepEqual(writeOff, { amount: round1Minor.toString(), manager: id(0x701) });
          // The day's sales ledger keeps it on its own line (decision 4): never collected.
          const day = await transactions().run((tx) =>
            createPostgresStoreSalesPaymentLedger({
              scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
              authorize: async () => true,
            })(tx, {
              startsAt: time(-minutes(120)),
              endsAt: new Date(Date.now() + 1000).toISOString(),
              observedAt: new Date(Date.now() + 1000).toISOString(),
            }),
          );
          assert.deepEqual(
            day.unpaidWriteOffs.map((entry) => [entry.orderReference, entry.amountMinor]),
            [[orderReference, round1Minor]],
          );
          assert.equal(day.settlement.cashTaken.count, 0);
          // The bill says written off and takes no payment.
          const afterBill = await bill();
          assert.deepEqual(afterBill.writeOff, {
            amountMinor: round1Minor.toString(),
            decidedAt: afterBill.writeOff?.decidedAt,
          });
          assert.equal(afterBill.settlement, null);
          await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_ALREADY_PAID" });
          // Nor can a payment be recorded for it directly (2000_101).
          await assert.rejects(
            admin.query(
              "INSERT INTO rms_payment.dining_table_settlement (settlement_id,tenant_id,brand_id,store_id,operation_id,intent_digest,dining_session_id,order_id,method,rounds_minor,tip_minor,rounding_minor,total_minor,currency_code,payment_environment,recording_reason,taken_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CardMachine',100,0,0,100,'CAD','Test','AtTable',date_trunc('milliseconds',now()),date_trunc('milliseconds',now()),$9,$10)",
              [
                fresh(),
                tenant,
                scope.brandReference,
                scope.storeReference,
                fresh(),
                "sha256:" + "c".repeat(64),
                sessionReference,
                orderReference,
                id(0x700),
                fresh(),
              ],
            ),
            /written off/u,
          );
          // The close check no longer says the table hasn't paid: nothing stops it from closing.
          const closePlan = await createMerchantDiningTableClosePlan({
            persistence: persistenceOf(manager),
            authentication: manager.authentication,
            resolveRefundConfiguration: async () => ({
              providerAccountReference: provider,
              environment: "Test",
            }),
          })({
            ...as(manager),
            query: { orderReference, diningSessionReference: sessionReference },
          });
          assert.deepEqual(closePlan.closeBlockers, []);
          // ── The table closes and waits for cleaning.
          assert.equal((await closing(manager, "Finalize")).phase, "Closed");
          const [table] = await rows(
            "SELECT t.table_snapshot->>'operationalState' AS state,t.table_snapshot->>'blockReasonCode' AS reason FROM rms_dining.dining_table t JOIN rms_dining.dining_session s ON s.table_id=t.table_id WHERE s.session_id=$1",
            [sessionReference],
          );
          assert.deepEqual(table, { state: "TemporarilyBlocked", reason: "CLEANING" });
        }
        /**
         * S4: the guest pays the whole table on their phone. The Provider is a test-only stand-in
         * (Stripe's normalized answers; the test decides each outcome); everything else is the
         * real composition under the restricted role.
         */
        async function paidOnlineEnding() {
          const intents = new Map();
          let created = 0;
          const answer = (request, intent) => ({
            kind: "Snapshot",
            context: request.context,
            providerIntentReference: intent.reference,
            providerTransactionReference: intent.status === "Captured" ? intent.transaction : null,
            paymentMethod: "OnlineCard",
            captureMode: "Automatic",
            status: intent.status,
            requestedAmount: intent.amount,
            authorizedAmount:
              intent.status === "Captured"
                ? intent.amount
                : { amountMinor: 0n, currencyCode: "CAD" },
            capturedAmount:
              intent.status === "Captured"
                ? intent.amount
                : { amountMinor: 0n, currencyCode: "CAD" },
            refundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
            observedAt: new Date().toISOString(),
            evidenceDigest: sha256("intent:" + intent.reference + ":" + intent.status),
          });
          const stripe = {
            async createIntent(request) {
              const known = intents.get(request.idempotencyKey);
              if (known) return answer(request, known);
              const intent = {
                reference: "pi_TEST" + String(++created).padStart(6, "0"),
                transaction: "ch_TEST" + String(created).padStart(6, "0"),
                status: "RequiresCustomerAction",
                amount: request.amount,
              };
              intents.set(request.idempotencyKey, intent);
              intents.set(intent.reference, intent);
              return answer(request, intent);
            },
            async retrieveIntent(request) {
              return answer(request, intents.get(String(request.providerIntentReference)));
            },
            async cancelIntent(request) {
              const intent = intents.get(String(request.providerIntentReference));
              if (intent.status === "RequiresCustomerAction") intent.status = "Cancelled";
              return answer(request, intent);
            },
          };
          const payments = createDiningTableOnlinePayments({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            provider: stripe,
            transactions: transactions(),
            now,
            nextReference: fresh,
          });
          const guestAt = (guestSessionReference) => ({
            diningSessionReference: sessionReference,
            guestSessionReference,
            allowed: async () => true,
          });
          const me = guestAt(guestSession),
            other = guestAt(tableGuest);
          const fifteen = { kind: "Percent", percent: 15 };
          const subtotalMinor = BigInt(open.owed.subtotalMinor);
          const tipMinor = (subtotalMinor * 15n + 50n) / 100n;
          const due = round1Minor + tipMinor;
          const attempts = () =>
            rows(
              "SELECT p.total_minor::text AS total,p.tip_minor::text AS tip,o.status FROM rms_payment.dining_table_online_payment p LEFT JOIN rms_payment.dining_table_online_payment_outcome o ON o.online_payment_id=p.online_payment_id WHERE p.order_id=$1 ORDER BY p.created_at,p.online_payment_id",
              [orderReference],
            );

          // ── The guest starts paying the bill as it stands with a 15 % tip, chosen once.
          const firstOperation = fresh();
          const started = await payments.start(me, {
            operationReference: firstOperation,
            tip: fifteen,
          });
          assert.equal(started.attempt?.totalMinor, due.toString());
          assert.equal(started.attempt?.mine, true);
          // The same request again comes back to the same payment (nothing new with the Provider).
          await payments.start(me, { operationReference: firstOperation, tip: fifteen });
          assert.equal(created, 1);
          assert.deepEqual(await attempts(), [
            { total: due.toString(), tip: tipMinor.toString(), status: null },
          ]);

          // ── While the guest pays, nothing else is taken for the table.
          await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_GUEST_PAYING" });
          await assert.rejects(
            admin.query(
              "INSERT INTO rms_payment.dining_table_settlement (settlement_id,tenant_id,brand_id,store_id,operation_id,intent_digest,dining_session_id,order_id,method,rounds_minor,tip_minor,rounding_minor,total_minor,currency_code,payment_environment,recording_reason,taken_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CardMachine',100,0,0,100,'CAD','Test','AtTable',date_trunc('milliseconds',now()),date_trunc('milliseconds',now()),$9,$10)",
              [
                fresh(),
                tenant,
                scope.brandReference,
                scope.storeReference,
                fresh(),
                "sha256:" + "c".repeat(64),
                sessionReference,
                orderReference,
                id(0x700),
                fresh(),
              ],
            ),
            /paying for the table on their phone/u,
          );
          await assert.rejects(departure(manager, orderVersion), {
            code: "UNPAID_DEPARTURE_GUEST_PAYING",
          });
          await assert.rejects(closing(server, "Cancel"), {
            code: "DINING_CHECKOUT_GUEST_PAYING",
          });
          // Another guest at the table can't start a second payment.
          await assert.rejects(
            payments.start(other, { operationReference: fresh(), tip: fifteen }),
            {
              code: "TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING",
            },
          );
          const bill1 = await bill();
          assert.equal(bill1.onlinePayment?.status, "InProgress");

          // ── The card is declined: recorded as failed; the guest tries again (a new payment).
          intents.get("pi_TEST000001").status = "Failed";
          const failedView = await payments.refresh(me);
          assert.equal(failedView.attempt, null);
          assert.equal(failedView.bill.onlinePayment?.status, "Failed");
          await payments.start(me, { operationReference: fresh(), tip: fifteen });
          assert.equal(created, 2);

          // ── The guest gives up; staff stop the phone payment (cancelled with the Provider,
          // recorded with who stopped it), so the table could be paid another way.
          const stopped = await payments.stop(me, id(0x700));
          assert.equal(stopped.bill.onlinePayment?.status, "Cancelled");
          assert.equal(intents.get("pi_TEST000002").status, "Cancelled");
          assert.deepEqual(
            await rows(
              "SELECT actor_reference::text AS actor FROM platform_audit.audit_record WHERE action_code='PAYMENT_DINING_TABLE_ONLINE_CANCELLED' AND target_id=$1",
              [orderReference],
            ),
            [{ actor: id(0x700) }],
          );

          // ── The guest comes back and pays: captured → the table's one payment, by round.
          await payments.start(me, { operationReference: fresh(), tip: fifteen });
          intents.get("pi_TEST000003").status = "Captured";
          const paidView = await payments.refresh(me);
          assert.equal(paidView.bill.settlement?.method, "Online");
          assert.equal(paidView.bill.settlement?.totalMinor, due.toString());
          assert.equal(paidView.bill.settlement?.tipMinor, tipMinor.toString());
          assert.deepEqual(
            (await attempts()).map((attempt) => attempt.status),
            ["Failed", "Cancelled", "Captured"],
          );
          assert.deepEqual(
            await rows(
              "SELECT r.line_number,r.order_batch_id::text AS batch,r.round_minor::text AS round,r.tip_minor::text AS tip,s.method,s.online_payment_id IS NOT NULL AS online FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id WHERE s.order_id=$1 ORDER BY r.line_number",
              [orderReference],
            ),
            [
              {
                line_number: 1,
                batch: R1.batch.orderBatchReference,
                round: round1Minor.toString(),
                tip: tipMinor.toString(),
                method: "Online",
                online: true,
              },
            ],
          );
          // Refreshing again records nothing twice; a paid table never goes back to ordering.
          await payments.refresh(me);
          assert.equal(
            (
              await rows("SELECT 1 FROM rms_payment.dining_table_settlement WHERE order_id=$1", [
                orderReference,
              ])
            ).length,
            1,
          );
          await assert.rejects(closing(server, "Cancel"), { code: "DINING_CHECKOUT_ALREADY_PAID" });
          await assert.rejects(payments.start(me, { operationReference: fresh(), tip: fifteen }), {
            code: "TABLE_ONLINE_PAYMENT_ALREADY_PAID",
          });
          // Payment counts the table as paid (the Order can close as usual).
          const settledNow = await transactions().run(async (tx) => {
            const at = now();
            const financial = await createPostgresOrderFinancialPosition({
              scope: ownerScope,
              providerAccountReference: provider,
              environment: "Test",
              authorize: async () => true,
            })(tx, { orderReference, observedAt: at });
            const priced = await createPostgresOrderPricedAmountSource({
              ...scope,
              authorize: async () => true,
            })(tx, { orderReference, observedAt: at });
            return assessOrderSettlement({
              currencyCode: "CAD",
              pricedOrderTotalMinor: priced.pricedTotalMinor,
              capturedMinor: financial.settlement.capturedMinor,
              capturedOrderAllocationMinor: financial.settlement.capturedOrderAllocationMinor,
              capturedTipMinor: financial.settlement.capturedTipMinor,
              confirmedRefundMinor: financial.settlement.confirmedRefundMinor,
              refundAllocation: financial.settlement.refundAllocation,
              pendingRefundMinor: financial.settlement.pendingRefundMinor,
              unresolvedAttemptCount: financial.unresolvedAttemptCount,
              pendingAmendmentCount: priced.pendingAmendmentCount,
            });
          });
          assert.equal(settledNow.classification, "Settled");

          // ── Reports and reconciliation: one online payment (one Provider transaction).
          const window = {
            startsAt: time(-minutes(120)),
            endsAt: new Date(Date.now() + 1000).toISOString(),
            observedAt: new Date(Date.now() + 1000).toISOString(),
          };
          const day = await transactions().run((tx) =>
            createPostgresStoreSalesPaymentLedger({
              scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
              authorize: async () => true,
            })(tx, window),
          );
          assert.deepEqual(
            day.payments
              .filter((payment) => payment.orderReference === orderReference)
              .map((payment) => [payment.channel, payment.totalMinor, payment.paymentCount]),
            [["Online", due, 1]],
          );
          assert.deepEqual(day.settlement.onlineCaptured, { count: 1, amountMinor: due });
          assert.equal(day.settlement.cardMachineTaken.count, 0);
          const captures = await transactions().run((tx) =>
            createPostgresPaymentCaptureWindowSource({
              scope: { ...scope, providerAccountReference: provider, environment: "Test" },
              authorize: async () => true,
            })(tx, window),
          );
          assert.deepEqual([captures.captureCount, captures.capturedAmountMinor], [1, due]);
        }
        if (ending === "WrittenOff") {
          await writtenOffEnding();
          return;
        }
        if (ending === "PaidOnline") {
          await paidOnlineEnding();
          return;
        }

        // Cash short of the rounded total is refused; nothing recorded.
        await assert.rejects(settleWith(server, { tenderedMinor: "100" }), {
          code: "TABLE_CHECKOUT_TENDER_SHORT",
        });
        // Cash: 15 % tip on the bill before tax, rounded to 5 cents, change given.
        const subtotalMinor = BigInt(open.owed.subtotalMinor);
        const tipMinor = (subtotalMinor * 15n + 50n) / 100n;
        const due = round1Minor + round2Minor + tipMinor;
        const digit = due % 10n;
        const rounding =
          digit === 0n || digit === 5n
            ? 0n
            : digit <= 2n
              ? -digit
              : digit <= 7n
                ? 5n - digit
                : 10n - digit;
        const operation = fresh();
        const paid = await settleWith(server, { operationReference: operation });
        assert.equal(paid.status, "Recorded");
        assert.deepEqual(paid.bill.settlement, {
          method: "Cash",
          roundsMinor: (round1Minor + round2Minor).toString(),
          tipMinor: tipMinor.toString(),
          roundingMinor: rounding.toString(),
          totalMinor: (due + rounding).toString(),
          tenderedMinor: "100000",
          changeMinor: (100000n - due - rounding).toString(),
          recordedAt: paid.bill.settlement.recordedAt,
          recordedAfterOutage: false,
        });
        assert.deepEqual(
          paid.bill.rounds.map((round) => round.paid),
          // The round taken off the bill is never a payment line.
          [true, false],
        );
        assert.equal(paid.bill.owed.totalMinor, "0");
        // A paid table can't go back to ordering: it pays once and its payment never changes.
        await assert.rejects(closing(server, "Cancel"), { code: "DINING_CHECKOUT_ALREADY_PAID" });
        // Once the table paid, no dish comes off its bill (it is refunded from the payment instead).
        await assert.rejects(
          removal(server, {
            orderBatchReference: R1.batch.orderBatchReference,
            orderItemReferences: [String(items1[0].orderItemReference)],
            expectedOrderVersion: await versionNow(),
            operationReference: fresh(),
          }),
          { code: "UNPAID_ITEM_REMOVAL_ALREADY_PAID" },
        );
        // One payment, one line per owed round; the tip and the rounding on the last one.
        assert.deepEqual(
          await rows(
            "SELECT r.line_number,r.order_batch_id::text AS batch,r.round_minor::text AS round,r.tip_minor::text AS tip,r.rounding_minor::text AS rounding FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id WHERE s.order_id=$1 ORDER BY r.line_number",
            [orderReference],
          ),
          [
            {
              line_number: 1,
              batch: R1.batch.orderBatchReference,
              round: round1Minor.toString(),
              tip: tipMinor.toString(),
              rounding: rounding.toString(),
            },
          ],
        );
        assert.deepEqual(
          await rows(
            "SELECT action_code,actor_reference::text AS actor,retention_policy_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_DINING_TABLE_SETTLED' AND target_id=$1",
            [orderReference],
          ),
          [
            {
              action_code: "PAYMENT_DINING_TABLE_SETTLED",
              actor: id(0x700),
              retention_policy_code: "FINANCIAL_COMPLIANCE",
            },
          ],
        );
        // The same command again returns that payment; another payment of the table is refused.
        assert.equal(
          (await settleWith(server, { operationReference: operation })).status,
          "AlreadyRecorded",
        );
        await assert.rejects(settleWith(server, { method: "CardMachine", tenderedMinor: null }), {
          code: "TABLE_CHECKOUT_ALREADY_PAID",
        });
        assert.equal(
          (
            await rows(
              "SELECT count(*)::int AS n FROM rms_payment.dining_table_settlement WHERE order_id=$1",
              [orderReference],
            )
          )[0].n,
          1,
        );
        // Payment now counts both rounds and the tip as paid: the Order is Settled (rounding apart).
        const settledNow = await transactions().run(async (tx) => {
          const at = now();
          const financial = await createPostgresOrderFinancialPosition({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            authorize: async () => true,
          })(tx, { orderReference, observedAt: at });
          const priced = await createPostgresOrderPricedAmountSource({
            ...scope,
            authorize: async () => true,
          })(tx, { orderReference, observedAt: at });
          return assessOrderSettlement({
            currencyCode: "CAD",
            pricedOrderTotalMinor: priced.pricedTotalMinor,
            capturedMinor: financial.settlement.capturedMinor,
            capturedOrderAllocationMinor: financial.settlement.capturedOrderAllocationMinor,
            capturedTipMinor: financial.settlement.capturedTipMinor,
            confirmedRefundMinor: financial.settlement.confirmedRefundMinor,
            refundAllocation: financial.settlement.refundAllocation,
            pendingRefundMinor: financial.settlement.pendingRefundMinor,
            unresolvedAttemptCount: financial.unresolvedAttemptCount,
            pendingAmendmentCount: priced.pendingAmendmentCount,
          });
        });
        assert.equal(settledNow.classification, "Settled");
        // A round paid with the table can never be paid again on the card machine (trigger).
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_payment.dining_table_settlement_round (settlement_id,brand_id,store_id,order_id,order_batch_id,submission_id,line_number,round_minor,tip_minor,rounding_minor) SELECT settlement_id,brand_id,store_id,order_id,$2,$3,3,1,0,0 FROM rms_payment.dining_table_settlement WHERE order_id=$1",
            [orderReference, R1.batch.orderBatchReference, R1.batch.submissionReference],
          ),
          /duplicate key|paid/u,
        );
        // ── S3: cash given back from the table's cash payment (a manager's decision).
        const cashRefund = (who, amountMinor, operationReference = fresh()) =>
          createMerchantDiningTableCashRefund({
            persistence: persistenceOf(who),
            authentication: who.authentication,
            nextReference: fresh,
          })({
            ...as(who),
            command: { orderReference, operationReference, amountMinor, reasonCode: "FOOD_ISSUE" },
          });
        await assert.rejects(cashRefund(server, "500"), {
          code: "TABLE_PAYMENT_PERMISSION_DENIED",
        });
        const refundOperation = fresh();
        const refunded = await cashRefund(manager, "500", refundOperation);
        assert.equal(refunded.status, "Recorded");
        assert.equal(refunded.payment.refundableMinor, (due + rounding - 500n).toString());
        assert.equal((await cashRefund(manager, "500", refundOperation)).status, "AlreadyRecorded");
        await assert.rejects(cashRefund(manager, String(due + rounding)), {
          code: "TABLE_PAYMENT_TOO_MUCH",
        });
        assert.deepEqual(
          (
            await createMerchantDiningTablePaymentRead({
              persistence: persistenceOf(server),
              authentication: server.authentication,
            })({ ...as(server), query: { orderReference } })
          ).payment.cashRefunds.map((refund) => [refund.amountMinor, refund.reasonCode]),
          [["500", "FOOD_ISSUE"]],
        );
        assert.deepEqual(
          await rows(
            "SELECT action_code,actor_reference::text AS actor FROM platform_audit.audit_record WHERE action_code='PAYMENT_DINING_TABLE_CASH_REFUNDED' AND target_id=$1",
            [orderReference],
          ),
          [{ action_code: "PAYMENT_DINING_TABLE_CASH_REFUNDED", actor: id(0x701) }],
        );
        await assert.rejects(
          admin.query("UPDATE rms_payment.dining_table_cash_refund SET amount_minor=1"),
          /append-only/u,
        );
        // The day's reports count the table's cash payment once, its rounds, tip, rounding and the
        // cash given back — never hidden from them (AGENTS.md: no sales suppression).
        const ledger = await transactions().run((tx) =>
          createPostgresStoreSalesPaymentLedger({
            scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
            authorize: async () => true,
          })(tx, {
            startsAt: time(-minutes(120)),
            endsAt: new Date(Date.now() + 1000).toISOString(),
            observedAt: new Date(Date.now() + 1000).toISOString(),
          }),
        );
        const cashLines = ledger.payments.filter((payment) => payment.channel === "Cash");
        assert.deepEqual(
          cashLines.map((line) => [
            line.orderBatchReference,
            line.orderAllocationMinor,
            line.tipMinor,
            line.roundingMinor,
            line.paymentCount,
          ]),
          [[R1.batch.orderBatchReference, round1Minor, tipMinor, rounding, 1]],
        );
        assert.deepEqual(ledger.settlement.cashTaken, {
          count: 1,
          amountMinor: due + rounding,
          tipMinor,
          roundingMinor: rounding,
        });
        assert.deepEqual(ledger.settlement.cashRefunded, { count: 1, amountMinor: 500n });
        assert.deepEqual(
          ledger.refunds.filter((refund) => refund.channel === "Cash").map((r) => r.amountMinor),
          [500n],
        );

        // A paid table can never be written off as well (2000_101; the amount check is Payment's
        // own, covered by the write-off ending), and the payment is append-only.
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_payment.order_unpaid_write_off (write_off_id,tenant_id,brand_id,store_id,operation_id,dining_session_id,order_id,order_version,order_checkpoint,reason_code,currency_code,priced_order_total_minor,captured_order_allocation_minor,written_off_minor,requested_by_actor_id,approved_by_actor_id,order_evidence_digest,payment_evidence_digest,decided_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,2,$8,'GUEST_LEFT_UNPAID','CAD',1000,0,999,$9,$9,$10,$10,now(),$11)",
            [
              fresh(),
              tenant,
              scope.brandReference,
              scope.storeReference,
              fresh(),
              sessionReference,
              orderReference,
              fresh(),
              id(0x701),
              "sha256:" + "b".repeat(64),
              fresh(),
            ],
          ),
          /the table already paid/u,
        );
        await assert.rejects(
          admin.query("UPDATE rms_payment.dining_table_settlement SET tip_minor=0"),
          /append-only/u,
        );
        await assert.rejects(
          admin.query("DELETE FROM rms_payment.dining_table_settlement_round"),
          /append-only/u,
        );

        // ── A pay-later round is never closed as "not paid in time" (nor any accepted round).
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) SELECT $1,$2,$3,b.brand_id,b.store_id,b.order_id,b.order_batch_id,b.submission_id,$4,NULL,NULL,3,4,b.submission_id,$5,$6,ARRAY(SELECT i.order_item_id FROM rms_ordering.order_item i WHERE i.order_batch_id=b.order_batch_id),$7,'Cancelled','STAFF_CANCELLED_UNPAID' FROM rms_ordering.order_batch b WHERE b.order_batch_id=$8",
            [
              fresh(),
              fresh(),
              tenant,
              id(0x2010),
              inventoryWorkflow.payment.workflowVersionReference,
              id(0x9999),
              now(),
              R2.batch.orderBatchReference,
            ],
          ),
          /pay-later round cannot expire unpaid/u,
        );

        // ── Append-only, and another Store of the Brand sees none of it.
        await assert.rejects(
          admin.query("UPDATE rms_ordering.order_pay_later_confirmation SET confirmed_at=now()"),
          /append-only/u,
        );
        await assert.rejects(
          admin.query("DELETE FROM rms_ordering.order_pay_later_confirmation"),
          /append-only/u,
        );
        const list = (storeReference) =>
          transactions().run((tx) =>
            createPostgresOrderPayLaterConfirmationStore({
              brandReference: scope.brandReference,
              storeReference,
              quoteVersion: 1,
              sha256,
              authorize: async () => true,
            }).listByOrders({ transaction: tx, orderReferences: [orderReference] }),
          );
        assert.deepEqual(
          (await list(scope.storeReference)).map((entry) => String(entry.orderBatchReference)),
          [R1.batch.orderBatchReference, R2.batch.orderBatchReference],
        );
        assert.deepEqual(await list(id(0x7ff)), []);
      } finally {
        await admin.end();
      }
    },
  );
}
