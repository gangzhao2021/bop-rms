import { parseOrderingInstant, parseOrderingReference } from "./cart.js";
export interface CheckoutSessionAllocation {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly guestSessionReference: string;
  readonly createOperationReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly checkoutSessionReference: string;
  readonly submissionReference: string;
  readonly paymentOperationReference: string;
  readonly allocatedAt: string;
}
export class CheckoutSessionAllocationError extends Error {
  constructor() {
    super("checkout allocation is invalid");
    this.name = "CheckoutSessionAllocationError";
  }
}
export function parseCheckoutSessionAllocation(value: unknown): CheckoutSessionAllocation {
  try {
    const refs = [
      "brandReference",
      "storeReference",
      "guestSessionReference",
      "createOperationReference",
      "cartReference",
      "quoteReference",
      "checkoutSessionReference",
      "submissionReference",
      "paymentOperationReference",
    ] as const;
    const fields = [...refs, "cartVersion", "quoteVersion", "allocatedAt"];
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new CheckoutSessionAllocationError();
    const keys = Reflect.ownKeys(value),
      descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      throw new CheckoutSessionAllocationError();
    const raw: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        throw new CheckoutSessionAllocationError();
      raw[field] = descriptor.value;
    }
    const parsed = {
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      createOperationReference: parseOrderingReference(raw.createOperationReference),
      cartReference: parseOrderingReference(raw.cartReference),
      quoteReference: parseOrderingReference(raw.quoteReference),
      checkoutSessionReference: parseOrderingReference(raw.checkoutSessionReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      paymentOperationReference: parseOrderingReference(raw.paymentOperationReference),
    };
    if (
      !Number.isSafeInteger(raw.cartVersion) ||
      Number(raw.cartVersion) < 1 ||
      Number(raw.cartVersion) > 2147483647 ||
      (raw.quoteVersion !== 1 && raw.quoteVersion !== 2) ||
      new Set([
        parsed.createOperationReference,
        parsed.checkoutSessionReference,
        parsed.submissionReference,
        parsed.paymentOperationReference,
      ]).size !== 4
    )
      throw new CheckoutSessionAllocationError();
    return Object.freeze({
      ...parsed,
      cartVersion: Number(raw.cartVersion),
      quoteVersion: raw.quoteVersion,
      allocatedAt: parseOrderingInstant(raw.allocatedAt),
    });
  } catch {
    throw new CheckoutSessionAllocationError();
  }
}
