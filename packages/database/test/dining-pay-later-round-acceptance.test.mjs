import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  changeDiningRoundHoldSetting,
  changeDiningServiceSetting,
  changeDiningTeaChargeSetting,
  createDiningGuestBindingQuery,
  createDiningTable,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningQrJoinStore,
  listDiningSessionMovedFrom,
  listDiningSessionTableLabels,
  listDiningSessionMergedInto,
  loadDiningParticipantMove,
  parseDiningSession,
  recordDiningPartySize,
} from "../../rms/dining/src/index.ts";
import { createMerchantDiningPartySize } from "../../../apps/api/src/merchant-dining-party-size.ts";
import { createMerchantDiningTableMove } from "../../../apps/api/src/merchant-dining-table-move.ts";
import { createMerchantDiningTableMerge } from "../../../apps/api/src/merchant-dining-table-merge.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { recordDiningTableBillOrder } from "../../rms/payment/src/index.ts";
import { createMerchantDiningTableCommand } from "../../../apps/api/src/merchant-dining-table-command.ts";
import { parseDiningJoinCapability } from "../../bop/public-capability/src/index.ts";
import {
  createCustomerSessionBootstrapHandler,
  createCustomerSessionBootstrapRead,
} from "../../../apps/api/src/customer-session-bootstrap.ts";
import { restoreCustomerSession } from "../../../apps/customer-pwa/src/session/session-bootstrap.ts";
import { createHttpDiningSessionClient } from "../../../apps/customer-pwa/src/dining/dining-session-client.ts";
import {
  getMovedTableLabel,
  getMovedTableMerged,
  setCustomerCsrfCredential,
} from "../../../apps/customer-pwa/src/session/customer-transaction-context.ts";
import { createMerchantDiningTeaCharge } from "../../../apps/api/src/merchant-dining-tea-charge.ts";
import {
  createOrderNumberAllocation,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresOrderRoundStaffHoldStore,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createDiningPayLaterRound } from "../../../apps/api/src/dining-pay-later-round.ts";
import {
  createMerchantDiningTableBillRead,
  createMerchantDiningTableSettle,
  createMerchantDiningTableSplit,
} from "../../../apps/api/src/merchant-dining-table-checkout.ts";
import { createMerchantDiningUnpaidDeparture } from "../../../apps/api/src/merchant-dining-unpaid-departure.ts";
import { createMerchantDiningUnpaidItemRemoval } from "../../../apps/api/src/merchant-dining-unpaid-item-removal.ts";
import { createMerchantDiningItemComp } from "../../../apps/api/src/merchant-dining-item-comp.ts";
import { createMerchantDiningOrderCloseCommand } from "../../../apps/api/src/merchant-dining-order-close-command.ts";
import { loadStoreSalesReportSources } from "../../../apps/api/src/persistent-merchant-store-reports.ts";
import { readTonightFacts } from "../../../apps/api/src/merchant-tonight-summary.ts";
import {
  computeStoreSalesReport,
  storeSalesReportCsv,
} from "../../../apps/api/src/store-sales-report.ts";
import { createMerchantDiningServeCommand } from "../../../apps/api/src/merchant-dining-serve-command.ts";
import { createDiningTableOnlinePayments } from "../../../apps/api/src/dining-table-online-payment.ts";
import {
  createCustomerDiningTablePayment,
  customerSettledTableReceiptBody,
} from "../../../apps/api/src/customer-dining-table-payment.ts";
import { createMerchantDiningOrderProgress } from "../../../apps/api/src/merchant-dining-order-progress.ts";
import { createMerchantDiningTableClosePlan } from "../../../apps/api/src/merchant-dining-table-close-plan.ts";
import { createKitchenInventoryConsumption } from "../../../apps/api/src/kitchen-inventory-consumption.ts";
import {
  changeKitchenNotPreparedProduct,
  createConfirmedOrderIntakeReceipt,
  createKitchenNotPreparedIntakeAdapter,
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
  loadKitchenBatchPreparationDecision,
} from "../../rms/kitchen/src/index.ts";
import { createMerchantDiningClosingCommand } from "../../../apps/api/src/merchant-dining-closing-command.ts";
import { createDiningOrderCloseConfiguration } from "../../../apps/api/src/dining-order-close-configuration.ts";
import {
  assessOrderSettlement,
  createPostgresOrderFinancialPosition,
  createPostgresPaymentCaptureWindowSource,
} from "../../rms/payment/src/index.ts";
import {
  createPostgresOrderPricedAmountSource,
  createPostgresStoreSalesOrderSource,
  listStorePriceReductionsDecided,
  listOrdersTaxRoundingLines,
} from "../../rms/ordering/src/index.ts";
import {
  changeStoreTipSetting,
  createPostgresPaymentTipSelectionStore,
  createPostgresStoreSalesPaymentLedger,
  parsePaymentTipSelection,
} from "../../rms/payment/src/index.ts";
import { readStoreTipChoices } from "../../../apps/api/src/merchant-store-features.ts";
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

// WP-2423 item 8 ① segment 2 (Owner decision 2): a manager comps or discounts dishes the kitchen
// started or the table was served, before it pays; the bill, the payment, the Order's settlement,
// the reports and the day-end settlement all follow, and nothing can be deleted.
it("a manager comps and discounts served dishes before the table pays; it stays on record", () =>
  journey("Comped"));

// v15 2026-10-27 follow-up: a table whose every dish was comped owes nothing and closes as usual.
it("a table comped in full owes nothing and closes without a payment", () =>
  journey("CompedWhole"));

// WP-2423 DEC-TAX-WHOLE-RECEIPT step 2: the bill's tax is rounded once over every dish; the rounds'
// difference is recorded by the system rule as the bill's tax rounding, paid exactly, part by part.
it("a table's bill is charged its whole-bill tax; the rounding is recorded and paid exactly", () =>
  journey("TaxRounding"));

// WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL: the table splits the bill evenly in three; each part is
// paid once, by its own method, with its own tip and cash rounding; a whole-table payment, a
// second payment of a part and a new split once paying started are all refused.
it("a table splits the bill evenly and pays it part by part", () => journey("PaidSplit"));
// WP-2423 item 8 ④: a split table pays one part in cash (some of it refunded), the guests leave;
// the manager writes off exactly the parts still unpaid, and the day's ledger keeps each.
it("a split table that paid one part and left is written off for the rest", () =>
  journey("SplitWrittenOff"));
// WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 5–7: with the Store's "a new phone's first round
// waits for staff" on, each guest's first round waits: it is not sent to the kitchen (the database
// refuses that and a cancellation without staff), asking again finds the same hold, and staff send
// it with their release in one transaction. Then the table goes on and pays as usual.
it("a new phone's first round waits for staff, who send it to the kitchen", () => journey("Held"));
// WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 11): the owner turned tips off.
// Neither staff at checkout nor a guest on their phone can add a tip (the commands refuse, and the
// database refuses a tip selection by any path); the table pays with no tip, part of it is
// refunded, and the Order's settlement, the day's ledger and reports follow with no tip.
it("a store with tips off takes no tip from staff or guests; the table pays and is refunded without one", () =>
  journey("TipsOff"));
// WP-2423 item 8 ⑦ 4b-2 (Owner decision 2, coordinator 2026-10-29): with a tea charge set, the
// table's tea follows its party size until it pays — added for more guests, taken off (who, when,
// "guests left"; the original line kept) for fewer, a retry never doing either twice; a server who
// may not take dishes off leaves it for a manager; none before a party size.
it("the per-head tea charge follows a pay-later table's party size until it pays", () =>
  journey("TeaCharge"));
// WP-2423 item 8 ⑧ (Owner decision 3): staff move the party to another free table with a code;
// everything the party has goes with it, once (two staff at once: one move wins), the old table
// is marked for cleaning, the kitchen names the table it came from, the old table's phones no
// longer act for the party (and are told where it sits now); a table with a party, without a
// code or blocked is refused, and so is a table checking out.
it("staff move a table's party to another free table, once; the old table waits for cleaning", () =>
  journey("Moved"));

// WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): staff merge another table's party, with its own
// Order, into this table: once (two staff at once: one merges); that table waits for cleaning; the
// bill holds both tables' rounds, each on its own Order; the table pays once and both Orders close.
it("staff merge another table's party into this table; it pays once and closes", () =>
  journey("Merged"));

/**
 * Coordinator 2026-10-30 (Owner authorized): what a guest's phone sees after its table closed — the
 * visit restore (the real bootstrap read) and then the settled table's receipt read with the ended
 * visit's value (the real table-payment port and public body), as the pilot API role. The phone's
 * table binding no longer holds (its table closed). Null when the restore says nothing was settled.
 */
async function settledReceiptFor({ scope, ownerScope, transactions, phone, provider }) {
  const access = {
    scope,
    transactions,
    credentials: phone.identity.session.credentials,
    now: () => new Date().toISOString(),
    binding: () => ({ validate: async () => "Unavailable" }),
  };
  const settled = await createCustomerSessionBootstrapRead(access).readSettledTable(
    phone.sessionCredential,
  );
  if (settled === null) return null;
  const port = createCustomerDiningTablePayment({
    access,
    payments: createDiningTableOnlinePayments({
      scope: ownerScope,
      providerAccountReference: provider,
      environment: "Test",
      provider: {},
      transactions,
      now: () => new Date().toISOString(),
      nextReference: () => {
        throw new Error("a receipt read records nothing");
      },
    }),
    providerEnvironment: "Test",
  });
  const body = customerSettledTableReceiptBody(
    await port.settledReceipt({
      sessionCredential: phone.sessionCredential,
      csrfCredential: settled.csrfToken,
    }),
  );
  // Public fields only: no references, card details, staff or Provider identifiers.
  assert.doesNotMatch(
    JSON.stringify(body),
    /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}|slip|TEST 0001|actor|provider|tendered/iu,
  );
  return { settledTableLabel: settled.tableLabel, ...body.receipt };
}

async function journey(ending) {
  await withIsolatedDatabase(
    {
      caseId:
        ending === "Paid"
          ? "wp2423_paylater"
          : ending === "WrittenOff"
            ? "wp2423_plwo"
            : ending === "TaxRounding"
              ? "wp2423_pltaxr"
              : ending === "Comped"
                ? "wp2423_plcomp"
                : ending === "CompedWhole"
                  ? "wp2423_plcwhole"
                  : ending === "PaidSplit"
                    ? "wp2423_plsplit"
                    : ending === "SplitWrittenOff"
                      ? "wp2423_plsplwo"
                      : ending === "Held"
                        ? "wp2423_plheld"
                        : ending === "TipsOff"
                          ? "wp2423_pltips"
                          : ending === "TeaCharge"
                            ? "wp2423_pltea"
                            : ending === "Moved"
                              ? "wp2423_plmove"
                              : ending === "Merged"
                                ? "wp2423_plmerge"
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
              // As the pilot's transaction runner (v15 2026-10-14): one query at a time; a second query
              // while one is in flight (Promise.all over one transaction) is refused.
              let inFlight = false;
              const result = await work({
                query: async (sql, values) => {
                  if (inFlight) throw new Error("TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY");
                  inFlight = true;
                  try {
                    return await client.query(sql, values);
                  } finally {
                    inFlight = false;
                  }
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
        const tablePhone = await seedAdditionalDiningGuest({
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

        // WP-2423 item 8 ⑤: the Store turns on "a new phone's first round waits for staff".
        const holdStore = createPostgresOrderRoundStaffHoldStore({
          ...scope,
          authorize: async () => true,
        });
        const staffMember = id(0x701);
        if (ending === "Held") {
          const setting = await transactions().run((tx) =>
            changeDiningRoundHoldSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: 0,
              firstRoundNeedsStaff: true,
              actorReference: staffMember,
              observedAt: clock,
            }),
          );
          assert.deepEqual([setting.version, setting.firstRoundNeedsStaff], [1, true]);
        }
        const holdIfNeeded = (submissionReference, guest) =>
          transactions().run((tx) =>
            payLater.holdIfNeeded(tx, {
              submissionReference,
              guestSessionReference: guest,
              authorize: async () => true,
            }),
          );
        /** A guest's round as sent from their phone: held, then sent by staff (Held ending). */
        const guestSends = async (submissionReference, guest) => {
          if (ending !== "Held") {
            assert.equal(await holdIfNeeded(submissionReference, guest), null);
            return send(submissionReference, guest);
          }
          const held = await holdIfNeeded(submissionReference, guest);
          assert.equal(held.status, "Waiting");
          assert.equal(held.reason, "FirstOrder");
          // Asking again finds the same hold; nothing more is written.
          assert.deepEqual(await holdIfNeeded(submissionReference, guest), held);
          assert.equal(
            (
              await rows(
                "SELECT count(*)::int AS n FROM rms_ordering.order_round_staff_hold WHERE order_batch_id=$1",
                [held.orderBatchReference],
              )
            )[0].n,
            1,
          );
          // Not in the kitchen while it waits: the database refuses its confirmation...
          await assert.rejects(send(submissionReference, guest));
          // ...and a release recorded without its outcome fails when the transaction commits.
          await assert.rejects(
            transactions().run((tx) =>
              holdStore.release({
                transaction: tx,
                operationReference: fresh(),
                orderReference: held.orderReference,
                orderBatchReference: held.orderBatchReference,
                outcome: "Cancelled",
                actorReference: staffMember,
                observedAt: clock,
              }),
            ),
          );
          assert.deepEqual(
            await rows(
              "SELECT 1 FROM rms_ordering.order_pay_later_confirmation WHERE order_batch_id=$1",
              [held.orderBatchReference],
            ),
            [],
          );
          // Staff send it: their release and the round's confirmation, together.
          const operation = fresh();
          const sent = await transactions().run(async (tx) => {
            await holdStore.release({
              transaction: tx,
              operationReference: operation,
              orderReference: held.orderReference,
              orderBatchReference: held.orderBatchReference,
              outcome: "Confirmed",
              actorReference: staffMember,
              observedAt: clock,
            });
            return payLater.confirm(tx, {
              submissionReference,
              actorReference: staffMember,
              operationReference: operation,
              correlationReference: operation,
              authorize: async () => true,
            });
          });
          assert.equal(sent.status, "Confirmed");
          assert.deepEqual(await holdIfNeeded(submissionReference, guest), {
            status: "Confirmed",
          });
          assert.deepEqual(
            await rows(
              "SELECT outcome,actor_id FROM rms_ordering.order_round_staff_hold_release WHERE order_batch_id=$1",
              [held.orderBatchReference],
            ),
            [{ outcome: "Confirmed", actor_id: staffMember }],
          );
          return sent;
        };

        // The round is sent: the System's acceptance, its revision, the confirmation and the event.
        const sent1 = await guestSends(r1.submissionReference, guestSession);
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
          extraPermissions: [...staffPermissions, "payment.refund.approve", "ordering.order.comp"],
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
              tip: ending === "TipsOff" ? { kind: "None" } : { kind: "Percent", percent: 15 },
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
        const sent2 = await guestSends(R2.batch.submissionReference, tableGuest);
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
        if (ending === "Merged") {
          // ── WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the party at another table (T-M, its own
          // Order and round) merges into this table. TEST-only identities.
          const M = journeyRound({
            at: time(-minutes(30)),
            prefix: "01a00021",
            party: { prefix: "01a0002f" },
          });
          const mRecord = M.f.request.record;
          const mOrder = mRecord.order.orderReference;
          const mGuest = mRecord.guestSessionReference;
          assert.notEqual(mOrder, orderReference);
          const mDining = await seedJourneyDining({
            client: admin,
            scope: ownerScope,
            round: M,
            startedAt: time(-minutes(35)),
            guestParticipant: id(0x611),
            tableVersion: 2,
            table: { suffix: "a101", label: "T-M", auditBase: 0xb100 },
          });
          const mSession = mDining.session.diningSessionReference;
          const mHost = await seedAdditionalDiningGuest({
            client: admin,
            runner: ownerRunner,
            f: M.f,
            dining: {
              ...mDining,
              participant: mDining.host,
              link: { paymentOperationReference: id(0x1100) },
            },
            at: time(-minutes(34)),
            idPrefix: "01909994-0000-7000-8000-",
          });
          const mItems = M.items();
          await seedAcceptanceOrderHistory(admin, {
            ...mRecord,
            items: mItems,
            orderNumberAllocation: createOrderNumberAllocation({
              orderReference: mOrder,
              allocatedAt: mRecord.createdAt,
              sequence: 7n,
              businessDateResolution: M.f.request.businessDateResolution,
            }),
          });
          await seedJourneyQuote({
            runner: ownerRunner,
            scope: ownerScope,
            snapshot: { items: mItems, batch: M.batch },
            prefix: "01a10021",
          });
          const mSent = await send(mRecord.submissionReference, mGuest);
          assert.equal(mSent.status, "Confirmed");
          const mEvent = await transactions({ guc: true }).run((tx) =>
            loadOutboxEnvelope(tx, mSent.confirmation.orderConfirmedEventReference),
          );
          const tableVersion = async (table) =>
            Number(
              (
                await rows("SELECT version FROM rms_dining.dining_table WHERE table_id=$1", [table])
              )[0].version,
            );
          const fromTable = mDining.table.tableReference,
            toTable = dining.table.tableReference;
          const merge = (who, operationReference, versions = {}) =>
            Promise.all([tableVersion(fromTable), tableVersion(toTable)]).then(([from, to]) =>
              createMerchantDiningTableMerge({
                persistence: persistenceOf(who),
                authentication: who.authentication,
                newReference: fresh,
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              })({
                ...as(who),
                command: {
                  action: "Merge",
                  operationReference,
                  tableReference: fromTable,
                  expectedTableVersion: versions.from ?? from,
                  targetTableReference: toTable,
                  expectedTargetTableVersion: versions.to ?? to,
                },
              }),
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
          // The table's join code, as a table started with one has it (the guests' QR joins renew
          // it). TEST-ONLY code value.
          const seedCode = async (table, session, startedAt, assignmentVersion) => {
            const joinCode = parseDiningJoinCapability({
              capabilityReference: fresh(),
              purpose: "DiningJoin",
              kind: "HumanCode",
              storeReference: scope.storeReference,
              tableReference: table,
              diningSessionReference: session,
              selectorHash: diningCredentials.hashJoinCredential(
                "HumanCode",
                "TEST-" + table.slice(-4),
              ),
              pepperVersion: 1,
              assignmentVersion,
              generation: 1,
              status: "Active",
              version: 1,
              issuedAt: startedAt,
              expiresAt: new Date(Date.parse(startedAt) + 15 * 60_000).toISOString(),
              consumedAt: null,
              revokedAt: null,
            });
            await admin.query(
              "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                joinCode.capabilityReference,
                tenant,
                scope.brandReference,
                scope.storeReference,
                session,
                JSON.stringify(joinCode),
              ],
            );
          };
          // A guest scans a table's code and taps "Join this table" (the code it is issued).
          const scanAt = (table, guestSession) =>
            createPostgresDiningQrJoinStore(transactions(), {
              scope: ownerScope,
              credentials: diningCredentials,
              pepperVersion: 1,
              now: () => new Date().toISOString(),
              authorize: async () => true,
              audit: (record) => ({
                auditId: fresh(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" },
                actionCode: "DINING_QR_JOIN_ISSUE",
                targetType: "DiningTable",
                targetId: record.tableReference,
                reasonCode: "GUEST_SCANNED_OPEN_TABLE",
                correlationId: record.operationReference,
                occurredAt: record.observedAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
            }).issue({
              operationReference: fresh(),
              guestSessionReference: guestSession,
              tableReference: table,
              observedAt: new Date().toISOString(),
            });
          await seedCode(
            toTable,
            sessionReference,
            dining.session.startedAt,
            dining.session.tableAssignmentVersion,
          );
          await seedCode(
            fromTable,
            mSession,
            mDining.session.startedAt,
            mDining.session.tableAssignmentVersion,
          );
          // Refused while this table is checking out (back to ordering after).
          assert.equal((await closing(server, "Begin")).phase, "Closing");
          await assert.rejects(merge(server, fresh()), { code: "DINING_TABLE_MERGE_CHECKING_OUT" });
          assert.equal((await closing(server, "Cancel")).phase, "Active");
          const partyBefore = (
            await rows(
              "SELECT party_size FROM rms_dining.dining_session_party_size WHERE session_id=$1 ORDER BY version DESC LIMIT 1",
              [sessionReference],
            )
          )[0]?.party_size;

          // ── Two staff merge T-M at the same moment: one merges, the other is told the tables
          // changed (never two merges).
          const versions = { from: await tableVersion(fromTable), to: await tableVersion(toTable) };
          const [byServer, byManager] = [fresh(), fresh()];
          const raced = await Promise.allSettled([
            merge(server, byServer, versions),
            merge(manager, byManager, versions),
          ]);
          const won = raced.filter((outcome) => outcome.status === "fulfilled");
          assert.equal(
            won.length,
            1,
            JSON.stringify(raced.map((o) => String(o.reason ?? o.status))),
          );
          assert.equal(
            raced.find((outcome) => outcome.status === "rejected")?.reason?.code,
            "DINING_TABLE_MERGE_CHANGED",
          );
          const merged = won[0].value;
          const winner = raced[0].status === "fulfilled" ? byServer : byManager;
          assert.deepEqual(
            [
              merged.status,
              merged.diningSessionReference,
              merged.tableLabel,
              merged.fromTableLabel,
            ],
            ["Applied", sessionReference, dining.table.stableLabel, "T-M"],
          );
          // The same request again: the same merge, nothing recorded twice.
          const again = await merge(
            raced[0].status === "fulfilled" ? server : manager,
            winner,
            versions,
          );
          assert.equal(again.status, "AlreadyApplied");
          assert.deepEqual(
            await rows(
              "SELECT operation_id::text op,source_session_id::text src,target_session_id::text dst,merged_party_size::int party FROM rms_dining.dining_session_merge_operation",
            ),
            [{ op: winner, src: mSession, dst: sessionReference, party: merged.partySize }],
          );
          assert.equal(merged.partySize, (partyBefore ?? 1) + 1);
          assert.deepEqual(
            await rows(
              "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_MERGE_TABLE' AND target_id=$1",
              [mSession],
            ),
            [{ n: 1 }],
          );
          // T-M's party ended here; its table waits for cleaning; this table seats both parties.
          assert.deepEqual(
            await rows("SELECT phase FROM rms_dining.dining_session WHERE session_id=$1", [
              mSession,
            ]),
            [{ phase: "Closed" }],
          );
          assert.deepEqual(
            await rows(
              "SELECT table_snapshot->>'activeDiningSessionReference' party,table_snapshot->>'blockReasonCode' reason FROM rms_dining.dining_table WHERE table_id=$1",
              [fromTable],
            ),
            [{ party: null, reason: "CLEANING" }],
          );
          assert.deepEqual(
            (
              await rows(
                "SELECT party_size FROM rms_dining.dining_session_party_size WHERE session_id=$1 ORDER BY version DESC LIMIT 1",
                [sessionReference],
              )
            )[0],
            { party_size: merged.partySize },
          );
          // Its Order is on this table's bill (Ordering and Payment each record their side).
          assert.deepEqual(
            await rows(
              "SELECT source_order_id::text s,target_order_id::text t FROM rms_ordering.order_merge",
            ),
            [{ s: mOrder, t: orderReference }],
          );
          assert.deepEqual(
            await rows(
              "SELECT member_order_id::text m,bill_order_id::text b FROM rms_payment.dining_table_bill_order",
            ),
            [{ m: mOrder, b: orderReference }],
          );
          // ── Codes: T-M's code admits no one now (its party ended); this table's code admits a
          // phone from either table (no host needed) — T-M's host scans it and joins again.
          const stale = await scanAt(fromTable, fresh());
          assert.equal(stale.status, "Refused", JSON.stringify(stale));
          const rejoined = await scanAt(toTable, mGuest);
          assert.equal(rejoined.status, "Issued", JSON.stringify(rejoined));
          const another = await scanAt(toTable, fresh());
          assert.equal(another.status, "Issued", JSON.stringify(another));
          // T-M's phone reloads its table page: it is told its table was merged into this one
          // (the real restore handler and the guest app's own clients, its cookie, the API role).
          const bootstrap = createCustomerSessionBootstrapHandler({
            allowedOrigin: "https://synthetic-journey.invalid",
            port: createCustomerSessionBootstrapRead({
              scope,
              transactions: transactions(),
              credentials: mHost.identity.session.credentials,
              now: () => new Date().toISOString(),
              // The pilot's binding: the phone's table (the one it scanned and joined at).
              binding: (transaction) => ({
                validate: async (session, observedAt) =>
                  (await createDiningGuestBindingQuery({
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
                    tableReference: fromTable,
                  }))
                    ? "Current"
                    : "Unavailable",
              }),
            }),
          });
          const restoreOnReload = async (handler = bootstrap, cookie = mHost.sessionCredential) => {
            setCustomerCsrfCredential(null);
            await restoreCustomerSession(async () => {
              const wire = await new Promise((resolve, reject) => {
                const headers = {};
                const response = {
                  statusCode: 0,
                  setHeader: (name, value) => {
                    headers[name.toLowerCase()] = value;
                  },
                  status(code) {
                    this.statusCode = code;
                    return this;
                  },
                  json(body) {
                    resolve({
                      status: this.statusCode,
                      headers: { ...headers, "content-type": "application/json" },
                      body: JSON.stringify(body),
                    });
                    return this;
                  },
                  end() {
                    resolve({ status: this.statusCode, headers, body: null });
                    return this;
                  },
                };
                Promise.resolve(
                  handler(
                    {
                      get: (name) =>
                        ({ "sec-fetch-site": "same-origin", "x-bop-session-bootstrap": "1" })[
                          name.toLowerCase()
                        ],
                      query: {},
                      body: undefined,
                      headers: { cookie: "__Host-bop-guest=" + cookie },
                    },
                    response,
                    reject,
                  ),
                ).catch(reject);
              });
              return new globalThis.Response(wire.body, {
                status: wire.status,
                headers: wire.headers,
              });
            });
            return createHttpDiningSessionClient(async () => {
              throw new Error("the table page reads nothing without the visit's token");
            })
              .load()
              .then(
                () => "loaded",
                (error) => [error.code, error.tableLabel ?? null],
              );
          };
          assert.deepEqual(await restoreOnReload(), ["moved", dining.table.stableLabel]);
          assert.equal(getMovedTableMerged(), true);
          setCustomerCsrfCredential("x".repeat(43));
          setCustomerCsrfCredential(null);
          // The kitchen: T-M's dishes go to this table, "merged from T-M".
          assert.deepEqual(
            [
              ...(
                await transactions().run((tx) => listDiningSessionMergedInto(tx, scope, [mSession]))
              ).values(),
            ].map((entry) => [entry.tableLabel, entry.fromTableLabel]),
            [[dining.table.stableLabel, "T-M"]],
          );
          const merges = await rows(
            "SELECT count(*)::int n FROM rms_dining.dining_session_merge_operation",
          );
          // Refused after: T-M has no party now.
          await assert.rejects(merge(server, fresh()), { code: "DINING_TABLE_MERGE_NOT_SEATED" });
          assert.deepEqual(
            await rows("SELECT count(*)::int n FROM rms_dining.dining_session_merge_operation"),
            merges,
          );
          // The bill: every round of both tables, each with its own Order and who ordered it.
          const merchantBill = await bill();
          assert.deepEqual(
            merchantBill.rounds.map((round) => [round.orderReference, round.orderBatchReference]),
            [
              [orderReference, R1.batch.orderBatchReference],
              [orderReference, R2.batch.orderBatchReference],
              [mOrder, M.batch.orderBatchReference],
            ],
          );
          const mRound = merchantBill.rounds.find((round) => round.orderReference === mOrder);
          assert.notEqual(mRound.orderedBy, null);
          assert.ok(
            merchantBill.rounds
              .filter(
                (round) => round.orderReference === orderReference && round.orderedBy !== null,
              )
              .every((round) => round.orderedBy !== mRound.orderedBy),
          );

          // ── The table eats, pays once and closes: both Orders' rounds cooked and served at this
          // table, one cash payment whose lines keep each round's Order, both Orders closed.
          await cookAndServeRound1([
            { c: c1, event: event1, batch: R1.batch, items: items1 },
            { c: c2, event: event2, batch: R2.batch, items: items2 },
          ]);
          await cookAndServeRound1([
            {
              c: mSent.confirmation,
              event: mEvent,
              batch: M.batch,
              items: mItems,
              orderReference: mOrder,
            },
          ]);
          const owed = (await bill()).owed.totalMinor;
          // The tea read (staff) works on a merged bill (each Order's lines, one at a time).
          const [{ sku }] = await rows(
            "SELECT transaction_snapshot_json->'catalog'->>'sellableReference' AS sku FROM rms_ordering.order_item WHERE order_item_id=$1",
            [String(mItems[0].orderItemReference)],
          );
          await transactions().run((tx) =>
            changeDiningTeaChargeSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: 0,
              teaSellableReference: sku,
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          const teaRead = await createMerchantDiningTeaCharge({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            now,
            placeRound: async () => ({ status: "Placed" }),
            removeItems: async () => ({ status: "Removed" }),
          })({
            ...as(server),
            command: { action: "Read", diningSessionReference: sessionReference },
          });
          assert.ok(teaRead.charged >= 1, JSON.stringify(teaRead));

          // v15 2026-10-30: each round says the table it came from (the default split gives each
          // table one part), and the Orders list (the Tables page's amount) shows the whole bill.
          const merchantRounds = (await bill()).rounds;
          assert.deepEqual(
            merchantRounds.map((round) => round.fromTableLabel),
            merchantRounds.map((round) =>
              round.orderBatchReference === M.batch.orderBatchReference ? "T-M" : null,
            ),
          );
          const queued = await createPersistentMerchantOrderQueue({
            persistence: persistenceOf(server),
            quoteVersion: 1,
            acceptanceConfigured: true,
          })({ sessionCookie: server.sessionCookie, afterOrderReference: null, orderReference });
          assert.deepEqual(queued.items[0].tableBill, {
            totalMinor: merchantRounds
              .reduce((sum, round) => sum + BigInt(round.totalMinor), 0n)
              .toString(),
            paid: null,
          });

          // ── The table checks out and splits "each pays own rounds": T-M's phone pays its own
          // round on the phone (the guests' real payment entry), staff take the rest in cash.
          assert.equal((await closing(server, "Begin")).phase, "Closing");
          // As the Tables page proposes it: one part per phone that ordered (staff rounds in 1).
          const toSplit = await bill();
          const phones = [...new Set(toSplit.rounds.map((round) => round.orderedBy ?? 0))].sort(
            (a, b) => a - b,
          );
          const split = await createMerchantDiningTableSplit({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            nextReference: fresh,
          })({
            ...as(server),
            command: {
              operationReference: fresh(),
              diningSessionReference: sessionReference,
              mode: "ByRounds",
              people: null,
              rounds: toSplit.rounds.map((round) => ({
                roundNumber: round.roundNumber,
                partNumber: phones.indexOf(round.orderedBy ?? 0) + 1,
              })),
            },
          });
          assert.equal(split.status, "Recorded");
          const mRoundNumber = split.bill.rounds.find(
            (round) => round.orderBatchReference === M.batch.orderBatchReference,
          ).roundNumber;
          const mPart = split.bill.split.parts.find((part) =>
            part.roundNumbers.includes(mRoundNumber),
          );
          assert.deepEqual(mPart.roundNumbers, [mRoundNumber]);
          const intents = new Map();
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
          const phone = createDiningTableOnlinePayments({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            provider: {
              async createIntent(request) {
                const intent = intents.get(request.idempotencyKey) ?? {
                  reference: "pi_TESTMERGE" + String(intents.size + 1).padStart(4, "0"),
                  transaction: "ch_TESTMERGE" + String(intents.size + 1).padStart(4, "0"),
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
            },
            transactions: transactions(),
            now,
            nextReference: fresh,
          });
          const guestAt = (guestSessionReference) => ({
            diningSessionReference: sessionReference,
            guestSessionReference,
            allowed: async () => true,
          });
          const paying = await phone.start(guestAt(mGuest), {
            operationReference: fresh(),
            tip: { kind: "None" },
            partNumber: mPart.partNumber,
          });
          assert.equal(paying.attempt.totalMinor, mPart.amountMinor);
          for (const intent of intents.values()) intent.status = "Captured";
          await phone.refresh(guestAt(mGuest));
          for (const part of split.bill.split.parts.filter(
            (entry) => entry.partNumber !== mPart.partNumber,
          ))
            await settleWith(server, {
              partNumber: part.partNumber,
              tip: { kind: "None" },
              tenderedMinor: "100000",
            });
          const paid = await bill();
          assert.deepEqual(
            [paid.split.paidParts, paid.split.remainingMinor],
            [split.bill.split.parts.length, "0"],
          );
          // Each payment line keeps its round's own Order.
          assert.deepEqual(
            (
              await rows(
                "SELECT DISTINCT r.order_id::text o,r.order_batch_id::text b FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id WHERE s.order_id=$1 ORDER BY 2",
                [orderReference],
              )
            ).map((row) => [row.o, row.b]),
            [
              [orderReference, R1.batch.orderBatchReference],
              [orderReference, R2.batch.orderBatchReference],
              [mOrder, M.batch.orderBatchReference],
            ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
          );
          assert.notEqual(owed, "0");
          // Nothing more joins a bill once anything on it was paid (Payment's own rule, under the
          // pilot role).
          await assert.rejects(
            transactions().run((tx) =>
              recordDiningTableBillOrder(tx, scope, {
                operationReference: fresh(),
                billOrderReference: orderReference,
                memberOrderReference: fresh(),
                recordedAt: now(),
              }),
            ),
            { code: "DINING_TABLE_SETTLEMENT_ALREADY_PAID" },
          );
          const closeOrder = async (order) => {
            const progress = await createMerchantDiningOrderProgress({
              persistence: persistenceOf(server),
              locale: "en-CA",
              authentication: server.authentication,
            })({ ...as(server), query: { orderReference: order } });
            return createMerchantDiningOrderCloseCommand({
              persistence: persistenceOf(server),
              authentication: server.authentication,
              resolveConfiguration: createDiningOrderCloseConfiguration({
                ...ownerScope,
                providerAccountReference: provider,
                environment: "Test",
              }),
              newReference: fresh,
              audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
            })({
              ...as(server),
              command: {
                orderReference: order,
                operationReference: fresh(),
                expectedOrderVersion: progress.currentOrderVersion,
                expectedClosureVersion: progress.closureVersion,
                reasonCode: "ORDER_COMPLETED",
              },
            });
          };
          assert.equal((await closeOrder(mOrder)).status, "Committed");
          assert.equal((await closeOrder(orderReference)).status, "Committed");
          assert.equal((await closing(server, "Finalize")).phase, "Closed");
          // Coordinator 2026-10-30: the table paid and closed. A phone of this table and the phone
          // merged in from T-M reload their table page: both are thanked at this table, never
          // asked to join (the real restore handler and guest clients, the pilot API role).
          const tableBootstrap = createCustomerSessionBootstrapHandler({
            allowedOrigin: "https://synthetic-journey.invalid",
            port: createCustomerSessionBootstrapRead({
              scope,
              transactions: transactions(),
              credentials: tablePhone.identity.session.credentials,
              now: () => new Date().toISOString(),
              binding: (transaction) => ({
                validate: async (session, observedAt) =>
                  (await createDiningGuestBindingQuery({
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
                  }))
                    ? "Current"
                    : "Unavailable",
              }),
            }),
          });
          for (const [handler, cookie] of [
            [tableBootstrap, tablePhone.sessionCredential],
            [bootstrap, mHost.sessionCredential],
          ]) {
            setCustomerCsrfCredential("x".repeat(43));
            setCustomerCsrfCredential(null);
            assert.deepEqual(await restoreOnReload(handler, cookie), [
              "settled",
              dining.table.stableLabel,
            ]);
            assert.equal(getMovedTableLabel(), null);
          }
          setCustomerCsrfCredential("x".repeat(43));
          setCustomerCsrfCredential(null);
          // The merged-in table's round is sold on its own Order, once.
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "Moved") {
          // TEST-ONLY tables beside the party's: free B and F (with codes), C without a code,
          // D being cleaned, E with another party.
          const fromTable = dining.table.tableReference;
          const tableAt = (n, label, overrides = {}) =>
            createDiningTable({
              ...ownerScope,
              tableReference: id(0x900 + n),
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
              ...overrides,
            });
          const otherParty = id(0x9e0);
          const seeded = [
            tableAt(1, "T-B"),
            tableAt(2, "T-C", { qrStatus: "Inactive", qrVersion: 0 }),
            tableAt(3, "T-D", {
              operationalState: "TemporarilyBlocked",
              blockReasonCode: "CLEANING",
            }),
            tableAt(4, "T-E", { activeDiningSessionReference: otherParty }),
            tableAt(5, "T-F"),
          ];
          for (const table of seeded)
            await admin.query(
              "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
              [
                table.tableReference,
                tenant,
                scope.brandReference,
                scope.storeReference,
                JSON.stringify(table),
                table.createdAt,
              ],
            );
          const [B, C, D, E, F] = seeded.map((table) => table.tableReference);
          await admin.query(
            "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
            [
              otherParty,
              tenant,
              scope.brandReference,
              scope.storeReference,
              E,
              JSON.stringify(
                parseDiningSession({
                  ...dining.session,
                  diningSessionReference: otherParty,
                  tableReference: E,
                  hostParticipantReference: id(0x9e1),
                }),
              ),
              dining.session.startedAt,
            ],
          );
          const tableVersion = async (table) =>
            Number(
              (
                await rows("SELECT version FROM rms_dining.dining_table WHERE table_id=$1", [table])
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
          const move = (who, operationReference, to, versions = {}) =>
            Promise.all([tableVersion(versions.from ?? fromTable), tableVersion(to)]).then(
              ([fromVersion, toVersion]) =>
                createMerchantDiningTableMove({
                  persistence: persistenceOf(who),
                  authentication: who.authentication,
                  newReference: fresh,
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                  credentials: diningCredentials,
                  pepperVersion: 1,
                })({
                  ...as(who),
                  command: {
                    action: "Move",
                    operationReference,
                    tableReference: versions.from ?? fromTable,
                    expectedTableVersion: versions.fromVersion ?? fromVersion,
                    targetTableReference: to,
                    expectedTargetTableVersion: versions.toVersion ?? toVersion,
                  },
                }),
            );
          // The table's join code, as a table started with one has it (the guests' QR joins renew
          // it). TEST-ONLY code value.
          const joinCode = parseDiningJoinCapability({
            capabilityReference: fresh(),
            purpose: "DiningJoin",
            kind: "HumanCode",
            storeReference: scope.storeReference,
            tableReference: fromTable,
            diningSessionReference: sessionReference,
            selectorHash: diningCredentials.hashJoinCredential("HumanCode", "TEST-CODE"),
            pepperVersion: 1,
            assignmentVersion: dining.session.tableAssignmentVersion,
            generation: 1,
            status: "Active",
            version: 1,
            issuedAt: dining.session.startedAt,
            expiresAt: new Date(Date.parse(dining.session.startedAt) + 15 * 60_000).toISOString(),
            consumedAt: null,
            revokedAt: null,
          });
          await admin.query(
            "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
            [
              joinCode.capabilityReference,
              tenant,
              scope.brandReference,
              scope.storeReference,
              sessionReference,
              JSON.stringify(joinCode),
            ],
          );
          // A guest scans a table's code and taps "Join this table" (the code it is issued).
          const scanAt = (table, guestSession) =>
            createPostgresDiningQrJoinStore(transactions(), {
              scope: ownerScope,
              credentials: diningCredentials,
              pepperVersion: 1,
              now: () => new Date().toISOString(),
              authorize: async () => true,
              audit: (record) => ({
                auditId: fresh(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" },
                actionCode: "DINING_QR_JOIN_ISSUE",
                targetType: "DiningTable",
                targetId: record.tableReference,
                reasonCode: "GUEST_SCANNED_OPEN_TABLE",
                correlationId: record.operationReference,
                occurredAt: record.observedAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
            }).issue({
              operationReference: fresh(),
              guestSessionReference: guestSession,
              tableReference: table,
              observedAt: new Date().toISOString(),
            });
          const partyBefore = await rows(
            "SELECT party_size,version FROM rms_dining.dining_session_party_size WHERE session_id=$1 ORDER BY version",
            [sessionReference],
          );
          const fromVersion = await tableVersion(fromTable);

          // ── Two staff move the party at the same moment, to B and to F: one move wins, the
          // other is told the tables changed (never two moves, never a party at two tables).
          const [toB, toF] = [fresh(), fresh()];
          const raced = await Promise.allSettled([
            move(server, toB, B, { fromVersion }),
            move(manager, toF, F, { fromVersion }),
          ]);
          const won = raced.filter((outcome) => outcome.status === "fulfilled");
          assert.equal(won.length, 1, JSON.stringify(raced.map((outcome) => outcome.status)));
          const lost = raced.find((outcome) => outcome.status === "rejected");
          assert.equal(lost?.reason?.code, "DINING_TABLE_MOVE_CHANGED", String(lost?.reason));
          const moved = won[0].value;
          const target = moved.tableReference;
          assert.ok(target === B || target === F);
          const winner = target === B ? toB : toF;
          assert.deepEqual(
            [moved.status, moved.diningSessionReference, moved.fromTableLabel],
            ["Applied", sessionReference, dining.table.stableLabel],
          );
          // The table it left is free and waits for cleaning at once (not only after a retry).
          const leftTable = () =>
            rows(
              "SELECT table_snapshot->>'activeDiningSessionReference' party,table_snapshot->>'operationalState' state,table_snapshot->>'blockReasonCode' reason FROM rms_dining.dining_table WHERE table_id=$1",
              [fromTable],
            );
          assert.deepEqual(await leftTable(), [
            { party: null, state: "TemporarilyBlocked", reason: "CLEANING" },
          ]);
          // The same request again: the same move, nothing recorded twice.
          const again = await move(target === B ? server : manager, winner, target, {
            fromVersion,
            toVersion: 1,
          }).catch((error) => error);
          assert.equal(again.status, "AlreadyApplied", String(again));
          const moves = await rows(
            "SELECT operation_id::text op,source_table_id::text src,target_table_id::text dst,record_json->'audit'->'actor'->>'reference' actor,record_json->'command'->>'expectedSourceTableVersion' sv,record_json->'session'->>'version' version FROM rms_dining.dining_session_move_operation WHERE session_id=$1",
            [sessionReference],
          );
          assert.deepEqual(
            moves.map((row) => [row.op, row.src, row.dst, row.actor, Number(row.sv)]),
            [[winner, fromTable, target, target === B ? id(0x700) : id(0x701), fromVersion]],
          );
          assert.equal(
            (
              await rows(
                "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_MOVE_TABLE' AND target_id=$1",
                [sessionReference],
              )
            )[0].n,
            1,
          );
          // The party (its order, rounds, party size, tea) is the session's: it sits at the
          // target now; the table it left is free and waits for cleaning.
          assert.deepEqual(
            await rows(
              "SELECT table_id::text t,phase FROM rms_dining.dining_session WHERE session_id=$1",
              [sessionReference],
            ),
            [{ t: target, phase: "Active" }],
          );
          assert.deepEqual(
            await rows(
              "SELECT table_snapshot->>'activeDiningSessionReference' party,table_snapshot->>'operationalState' state,table_snapshot->>'blockReasonCode' reason FROM rms_dining.dining_table WHERE table_id=$1",
              [fromTable],
            ),
            [{ party: null, state: "TemporarilyBlocked", reason: "CLEANING" }],
          );
          assert.deepEqual(
            await rows(
              "SELECT party_size,version FROM rms_dining.dining_session_party_size WHERE session_id=$1 ORDER BY version",
              [sessionReference],
            ),
            partyBefore,
          );
          assert.equal(
            (
              await rows(
                "SELECT dining_session_id::text s FROM rms_ordering.order_header WHERE order_id=$1",
                [orderReference],
              )
            )[0].s,
            sessionReference,
          );
          // v15 2026-10-30: the party's join code was reissued for the table it sits at now, linked
          // to the move, so the host's phone (it joined at the old table) can scan the new table's
          // code and join again, as can any phone (no host needed).
          const rescanned = await scanAt(target, fresh());
          assert.equal(rescanned.status, "Issued", JSON.stringify(rescanned));
          assert.deepEqual(
            await rows(
              "SELECT move_operation_id::text m FROM rms_dining.dining_join_regeneration_operation WHERE session_id=$1 AND move_operation_id IS NOT NULL",
              [sessionReference],
            ),
            [{ m: winner }],
          );
          // The kitchen names the table the party came from beside the one it sits at.
          assert.deepEqual(
            await transactions().run(async (tx) => [
              ...(await listDiningSessionTableLabels(tx, scope, [sessionReference])),
              ...(await listDiningSessionMovedFrom(tx, scope, [sessionReference])),
            ]),
            [
              [sessionReference, target === B ? "T-B" : "T-F"],
              [sessionReference, dining.table.stableLabel],
            ],
          );
          // The old table's phone no longer acts for the party (it joined at the old table, and
          // the table codes are bound to it); it is told where the party sits now.
          const binding = (table) =>
            transactions().run((tx) =>
              createDiningGuestBindingQuery({
                scope,
                now: () => new Date().toISOString(),
                repository: createPostgresDiningGuestBindingStore(
                  { run: (work) => work(tx) },
                  ownerScope,
                ),
              }).resolve({
                purpose: "GuestSessionBinding",
                diningSessionReference: sessionReference,
                participantReference: id(0x601),
                tableReference: table,
              }),
            );
          assert.equal(await binding(fromTable), null);
          assert.equal(await binding(target), null);
          assert.deepEqual(
            await transactions().run((tx) =>
              loadDiningParticipantMove(tx, scope, {
                diningSessionReference: sessionReference,
                participantReference: id(0x601),
              }),
            ),
            { tableLabel: target === B ? "T-B" : "T-F", fromTableLabel: dining.table.stableLabel },
          );

          // v15 2026-10-30: the phone that joined at the old table reloads the table page. The
          // visit is restored first (the page's CSRF token lives in memory), which its table binding
          // no longer allows; the restore says where the party sits now instead of "nothing to
          // restore", and the table page says so (the real restore handler and the guest app's own
          // restore and table clients, the phone's cookie, the pilot API role).
          const bootstrap = createCustomerSessionBootstrapHandler({
            allowedOrigin: "https://synthetic-journey.invalid",
            port: createCustomerSessionBootstrapRead({
              scope,
              transactions: transactions(),
              credentials: tablePhone.identity.session.credentials,
              now: () => new Date().toISOString(),
              // The pilot's binding: the phone's table (the one it scanned and joined at).
              binding: (transaction) => ({
                validate: async (session, observedAt) =>
                  (await createDiningGuestBindingQuery({
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
                    tableReference: fromTable,
                  }))
                    ? "Current"
                    : "Unavailable",
              }),
            }),
          });
          const restoreOnReload = async () => {
            setCustomerCsrfCredential(null);
            await restoreCustomerSession(async () => {
              const wire = await new Promise((resolve, reject) => {
                const headers = {};
                const response = {
                  statusCode: 0,
                  setHeader: (name, value) => {
                    headers[name.toLowerCase()] = value;
                  },
                  status(code) {
                    this.statusCode = code;
                    return this;
                  },
                  json(body) {
                    resolve({
                      status: this.statusCode,
                      headers: { ...headers, "content-type": "application/json" },
                      body: JSON.stringify(body),
                    });
                    return this;
                  },
                  end() {
                    resolve({ status: this.statusCode, headers, body: null });
                    return this;
                  },
                };
                Promise.resolve(
                  bootstrap(
                    {
                      get: (name) =>
                        ({ "sec-fetch-site": "same-origin", "x-bop-session-bootstrap": "1" })[
                          name.toLowerCase()
                        ],
                      query: {},
                      body: undefined,
                      headers: { cookie: "__Host-bop-guest=" + tablePhone.sessionCredential },
                    },
                    response,
                    reject,
                  ),
                ).catch(reject);
              });
              return new globalThis.Response(wire.body, {
                status: wire.status,
                headers: wire.headers,
              });
            });
            return createHttpDiningSessionClient(async () => {
              throw new Error("the table page reads nothing without the visit's token");
            })
              .load()
              .then(
                () => "loaded",
                (error) => [error.code, error.tableLabel ?? null],
              );
          };
          assert.deepEqual(await restoreOnReload(), ["moved", target === B ? "T-B" : "T-F"]);
          assert.equal(getMovedTableLabel(), target === B ? "T-B" : "T-F");
          // A new visit (the phone scans the new table's code) forgets it.
          setCustomerCsrfCredential("x".repeat(43));
          assert.equal(getMovedTableLabel(), null);
          setCustomerCsrfCredential(null);

          // ── Refused, with nothing recorded: a table with another party (merging is not
          // offered), one without a code, one being cleaned; and a table checking out.
          const from = { from: target };
          for (const [to, code] of [
            [E, "DINING_TABLE_MOVE_TARGET_OCCUPIED"],
            [C, "DINING_TABLE_MOVE_TARGET_NO_CODE"],
            [D, "DINING_TABLE_MOVE_TARGET_UNAVAILABLE"],
          ])
            await assert.rejects(move(server, fresh(), to, from), { code });
          assert.equal((await closing(server, "Begin")).phase, "Closing");
          const other = target === B ? F : B;
          await assert.rejects(move(server, fresh(), other, from), {
            code: "DINING_TABLE_MOVE_CHECKING_OUT",
          });
          // Back to ordering: the party goes on, pays and its table closes (below, as usual).
          assert.equal((await closing(server, "Cancel")).phase, "Active");

          // ── v15 2026-10-30: moved back to the first table (A to B and back to A) once it is
          // cleaned. The host's phone (it joined at A before) is told the party sits at A now; a
          // scan of A's code joins it again.
          const cleanedVersion = await tableVersion(fromTable);
          await createMerchantDiningTableCommand({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            newReference: fresh,
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          })({
            ...as(server),
            command: {
              action: "ClearBlock",
              tableReference: fromTable,
              expectedAggregateVersion: cleanedVersion,
              operationReference: fresh(),
              reasonCode: null,
            },
          });
          const back = await move(server, fresh(), fromTable, from);
          assert.equal(back.tableLabel, dining.table.stableLabel);
          assert.deepEqual(
            await transactions().run((tx) =>
              loadDiningParticipantMove(tx, scope, {
                diningSessionReference: sessionReference,
                participantReference: id(0x601),
              }),
            ),
            { tableLabel: dining.table.stableLabel, fromTableLabel: dining.table.stableLabel },
          );
          assert.equal(await binding(fromTable), null);
          const rejoined = await scanAt(fromTable, fresh());
          assert.equal(rejoined.status, "Issued", JSON.stringify(rejoined));
          assert.equal(
            (
              await rows(
                "SELECT count(*)::int n FROM rms_dining.dining_session_move_operation WHERE session_id=$1",
                [sessionReference],
              )
            )[0].n,
            2,
          );
          // The move record is append-only: the pilot role can't change it (and nothing does).
          const changed = await transactions({ guc: true })
            .run((tx) =>
              tx.query(
                "UPDATE rms_dining.dining_session_move_operation SET occurred_at=occurred_at WHERE session_id=$1",
                [sessionReference],
              ),
            )
            .then(
              (result) => result.rowCount,
              (error) => String(error),
            );
          assert.ok(
            changed === 0 || /permission denied/u.test(String(changed)),
            "the move record changed: " + String(changed),
          );
        }
        if (ending === "TeaCharge") {
          // The tea charge is round 2's dish (a synthetic stand-in for the Store's tea item).
          const [{ sku }] = await rows(
            "SELECT transaction_snapshot_json->'catalog'->>'sellableReference' AS sku FROM rms_ordering.order_item WHERE order_item_id=$1",
            [String(items2[0].orderItemReference)],
          );
          const placed = [];
          const tea = (who, command) =>
            createMerchantDiningTeaCharge({
              persistence: persistenceOf(who),
              authentication: who.authentication,
              now,
              placeRound: async (input) => {
                placed.push(input.command);
                return { status: "Placed" };
              },
              removeItems: (input) =>
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
                })(input),
            })({ ...as(who), command });
          const sync = (who, operationReference = fresh()) =>
            tea(who, {
              action: "Sync",
              diningSessionReference: sessionReference,
              operationReference,
            });
          const readTea = () =>
            tea(server, { action: "Read", diningSessionReference: sessionReference });
          // No tea charge yet: nothing is ever added.
          assert.equal((await readTea()).status, "NoTeaCharge");
          await transactions().run((tx) =>
            changeDiningTeaChargeSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: 0,
              teaSellableReference: sku,
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          const before = await readTea();
          assert.equal(before.status, "NoPartySize");
          const charged = before.charged;
          assert.ok(charged >= 1);
          const party = (version, size) =>
            transactions().run((tx) =>
              recordDiningPartySize(tx, ownerScope, {
                diningSessionReference: sessionReference,
                operationReference: fresh(),
                expectedVersion: version,
                partySize: size,
                actorReference: id(0x700),
                observedAt: now(),
              }),
            );
          // One more guest than tea on the bill: the difference is added as a staff round.
          await party(0, charged + 1);
          const addOperation = fresh();
          const more = await sync(server, addOperation);
          assert.deepEqual(
            [more.status, more.charged, more.expected],
            ["Mismatch", charged, charged + 1],
          );
          assert.equal(placed.length, 1);
          assert.deepEqual(placed[0].lines, [
            { sellableReference: sku, quantity: 1, optionSelections: [], note: null },
          ]);
          assert.equal(placed[0].tip.kind, "None");
          // The same sync again asks for the same round (its operation), never a second one.
          await sync(server, addOperation);
          assert.equal(placed[1].operationReference, placed[0].operationReference);
          // Fewer guests: as many as round 2's tea held. A server who may not take dishes off
          // changes nothing: left for a manager.
          const fewer = charged - items2[0].quantity;
          assert.ok(fewer >= 1);
          await party(1, fewer);
          const outsiderTea = await seedMerchantAcceptanceSession({
            admin,
            runner: transactions(),
            scope: ownerScope,
            actor: id(0x703),
            at: now(),
            extraPermissions: ["dining.operate"],
            referencePrefix: "019099aa",
            sessionReferencePrefix: "019099ab",
          });
          const refused = await sync(outsiderTea);
          assert.deepEqual([refused.status, refused.problem], ["Mismatch", "NeedsManager"]);
          assert.deepEqual(
            await rows(
              "SELECT count(*)::int AS n FROM rms_ordering.order_item_staff_cancellation WHERE order_id=$1",
              [orderReference],
            ),
            [{ n: 0 }],
          );
          // The server takes the newest tea off with "guests left"; the line stays on record.
          const lessOperation = fresh();
          placed.length = 0;
          const less = await sync(server, lessOperation);
          assert.deepEqual([less.status, less.charged, less.expected], ["Charged", fewer, fewer]);
          assert.deepEqual(
            await rows(
              "SELECT basis,reason_code,actor_id::text AS actor,order_item_ids::text[] AS items FROM rms_ordering.order_item_staff_cancellation WHERE order_id=$1",
              [orderReference],
            ),
            [
              {
                basis: "PayLater",
                reason_code: "GUEST_LEFT",
                actor: id(0x700),
                items: [String(items2[0].orderItemReference)],
              },
            ],
          );
          assert.deepEqual(
            await rows(
              "SELECT count(*)::int AS n FROM rms_ordering.order_item WHERE order_item_id=$1",
              [String(items2[0].orderItemReference)],
            ),
            [{ n: 1 }],
          );
          // The same sync again takes nothing more off.
          await sync(server, lessOperation);
          assert.equal(
            (
              await rows(
                "SELECT count(*)::int AS n FROM rms_ordering.order_item_staff_cancellation WHERE order_id=$1",
                [orderReference],
              )
            )[0].n,
            1,
          );
          // Exactly the guests are charged: nothing is added back.
          assert.deepEqual(placed, []);
          // Staff set a tea count other than the guests, with the reason (here one more: the
          // coordinator's v15 live check proves a lower count against real tea rounds). It is
          // recorded with who, when and why, and the tea follows it.
          placed.length = 0;
          const higher = fewer + 1;
          const counted = await tea(server, {
            action: "SetTeaCount",
            diningSessionReference: sessionReference,
            operationReference: fresh(),
            expectedVersion: 0,
            teaQuantity: higher,
            reason: "Other",
          });
          assert.deepEqual(counted.override, { teaQuantity: higher, reason: "Other", version: 1 });
          assert.deepEqual([counted.expected, counted.guests], [higher, fewer]);
          assert.deepEqual(
            await rows(
              "SELECT version,tea_quantity,reason_code,actor_id::text AS actor FROM rms_dining.dining_session_tea_override WHERE session_id=$1",
              [sessionReference],
            ),
            [{ version: 1, tea_quantity: higher, reason_code: "Other", actor: id(0x700) }],
          );
          assert.deepEqual(
            placed.map((command) => command.lines[0].quantity),
            [higher - fewer],
          );
          // A stale tea count version is refused (another server set it first).
          await assert.rejects(
            tea(server, {
              action: "SetTeaCount",
              diningSessionReference: sessionReference,
              operationReference: fresh(),
              expectedVersion: 0,
              teaQuantity: fewer,
              reason: "GuestDeclined",
            }),
          );
          await assert.rejects(
            admin.query("UPDATE rms_dining.dining_session_tea_override SET tea_quantity=9"),
            /append-only tea override/u,
          );
          // A party size recorded later: the tea follows the guests again.
          await party(2, fewer + 2);
          const after = await readTea();
          assert.deepEqual(
            [after.override, after.expected, after.guests],
            [null, fewer + 2, fewer + 2],
          );
          return;
        }
        // The Comped ending keeps round 2 on the bill: its one dish is comped instead (v15 case).
        if (ending !== "Comped" && ending !== "TaxRounding") {
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
            removal(server, {
              expectedOrderVersion: beforeRemoval - 1,
              operationReference: fresh(),
            }),
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
        }
        // Round 2's only dish came off: the whole round is off the bill (it owes nothing).
        assert.equal(items2.length, 1);
        const removedMinor =
          ending === "Comped" || ending === "TaxRounding"
            ? 0n
            : items2[0].pricing.total.amountMinor;
        // Paying before checkout started is refused: rounds can still be added.
        await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_NOT_STARTED" });
        // Checkout starts again with round 2 on the table.
        const begun = await closing(server, "Begin");
        assert.equal(begun.phase, "Closing");

        // The bill: round 1 owed with its items, before tax, tax and total; round 2 owes nothing.
        const round1Minor = items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
        const round2Minor =
          items2.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) - removedMinor;
        if (ending !== "Comped" && ending !== "TaxRounding") assert.equal(round2Minor, 0n);
        const open = await bill();
        assert.equal(open.paymentTiming, "PayLater");
        assert.equal(open.sessionPhase, "Closing");
        assert.equal(open.consistent, true);
        assert.deepEqual(
          open.rounds.map((round) => [round.roundNumber, round.totalMinor, round.paid]),
          [
            [1, round1Minor.toString(), false],
            [2, round2Minor.toString(), false],
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
        /**
         * The kitchen makes round 1 (accepts, starts and completes each dish through the pilot
         * kitchen lifecycle) and staff serve it; round 2 came off the bill. Returns the progress.
         */
        async function cookAndServeRound1(
          rounds = [{ c: c1, event: event1, batch: R1.batch, items: items1 }],
          options = {},
        ) {
          for (const round of rounds) {
            if (options.notPrepared) {
              // WP-2423 item 8 ⑦: a round of dishes the kitchen does not prepare has no kitchen
              // source (its kitchen work is nothing), so no ticket, nothing to cook or serve.
              await assert.rejects(
                transactions().run((tx) =>
                  createPostgresOrderKitchenSourceStore({
                    ...scope,
                    quoteVersion: 1,
                    sha256,
                    authorize: async () => true,
                    notPrepared: async (transaction, round) =>
                      new Set(
                        (
                          await loadKitchenBatchPreparationDecision(
                            transaction,
                            scope,
                            round.orderBatchReference,
                          )
                        )?.notPreparedOrderItemReferences ?? [],
                      ),
                  }).resolve({
                    transaction: tx,
                    query: {
                      brandReference: scope.brandReference,
                      storeReference: scope.storeReference,
                      orderReference: round.orderReference ?? orderReference,
                      orderBatchReference: String(round.c.orderBatchReference),
                      confirmationReference: String(round.c.confirmationReference),
                      sourceEventReference: round.event.eventId,
                      sourceAggregateVersion: round.event.aggregateVersion,
                      sourceSnapshotDigest: String(round.c.sourceSnapshotDigest),
                      observedAt: now(),
                    },
                  }),
                ),
                { code: "ORDER_KITCHEN_SOURCE_NOTHING_TO_PREPARE" },
              );
              continue;
            }
            // ── Kitchen: round 1's ticket, one queued work item per dish (test-only owner seed, as
            // the dine-in item cancellation acceptance seeds it), whose source evidence is the real
            // Ordering kitchen source of the pay-later round as it is now.
            const sourceQuery = {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              orderReference: round.orderReference ?? orderReference,
              orderBatchReference: String(round.c.orderBatchReference),
              confirmationReference: String(round.c.confirmationReference),
              sourceEventReference: round.event.eventId,
              sourceAggregateVersion: round.event.aggregateVersion,
              sourceSnapshotDigest: String(round.c.sourceSnapshotDigest),
            };
            const sourceStore = createPostgresOrderKitchenSourceStore({
              ...scope,
              quoteVersion: 1,
              sha256,
              authorize: async () => true,
            });
            const issued = await transactions().run((tx) =>
              sourceStore.resolve({
                transaction: tx,
                query: { ...sourceQuery, observedAt: now() },
              }),
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
                round.orderReference ?? orderReference,
                round.batch.orderBatchReference,
                String(round.c.confirmationReference),
                round.event.eventId,
                String(round.c.sourceSnapshotDigest),
                String(round.c.confirmedAt),
                correlation,
                sha256("binding:" + ticket),
                evidence,
                issued.evidenceDigest,
                kitchenAt,
                plan,
                sha256("plan:" + ticket),
                round.event.aggregateVersion,
              ],
            );
            const workItems = round.items.map(() => fresh());
            for (const [j, item] of round.items.entries())
              await admin.query(
                "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',$11,0,$12,$13,$14,$15,$16::jsonb,'[]'::jsonb,$17,$18,$19,1,$20,$21,1,$22,$23::jsonb,$24,'System','System',$25,$25)",
                [
                  workItems[j],
                  scope.brandReference,
                  scope.storeReference,
                  ticket,
                  round.orderReference ?? orderReference,
                  round.batch.orderBatchReference,
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
            for (const [j, item] of round.items.entries()) {
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
          }
          // Inventory uses the dishes from the Kitchen lifecycle Events (as the pilot consumers do).
          // WP-2423 item 8 ⑨: the rounds of one Order (a merged table's round is of its own).
          const cooked = rounds[0]?.orderReference ?? orderReference;
          const consume = createKitchenInventoryConsumption({
            scope: ownerScope,
            nextReference: fresh,
            authorize: async () => true,
            retentionPolicy: { code: "AUDIT_DEFAULT", version: 1 },
          });
          for (const event of await rows(
            "SELECT event_id::text AS id FROM platform_eventing.outbox_event WHERE event_type IN ('KitchenWorkStarted','KitchenItemCompleted') AND payload_json->>'orderReference'=$1 ORDER BY occurred_at,event_id",
            [cooked],
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
            })({ ...as(server), query: { orderReference: cooked } });
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
          for (const item of options.notPrepared ? [] : rounds.flatMap((round) => round.items))
            await serve({
              ...as(server),
              command: {
                operationReference: fresh(),
                orderReference: cooked,
                orderItemReference: String(item.orderItemReference),
                quantity: item.quantity,
                expectedOrderVersion: ready.currentOrderVersion,
                expectedItemServiceVersion: 0,
                expectedSessionVersion: ready.sessionVersion,
                expectedTableAssignmentVersion: ready.tableAssignmentVersion,
              },
            });
          const served = await progress();
          if (
            ending !== "Comped" &&
            ending !== "TaxRounding" &&
            ending !== "Merged" &&
            cooked === orderReference
          ) {
            // Round 1 served; round 2's dishes, taken off the bill before the table paid, are cancelled.
            assert.deepEqual(
              served.items.map((item) => [item.batchSequence, item.phase]),
              [
                [1, "Fulfilled"],
                [2, "Cancelled"],
              ],
            );
          }
          return served;
        }
        async function writtenOffEnding() {
          const served = await cookAndServeRound1();

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
        const comp = (who, command) =>
          createMerchantDiningItemComp({
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
              orderItemReferences: [String(items1[0].orderItemReference)],
              kind: "Comp",
              percent: null,
              amountOffMinor: null,
              reasonCode: "QUALITY",
              operationReference: fresh(),
              ...command,
            },
          });
        const price = (item) => ({
          net: item.pricing.subtotal.amountMinor - item.pricing.discount.amountMinor,
          tax: item.pricing.tax.amountMinor,
          fee: item.pricing.fee.amountMinor,
          total: item.pricing.total.amountMinor,
          subtotal: item.pricing.subtotal.amountMinor,
        });
        /** The day's sales reports from the same sources and composition the reports page uses. */
        // Function declarations (hoisted): the merged table's journey ends earlier in this block.
        function salesReport() {
          return transactions().run(async (tx) => {
            const window = {
              startsAt: time(-minutes(120)),
              endsAt: new Date(Date.now() + 1000).toISOString(),
            };
            const sources = await loadStoreSalesReportSources(tx, {
              scope: ownerScope,
              configuration: { providerAccountReference: provider, environment: "Test" },
              window,
              observedAt: new Date(Date.now() + 1000).toISOString(),
              locale: "en-CA",
              authorize: async () => true,
            });
            return computeStoreSalesReport({
              storeLabel: "Synthetic Store",
              timeZone: "America/Toronto",
              days: [
                {
                  businessDate: "2026-10-27",
                  ...window,
                  timeZone: "America/Toronto",
                  status: "Open",
                },
              ],
              payments: sources.ledger.payments,
              refundedPayments: sources.ledger.refundedPayments,
              refunds: sources.ledger.refunds,
              settlement: sources.ledger.settlement,
              unresolvedOnlineRefundCount: sources.ledger.unresolvedOnlineRefundCount,
              unpaidWriteOffs: sources.ledger.unpaidWriteOffs,
              orders: sources.orders,
              priceReductions: sources.priceReductions,
              mayExport: true,
              generatedAt: new Date().toISOString(),
            });
          });
        }
        /**
         * v15 2026-10-30 (the reported books gap): every round a table paid counts once in the day's
         * sales and tax, however it paid — whole, split evenly or by rounds, across cash, card
         * machine and phone, merged or comped — so net sales, service charges and tax are exactly
         * what the table bills took for their rounds, nothing is left unmatched, and the money
         * still agrees with the day-end settlement.
         */
        async function assertSalesCountEveryRoundOnce() {
          const report = await salesReport();
          const [paid] = await rows(
            "SELECT coalesce(sum(rounds_minor),0)::text AS rounds FROM rms_payment.dining_table_settlement",
          );
          const s = report.summary;
          assert.deepEqual(
            {
              unmatched: s.unmatchedMinor,
              sold: (
                BigInt(s.netSalesMinor) +
                BigInt(s.serviceChargesMinor) +
                BigInt(s.taxMinor)
              ).toString(),
              taxes: s.taxes.reduce((sum, tax) => sum + BigInt(tax.amountMinor), 0n).toString(),
              matches: report.reconciliation.matchesSettlement,
            },
            { unmatched: "0", sold: paid.rounds, taxes: s.taxMinor, matches: true },
          );
          for (const row of report.byChannel) assert.equal(row.unmatchedMinor, "0", row.channel);
          return report;
        }
        /** WP-2423 item 8 ②: the closing summary's open tables and cancellations, as the API role. */
        const tonightFacts = () =>
          transactions().run((tx) =>
            readTonightFacts(tx, {
              scope: ownerScope,
              window: {
                startsAt: time(-minutes(120)),
                endsAt: new Date(Date.now() + 1000).toISOString(),
              },
              observedAt: new Date().toISOString(),
              authorize: async () => true,
            }),
          );
        const round2 = { c: c2, event: event2, batch: R2.batch, items: items2 };
        const round1 = { c: c1, event: event1, batch: R1.batch, items: items1 };
        /**
         * v15 2026-10-27 (the reported case): round 2 is one dish, comped in full by a manager; round
         * 1 is discounted 50 % and paid in cash. The comped dish stays in the sales, the comps are
         * their own line, and reports, the day-end settlement and the export all say so.
         */
        async function compedEnding() {
          const mocha = String(items2[0].orderItemReference);
          // Before the kitchen starts a dish it is taken off the bill instead (the kitchen stops it).
          await assert.rejects(comp(manager, { orderItemReferences: [mocha] }), {
            code: "ITEM_COMP_NOT_STARTED",
          });
          await cookAndServeRound1([round1, round2]);
          // A server (no comp permission) is refused; nothing is written.
          await assert.rejects(comp(server, { orderItemReferences: [mocha] }), {
            code: "ITEM_COMP_PERMISSION_DENIED",
          });
          const first = price(items1[0]),
            second = price(items2[0]);
          // The browser never sets the money: an amount off the whole dish or more is refused.
          await assert.rejects(
            comp(manager, { kind: "Amount", amountOffMinor: String(first.net) }),
            {
              code: "ITEM_COMP_INVALID_AMOUNT",
            },
          );
          // The database checks the money itself: 0.01 off with 0.05 tax is not this dish's rule.
          await assert.rejects(
            admin.query(
              "INSERT INTO rms_ordering.order_item_price_reduction (reduction_id,operation_id,brand_id,store_id,order_id,order_batch_id,order_item_id,kind,percent,net_minor,tax_minor,fee_minor,total_minor,currency_code,reason_code,actor_id,permission_code,audit_id,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'Amount',NULL,1,5,0,6,'CAD','GOODWILL',$8,'ordering.order.comp',$9,date_trunc('milliseconds',now()))",
              [
                fresh(),
                fresh(),
                scope.brandReference,
                scope.storeReference,
                orderReference,
                R1.batch.orderBatchReference,
                String(items1[0].orderItemReference),
                id(0x701),
                fresh(),
              ],
            ),
            /price reduction amount mismatch/u,
          );
          // The manager comps round 2's only dish (food quality): net, tax and fee all come off.
          const compOperation = fresh();
          const comped = await comp(manager, {
            orderItemReferences: [mocha],
            operationReference: compOperation,
          });
          assert.deepEqual(
            comped.reductions.map((entry) => [entry.kind, entry.amountMinor, entry.reasonCode]),
            [["Comp", second.total.toString(), "QUALITY"]],
          );
          // The same request again is that comp; a second decision on the dish is refused.
          assert.equal(
            (
              await comp(manager, {
                orderItemReferences: [mocha],
                operationReference: compOperation,
              })
            ).status,
            "AlreadyRecorded",
          );
          await assert.rejects(comp(manager, { orderItemReferences: [mocha] }), {
            code: "ITEM_COMP_ALREADY_COMPED",
          });
          // Round 1's dish 50 % off (the guests waited too long): tax in proportion, half up.
          const discountNet = (first.net * 50n + 50n) / 100n;
          const share = (amount) => (amount * discountNet * 2n + first.net) / (2n * first.net);
          const discountMinor = discountNet + share(first.tax) + share(first.fee);
          const discounted = await comp(manager, {
            kind: "Percent",
            percent: 50,
            reasonCode: "LONG_WAIT",
          });
          assert.deepEqual(
            discounted.reductions.map((entry) => [entry.kind, entry.percent, entry.amountMinor]),
            [["Percent", 50, discountMinor.toString()]],
          );
          await assert.rejects(
            admin.query("UPDATE rms_ordering.order_item_price_reduction SET total_minor=1"),
            /append-only/u,
          );
          await assert.rejects(
            admin.query("DELETE FROM rms_ordering.order_item_price_reduction"),
            /append-only/u,
          );
          assert.deepEqual(
            await rows(
              "SELECT action_code,actor_reference::text AS actor,reason_code FROM platform_audit.audit_record WHERE action_code IN ('ORDER_ITEM_COMPED','ORDER_ITEM_DISCOUNTED') ORDER BY action_code",
            ),
            [
              { action_code: "ORDER_ITEM_COMPED", actor: id(0x701), reason_code: "QUALITY" },
              { action_code: "ORDER_ITEM_DISCOUNTED", actor: id(0x701), reason_code: "LONG_WAIT" },
            ],
          );
          // The bill: round 2 owes nothing, round 1 less its discount; the dishes stay on it.
          const owedNow = await bill();
          assert.equal(owedNow.consistent, true);
          assert.deepEqual(
            owedNow.rounds.map((round) => [round.roundNumber, round.totalMinor]),
            [
              [1, (round1Minor - discountMinor).toString()],
              [2, "0"],
            ],
          );
          assert.equal(owedNow.owed.totalMinor, (round1Minor - discountMinor).toString());
          assert.deepEqual(owedNow.rounds[1].items[0].reduction, {
            kind: "Comp",
            percent: null,
            amountMinor: second.total.toString(),
          });
          // Closing summary: the table is open, checking out, and owes exactly its bill.
          const beforePaying = await tonightFacts();
          assert.deepEqual(
            beforePaying.openTables.map((table) => [
              table.phase,
              table.paymentTiming,
              table.owedMinor,
            ]),
            [["Closing", "PayLater", (round1Minor - discountMinor).toString()]],
          );
          assert.ok(beforePaying.openTables[0].openedMinutes >= 0);
          assert.equal(beforePaying.openTablesOwedMinor, (round1Minor - discountMinor).toString());
          assert.equal(beforePaying.cancelled.removedBeforePayment.dishCount, 0);
          // The table pays what is left, in cash; round 2 is never a payment line.
          const paid = await settleWith(server, {});
          assert.equal(paid.status, "Recorded");
          assert.equal(paid.bill.settlement.roundsMinor, (round1Minor - discountMinor).toString());
          assert.deepEqual(
            await rows(
              "SELECT r.order_batch_id::text AS batch FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id WHERE s.order_id=$1",
              [orderReference],
            ),
            [{ batch: R1.batch.orderBatchReference }],
          );
          // A paid table is refunded instead: no comp after payment.
          await assert.rejects(comp(manager, {}), { code: "ITEM_COMP_ALREADY_PAID" });
          // Paid and still seated: the closing summary lists it with nothing left to take.
          assert.deepEqual(
            (await tonightFacts()).openTables.map((table) => table.owedMinor),
            ["0"],
          );
          // The Order is settled at its priced total less the comps (closing can follow).
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
            assert.equal(priced.pricedTotalMinor, round1Minor - discountMinor);
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
          // Reports (as the reports page composes them, under the pilot API role): both dishes sold
          // at their price, the two comps on their own line, net sales and tax less them, and the
          // takings still the settlement's (no sales suppression).
          const report = await salesReport();
          const compsMinor = second.net + discountNet;
          assert.equal(
            report.summary.grossSalesMinor,
            (first.subtotal + second.subtotal).toString(),
          );
          assert.equal(report.summary.compCount, 2);
          assert.equal(report.summary.compsMinor, compsMinor.toString());
          assert.equal(
            report.summary.netSalesMinor,
            (first.subtotal + second.subtotal - compsMinor).toString(),
          );
          assert.equal(report.summary.unmatchedPaymentCount, 0);
          assert.equal(report.reconciliation.matchesSettlement, true);
          // Every dish sold is in the item rows (the comped one too), with its comp.
          assert.equal(
            report.items.reduce((sum, row) => sum + row.quantitySold, 0),
            items1[0].quantity + items2[0].quantity,
          );
          assert.equal(
            report.items.reduce((sum, row) => sum + BigInt(row.compsMinor), 0n),
            compsMinor,
          );
          // …and in the export.
          const [header, line] = storeSalesReportCsv(report, "summary").slice(1).split("\r\n");
          const columns = header.split(",");
          const values = line.split(",");
          assert.equal(values[columns.indexOf("comps_and_discounts_count")], "2");
          assert.equal(
            values[columns.indexOf("comps_and_discounts_by_manager")],
            (Number(compsMinor) / 100).toFixed(2),
          );
          // The day-end settlement's line: what managers took off today, by dish.
          const decided = await transactions().run((tx) =>
            listStorePriceReductionsDecided(tx, scope, {
              startsAt: time(-minutes(120)),
              endsAt: new Date(Date.now() + 1000).toISOString(),
            }),
          );
          assert.equal(decided.length, 2);
          assert.equal(
            decided.reduce((sum, record) => sum + record.totalMinor, 0n),
            second.total + discountMinor,
          );
          // Another Store of the Brand sees none of it (row security).
          assert.deepEqual(
            await transactions().run((tx) =>
              listStorePriceReductionsDecided(
                tx,
                { brandReference: scope.brandReference, storeReference: id(0x7ff) },
                {
                  startsAt: time(-minutes(120)),
                  endsAt: new Date(Date.now() + 1000).toISOString(),
                },
              ),
            ),
            [],
          );
        }
        /**
         * Round 2 came off the bill (S3); the manager comps round 1's dishes in full. The table owes
         * nothing: no payment is taken, the Order is settled at zero and the table closes as usual,
         * and the comped dishes are still in the day's sales.
         */
        /**
         * WP-2423 item 8 ⑦ (decision 2): how many guests sit at the table, as the merchant API
         * composes it. Not asked until the owner turns it on; recorded against the version seen
         * (a stale one is refused, the same operation returns); the record is append-only.
         */
        const partySize = (who, command) =>
          createMerchantDiningPartySize({
            persistence: persistenceOf(who),
            authentication: who.authentication,
            now,
          })({ ...as(who), command });
        async function partySizeWhileOpen() {
          const read = () =>
            partySize(server, { action: "Read", diningSessionReferences: [sessionReference] });
          assert.deepEqual(await read(), { askPartySize: false, partySizes: [] });
          await transactions().run((tx) =>
            changeDiningServiceSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: 0,
              staffCall: false,
              chaseDish: false,
              askPartySize: true,
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          const first = fresh();
          const record = (operationReference, expectedVersion, size) =>
            partySize(server, {
              action: "Record",
              diningSessionReference: sessionReference,
              operationReference,
              expectedVersion,
              partySize: size,
            });
          assert.deepEqual(await record(first, 0, 4), {
            diningSessionReference: sessionReference,
            partySize: 4,
            version: 1,
          });
          // The same operation again returns it; the same with another number is a conflict.
          assert.equal((await record(first, 0, 4)).version, 1);
          await assert.rejects(record(first, 0, 5), { code: "DINING_PARTY_SIZE_CHANGED" });
          // Another server saw no party size yet: refused, read again.
          await assert.rejects(record(fresh(), 0, 3), { code: "DINING_PARTY_SIZE_CHANGED" });
          // A fifth guest arrives.
          assert.equal((await record(fresh(), 1, 5)).version, 2);
          await assert.rejects(record(fresh(), 2, 100), {
            code: "DINING_PARTY_SIZE_INPUT_INVALID",
          });
          assert.deepEqual(await read(), {
            askPartySize: true,
            partySizes: [{ diningSessionReference: sessionReference, partySize: 5, version: 2 }],
          });
          assert.deepEqual(
            await rows(
              "SELECT version,party_size,actor_id::text AS actor FROM rms_dining.dining_session_party_size WHERE session_id=$1 ORDER BY version",
              [sessionReference],
            ),
            [
              { version: 1, party_size: 4, actor: id(0x700) },
              { version: 2, party_size: 5, actor: id(0x700) },
            ],
          );
          await assert.rejects(
            admin.query("UPDATE rms_dining.dining_session_party_size SET party_size=2"),
            /append-only party size/u,
          );
          return record;
        }

        /**
         * WP-2423 item 8 ⑦ (decision 2): the owner marks round 1's dish as not prepared by the
         * kitchen before the round reaches it. The kitchen fixes that for the round as it takes it
         * (a later change of the mark doesn't move it); a round of only such dishes makes no
         * ticket and is still taken once; the dish counts as served once ordered.
         */
        async function notPreparedRound1() {
          const all = await transactions().run((tx) =>
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
                orderBatchReference: String(c1.orderBatchReference),
                confirmationReference: String(c1.confirmationReference),
                sourceEventReference: event1.eventId,
                sourceAggregateVersion: event1.aggregateVersion,
                sourceSnapshotDigest: String(c1.sourceSnapshotDigest),
                observedAt: now(),
              },
            }),
          );
          const lines = all.items.map((item) => ({
            orderItemReference: String(item.orderItemReference),
            productReference: String(item.productReference),
          }));
          assert.equal(lines.length, 1);
          const mark = await transactions().run((tx) =>
            changeKitchenNotPreparedProduct(tx, ownerScope, {
              productReference: lines[0].productReference,
              operationReference: fresh(),
              expectedVersion: 0,
              notPrepared: true,
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          assert.deepEqual(mark, { notPrepared: true, version: 1 });
          const ticketsMade = [];
          const intake = () =>
            createKitchenNotPreparedIntakeAdapter({
              inner: {
                resolveByIdentity: async () => ({ status: "NotFound" }),
                accept: async (input) => {
                  ticketsMade.push(input.receipt);
                  return { status: "Created", receipt: input.receipt };
                },
              },
              scope,
              now,
              allLines: async () => lines,
            });
          const receipt = createConfirmedOrderIntakeReceipt({
            sourceEvent: event1,
            semanticEventBindingDigest: sha256("semantic:" + event1.eventId),
          });
          const accepted = await transactions().run((tx) =>
            intake().accept({ receipt, transaction: tx }),
          );
          assert.equal(accepted.status, "Created");
          // Nothing to prepare: no ticket was asked for, and the round is known as taken.
          assert.deepEqual(ticketsMade, []);
          const again = await transactions().run((tx) =>
            intake().resolveByIdentity({
              brandReference: receipt.brandReference,
              storeReference: receipt.storeReference,
              sourceEventReference: receipt.sourceEventReference,
              confirmationReference: receipt.confirmationReference,
              orderBatchReference: receipt.orderBatchReference,
              transaction: tx,
            }),
          );
          assert.equal(again.status, "Resolved");
          assert.equal(again.receipt.sourceAggregateVersion, receipt.sourceAggregateVersion);
          assert.equal(
            (await transactions().run((tx) => intake().accept({ receipt, transaction: tx })))
              .status,
            "AlreadyAccepted",
          );
          // Clearing the mark later doesn't move what the kitchen decided for the round.
          await transactions().run((tx) =>
            changeKitchenNotPreparedProduct(tx, ownerScope, {
              productReference: lines[0].productReference,
              operationReference: fresh(),
              expectedVersion: 1,
              notPrepared: false,
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          assert.deepEqual(
            await rows(
              "SELECT not_prepared_order_item_ids::text[] AS items,all_not_prepared FROM rms_kitchen.kitchen_batch_preparation_decision WHERE order_batch_id=$1",
              [String(c1.orderBatchReference)],
            ),
            [{ items: [lines[0].orderItemReference], all_not_prepared: true }],
          );
          await assert.rejects(
            admin.query(
              "UPDATE rms_kitchen.kitchen_batch_preparation_decision SET all_not_prepared=false",
            ),
            /append-only kitchen preparation record/u,
          );
        }

        /**
         * WP-2423 DEC-TAX-WHOLE-RECEIPT step 2: the bill is one receipt — its tax is rounded once
         * over every dish, and the difference from what the rounds were charged is the bill's "Tax
         * rounding", recorded by the system rule before a payment is planned or taken (a new version
         * when the bill changed), frozen once anything is paid, and part of the Order's priced total.
         * $0.50 off a $20.00 dish leaves 253.5¢ tax, charged 253¢ on its round: two such rounds are
         * charged 506¢ while the bill's tax is 507¢.
         */
        async function taxRoundingEnding() {
          await cookAndServeRound1([round1, round2]);
          const dish1 = String(items1[0].orderItemReference),
            dish2 = String(items2[0].orderItemReference);
          // What the bill's tax should be, from its own figures (every dish here is 13% HST).
          const wholeBill = (current) => {
            const taxable = current.rounds.reduce((sum, r) => sum + BigInt(r.subtotalMinor), 0n);
            const charged = current.rounds.reduce(
              (sum, r) => sum + BigInt(r.taxMinor) - BigInt(r.taxRoundingMinor),
              0n,
            );
            return { taxable, charged, tax: (taxable * 13n + 50n) / 100n };
          };
          const recorded = () =>
            rows(
              "SELECT version,supersedes_adjustment_id IS NOT NULL AS supersedes,rule_code,rule_version,total_minor::text AS total,(SELECT array_agg(l.order_batch_id::text||':'||l.tax_component_code||':'||l.amount_minor ORDER BY l.line_number) FROM rms_ordering.order_tax_rounding_adjustment_line l WHERE l.adjustment_id=a.adjustment_id) AS lines FROM rms_ordering.order_tax_rounding_adjustment a WHERE bill_order_id=$1 ORDER BY version",
              [orderReference],
            );
          const splitInTwo = () =>
            createMerchantDiningTableSplit({
              persistence: persistenceOf(server),
              authentication: server.authentication,
              nextReference: fresh,
            })({
              ...as(server),
              command: {
                operationReference: fresh(),
                diningSessionReference: sessionReference,
                mode: "Even",
                people: 3,
                rounds: null,
              },
            });
          const discount = (dish) =>
            comp(manager, {
              orderItemReferences: [dish],
              kind: "Amount",
              amountOffMinor: "50",
              reasonCode: "GOODWILL",
            });

          // Before any discount the rounds already add up to the bill's tax: nothing to round.
          const before = await bill();
          const plain = wholeBill(before);
          assert.equal(before.taxRoundingMinor, "0");
          assert.equal(plain.charged, plain.tax);

          // $0.50 off round 1's dish: the bill shows the rounding it would record (not yet recorded).
          await discount(dish1);
          const one = await bill();
          const afterOne = wholeBill(one);
          assert.equal(BigInt(one.taxRoundingMinor), afterOne.tax - afterOne.charged);
          assert.equal(one.consistent, true);
          assert.deepEqual(await recorded(), []);
          // Planning the split records it (system rule, version 1) when there is something to round.
          const firstSplit = await splitInTwo();
          assert.equal(firstSplit.status, "Recorded");
          const v1 = await recorded();
          assert.deepEqual(
            v1.map((row) => [row.version, row.total]),
            afterOne.tax === afterOne.charged ? [] : [[1, one.taxRoundingMinor]],
          );

          // $0.50 off round 2's dish: the bill changed before anything was paid, so the split is
          // stale and planning it again records a new version superseding the last.
          await discount(dish2);
          const two = await bill();
          const afterTwo = wholeBill(two);
          assert.equal(afterTwo.tax - afterTwo.charged, 1n);
          assert.equal(two.taxRoundingMinor, "1");
          assert.equal(two.split.stale, true);
          const resplit = await splitInTwo();
          assert.equal(resplit.status, "Recorded");
          const versions = await recorded();
          const last = versions.at(-1);
          assert.deepEqual(
            [last.version, last.supersedes, last.rule_code, last.rule_version, last.total],
            [versions.length, versions.length > 1, "DEC_TAX_WHOLE_RECEIPT", 1, "1"],
          );
          assert.equal(last.lines.length, 1);
          // The bill charges exactly the whole bill's tax: the rounds' tax (with the rounding)
          // adds up to round(taxable × 13%), and the parts add up to the bill.
          const planned = resplit.bill;
          const owed = BigInt(planned.owed.totalMinor);
          assert.equal(
            planned.rounds.reduce((sum, r) => sum + BigInt(r.taxMinor), 0n),
            afterTwo.tax,
          );
          assert.equal(owed, afterTwo.taxable + afterTwo.tax);
          assert.equal(
            planned.split.parts.reduce((sum, part) => sum + BigInt(part.amountMinor), 0n),
            owed,
          );

          // Part 1 in cash (rounded to 5¢ on its own), part 2 on the card machine, part 3 on a
          // guest's phone (TEST Provider stand-in; everything else is the real composition).
          const cash = await settleWith(server, {
            partNumber: 1,
            tip: { kind: "None" },
            tenderedMinor: "100000",
          });
          assert.equal(cash.status, "Recorded");
          const cardPaid = await settleWith(server, {
            partNumber: 2,
            method: "CardMachine",
            tip: { kind: "None" },
            tenderedMinor: null,
            slipReference: "TEST 0002",
          });
          assert.equal(cardPaid.status, "Recorded");
          const intents = new Map();
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
          const phone = createDiningTableOnlinePayments({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            provider: {
              async createIntent(request) {
                const intent = intents.get(request.idempotencyKey) ?? {
                  reference: "pi_TESTTAXR" + String(intents.size + 1).padStart(4, "0"),
                  transaction: "ch_TESTTAXR" + String(intents.size + 1).padStart(4, "0"),
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
                return answer(request, intents.get(String(request.providerIntentReference)));
              },
            },
            transactions: transactions(),
            now,
            nextReference: fresh,
          });
          const guest = {
            diningSessionReference: sessionReference,
            guestSessionReference: guestSession,
            allowed: async () => true,
          };
          const paying = await phone.start(guest, {
            operationReference: fresh(),
            tip: { kind: "None" },
            partNumber: 3,
          });
          assert.equal(paying.attempt.totalMinor, paying.bill.split.parts[2].amountMinor);
          for (const intent of intents.values()) intent.status = "Captured";
          const card = { bill: (await phone.refresh(guest)).bill };
          const paidParts = card.bill.split.parts;
          assert.deepEqual(
            paidParts.map((part) => part.payment?.method),
            ["Cash", "CardMachine", "Online"],
          );
          assert.ok(paidParts.every((part) => part.payment !== null));
          // What was paid for the rounds is exactly the bill (cash rounding apart).
          const lines = await rows(
            "SELECT coalesce(sum(r.round_minor),0)::text AS rounds FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id WHERE s.order_id=$1",
            [orderReference],
          );
          assert.equal(lines[0].rounds, owed.toString());
          // Frozen once paid: the bill keeps the recorded rounding; nothing new is recorded.
          assert.equal(card.bill.taxRoundingMinor, "1");
          assert.deepEqual(await recorded(), versions);
          await assert.rejects(discount(dish1), { code: "ITEM_COMP_ALREADY_PAID" });
          // Ordering's priced total includes the rounding, so the Order is settled.
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
            assert.equal(priced.pricedTotalMinor, owed);
            assert.equal(priced.taxRoundingMinor, 1n);
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
          // Reports read each round's share under tax (the sales source, as the pilot API role):
          // the latest recorded version's lines, adding up to the bill's rounding.
          const reported = await transactions().run((tx) =>
            listOrdersTaxRoundingLines(tx, scope, [orderReference]),
          );
          assert.equal(
            reported.reduce((sum, line) => sum + line.amountMinor, 0n),
            1n,
          );
          assert.ok(reported.every((line) => line.taxComponentCode.length > 0));
          // Append-only: the records can't be changed or removed.
          for (const sql of [
            "UPDATE rms_ordering.order_tax_rounding_adjustment SET total_minor=0",
            "DELETE FROM rms_ordering.order_tax_rounding_adjustment_line",
          ])
            await assert.rejects(admin.query(sql), /append-only tax rounding/u);
          // The lines must add up to the record (checked at commit).
          await assert.rejects(
            (async () => {
              await admin.query("BEGIN");
              try {
                await admin.query(
                  "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
                  [scope.brandReference, scope.storeReference],
                );
                await admin.query(
                  "INSERT INTO rms_ordering.order_tax_rounding_adjustment (adjustment_id,brand_id,store_id,bill_order_id,version,supersedes_adjustment_id,rule_code,rule_version,basis_digest,total_minor,currency_code,recorded_at) SELECT $1,brand_id,store_id,bill_order_id,version+1,adjustment_id,rule_code,rule_version,basis_digest,5,'CAD',date_trunc('milliseconds',now()) FROM rms_ordering.order_tax_rounding_adjustment WHERE bill_order_id=$2 ORDER BY version DESC LIMIT 1",
                  [fresh(), orderReference],
                );
                await admin.query("COMMIT");
              } catch (error) {
                await admin.query("ROLLBACK");
                throw error;
              }
            })(),
            /do not add up to the total/u,
          );
        }

        async function compedWholeEnding() {
          const recordPartySize = await partySizeWhileOpen();
          await notPreparedRound1();
          const servedOnOrdering = await cookAndServeRound1(undefined, { notPrepared: true });
          // The dish no one cooked or served counts as served (round 2's was taken off the bill).
          assert.deepEqual(
            servedOnOrdering.items.map((item) => [item.batchSequence, item.phase]),
            [
              [1, "Fulfilled"],
              [2, "Cancelled"],
            ],
          );
          // Closing summary: round 2's dish, taken off the bill before payment, is listed (never sold).
          assert.deepEqual((await tonightFacts()).cancelled.removedBeforePayment, {
            dishCount: items2.reduce((sum, item) => sum + item.quantity, 0),
            amountMinor: items2
              .reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n)
              .toString(),
          });
          const comped = await comp(manager, {
            orderItemReferences: items1.map((item) => String(item.orderItemReference)),
          });
          assert.equal(comped.status, "Recorded");
          const owedNow = await bill();
          assert.equal(owedNow.consistent, true);
          assert.equal(owedNow.owed.totalMinor, "0");
          // Nothing to pay: a payment is refused, and nothing stops the table from closing.
          await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_NOTHING_OWED" });
          const closePlan = await createMerchantDiningTableClosePlan({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            resolveRefundConfiguration: async () => ({
              providerAccountReference: provider,
              environment: "Test",
            }),
          })({
            ...as(server),
            query: { orderReference, diningSessionReference: sessionReference },
          });
          assert.deepEqual(closePlan.closeBlockers, []);
          // A server closes it as the Tables page does: the Order, then the table.
          const progress = await createMerchantDiningOrderProgress({
            persistence: persistenceOf(server),
            locale: "en-CA",
            authentication: server.authentication,
          })({ ...as(server), query: { orderReference } });
          const closed = await createMerchantDiningOrderCloseCommand({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            resolveConfiguration: createDiningOrderCloseConfiguration({
              ...ownerScope,
              providerAccountReference: provider,
              environment: "Test",
            }),
            newReference: fresh,
            audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
          })({
            ...as(server),
            command: {
              orderReference,
              operationReference: fresh(),
              expectedOrderVersion: progress.currentOrderVersion,
              expectedClosureVersion: progress.closureVersion,
              reasonCode: "ORDER_COMPLETED",
            },
          });
          assert.equal(closed.status, "Committed");
          assert.equal((await closing(server, "Finalize")).phase, "Closed");
          // A closed table takes no new party size: the command says so and the database refuses.
          await assert.rejects(recordPartySize(fresh(), 2, 6), {
            code: "DINING_PARTY_SIZE_TABLE_CLOSED",
          });
          await assert.rejects(
            transactions({ guc: true }).run((tx) =>
              tx.query(
                "INSERT INTO rms_dining.dining_session_party_size (tenant_id,brand_id,store_id,session_id,version,operation_id,party_size,actor_id,recorded_at) VALUES ($1,$2,$3,$4,3,$5,6,$6,date_trunc('milliseconds',now()))",
                [
                  tenant,
                  ownerScope.brandReference,
                  ownerScope.storeReference,
                  sessionReference,
                  fresh(),
                  id(0x700),
                ],
              ),
            ),
            /party size only for an open table/u,
          );
          const [table] = await rows(
            "SELECT t.table_snapshot->>'blockReasonCode' AS reason FROM rms_dining.dining_table t JOIN rms_dining.dining_session s ON s.table_id=t.table_id WHERE s.session_id=$1",
            [sessionReference],
          );
          assert.deepEqual(table, { reason: "CLEANING" });
          // Closed: no longer an open table in the closing summary.
          assert.deepEqual((await tonightFacts()).openTables, []);
          // The comped dishes are still sold in the day's report, all of it comped, nothing taken.
          const report = await salesReport();
          const subtotal = items1.reduce(
            (sum, item) => sum + item.pricing.subtotal.amountMinor,
            0n,
          );
          assert.equal(report.summary.grossSalesMinor, subtotal.toString());
          assert.equal(report.summary.compsMinor, subtotal.toString());
          assert.equal(report.summary.netSalesMinor, "0");
          assert.equal(report.summary.collectedMinor, "0");
          // Round 2's dish, taken off the bill before the table paid, was never sold or charged:
          // it is not a line of the sale.
          const [sale] = await transactions().run((tx) =>
            createPostgresStoreSalesOrderSource({
              ...scope,
              locale: "en-CA",
              authorize: async () => true,
            })(tx, [orderReference]),
          );
          assert.deepEqual(
            sale.batches.find((batch) => batch.orderBatchReference === R2.batch.orderBatchReference)
              ?.items ?? [],
            [],
          );
        }
        /**
         * WP-2423 item 8 ⑦ (decision 11): the owner turns tips off before the table pays. Staff
         * can't record the payment with a tip, a guest can't start paying on their phone with
         * one, and the database refuses a tip selection (a guest's checkout, a counter order, a
         * staff round) whatever writes it. Nothing is recorded or charged by the refusals.
         */
        async function tipsOffRefusals() {
          const whileOn = now();
          await new Promise((resolve) => setTimeout(resolve, 5));
          const off = await transactions().run((tx) =>
            changeStoreTipSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: 0,
              tipsEnabled: false,
              tierPercents: [10, 15, 18],
              actorReference: id(0x701),
              observedAt: now(),
            }),
          );
          assert.deepEqual([off.version, off.tipsEnabled], [1, false]);
          // The bill staff and guests read says tips are off.
          assert.deepEqual((await bill()).tips, { enabled: false, tierPercents: [10, 15, 18] });
          // The choices in force earlier (a payment taken during an outage is judged by them).
          assert.deepEqual(
            await transactions().run((tx) => readStoreTipChoices(tx, ownerScope, whileOn)),
            { enabled: true, tierPercents: [10, 15, 18] },
          );
          // Staff at checkout: a percentage or a typed tip is refused.
          for (const tip of [
            { kind: "Percent", percent: 15 },
            { kind: "Amount", amountMinor: "250" },
          ])
            await assert.rejects(settleWith(server, { tip }), { code: "TABLE_CHECKOUT_TIPS_OFF" });
          // A guest on their phone: refused before the Provider is asked for anything.
          const untouched = () => {
            throw new Error("the Provider is not called for a refused tip");
          };
          const phone = createDiningTableOnlinePayments({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            provider: {
              createIntent: untouched,
              retrieveIntent: untouched,
              cancelIntent: untouched,
            },
            transactions: transactions(),
            now,
            nextReference: fresh,
          });
          for (const tip of [
            { kind: "Percent", percent: 15 },
            { kind: "Amount", amountMinor: "250" },
          ])
            await assert.rejects(
              phone.start(
                {
                  diningSessionReference: sessionReference,
                  guestSessionReference: guestSession,
                  allowed: async () => true,
                },
                { operationReference: fresh(), tip },
              ),
              { code: "TABLE_ONLINE_PAYMENT_TIPS_OFF" },
            );
          // A tip selection (guest checkout, counter order, staff round): Payment's store refuses
          // it, and the database refuses it even when written directly under the api role.
          const selection = (n, amountMinor) =>
            parsePaymentTipSelection({
              selectionReference: id(0x7a0 + n),
              paymentOperationReference: id(0x7b0 + n),
              submissionReference: id(0x7c0 + n),
              cartReference: id(0x7d0 + n),
              cartVersion: 1,
              quoteReference: id(0x7e0 + n),
              guestSessionReference: guestSession,
              brandReference: ownerScope.brandReference,
              storeReference: ownerScope.storeReference,
              tip: { amountMinor, currencyCode: "CAD" },
              selectedAt: new Date(Date.now() - 1000).toISOString(),
            });
          const tipStore = createPostgresPaymentTipSelectionStore(
            transactions(),
            {
              brandReference: ownerScope.brandReference,
              storeReference: ownerScope.storeReference,
            },
            { now },
          );
          const tipAudit = (record) => ({
            auditId: fresh(),
            brandId: ownerScope.brandReference,
            storeId: ownerScope.storeReference,
            actor: { type: "System" },
            actionCode: "PAYMENT_TIP_SELECT",
            targetType: "PaymentTipSelection",
            targetId: record.selectionReference,
            reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
            correlationId: fresh(),
            occurredAt: record.selectedAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          });
          const tipped = selection(1, 125n);
          await assert.rejects(tipStore.append({ record: tipped, audit: tipAudit(tipped) }), {
            code: "PAYMENT_TIP_TURNED_OFF",
          });
          await assert.rejects(
            transactions({ guc: true }).run((tx) =>
              tx.query(
                "INSERT INTO rms_payment.payment_tip_selection (selection_id,brand_id,store_id,payment_operation_id,submission_id,cart_id,cart_version,quote_id,guest_session_id,tip_minor,currency_code,selected_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,125,'CAD',$9)",
                [
                  tipped.selectionReference,
                  ownerScope.brandReference,
                  ownerScope.storeReference,
                  tipped.paymentOperationReference,
                  tipped.submissionReference,
                  tipped.cartReference,
                  tipped.quoteReference,
                  guestSession,
                  tipped.selectedAt,
                ],
              ),
            ),
            /tips are turned off at this store/u,
          );
          // No tip is still taken as usual.
          const none = selection(2, 0n);
          assert.equal(
            (await tipStore.append({ record: none, audit: tipAudit(none) })).status,
            "Created",
          );
          // Nothing was recorded by the refusals: no table payment, no phone payment, no tip.
          assert.deepEqual(
            (
              await rows(
                "SELECT (SELECT count(*) FROM rms_payment.dining_table_settlement WHERE order_id=$1)::int AS settled,(SELECT count(*) FROM rms_payment.dining_table_online_payment WHERE order_id=$1)::int AS online,(SELECT count(*) FROM rms_payment.payment_tip_selection WHERE tip_minor>0 AND selection_id IN ($2,$3))::int AS tipped",
                [orderReference, tipped.selectionReference, none.selectionReference],
              )
            )[0],
            { settled: 0, online: 0, tipped: 0 },
          );
        }

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
          // WP-2423 item 8 ⑦: this time the guest types the tip ("Other amount"). One larger
          // than the bill before tax is refused before the Provider is asked for anything.
          await assert.rejects(
            payments.start(me, {
              operationReference: fresh(),
              tip: { kind: "Amount", amountMinor: (subtotalMinor + 1n).toString() },
            }),
            { code: "TABLE_ONLINE_PAYMENT_INPUT_INVALID" },
          );
          assert.equal(created, 1);
          await payments.start(me, {
            operationReference: fresh(),
            tip: { kind: "Amount", amountMinor: "250" },
          });
          assert.equal(created, 2);
          assert.deepEqual((await attempts()).at(-1), {
            total: (round1Minor + 250n).toString(),
            tip: "250",
            status: null,
          });

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
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "Comped") {
          await compedEnding();
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "TaxRounding") {
          await taxRoundingEnding();
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "CompedWhole") {
          await compedWholeEnding();
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "PaidOnline") {
          await paidOnlineEnding();
          await assertSalesCountEveryRoundOnce();
          return;
        }

        // Cash short of the rounded total is refused; nothing recorded.
        await assert.rejects(settleWith(server, { tenderedMinor: "100" }), {
          code: "TABLE_CHECKOUT_TENDER_SHORT",
        });
        // Cash: 15 % tip on the bill before tax (none with tips off), rounded to 5 cents, change
        // given.
        const subtotalMinor = BigInt(open.owed.subtotalMinor);
        const tipMinor = ending === "TipsOff" ? 0n : (subtotalMinor * 15n + 50n) / 100n;
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
        // v15 2026-10-28 (b): the close check of a table that pays at the end, its dishes not served
        // yet, says what staff do — never fails (it used to look for a per-round payment).
        const closePlan = () =>
          createMerchantDiningTableClosePlan({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            resolveRefundConfiguration: async () => ({
              providerAccountReference: provider,
              environment: "Test",
            }),
          })({
            ...as(server),
            query: { orderReference, diningSessionReference: sessionReference },
          });
        assert.deepEqual(
          (await closePlan()).rounds.map((round) => [round.sequence, round.state, round.refund]),
          [[1, "OnTableBill", null]],
        );
        if (ending === "PaidSplit" || ending === "SplitWrittenOff") {
          const splitWith = (command) =>
            createMerchantDiningTableSplit({
              persistence: persistenceOf(server),
              authentication: server.authentication,
              nextReference: fresh,
            })({
              ...as(server),
              command: {
                operationReference: fresh(),
                diningSessionReference: sessionReference,
                mode: "Even",
                people: 3,
                rounds: null,
                ...command,
              },
            });
          const billMinor = round1Minor + round2Minor;
          const split = await splitWith({});
          assert.equal(split.status, "Recorded");
          const parts = split.bill.split.parts;
          const base = billMinor / 3n,
            extra = billMinor % 3n;
          assert.deepEqual(
            parts.map((part) => part.amountMinor),
            [0n, 1n, 2n].map((index) => (index < extra ? base + 1n : base).toString()),
          );
          assert.equal(split.bill.split.mode, "Even");
          assert.equal(split.bill.owed.totalMinor, billMinor.toString());
          // The bill is split: one payment for the whole table, or for no part, is refused.
          await assert.rejects(settleWith(server, {}), { code: "TABLE_CHECKOUT_INPUT_INVALID" });
          await assert.rejects(settleWith(server, { partNumber: 4 }), {
            code: "TABLE_CHECKOUT_INPUT_INVALID",
          });
          const ledgerNow = () =>
            transactions().run((tx) =>
              createPostgresStoreSalesPaymentLedger({
                scope: { ...ownerScope, providerAccountReference: provider, environment: "Test" },
                authorize: async () => true,
              })(tx, {
                startsAt: time(-minutes(120)),
                endsAt: new Date(Date.now() + 1000).toISOString(),
                observedAt: new Date(Date.now() + 1000).toISOString(),
              }),
            );
          if (ending === "SplitWrittenOff") {
            // Part 1 in cash, no tip; a manager gives $5.00 of it back (from that part's cash).
            const cashPart = await settleWith(server, {
              partNumber: 1,
              tip: { kind: "None" },
              tenderedMinor: "100000",
            });
            const part1Total = BigInt(cashPart.bill.split.parts[0].payment.totalMinor);
            const refund = await createMerchantDiningTableCashRefund({
              persistence: persistenceOf(manager),
              authentication: manager.authentication,
              nextReference: fresh,
            })({
              ...as(manager),
              command: {
                orderReference,
                operationReference: fresh(),
                amountMinor: "500",
                reasonCode: "FOOD_ISSUE",
                partNumber: 1,
              },
            });
            assert.equal(refund.status, "Recorded");
            // The guests leave: what is written off is exactly the parts not paid.
            const served = await cookAndServeRound1();
            const left = await departure(manager, served.currentOrderVersion);
            assert.ok(left);
            const [writeOff] = await rows(
              "SELECT written_off_minor::text AS amount FROM rms_payment.order_unpaid_write_off WHERE order_id=$1",
              [orderReference],
            );
            const unpaid = BigInt(parts[1].amountMinor) + BigInt(parts[2].amountMinor);
            assert.equal(writeOff.amount, unpaid.toString());
            await assert.rejects(
              settleWith(server, { partNumber: 2, tip: { kind: "None" }, tenderedMinor: "100000" }),
              { code: "TABLE_CHECKOUT_ALREADY_PAID" },
            );
            const day = await ledgerNow();
            assert.deepEqual(
              day.unpaidWriteOffs.map((entry) => [entry.orderReference, entry.amountMinor]),
              [[orderReference, unpaid]],
            );
            assert.deepEqual(
              [day.settlement.cashTaken.count, day.settlement.cashTaken.amountMinor],
              [1, part1Total],
            );
            assert.deepEqual(day.settlement.cashRefunded, { count: 1, amountMinor: 500n });
            await assertSalesCountEveryRoundOnce();
            return;
          }
          // Part 1 on the card machine with a 15 % tip on its own share before tax.
          const card = await settleWith(server, {
            partNumber: 1,
            method: "CardMachine",
            tenderedMinor: null,
            slipReference: "TEST 0001",
          });
          const part1 = card.bill.split.parts[0];
          const tip1 = (BigInt(part1.subtotalMinor) * 15n + 50n) / 100n;
          assert.deepEqual(part1.payment, {
            method: "CardMachine",
            tipMinor: tip1.toString(),
            roundingMinor: "0",
            totalMinor: (BigInt(part1.amountMinor) + tip1).toString(),
            tenderedMinor: null,
            changeMinor: null,
            recordedAt: part1.payment.recordedAt,
            recordedAfterOutage: false,
          });
          assert.equal(card.bill.split.paidParts, 1);
          // Locked once a part is paid; a part is paid once.
          await assert.rejects(splitWith({ people: 2 }), { code: "TABLE_CHECKOUT_SPLIT_LOCKED" });
          // v15 2026-10-28: once a part is paid, checkout can't be cancelled (back to ordering).
          await assert.rejects(closing(server, "Cancel"), { code: "DINING_CHECKOUT_ALREADY_PAID" });
          await assert.rejects(
            settleWith(server, { partNumber: 1, method: "CardMachine", tenderedMinor: null }),
            { code: "TABLE_CHECKOUT_ALREADY_PAID" },
          );
          // Part 2 in cash, no tip, rounded to 5 cents on its own amount.
          for (const partNumber of [2]) {
            const cash = await settleWith(server, {
              partNumber,
              tip: { kind: "None" },
              tenderedMinor: "100000",
            });
            const part = cash.bill.split.parts[partNumber - 1];
            const amount = BigInt(part.amountMinor);
            const digit = amount % 10n;
            const rounding =
              digit === 0n || digit === 5n
                ? 0n
                : digit <= 2n
                  ? -digit
                  : digit <= 7n
                    ? 5n - digit
                    : 10n - digit;
            assert.deepEqual(
              [part.payment.method, part.payment.roundingMinor, part.payment.totalMinor],
              ["Cash", rounding.toString(), (amount + rounding).toString()],
            );
            assert.equal(part.payment.changeMinor, (100000n - amount - rounding).toString());
          }
          // Part 3 on a guest's phone (TEST Provider): while it is open staff can't take that part
          // and another guest can't start it; the capture pays exactly part 3.
          const intents = new Map();
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
          const phone = createDiningTableOnlinePayments({
            scope: ownerScope,
            providerAccountReference: provider,
            environment: "Test",
            provider: {
              async createIntent(request) {
                const intent = intents.get(request.idempotencyKey) ?? {
                  reference: "pi_TESTSPLIT" + String(intents.size + 1).padStart(4, "0"),
                  transaction: "ch_TESTSPLIT" + String(intents.size + 1).padStart(4, "0"),
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
            },
            transactions: transactions(),
            now,
            nextReference: fresh,
          });
          const guestAt = (guestSessionReference) => ({
            diningSessionReference: sessionReference,
            guestSessionReference,
            allowed: async () => true,
          });
          const paying = await phone.start(guestAt(guestSession), {
            operationReference: fresh(),
            tip: { kind: "None" },
            partNumber: 3,
          });
          const part3 = paying.bill.split.parts[2];
          assert.deepEqual(
            [paying.attempt.partNumber, paying.attempt.totalMinor, part3.guestPaying],
            [3, part3.amountMinor, true],
          );
          await assert.rejects(
            settleWith(server, { partNumber: 3, tip: { kind: "None" }, tenderedMinor: "100000" }),
            { code: "TABLE_CHECKOUT_GUEST_PAYING" },
          );
          await assert.rejects(
            phone.start(guestAt(tableGuest), {
              operationReference: fresh(),
              tip: { kind: "None" },
              partNumber: 3,
            }),
            { code: "TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING" },
          );
          for (const intent of intents.values()) intent.status = "Captured";
          const captured = await phone.refresh(guestAt(guestSession));
          assert.deepEqual(
            [
              captured.bill.split.parts[2].payment.method,
              captured.bill.split.parts[2].payment.totalMinor,
            ],
            ["Online", part3.amountMinor],
          );
          const done = await bill();
          assert.deepEqual([done.split.paidParts, done.split.remainingMinor], [3, "0"]);
          // The day's ledger: three payments, one per part, each in its own channel; their round
          // allocations add up to the bill.
          const day = await ledgerNow();
          assert.deepEqual(
            [
              day.settlement.cardMachineTaken.count,
              day.settlement.cashTaken.count,
              day.settlement.onlineCaptured.count,
            ],
            [1, 1, 1],
          );
          assert.equal(
            day.payments
              .filter((payment) => payment.orderReference === orderReference)
              .reduce((sum, payment) => sum + payment.orderAllocationMinor, 0n),
            billMinor,
          );
          assert.equal(done.owed.totalMinor, "0");
          assert.ok(done.rounds.every((round) => round.paid || round.totalMinor === "0"));
          assert.ok(done.consistent);
          // In the database: three payments under one plan; each round's lines add up to it.
          const lines = await rows(
            `SELECT r.order_batch_id::text AS batch,sum(r.round_minor)::text AS paid,count(DISTINCT s.part_number) AS parts
 FROM rms_payment.dining_table_settlement_round r JOIN rms_payment.dining_table_settlement s ON s.settlement_id=r.settlement_id
 WHERE s.order_id=$1 GROUP BY r.order_batch_id ORDER BY 1`,
            [orderReference],
          );
          assert.deepEqual(
            lines.map((line) => line.paid).sort(),
            [round1Minor, round2Minor]
              .filter((minor) => minor > 0n)
              .map(String)
              .sort(),
          );
          assert.equal(
            (
              await rows(
                "SELECT count(*)::int AS n FROM rms_payment.dining_table_settlement WHERE order_id=$1 AND split_plan_id IS NOT NULL",
                [orderReference],
              )
            )[0].n,
            3,
          );
          // Coordinator 2026-10-30: the split table, every part paid, closes; a phone of the table
          // reloads and reads the whole bill and how each part was paid.
          await cookAndServeRound1();
          const progress = await createMerchantDiningOrderProgress({
            persistence: persistenceOf(server),
            locale: "en-CA",
            authentication: server.authentication,
          })({ ...as(server), query: { orderReference } });
          const closedOrder = await createMerchantDiningOrderCloseCommand({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            resolveConfiguration: createDiningOrderCloseConfiguration({
              ...ownerScope,
              providerAccountReference: provider,
              environment: "Test",
            }),
            newReference: fresh,
            audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
          })({
            ...as(server),
            command: {
              orderReference,
              operationReference: fresh(),
              expectedOrderVersion: progress.currentOrderVersion,
              expectedClosureVersion: progress.closureVersion,
              reasonCode: "ORDER_COMPLETED",
            },
          });
          assert.equal(closedOrder.status, "Committed");
          assert.equal((await closing(server, "Finalize")).phase, "Closed");
          const receipt = await settledReceiptFor({
            scope,
            ownerScope,
            transactions: transactions(),
            phone: tablePhone,
            provider,
          });
          assert.equal(receipt.split, true);
          assert.deepEqual(
            receipt.payments.map((payment) => [payment.partNumber, payment.method]),
            [
              [1, "CardMachine"],
              [2, "Cash"],
              [3, "Online"],
            ],
          );
          const paidParts = done.split.parts;
          assert.deepEqual(
            receipt.payments.map((payment) => payment.totalMinor),
            paidParts.map((part) => part.payment.totalMinor),
          );
          assert.equal(
            receipt.paidMinor,
            paidParts.reduce((sum, part) => sum + BigInt(part.payment.totalMinor), 0n).toString(),
          );
          assert.equal(
            receipt.tipMinor,
            paidParts.reduce((sum, part) => sum + BigInt(part.payment.tipMinor), 0n).toString(),
          );
          assert.equal(
            BigInt(receipt.ordersTotalMinor),
            BigInt(receipt.subtotalMinor) + BigInt(receipt.taxMinor),
          );
          await assertSalesCountEveryRoundOnce();
          return;
        }
        if (ending === "TipsOff") await tipsOffRefusals();
        const operation = fresh();
        const paid = await settleWith(server, { operationReference: operation });
        assert.equal(paid.status, "Recorded");
        // Paid in full while round 1's dishes are still to come: serve them, then close.
        const afterPaying = await closePlan();
        assert.deepEqual(
          afterPaying.rounds.map((round) => [
            round.sequence,
            round.state,
            round.openItemCount,
            round.refund,
          ]),
          [[1, "PaidWithTable", items1.reduce((sum, item) => sum + item.quantity, 0), null]],
        );
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

        await assertSalesCountEveryRoundOnce();
        if (ending === "Moved") {
          // v15 2026-10-30: the moved table, paid, closes as the Tables page does it — the Order,
          // then the table (its session at the table it moved to).
          await cookAndServeRound1();
          const progress = await createMerchantDiningOrderProgress({
            persistence: persistenceOf(server),
            locale: "en-CA",
            authentication: server.authentication,
          })({ ...as(server), query: { orderReference } });
          const closed = await createMerchantDiningOrderCloseCommand({
            persistence: persistenceOf(server),
            authentication: server.authentication,
            resolveConfiguration: createDiningOrderCloseConfiguration({
              ...ownerScope,
              providerAccountReference: provider,
              environment: "Test",
            }),
            newReference: fresh,
            audit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
          })({
            ...as(server),
            command: {
              orderReference,
              operationReference: fresh(),
              expectedOrderVersion: progress.currentOrderVersion,
              expectedClosureVersion: progress.closureVersion,
              reasonCode: "ORDER_COMPLETED",
            },
          });
          assert.equal(closed.status, "Committed");
          const receiptOf = () =>
            settledReceiptFor({
              scope,
              ownerScope,
              transactions: transactions(),
              phone: tablePhone,
              provider,
            });
          // Not before the table closes: the guest is still at an open table.
          assert.equal(await receiptOf(), null);
          assert.equal((await closing(server, "Finalize")).phase, "Closed");
          // Coordinator 2026-10-30: a phone of the table, reloading after it was paid in cash and
          // closed, reads the table's receipt (whoever placed the rounds): every round, before tax,
          // tax, the cash rounding, the total and that it was cash.
          const receipt = await receiptOf();
          const settlement = paid.bill.settlement;
          assert.equal(receipt.settledTableLabel, receipt.tableLabel);
          assert.deepEqual(receipt.payments, [
            {
              partNumber: null,
              method: "Cash",
              tipMinor: settlement.tipMinor,
              roundingMinor: settlement.roundingMinor,
              totalMinor: settlement.totalMinor,
              paidAt: settlement.recordedAt,
            },
          ]);
          assert.equal(receipt.split, false);
          assert.equal(receipt.paidMinor, settlement.totalMinor);
          assert.equal(receipt.roundingMinor, settlement.roundingMinor);
          assert.equal(receipt.tipMinor, settlement.tipMinor);
          assert.equal(
            BigInt(receipt.ordersTotalMinor),
            BigInt(receipt.subtotalMinor) + BigInt(receipt.taxMinor),
          );
          assert.equal(receipt.ordersTotalMinor, settlement.roundsMinor);
          assert.ok(receipt.rounds.length >= 1);
          assert.ok(receipt.rounds.every((round) => round.items.length > 0));
        }
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
