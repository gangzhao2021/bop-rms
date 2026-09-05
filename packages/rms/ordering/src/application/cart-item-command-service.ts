import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import {
  CartError,
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
      !["Qr", "Web"].includes(cart.sourceChannel) ||
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
  const cart = await ports.repository.load(cartReference).catch(failure);
  if (cart === null) throw new CartError("CART_UNAVAILABLE");
  const aggregate = parseCartAggregate(cart);
  const evidence = await ports.authorization
    .authorize({ action, cartReference, operationReference, observedAt: at })
    .catch(failure);
  if (evidence === null) throw new CartError("CART_PERMISSION_DENIED");
  const session = authorizeSession(evidence.guestSession, aggregate, at);
  return Object.freeze({ aggregate, session, audit: audit(evidence.audit, action, aggregate, at) });
}

async function replay(
  ports: CartItemCommandPorts,
  input: {
    action: CartItemOperationAction;
    operationReference: OrderingReference;
    intent: ReturnType<typeof parseOrderingHash>;
    cartReference: OrderingReference;
    guestSessionReference: OrderingReference;
    requestedAt: OrderingInstant;
  },
) {
  const prior = await ports.repository.resolveOperation(input.operationReference).catch(failure);
  if (prior === null) return null;
  try {
    const result = parseCartAggregate(prior.result);
    if (
      prior.action !== input.action ||
      prior.operationReference !== input.operationReference ||
      prior.cartReference !== input.cartReference ||
      prior.guestSessionReference !== input.guestSessionReference ||
      !ports.references.equals(prior.operationIntentHash, input.intent) ||
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
) {
  try {
    const result = parseCartAggregate(saved.result);
    if (
      saved.action !== expected.action ||
      saved.operationReference !== expected.operationReference ||
      saved.guestSessionReference !== expected.guestSessionReference ||
      saved.cartReference !== expected.cartReference ||
      saved.cartItemReference !== expected.cartItemReference ||
      !ports.references.equals(saved.operationIntentHash, expected.operationIntentHash) ||
      result.cartReference !== expected.result.cartReference ||
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

async function catalogEvidence(
  ports: CartItemCommandPorts,
  cart: CartAggregate,
  sellableReference: OrderingReference,
  optionSelections: readonly CartOptionSelection[],
  observedAt: OrderingInstant,
): Promise<CatalogSelectionEvidence> {
  let result;
  try {
    result = await ports.catalog.validateSelection({
      brandReference: cart.brandReference as never,
      storeReference: cart.storeReference as never,
      sourceChannel: cart.sourceChannel,
      orderType: cart.orderType,
      sellableReference: sellableReference as never,
      optionSelections: optionSelections as never,
      observedAt: observedAt as never,
    });
  } catch {
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
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
    if (error instanceof CartError && error.code === "CART_SELECTION_INVALID") throw error;
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

async function commit(
  ports: CartItemCommandPorts,
  input: {
    action: CartItemOperationAction;
    operationReference: OrderingReference;
    intent: ReturnType<typeof parseOrderingHash>;
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
  let saved: CartItemOperationRecord;
  try {
    saved = await ports.repository.commit({
      record,
      expectedAggregateVersion: input.expectedVersion,
      audit: input.audit,
    });
  } catch (error) {
    // A competing commit may have saved this exact operation after the initial lookup.
    // Reconcile only a controlled conflict; never retry the mutation or infer a result.
    if (
      error instanceof CartError &&
      ["CART_VERSION_CONFLICT", "CART_IDEMPOTENCY_CONFLICT"].includes(error.code)
    ) {
      const authorized = await context(
        ports,
        input.action,
        input.aggregate.cartReference,
        input.operationReference,
        input.at,
      );
      const prior = await replay(ports, {
        action: input.action,
        operationReference: input.operationReference,
        intent: input.intent,
        cartReference: input.aggregate.cartReference,
        guestSessionReference: parseOrderingReference(authorized.session.sessionReference),
        requestedAt: input.at,
      });
      if (prior !== null) return prior;
    }
    return failure(error);
  }
  return Object.freeze({
    status: "Applied" as const,
    cartItemReference: input.cartItemReference,
    aggregate: verify(saved, record, ports),
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
      const intent = intentHash(ports, "Add", {
        cartReference,
        expectedAggregateVersion: expectedVersion,
        sellableReference,
        quantity,
        optionSelections,
        customerNote,
        operationReference,
      });
      const current = await context(ports, "Add", cartReference, operationReference, requestedAt);
      const prior = await replay(ports, {
        action: "Add",
        operationReference,
        intent,
        cartReference,
        guestSessionReference: parseOrderingReference(current.session.sessionReference),
        requestedAt,
      });
      if (prior !== null) return prior;
      if (current.aggregate.aggregateVersion !== expectedVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      assertCartLifecycleActive(current.aggregate.lifecycle, requestedAt);
      if (current.aggregate.items.length >= 100) throw new CartError("CART_ITEM_LIMIT_REACHED");
      const selectionEvidence = await catalogEvidence(
        ports,
        current.aggregate,
        sellableReference,
        optionSelections,
        requestedAt,
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
      const intent = intentHash(ports, "Update", {
        cartReference,
        cartItemReference,
        expectedAggregateVersion: expectedVersion,
        quantity,
        optionSelections,
        customerNote,
        operationReference,
      });
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
        intent,
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
      const selectionEvidence = await catalogEvidence(
        ports,
        current.aggregate,
        item.sellableReference,
        optionSelections,
        requestedAt,
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
      const intent = intentHash(ports, "Remove", {
        cartReference,
        cartItemReference,
        expectedAggregateVersion: expectedVersion,
        operationReference,
      });
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
        intent,
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
