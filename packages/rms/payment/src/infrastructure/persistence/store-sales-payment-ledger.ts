import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { decodeOrdinaryRefundRequest } from "../../application/ordinary-refund-request.js";
import { createPostgresOrdinaryRefundWindowSource } from "../ordinary-refund-window-source.js";
import { createPostgresConfirmedCompensationRefundSource } from "./payment-compensation-refund-source.js";
import { createPostgresCardMachinePaymentStore } from "./card-machine-payment-store.js";
import { createPostgresDiningTableSettlementStore } from "./dining-table-settlement-store.js";
import { createPostgresPaymentCaptureWindowSource } from "./payment-reconciliation-candidates.js";

/**
 * Where the money moved: the Provider (online card), the Store's own card machine, or cash
 * (DEC-DINE-IN-PAY-LATER: a table paid in cash at the end).
 */
export type StoreSalesPaymentChannel = "Online" | "CardMachine" | "Cash";
export interface StoreSalesPayment {
  readonly channel: StoreSalesPaymentChannel;
  readonly paymentIntentReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** What the Batch's priced items cost (items, discounts, tax and fees), without the tip. */
  readonly orderAllocationMinor: bigint;
  readonly tipMinor: bigint;
  readonly totalMinor: bigint;
  /**
   * DEC-DINE-IN-PAY-LATER: cash rounding to 5 cents taken with this line (cash only; 0 otherwise).
   * It is collected but is not the Order's amount, tip or tax.
   */
  readonly roundingMinor: bigint;
  /**
   * How many payments this record is: 1, except the further round lines of one table payment
   * (a table pays once; each round is its own line), which are 0.
   */
  readonly paymentCount: 0 | 1;
  /** When the money was taken: the Provider capture or the card-machine approval time. */
  readonly takenAt: string;
}
/** A refund's share of one order item, from the refund request's own allocation. */
export interface StoreSalesRefundItemShare {
  readonly orderItemReference: string;
  readonly unitCount: number;
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly tipMinor: bigint;
  readonly serviceChargeMinor: bigint;
}
export interface StoreSalesRefund {
  readonly channel: StoreSalesPaymentChannel;
  /** Ordinary: an item refund (also staff item cancellations); Compensation and CardMachine
   * whole-payment refunds return what remained of the payment; Cash: cash given back from a
   * table's cash payment (an amount, not itemized). */
  readonly kind: "Ordinary" | "Compensation" | "CardMachine" | "Cash";
  readonly refundReference: string;
  readonly orderReference: string;
  readonly paymentIntentReference: string;
  readonly amountMinor: bigint;
  /** When the money went back, by the day-end settlement's rule for this kind. */
  readonly refundedAt: string;
  /** Item shares when the refund request allocated them; null for a whole-payment refund. */
  readonly items: readonly StoreSalesRefundItemShare[] | null;
}
/** The day-end settlement's own totals for the same window, read by its own sources. */
export interface StoreSalesSettlementTotals {
  readonly onlineCaptured: { readonly count: number; readonly amountMinor: bigint };
  readonly onlineRefunded: { readonly count: number; readonly amountMinor: bigint };
  readonly cardMachineTaken: {
    readonly count: number;
    readonly amountMinor: bigint;
    readonly tipMinor: bigint;
  };
  readonly cardMachineRefunded: { readonly count: number; readonly amountMinor: bigint };
  /** DEC-DINE-IN-PAY-LATER: tables paid in cash (taken includes the cash rounding). */
  readonly cashTaken: {
    readonly count: number;
    readonly amountMinor: bigint;
    readonly tipMinor: bigint;
    readonly roundingMinor: bigint;
  };
  readonly cashRefunded: { readonly count: number; readonly amountMinor: bigint };
}

const fail = (): never => {
  throw new Error("STORE_SALES_PAYMENT_LEDGER_UNAVAILABLE");
};
const integer = (value: unknown) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
  return BigInt(value);
};

/**
 * WP-2423 Q14 (store reports): the payments a Store took in a window and every refund made before the
 * window's end, as the day-end settlement counts them — online captures by Provider capture time,
 * ordinary refunds by Provider creation time, compensation refunds by Provider confirmation time and
 * card-machine payments and refunds by when staff took or returned them. Each record names its Order
 * and Batch so a report can join Ordering's priced items; no card, contact or Provider data leaves.
 * The settlement's own window totals come back alongside, so the caller can prove the two agree.
 */
export function createPostgresStoreSalesPaymentLedger(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  return async (
    tx: ConsumerTransaction,
    value: { readonly startsAt: string; readonly endsAt: string; readonly observedAt: string },
  ) => {
    const startsAt = parsePaymentInstant(value.startsAt),
      endsAt = parsePaymentInstant(value.endsAt),
      observedAt = parsePaymentInstant(value.observedAt);
    if (startsAt >= endsAt || endsAt > observedAt) return fail();
    const allowed = async (t: ConsumerTransaction) => {
      if (t !== tx || (await options.authorize(tx)) !== true) return fail();
      return true;
    };
    await allowed(tx);
    const providerScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      providerAccountReference: scope.providerAccountReference,
      environment: scope.environment,
    };
    const window = { startsAt, endsAt, observedAt };

    // Settlement totals, by the settlement's own sources.
    const captured = await createPostgresPaymentCaptureWindowSource({
      scope: providerScope,
      authorize: async (t) => allowed(t),
    })(tx, window);
    const ordinary = await createPostgresOrdinaryRefundWindowSource({
      scope: { tenantReference: scope.tenantReference, ...providerScope },
      authorize: async (t) => allowed(t),
    })(tx, window);
    const cardMachineStore = createPostgresCardMachinePaymentStore({
      scope: {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      // The store's reads here take no per-Order authority; the caller's Store check applies.
      authorize: async (t) => (t as unknown) === tx && (await allowed(tx)),
    });
    const cardSummary = await cardMachineStore.summarize(tx, { from: startsAt, to: endsAt });
    const cardMachine = await cardMachineStore.listWindow(tx, { from: startsAt, to: endsAt });
    // DEC-DINE-IN-PAY-LATER: tables that paid once at the end (card machine or cash) and cash
    // given back from them, by when the money moved.
    const table = await createPostgresDiningTableSettlementStore({
      scope: {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      authorize: async (t) => (t as unknown) === tx && (await allowed(tx)),
    }).listWindow(tx, { from: startsAt, to: endsAt });
    const lineKey = (settlement: string, line: number) => settlement + ":" + String(line);

    // Refunds made before the window's end (earlier ones let a whole-payment refund know what was
    // already returned on its items).
    const refunds: StoreSalesRefund[] = [];
    const ordinaryInWindow = { count: 0, amountMinor: 0n };
    const requests = new Map<string, ReturnType<typeof decodeOrdinaryRefundRequest>>();
    const confirmed = ordinary.confirmedRefunds.filter((r) => r.providerCreatedAt < endsAt);
    const requestReferences = [...new Set(confirmed.map((r) => r.requestReference))];
    for (let index = 0; index < requestReferences.length; index += 500) {
      const chunk = requestReferences.slice(index, index + 500);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT request_id::text AS request,record_json::text AS record FROM rms_payment.ordinary_refund_request WHERE brand_id=$1 AND store_id=$2 AND request_id=ANY($3::uuid[])",
        [scope.brandReference, scope.storeReference, chunk],
      );
      for (const row of result.rows as readonly Record<string, unknown>[]) {
        const request = decodeOrdinaryRefundRequest(row.record);
        if (
          request.requestReference !== row.request ||
          request.brandReference !== scope.brandReference ||
          request.storeReference !== scope.storeReference ||
          request.tenantReference !== scope.tenantReference
        )
          return fail();
        requests.set(request.requestReference, request);
      }
    }
    for (const refund of confirmed) {
      const request = requests.get(refund.requestReference) ?? fail();
      const payment = request.payments.find(
        (entry) => entry.paymentAttemptReference === refund.paymentAttemptReference,
      );
      if (
        !payment ||
        request.orderReference !== refund.orderReference ||
        payment.paymentIntentReference !== refund.paymentIntentReference
      )
        return fail();
      const items = payment.items.map((item) =>
        Object.freeze({
          orderItemReference: item.orderItemReference,
          unitCount: item.refundUnitOrdinals.length,
          netMinor: item.components.netAmountMinor,
          taxMinor: item.components.taxAmountMinor,
          tipMinor: item.components.tipAmountMinor,
          serviceChargeMinor:
            item.components.serviceChargeAmountMinor + item.components.serviceChargeTaxAmountMinor,
        }),
      );
      const share = items.reduce(
        (sum, item) =>
          sum + item.netMinor + item.taxMinor + item.tipMinor + item.serviceChargeMinor,
        0n,
      );
      if (share !== refund.amountMinor) return fail();
      if (refund.providerCreatedAt >= startsAt) {
        ordinaryInWindow.count++;
        ordinaryInWindow.amountMinor += refund.amountMinor;
      }
      refunds.push(
        Object.freeze({
          channel: "Online" as const,
          kind: "Ordinary" as const,
          refundReference: refund.operationReference,
          orderReference: refund.orderReference,
          paymentIntentReference: refund.paymentIntentReference,
          amountMinor: refund.amountMinor,
          refundedAt: refund.providerCreatedAt,
          items: Object.freeze(items),
        }),
      );
    }
    if (
      ordinaryInWindow.count !== ordinary.refundCount ||
      ordinaryInWindow.amountMinor !== ordinary.refundedAmountMinor
    )
      return fail();
    const compensation = createPostgresConfirmedCompensationRefundSource({
      scope: providerScope,
      authorize: async (t) => allowed(t),
    });
    const compensationInWindow = { count: 0, amountMinor: 0n };
    let afterRefundReference: string | null = null,
      pages = 0;
    do {
      if (++pages > 1000) return fail();
      const page = await compensation(tx, { observedAt, afterRefundReference, limit: 100 });
      for (const record of page.records) {
        const fact = record.receipt.fact;
        if (fact.providerConfirmedAt >= endsAt) continue;
        if (fact.providerConfirmedAt >= startsAt) {
          compensationInWindow.count++;
          compensationInWindow.amountMinor += fact.amount.amountMinor;
        }
        refunds.push(
          Object.freeze({
            channel: "Online" as const,
            kind: "Compensation" as const,
            refundReference: String(fact.refundReference),
            orderReference: String(fact.orderReference),
            paymentIntentReference: String(fact.paymentIntentReference),
            amountMinor: fact.amount.amountMinor,
            refundedAt: String(fact.providerConfirmedAt),
            items: null,
          }),
        );
      }
      afterRefundReference = page.nextAfterRefundReference;
    } while (afterRefundReference !== null);

    const cardPayments = new Map(
      cardMachine.payments.map((payment) => [payment.cardMachinePaymentReference, payment]),
    );
    const cardRequestReferences = cardMachine.refunds
      .filter((refund) => refund.sourceKind === "OrdinaryRefund")
      .map((refund) => refund.sourceReference);
    if (cardRequestReferences.some((reference) => !requests.has(reference))) {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT request_id::text AS request,record_json::text AS record FROM rms_payment.ordinary_refund_request WHERE brand_id=$1 AND store_id=$2 AND request_id=ANY($3::uuid[])",
        [scope.brandReference, scope.storeReference, cardRequestReferences],
      );
      for (const row of result.rows as readonly Record<string, unknown>[]) {
        const request = decodeOrdinaryRefundRequest(row.record);
        if (request.requestReference !== row.request) return fail();
        requests.set(request.requestReference, request);
      }
    }
    for (const refund of cardMachine.refunds) {
      const payment = cardPayments.get(refund.cardMachinePaymentReference) ?? fail();
      let items: StoreSalesRefund["items"] = null;
      if (refund.sourceKind === "OrdinaryRefund") {
        const request = requests.get(refund.sourceReference) ?? fail();
        const entry = request.payments.find(
          (candidate) => candidate.paymentIntentReference === payment.paymentIntentReference,
        );
        if (!entry) return fail();
        items = Object.freeze(
          entry.items.map((item) =>
            Object.freeze({
              orderItemReference: item.orderItemReference,
              unitCount: item.refundUnitOrdinals.length,
              netMinor: item.components.netAmountMinor,
              taxMinor: item.components.taxAmountMinor,
              tipMinor: item.components.tipAmountMinor,
              serviceChargeMinor:
                item.components.serviceChargeAmountMinor +
                item.components.serviceChargeTaxAmountMinor,
            }),
          ),
        );
      }
      refunds.push(
        Object.freeze({
          channel: "CardMachine" as const,
          kind: "CardMachine" as const,
          refundReference: refund.cardMachineRefundReference,
          orderReference: refund.orderReference,
          paymentIntentReference: payment.paymentIntentReference,
          amountMinor: refund.amountMinor,
          refundedAt: refund.refundedAt,
          items,
        }),
      );
    }

    const tableSettlements = new Map(
      table.settlements.map((settlement) => [settlement.settlementReference, settlement]),
    );
    const cashRefunded = { count: 0, amountMinor: 0n };
    for (const refund of table.cashRefunds) {
      const settlement = tableSettlements.get(refund.settlementReference) ?? fail();
      const last = settlement.lines.at(-1) ?? fail();
      cashRefunded.count++;
      cashRefunded.amountMinor += refund.amountMinor;
      refunds.push(
        Object.freeze({
          channel: "Cash" as const,
          kind: "Cash" as const,
          refundReference: refund.cashRefundReference,
          orderReference: refund.orderReference,
          paymentIntentReference: lineKey(settlement.settlementReference, last.lineNumber),
          amountMinor: refund.amountMinor,
          refundedAt: refund.refundedAt,
          items: null,
        }),
      );
    }

    // Online payments captured in the window, and those any refund above belongs to.
    const refundedIntents = [
      ...new Set(
        refunds.filter((r) => r.channel === "Online").map((r) => r.paymentIntentReference),
      ),
    ];
    await allowed(tx);
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const online = await tx.query(
      "SELECT f.payment_transaction_id::text AS transaction,f.payment_intent_id::text AS intent,f.order_id::text AS order_id,i.order_batch_id::text AS batch,i.order_allocation_minor::text AS allocation,i.tip_minor::text AS tip,i.total_minor::text AS total,f.amount_minor::text AS amount,f.currency_code AS currency,f.occurred_at,f.recorded_at FROM rms_payment.payment_terminal_fact f JOIN rms_payment.payment_intent i ON i.brand_id=f.brand_id AND i.store_id=f.store_id AND i.payment_intent_id=f.payment_intent_id AND i.order_id=f.order_id WHERE f.brand_id=$1 AND f.store_id=$2 AND f.provider_account_id=$3 AND f.provider_environment=$4 AND f.terminal_outcome='Succeeded' AND f.recorded_at<=$7 AND ((f.occurred_at>=$5 AND f.occurred_at<$6) OR f.payment_intent_id=ANY($8::uuid[])) ORDER BY f.occurred_at,f.payment_transaction_id LIMIT 100001",
      [
        scope.brandReference,
        scope.storeReference,
        scope.providerAccountReference,
        scope.environment,
        startsAt,
        endsAt,
        observedAt,
        refundedIntents,
      ],
    );
    const rows = online.rows as readonly Record<string, unknown>[];
    if (rows.length > 100000) return fail();
    const payments: StoreSalesPayment[] = [],
      refundedPayments: StoreSalesPayment[] = [];
    const seenIntents = new Set<string>();
    for (const row of rows) {
      if (!(row.occurred_at instanceof Date) || !(row.recorded_at instanceof Date)) return fail();
      const takenAt = parsePaymentInstant(row.occurred_at.toISOString());
      const allocation = integer(row.allocation),
        tip = integer(row.tip),
        total = integer(row.total);
      const intent = String(parsePaymentReference(row.intent));
      if (
        row.currency !== "CAD" ||
        integer(row.amount) !== total ||
        allocation + tip !== total ||
        allocation <= 0n ||
        seenIntents.has(intent)
      )
        return fail();
      seenIntents.add(intent);
      const payment = Object.freeze({
        channel: "Online" as const,
        paymentIntentReference: intent,
        orderReference: String(parsePaymentReference(row.order_id)),
        orderBatchReference: String(parsePaymentReference(row.batch)),
        orderAllocationMinor: allocation,
        tipMinor: tip,
        totalMinor: total,
        roundingMinor: 0n,
        paymentCount: 1 as const,
        takenAt,
      });
      if (takenAt >= startsAt && takenAt < endsAt) payments.push(payment);
      else refundedPayments.push(payment);
    }
    if (refundedIntents.some((intent) => !seenIntents.has(intent))) return fail();
    const onlineTotal = payments.reduce((sum, payment) => sum + payment.totalMinor, 0n);
    if (payments.length !== captured.captureCount || onlineTotal !== captured.capturedAmountMinor)
      return fail();
    for (const payment of cardMachine.payments) {
      const record = Object.freeze({
        channel: "CardMachine" as const,
        paymentIntentReference: payment.paymentIntentReference,
        orderReference: payment.orderReference,
        orderBatchReference: payment.orderBatchReference,
        orderAllocationMinor: payment.preparation.orderAllocation.amountMinor,
        tipMinor: payment.preparation.tip.amountMinor,
        totalMinor: payment.preparation.total.amountMinor,
        roundingMinor: 0n,
        paymentCount: 1 as const,
        takenAt: payment.takenAt,
      });
      if (record.orderAllocationMinor + record.tipMinor !== record.totalMinor) return fail();
      if (payment.takenAt >= startsAt && payment.takenAt < endsAt) payments.push(record);
      else refundedPayments.push(record);
    }
    const tableCard = { count: 0, amountMinor: 0n, tipMinor: 0n };
    const cashTaken = { count: 0, amountMinor: 0n, tipMinor: 0n, roundingMinor: 0n };
    for (const settlement of table.settlements) {
      const inWindow = settlement.takenAt >= startsAt && settlement.takenAt < endsAt;
      if (inWindow) {
        const totals = settlement.method === "Cash" ? cashTaken : tableCard;
        totals.count++;
        totals.amountMinor += settlement.totalMinor;
        totals.tipMinor += settlement.tipMinor;
        if (settlement.method === "Cash") cashTaken.roundingMinor += settlement.roundingMinor;
      }
      for (const [index, line] of settlement.lines.entries()) {
        const record = Object.freeze({
          channel: settlement.method === "Cash" ? ("Cash" as const) : ("CardMachine" as const),
          paymentIntentReference: lineKey(settlement.settlementReference, line.lineNumber),
          orderReference: settlement.orderReference,
          orderBatchReference: line.orderBatchReference,
          orderAllocationMinor: line.roundMinor,
          tipMinor: line.tipMinor,
          totalMinor: line.roundMinor + line.tipMinor,
          roundingMinor: line.roundingMinor,
          paymentCount: index === 0 ? (1 as const) : (0 as const),
          takenAt: settlement.takenAt,
        });
        if (inWindow) payments.push(record);
        else refundedPayments.push(record);
      }
    }
    await allowed(tx);
    return Object.freeze({
      startsAt,
      endsAt,
      observedAt,
      currencyCode: "CAD" as const,
      /** DEC-DINE-IN-PAY-LATER: tables written off when the guests left without paying. */
      unpaidWriteOffs: Object.freeze(
        table.writeOffs.map((writeOff) =>
          Object.freeze({
            orderReference: writeOff.orderReference,
            amountMinor: writeOff.writtenOffMinor,
            decidedAt: writeOff.decidedAt,
          }),
        ),
      ),
      payments: Object.freeze(payments),
      refundedPayments: Object.freeze(refundedPayments),
      refunds: Object.freeze(refunds.sort((a, b) => a.refundedAt.localeCompare(b.refundedAt))),
      /** Online refunds sent but not yet confirmed by the Provider (not counted anywhere yet). */
      unresolvedOnlineRefundCount: ordinary.unresolvedOperationCount,
      settlement: Object.freeze({
        onlineCaptured: { count: captured.captureCount, amountMinor: captured.capturedAmountMinor },
        onlineRefunded: {
          count: ordinary.refundCount + compensationInWindow.count,
          amountMinor: ordinary.refundedAmountMinor + compensationInWindow.amountMinor,
        },
        // The Store's card machine took both counter/round payments and tables paid at the end.
        cardMachineTaken: {
          count: cardSummary.paymentCount + tableCard.count,
          amountMinor: cardSummary.takenMinor + tableCard.amountMinor,
          tipMinor: cardSummary.tipMinor + tableCard.tipMinor,
        },
        cardMachineRefunded: {
          count: cardSummary.refundCount,
          amountMinor: cardSummary.refundedMinor,
        },
        cashTaken,
        cashRefunded,
      }) satisfies StoreSalesSettlementTotals,
    });
  };
}
