import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "./cart.js";

export interface CheckoutPickupContact {
  readonly name: string;
  readonly channel: "Phone" | "Email";
  readonly value: string;
}
export interface CheckoutPolicyAcknowledgement {
  readonly documentReference: string;
  readonly documentVersion: number;
  readonly documentDigest: string;
  readonly purposeCode: string;
}
/** Original submission details. Email choice is a request, never delivery or verification evidence. */
export interface CheckoutDetailsSnapshot {
  readonly schemaVersion: 1;
  readonly detailsReference: string;
  readonly detailsVersion: number;
  readonly guestSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly orderType: "DineIn" | "Pickup";
  readonly pickupContact: CheckoutPickupContact | null;
  readonly receipt:
    | Readonly<{ choice: "InSession"; email: null }>
    | Readonly<{ choice: "TransactionalEmail"; email: string }>;
  readonly policies: readonly CheckoutPolicyAcknowledgement[];
  readonly recordedAt: string;
}
export class CheckoutDetailsError extends Error {
  constructor(readonly code: "CHECKOUT_DETAILS_INPUT_INVALID" = "CHECKOUT_DETAILS_INPUT_INVALID") {
    super("checkout details are unavailable");
    this.name = "CheckoutDetailsError";
  }
}
function fail(): never {
  throw new CheckoutDetailsError();
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    return fail();
  return Number(value);
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[<>\p{Cc}\p{Cf}]/u.test(value)
  )
    return fail();
  return value;
}
function email(value: unknown): string {
  const result = text(value, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) return fail();
  return result;
}
function contact(value: unknown): CheckoutPickupContact {
  const raw = exact(value, ["name", "channel", "value"]);
  if (raw.channel !== "Phone" && raw.channel !== "Email") return fail();
  const result = raw.channel === "Email" ? email(raw.value) : text(raw.value, 16);
  if (raw.channel === "Phone" && !/^\+[1-9][0-9]{6,14}$/u.test(result)) return fail();
  return Object.freeze({ name: text(raw.name, 120), channel: raw.channel, value: result });
}
function receipt(value: unknown): CheckoutDetailsSnapshot["receipt"] {
  const raw = exact(value, ["choice", "email"]);
  if (raw.choice === "InSession" && raw.email === null)
    return Object.freeze({ choice: "InSession", email: null });
  if (raw.choice === "TransactionalEmail")
    return Object.freeze({ choice: "TransactionalEmail", email: email(raw.email) });
  return fail();
}
export function parseCheckoutPolicyAcknowledgements(
  value: unknown,
): readonly CheckoutPolicyAcknowledgement[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 20
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const result: CheckoutPolicyAcknowledgement[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail();
    const raw = exact(descriptor.value, [
      "documentReference",
      "documentVersion",
      "documentDigest",
      "purposeCode",
    ]);
    const purposeCode = text(raw.purposeCode, 64);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(purposeCode)) return fail();
    result.push(
      Object.freeze({
        documentReference: parseOrderingReference(raw.documentReference),
        documentVersion: version(raw.documentVersion),
        documentDigest: parseOrderingHash(raw.documentDigest),
        purposeCode,
      }),
    );
  }
  if (new Set(result.map((item) => item.documentReference)).size !== result.length) return fail();
  return Object.freeze(result);
}
/** Structural history validation; the application must authorize and validate current required policies. */
export function parseCheckoutDetailsSnapshot(value: unknown): CheckoutDetailsSnapshot {
  try {
    const raw = exact(value, [
      "schemaVersion",
      "detailsReference",
      "detailsVersion",
      "guestSessionReference",
      "brandReference",
      "storeReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "quoteVersion",
      "orderType",
      "pickupContact",
      "receipt",
      "policies",
      "recordedAt",
    ]);
    if (
      raw.schemaVersion !== 1 ||
      (raw.quoteVersion !== 1 && raw.quoteVersion !== 2) ||
      (raw.orderType !== "DineIn" && raw.orderType !== "Pickup")
    )
      return fail();
    const pickupContact = raw.pickupContact === null ? null : contact(raw.pickupContact);
    if ((raw.orderType === "Pickup") !== (pickupContact !== null)) return fail();
    return Object.freeze({
      schemaVersion: 1,
      detailsReference: parseOrderingReference(raw.detailsReference),
      detailsVersion: version(raw.detailsVersion),
      guestSessionReference: parseOrderingReference(raw.guestSessionReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      cartReference: parseOrderingReference(raw.cartReference),
      cartVersion: version(raw.cartVersion),
      quoteReference: parseOrderingReference(raw.quoteReference),
      quoteVersion: raw.quoteVersion,
      orderType: raw.orderType,
      pickupContact,
      receipt: receipt(raw.receipt),
      policies: parseCheckoutPolicyAcknowledgements(raw.policies),
      recordedAt: parseOrderingInstant(raw.recordedAt),
    });
  } catch {
    return fail();
  }
}
