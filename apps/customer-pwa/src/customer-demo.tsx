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
  MenuPhoto,
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

/*
 * Synthetic training photo (a generated brown radial gradient, not a real product photo). Kept in
 * this development-only module as object URLs so no demo image is copied into the production build.
 */
const syntheticPhotoJpeg =
  "/9j/2wBDAA4KCw0LCQ4NDA0QDw4RFiQXFhQUFiwgIRokNC43NjMuMjI6QVNGOj1OPjIySGJJTlZYXV5dOEVmbWVa" +
  "bFNbXVn/2wBDAQ8QEBYTFioXFypZOzI7WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZ" +
  "WVlZWVlZWVn/wAARCADwAUADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAgMBAAb/xAAYEAEBAQEBAAAA" +
  "AAAAAAAAAAABABICEf/EABYBAQEBAAAAAAAAAAAAAAAAAAABAv/EABYRAQEBAAAAAAAAAAAAAAAAAAARAf/aAAwD" +
  "AQACEQMRAD8A8ZdddZaddddB1110HXXWhBl3kgkFKsAJZkEjmlWBm3yebfJVgeW5n5bmlInm3NTN2aVYnm7NTN2Z" +
  "SJ5uzUzdmUiebM1c3ZlIlmzyrmzytSJeWZq+WZrSJPMUrPMUlSJeXVEilakG61LKo6666DrrroOuuug6666Drrrv" +
  "IOtC0JBSrBCQSCQUqwQkEgkFKsAJBIJBStQM2+TzbmlIHluZ+W5pVgZuzUzbmlWJ5uzUzdmUiebs1M3ZlIlm7NXN" +
  "mZSJZs8q5s8rUiXlmaubM1qRJIpWSKVpEkilZIpWsxFIpWSKVqRJLKiRS1Ug3XeXRHXXXQdddaEGBMLgmFKsYEgt" +
  "CQWa1GBIJBIKVqCEgkEgs1YISCQWhSrBC0JhI5pVgeW5n5b5SrE825qZuzSrE825qZuzKRPNmaubsykSzZmrm7Mp" +
  "Es2eVfLPK1IiliVnmKVqRJIpVSxK1IikUrJFK1IikUrJFLVSIpFKqRStZiSQSskEtVkLrUsqjQkFwTCmq4JhYEws" +
  "7rWOCQWhILNajgkFoSCzWowJBIJBZqwQkEgkFK1BCRzILQpVghb5M5tzSrAzbmebc0E825qZuzBPNmaubswSzZmr" +
  "mzMEvLEq5sea0iTzFKqWJWpEUilZIpWpEUilZIpWsxFIpVSKWqkRSKVUilrNZiSQSqkEtZrOpJFKqQS1jJBMLAmF" +
  "nWsaEwsCYWdaxwTC4JhZ1rHBILgmFndazHBILQkFmtRgSCQSCiiEgkczOaAHMjmZzI5gBzbmZzbmCebc1M25glmz" +
  "NbNmYJZseaubHmCLzF5rvMXmCCRSu8weYIpFKyRSoikUqpFK1IikUqpBLWazEkglZIJaxnUkglVIJaxnUkglVIJa" +
  "xnSCYRCoU1caEwsCYWdaxoTCwJhY1rGhILgmFnW8cEwuCYWVcEwuCYQcEgtCYQE5kczOZBEA5lmZzacwDN2ambcw" +
  "SzdmrmzMEsxeazzY8wQeYvNdIvMEEilZIJFRSCVkgkEUglZIJBFIpVSCWsTUkglVIJaxjUkglVIJbxnUkglVptrG" +
  "dImRJlNXCJhEmWNawgmWEyzreEEwiTCzrWEEws5J8lAgmFgTCDQmFwTCI4JnNoTCIJzI5kEzmAZuzUObcwSzdmrm" +
  "x5gi8xea7zBIIvMErpBIqCQSskEgikEqpBIqKQSr0Q6IJJBKiQa4akwSqwbWM6kkGowbeMamwajBtYzrSZAmU1cM" +
  "mQKhZ1rDJkCZY1rDJkSZZaPmpzDmoQMnyR5qcxCCpyQKnMCCoESpyRGhMLuSYQYc25mEjmIlmx5rPMUgikErJDoi" +
  "opTSt0U2CXRTSr1TYqXRBq9U+oJdU+qrT6ipMGowYJsGbBtYzqbBqNNt4zoMGbBtYzriZAmTTFOZlMqFnWsMqFMm" +
  "WNaxTmZAmWWlOahT5qEFOanNPmpzEUKhSKnMFSfNMqcsRTmoU+WYwV5qFEZHURRp9XPUVgLT6msOmKn1Bn002AdU" +
  "2fVNih1T6qdU+oJtPqo0+oqbDqbBgDTZsG1jOgw6m023jOgwZsG1jOuJlMmV1MUJlMmWNbxUmUyZZ1rFCZTJjZaV" +
  "5qc0uWfLQWJ8tIZjEWGpy0RmMFhqDRGYxFhmNAZnUFjq3VE6t1BXVj1T1Y9QNYLY9QWDVprasFgzpprasFij0wbV" +
  "gsB6p9S6YdMUGDJYNQWDJg2sZ0GDJg2sZ0WDJg28Y1hMpDUJpihMaYzGzrWKDMpjMbOtYqMxpDMbGtYqMxpDMaKs" +
  "MxojMYLDMaIzGIsMzqidSGCx1I6onVp1EX1dqjq3UFdXapas1BR6i9QerHqBPUFsWL1FcsFuWCwcsFuWCxWLBbVg" +
  "sGLBbVgtcTRYLJYLbxnRWDJYLaxnRYMmmtrGdYMxpDMa6mKjMaQzGzrWKjMaQzGzrWKjIaQzGzrWKjMaQyGy0sMx" +
  "ojIaC4yGgdTOoLHUjqidSOoLHUtUDq3URfV2qOrdQV1dqlqzUFdReqerHqBvUXqL1F6iksVi9QeoEsFsWKwcsFuW" +
  "K1GLFblgtrGdcsFtWC2sZ1iwW1YLaxnWLBbVgtrGdEZjSGY2tZxUZjRGY2daxUZjSGQ2dxpYZDSGQ2Y1VhkNIZDZ" +
  "jVVGQ0hkNItVGQ0htGyqx1I6onVuoLnVuqGrdQW1bqjq7UFtWapau1BXVj1S1ZqCj1F6hqx6gSxWK2LUasVsWK1i" +
  "VqxWxYrWJXLFbFitqM1ywW5YrazGXLBblgtrGdcsFtWC2sZ0RkMLRtIqMxojMbMWqjIaQyGzuNVYZDSGQ2Y1VRkN" +
  "IZDSLVRkNIbRsxqrDI6ojI6pFqo2+0vbfaRarq3VLV2qQqurdUtXakWq6s1T1dqQqmrNU9XakSn7YsPbPawpvUVi" +
  "9RWsSksViti1iVqxWxYrajNasVsWK1iVyxWxYrajNasFuWC2sxmuWK3LZaR1110RwzGF3sVUZDSGQ2YtVGQ0hkNI" +
  "tVGQ0hkNmNVUZDRGQ0i1UbRpat1SLVvbdUfbdUi1XVuqWrdSFU1bqlq7VItV1Zqnq7UhVNWahqzVYlU1Z7T1Z7IU" +
  "1sWGrNViU1isVitYlJYrYsVrErVitixW1Ga1YrYsVrErVgt3t1pHXXXRH//Z";
const syntheticPhotoWebp =
  "UklGRi4DAABXRUJQVlA4ICIDAABQIgCdASpAAfAAPsFepVCnpKMioCyY8BgJaW7hHFCo9+W02r0eWpiFyyPf+tN3" +
  "/P7/9wArrUhJRwaBl1btVyXsrHxu000Kstr7tmBuV5hmYRw9ZtcjPVc6vusHvkL6vzqU5UXu7ey420vOWS51Vmpp" +
  "AHBim3ddMvS1feFyMP7uLeMv9dAQSHApZqGhTD8SWYA4Hy/e7/GHUtNTFOVKdQ4H0hxJUOjD1oIsxxv5cLFzZeoA" +
  "aqtdrDzNKVg2Ua09qV2BQHdfIaHRaXjrSF3PMIZlVGkrbXBtQ0KWmzSNN/ap1CKWoaFLTSDWo4P5NIA3xjJolIAu" +
  "91fDSuoUaUtxaKIlNYcDkI+HtdKhbSFg+8M1ndUuL1n93GyECQIAAP7b2scqRFAeZYujGQgg4SDbsNiErVvXwpFA" +
  "rmqtC8vRFyoPadZVvIF7alFhRasYxJft7TaJp3qxTL1eN5U9luJxDFVeIfDZDUwPZQrlujtM5n07ACbmOESLfp2a" +
  "ZDtGJCpuc3Eh7QLfBR6NnzdEMvqiX9AlR0qxjiw6qDywyfVHvbfODBJj+04olyO28ljI7qtbWJKT4R76ipkmwXIU" +
  "5e/E++S3GoUfe0s5xXvDyJ9r0Ro7ZH5ZYavjUT8kaPw/bOaQypOGVUvzlNic8Jn4GykrnbGF5I8reZLARObw7e5R" +
  "NUB0be3SsOSDqhgl/7xzhJmc3cazntlMR0sogbiEt2Yo6NlKmTBRbT98pJQAPDQrcU8WvrixPrxM9F7UlJ7d4sgO" +
  "bdMcc3XkSauLyZNyu23XUiewEAAqg8df0LsVfsoonKaIw1N96fBfLEocjaACY6xy6T6lYlw3HVHw7kbypca924SU" +
  "PJcsqlYHGGhQ7BLRi54CF2A9I0D+bHx4wqa7A/fUCqnpbLkIs2M+U55BcDahYfGcUhuUUTa297c11RAhnVAm9gP4" +
  "gkdAlHk8fCGWqHTmJ2O5Prl/3s7qlwRJDMf6Cmc/Kv0AhyIHlGDtzjz/R1WG8IwCsTmp59/6KxKRS7SmTb/8bPCO" +
  "HLHF3njaWOiGE7NwI87dExJ/2BlXSDJQ56sXDgAA";

function syntheticObjectUrl(base64: string, type: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function syntheticPhoto(altText: string): MenuPhoto {
  const jpeg = syntheticObjectUrl(syntheticPhotoJpeg, "image/jpeg");
  const webp = syntheticObjectUrl(syntheticPhotoWebp, "image/webp");
  return Object.freeze({
    altText,
    width: 320,
    height: 240,
    renditions: Object.freeze(
      ([320, 640, 1280] as const).flatMap((width) => [
        Object.freeze({
          url: jpeg,
          contentType: "image/jpeg" as const,
          width,
          height: (width * 3) / 4,
        }),
        Object.freeze({
          url: webp,
          contentType: "image/webp" as const,
          width,
          height: (width * 3) / 4,
        }),
      ]),
    ),
  });
}

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
          description:
            "Steamed rice with roasted mushrooms, pickled carrot and a soy-sesame glaze. A synthetic training item for staff practice.",
          photo: syntheticPhoto(
            "Synthetic training photo: a brown bowl shape on a dark background",
          ),
          presentationRole: "Featured",
          pinned: true,
          availability: "Available",
          price: null,
          allergens: Object.freeze([
            Object.freeze({ name: "Soy", classification: "Contains" }),
            Object.freeze({ name: "Sesame", classification: "CrossContactPossible" }),
          ]),
          optionRules: Object.freeze([]),
        }),
        Object.freeze({
          sellableReference: id(4),
          name: "Synthetic iced tea",
          description: null,
          photo: null,
          presentationRole: "Standard",
          pinned: false,
          availability: "Available",
          price: null,
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
      const sections = menu.sections
        .filter(
          (section) =>
            input?.sectionReference === undefined ||
            section.sectionReference === input.sectionReference,
        )
        .map((section) => ({
          ...section,
          // Mirrors the published menu search: name matches first, then description matches.
          sellables: term
            ? [
                ...section.sellables.filter((item) =>
                  item.name.toLocaleLowerCase("en-CA").includes(term),
                ),
                ...section.sellables.filter(
                  (item) =>
                    !item.name.toLocaleLowerCase("en-CA").includes(term) &&
                    (item.description?.toLocaleLowerCase("en-CA").includes(term) ?? false),
                ),
              ]
            : section.sellables,
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
