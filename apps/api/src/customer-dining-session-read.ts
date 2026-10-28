import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import { createHash } from "node:crypto";
import { createPostgresDiningPaymentTimingStore, listDiningSessionTableLabels } from "@rms/dining";
import { listOpenKitchenReworkItems } from "@rms/kitchen";
import {
  createOrderStatusQueryService,
  createPostgresDiningSessionOrderLookup,
  createPostgresOrderStatusProjectionStore,
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listDiningOrderBatchAuthorship,
  listOrderItemPrices,
  listStoreDiningBatchPaymentDeadlines,
  listStoreUnpaidBatchCancellations,
  OrderStatusProjectionError,
  type CartQueryTransactionRunner,
  type OrderItemProgressPhase,
  createPostgresStaffDiningRoundEntryStore,
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresPayLaterItemCancellationStore,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  createPostgresCardMachinePaymentStore,
  createPostgresOrdinaryRefundPositionSource,
  createPostgresPaymentCompensationRefundPositionSource,
  createPostgresPaymentStatusStore,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
} from "@rms/payment";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { withFailureCause } from "./customer-failure-diagnostic.js";
import type { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { readItemCancellationRefundStatus } from "./merchant-order-item-staff-cancellation.js";
import { readStaffCancellationRefundPosition } from "./merchant-order-staff-cancellation.js";

/**
 * WP-2423 Q8 (Section 88 CUST-DINE-IN-SESSION): the table's shared, read-only view for a guest who
 * is a current participant of a dine-in session — each round ordered at this table, who ordered it
 * only as "you" or "another guest", where it is (kitchen, served, cancelled) and whether it was
 * paid, plus what the table has paid, had refunded and still owes. Composed from the owners' public
 * reads (Ordering status and authorship, Dining service and table label, Kitchen through delivery
 * progress, Payment outcomes and refunds); no business rule is decided here beyond presenting them.
 */

export interface CustomerMoney {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}
export type DiningStoreCancellationReason =
  "CustomerRequest" | "SoldOut" | "StoreError" | "DuplicateOrder" | "GuestLeft";
export type DiningItemPhase = OrderItemProgressPhase;

/** The published menu item and options of a dish the table ordered (public menu references). */
export interface CustomerDiningOrderAgain {
  readonly sellableReference: string;
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
}

/** Owner facts for one dining session, as read in one transaction. References stay server-side. */
export interface CustomerDiningSessionFacts {
  readonly diningSessionReference: string;
  readonly tableLabel: string | null;
  readonly checkedAt: string;
  /** DEC-DINE-IN-PAY-LATER: how this table pays, as it was opened (absent: pay first). */
  readonly paymentTiming?: "PayFirst" | "PayLater";
  readonly order: null | {
    readonly orderNumber: string;
    readonly batches: readonly {
      readonly orderBatchReference: string;
      readonly submittedAt: string;
      readonly items: readonly {
        readonly orderItemReference: string;
        readonly displayName: string;
        readonly quantity: number;
        readonly lineTotal: CustomerMoney;
      }[];
    }[];
    /** Per round: submitted by the asking guest. */
    readonly authorship: ReadonlyMap<string, boolean>;
    /** WP-2423 Q7 slice 2: rounds staff entered for the table (DEC-STAFF-DINE-IN-ROUND). */
    readonly staffRounds?: ReadonlySet<string>;
    /** Per item: Ordering/Kitchen phase and Dining's served quantity. */
    readonly delivery: ReadonlyMap<
      string,
      { readonly phase: DiningItemPhase; readonly deliveredQuantity: number }
    >;
    readonly paymentOutcomes: ReadonlyMap<string, "Succeeded" | "Failed">;
    readonly paymentDeadlines: ReadonlyMap<string, string>;
    /**
     * WP-2423 item 5: rounds whose payment was started (online or on the card machine). A round
     * awaiting payment with none is cancelled automatically at its deadline, and guests are told.
     */
    readonly paymentStarted?: ReadonlySet<string>;
    /**
     * DEC-DINE-IN-PAY-LATER: rounds sent to the kitchen unpaid at a table that pays once at the
     * end; they are owed (due) until the table is settled and are never cancelled for it.
     */
    readonly payLaterRounds?: ReadonlySet<string>;
    /** DEC-DINE-IN-PAY-LATER: rounds the table paid at the end, with its one payment. */
    readonly settledRounds?: ReadonlySet<string>;
    /** DEC-DINE-IN-PAY-LATER: the tip and cash rounding of the table's one payment (if paid). */
    readonly tableSettlement?: { readonly tipMinor: bigint; readonly roundingMinor: bigint } | null;
    readonly unpaidCancellations: ReadonlySet<string>;
    readonly staffCancellations: ReadonlyMap<
      string,
      {
        readonly reason: DiningStoreCancellationReason;
        readonly refundedMinor: bigint;
        readonly pendingMinor: bigint;
      }
    >;
    readonly itemCancellations: readonly {
      readonly orderItemReferences: readonly string[];
      readonly refunded: boolean;
      readonly refundAmount: CustomerMoney;
      /**
       * DEC-DINE-IN-PAY-LATER: taken off a pay-later bill before the table paid — never charged,
       * so not part of what the table ordered.
       */
      readonly notCharged?: true;
    }[];
    /** WP-2423 Q26: Order items the kitchen is remaking (Kitchen's public Query). */
    readonly remakes?: ReadonlySet<string>;
    /**
     * WP-2423 item 8 ③ (Owner decision 13): per Order item, the menu item and chosen options a
     * guest adds to their own cart with "Order again" (never the note or who added it).
     */
    readonly orderAgain?: ReadonlyMap<string, CustomerDiningOrderAgain>;
    /**
     * WP-2423 D5: each item's frozen price before tax and its tax (Ordering's own order items),
     * for every shown item or absent, so the table prints item prices, subtotal, tax and total
     * like the receipt. The amounts guests pay are unchanged.
     */
    readonly itemPrices?: ReadonlyMap<
      string,
      { readonly subtotal: CustomerMoney; readonly tax: CustomerMoney }
    >;
    readonly payments: readonly {
      readonly status: "Succeeded" | "Failed";
      readonly amount: CustomerMoney | null;
    }[];
    /**
     * Payment's refund positions over every captured payment of the Order: ordinary refunds (staff
     * refunds and item cancellations) plus compensation refunds (store-cancelled rounds).
     */
    readonly refunds: { readonly confirmedMinor: bigint; readonly pendingMinor: bigint };
  };
}

export type DiningRoundStatus =
  | "AwaitingPayment"
  | "PaymentFailed"
  | "NotPaidCancelled"
  | "StoreCancelled"
  | "Received"
  | "Queued"
  | "Preparing"
  | "Ready"
  | "Serving"
  | "Served";
export type DiningRoundPayment =
  | "Paid"
  | "Awaiting"
  | "Failed"
  | "NotCharged"
  | "Refunded"
  | "RefundPending"
  /** DEC-DINE-IN-PAY-LATER: in the kitchen, paid with the table's bill at the end. */
  | "OnTableBill";

export interface CustomerDiningSessionView {
  readonly tableLabel: string | null;
  readonly orderNumber: string | null;
  readonly checkedAt: string;
  /** DEC-DINE-IN-PAY-LATER: PayLater — rounds go to the kitchen when sent; the table pays at the end. */
  readonly paymentTiming: "PayFirst" | "PayLater";
  readonly rounds: readonly {
    readonly roundNumber: number;
    /** WP-2423 Q7 slice 2: "Staff" for a round staff entered for the table. */
    readonly orderedBy: "You" | "AnotherGuest" | "Staff";
    readonly submittedAt: string;
    readonly status: DiningRoundStatus;
    readonly payment: DiningRoundPayment;
    /**
     * When a round whose payment failed, or (WP-2423 item 5) one with no payment started, is
     * cancelled automatically.
     */
    readonly cancelsAt: string | null;
    readonly storeCancellationReason: DiningStoreCancellationReason | null;
    readonly items: readonly {
      readonly displayName: string;
      readonly quantity: number;
      readonly servedQuantity: number;
      readonly cancelled: boolean;
      readonly lineTotal: CustomerMoney;
      /** WP-2423 D5: the item's price before tax (present when every item's price is known). */
      readonly priceBeforeTax?: CustomerMoney;
      /** WP-2423 Q26: present (true) only while the kitchen is making this item again. */
      readonly beingRemade?: true;
      /** WP-2423 item 8 ③ (decision 13): what "Order again" adds, when it can be read. */
      readonly orderAgain?: CustomerDiningOrderAgain;
    }[];
    /** WP-2423 D5: the round's items before tax and their tax (with priceBeforeTax). */
    readonly subtotal?: CustomerMoney;
    readonly tax?: CustomerMoney;
    readonly itemsTotal: CustomerMoney;
  }[];
  /** Null until the table has ordered. Due is the item total of rounds still waiting for payment. */
  readonly summary: null | {
    readonly paid: CustomerMoney;
    readonly refunded: CustomerMoney;
    readonly refundPending: CustomerMoney;
    readonly due: CustomerMoney;
    /** DEC-DINE-IN-PAY-LATER: the tip and cash rounding of the table's one payment, once paid. */
    readonly tableTip?: CustomerMoney;
    readonly cashRounding?: CustomerMoney;
    /**
     * WP-2423 D5: what the table ordered (rounds never cancelled for non-payment): items before
     * tax, tax and the total including tax. Present when every item's price is known.
     */
    readonly ordered?: {
      readonly subtotal: CustomerMoney;
      readonly tax: CustomerMoney;
      readonly total: CustomerMoney;
    };
  };
}

const unavailable = (): never => {
  throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
};
/**
 * v15 2026-10-27: a guest of the table whose first round was just sent — the Order exists but its
 * status view is still being built (an event consumer does it, within seconds). Not "not joined":
 * the page waits a moment and reads again.
 */
export class DiningOrderStillProcessingError extends Error {
  constructor() {
    super("the table's order is still being prepared");
    this.name = "DiningOrderStillProcessingError";
  }
}
const denied = (): never => {
  throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
};

/** Pure composition of the owner facts into the customer-safe table view. */
export function composeCustomerDiningSession(
  facts: CustomerDiningSessionFacts,
): CustomerDiningSessionView {
  const order = facts.order;
  if (order === null)
    return Object.freeze({
      tableLabel: facts.tableLabel,
      orderNumber: null,
      checkedAt: facts.checkedAt,
      paymentTiming: facts.paymentTiming ?? "PayFirst",
      rounds: Object.freeze([]),
      summary: null,
    });
  const currency = order.batches[0]?.items[0]?.lineTotal.currencyCode;
  if (currency === undefined) return unavailable();
  const money = (amountMinor: bigint): CustomerMoney =>
    Object.freeze({ amountMinor, currencyCode: currency });
  const itemCancellation = (orderItemReference: string) =>
    order.itemCancellations.find((entry) => entry.orderItemReferences.includes(orderItemReference));
  let due = 0n;
  // WP-2423 D5: item prices before tax only when every item has one (never a mix).
  const prices =
    order.itemPrices !== undefined &&
    order.batches.every((batch) =>
      batch.items.every((item) => {
        const price = order.itemPrices?.get(item.orderItemReference);
        return (
          price !== undefined &&
          price.subtotal.currencyCode === currency &&
          price.tax.currencyCode === currency &&
          price.subtotal.amountMinor >= 0n &&
          price.tax.amountMinor >= 0n
        );
      }),
    )
      ? order.itemPrices
      : undefined;
  const ordered = { subtotal: 0n, tax: 0n, total: 0n };
  const rounds = order.batches.map((batch, index) => {
    const reference = batch.orderBatchReference;
    const mine = order.authorship.get(reference);
    if (mine === undefined || batch.items.length === 0) return unavailable();
    const unpaidCancelled = order.unpaidCancellations.has(reference);
    const staff = order.staffCancellations.get(reference);
    const items = batch.items.map((item) => {
      if (item.lineTotal.currencyCode !== currency) return unavailable();
      const delivery = order.delivery.get(item.orderItemReference);
      if (delivery === undefined) return unavailable();
      const cancelled =
        unpaidCancelled ||
        staff !== undefined ||
        delivery.phase === "Cancelled" ||
        delivery.phase === "Rejected" ||
        itemCancellation(item.orderItemReference) !== undefined;
      return Object.freeze({
        displayName: item.displayName,
        quantity: item.quantity,
        servedQuantity: cancelled ? 0 : delivery.deliveredQuantity,
        cancelled,
        lineTotal: money(item.lineTotal.amountMinor),
        price: prices?.get(item.orderItemReference),
        phase: delivery.phase,
        beingRemade: !cancelled && order.remakes?.has(item.orderItemReference) === true,
        orderAgain: order.orderAgain?.get(item.orderItemReference),
        notCharged: itemCancellation(item.orderItemReference)?.notCharged === true,
      });
    });
    const itemsTotal = items.reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n);
    const subtotal = items.reduce(
      (sum, item) => sum + (item.price?.subtotal.amountMinor ?? 0n),
      0n,
    );
    const tax = items.reduce((sum, item) => sum + (item.price?.tax.amountMinor ?? 0n), 0n);
    if (!unpaidCancelled) {
      const charged = items.filter((item) => !item.notCharged);
      ordered.subtotal += charged.reduce(
        (sum, item) => sum + (item.price?.subtotal.amountMinor ?? 0n),
        0n,
      );
      ordered.tax += charged.reduce((sum, item) => sum + (item.price?.tax.amountMinor ?? 0n), 0n);
      ordered.total += charged.reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n);
    }
    const outcome = order.paymentOutcomes.get(reference);
    const deadline = order.paymentDeadlines.get(reference) ?? null;
    let status: DiningRoundStatus;
    let payment: DiningRoundPayment;
    let cancelsAt: string | null = null;
    let reason: DiningStoreCancellationReason | null = null;
    if (unpaidCancelled) {
      status = "NotPaidCancelled";
      payment = "NotCharged";
    } else if (staff !== undefined) {
      status = "StoreCancelled";
      reason = staff.reason;
      payment =
        staff.refundedMinor > 0n && staff.pendingMinor === 0n ? "Refunded" : "RefundPending";
    } else if (outcome === "Failed") {
      status = "PaymentFailed";
      payment = "Failed";
      cancelsAt = deadline;
      due += itemsTotal;
    } else if (
      outcome === undefined &&
      order.payLaterRounds?.has(reference) === true &&
      order.settledRounds?.has(reference) === true
    ) {
      payment = "Paid";
      status = kitchenStatus();
    } else if (outcome === undefined && order.payLaterRounds?.has(reference) === true) {
      // In the kitchen and owed until the table pays at the end; never cancelled for payment.
      payment = "OnTableBill";
      due += items.reduce(
        (sum, item) => sum + (item.cancelled ? 0n : item.lineTotal.amountMinor),
        0n,
      );
      status = kitchenStatus();
    } else if (outcome === undefined) {
      status = "AwaitingPayment";
      payment = "Awaiting";
      if (order.paymentStarted !== undefined && !order.paymentStarted.has(reference))
        cancelsAt = deadline;
      due += itemsTotal;
    } else {
      payment = "Paid";
      status = kitchenStatus();
    }
    function kitchenStatus(): DiningRoundStatus {
      let status: DiningRoundStatus;
      const active = items.filter((item) => !item.cancelled);
      if (active.length === 0) {
        status = "StoreCancelled";
        const lines = batch.items.map((item) => itemCancellation(item.orderItemReference));
        // Nothing of an unpaid round was charged, so nothing is refunded.
        if (payment === "Paid")
          payment = lines.every((entry) => entry?.refunded === true) ? "Refunded" : "RefundPending";
        else payment = "NotCharged";
      } else if (active.every((item) => item.phase === "Fulfilled")) status = "Served";
      else if (active.some((item) => item.servedQuantity > 0)) status = "Serving";
      else if (active.every((item) => item.phase === "Ready")) status = "Ready";
      else if (active.some((item) => item.phase === "InProgress" || item.phase === "Ready"))
        status = "Preparing";
      else if (active.some((item) => item.phase === "Accepted")) status = "Queued";
      else status = "Received";
      // WP-2423 Q26: a dish being made again is neither served nor ready yet.
      if (active.some((item) => item.beingRemade))
        status = status === "Served" ? "Serving" : status === "Ready" ? "Preparing" : status;
      return status;
    }
    return Object.freeze({
      roundNumber: index + 1,
      orderedBy: order.staffRounds?.has(reference)
        ? ("Staff" as const)
        : mine
          ? ("You" as const)
          : ("AnotherGuest" as const),
      submittedAt: batch.submittedAt,
      status,
      payment,
      cancelsAt,
      storeCancellationReason: reason,
      items: Object.freeze(
        items.map((item) =>
          Object.freeze({
            displayName: item.displayName,
            quantity: item.quantity,
            servedQuantity: item.servedQuantity,
            cancelled: item.cancelled,
            lineTotal: item.lineTotal,
            ...(item.price === undefined
              ? {}
              : { priceBeforeTax: money(item.price.subtotal.amountMinor) }),
            ...(item.beingRemade ? { beingRemade: true as const } : {}),
            ...(item.orderAgain === undefined ? {} : { orderAgain: item.orderAgain }),
          }),
        ),
      ),
      ...(prices === undefined ? {} : { subtotal: money(subtotal), tax: money(tax) }),
      itemsTotal: money(itemsTotal),
    });
  });
  let paid = 0n;
  for (const entry of order.payments) {
    if (entry.status !== "Succeeded" || entry.amount === null) continue;
    if (entry.amount.currencyCode !== currency) return unavailable();
    paid += entry.amount.amountMinor;
  }
  for (const entry of order.itemCancellations)
    if (entry.refundAmount.currencyCode !== currency) return unavailable();
  const refunded = order.refunds.confirmedMinor,
    refundPending = order.refunds.pendingMinor;
  if (refunded < 0n || refundPending < 0n || refunded + refundPending > paid) return unavailable();
  return Object.freeze({
    tableLabel: facts.tableLabel,
    orderNumber: order.orderNumber,
    checkedAt: facts.checkedAt,
    paymentTiming: facts.paymentTiming ?? "PayFirst",
    rounds: Object.freeze(rounds),
    summary: Object.freeze({
      // DEC-DINE-IN-PAY-LATER: what the table's one payment added to its dishes, so the guest's
      // total and what was paid agree line by line.
      ...(order.tableSettlement == null
        ? {}
        : {
            tableTip: money(order.tableSettlement.tipMinor),
            cashRounding: money(order.tableSettlement.roundingMinor),
          }),
      paid: money(paid),
      refunded: money(refunded),
      refundPending: money(refundPending),
      due: money(due),
      ...(prices === undefined
        ? {}
        : {
            ordered: Object.freeze({
              subtotal: money(ordered.subtotal),
              tax: money(ordered.tax),
              total: money(ordered.total),
            }),
          }),
    }),
  });
}

type Options = Parameters<typeof createCustomerOrderStatusRead>[0];

/** A current participant of a dine-in session in this Store, or refused. */
export function assertDiningParticipant(
  guest: GuestSession,
  scope: { readonly brandReference: string; readonly storeReference: string },
) {
  if (
    String(guest.brandReference) !== scope.brandReference ||
    String(guest.storeReference) !== scope.storeReference ||
    guest.channel !== "DineIn" ||
    guest.diningState !== "DiningBound" ||
    guest.diningSessionReference === null ||
    guest.diningParticipantReference === null
  )
    return denied();
  return Object.freeze({
    guestSessionReference: String(guest.sessionReference),
    diningSessionReference: String(guest.diningSessionReference),
  });
}

export interface CustomerDiningSessionDependencies {
  /** Current Guest authorization inside the read transaction. */
  identity(
    transaction: ConsumerTransaction,
    now: () => string,
  ): { authorize(input: { observedAt: string }): Promise<GuestSession> };
  /** Owner facts for the participant's own dining session only. */
  facts(
    transaction: ConsumerTransaction,
    context: {
      readonly guest: GuestSession;
      readonly guestSessionReference: string;
      readonly diningSessionReference: string;
      readonly stillAuthorized: () => Promise<boolean>;
      readonly now: () => string;
      /** Owner 2026-10-23: the guest's chosen language for item names (absent: the session's). */
      readonly displayLocale?: string;
    },
  ): Promise<CustomerDiningSessionFacts>;
}

function postgresDependencies(
  options: Options,
  credentials: { sessionCredential: string; csrfCredential: string },
): CustomerDiningSessionDependencies {
  const scope = options.scope;
  return {
    identity(transaction, now) {
      const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
      const service = new GuestSessionService({
        store: createPostgresGuestSessionEntryStore(runner, scope),
        credentials: options.credentials,
        binding: options.binding(transaction),
        now,
        admission: { consume: async () => null },
      });
      return { authorize: (input) => service.authorize({ ...credentials, ...input }) };
    },
    async facts(transaction, context) {
      const {
        diningSessionReference,
        guestSessionReference,
        guest,
        stillAuthorized,
        now,
        displayLocale,
      } = context;
      const tableLabel =
        (await listDiningSessionTableLabels(transaction, scope, [diningSessionReference])).get(
          diningSessionReference,
        ) ?? null;
      // DEC-DINE-IN-PAY-LATER: the table's payment timing, captured when it was opened.
      const paymentTiming =
        options.diningScope === undefined
          ? undefined
          : ((
              await createPostgresDiningPaymentTimingStore({
                scope: options.diningScope,
                hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
                equals: (a, b) => a === b,
              }).loadSessionTimings(transaction, [diningSessionReference])
            ).get(diningSessionReference) ?? "PayFirst");
      const timing = paymentTiming === undefined ? {} : { paymentTiming };
      const orderReference = await createPostgresDiningSessionOrderLookup({
        ...scope,
        authorize: async (_tx, query) =>
          String(query.diningSessionReference) === diningSessionReference &&
          String(query.guestSessionReference) === guestSessionReference &&
          (await stillAuthorized()),
      }).load(transaction, { diningSessionReference, guestSessionReference, observedAt: now() });
      if (orderReference === null)
        return { diningSessionReference, tableLabel, checkedAt: now(), ...timing, order: null };
      if (options.diningScope === undefined || options.paymentScope === undefined)
        return unavailable();
      if (
        options.paymentScope.brandReference !== scope.brandReference ||
        options.paymentScope.storeReference !== scope.storeReference
      )
        return unavailable();
      const projections = createPostgresOrderStatusProjectionStore({
        ...scope,
        authorize: async (_tx, target) =>
          target.access === "Load" &&
          target.orderReference === orderReference &&
          target.brandReference === scope.brandReference &&
          target.storeReference === scope.storeReference &&
          (await stillAuthorized()),
        validateCurrentSource: async () => false,
      });
      const status = await createOrderStatusQueryService({
        authorization: {
          authorizeCustomer: async () => null,
          // The Order was resolved from this participant's own dining session above.
          authorizeDiningParticipant: async (input) =>
            input.orderReference === orderReference && (await stillAuthorized())
              ? { guestSession: guest }
              : null,
          authorizeMerchant: async () => null,
        },
        projections: {
          load: (reference) => projections.load({ transaction, orderReference: reference }),
          list: async () => denied(),
        },
      })
        .getDiningParticipant({ orderReference, observedAt: now() })
        .catch((error: unknown) => {
          if (
            error instanceof OrderStatusProjectionError &&
            error.code === "ORDER_STATUS_NOT_FOUND"
          )
            throw new DiningOrderStillProcessingError();
          throw error;
        });
      const delivery = await createDiningOrderDeliveryProgress({
        ...scope,
        diningScope: options.diningScope,
        authorize: async () => stillAuthorized(),
        authorizeKitchen: async () => stillAuthorized(),
        authorizeDining: async () => stillAuthorized(),
      }).load({
        transaction,
        ...scope,
        orderReference,
        diningSessionReference,
        guestSessionReference,
        observedAt: now(),
      });
      const members = status.order.batches.flatMap((batch) =>
        batch.items.map((item) => ({
          orderBatchReference: String(batch.orderBatchReference),
          orderItemReference: String(item.orderItemReference),
          quantity: item.quantity,
        })),
      );
      if (
        !delivery ||
        delivery.items.length !== members.length ||
        delivery.items.some(
          (item) =>
            !members.some(
              (member) =>
                member.orderItemReference === item.orderItemReference &&
                member.orderBatchReference === item.orderBatchReference &&
                member.quantity === item.orderedQuantity,
            ),
        )
      )
        return unavailable();
      const authorship = await listDiningOrderBatchAuthorship(transaction, scope, {
        orderReference,
        diningSessionReference,
        guestSessionReference,
      });
      if (!(await stillAuthorized())) return denied();
      const payments = await createPostgresPaymentStatusStore({
        scope: options.paymentScope,
        authorizeOrder: async (_tx, target) =>
          target.orderReference === orderReference && (await stillAuthorized()),
        authorize: async () => stillAuthorized(),
      }).listByOrder({ transaction, orderReference });
      const paymentOutcomes = new Map<string, "Succeeded" | "Failed">();
      for (const entry of await listStoreOrderBatchPaymentOutcomes(transaction, scope, [
        orderReference,
      ]))
        paymentOutcomes.set(entry.orderBatchReference, entry.status);
      const paymentDeadlines = new Map<string, string>();
      for (const entry of await listStoreDiningBatchPaymentDeadlines(transaction, scope, [
        orderReference,
      ]))
        paymentDeadlines.set(entry.orderBatchReference, entry.paymentDeadline);
      const unpaidCancellations = new Set<string>();
      for (const entry of await listStoreUnpaidBatchCancellations(transaction, scope, [
        orderReference,
      ]))
        unpaidCancellations.add(entry.orderBatchReference);
      // WP-2423 Q7 slice 2: rounds staff entered for the table, paid on the Store's card machine.
      const staffRounds = new Set(
        (
          await createPostgresStaffDiningRoundEntryStore({
            ...scope,
            authorize: async () => stillAuthorized(),
          }).listByOrders(transaction, [orderReference])
        ).keys(),
      );
      const cardMachinePayments = await createPostgresCardMachinePaymentStore({
        scope,
        authorize: async (_tx, target) =>
          target.orderReference === orderReference && (await stillAuthorized()),
      }).listByOrder(transaction, orderReference);
      for (const entry of cardMachinePayments)
        paymentOutcomes.set(entry.payment.orderBatchReference, "Succeeded");
      const paymentStarted = new Set(
        await listStoreOrderBatchesWithOnlinePayment(transaction, scope, [orderReference]),
      );
      for (const entry of cardMachinePayments)
        paymentStarted.add(entry.payment.orderBatchReference);
      if (!(await stillAuthorized())) return denied();
      const staffCancellations = new Map<
        string,
        { reason: DiningStoreCancellationReason; refundedMinor: bigint; pendingMinor: bigint }
      >();
      for (const record of await createPostgresStaffOrderCancellationReader(scope).listByOrders(
        transaction,
        [orderReference],
      )) {
        const position = await readStaffCancellationRefundPosition(
          transaction,
          scope,
          record,
          stillAuthorized,
        );
        staffCancellations.set(String(record.orderBatchReference), {
          reason: customerCancellationReasons[record.reasonCode],
          refundedMinor: position.confirmedMinor,
          pendingMinor: position.pendingMinor,
        });
      }
      const itemCancellations = [];
      for (const record of await createPostgresStaffItemCancellationReader(scope).listByOrders(
        transaction,
        [orderReference],
      ))
        itemCancellations.push({
          orderItemReferences: record.orderItemReferences.map(String),
          refunded:
            options.itemRefundScope !== undefined &&
            (await readItemCancellationRefundStatus(
              transaction,
              { ...scope, ...options.itemRefundScope },
              record,
              stillAuthorized,
            )) === "Refunded",
          refundAmount: {
            amountMinor: record.refundAmountMinor,
            currencyCode: record.currencyCode,
          },
        });
      // DEC-DINE-IN-PAY-LATER: dishes taken off the bill before the table paid (nothing charged).
      if (paymentTiming === "PayLater")
        for (const record of await createPostgresPayLaterItemCancellationStore({
          ...scope,
          authorize: async (_tx, value) =>
            value.orderReference === orderReference && (await stillAuthorized()),
        }).listByOrders(transaction, [orderReference]))
          itemCancellations.push({
            orderItemReferences: [...record.orderItemReferences],
            refunded: false,
            refundAmount: { amountMinor: 0n, currencyCode: "CAD" },
            notCharged: true as const,
          });
      // WP-2423 Q26: items the kitchen is remaking for this table's order.
      const remakes = new Set(
        (await listOpenKitchenReworkItems(transaction, scope, [orderReference])).map(
          (entry) => entry.orderItemReference,
        ),
      );
      // WP-2423 D5: each item's frozen price before tax (Ordering's own order items), only for the
      // items this view shows and only when each one's total is the total shown. If they can't be
      // read, the table keeps the totals it has.
      let itemPrices:
        | Map<
            string,
            {
              subtotal: { amountMinor: bigint; currencyCode: string };
              tax: { amountMinor: bigint; currencyCode: string };
            }
          >
        | undefined;
      // Owner 2026-10-23: item names in the guest's chosen language, by Order item.
      let chosenNames: Map<string, string> | undefined;
      // WP-2423 item 8 ③ (decision 13): what "Order again" adds, by Order item.
      let orderAgain: Map<string, CustomerDiningOrderAgain> | undefined;
      if (await stillAuthorized()) {
        const shown = new Map(
          status.order.batches.flatMap((batch) =>
            batch.items.map((item) => [String(item.orderItemReference), item] as const),
          ),
        );
        try {
          await transaction.query("SAVEPOINT customer_dining_item_prices", []);
          const found = await listOrderItemPrices(
            transaction,
            scope,
            orderReference,
            displayLocale === undefined ? undefined : [displayLocale, String(guest.locale)],
          );
          await transaction.query("RELEASE SAVEPOINT customer_dining_item_prices", []);
          orderAgain = new Map(
            found.map((price) => [
              price.orderItemReference,
              Object.freeze({
                sellableReference: price.sellableReference,
                optionSelections: price.optionSelections,
              }),
            ]),
          );
          if (displayLocale !== undefined)
            chosenNames = new Map(
              found.map((price) => [price.orderItemReference, price.displayName] as const),
            );
          const matched = found.filter((price) => shown.has(price.orderItemReference));
          if (
            matched.length === shown.size &&
            matched.every(
              (price) =>
                shown.get(price.orderItemReference)?.lineTotal.amountMinor ===
                  price.total.amountMinor &&
                shown.get(price.orderItemReference)?.lineTotal.currencyCode ===
                  price.total.currencyCode,
            )
          )
            itemPrices = new Map(
              matched.map((price) => [
                price.orderItemReference,
                { subtotal: price.subtotal, tax: price.tax },
              ]),
            );
        } catch {
          await transaction.query("ROLLBACK TO SAVEPOINT customer_dining_item_prices", []);
          await transaction.query("RELEASE SAVEPOINT customer_dining_item_prices", []);
        }
      }
      // Refund positions per captured payment, as the receipt reads them (Payment owner sources).
      const refunds = { confirmedMinor: 0n, pendingMinor: 0n };
      // A card-machine payment is refunded on the machine and recorded (only confirmed refunds).
      for (const entry of cardMachinePayments)
        for (const refund of entry.refunds) refunds.confirmedMinor += refund.amountMinor;
      for (const projection of payments) {
        if (projection.snapshot.terminalStatus !== "Succeeded") continue;
        const payment = {
          orderReference,
          paymentTransactionReference: String(projection.snapshot.paymentTransactionReference),
          paymentAttemptReference: String(projection.snapshot.paymentAttemptReference),
        };
        const compensation = await createPostgresPaymentCompensationRefundPositionSource({
          scope,
          authorize: async (tx, input) =>
            tx === transaction &&
            input.orderReference === orderReference &&
            (await stillAuthorized()),
        })(transaction, payment);
        refunds.confirmedMinor += compensation.confirmedMinor;
        refunds.pendingMinor += compensation.pendingMinor;
        if (options.itemRefundScope === undefined) continue;
        const ordinary = await createPostgresOrdinaryRefundPositionSource({
          scope: { ...scope, tenantReference: options.itemRefundScope.tenantReference },
          providerAccountReference: options.itemRefundScope.providerAccountReference,
          environment: options.itemRefundScope.environment,
          authorize: async (tx, input) =>
            tx === transaction &&
            input.orderReference === orderReference &&
            (await stillAuthorized()),
        })(transaction, {
          ...payment,
          paymentIntentReference: String(projection.snapshot.paymentIntentReference),
          observedAt: now(),
        });
        refunds.confirmedMinor += ordinary.confirmedMinor;
        refunds.pendingMinor += ordinary.pendingMinor;
      }
      const payLaterRounds = new Set(
        paymentTiming !== "PayLater"
          ? []
          : (
              await createPostgresOrderPayLaterConfirmationStore({
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                quoteVersion: 2,
                sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
                authorize: async () => stillAuthorized(),
              }).listByOrders({ transaction, orderReferences: [orderReference] })
            ).map((entry) => String(entry.orderBatchReference)),
      );
      // DEC-DINE-IN-PAY-LATER: the table's one payment at the end (card machine or cash), what
      // the guests paid in total (tip and cash rounding included).
      const tableStore =
        paymentTiming !== "PayLater" || options.diningScope === undefined
          ? null
          : createPostgresDiningTableSettlementStore({
              scope: options.diningScope,
              authorize: async (_tx, value) =>
                value.orderReference === orderReference && (await stillAuthorized()),
            });
      const tableSettlements =
        tableStore === null ? [] : await tableStore.listByOrders(transaction, [orderReference]);
      // WP-2423 item 8 ④: a split bill's rounds are paid once every part is (each part is a
      // payment with its own tip and cash rounding, added up below).
      const [splitPlan] =
        tableStore !== null && tableSettlements.some((settlement) => settlement.part !== null)
          ? await tableStore.listSplitPlans(transaction, [orderReference])
          : [];
      const splitPaid =
        splitPlan !== undefined &&
        splitPlan.mode !== "Whole" &&
        splitPlan.parts.every((part) =>
          tableSettlements.some((settlement) => settlement.part?.partNumber === part.partNumber),
        );
      const settledRounds = new Set(
        tableSettlements
          .filter((settlement) => settlement.part === null || splitPaid)
          .flatMap((settlement) => settlement.lines.map((line) => line.orderBatchReference)),
      );
      return {
        diningSessionReference,
        tableLabel,
        checkedAt: now(),
        ...timing,
        order: {
          orderNumber: status.order.orderNumber,
          batches: status.order.batches.map((batch) => ({
            orderBatchReference: String(batch.orderBatchReference),
            submittedAt: String(batch.submittedAt),
            items: batch.items.map((item) => ({
              orderItemReference: String(item.orderItemReference),
              displayName: chosenNames?.get(String(item.orderItemReference)) ?? item.displayName,
              quantity: item.quantity,
              lineTotal: item.lineTotal,
            })),
          })),
          authorship,
          delivery: new Map(
            delivery.items.map((item) => [
              item.orderItemReference,
              { phase: item.phase, deliveredQuantity: item.deliveredQuantity },
            ]),
          ),
          paymentOutcomes,
          paymentDeadlines,
          paymentStarted,
          payLaterRounds,
          settledRounds,
          tableSettlement:
            tableSettlements.length === 0
              ? null
              : {
                  tipMinor: tableSettlements.reduce((sum, entry) => sum + entry.tipMinor, 0n),
                  roundingMinor: tableSettlements.reduce(
                    (sum, entry) => sum + entry.roundingMinor,
                    0n,
                  ),
                },
          unpaidCancellations,
          staffCancellations,
          itemCancellations,
          remakes,
          ...(orderAgain === undefined ? {} : { orderAgain }),
          ...(itemPrices === undefined ? {} : { itemPrices }),
          payments: [
            ...payments.map((projection) => ({
              status: projection.snapshot.terminalStatus,
              amount: projection.snapshot.amount,
            })),
            ...tableSettlements.map((settlement) => ({
              status: "Succeeded" as const,
              amount: { amountMinor: settlement.totalMinor, currencyCode: "CAD" },
            })),
            ...cardMachinePayments.map((entry) => ({
              status: "Succeeded" as const,
              amount: {
                amountMinor: entry.payment.preparation.total.amountMinor,
                currencyCode: "CAD",
              },
            })),
          ],
          staffRounds,
          refunds,
        },
      };
    },
  };
}

/** WP-2423 Q6: customer-safe reason categories; staff identity and internal codes stay private. */
const customerCancellationReasons = Object.freeze({
  CUSTOMER_REQUEST: "CustomerRequest",
  SOLD_OUT: "SoldOut",
  STORE_ERROR: "StoreError",
  DUPLICATE_ORDER: "DuplicateOrder",
  // DEC-TABLE-CLOSE-GUESTS-LEFT: the table was closed after the party left.
  GUEST_LEFT: "GuestLeft",
} as const);

/**
 * Current Guest credentials are resolved inside the same transaction as every owner read, and are
 * re-checked between reads. The guest never names a table, session or Order: the view is always
 * the guest's own current dining session.
 */
export function createCustomerDiningSessionRead(
  options: Options,
  dependencies?: (credentials: {
    sessionCredential: string;
    csrfCredential: string;
  }) => CustomerDiningSessionDependencies,
) {
  return Object.freeze({
    /** `displayLocale` (Owner 2026-10-23): the guest's chosen language for item names. */
    async read(value: unknown, displayLocale?: string): Promise<CustomerDiningSessionView> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      try {
        const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential"]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
      } catch {
        throw new OrderStatusProjectionError("ORDER_STATUS_INPUT_INVALID");
      }
      const deps = (dependencies ?? ((c) => postgresDependencies(options, c)))(credentials);
      // v15 2026-10-16: this read authorizes (reading the Dining table row FOR SHARE) before it
      // knows the order, so it cannot take the Order fence first; a deadlock or lock wait with a
      // payment outcome or acceptance is rerun instead of answering 503.
      const transactions = {
        run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) =>
          retryTransactionConflict(() => options.transactions.run(work)),
      };
      try {
        return await transactions.run(async (transaction) => {
          let previous: string | undefined;
          const now = () => {
            const at = String(parseCanonicalInstant(options.now()));
            if (previous !== undefined && at < previous) return denied();
            previous = at;
            return at;
          };
          const identity = deps.identity(transaction, now);
          const authorize = async () => {
            const guest = await identity.authorize({ observedAt: now() });
            return { guest, participant: assertDiningParticipant(guest, options.scope) };
          };
          const first = await authorize();
          const fingerprint = JSON.stringify(first.guest);
          const stillAuthorized = async () => {
            try {
              return JSON.stringify((await authorize()).guest) === fingerprint;
            } catch {
              return false;
            }
          };
          const facts = await deps.facts(transaction, {
            ...first.participant,
            guest: first.guest,
            stillAuthorized,
            now,
            ...(displayLocale === undefined ? {} : { displayLocale }),
          });
          if (facts.diningSessionReference !== first.participant.diningSessionReference)
            return denied();
          const view = composeCustomerDiningSession(facts);
          if (!(await stillAuthorized())) return denied();
          return view;
        });
      } catch (error) {
        if (error instanceof OrderStatusProjectionError) throw error;
        if (error instanceof DiningOrderStillProcessingError) throw error;
        if (error instanceof GuestSessionError)
          throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
        throw withFailureCause(
          new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"),
          error,
        );
      }
    },
  });
}
