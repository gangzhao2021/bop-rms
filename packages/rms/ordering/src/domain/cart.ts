import { parseCartLifecycle, type CartLifecycle } from "./cart-lifecycle.js";

export type OrderingReference = string & { readonly __orderingReference: unique symbol };
export type OrderingInstant = string & { readonly __orderingInstant: unique symbol };
export type OrderingHash = string & { readonly __orderingHash: unique symbol };
export type CartOrderType = "DineIn" | "Pickup";
export type CartSourceChannel = "Api" | "Pos" | "Qr" | "Web";

/**
 * Channels whose carts a guest session operates. WP-2423 Q7: a counter (Pos) cart is a Pickup cart
 * staff open at the counter for a walk-up guest, under that guest's own session; only Pickup takes
 * it (staff dine-in ordering is a later slice).
 */
export function isGuestCartChannel(orderType: string | undefined, sourceChannel: string): boolean {
  return (
    sourceChannel === "Qr" ||
    sourceChannel === "Web" ||
    (sourceChannel === "Pos" && orderType === "Pickup")
  );
}

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
  "CART_REPLACEMENT_FORBIDDEN",
  /** WP-2423: a checkout on the previous table Cart may still create an order or charge; retry later. */
  "CART_REPLACEMENT_CHECKOUT_PENDING",
  /** DEC-DINING-ANY-PARTICIPANT-SUBMIT: another guest's checkout holds this table Cart version. */
  "CART_CHECKOUT_IN_PROGRESS",
  /** DEC-DINE-IN-PAY-LATER: the guest's table is checking out; staff add dishes. */
  "CART_TABLE_CHECKING_OUT",
  /** M126 I.2: this phone's place at the table ended (left or removed, table closed, changed). */
  "CART_PARTICIPATION_ENDED",
  "CART_VERSION_CONFLICT",
  "CART_IDEMPOTENCY_CONFLICT",
  "CART_ITEM_NOT_FOUND",
  "CART_ITEM_LIMIT_REACHED",
  "CART_SELECTION_INVALID",
  /** WP-2423 (guest-cart-503): one named line cannot be sold now; remove it (never retried). */
  "CART_ITEM_UNAVAILABLE",
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

/** M126 I.2: why this phone's place at the table ended. */
export const cartParticipationEndedReasons = ["Left", "TableClosed", "Changed"] as const;
export type CartParticipationEndedReason = (typeof cartParticipationEndedReasons)[number];

/** M126 I.2: told apart from an expired visit, so the guest is told what happened. */
export class CartParticipationEndedError extends CartError {
  readonly reason: CartParticipationEndedReason;
  constructor(reason: CartParticipationEndedReason) {
    super("CART_PARTICIPATION_ENDED");
    this.name = "CartParticipationEndedError";
    this.reason = reason;
  }
}

/** The reason of a CartParticipationEndedError (either copy), or null. */
export function readCartParticipationEnded(error: unknown): CartParticipationEndedReason | null {
  const found = readCartError(error);
  if (found === null || found.code !== "CART_PARTICIPATION_ENDED") return null;
  const reason = (found as Partial<CartParticipationEndedError>).reason;
  return reason !== undefined && cartParticipationEndedReasons.includes(reason) ? reason : null;
}

/**
 * WP-2423: replacement of a timed-out table Cart waits for a checkout on it that may still create an
 * order or a charge. pendingUntil is when the last time-bounded wait ends, or null when the wait
 * has no known end (for example a payment without outcome).
 */
export class CartReplacementPendingError extends CartError {
  readonly pendingUntil: string | null;
  constructor(pendingUntil: string | null) {
    super("CART_REPLACEMENT_CHECKOUT_PENDING");
    this.pendingUntil = pendingUntil;
  }
}

/**
 * DEC-DINING-ANY-PARTICIPANT-SUBMIT: another participant at the table is checking out this exact
 * Cart version until heldUntil. Nothing was changed; the guest may try again after it.
 */
export class CartCheckoutInProgressError extends CartError {
  readonly heldUntil: string;
  constructor(heldUntil: string) {
    super("CART_CHECKOUT_IN_PROGRESS");
    this.heldUntil = heldUntil;
  }
}

/**
 * WP-2423 (guest-cart-503): why a named line cannot be sold now, from a stable Catalog fact only.
 * `Unavailable`: sold out, out of stock, hidden or no longer on the menu. `OptionsChanged`: the dish
 * is sold but its chosen options no longer fit. `SetupIncomplete`: the merchant's menu setup is
 * missing a fact the order needs (for example the tax class); staff must fix the menu.
 */
export type CartItemUnavailableReason = "Unavailable" | "OptionsChanged" | "SetupIncomplete";
export const cartItemUnavailableReasons: readonly CartItemUnavailableReason[] = Object.freeze([
  "Unavailable",
  "OptionsChanged",
  "SetupIncomplete",
]);

/** WP-2423 (guest-cart-503): a stable Catalog standing as the guest's reason, or null (retry). */
export function cartItemUnavailableReason(standing: unknown): CartItemUnavailableReason | null {
  return standing === "Unavailable" || standing === "NotOnMenu"
    ? "Unavailable"
    : standing === "OptionsChanged" || standing === "SetupIncomplete"
      ? standing
      : null;
}

/** WP-2423 (guest-cart-503): the guest's own cart line that cannot be sold now. */
export class CartItemUnavailableError extends CartError {
  readonly cartItemReference: OrderingReference;
  readonly reason: CartItemUnavailableReason;
  constructor(cartItemReference: OrderingReference, reason: CartItemUnavailableReason) {
    super("CART_ITEM_UNAVAILABLE");
    this.name = "CartItemUnavailableError";
    this.cartItemReference = cartItemReference;
    this.reason = reason;
  }
}

/**
 * WP-2423 (cart-unsellable-dishes): why Catalog refused the dish a guest is adding or changing.
 * `OptionNotOffered`: a chosen option is not offered right now (choose another); `NotAvailable`:
 * the dish itself can't be had now (hidden, sold out, every choice of a required group off, or its
 * menu setup broken); `Other`: the choices don't fit the dish's rules.
 */
export type CartSelectionRejectedReason = "OptionNotOffered" | "NotAvailable" | "Other";
const cartSelectionRejectedReasons: readonly CartSelectionRejectedReason[] = Object.freeze([
  "OptionNotOffered",
  "NotAvailable",
  "Other",
]);
/** WP-2423 (cart-unsellable-dishes): a refused selection, with why (still CART_SELECTION_INVALID). */
export class CartSelectionRejectedError extends CartError {
  readonly reason: CartSelectionRejectedReason;
  constructor(reason: CartSelectionRejectedReason) {
    super("CART_SELECTION_INVALID");
    this.name = "CartSelectionRejectedError";
    this.reason = reason;
  }
}

/** The reason of a CartSelectionRejectedError (either copy); null for any other error. */
export function readCartSelectionRejected(error: unknown): CartSelectionRejectedReason | null {
  const found = readCartError(error);
  if (found === null || found.code !== "CART_SELECTION_INVALID") return null;
  const reason = (found as Partial<CartSelectionRejectedError>).reason;
  return reason !== undefined && cartSelectionRejectedReasons.includes(reason) ? reason : null;
}

/**
 * The CartError an edge maps, also when the deployed entry loads this package as a second copy
 * (then `instanceof` fails, as customer-dining-cart-composition notes): matched by name and a known
 * code. Anything else is null.
 */
export function readCartError(error: unknown): CartError | null {
  if (error instanceof CartError) return error;
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (
    (error.name !== "CartError" &&
      error.name !== "CartItemUnavailableError" &&
      error.name !== "CartSelectionRejectedError" &&
      error.name !== "CartCheckoutInProgressError" &&
      error.name !== "CartParticipationEndedError") ||
    typeof code !== "string" ||
    !(cartErrorCodes as readonly string[]).includes(code)
  )
    return null;
  return error as CartError;
}

/** The unavailable line of a CartItemUnavailableError (either copy), or null. */
export function readCartItemUnavailable(
  error: unknown,
): { cartItemReference: OrderingReference; reason: CartItemUnavailableReason } | null {
  const found = readCartError(error);
  if (found === null || found.code !== "CART_ITEM_UNAVAILABLE") return null;
  const raw = found as Partial<CartItemUnavailableError>;
  try {
    const reason = raw.reason;
    if (reason === undefined || !cartItemUnavailableReasons.includes(reason)) return null;
    return { cartItemReference: parseOrderingReference(raw.cartItemReference), reason };
  } catch {
    return null;
  }
}

/** Owner-supplied current read (Dining) of another participant's checkout hold on a Cart version. */
export interface DiningCartCheckoutHoldPort {
  read(input: {
    readonly diningSessionReference: string;
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly participantReference: string;
    readonly observedAt: string;
  }): Promise<Readonly<{ heldUntil: string }> | null>;
}

/** Throws CartCheckoutInProgressError when another participant's checkout holds the version. */
export async function assertDiningCartNotHeld(
  hold: DiningCartCheckoutHoldPort | undefined,
  input: Parameters<DiningCartCheckoutHoldPort["read"]>[0],
): Promise<void> {
  if (hold === undefined) return;
  let held: Readonly<{ heldUntil: string }> | null;
  try {
    held = await hold.read(Object.freeze({ ...input }));
  } catch {
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
  if (held === null) return;
  const heldUntil = held.heldUntil;
  if (typeof heldUntil !== "string" || !instantPattern.test(heldUntil))
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  throw new CartCheckoutInProgressError(heldUntil);
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

/**
 * WP-2423: the application host and the database run on separate clocks. A Checkout authority is
 * observed on the application clock and checked again inside the owning transaction on the
 * database clock (`clock_timestamp()`); an ordering check between the two ("observed no later
 * than now") allows this much skew in either direction. Expiry is never extended by it: a
 * Session's deadlines are database facts compared with the database clock, and the in-transaction
 * re-authorization is the authority, not the earlier observation.
 */
export const ORDERING_CLOCK_SKEW_ALLOWANCE_MS = 2000;

/** `earlier` (one clock) is no later than `later` (the other clock), within the skew allowance. */
export function orderingInstantNotAfterAcrossClocks(earlier: string, later: string): boolean {
  return (
    Date.parse(parseOrderingInstant(earlier)) <=
    Date.parse(parseOrderingInstant(later)) + ORDERING_CLOCK_SKEW_ALLOWANCE_MS
  );
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
