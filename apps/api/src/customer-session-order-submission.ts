import { parseDiningCheckoutCommitment } from "@rms/dining";
import { parseAsapCapacityCommitment } from "@rms/fulfillment";
import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  parseOrderingReference,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  type CheckoutSession,
  type OrderCapacityLink,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  createCustomerPickupOrderSubmissionComposition,
  createCustomerConfiguredPickupOrderSubmissionComposition,
  type CustomerPickupOrderSubmissionOptions,
} from "./customer-pickup-order-submission-composition.js";
import {
  createCustomerDiningOrderSubmissionComposition,
  createCustomerConfiguredDiningOrderSubmissionComposition,
  type CustomerDiningOrderSubmissionOptions,
} from "./customer-dining-order-submission-composition.js";
import type { CustomerOrderSubmissionCommand } from "./customer-order-submission.js";

function bindLink(session: CheckoutSession, link: OrderCapacityLink) {
  const v = session.validation;
  if (
    link.submissionReference !== session.submissionReference ||
    link.paymentOperationReference !== session.paymentOperationReference ||
    link.cartReference !== v.cartReference ||
    link.cartVersion !== v.cartVersion ||
    link.quoteReference !== v.quoteReference ||
    link.brandReference !== v.brandReference ||
    link.storeReference !== v.storeReference ||
    link.guestSessionReference !== v.guestSessionReference
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
}
/** Internal bridge; the browser supplies no submission/payment operation IDs. */
function bridge(
  access: CustomerCheckoutSessionAuthorizationOptions,
  quoteVersion: 1 | 2,
  orderType: "Pickup" | "DineIn",
  submit: (
    session: CheckoutSession,
    input: CustomerOrderSubmissionCommand,
    action: "Create" | "Clock",
  ) => Promise<unknown>,
) {
  const reader = createCustomerCheckoutSessionRead(access);
  return Object.freeze({
    async create(value: unknown) {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        checkoutSessionReference: string;
      };
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
        ]);
        input = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        };
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      const session = parseCheckoutSession(await reader.read(input));
      const v = session.validation;
      if (v.quoteVersion !== quoteVersion || v.orderType !== orderType)
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const result = readClosedRecord(
        await submit(
          session,
          {
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            submissionReference: session.submissionReference,
            cartReference: v.cartReference,
            expectedCartVersion: v.cartVersion,
            quoteReference: v.quoteReference,
          },
          "Create",
        ),
        ["status", "record"],
      );
      if (result.status !== "Created" && result.status !== "AlreadyCreated")
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      const record =
        quoteVersion === 2
          ? parseConfiguredOrderCreationRecord(result.record)
          : parseOrderCreationRecord(result.record);
      const batch = record.order.batches[0];
      if (
        record.submissionReference !== session.submissionReference ||
        record.guestSessionReference !== v.guestSessionReference ||
        record.order.brandReference !== v.brandReference ||
        record.order.storeReference !== v.storeReference ||
        batch.sourceCartReference !== v.cartReference ||
        batch.sourceCartVersion !== v.cartVersion ||
        batch.quoteReference !== v.quoteReference ||
        record.order.orderType !== orderType
      )
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      // Lost response recovers original Order on retry, after current session authorization.
      if (JSON.stringify(await reader.read(input)) !== JSON.stringify(session))
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return Object.freeze({ status: result.status, record, session });
    },
    async preparePaymentClock(value: unknown) {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        checkoutSessionReference: string;
      };
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
        ]);
        input = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        };
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      const session = parseCheckoutSession(await reader.read(input)),
        v = session.validation;
      if (v.quoteVersion !== quoteVersion || v.orderType !== orderType)
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const result = readClosedRecord(
        await submit(
          session,
          {
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            submissionReference: session.submissionReference,
            cartReference: v.cartReference,
            expectedCartVersion: v.cartVersion,
            quoteReference: v.quoteReference,
          },
          "Clock",
        ),
        ["order", "clock"],
      );
      const order =
        quoteVersion === 2
          ? parseConfiguredOrderCreationRecord(result.order)
          : parseOrderCreationRecord(result.order);
      const clock =
        orderType === "DineIn"
          ? parseDiningCheckoutCommitment(result.clock)
          : parseAsapCapacityCommitment(result.clock);
      const batch = order.order.batches[0];
      if (
        order.submissionReference !== session.submissionReference ||
        order.guestSessionReference !== v.guestSessionReference ||
        order.order.brandReference !== v.brandReference ||
        order.order.storeReference !== v.storeReference ||
        order.order.orderType !== orderType ||
        batch.sourceCartReference !== v.cartReference ||
        batch.sourceCartVersion !== v.cartVersion ||
        batch.quoteReference !== v.quoteReference ||
        clock.submissionReference !== session.submissionReference ||
        clock.paymentOperationReference !== session.paymentOperationReference ||
        String(clock.guestSessionReference) !== v.guestSessionReference ||
        String(clock.cartReference) !== v.cartReference ||
        clock.cartVersion !== v.cartVersion ||
        String(clock.quoteReference) !== v.quoteReference ||
        String(clock.orderReference) !== order.order.orderReference ||
        String(clock.orderBatchReference) !== batch.orderBatchReference ||
        clock.state !== "PaymentPending" ||
        clock.paymentRequestedAt === null ||
        clock.capacityExpiresAt === null
      )
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      if (JSON.stringify(await reader.read(input)) !== JSON.stringify(session))
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return Object.freeze({ order, clock, session });
    },
  });
}

export function createCustomerPickupSessionOrderSubmission(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerPickupOrderSubmissionOptions<1>,
) {
  return bridge(access, 1, "Pickup", async (session, input, action) => {
    const composition = createCustomerPickupOrderSubmissionComposition({
      ...options,
      preparation: {
        ...options.preparation,
        references: {
          ...options.preparation.references,
          generate: (kind) =>
            kind === "PaymentOperation"
              ? session.paymentOperationReference
              : options.preparation.references.generate(kind),
        },
      },
      repository: (link, authorization) => {
        bindLink(session, link);
        return options.repository(link, authorization);
      },
    });
    return action === "Clock" ? composition.preparePaymentClock(input) : composition.create(input);
  });
}

export function createCustomerConfiguredPickupSessionOrderSubmission(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerPickupOrderSubmissionOptions<2>,
) {
  return bridge(access, 2, "Pickup", async (session, input, action) => {
    const composition = createCustomerConfiguredPickupOrderSubmissionComposition({
      ...options,
      preparation: {
        ...options.preparation,
        references: {
          ...options.preparation.references,
          generate: (kind) =>
            kind === "PaymentOperation"
              ? session.paymentOperationReference
              : options.preparation.references.generate(kind),
        },
      },
      repository: (link, authorization) => {
        bindLink(session, link);
        return options.repository(link, authorization);
      },
    });
    return action === "Clock" ? composition.preparePaymentClock(input) : composition.create(input);
  });
}

export function createCustomerDiningSessionOrderSubmission(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerDiningOrderSubmissionOptions<1>,
) {
  return bridge(access, 1, "DineIn", async (session, input, action) => {
    const composition = createCustomerDiningOrderSubmissionComposition({
      ...options,
      preparation: {
        ...options.preparation,
        references: {
          ...options.preparation.references,
          generate: (kind) =>
            kind === "PaymentOperation"
              ? session.paymentOperationReference
              : options.preparation.references.generate(kind),
        },
      },
      repository: (link, authorization) => {
        bindLink(session, link);
        return options.repository(link, authorization);
      },
    });
    return action === "Clock" ? composition.preparePaymentClock(input) : composition.create(input);
  });
}

export function createCustomerConfiguredDiningSessionOrderSubmission(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerDiningOrderSubmissionOptions<2>,
) {
  return bridge(access, 2, "DineIn", async (session, input, action) => {
    const composition = createCustomerConfiguredDiningOrderSubmissionComposition({
      ...options,
      preparation: {
        ...options.preparation,
        references: {
          ...options.preparation.references,
          generate: (kind) =>
            kind === "PaymentOperation"
              ? session.paymentOperationReference
              : options.preparation.references.generate(kind),
        },
      },
      repository: (link, authorization) => {
        bindLink(session, link);
        return options.repository(link, authorization);
      },
    });
    return action === "Clock" ? composition.preparePaymentClock(input) : composition.create(input);
  });
}
