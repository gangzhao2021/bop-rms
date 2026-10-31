import { readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  type CheckoutSession,
  type OrderPaymentPreparationEvidence,
  type PickupCartItemOptions,
} from "@rms/ordering";
import type { Money } from "@rms/pricing";
import type { CustomerCartBindingPort } from "./customer-cart-binding.js";
import type { CustomerCartPort } from "./customer-cart.js";
import type { CustomerEntryPort } from "./customer-entry.js";
import type { CustomerEntryOperatingReader } from "./customer-entry-composition.js";
import type { CustomerCheckoutDetailsPort } from "./customer-checkout-details.js";
import type { CustomerQuotePort } from "./customer-quote.js";
import { prepareCustomerSessionPayment } from "./customer-session-payment-intent.js";
import type { CounterGuestCredentials, CounterGuestPipeline } from "./merchant-counter-order.js";

/**
 * WP-2423 Q7: the checkout details of a counter order. Every pickup Order carries a checkout
 * details record; a walk-up guest gives no contact (staff call the order number) and keeps the
 * card machine slip as the receipt.
 */
export function counterCheckoutDetailsCommand(input: {
  readonly operationReference: string;
  readonly detailsReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
}) {
  return Object.freeze({
    operationReference: input.operationReference,
    detailsReference: input.detailsReference,
    expectedVersion: 0,
    cartReference: input.cartReference,
    cartVersion: input.cartVersion,
    quoteReference: input.quoteReference,
    quoteVersion: 2 as const,
    pickupContact: null,
    receipt: Object.freeze({ choice: "InSession" as const, email: null }),
    policies: Object.freeze([]) as readonly never[],
  });
}

/**
 * WP-2423 Q7: the counter's walk-up guest enters with the Store's pickup QR even while online
 * ordering is paused (or, for a paper order entered after an outage, after closing). Whether the
 * counter takes the order is decided by the staff command ({@link counterTakesOrder}) before the
 * guest is opened and again before payment; this view only keeps the customer entry rule from
 * refusing the counter's guest. Customers' own entry is unchanged.
 */
export function counterEntryOperatingReader(
  reader: CustomerEntryOperatingReader,
  /** WP-2423 Q7 slice 2: a staff-entered table round enters with the table QR (DineIn). */
  mode: "Pickup" | "DineIn" = "Pickup",
): CustomerEntryOperatingReader {
  return Object.freeze({
    async readCurrent(input: Parameters<CustomerEntryOperatingReader["readCurrent"]>[0]) {
      const current = await reader.readCurrent(input);
      if (current === null) return null;
      return Object.freeze({
        ...current,
        state: "Open" as const,
        availableServiceModes: Object.freeze([
          ...new Set([...current.availableServiceModes, mode]),
        ]),
      });
    },
  });
}

type PaymentOptions = Parameters<typeof prepareCustomerSessionPayment>[0];

/**
 * WP-2423 Q7: the counter's walk-up guest goes through exactly the ports the customer app's HTTP
 * handlers call (entry with the Store's pickup QR, Cart binding, items, Quote, checkout session,
 * submission, tip and payment clock). Only the transport differs: credentials stay in this
 * process's memory for one staff request and are never returned or logged.
 */
export function createCounterGuestPipeline(options: {
  /** The Store's current pickup entry QR token (the code printed at the counter). */
  pickupQrToken(): Promise<string>;
  entry: CustomerEntryPort;
  binding: CustomerCartBindingPort;
  /** Current guest session authority (Identity owner), used to name the rotated session. */
  sessions: {
    authorize(input: {
      sessionCredential: string;
      csrfCredential: string;
      observedAt: string;
    }): Promise<{ readonly sessionReference: string }>;
  };
  cart: Pick<CustomerCartPort, "getCurrentCart" | "addItem">;
  quote: CustomerQuotePort;
  /** The customer checkout details owner (the same record the customer app saves). */
  details: Pick<CustomerCheckoutDetailsPort, "save">;
  checkout: {
    create(value: unknown): Promise<unknown>;
    read(value: unknown): Promise<unknown>;
  };
  /** The counter's opening rule on the Store's current status (checked again at payment). */
  takesOrder(input: { readonly recordedAfterOutage: boolean }): Promise<boolean>;
  /** WP-2423: whether a pickup time covers now (to explain a refused order to staff). */
  pickupTimesNow?(): Promise<boolean>;
  payment: (credentials: CounterGuestCredentials) => PaymentOptions;
  /**
   * WP-2423 (v15 run): the stock check the counter Cart's item command makes (the Catalog
   * selection with the Store's stock for a quantity), used to tell staff how many of a short
   * item are left. Its authorization takes the walk-up guest's Cart as context.
   */
  stock?: {
    readonly scope: { readonly brandReference: string; readonly storeReference: string };
    readonly catalog: PickupCartItemOptions["catalog"];
  };
  nextReference(): string;
  now(): string;
}): CounterGuestPipeline {
  const failed = (): never => {
    throw new Error("COUNTER_GUEST_PIPELINE_UNAVAILABLE");
  };
  const steps = createGuestOrderSteps(options);
  const pipeline: CounterGuestPipeline = {
    takesOrder: (input) => options.takesOrder(input),
    ...(options.pickupTimesNow === undefined
      ? {}
      : { pickupTimesNow: options.pickupTimesNow.bind(options) }),
    async open(input) {
      const result = (await options.entry.establish({
        entryRequestReference: options.nextReference(),
        operationReference: options.nextReference(),
        qrToken: await options.pickupQrToken(),
        requestedAt: input.requestedAt,
      })) as {
        status: string;
        channel?: string;
        sessionCredential?: unknown;
        csrfCredential?: unknown;
      };
      if (result.status === "NotAccepting")
        return Object.freeze({ status: "NotAccepting" as const });
      if (
        result.status !== "Established" ||
        result.channel !== "Pickup" ||
        typeof result.sessionCredential !== "string" ||
        typeof result.csrfCredential !== "string"
      )
        return failed();
      return Object.freeze({
        status: "Established" as const,
        credentials: Object.freeze({
          sessionCredential: result.sessionCredential,
          csrfCredential: result.csrfCredential,
        }),
      });
    },
    async bindCart(credentials, input) {
      const prepared = readClosedRecord(
        await options.binding.prepare({
          operationReference: input.operationReference,
          ...credentials,
        }),
        [
          "status",
          "operationReference",
          "sessionCredential",
          "csrfCredential",
          "recoveryProof",
          "expiresAt",
        ],
      );
      if (
        prepared.status !== "Prepared" ||
        typeof prepared.sessionCredential !== "string" ||
        typeof prepared.csrfCredential !== "string" ||
        typeof prepared.recoveryProof !== "string"
      )
        return failed();
      const activated = readClosedRecord(
        await options.binding.activate({
          operationReference: input.operationReference,
          ...credentials,
          candidateSessionCredential: prepared.sessionCredential,
          candidateCsrfCredential: prepared.csrfCredential,
          recoveryProof: prepared.recoveryProof,
        }),
        ["status", "operationReference", "sessionCredential", "csrfCredential", "cookie"],
      );
      if (
        activated.status !== "Activated" ||
        activated.sessionCredential !== prepared.sessionCredential ||
        activated.csrfCredential !== prepared.csrfCredential
      )
        return failed();
      const current = Object.freeze({
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      });
      const guest = await options.sessions.authorize({ ...current, observedAt: options.now() });
      const cart = await options.cart.getCurrentCart({
        guestCredential: current.sessionCredential,
        requestedAt: options.now(),
      });
      if (cart.status !== "Found" || cart.view.cart.orderType !== "Pickup") return failed();
      return Object.freeze({
        credentials: current,
        guestSessionReference: String(guest.sessionReference),
        cartReference: cart.view.cart.cartReference,
        cartVersion: cart.view.cart.version,
      });
    },
    ...steps,
    ...(options.stock === undefined
      ? {}
      : {
          async canSell(credentials, input) {
            const stock = options.stock as NonNullable<typeof options.stock>;
            const guest = await options.sessions.authorize({
              ...credentials,
              observedAt: options.now(),
            });
            const result = await stock.catalog.validateSelection(
              {
                brandReference: stock.scope.brandReference as never,
                storeReference: stock.scope.storeReference as never,
                sourceChannel: "Pos",
                orderType: "Pickup",
                sellableReference: input.sellableReference as never,
                optionSelections: input.optionSelections as never,
                observedAt: input.requestedAt as never,
              },
              Object.freeze({
                diningSessionReference: null,
                cartReference: input.cartReference as never,
                cartVersion: input.cartVersion,
                guestSessionReference: String(guest.sessionReference) as never,
                quantity: input.quantity,
              }),
            );
            return result.status === "Accepted";
          },
        }),
    async preparePayment(credentials, input): Promise<OrderPaymentPreparationEvidence> {
      if (!(await options.takesOrder({ recordedAfterOutage: input.recordedAfterOutage })))
        throw new CheckoutSessionServiceError("STORE_CLOSED");
      const read = { ...credentials, checkoutSessionReference: input.checkoutSessionReference };
      const session: CheckoutSession = parseCheckoutSession(await options.checkout.read(read));
      return prepareCustomerSessionPayment(options.payment(credentials), {
        input: read,
        session,
        selectionReference: input.selectionReference,
        tip: input.tip as Money,
      });
    },
  };
  return Object.freeze(pipeline);
}

/**
 * The customer cart, quote, checkout details and checkout steps a staff-entered order takes on
 * behalf of its guest (WP-2423 Q7): the same owner ports the customer app's HTTP handlers call.
 */
export function createGuestOrderSteps(options: {
  cart: Pick<CustomerCartPort, "addItem">;
  quote: CustomerQuotePort;
  details: Pick<CustomerCheckoutDetailsPort, "save">;
  checkout: { create(value: unknown): Promise<unknown> };
}): Pick<CounterGuestPipeline, "addItem" | "quote" | "saveDetails" | "startCheckout"> {
  const failed = (): never => {
    throw new Error("COUNTER_GUEST_PIPELINE_UNAVAILABLE");
  };
  return {
    async addItem(credentials, input) {
      const result = await options.cart.addItem({
        guestCredential: credentials.sessionCredential,
        csrfCredential: credentials.csrfCredential,
        operationReference: input.operationReference,
        requestedAt: input.requestedAt,
        cartReference: input.cartReference,
        expectedCartVersion: input.expectedCartVersion,
        sellableReference: input.sellableReference,
        quantity: input.quantity,
        optionSelections: input.optionSelections,
        customerNote: input.customerNote ?? null,
      });
      if (result.status === "Applied")
        return {
          status: "Applied" as const,
          cartVersion: result.view.cart.version,
          lines: result.view.cart.items.map((item) => ({
            cartItemReference: item.cartItemReference,
            quantity: item.quantity,
          })),
        };
      // Not on the menu now, sold out, or an option the item does not take.
      if (result.status === "SelectionInvalid") return { status: "NotAvailable" as const };
      // A table guest is paying for this table's Cart right now (dine-in only).
      if (result.status === "CheckoutInProgress") return { status: "CheckoutInProgress" as const };
      return failed();
    },
    async quote(credentials, input) {
      const result = await options.quote.quoteCart({
        cartReference: input.cartReference as never,
        expectedCartVersion: input.cartVersion,
        guestCredential: credentials.sessionCredential,
        csrfCredential: credentials.csrfCredential,
        idempotencyKey: input.operationReference,
        requestedAt: input.requestedAt,
      });
      if (result.status === "InvalidConfiguration") return { status: "NotPriced" as const };
      if (result.status !== "Created" && result.status !== "Current") return failed();
      const quote = result.quote;
      if (
        String(quote.cartReference) !== input.cartReference ||
        quote.cartVersion !== input.cartVersion ||
        quote.blockingReasons.length !== 0 ||
        quote.total.currencyCode !== "CAD"
      )
        return { status: "NotPriced" as const };
      return {
        status: "Quoted" as const,
        quoteReference: String(quote.quoteReference),
        subtotalMinor: quote.subtotal.amountMinor,
        totalMinor: quote.total.amountMinor,
      };
    },
    async saveDetails(credentials, input) {
      const saved = readClosedRecord(
        await options.details.save({
          ...credentials,
          command: counterCheckoutDetailsCommand(input),
        }),
        ["status", "snapshot"],
      );
      const snapshot = saved.snapshot as {
        cartReference?: unknown;
        cartVersion?: unknown;
        quoteReference?: unknown;
      } | null;
      if (
        (saved.status !== "Saved" && saved.status !== "AlreadySaved") ||
        String(snapshot?.cartReference) !== input.cartReference ||
        snapshot?.cartVersion !== input.cartVersion ||
        String(snapshot?.quoteReference) !== input.quoteReference
      )
        return failed();
    },
    async startCheckout(credentials, input) {
      try {
        const created = readClosedRecord(
          await options.checkout.create({
            ...credentials,
            command: {
              createOperationReference: input.createOperationReference,
              cartReference: input.cartReference,
              cartVersion: input.cartVersion,
              quoteReference: input.quoteReference,
              quoteVersion: 2,
            },
          }),
          ["status", "session"],
        );
        const session = parseCheckoutSession(created.session);
        return {
          status: "Started" as const,
          checkoutSessionReference: session.checkoutSessionReference,
        };
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError && error.code === "STORE_CLOSED")
          return { status: "StoreNotTakingOrders" as const };
        // WP-2423: which item the Store's stock can't make (and how many it can); nothing created.
        if (error instanceof CheckoutSessionServiceError && error.code === "ITEM_SHORT")
          return {
            status: "ItemShort" as const,
            cartItemReference: String(error.line?.cartItemReference ?? ""),
            available: error.line?.available ?? 0,
            sharedStock: error.line?.sharedStock ?? false,
          };
        if (error instanceof CheckoutSessionServiceError && error.code === "ITEM_UNAVAILABLE")
          return {
            status: "ItemUnavailable" as const,
            cartItemReference: error.line === null ? null : String(error.line.cartItemReference),
          };
        throw error;
      }
    },
  };
}
