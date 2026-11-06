import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import {
  CartError,
  CartSelectionRejectedError,
  cartItemUnavailableReason,
  parseCartAggregate,
  parseCartItem,
  parseCatalogSelectionEvidence,
  parseCustomerNote,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type CartOptionSelection,
  type CatalogSelectionEvidence,
  type OrderingInstant,
  type OrderingReference,
  isGuestCartChannel,
} from "../domain/cart.js";
import { advanceCartLifecycle, assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type {
  CartItemCommandPorts,
  CartItemOperationAction,
  CartItemOperationRecord,
} from "./ports/cart-item-command-ports.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const parsed: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
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

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function failure(error: unknown): never {
  if (
    error instanceof CartError &&
    ["CART_VERSION_CONFLICT", "CART_IDEMPOTENCY_CONFLICT"].includes(error.code)
  )
    throw error;
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}

function intentHash(ports: CartItemCommandPorts, action: CartItemOperationAction, raw: unknown) {
  return parseOrderingHash(ports.references.hashIntent(`${action}:${JSON.stringify(raw)}`));
}

function expiresAt(occurredAt: OrderingInstant): OrderingInstant {
  return parseOrderingInstant(new Date(Date.parse(occurredAt) + dayMilliseconds).toISOString());
}

function audit(
  evidence: AppendAuditRecordInput,
  action: CartItemOperationAction,
  cart: CartAggregate,
  at: OrderingInstant,
) {
  try {
    const parsed = validateAuditRecord(evidence, Date.parse(at));
    if (
      parsed.brandId !== cart.brandReference ||
      parsed.storeId !== cart.storeReference ||
      parsed.actor.type !== "System" ||
      parsed.actionCode !== `ORDERING_CART_ITEM_${action.toUpperCase()}` ||
      parsed.targetType !== "OrderingCart" ||
      parsed.targetId !== cart.cartReference ||
      parsed.beforeSummary !== undefined ||
      parsed.afterSummary !== undefined ||
      parsed.reasonCode !== "AUTHORIZED_CART_MUTATION" ||
      parsed.occurredAt !== at ||
      parsed.sourceChannel !== "CUSTOMER_PWA" ||
      parsed.dataClassification !== "Restricted"
    )
      throw new Error("denied");
    return parsed;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function authorizeSession(
  value: GuestSession,
  cart: CartAggregate,
  at: OrderingInstant,
): GuestSession {
  try {
    const session = assertGuestSessionUsable(createGuestSession(value), at);
    const sessionBrandReference = parseOrderingReference(session.brandReference);
    const sessionStoreReference = parseOrderingReference(session.storeReference);
    const sessionReference = parseOrderingReference(session.sessionReference);
    const diningSessionReference =
      session.diningSessionReference === null
        ? null
        : parseOrderingReference(session.diningSessionReference);
    if (
      sessionBrandReference !== cart.brandReference ||
      sessionStoreReference !== cart.storeReference ||
      session.channel !== cart.orderType ||
      !isGuestCartChannel(cart.orderType, cart.sourceChannel) ||
      (cart.orderType === "Pickup" &&
        (sessionReference !== cart.createdByActorReference ||
          session.diningState !== "ContextOnly" ||
          session.diningSessionReference !== null ||
          session.diningParticipantReference !== null)) ||
      (cart.orderType === "DineIn" &&
        (session.diningState !== "DiningBound" ||
          diningSessionReference !== cart.diningSessionReference ||
          session.diningParticipantReference === null))
    )
      throw new Error("denied");
    return session;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

async function context(
  ports: CartItemCommandPorts,
  action: CartItemOperationAction,
  cartReference: OrderingReference,
  operationReference: OrderingReference,
  at: OrderingInstant,
) {
  const evidence = await ports.authorization
    .authorize({ action, cartReference, operationReference, observedAt: at })
    .catch(failure);
  if (evidence === null) throw new CartError("CART_PERMISSION_DENIED");
  let usableSession: GuestSession;
  try {
    usableSession = assertGuestSessionUsable(createGuestSession(evidence.guestSession), at);
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
  const cart = await ports.repository.load(cartReference).catch(failure);
  if (cart === null) throw new CartError("CART_UNAVAILABLE");
  const aggregate = parseCartAggregate(cart);
  if (aggregate.cartReference !== cartReference) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  const session = authorizeSession(usableSession, aggregate, at);
  return Object.freeze({ aggregate, session, audit: audit(evidence.audit, action, aggregate, at) });
}

async function replay(
  ports: CartItemCommandPorts,
  input: {
    action: CartItemOperationAction;
    operationReference: OrderingReference;
    intentAt: (at: OrderingInstant) => ReturnType<typeof parseOrderingHash>;
    cartReference: OrderingReference;
    guestSessionReference: OrderingReference;
    requestedAt: OrderingInstant;
  },
) {
  const prior = await ports.repository.resolveOperation(input.operationReference).catch(failure);
  if (prior === null) return null;
  try {
    const result = parseCartAggregate(prior.result);
    // Preserve stored digest encoding; only the original observation belongs to that record.
    if (
      prior.action !== input.action ||
      prior.operationReference !== input.operationReference ||
      prior.cartReference !== input.cartReference ||
      prior.guestSessionReference !== input.guestSessionReference ||
      !ports.references.equals(
        prior.operationIntentHash,
        input.intentAt(parseOrderingInstant(prior.occurredAt)),
      ) ||
      Date.parse(input.requestedAt) >= Date.parse(parseOrderingInstant(prior.expiresAt))
    )
      throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "AlreadyApplied" as const,
      cartItemReference: prior.cartItemReference,
      aggregate: result,
    });
  } catch (error) {
    if (error instanceof CartError) throw error;
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

function verify(
  saved: CartItemOperationRecord,
  expected: CartItemOperationRecord,
  ports: CartItemCommandPorts,
  intentAt: (at: OrderingInstant) => ReturnType<typeof parseOrderingHash>,
) {
  try {
    const result = parseCartAggregate(saved.result);
    if (
      saved.action !== expected.action ||
      saved.operationReference !== expected.operationReference ||
      saved.guestSessionReference !== expected.guestSessionReference ||
      saved.cartReference !== expected.cartReference ||
      (expected.action !== "Add" && saved.cartItemReference !== expected.cartItemReference) ||
      (expected.action === "Add" &&
        result.items.find((item) => item.cartItemReference === saved.cartItemReference)
          ?.addedByActorReference !== expected.guestSessionReference) ||
      !ports.references.equals(
        saved.operationIntentHash,
        intentAt(parseOrderingInstant(saved.occurredAt)),
      ) ||
      result.cartReference !== expected.result.cartReference ||
      result.brandReference !== expected.result.brandReference ||
      result.storeReference !== expected.result.storeReference ||
      result.aggregateVersion !== expected.result.aggregateVersion
    )
      throw new Error("bad result");
    return result;
  } catch {
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

function selections(value: unknown): readonly CartOptionSelection[] {
  const candidate = parseCartItem({
    cartItemReference: "018f5000-0000-7000-8000-000000000001",
    cartReference: "018f5000-0000-7000-8000-000000000002",
    sellableReference: "018f5000-0000-7000-8000-000000000003",
    quantity: 1,
    optionSelections: value,
    customerNote: null,
    catalogSelectionEvidence: null,
    addedByActorReference: "018f5000-0000-7000-8000-000000000004",
    addedByParticipantReference: null,
    addedAt: "2026-08-02T00:00:00.000Z",
  }).optionSelections;
  return candidate;
}

function itemQuantity(value: unknown): number {
  return parseCartItem({
    cartItemReference: "018f5000-0000-7000-8000-000000000001",
    cartReference: "018f5000-0000-7000-8000-000000000002",
    sellableReference: "018f5000-0000-7000-8000-000000000003",
    quantity: value,
    optionSelections: [],
    customerNote: null,
    catalogSelectionEvidence: null,
    addedByActorReference: "018f5000-0000-7000-8000-000000000004",
    addedByParticipantReference: null,
    addedAt: "2026-08-02T00:00:00.000Z",
  }).quantity;
}

function sameSelections(
  left: readonly CartOptionSelection[],
  right: readonly { readonly optionReference: string; readonly quantity: number }[],
) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.optionReference === right[index]?.optionReference &&
        item.quantity === right[index]?.quantity,
    )
  );
}

/**
 * What Catalog says about one cart line now: its evidence when it can still be sold as selected,
 * CART_SELECTION_INVALID when not. The one check for a line added, changed or carried over a new
 * menu version.
 */
export async function validatedCatalogEvidence(
  catalog: CartItemCommandPorts["catalog"],
  cart: CartAggregate,
  sellableReference: OrderingReference,
  optionSelections: readonly CartOptionSelection[],
  observedAt: OrderingInstant,
  quantity: number,
  guestSessionReference: OrderingReference,
): Promise<CatalogSelectionEvidence> {
  let result;
  const selection = {
    brandReference: cart.brandReference as never,
    storeReference: cart.storeReference as never,
    sourceChannel: cart.sourceChannel,
    orderType: cart.orderType,
    sellableReference: sellableReference as never,
    optionSelections: optionSelections as never,
    observedAt: observedAt as never,
  };
  /**
   * WP-2423 (cart-unsellable-dishes): why this one dish can't be had as chosen, from a stable
   * Catalog standing only; null when there is none (or no standing source) so the caller keeps
   * its own answer.
   */
  const standing = async (): Promise<"NotAvailable" | "SoldOut" | "OptionsChanged" | null> => {
    if (catalog.explainMany === undefined) return null;
    try {
      const found = await catalog.explainMany([selection]);
      if (!Array.isArray(found) || found.length !== 1) return null;
      // WP-2423 (M154): the guest is told it is sold out, not only "can't be ordered".
      if (found[0] === "SoldOut") return "SoldOut";
      const reason = cartItemUnavailableReason(found[0]);
      return reason === null
        ? null
        : reason === "OptionsChanged"
          ? "OptionsChanged"
          : "NotAvailable";
    } catch {
      return null;
    }
  };
  try {
    result = await catalog.validateSelection(
      selection,
      Object.freeze({
        diningSessionReference: cart.diningSessionReference,
        cartReference: cart.cartReference,
        cartVersion: cart.aggregateVersion,
        guestSessionReference,
        quantity,
      }),
    );
  } catch {
    // A stable reason (the dish's setup broke, it was hidden) names it; an outage stays retry.
    const reason = await standing();
    if (reason !== null)
      throw new CartSelectionRejectedError(
        reason === "OptionsChanged" ? "OptionNotOffered" : reason,
      );
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
  let rejectedReason: string | null = null;
  try {
    const status = Object.getOwnPropertyDescriptor(result, "status");
    if (status === undefined || !Object.hasOwn(status, "value")) throw new Error("bad result");
    if (status.value === "Rejected") {
      const rejected = exact(result, ["status", "reason"]);
      if (
        ![
          "SELLABLE_UNAVAILABLE",
          "OPTION_NOT_ENABLED",
          "OPTION_QUANTITY_INVALID",
          "RULE_UNSATISFIED",
          "OPTION_CONFLICT",
        ].includes(String(rejected.reason))
      )
        throw new Error("bad result");
      rejectedReason = String(rejected.reason);
      throw new CartError("CART_SELECTION_INVALID");
    }
    const accepted = exact(result, [
      "status",
      "brandReference",
      "storeReference",
      "sourceChannel",
      "orderType",
      "sellableReference",
      "optionSelections",
      "observedAt",
      "menuVersionReference",
      "productVersionReference",
      "catalogChannelCode",
      "catalogOrderTypeCode",
      "ruleEvidence",
      "validatedAt",
    ]);
    if (
      accepted.status !== "Accepted" ||
      parseOrderingReference(accepted.brandReference) !== cart.brandReference ||
      parseOrderingReference(accepted.storeReference) !== cart.storeReference ||
      accepted.sourceChannel !== cart.sourceChannel ||
      accepted.orderType !== cart.orderType ||
      parseOrderingReference(accepted.sellableReference) !== sellableReference ||
      parseOrderingInstant(accepted.observedAt) !== observedAt ||
      !Array.isArray(accepted.optionSelections) ||
      !sameSelections(optionSelections, selections(accepted.optionSelections))
    )
      throw new Error("bad result");
    const evidence = parseCatalogSelectionEvidence({
      menuVersionReference: accepted.menuVersionReference,
      productVersionReference: accepted.productVersionReference,
      catalogChannelCode: accepted.catalogChannelCode,
      catalogOrderTypeCode: accepted.catalogOrderTypeCode,
      ruleEvidence: accepted.ruleEvidence,
      validatedAt: accepted.validatedAt,
    });
    if (evidence === null || evidence.validatedAt !== observedAt) throw new Error("bad result");
    return evidence;
  } catch (error) {
    if (error instanceof CartError && error.code === "CART_SELECTION_INVALID") {
      // WP-2423 (cart-unsellable-dishes): say which kind of refusal it is.
      if (rejectedReason === "OPTION_NOT_ENABLED")
        throw new CartSelectionRejectedError("OptionNotOffered");
      if (rejectedReason === "SELLABLE_UNAVAILABLE" || rejectedReason === "RULE_UNSATISFIED") {
        const reason = await standing();
        if (reason === "NotAvailable") throw new CartSelectionRejectedError("NotAvailable");
        if (reason === "SoldOut") throw new CartSelectionRejectedError("SoldOut");
        // WP-2423 (M154): the dish is sold but its choice rules changed under the guest.
        if (reason === "OptionsChanged" && rejectedReason === "RULE_UNSATISFIED")
          throw new CartSelectionRejectedError("ChoicesChanged");
      }
      throw new CartSelectionRejectedError("Other");
    }
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

function canMutateItem(
  item: CartAggregate["items"][number],
  cart: CartAggregate,
  session: GuestSession,
) {
  return cart.orderType === "DineIn"
    ? item.addedByParticipantReference ===
        (session.diningParticipantReference === null
          ? null
          : parseOrderingReference(session.diningParticipantReference))
    : item.addedByActorReference === parseOrderingReference(session.sessionReference);
}

/**
 * WP-2423 (guest-cart-503): at a table, a line another phone added may be removed by anyone at the
 * table once a stable Catalog fact says it can't be sold now (sold out, off the menu, options no
 * longer fit). Checked inside the command at its own instant; a listing in progress, a Catalog
 * failure or no Catalog answer keeps the remove refused. Only Remove: any other edit stays the
 * adder's. The remove is the ordinary attributed operation (the remover's Guest Session, its own
 * Audit record and the next Cart version), so history stays append-only.
 */
async function removableAsUnsellable(
  ports: CartItemCommandPorts,
  cart: CartAggregate,
  item: CartAggregate["items"][number],
  at: OrderingInstant,
): Promise<boolean> {
  const explain = ports.catalog.explainMany;
  if (cart.orderType !== "DineIn" || explain === undefined) return false;
  try {
    const standings = await explain([
      {
        brandReference: cart.brandReference as never,
        storeReference: cart.storeReference as never,
        sourceChannel: cart.sourceChannel,
        orderType: cart.orderType,
        sellableReference: item.sellableReference as never,
        optionSelections: item.optionSelections as never,
        observedAt: at as never,
      },
    ]);
    return (
      Array.isArray(standings) &&
      standings.length === 1 &&
      cartItemUnavailableReason(standings[0]) !== null
    );
  } catch {
    return false;
  }
}

/**
 * WP-2423 (same-table-ordering): a table line whose adder can no longer act at this table (staff
 * removed the phone, the table QR was replaced, its session ended) may be removed by anyone at the
 * table, so nobody has to pay for a dish no one can take out. Checked inside the command at its own
 * instant, with the full binding check. Update stays the adder's.
 *
 * - `Removable`: an owner records the adder `Gone`.
 * - `AtTable`: the adder is back (or never left); the view the guest saw is stale.
 * - `Unknown`: no answer could be had (an outage, a failure, a malformed answer). Never read as
 *   "no permission": the guest is told to try again.
 * - `NotApplicable`: not a table line with a recorded adder, or no standing source.
 */
export async function adderGoneStanding(
  ports: Pick<CartItemCommandPorts, "adders">,
  cart: CartAggregate,
  item: CartAggregate["items"][number],
  at: OrderingInstant,
): Promise<"Removable" | "AtTable" | "Unknown" | "NotApplicable"> {
  const adders = ports.adders;
  const participant = item.addedByParticipantReference;
  if (
    cart.orderType !== "DineIn" ||
    adders === undefined ||
    participant === null ||
    cart.diningSessionReference === null
  )
    return "NotApplicable";
  try {
    const standings = await adders.standing(
      Object.freeze({
        diningSessionReference: String(cart.diningSessionReference),
        participantReferences: Object.freeze([String(participant)]),
        observedAt: at,
      }),
    );
    if (
      !Array.isArray(standings) ||
      standings.length !== 1 ||
      standings[0]?.participantReference !== String(participant)
    )
      return "Unknown";
    const standing = standings[0]?.standing;
    return standing === "Gone" ? "Removable" : standing === "AtTable" ? "AtTable" : "Unknown";
  } catch {
    return "Unknown";
  }
}

async function commit(
  ports: CartItemCommandPorts,
  input: {
    action: CartItemOperationAction;
    operationReference: OrderingReference;
    intent: ReturnType<typeof parseOrderingHash>;
    intentAt: (at: OrderingInstant) => ReturnType<typeof parseOrderingHash>;
    cartItemReference: OrderingReference;
    aggregate: CartAggregate;
    session: GuestSession;
    at: OrderingInstant;
    expectedVersion: number;
    audit: AppendAuditRecordInput;
  },
) {
  const record: CartItemOperationRecord = Object.freeze({
    action: input.action,
    operationReference: input.operationReference,
    operationIntentHash: input.intent,
    guestSessionReference: parseOrderingReference(input.session.sessionReference),
    cartReference: input.aggregate.cartReference,
    cartItemReference: input.cartItemReference,
    result: input.aggregate,
    occurredAt: input.at,
    expiresAt: expiresAt(input.at),
  });
  const saved = await ports.repository
    .commit({ record, expectedAggregateVersion: input.expectedVersion, audit: input.audit })
    .catch(failure);
  const aggregate = verify(saved, record, ports, input.intentAt);
  return Object.freeze({
    status: "Applied" as const,
    cartItemReference: saved.cartItemReference,
    aggregate,
  });
}

export function createCartItemCommandService(ports: CartItemCommandPorts) {
  return Object.freeze({
    async add(value: unknown) {
      const raw = exact(value, [
        "cartReference",
        "expectedAggregateVersion",
        "sellableReference",
        "quantity",
        "optionSelections",
        "customerNote",
        "operationReference",
        "requestedAt",
      ]);
      const cartReference = parseOrderingReference(raw.cartReference);
      const operationReference = parseOrderingReference(raw.operationReference);
      const requestedAt = parseOrderingInstant(raw.requestedAt);
      const expectedVersion = version(raw.expectedAggregateVersion);
      const sellableReference = parseOrderingReference(raw.sellableReference);
      const quantity = itemQuantity(raw.quantity);
      const optionSelections = selections(raw.optionSelections);
      const customerNote = parseCustomerNote(raw.customerNote);
      const intentAt = (at: OrderingInstant) =>
        intentHash(ports, "Add", {
          cartReference,
          expectedAggregateVersion: expectedVersion,
          sellableReference,
          quantity,
          optionSelections,
          customerNote,
          operationReference,
          requestedAt: at,
        });
      const intent = intentAt(requestedAt);
      const current = await context(ports, "Add", cartReference, operationReference, requestedAt);
      const prior = await replay(ports, {
        action: "Add",
        operationReference,
        intentAt,
        cartReference,
        guestSessionReference: parseOrderingReference(current.session.sessionReference),
        requestedAt,
      });
      if (prior !== null) return prior;
      if (current.aggregate.aggregateVersion !== expectedVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      assertCartLifecycleActive(current.aggregate.lifecycle, requestedAt);
      if (current.aggregate.items.length >= 100) throw new CartError("CART_ITEM_LIMIT_REACHED");
      const selectionEvidence = await validatedCatalogEvidence(
        ports.catalog,
        current.aggregate,
        sellableReference,
        optionSelections,
        requestedAt,
        quantity,
        parseOrderingReference(current.session.sessionReference),
      );
      const cartItemReference = parseOrderingReference(ports.references.generate("CartItem"));
      const item = parseCartItem({
        cartItemReference,
        cartReference,
        sellableReference,
        quantity,
        optionSelections,
        customerNote,
        catalogSelectionEvidence: selectionEvidence,
        addedByActorReference: current.session.sessionReference,
        addedByParticipantReference:
          current.aggregate.orderType === "DineIn"
            ? current.session.diningParticipantReference
            : null,
        addedAt: requestedAt,
      });
      const aggregate = parseCartAggregate({
        ...current.aggregate,
        aggregateVersion: expectedVersion + 1,
        updatedAt: requestedAt,
        lifecycle: advanceCartLifecycle(current.aggregate.lifecycle, requestedAt),
        items: [...current.aggregate.items, item],
      });
      return commit(ports, {
        action: "Add",
        operationReference,
        intent,
        intentAt,
        cartItemReference,
        aggregate,
        session: current.session,
        at: requestedAt,
        expectedVersion,
        audit: current.audit,
      });
    },

    async update(value: unknown) {
      const raw = exact(value, [
        "cartReference",
        "cartItemReference",
        "expectedAggregateVersion",
        "quantity",
        "optionSelections",
        "customerNote",
        "operationReference",
        "requestedAt",
      ]);
      const cartReference = parseOrderingReference(raw.cartReference);
      const cartItemReference = parseOrderingReference(raw.cartItemReference);
      const operationReference = parseOrderingReference(raw.operationReference);
      const requestedAt = parseOrderingInstant(raw.requestedAt);
      const expectedVersion = version(raw.expectedAggregateVersion);
      const quantity = itemQuantity(raw.quantity);
      const optionSelections = selections(raw.optionSelections);
      const customerNote = parseCustomerNote(raw.customerNote);
      const intentAt = (at: OrderingInstant) =>
        intentHash(ports, "Update", {
          cartReference,
          cartItemReference,
          expectedAggregateVersion: expectedVersion,
          quantity,
          optionSelections,
          customerNote,
          operationReference,
          requestedAt: at,
        });
      const intent = intentAt(requestedAt);
      const current = await context(
        ports,
        "Update",
        cartReference,
        operationReference,
        requestedAt,
      );
      const prior = await replay(ports, {
        action: "Update",
        operationReference,
        intentAt,
        cartReference,
        guestSessionReference: parseOrderingReference(current.session.sessionReference),
        requestedAt,
      });
      if (prior !== null) return prior;
      if (current.aggregate.aggregateVersion !== expectedVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      assertCartLifecycleActive(current.aggregate.lifecycle, requestedAt);
      const item = current.aggregate.items.find(
        (candidate) => candidate.cartItemReference === cartItemReference,
      );
      if (item === undefined) throw new CartError("CART_ITEM_NOT_FOUND");
      if (!canMutateItem(item, current.aggregate, current.session))
        throw new CartError("CART_PERMISSION_DENIED");
      const selectionEvidence = await validatedCatalogEvidence(
        ports.catalog,
        current.aggregate,
        item.sellableReference,
        optionSelections,
        requestedAt,
        quantity,
        parseOrderingReference(current.session.sessionReference),
      );
      const replacement = parseCartItem({
        ...item,
        quantity,
        optionSelections,
        customerNote,
        catalogSelectionEvidence: selectionEvidence,
      });
      const aggregate = parseCartAggregate({
        ...current.aggregate,
        aggregateVersion: expectedVersion + 1,
        updatedAt: requestedAt,
        lifecycle: advanceCartLifecycle(current.aggregate.lifecycle, requestedAt),
        items: current.aggregate.items.map((candidate) =>
          candidate.cartItemReference === cartItemReference ? replacement : candidate,
        ),
      });
      return commit(ports, {
        action: "Update",
        operationReference,
        intent,
        intentAt,
        cartItemReference,
        aggregate,
        session: current.session,
        at: requestedAt,
        expectedVersion,
        audit: current.audit,
      });
    },

    async remove(value: unknown) {
      const raw = exact(value, [
        "cartReference",
        "cartItemReference",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const cartReference = parseOrderingReference(raw.cartReference);
      const cartItemReference = parseOrderingReference(raw.cartItemReference);
      const operationReference = parseOrderingReference(raw.operationReference);
      const requestedAt = parseOrderingInstant(raw.requestedAt);
      const expectedVersion = version(raw.expectedAggregateVersion);
      const intentAt = (at: OrderingInstant) =>
        intentHash(ports, "Remove", {
          cartReference,
          cartItemReference,
          expectedAggregateVersion: expectedVersion,
          operationReference,
          requestedAt: at,
        });
      const intent = intentAt(requestedAt);
      const current = await context(
        ports,
        "Remove",
        cartReference,
        operationReference,
        requestedAt,
      );
      const prior = await replay(ports, {
        action: "Remove",
        operationReference,
        intentAt,
        cartReference,
        guestSessionReference: parseOrderingReference(current.session.sessionReference),
        requestedAt,
      });
      if (prior !== null) return prior;
      if (current.aggregate.aggregateVersion !== expectedVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      assertCartLifecycleActive(current.aggregate.lifecycle, requestedAt);
      const item = current.aggregate.items.find(
        (candidate) => candidate.cartItemReference === cartItemReference,
      );
      if (item === undefined) throw new CartError("CART_ITEM_NOT_FOUND");
      if (
        !canMutateItem(item, current.aggregate, current.session) &&
        !(await removableAsUnsellable(ports, current.aggregate, item, requestedAt))
      ) {
        const adder = await adderGoneStanding(ports, current.aggregate, item, requestedAt);
        // The adder is back at the table: the guest's view is stale, so its phone reads again.
        if (adder === "AtTable") throw new CartError("CART_VERSION_CONFLICT");
        // Could not be checked: try again later, never "your session expired".
        if (adder === "Unknown") throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        if (adder !== "Removable") throw new CartError("CART_PERMISSION_DENIED");
      }
      const aggregate = parseCartAggregate({
        ...current.aggregate,
        aggregateVersion: expectedVersion + 1,
        updatedAt: requestedAt,
        lifecycle: advanceCartLifecycle(current.aggregate.lifecycle, requestedAt),
        items: current.aggregate.items.filter(
          (candidate) => candidate.cartItemReference !== cartItemReference,
        ),
      });
      return commit(ports, {
        action: "Remove",
        operationReference,
        intent,
        intentAt,
        cartItemReference,
        aggregate,
        session: current.session,
        at: requestedAt,
        expectedVersion,
        audit: current.audit,
      });
    },
  });
}
