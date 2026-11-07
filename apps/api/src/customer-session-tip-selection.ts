import { parseDiningCheckoutCommitment } from "@rms/dining";
import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import { createMoney, type Money } from "@rms/pricing";
import { parsePaymentTipSelection, type PaymentTipSelection } from "@rms/payment";
import {
  CheckoutSessionServiceError,
  parseCheckoutSession,
  parseOrderingReference,
  type CheckoutSession,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  createCustomerPickupTipSelectionComposition,
  createCustomerConfiguredPickupTipSelectionComposition,
  type CustomerPickupTipSelectionOptions,
} from "./customer-pickup-tip-selection-composition.js";
import {
  createPersistentAdditionalDiningTipSelection,
  createCustomerDiningTipSelectionComposition,
  createCustomerConfiguredDiningTipSelectionComposition,
  type CustomerDiningTipSelectionOptions,
} from "./customer-dining-tip-selection-composition.js";

function bind(session: CheckoutSession, selection: PaymentTipSelection) {
  const v = session.validation;
  if (
    String(selection.paymentOperationReference) !== session.paymentOperationReference ||
    String(selection.submissionReference) !== session.submissionReference ||
    String(selection.cartReference) !== v.cartReference ||
    selection.cartVersion !== v.cartVersion ||
    String(selection.quoteReference) !== v.quoteReference ||
    String(selection.guestSessionReference) !== v.guestSessionReference ||
    String(selection.brandReference) !== v.brandReference ||
    String(selection.storeReference) !== v.storeReference
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
}
function bridge(
  access: CustomerCheckoutSessionAuthorizationOptions,
  version: 1 | 2,
  channel: "Pickup" | "DineIn",
  select: (session: CheckoutSession, input: unknown) => Promise<unknown>,
) {
  const reader = createCustomerCheckoutSessionRead(access);
  return Object.freeze({
    async select(value: unknown) {
      let input: {
        sessionCredential: string;
        csrfCredential: string;
        checkoutSessionReference: string;
      };
      let selectionReference: string, tip: Money;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
          "selectionReference",
          "tip",
        ]);
        input = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
          checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
        };
        selectionReference = String(parseOrderingReference(raw.selectionReference));
        tip = createMoney(raw.tip as Money);
        if (
          tip.currencyCode !== "CAD" ||
          tip.amountMinor < 0n ||
          tip.amountMinor > 9223372036854775807n
        )
          throw new Error("invalid tip");
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      const session = parseCheckoutSession(await reader.read(input)),
        v = session.validation;
      if (v.quoteVersion !== version || v.orderType !== channel)
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const result = readClosedRecord(
        await select(session, {
          sessionCredential: input.sessionCredential,
          csrfCredential: input.csrfCredential,
          selectionReference,
          submissionReference: session.submissionReference,
          cartReference: v.cartReference,
          cartVersion: v.cartVersion,
          quoteReference: v.quoteReference,
          tip,
        }),
        ["status", "record"],
      );
      if (result.status !== "Created" && result.status !== "Existing")
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      const record = parsePaymentTipSelection(result.record);
      bind(session, record);
      if (
        String(record.selectionReference) !== selectionReference ||
        record.tip.amountMinor !== tip.amountMinor ||
        record.tip.currencyCode !== tip.currencyCode
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      if (JSON.stringify(await reader.read(input)) !== JSON.stringify(session))
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return Object.freeze({ status: result.status, record, session });
    },
  });
}

export function createCustomerPickupSessionTipSelection(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerPickupTipSelectionOptions<1>,
) {
  return bridge(access, 1, "Pickup", async (session, input) => {
    return createCustomerPickupTipSelectionComposition({
      ...options,
      tip: {
        ...options.tip,
        repository: {
          load: async (reference) => {
            const record = await options.tip.repository.load(reference);
            if (record !== null) bind(session, parsePaymentTipSelection(record));
            return record;
          },
          append: async (value) => {
            bind(session, parsePaymentTipSelection(value.record));
            return options.tip.repository.append(value);
          },
        },
      },
    }).select(input);
  });
}

export function createCustomerConfiguredPickupSessionTipSelection(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerPickupTipSelectionOptions<2>,
) {
  return bridge(access, 2, "Pickup", async (session, input) => {
    return createCustomerConfiguredPickupTipSelectionComposition({
      ...options,
      tip: {
        ...options.tip,
        repository: {
          load: async (reference) => {
            const record = await options.tip.repository.load(reference);
            if (record !== null) bind(session, parsePaymentTipSelection(record));
            return record;
          },
          append: async (value) => {
            bind(session, parsePaymentTipSelection(value.record));
            return options.tip.repository.append(value);
          },
        },
      },
    }).select(input);
  });
}

export function createCustomerDiningSessionTipSelection(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerDiningTipSelectionOptions<1>,
) {
  return bridge(access, 1, "DineIn", async (session, input) => {
    return createCustomerDiningTipSelectionComposition({
      ...options,
      tip: {
        ...options.tip,
        repository: {
          load: async (reference) => {
            const record = await options.tip.repository.load(reference);
            if (record !== null) bind(session, parsePaymentTipSelection(record));
            return record;
          },
          append: async (value) => {
            bind(session, parsePaymentTipSelection(value.record));
            return options.tip.repository.append(value);
          },
        },
      },
    }).select(input);
  });
}

export function createCustomerConfiguredDiningSessionTipSelection(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: CustomerDiningTipSelectionOptions<2>,
) {
  return bridge(access, 2, "DineIn", async (session, input) => {
    return createCustomerConfiguredDiningTipSelectionComposition({
      ...options,
      tip: {
        ...options.tip,
        repository: {
          load: async (reference) => {
            const record = await options.tip.repository.load(reference);
            if (record !== null) bind(session, parsePaymentTipSelection(record));
            return record;
          },
          append: async (value) => {
            bind(session, parsePaymentTipSelection(value.record));
            return options.tip.repository.append(value);
          },
        },
      },
    }).select(input);
  });
}

/** Server-bound parent identity; the owner revalidates its current version before selection. */
export function createCustomerAdditionalDiningSessionTipSelection(
  access: CustomerCheckoutSessionAuthorizationOptions,
  options: Parameters<typeof createPersistentAdditionalDiningTipSelection>[0],
  parent: Readonly<{ orderReference: string; expectedOrderVersion: number }>,
) {
  const orderReference = String(parseOrderingReference(parent.orderReference));
  const expectedOrderVersion = parent.expectedOrderVersion;
  if (
    !Number.isInteger(expectedOrderVersion) ||
    expectedOrderVersion < 1 ||
    expectedOrderVersion >= 2147483647 ||
    String(access.scope.brandReference) !== String(options.preparation.scope.brandReference) ||
    String(access.scope.storeReference) !== String(options.preparation.scope.storeReference)
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const quoteVersion = options.quoteVersion ?? 1;
  if (quoteVersion !== 1 && quoteVersion !== 2)
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  return bridge(access, quoteVersion, "DineIn", async (session, input) => {
    const preparation = options.preparation;
    const raw = readClosedRecord(input, [
      "sessionCredential",
      "csrfCredential",
      "selectionReference",
      "submissionReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "tip",
    ]);
    return createPersistentAdditionalDiningTipSelection({
      ...options,
      preparation: {
        ...preparation,
        submissions: {
          ...preparation.submissions,
          loadSubmission: async (reference) => {
            const loaded = await preparation.submissions.loadSubmission(reference);
            if (loaded === null) return null;
            const record = parseDiningCheckoutCommitment(loaded);
            const v = session.validation;
            if (
              String(record.orderReference) !== orderReference ||
              String(record.submissionReference) !== session.submissionReference ||
              String(record.paymentOperationReference) !== session.paymentOperationReference ||
              String(record.brandReference) !== v.brandReference ||
              String(record.storeReference) !== v.storeReference ||
              String(record.guestSessionReference) !== v.guestSessionReference ||
              String(record.cartReference) !== v.cartReference ||
              record.cartVersion !== v.cartVersion ||
              String(record.quoteReference) !== v.quoteReference
            )
              throw new CheckoutSessionServiceError("INTENT_CONFLICT");
            return record;
          },
        },
      },
    }).select({ ...raw, orderReference, expectedOrderVersion });
  });
}
