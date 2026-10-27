import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderPaymentAttemptPosition } from "./persistence/order-payment-attempt-position.js";
import { createPostgresOrderPaymentRefundPosition } from "./order-payment-refund-position.js";
import { createPostgresCardMachinePaymentStore } from "./persistence/card-machine-payment-store.js";
import { createPostgresDiningTableSettlementStore } from "./persistence/dining-table-settlement-store.js";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
const fail = (): never => {
  throw new Error("ORDER_FINANCIAL_POSITION_UNAVAILABLE");
};
const reference = (value: unknown) => String(parsePaymentReference(value));
/** Current Payment facts only. Ordering owns the receivable; this position does not
 * issue financial finality or permit closure. Retain the caller transaction/fences.
 * Snapshot digest binds this observation, including the refund owners' digests. */
export function createPostgresOrderFinancialPosition(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize(
    tx: ConsumerTransaction,
    query: { orderReference: string; observedAt: string },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
      tenantReference: reference(options.scope.tenantReference),
      brandReference: reference(options.scope.brandReference),
      storeReference: reference(options.scope.storeReference),
    }),
    providerAccountReference = reference(options.providerAccountReference),
    environment = options.environment;
  if (!["Test", "Live"].includes(environment)) return fail();
  return async (tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) => {
    try {
      const raw = exactPaymentObject(input, ["orderReference", "observedAt"]),
        query = Object.freeze({
          orderReference: reference(raw.orderReference),
          observedAt: String(parsePaymentInstant(raw.observedAt)),
        });
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
        return true;
      };
      await authorize();
      const position = await createPostgresOrderPaymentAttemptPosition({
        scope: { ...scope, providerAccountReference, environment },
        authorize,
      }).load(tx, query);
      if (
        position.brandReference !== scope.brandReference ||
        position.storeReference !== scope.storeReference ||
        position.orderReference !== query.orderReference ||
        position.observedAt !== query.observedAt ||
        position.providerAccountReference !== providerAccountReference ||
        position.environment !== environment
      )
        return fail();
      const refunds = createPostgresOrderPaymentRefundPosition({
        scope,
        providerAccountReference,
        environment,
        authorize,
      });
      let confirmedRefundMinor = 0n,
        pendingRefundMinor = 0n,
        capturedMinor = 0n,
        capturedOrderAllocationMinor = 0n,
        capturedTipMinor = 0n,
        refundedOrderMinor = 0n,
        refundedTipMinor = 0n,
        unallocatedRefundMinor = 0n;
      const captures = [];
      for (const attempt of position.attempts) {
        if (attempt.outcome !== "Succeeded") continue;
        if (attempt.terminalReference === null || !/^[1-9][0-9]{0,18}$/u.test(attempt.totalMinor))
          return fail();
        const captureMinor = BigInt(attempt.totalMinor);
        if (
          !/^[1-9][0-9]{0,18}$/u.test(attempt.orderAllocationMinor) ||
          !/^(?:0|[1-9][0-9]{0,18})$/u.test(attempt.tipMinor)
        )
          return fail();
        const allocationMinor = BigInt(attempt.orderAllocationMinor),
          tipMinor = BigInt(attempt.tipMinor);
        if (allocationMinor + tipMinor !== captureMinor) return fail();
        const refund = await refunds(tx, {
          ...query,
          paymentTransactionReference: attempt.terminalReference,
          paymentIntentReference: attempt.paymentIntentReference,
          paymentAttemptReference: attempt.paymentAttemptReference,
        });
        if (
          typeof refund.confirmedMinor !== "bigint" ||
          typeof refund.pendingMinor !== "bigint" ||
          refund.confirmedMinor < 0n ||
          refund.pendingMinor < 0n ||
          refund.confirmedMinor + refund.pendingMinor > captureMinor ||
          !/^sha256:[a-f0-9]{64}$/u.test(refund.snapshotDigest)
        )
          return fail();
        let orderRefund = refund.confirmedOrderAllocationMinor,
          tipRefund = refund.confirmedTipMinor,
          unallocated = refund.unallocatedConfirmedMinor;
        if (
          [orderRefund, tipRefund, unallocated].some((v) => typeof v !== "bigint" || v < 0n) ||
          orderRefund + tipRefund + unallocated !== refund.confirmedMinor ||
          orderRefund > allocationMinor ||
          tipRefund > tipMinor
        )
          return fail();
        const compensationUnallocated = refund.unallocatedCompensationMinor;
        if (
          typeof compensationUnallocated !== "bigint" ||
          compensationUnallocated < 0n ||
          compensationUnallocated > unallocated
        )
          return fail();
        // A fully reversed capture leaves no ambiguity about aggregate order/tip components.
        // Never derive a partial allocation or absorb missing ordinary-refund evidence.
        if (
          refund.confirmedMinor === captureMinor &&
          refund.pendingMinor === 0n &&
          unallocated > 0n &&
          unallocated === compensationUnallocated
        ) {
          orderRefund = allocationMinor;
          tipRefund = tipMinor;
          unallocated = 0n;
        }
        refundedOrderMinor += orderRefund;
        refundedTipMinor += tipRefund;
        unallocatedRefundMinor += unallocated;
        capturedMinor += captureMinor;
        capturedOrderAllocationMinor += allocationMinor;
        capturedTipMinor += tipMinor;
        confirmedRefundMinor += refund.confirmedMinor;
        pendingRefundMinor += refund.pendingMinor;
        captures.push(
          Object.freeze({
            paymentTransactionReference: attempt.terminalReference,
            paymentIntentReference: attempt.paymentIntentReference,
            paymentAttemptReference: attempt.paymentAttemptReference,
            orderBatchReference: attempt.orderBatchReference,
            capturedMinor: captureMinor,
            orderAllocationMinor: allocationMinor,
            tipMinor,
            confirmedRefundMinor: refund.confirmedMinor,
            pendingRefundMinor: refund.pendingMinor,
            refundedOrderMinor: orderRefund,
            refundedTipMinor: tipRefund,
            unallocatedRefundMinor: unallocated,
            refundSnapshotDigest: refund.snapshotDigest,
          }),
        );
      }
      if (capturedMinor !== position.capturedMinor || capturedMinor > 9223372036854775807n)
        return fail();
      // WP-2423 (B759): card-machine payments are this Order's captures too (Payment owns both
      // tenders). Their refunds are the ordinary refund requests recorded on the machine (read
      // through the same ordinary refund owner, with its order/tip allocation) and the refunds the
      // Store recorded for cancellations. A cancellation refund returns what was left of the
      // payment, so once the payment is reversed in full its components are reversed in full.
      const machine = await createPostgresCardMachinePaymentStore({
        scope,
        authorize: async (_tx, value) =>
          value.orderReference === query.orderReference && (await authorize()),
      }).listByOrder(tx, query.orderReference);
      let machineCapturedMinor = 0n,
        machineOrderMinor = 0n,
        machineTipMinor = 0n,
        machineConfirmedRefundMinor = 0n,
        machinePendingRefundMinor = 0n,
        machineRefundedOrderMinor = 0n,
        machineRefundedTipMinor = 0n,
        machineUnallocatedRefundMinor = 0n;
      const machineCaptures = [];
      for (const { payment, refunds: recorded } of machine) {
        if (payment.recordedAt > query.observedAt) continue;
        if (
          payment.tenantReference !== scope.tenantReference ||
          payment.brandReference !== scope.brandReference ||
          payment.storeReference !== scope.storeReference ||
          payment.orderReference !== query.orderReference ||
          payment.environment !== environment
        )
          return fail();
        const captureMinor = BigInt(payment.preparation.total.amountMinor),
          allocationMinor = BigInt(payment.preparation.orderAllocation.amountMinor),
          tipMinor = BigInt(payment.preparation.tip.amountMinor);
        if (captureMinor <= 0n || allocationMinor < 0n || tipMinor < 0n) return fail();
        if (allocationMinor + tipMinor !== captureMinor) return fail();
        const ordinary = await refunds(tx, {
          ...query,
          paymentTransactionReference: payment.cardMachinePaymentReference,
          paymentIntentReference: payment.paymentIntentReference,
          paymentAttemptReference: payment.paymentAttemptReference,
        });
        if (
          typeof ordinary.confirmedMinor !== "bigint" ||
          typeof ordinary.pendingMinor !== "bigint" ||
          ordinary.confirmedMinor < 0n ||
          ordinary.pendingMinor < 0n ||
          !/^sha256:[a-f0-9]{64}$/u.test(ordinary.snapshotDigest)
        )
          return fail();
        let itemMinor = 0n,
          wholeMinor = 0n;
        for (const refund of recorded) {
          if (
            refund.cardMachinePaymentReference !== payment.cardMachinePaymentReference ||
            refund.orderReference !== query.orderReference ||
            refund.amountMinor <= 0n
          )
            return fail();
          // Ordinary refunds are counted (and allocated) by the ordinary refund owner above.
          if (refund.sourceKind === "OrdinaryRefund" || refund.recordedAt > query.observedAt)
            continue;
          if (refund.sourceKind === "ItemCancellation") itemMinor += refund.amountMinor;
          else wholeMinor += refund.amountMinor;
        }
        const confirmedMinor = ordinary.confirmedMinor + itemMinor + wholeMinor,
          pendingMinor = ordinary.pendingMinor;
        if (confirmedMinor + pendingMinor > captureMinor) return fail();
        let orderRefund = ordinary.confirmedOrderAllocationMinor + itemMinor,
          tipRefund = ordinary.confirmedTipMinor,
          unallocated = ordinary.unallocatedConfirmedMinor + wholeMinor;
        if (
          [orderRefund, tipRefund, unallocated].some((v) => typeof v !== "bigint" || v < 0n) ||
          orderRefund + tipRefund + unallocated !== confirmedMinor ||
          orderRefund > allocationMinor ||
          tipRefund > tipMinor
        )
          return fail();
        const derivable = ordinary.unallocatedCompensationMinor + wholeMinor;
        if (
          confirmedMinor === captureMinor &&
          pendingMinor === 0n &&
          unallocated > 0n &&
          unallocated === derivable
        ) {
          orderRefund = allocationMinor;
          tipRefund = tipMinor;
          unallocated = 0n;
        }
        machineCapturedMinor += captureMinor;
        machineOrderMinor += allocationMinor;
        machineTipMinor += tipMinor;
        machineConfirmedRefundMinor += confirmedMinor;
        machinePendingRefundMinor += pendingMinor;
        machineRefundedOrderMinor += orderRefund;
        machineRefundedTipMinor += tipRefund;
        machineUnallocatedRefundMinor += unallocated;
        machineCaptures.push(
          Object.freeze({
            cardMachinePaymentReference: payment.cardMachinePaymentReference,
            orderBatchReference: payment.orderBatchReference,
            capturedMinor: captureMinor,
            orderAllocationMinor: allocationMinor,
            tipMinor,
            confirmedRefundMinor: confirmedMinor,
            pendingRefundMinor: pendingMinor,
            refundedOrderMinor: orderRefund,
            refundedTipMinor: tipRefund,
            unallocatedRefundMinor: unallocated,
            refundSnapshotDigest: ordinary.snapshotDigest,
            recordedRefunds: recorded
              .filter((refund) => refund.recordedAt <= query.observedAt)
              .map((refund) => refund.cardMachineRefundReference),
          }),
        );
      }
      // WP-2423 DEC-DINE-IN-PAY-LATER: a table that paid once at the end (card machine or cash),
      // one line per round. Each line is a capture of its round's total (and the tip on the last
      // line); cash rounding is the drawer's difference, not part of the Order's amounts.
      const tableStore = createPostgresDiningTableSettlementStore({
        scope,
        authorize: async (_tx, value) =>
          value.orderReference === query.orderReference && (await authorize()),
      });
      const tableSettlements = (await tableStore.listByOrders(tx, [query.orderReference])).filter(
        (settlement) => settlement.recordedAt <= query.observedAt,
      );
      // Cash given back from a table's cash payment: the Order's share first, then the tip; what
      // is left (the cash rounding) is not the Order's and stays unallocated.
      const tableCashRefunds = (
        tableSettlements.some((settlement) => settlement.method === "Cash")
          ? await tableStore.listCashRefundsByOrders(tx, [query.orderReference])
          : []
      ).filter((refund) => refund.recordedAt <= query.observedAt);
      let tableRefundedMinor = 0n,
        tableRefundedOrderMinor = 0n,
        tableRefundedTipMinor = 0n,
        tableRefundedUnallocatedMinor = 0n;
      let tableOrderMinor = 0n,
        tableTipMinor = 0n;
      const tableCaptures = [];
      for (const settlement of tableSettlements) {
        if (
          settlement.orderReference !== query.orderReference ||
          settlement.environment !== environment
        )
          return fail();
        for (const line of settlement.lines) {
          tableOrderMinor += line.roundMinor;
          tableTipMinor += line.tipMinor;
          tableCaptures.push(
            Object.freeze({
              settlementReference: settlement.settlementReference,
              method: settlement.method,
              orderBatchReference: line.orderBatchReference,
              capturedMinor: line.roundMinor + line.tipMinor,
              orderAllocationMinor: line.roundMinor,
              tipMinor: line.tipMinor,
              roundingMinor: line.roundingMinor,
            }),
          );
        }
      }
      for (const settlement of tableSettlements) {
        const refunded = tableCashRefunds
          .filter((refund) => refund.settlementReference === settlement.settlementReference)
          .reduce((sum, refund) => sum + refund.amountMinor, 0n);
        if (refunded > settlement.totalMinor) return fail();
        const toOrder = refunded < settlement.roundsMinor ? refunded : settlement.roundsMinor;
        const rest = refunded - toOrder;
        const toTip = rest < settlement.tipMinor ? rest : settlement.tipMinor;
        tableRefundedMinor += refunded;
        tableRefundedOrderMinor += toOrder;
        tableRefundedTipMinor += toTip;
        tableRefundedUnallocatedMinor += rest - toTip;
      }
      if (
        tableCashRefunds.some(
          (refund) =>
            !tableSettlements.some(
              (settlement) => settlement.settlementReference === refund.settlementReference,
            ),
        )
      )
        return fail();
      const tableCapturedMinor = tableOrderMinor + tableTipMinor;
      if (capturedMinor + machineCapturedMinor + tableCapturedMinor > 9223372036854775807n)
        return fail();
      await authorize();
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            scope,
            providerAccountReference,
            environment,
            query,
            position.snapshotDigest,
            captures.map((c) => [c.paymentTransactionReference, c.refundSnapshotDigest]),
            capturedMinor.toString(),
            capturedOrderAllocationMinor.toString(),
            capturedTipMinor.toString(),
            confirmedRefundMinor.toString(),
            pendingRefundMinor.toString(),
            refundedOrderMinor.toString(),
            refundedTipMinor.toString(),
            unallocatedRefundMinor.toString(),
            machineCaptures.map((c) => [
              c.cardMachinePaymentReference,
              c.refundSnapshotDigest,
              c.recordedRefunds,
            ]),
            machineCapturedMinor.toString(),
            machineConfirmedRefundMinor.toString(),
            machinePendingRefundMinor.toString(),
            tableCaptures.map((c) => [
              c.settlementReference,
              c.orderBatchReference,
              c.capturedMinor.toString(),
              c.roundingMinor.toString(),
            ]),
            tableCashRefunds.map((r) => [r.cashRefundReference, r.amountMinor.toString()]),
          ]),
        )
        .digest("hex");
      return Object.freeze({
        ...scope,
        ...query,
        providerAccountReference,
        environment,
        currencyCode: "CAD" as const,
        capturedMinor,
        capturedOrderAllocationMinor,
        capturedTipMinor,
        confirmedRefundMinor,
        pendingRefundMinor,
        refundAllocation: Object.freeze({
          orderMinor: refundedOrderMinor,
          tipMinor: refundedTipMinor,
          unallocatedMinor: unallocatedRefundMinor,
        }),
        netCapturedMinor: capturedMinor - confirmedRefundMinor,
        unresolvedAttemptCount: position.unresolvedCount,
        failedAttemptCount: position.failedCount,
        captures: Object.freeze(captures),
        /** Card-machine payments of this Order and their refunds (not sent to a Provider). */
        cardMachineCaptures: Object.freeze(machineCaptures),
        /** WP-2423 DEC-DINE-IN-PAY-LATER: the rounds a table paid with its one settlement. */
        tableSettlementCaptures: Object.freeze(tableCaptures),
        /**
         * WP-2423 (B759): what the Order was paid and refunded across both tenders (online and
         * card machine). Settlement and financial finality read these; the fields above stay the
         * online payment alone (receipts, "Paid online").
         */
        settlement: Object.freeze({
          capturedMinor: capturedMinor + machineCapturedMinor + tableCapturedMinor,
          capturedOrderAllocationMinor:
            capturedOrderAllocationMinor + machineOrderMinor + tableOrderMinor,
          capturedTipMinor: capturedTipMinor + machineTipMinor + tableTipMinor,
          confirmedRefundMinor:
            confirmedRefundMinor + machineConfirmedRefundMinor + tableRefundedMinor,
          pendingRefundMinor: pendingRefundMinor + machinePendingRefundMinor,
          refundAllocation: Object.freeze({
            orderMinor: refundedOrderMinor + machineRefundedOrderMinor + tableRefundedOrderMinor,
            tipMinor: refundedTipMinor + machineRefundedTipMinor + tableRefundedTipMinor,
            unallocatedMinor:
              unallocatedRefundMinor +
              machineUnallocatedRefundMinor +
              tableRefundedUnallocatedMinor,
          }),
        }),
        snapshotDigest: "sha256:" + digest,
      });
    } catch {
      return fail();
    }
  };
}
