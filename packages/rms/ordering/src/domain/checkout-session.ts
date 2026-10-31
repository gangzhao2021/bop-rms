import { parseOrderingInstant, parseOrderingReference } from "./cart.js";
import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "./checkout-validation.js";

export interface CheckoutSession {
  readonly schemaVersion: 1;
  readonly checkoutSessionReference: string;
  readonly createOperationReference: string;
  readonly submissionReference: string;
  readonly paymentOperationReference: string;
  readonly validation: CheckoutValidationEvidence<1 | 2>;
  readonly createdAt: string;
}
export class CheckoutSessionError extends Error {
  constructor() {
    super("checkout session input is invalid");
    this.name = "CheckoutSessionError";
  }
}
/** Historical binding only: current customer access and payment admission remain mandatory. */
export function parseCheckoutSession(value: unknown): CheckoutSession {
  try {
    const fields = [
      "schemaVersion",
      "checkoutSessionReference",
      "createOperationReference",
      "submissionReference",
      "paymentOperationReference",
      "validation",
      "createdAt",
    ];
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new CheckoutSessionError();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      throw new CheckoutSessionError();
    const raw: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        throw new CheckoutSessionError();
      raw[field] = descriptor.value;
    }
    if (raw.schemaVersion !== 1) throw new CheckoutSessionError();
    const checkoutSessionReference = parseOrderingReference(raw.checkoutSessionReference);
    const createOperationReference = parseOrderingReference(raw.createOperationReference);
    const submissionReference = parseOrderingReference(raw.submissionReference);
    const paymentOperationReference = parseOrderingReference(raw.paymentOperationReference);
    if (
      new Set([
        checkoutSessionReference,
        createOperationReference,
        submissionReference,
        paymentOperationReference,
      ]).size !== 4
    )
      throw new CheckoutSessionError();
    // The evidence parsers reject unknown fields, accessors, and unsupported quote versions.
    let validation: CheckoutValidationEvidence<1 | 2>;
    try {
      validation = parseCheckoutValidationEvidence(raw.validation);
    } catch {
      validation = parseConfiguredCheckoutValidationEvidence(raw.validation);
    }
    const createdAt = parseOrderingInstant(raw.createdAt);
    if (createdAt < validation.validatedAt || createdAt >= validation.validUntil)
      throw new CheckoutSessionError();
    return Object.freeze({
      schemaVersion: 1,
      checkoutSessionReference,
      createOperationReference,
      submissionReference,
      paymentOperationReference,
      validation,
      createdAt,
    });
  } catch {
    throw new CheckoutSessionError();
  }
}
