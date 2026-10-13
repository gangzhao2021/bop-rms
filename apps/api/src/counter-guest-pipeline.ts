import { readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  type CheckoutSession,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";
import type { Money } from "@rms/pricing";
import type { CustomerCartBindingPort } from "./customer-cart-binding.js";
import type { CustomerCartPort } from "./customer-cart.js";
import type { CustomerEntryPort } from "./customer-entry.js";
import type { CustomerQuotePort } from "./customer-quote.js";
import { prepareCustomerSessionPayment } from "./customer-session-payment-intent.js";
import type { CounterGuestCredentials, CounterGuestPipeline } from "./merchant-counter-order.js";

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
  checkout: {
    create(value: unknown): Promise<unknown>;
    read(value: unknown): Promise<unknown>;
  };
  /** WP-2423 Q4: the Store takes a pickup order now (checked again when payment starts). */
  takesOrder(credentials: CounterGuestCredentials): Promise<boolean>;
  payment: (credentials: CounterGuestCredentials) => PaymentOptions;
  nextReference(): string;
  now(): string;
}): CounterGuestPipeline {
  const failed = (): never => {
    throw new Error("COUNTER_GUEST_PIPELINE_UNAVAILABLE");
  };
  const pipeline: CounterGuestPipeline = {
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
        customerNote: null,
      });
      if (result.status === "Applied")
        return { status: "Applied" as const, cartVersion: result.view.cart.version };
      // Not on the menu now, sold out, or an option the item does not take.
      if (result.status === "SelectionInvalid") return { status: "NotAvailable" as const };
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
        throw error;
      }
    },
    async preparePayment(credentials, input): Promise<OrderPaymentPreparationEvidence> {
      if (!(await options.takesOrder(credentials)))
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
