import { parseCartLifecycle, type CartLifecycle } from "./cart-lifecycle.js";

export type OrderingReference = string & { readonly __orderingReference: unique symbol };
export type OrderingInstant = string & { readonly __orderingInstant: unique symbol };
export type OrderingHash = string & { readonly __orderingHash: unique symbol };
export type CartOrderType = "DineIn" | "Pickup";
export type CartSourceChannel = "Api" | "Pos" | "Qr" | "Web";

export interface CartOptionSelection {
  readonly optionReference: OrderingReference;
  readonly quantity: number;
}

export interface CartItem {
  readonly cartItemReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly quantity: number;
  readonly optionSelections: readonly CartOptionSelection[];
  readonly customerNote: string | null;
  readonly catalogSelectionEvidence: CatalogSelectionEvidence | null;
  readonly addedByActorReference: OrderingReference;
  readonly addedByParticipantReference: OrderingReference | null;
  readonly addedAt: OrderingInstant;
}

export interface CartSelectionRuleEvidence {
  readonly bindingReference: OrderingReference;
  readonly optionSetVersionReference: OrderingReference;
}

export interface CatalogSelectionEvidence {
  readonly menuVersionReference: OrderingReference;
  readonly productVersionReference: OrderingReference;
  readonly catalogChannelCode: string;
  readonly catalogOrderTypeCode: string;
  readonly ruleEvidence: readonly CartSelectionRuleEvidence[];
  readonly validatedAt: OrderingInstant;
}

export interface CartAggregate {
  readonly cartReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderType: CartOrderType;
  readonly sourceChannel: CartSourceChannel;
  readonly diningSessionReference: OrderingReference | null;
  readonly createdByActorReference: OrderingReference;
  readonly aggregateVersion: number;
  readonly createdAt: OrderingInstant;
  readonly updatedAt: OrderingInstant;
  readonly lifecycle: CartLifecycle | null;
  readonly items: readonly CartItem[];
}

export const cartErrorCodes = [
  "CART_INPUT_INVALID",
  "CART_UNAVAILABLE",
  "CART_PERMISSION_DENIED",
  "CART_VERSION_CONFLICT",
  "CART_IDEMPOTENCY_CONFLICT",
  "CART_ITEM_NOT_FOUND",
  "CART_ITEM_LIMIT_REACHED",
  "CART_SELECTION_INVALID",
  "CART_QUOTE_INVALID",
  "CART_QUOTE_EXPIRED",
  "CART_LIFECYCLE_UNAVAILABLE",
  "CART_EXPIRED",
  "CART_ABANDONED",
  "CART_EXPIRATION_NOT_DUE",
  "CART_DEPENDENCY_UNAVAILABLE",
] as const;
export type CartErrorCode = (typeof cartErrorCodes)[number];

export class CartError extends Error {
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode) {
    super(
      code === "CART_INPUT_INVALID"
        ? "cart input is invalid"
        : code === "CART_VERSION_CONFLICT"
          ? "cart version conflict"
          : code === "CART_IDEMPOTENCY_CONFLICT"
            ? "cart idempotency conflict"
            : "cart is unavailable",
    );
    this.name = "CartError";
    this.code = code;
  }
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return invalid();
      parsed[key] = descriptor.value;
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof CartError) throw error;
    return invalid();
  }
}

export function parseOrderingReference(value: unknown): OrderingReference {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value as OrderingReference;
}

export function parseOrderingInstant(value: unknown): OrderingInstant {
  if (typeof value !== "string" || !instantPattern.test(value)) return invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    return invalid();
  return value as OrderingInstant;
}

export function parseOrderingHash(value: unknown): OrderingHash {
  if (typeof value !== "string" || !hashPattern.test(value)) return invalid();
  return value as OrderingHash;
}

export function parseCustomerNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 500 ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) as number;
      return (
        codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
      );
    })
  )
    return invalid();
  return normalized;
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value)) return invalid();
  return value;
}

function parseCartSelectionRuleEvidence(value: unknown): CartSelectionRuleEvidence {
  const raw = closed(value, ["bindingReference", "optionSetVersionReference"]);
  return Object.freeze({
    bindingReference: parseOrderingReference(raw.bindingReference),
    optionSetVersionReference: parseOrderingReference(raw.optionSetVersionReference),
  });
}

export function parseCatalogSelectionEvidence(value: unknown): CatalogSelectionEvidence | null {
  if (value === null) return null;
  const raw = closed(value, [
    "menuVersionReference",
    "productVersionReference",
    "catalogChannelCode",
    "catalogOrderTypeCode",
    "ruleEvidence",
    "validatedAt",
  ]);
  if (!Array.isArray(raw.ruleEvidence) || raw.ruleEvidence.length > 100) return invalid();
  const ruleEvidence = raw.ruleEvidence.map(parseCartSelectionRuleEvidence);
  if (new Set(ruleEvidence.map((item) => item.bindingReference)).size !== ruleEvidence.length)
    return invalid();
  return Object.freeze({
    menuVersionReference: parseOrderingReference(raw.menuVersionReference),
    productVersionReference: parseOrderingReference(raw.productVersionReference),
    catalogChannelCode: code(raw.catalogChannelCode),
    catalogOrderTypeCode: code(raw.catalogOrderTypeCode),
    ruleEvidence: Object.freeze(ruleEvidence),
    validatedAt: parseOrderingInstant(raw.validatedAt),
  });
}

// Cart revisions follow the current PostgreSQL integer storage contract, not item quantities.
function aggregateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647)
    return invalid();
  return value as number;
}

function quantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999)
    return invalid();
  return value as number;
}

export function parseCartOptionSelection(value: unknown): CartOptionSelection {
  const raw = closed(value, ["optionReference", "quantity"]);
  return Object.freeze({
    optionReference: parseOrderingReference(raw.optionReference),
    quantity: quantity(raw.quantity),
  });
}

export function parseCartItem(value: unknown): CartItem {
  const raw = closed(value, [
    "cartItemReference",
    "cartReference",
    "sellableReference",
    "quantity",
    "optionSelections",
    "customerNote",
    "catalogSelectionEvidence",
    "addedByActorReference",
    "addedByParticipantReference",
    "addedAt",
  ]);
  if (!Array.isArray(raw.optionSelections) || raw.optionSelections.length > 100) return invalid();
  const optionSelections = raw.optionSelections.map(parseCartOptionSelection);
  if (
    new Set(optionSelections.map((selection) => selection.optionReference)).size !==
    optionSelections.length
  )
    return invalid();
  return Object.freeze({
    cartItemReference: parseOrderingReference(raw.cartItemReference),
    cartReference: parseOrderingReference(raw.cartReference),
    sellableReference: parseOrderingReference(raw.sellableReference),
    quantity: quantity(raw.quantity),
    optionSelections: Object.freeze(optionSelections),
    customerNote: parseCustomerNote(raw.customerNote),
    catalogSelectionEvidence: parseCatalogSelectionEvidence(raw.catalogSelectionEvidence),
    addedByActorReference: parseOrderingReference(raw.addedByActorReference),
    addedByParticipantReference:
      raw.addedByParticipantReference === null
        ? null
        : parseOrderingReference(raw.addedByParticipantReference),
    addedAt: parseOrderingInstant(raw.addedAt),
  });
}

export function parseCartAggregate(value: unknown): CartAggregate {
  const raw = closed(value, [
    "cartReference",
    "brandReference",
    "storeReference",
    "orderType",
    "sourceChannel",
    "diningSessionReference",
    "createdByActorReference",
    "aggregateVersion",
    "createdAt",
    "updatedAt",
    "lifecycle",
    "items",
  ]);
  if (raw.orderType !== "DineIn" && raw.orderType !== "Pickup") return invalid();
  if (!["Api", "Pos", "Qr", "Web"].includes(raw.sourceChannel as string)) return invalid();
  if (!Array.isArray(raw.items) || raw.items.length > 100) return invalid();
  const cartReference = parseOrderingReference(raw.cartReference);
  const createdAt = parseOrderingInstant(raw.createdAt);
  const updatedAt = parseOrderingInstant(raw.updatedAt);
  const lifecycle = parseCartLifecycle(raw.lifecycle);
  const diningSessionReference =
    raw.diningSessionReference === null ? null : parseOrderingReference(raw.diningSessionReference);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (raw.orderType === "DineIn") !== (diningSessionReference !== null) ||
    (lifecycle !== null &&
      (Date.parse(lifecycle.idleExpiresAt) <= Date.parse(createdAt) ||
        Date.parse(lifecycle.absoluteExpiresAt) <= Date.parse(createdAt) ||
        (lifecycle.status === "Active" &&
          (Date.parse(updatedAt) >= Date.parse(lifecycle.idleExpiresAt) ||
            Date.parse(updatedAt) >= Date.parse(lifecycle.absoluteExpiresAt))) ||
        (lifecycle.status !== "Active" && lifecycle.terminalAt !== updatedAt)))
  )
    return invalid();
  const items = raw.items.map(parseCartItem);
  if (
    items.some(
      (item) =>
        item.cartReference !== cartReference ||
        (raw.orderType === "DineIn" && item.addedByParticipantReference === null),
    ) ||
    new Set(items.map((item) => item.cartItemReference)).size !== items.length
  )
    return invalid();
  return Object.freeze({
    cartReference,
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
    orderType: raw.orderType,
    sourceChannel: raw.sourceChannel as CartSourceChannel,
    diningSessionReference,
    createdByActorReference: parseOrderingReference(raw.createdByActorReference),
    aggregateVersion: aggregateVersion(raw.aggregateVersion),
    createdAt,
    updatedAt,
    lifecycle,
    items: Object.freeze(items),
  });
}
