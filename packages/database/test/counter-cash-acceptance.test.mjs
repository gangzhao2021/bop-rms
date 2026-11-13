import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { parseOrderPaymentPreparationEvidence } from "../../rms/ordering/src/index.ts";
import {
  cardMachinePaymentTakenMinor,
  cardMachineRefundGivenBackMinor,
  createPostgresCardMachinePaymentStore,
  createPostgresOrderFinancialPosition,
  createPostgresRefundRecoveryStore,
  readRefundRecoveryAllowance,
  parseCardMachinePaymentRecord,
  parseCardMachineRefundRecord,
  planCounterCashTender,
} from "../../rms/payment/src/index.ts";
import { preparation } from "../../rms/payment/src/tests/payment-intent-creation.fixture.ts";
import { createPostgresOrdinaryRefundCaptureSource } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-capture-source.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a7e560-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (n) => "sha256:" + n.toString(16).padStart(64, "0");
const brand = id(1),
  store = id(2),
  tenant = id(3),
  otherStore = id(4),
  actor = id(5);

/**
 * WP-2423 M52 (DEC-COUNTER-CASH): a counter order paid in cash is the counter's one payment record
 * with its cash rounding to 5 cents, the cash handed over and the change; cash given back from it
 * goes back in whole nickels and never more than the drawer took (M131). Everything below runs as a
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants; only the order facts
 * (a synthetic payment preparation, as Ordering hands it to Payment) are test-controlled.
 */
it("WP-2423 M52: the counter takes cash by the table's rules; replay, concurrency and nickel refunds hold", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_counter_cash" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cc_" + context.runId,
      worker = "wp2423_cc_w_" + context.runId;
    const clients = [];
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

      const connect = async () => {
        const client = new Client(context.clientConfig);
        await client.connect();
        clients.push(client);
        return client;
      };
      /** One unit of work as the pilot API role. */
      const asApi = async (work, client = null) => {
        const own = client ?? (await connect());
        await own.query("BEGIN");
        try {
          await own.query("SET LOCAL ROLE " + api);
          await own.query("SET LOCAL statement_timeout = '20s'");
          const result = await work(own);
          await own.query("COMMIT");
          return result;
        } catch (error) {
          await own.query("ROLLBACK");
          throw error;
        }
      };
      const cards = (storeReference = store) =>
        createPostgresCardMachinePaymentStore({
          scope: { tenantReference: tenant, brandReference: brand, storeReference },
          authorize: async () => true,
        });

      // An order of $20.43 with tax and a $2.00 tip: $22.43, $22.45 in cash.
      let n = 100;
      const order = (allocationMinor, tipMinor) => {
        const orderReference = id(++n),
          batch = id(++n),
          submission = id(++n);
        return {
          orderReference,
          batch,
          submission,
          preparation: parseOrderPaymentPreparationEvidence(
            preparation({
              preparationReference: id(++n),
              orderReference,
              orderBatchReference: batch,
              submissionReference: submission,
              brandReference: brand,
              storeReference: store,
              orderAllocation: { amountMinor: allocationMinor, currencyCode: "CAD" },
              tip: { amountMinor: tipMinor, currencyCode: "CAD" },
              total: { amountMinor: allocationMinor + tipMinor, currencyCode: "CAD" },
            }),
          ),
        };
      };
      const now = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/u, ".000Z");
      const paymentOf = (paid, operationReference, extra) =>
        parseCardMachinePaymentRecord({
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          cardMachinePaymentReference: id(++n),
          paymentIntentReference: id(++n),
          paymentAttemptReference: id(++n),
          paymentOperationReference: id(++n),
          operationReference,
          intentDigest: digest(operationReference.length + n),
          orderReference: paid.orderReference,
          orderBatchReference: paid.batch,
          submissionReference: paid.submission,
          preparation: paid.preparation,
          environment: "Test",
          slipReference: null,
          recordingReason: "AtCounter",
          takenAt: now,
          recordedAt: now,
          actorReference: actor,
          eventReference: id(++n),
          auditReference: id(++n),
          ...extra,
        });

      // 1. Cash at the counter: the table's rounding, what was handed over, the change.
      const first = order(2043n, 200n);
      const cash = planCounterCashTender(first.preparation, 5000n);
      assert.deepEqual(cash, { roundingMinor: 2n, tenderedMinor: 5000n, changeMinor: 2755n });
      const operation = id(++n);
      const record = paymentOf(first, operation, { cash });
      const saved = await asApi((tx) => cards().record(tx, record));
      assert.equal(saved.status, "Created");
      assert.deepEqual(saved.record.cash, cash);
      assert.equal(cardMachinePaymentTakenMinor(saved.record), 2245n);
      // v15 batch 8: the payment page and the cancel dialog read the payment back, as the pilot API
      // role, by its intent and by its round, and tell staff it was cash (given back from the
      // drawer), never a card-machine payment.
      const byIntent = await asApi((tx) => cards().loadByIntent(tx, record.paymentIntentReference));
      const byBatch = await asApi((tx) =>
        cards().loadByBatch(tx, first.orderReference, first.batch),
      );
      assert.deepEqual(byIntent?.cash, cash);
      assert.deepEqual(byBatch?.cash, cash);
      const row = (
        await admin.query(
          "SELECT tender,total_minor::text,rounding_minor::text,tendered_minor::text,change_minor::text,slip_reference,actor_id::text FROM rms_payment.card_machine_payment WHERE operation_id=$1",
          [operation],
        )
      ).rows[0];
      assert.deepEqual(row, {
        tender: "Cash",
        total_minor: "2243",
        rounding_minor: "2",
        tendered_minor: "5000",
        change_minor: "2755",
        slip_reference: null,
        actor_id: actor,
      });
      // Recorded and attributed: the same paid signal as the card machine, and its own audit.
      const audit = (
        await admin.query(
          "SELECT action_code,reason_code,actor_reference::text AS actor_id,after_summary_json FROM platform_audit.audit_record WHERE audit_id=$1",
          [record.auditReference],
        )
      ).rows[0];
      assert.equal(audit.action_code, "PAYMENT_COUNTER_CASH_RECORDED");
      assert.equal(audit.reason_code, "CASH_RECEIVED");
      assert.equal(audit.actor_id, actor);
      assert.equal(audit.after_summary_json.cashTakenMinor, "2245");
      const event = (
        await admin.query(
          "SELECT event_type,payload_json->>'amountMinor' AS amount FROM platform_eventing.outbox_event WHERE event_id=$1",
          [record.eventReference],
        )
      ).rows[0];
      assert.deepEqual(event, { event_type: "PaymentSucceeded", amount: "2243" });

      // 2. Replay: the same operation returns the same record; a different tender is a conflict.
      const replay = await asApi((tx) => cards().record(tx, record));
      assert.equal(replay.status, "AlreadyRecorded");
      await assert.rejects(
        asApi((tx) =>
          cards().record(tx, {
            ...record,
            cash: planCounterCashTender(first.preparation, 10000n),
          }),
        ),
        { code: "CARD_MACHINE_IDEMPOTENCY_CONFLICT" },
      );
      // A second payment of the same order, by anyone, is refused.
      await assert.rejects(
        asApi((tx) => cards().record(tx, paymentOf(first, id(++n), { cash }))),
        { code: "CARD_MACHINE_ALREADY_PAID" },
      );
      // The database holds the rounding, change and slip rules for every row.
      for (const [rounding, tendered, change, slip] of [
        [0, 5000, 2757, null],
        [2, 5000, 2750, null],
        [2, 2000, -245, null],
        [2, 5000, 2755, "AUTH 1"],
      ])
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_payment.card_machine_payment SELECT tenant_id,brand_id,store_id,$1,$2,$3,$4,$5,intent_digest,order_id,$6::text::platform_helpers.uuid_v7,submission_id,jsonb_set(preparation_json,'{orderBatchReference}',to_jsonb($6::text)),order_allocation_minor,tip_minor,total_minor,currency_code,payment_environment,$10,recording_reason,taken_at,recorded_at,actor_id,$11,$12,'Cash',$7,$8,$9 FROM rms_payment.card_machine_payment WHERE operation_id=$13",
            [
              id(++n),
              id(++n),
              id(++n),
              id(++n),
              id(++n),
              id(++n),
              rounding,
              tendered,
              change,
              slip,
              id(++n),
              id(++n),
              operation,
            ],
          ),
          /card_machine_payment_cash_tender/u,
        );
      await assert.rejects(
        admin.query("UPDATE rms_payment.card_machine_payment SET change_minor=0"),
        /append-only/u,
      );
      // Another Store's role scope sees nothing of it.
      assert.equal(await asApi((tx) => cards(otherStore).loadByOperation(tx, operation)), null);

      // 3. Two tills record the same order at once: one payment, the other is told it is paid.
      const raced = order(1000n, 0n);
      const [a, b] = [await connect(), await connect()];
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE " + api);
      const left = await cards().record(
        a,
        paymentOf(raced, id(++n), { cash: planCounterCashTender(raced.preparation, 1000n) }),
      );
      assert.equal(left.status, "Created");
      const right = asApi(
        (tx) =>
          cards().record(
            tx,
            paymentOf(raced, id(++n), { cash: planCounterCashTender(raced.preparation, 2000n) }),
          ),
        b,
      );
      let waited = false;
      for (let attempt = 0; attempt < 400 && !waited; attempt++) {
        const waiting = await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        waited = waiting.rows[0].n > 0;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waited, "the second till waits for the first");
      await a.query("COMMIT");
      await assert.rejects(right, { code: "CARD_MACHINE_ALREADY_PAID" });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_payment.card_machine_payment WHERE order_batch_id=$1",
            [raced.batch],
          )
        ).rows[0].n,
        1,
      );

      // 4. Refunds of the cash payment go back in whole nickels (M131).
      const refundOf = (amountMinor, extra = {}) =>
        parseCardMachineRefundRecord({
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          cardMachineRefundReference: id(++n),
          cardMachinePaymentReference: saved.record.cardMachinePaymentReference,
          orderReference: first.orderReference,
          operationReference: id(++n),
          intentDigest: digest(++n),
          sourceKind: "StaffCancellation",
          sourceReference: id(++n),
          amountMinor,
          slipReference: null,
          refundedAt: now,
          recordedAt: now,
          actorReference: actor,
          auditReference: id(++n),
          ...extra,
        });
      // An odd cent is refused by the store and by the database.
      await assert.rejects(
        asApi((tx) => cards().recordRefund(tx, refundOf(437n))),
        { code: "CARD_MACHINE_INPUT_INVALID" },
      );
      await assert.rejects(
        asApi((tx) =>
          tx
            .query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
              brand,
              store,
            ])
            .then(() =>
              tx.query(
                "INSERT INTO rms_payment.card_machine_refund (tenant_id,brand_id,store_id,card_machine_refund_id,card_machine_payment_id,order_id,operation_id,intent_digest,source_kind,source_id,amount_minor,currency_code,slip_reference,refunded_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'StaffCancellation',$9,437,'CAD',NULL,$10,$10,$11,$12)",
                [
                  tenant,
                  brand,
                  store,
                  id(++n),
                  saved.record.cardMachinePaymentReference,
                  first.orderReference,
                  id(++n),
                  digest(++n),
                  id(++n),
                  now,
                  actor,
                  id(++n),
                ],
              ),
            ),
        ),
        /whole nickels/u,
      );
      // $4.37 of dishes goes back as $4.35; the rest is what the drawer still holds — $18.10,
      // the rounding up included ($22.45 in all, more than the order's $22.43).
      assert.equal(cardMachineRefundGivenBackMinor(saved.record, 437n, 0n), 435n);
      const part = await asApi((tx) => cards().recordRefund(tx, refundOf(435n)));
      assert.equal(part.status, "Created");
      const rest = cardMachineRefundGivenBackMinor(saved.record, 2245n - 435n, 435n);
      assert.equal(rest, 1810n);
      const whole = await asApi((tx) => cards().recordRefund(tx, refundOf(rest)));
      assert.equal(whole.status, "Created");
      await assert.rejects(
        asApi((tx) => cards().recordRefund(tx, refundOf(5n))),
        { code: "CARD_MACHINE_REFUND_EXCEEDS_PAYMENT" },
      );
      assert.equal(cardMachineRefundGivenBackMinor(saved.record, 100n, 2245n), 0n);
      const refundAudit = (
        await admin.query(
          "SELECT reason_code FROM platform_audit.audit_record WHERE action_code='PAYMENT_CARD_MACHINE_REFUND_RECORDED' ORDER BY occurred_at LIMIT 1",
        )
      ).rows[0];
      assert.equal(refundAudit.reason_code, "CASH_GIVEN_BACK");

      // 5. The day: the card machine's takings apart from the counter's cash (rounding included).
      const carded = order(1999n, 0n);
      await asApi((tx) =>
        cards().record(tx, paymentOf(carded, id(++n), { slipReference: "AUTH 9" })),
      );
      const day = await asApi((tx) =>
        cards().summarize(tx, {
          from: new Date(Date.parse(now) - 3_600_000).toISOString(),
          to: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      assert.deepEqual(day, {
        paymentCount: 1,
        backEnteredCount: 0,
        takenMinor: 1999n,
        tipMinor: 0n,
        refundCount: 0,
        refundedMinor: 0n,
        cash: {
          paymentCount: 2,
          backEnteredCount: 0,
          takenMinor: 2245n + 1000n,
          tipMinor: 200n,
          roundingMinor: 2n,
          refundCount: 2,
          refundedMinor: 2245n,
        },
      });

      // 6. M52/M131 (review): the Order's refunded amounts read from the database as the pilot API
      // role. Cash goes back in whole nickels; the Order never counts the rounding, and once the
      // drawer gave back all the cash it took, the Order is refunded in full.
      const position = (orderReference) =>
        asApi((tx) =>
          createPostgresOrderFinancialPosition({
            scope: { tenantReference: tenant, brandReference: brand, storeReference: store },
            providerAccountReference: id(++n),
            environment: "Test",
            authorize: async () => true,
          })(tx, { orderReference, observedAt: new Date().toISOString() }),
        );
      // $22.43 taken as $22.45: $4.35 and $18.10 went back ($22.45): the Order got $22.43.
      const roundedUp = (await position(first.orderReference)).settlement;
      assert.equal(roundedUp.confirmedRefundMinor, 2243n);
      assert.deepEqual(roundedUp.refundAllocation, {
        orderMinor: 2043n,
        tipMinor: 200n,
        unallocatedMinor: 0n,
      });
      // $22.47 taken as $22.45, cancelled: the drawer gives back $22.45, the Order is refunded
      // $22.47 in full (it was read as $22.45, two cents never refunded).
      const down = order(2047n, 200n);
      const downPaid = await asApi((tx) =>
        cards().record(
          tx,
          paymentOf(down, id(++n), { cash: planCounterCashTender(down.preparation, 3000n) }),
        ),
      );
      const refundOn = (paid, amountMinor, extra = {}) =>
        refundOf(amountMinor, {
          cardMachinePaymentReference: paid.record.cardMachinePaymentReference,
          orderReference: paid.record.orderReference,
          ...extra,
        });
      const owed = cardMachineRefundGivenBackMinor(
        downPaid.record,
        cardMachinePaymentTakenMinor(downPaid.record),
        0n,
      );
      assert.equal(owed, 2245n);
      await asApi((tx) => cards().recordRefund(tx, refundOn(downPaid, owed)));
      const cancelled = (await position(down.orderReference)).settlement;
      assert.equal(cancelled.capturedMinor, 2247n);
      assert.equal(cancelled.confirmedRefundMinor, 2247n);
      assert.equal(cancelled.pendingRefundMinor, 0n);
      assert.deepEqual(cancelled.refundAllocation, {
        orderMinor: 2047n,
        tipMinor: 200n,
        unallocatedMinor: 0n,
      });

      // 7. M52/M131 (review): a new refund request on a cash payment, as the pilot API role: what is
      // left is the Order's, a request under 3 cents is refused, and once the drawer is empty nothing
      // more can be requested (refusals, never an outage).
      const dishes = order(2047n, 200n);
      const dishesPaid = await asApi((tx) =>
        cards().record(
          tx,
          paymentOf(dishes, id(++n), { cash: planCounterCashTender(dishes.preparation, 3000n) }),
        ),
      );
      const requestAt = new Date().toISOString();
      const request = (amountMinor) => ({
        tenantReference: tenant,
        brandReference: brand,
        storeReference: store,
        orderReference: dishes.orderReference,
        requestReference: id(++n),
        operationReference: id(++n),
        actorReference: actor,
        auditReference: id(++n),
        expectedClaimVersion: 0,
        policyVersion: "PILOT_ORDINARY_REFUND_V1",
        allocationVersion: "ORDINARY_REFUND_ALLOCATION_V1",
        reasonCode: "CUSTOMER_REQUEST",
        requestedAt: requestAt,
        currencyCode: "CAD",
        amountMinor,
        payments: [
          {
            paymentTransactionReference: dishesPaid.record.cardMachinePaymentReference,
            paymentIntentReference: dishesPaid.record.paymentIntentReference,
            paymentAttemptReference: dishesPaid.record.paymentAttemptReference,
            firstCaptureReference: dishesPaid.record.cardMachinePaymentReference,
            sourceReference: id(++n),
            sourceDigest: digest(++n),
            items: [
              {
                orderItemReference: id(++n),
                refundUnitOrdinals: [1],
                components: {
                  netAmountMinor: amountMinor,
                  taxAmountMinor: 0n,
                  tipAmountMinor: 0n,
                  serviceChargeAmountMinor: 0n,
                  serviceChargeTaxAmountMinor: 0n,
                },
              },
            ],
          },
        ],
      });
      const balance = (value, history = []) =>
        asApi((tx) =>
          createPostgresOrdinaryRefundCaptureSource({
            scope: {
              tenantReference: tenant,
              brandReference: brand,
              storeReference: store,
              providerAccountReference: id(++n),
              environment: "Test",
            },
            now: () => new Date().toISOString(),
            authorize: async () => true,
            validatePricing: async () => true,
            allowCardMachine: true,
          })(tx, { request: value, history }),
        );
      const dish = request(438n);
      assert.deepEqual(
        (await balance(dish)).map((entry) => [
          entry.capturedAmountMinor,
          entry.otherOccupiedAmountMinor,
        ]),
        [[2247n, 0n]],
      );
      // Under 3 cents can't be handed back in cash.
      await assert.rejects(balance(request(2n)), /ORDINARY_REFUND_CASH_UNDER_NICKEL/u);
      // The order is cancelled: the drawer gives back all $22.45 it took (the rounding included).
      await asApi((tx) =>
        cards().recordRefund(
          tx,
          refundOn(
            dishesPaid,
            cardMachineRefundGivenBackMinor(
              dishesPaid.record,
              cardMachinePaymentTakenMinor(dishesPaid.record),
              0n,
            ),
          ),
        ),
      );
      // v15 batch 8: Approvals and the payment page read the cash given back from the payment's
      // refunds as the pilot API role (what the drawer still holds), and nothing more goes back.
      const givenBack = await asApi((tx) =>
        cards().refunds(tx, dishesPaid.record.cardMachinePaymentReference),
      );
      assert.deepEqual(
        givenBack.map((refund) => refund.amountMinor),
        [2245n],
      );
      assert.equal(
        cardMachinePaymentTakenMinor(dishesPaid.record) -
          givenBack.reduce((sum, refund) => sum + refund.amountMinor, 0n),
        0n,
      );
      assert.equal(cardMachineRefundGivenBackMinor(dishesPaid.record, 438n, 2245n), 0n);
      // The drawer is empty: the 2 cents of the Order it never held can't be requested (all of it
      // is taken), and a request already made revalidates as it was.
      assert.equal((await balance(request(4n)))[0].otherOccupiedAmountMinor, 2247n);
      assert.equal((await balance(request(2n)))[0].otherOccupiedAmountMinor, 2247n);
      assert.equal((await balance(dish, [dish]))[0].otherOccupiedAmountMinor, 2245n);

      // 8. b10 cash-refund-approvals (M163): money taken back on an order paid only in cash at the
      // counter, as the pilot API role. The guest can only hand back the cash the drawer gave them:
      // in cash, in whole nickels, up to the $22.45 given back (the rounding up included, more than
      // the Order's $22.43 refunded); never "charged on the card machine".
      const recover = createPostgresRefundRecoveryStore({
        scope: { tenantReference: tenant, brandReference: brand, storeReference: store },
        providerAccountReference: id(++n),
        environment: "Test",
        authorize: async (_tx, query) => query.orderReference === first.orderReference,
      });
      const recoveredAt = new Date().toISOString();
      const takeBack = (amountMinor, extra = {}) => {
        const recoveryReference = id(++n);
        return {
          recoveryReference,
          operationReference: id(++n),
          orderReference: first.orderReference,
          method: "Cash",
          slipReference: null,
          amountMinor,
          reasonCode: "REFUNDED_TOO_MUCH",
          actorReference: actor,
          recordedAt: recoveredAt,
          businessDate: recoveredAt.slice(0, 10),
          audit: {
            auditId: id(++n),
            brandId: brand,
            storeId: store,
            actor: { type: "User", reference: actor },
            actionCode: "PAYMENT_REFUND_RECOVERY_RECORDED",
            targetType: "PaymentRefundRecovery",
            targetId: recoveryReference,
            reasonCode: "REFUNDED_TOO_MUCH",
            correlationId: id(++n),
            occurredAt: recoveredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: "FINANCIAL_COMPLIANCE",
            retentionPolicyVersion: 1,
          },
          ...extra,
        };
      };
      assert.equal(
        (await position(first.orderReference)).settlement.confirmedRefundMinor,
        2243n,
        "the Order was refunded $22.43; the drawer gave back $22.45",
      );
      // The payment page reads the same allowance: cash only, $22.45.
      const allowance = () =>
        asApi((tx) =>
          readRefundRecoveryAllowance(
            tx,
            {
              scope: { tenantReference: tenant, brandReference: brand, storeReference: store },
              providerAccountReference: id(++n),
              environment: "Test",
              authorize: async () => true,
            },
            { orderReference: first.orderReference, observedAt: new Date().toISOString() },
          ),
        );
      assert.deepEqual(await allowance(), { cashOnly: true, leftMinor: 2245n });
      // A cash payment can't be charged back on the card machine, and cash has no odd cents.
      await assert.rejects(
        asApi((tx) => recover(tx, takeBack(500n, { method: "CardMachine", slipReference: "A1" }))),
        // b12: refused for its own reason, answered 422 by the route (never a permission refusal).
        { code: "REFUND_RECOVERY_CASH_ONLY" },
      );
      await assert.rejects(
        asApi((tx) => recover(tx, takeBack(437n))),
        { code: "REFUND_RECOVERY_WHOLE_NICKELS" },
      );
      // A recovery recorded before b10 could be any cents (the old command took $0.02 in cash on
      // a cash order). Test-controlled legacy row: what is left is rounded down to whole nickels
      // ($22.43 -> $22.40), so the payment page reads an amount it can offer, never 2243.
      const legacy = id(++n);
      await admin.query(
        "INSERT INTO rms_payment.refund_recovery (tenant_id,brand_id,store_id,recovery_id,operation_id,order_id,method,slip_reference,amount_minor,currency_code,reason_code,actor_type,actor_id,permission_code,business_date,recorded_at,audit_id) VALUES ($1,$2,$3,$4,$5,$6,'Cash',NULL,2,'CAD','REFUNDED_TOO_MUCH','User',$7,'payment.refund.recover',$8::date,$9::timestamptz,$10)",
        [
          tenant,
          brand,
          store,
          legacy,
          id(++n),
          first.orderReference,
          actor,
          recoveredAt.slice(0, 10),
          recoveredAt,
          id(++n),
        ],
      );
      assert.deepEqual(await allowance(), { cashOnly: true, leftMinor: 2240n });
      await assert.rejects(
        asApi((tx) => recover(tx, takeBack(2245n))),
        { code: "REFUND_RECOVERY_ABOVE_REFUNDED" },
      );
      // All the cash still left can come back, in whole nickels.
      const allBack = await asApi((tx) => recover(tx, takeBack(2240n)));
      assert.equal(allBack.status, "Recorded");
      await assert.rejects(
        asApi((tx) => recover(tx, takeBack(5n))),
        { code: "REFUND_RECOVERY_ABOVE_REFUNDED" },
      );
      assert.deepEqual(await allowance(), { cashOnly: true, leftMinor: 0n });
      // A card-machine order keeps both ways and its confirmed refunds as the limit.
      const carded2 = order(1000n, 0n);
      await asApi((tx) =>
        cards().record(tx, paymentOf(carded2, id(++n), { slipReference: "AUTH 10" })),
      );
      assert.deepEqual(
        await asApi((tx) =>
          readRefundRecoveryAllowance(
            tx,
            {
              scope: { tenantReference: tenant, brandReference: brand, storeReference: store },
              providerAccountReference: id(++n),
              environment: "Test",
              authorize: async () => true,
            },
            { orderReference: carded2.orderReference, observedAt: new Date().toISOString() },
          ),
        ),
        { cashOnly: false, leftMinor: 0n },
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT method,amount_minor::text AS amount,slip_reference FROM rms_payment.refund_recovery WHERE order_id=$1 ORDER BY amount_minor",
            [first.orderReference],
          )
        ).rows,
        [
          { method: "Cash", amount: "2", slip_reference: null },
          { method: "Cash", amount: "2240", slip_reference: null },
        ],
      );
    } finally {
      for (const client of clients) await client.end().catch(() => undefined);
      await admin.end();
    }
  });
});
