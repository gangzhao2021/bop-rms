import type { ComponentType, ReactNode } from "react";
import type { CartState, CartStateController } from "./cart/cart-state.js";
import type { CartView } from "./cart/types.js";
import type { CheckoutController } from "./checkout/checkout-client.js";
import type { CheckoutQuote, CheckoutState } from "./checkout/types.js";
import type { CustomerDeliveryTrackingClient } from "./delivery-status/delivery-status-client.js";
import type {
  CustomerEntryClient,
  CustomerEntryEstablishedContext,
  CustomerEntryScreenState,
} from "./entry/types.js";
import type {
  CustomerMenuClient,
  MenuJourneyContext,
  MenuLoadResult,
  MenuView,
} from "./menu/types.js";
import type { OrderStatusController } from "./order-status/order-status-controller.js";
import type { OrderStatusState } from "./order-status/types.js";
import type { ReceiptController } from "./receipt/receipt-controller.js";
import type { ReceiptState } from "./receipt/types.js";

const id = (value: number) => `018f9900-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const fixedNow = Date.parse("2026-09-02T17:00:00.000Z");

export const customerDemoOrderReference = id(20);
export const customerDemoSellableReference = id(3);

const entryContext: CustomerEntryEstablishedContext = Object.freeze({
  brandDisplayName: "Synthetic Kitchen",
  storeDisplayName: "Training Store",
  publicStoreReference: id(1),
  publicTableReference: null,
  channel: "Pickup",
  operatingState: "Open",
  availableServiceModes: Object.freeze(["Pickup"] as const),
  locale: "en-CA",
  contextExpiresAt: "2026-09-02T17:30:00.000Z",
  csrfToken: "d".repeat(43),
});

const menuContext: MenuJourneyContext = Object.freeze({
  publicStoreReference: entryContext.publicStoreReference,
  channel: entryContext.channel,
  locale: entryContext.locale,
  brandDisplayName: entryContext.brandDisplayName,
  storeDisplayName: entryContext.storeDisplayName,
});

const menu: MenuView = Object.freeze({
  name: "Synthetic all-day menu",
  locale: "en-CA",
  effectiveFrom: "2026-09-02T12:00:00.000Z",
  effectiveUntil: null,
  sections: Object.freeze([
    Object.freeze({
      sectionReference: id(2),
      name: "Training favourites",
      sellables: Object.freeze([
        Object.freeze({
          sellableReference: customerDemoSellableReference,
          name: "Synthetic mushroom rice bowl",
          presentationRole: "Featured",
          pinned: true,
          allergens: Object.freeze([
            Object.freeze({ name: "Soy", classification: "Contains" }),
            Object.freeze({ name: "Sesame", classification: "CrossContactPossible" }),
          ]),
          optionRules: Object.freeze([]),
        }),
        Object.freeze({
          sellableReference: id(4),
          name: "Synthetic iced tea",
          presentationRole: "Standard",
          pinned: false,
          allergens: Object.freeze([]),
          optionRules: Object.freeze([]),
        }),
      ]),
    }),
  ]),
});

const money = (amountMinor: string) => Object.freeze({ amountMinor, currency: "CAD" });
const cart: CartView = Object.freeze({
  schemaVersion: 1,
  cart: Object.freeze({
    cartReference: id(5),
    version: 4,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: Object.freeze({ brandName: "Synthetic Kitchen", storeName: "Training Store" }),
    lifecycle: Object.freeze({
      status: "Active",
      idleExpiresAt: "2026-09-02T17:20:00.000Z",
      absoluteExpiresAt: "2026-09-02T18:00:00.000Z",
    }),
    items: Object.freeze([
      Object.freeze({
        cartItemReference: id(6),
        sellableReference: customerDemoSellableReference,
        displayName: "Synthetic mushroom rice bowl",
        quantity: 1,
        configuration: Object.freeze([]),
        customerNote: null,
        lineEstimate: Object.freeze({ status: "Available", total: money("1299") }),
        warnings: Object.freeze(["TRAINING_DATA_ONLY"]),
      }),
    ]),
    quote: Object.freeze({
      quoteReference: id(7),
      quoteVersion: 2,
      cartVersion: 4,
      subtotal: money("1299"),
      discount: money("0"),
      tax: money("169"),
      fee: money("0"),
      total: money("1468"),
      expiresAt: "2026-09-02T17:10:00.000Z",
      warnings: Object.freeze(["TRAINING_DATA_ONLY"]),
      blockingReasons: Object.freeze([]),
    }),
    warnings: Object.freeze([]),
  }),
});

const quote: CheckoutQuote = Object.freeze({
  quoteReference: id(7),
  quoteVersion: 2,
  cartVersion: 4,
  subtotal: money("1299"),
  discount: money("0"),
  tax: money("169"),
  fee: money("0"),
  total: money("1468"),
  expiresAt: "2026-09-02T17:10:00.000Z",
  warnings: Object.freeze(["TRAINING_DATA_ONLY"]),
  blockingReasons: Object.freeze([]),
  priceChange: null,
});

const cartState: CartState = Object.freeze({ status: "offline-readonly", cart });
const checkoutState: CheckoutState = Object.freeze({ status: "ready", cart, quote });

function staticCartController(): CartStateController {
  return Object.freeze({
    getState: () => cartState,
    load: async () => undefined,
    removeItem: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
    updateItem: async () => undefined,
  });
}

function staticCheckoutController(): CheckoutController {
  return Object.freeze({
    getState: () => checkoutState,
    load: async () => undefined,
    quote: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
  });
}

const orderState: OrderStatusState = Object.freeze({
  status: "ready",
  realtime: "unavailable",
  refreshing: false,
  view: Object.freeze({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: id(21),
    projectedAt: "2026-09-02T16:55:00.000Z",
    freshnessStatus: "Fresh",
    order: Object.freeze({
      orderReference: customerDemoOrderReference,
      orderNumber: "1001",
      orderType: "Pickup",
      canonicalPhase: "Fulfilled",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Completed",
      fulfilledAt: "2026-09-02T16:50:00.000Z",
      eta: null,
      submittedAt: "2026-09-02T16:30:00.000Z",
      batches: Object.freeze([
        Object.freeze({
          orderBatchReference: id(22),
          submittedAt: "2026-09-02T16:30:00.000Z",
          items: Object.freeze([
            Object.freeze({
              orderItemReference: id(23),
              displayName: "Synthetic mushroom rice bowl",
              quantity: 1,
              lineTotal: Object.freeze({ amountMinor: 1468n, currencyCode: "CAD" }),
            }),
          ]),
        }),
      ]),
    }),
  }),
});

function staticOrderStatusController(): OrderStatusController {
  return Object.freeze({
    getState: () => orderState,
    load: async () => undefined,
    refresh: async () => undefined,
    setOnline: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
  });
}

const receiptState: ReceiptState = Object.freeze({
  status: "ready",
  view: Object.freeze({
    orderReference: customerDemoOrderReference,
    freshnessStatus: "Fresh",
    deliveryStatus: "Unavailable",
    supportEligible: false,
    cancellationEligible: false,
    records: Object.freeze([
      Object.freeze({
        recordReference: id(30),
        version: 1,
        kind: "Original",
        recordedAt: "2026-09-02T16:51:00.000Z",
        reasonCode: null,
        snapshot: Object.freeze({
          receiptReference: id(31),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Training Store",
          orderNumber: "1001",
          issuedAt: "2026-09-02T16:51:00.000Z",
          locale: "en-CA",
          lines: Object.freeze([
            Object.freeze({
              lineReference: id(32),
              displayName: "Synthetic mushroom rice bowl",
              quantity: 1,
              lineTotal: Object.freeze({ amountMinor: 1468n, currencyCode: "CAD" }),
            }),
          ]),
          subtotal: Object.freeze({ amountMinor: 1299n, currencyCode: "CAD" }),
          tax: Object.freeze({ amountMinor: 169n, currencyCode: "CAD" }),
          tip: Object.freeze({ amountMinor: 0n, currencyCode: "CAD" }),
          total: Object.freeze({ amountMinor: 1468n, currencyCode: "CAD" }),
          paymentStatus: "Paid",
          refundedTotal: Object.freeze({ amountMinor: 0n, currencyCode: "CAD" }),
        }),
      }),
    ]),
  }),
});

function staticReceiptController(): ReceiptController {
  return Object.freeze({
    getState: () => receiptState,
    load: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
  });
}

export function LocalCustomerDemoNotice() {
  return (
    <aside className="customer-demo-notice" role="status" aria-label="Local synthetic preview">
      <strong>Local synthetic preview</strong>
      <span>Read-only training data. No API, payment, order or customer fact is created.</span>
      <nav aria-label="Preview routes">
        <a href="/">Entry</a>
        <a href="/menu">Menu</a>
        <a href="/cart">Cart</a>
        <a href="/checkout">Checkout</a>
        <a href={`/orders/${customerDemoOrderReference}`}>Order</a>
        <a href={`/orders/${customerDemoOrderReference}/delivery`}>Delivery</a>
        <a href={`/orders/${customerDemoOrderReference}/receipt`}>Receipt</a>
      </nav>
    </aside>
  );
}

export interface CustomerDemoDependencies {
  readonly Notice: ComponentType;
  readonly orderReference: string;
  readonly entryClient: CustomerEntryClient;
  readonly menuContext: MenuJourneyContext;
  readonly menuClient: CustomerMenuClient;
  readonly menuReadOnlyNotice: ReactNode;
  readonly cartController: CartStateController;
  readonly checkoutController: CheckoutController;
  readonly orderStatusController: OrderStatusController;
  readonly deliveryClient: CustomerDeliveryTrackingClient;
  readonly receiptController: ReceiptController;
  readonly now: () => number;
}

export const enabledCustomerDemo: CustomerDemoDependencies = Object.freeze({
  Notice: LocalCustomerDemoNotice,
  orderReference: customerDemoOrderReference,
  entryClient: Object.freeze({
    hasEntry: true,
    start: async (): Promise<CustomerEntryScreenState> => ({
      kind: "Established",
      context: entryContext,
    }),
    retry: async (): Promise<CustomerEntryScreenState> => ({
      kind: "Established",
      context: entryContext,
    }),
  }),
  menuContext,
  menuReadOnlyNotice: <p>Read-only training data. Adding or configuring an item is unavailable.</p>,
  menuClient: Object.freeze({
    async load(
      input?: Readonly<{ searchTerm?: string; sectionReference?: string }>,
    ): Promise<MenuLoadResult> {
      const term = input?.searchTerm?.toLocaleLowerCase("en-CA");
      if (!term) return { kind: "Found", menu };
      const sections = menu.sections
        .map((section) => ({
          ...section,
          sellables: section.sellables.filter((item) =>
            item.name.toLocaleLowerCase("en-CA").includes(term),
          ),
        }))
        .filter((section) => section.sellables.length > 0);
      return sections.length === 0
        ? { kind: "NotFound" }
        : { kind: "Found", menu: { ...menu, sections } };
    },
  }),
  cartController: staticCartController(),
  checkoutController: staticCheckoutController(),
  orderStatusController: staticOrderStatusController(),
  deliveryClient: Object.freeze({
    async load() {
      return {
        projectionName: "customer_delivery_tracking_v1",
        projectionVersion: 1,
        screenId: "CUST-DELIVERY-STATUS",
        publicOrderReference: customerDemoOrderReference,
        asOfUtc: "2026-09-02T16:55:00.000Z",
        freshness: "Current",
        partial: false,
        status: "Delivered",
        eta: null,
        handoffSummary: "Complete",
        proofSummary: "Confirmed",
        supportPath: "/support?from=delivery",
        instructionUpdateAllowed: false,
        instructionCutoffUtc: null,
      };
    },
  }),
  receiptController: staticReceiptController(),
  now: () => fixedNow,
});
