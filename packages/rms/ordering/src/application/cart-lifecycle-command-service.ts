import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { expireCartLifecycle, terminateCartLifecycle } from "../domain/cart-lifecycle.js";
import type {
  CartLifecycleAction,
  CartLifecycleCommandPorts,
  CartLifecycleOperationRecord,
} from "./ports/cart-lifecycle-command-ports.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const parsed: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      parsed[field] = descriptor.value;
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
    [
      "CART_VERSION_CONFLICT",
      "CART_IDEMPOTENCY_CONFLICT",
      "CART_EXPIRATION_NOT_DUE",
      "CART_EXPIRED",
      "CART_ABANDONED",
      "CART_LIFECYCLE_UNAVAILABLE",
    ].includes(error.code)
  )
    throw error;
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}

function guestForCart(
  value: GuestSession,
  cart: CartAggregate,
  observedAt: OrderingInstant,
): GuestSession {
  try {
    const session = assertGuestSessionUsable(createGuestSession(value), observedAt);
    const sessionReference = parseOrderingReference(session.sessionReference);
    if (
      parseOrderingReference(session.brandReference) !== cart.brandReference ||
      parseOrderingReference(session.storeReference) !== cart.storeReference ||
      session.channel !== cart.orderType ||
      !["Qr", "Web"].includes(cart.sourceChannel) ||
      (cart.orderType === "Pickup" &&
        (sessionReference !== cart.createdByActorReference ||
          session.diningState !== "ContextOnly" ||
          session.diningSessionReference !== null ||
          session.diningParticipantReference !== null)) ||
      (cart.orderType === "DineIn" &&
        (session.diningState !== "DiningBound" ||
          session.diningSessionReference === null ||
          parseOrderingReference(session.diningSessionReference) !== cart.diningSessionReference ||
          session.diningParticipantReference === null))
    )
      throw new Error("denied");
    return session;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function audit(
  evidence: AppendAuditRecordInput,
  action: CartLifecycleAction,
  cart: CartAggregate,
  observedAt: OrderingInstant,
) {
  try {
    const parsed = validateAuditRecord(evidence, Date.parse(observedAt));
    if (
      parsed.brandId !== cart.brandReference ||
      parsed.storeId !== cart.storeReference ||
      parsed.actor.type !== "System" ||
      parsed.actionCode !== `ORDERING_CART_${action.toUpperCase()}` ||
      parsed.targetType !== "OrderingCart" ||
      parsed.targetId !== cart.cartReference ||
      parsed.beforeSummary !== undefined ||
      parsed.afterSummary !== undefined ||
      parsed.reasonCode !==
        (action === "Abandon" ? "AUTHORIZED_CART_ABANDONMENT" : "CART_DEADLINE_REACHED") ||
      parsed.occurredAt !== observedAt ||
      parsed.sourceChannel !== (action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM") ||
      parsed.dataClassification !== "Restricted"
    )
      throw new Error("denied");
    return parsed;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function idempotencyExpiry(observedAt: OrderingInstant): OrderingInstant {
  return parseOrderingInstant(new Date(Date.parse(observedAt) + dayMilliseconds).toISOString());
}

function parseRecord(value: CartLifecycleOperationRecord): CartLifecycleOperationRecord {
  let raw: Readonly<Record<string, unknown>>;
  try {
    raw = exact(value, [
      "action",
      "operationReference",
      "operationIntentHash",
      "guestSessionReference",
      "cartReference",
      "result",
      "occurredAt",
      "expiresAt",
    ]);
  } catch {
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
  try {
    const result = parseCartAggregate(raw.result);
    const operationReference = parseOrderingReference(raw.operationReference);
    const occurredAt = parseOrderingInstant(raw.occurredAt);
    const expiresAt = parseOrderingInstant(raw.expiresAt);
    if (
      !["Abandon", "Expire"].includes(String(raw.action)) ||
      parseOrderingReference(raw.cartReference) !== result.cartReference ||
      Date.parse(expiresAt) !== Date.parse(occurredAt) + dayMilliseconds ||
      result.updatedAt !== occurredAt ||
      result.lifecycle === null ||
      (raw.action === "Abandon" && result.lifecycle.status !== "Abandoned") ||
      (raw.action === "Expire" && result.lifecycle.status !== "Expired")
    )
      throw new Error("invalid record");
    return Object.freeze({
      action: raw.action as CartLifecycleAction,
      operationReference,
      operationIntentHash: parseOrderingHash(raw.operationIntentHash),
      guestSessionReference:
        raw.guestSessionReference === null
          ? null
          : parseOrderingReference(raw.guestSessionReference),
      cartReference: result.cartReference,
      result,
      occurredAt,
      expiresAt,
    });
  } catch {
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

async function execute(
  ports: CartLifecycleCommandPorts,
  action: CartLifecycleAction,
  value: unknown,
) {
  const timeField = action === "Abandon" ? "requestedAt" : "evaluatedAt";
  const raw = exact(value, [
    "cartReference",
    "expectedAggregateVersion",
    "operationReference",
    timeField,
  ]);
  const cartReference = parseOrderingReference(raw.cartReference);
  const expectedAggregateVersion = version(raw.expectedAggregateVersion);
  const operationReference = parseOrderingReference(raw.operationReference);
  const observedAt = parseOrderingInstant(raw[timeField]);
  const intentAt = (observedAt: OrderingInstant) =>
    parseOrderingHash(
      ports.references.hashIntent(
        `${action}:${JSON.stringify({ cartReference, expectedAggregateVersion, operationReference, observedAt })}`,
      ),
    );
  const intent = intentAt(observedAt);
  const authorization = await ports.authorization
    .authorize({ action, cartReference, operationReference, observedAt })
    .catch(failure);
  if (authorization === null || (action === "Abandon") !== (authorization.guestSession !== null))
    throw new CartError("CART_PERMISSION_DENIED");
  if (authorization.guestSession !== null) {
    try {
      assertGuestSessionUsable(createGuestSession(authorization.guestSession), observedAt);
    } catch {
      throw new CartError("CART_PERMISSION_DENIED");
    }
  }
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior !== null) {
    const record = parseRecord(prior);
    const sessionReference =
      authorization.guestSession === null
        ? null
        : parseOrderingReference(
            guestForCart(authorization.guestSession, record.result, observedAt).sessionReference,
          );
    if (
      record.operationReference !== operationReference ||
      record.action !== action ||
      record.cartReference !== cartReference ||
      record.result.aggregateVersion !== expectedAggregateVersion + 1 ||
      record.guestSessionReference !== sessionReference ||
      !ports.references.equals(record.operationIntentHash, intentAt(record.occurredAt)) ||
      Date.parse(observedAt) >= Date.parse(record.expiresAt)
    )
      throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    if ((action === "Abandon") !== (authorization.guestSession !== null))
      throw new CartError("CART_PERMISSION_DENIED");
    audit(authorization.audit, action, record.result, observedAt);
    return Object.freeze({ status: "AlreadyApplied" as const, aggregate: record.result });
  }
  const loaded = await ports.repository.load(cartReference).catch(failure);
  if (loaded === null) throw new CartError("CART_UNAVAILABLE");
  const cart = parseCartAggregate(loaded);
  if (cart.cartReference !== cartReference) throw new CartError("CART_UNAVAILABLE");
  let guestSessionReference: OrderingReference | null = null;
  if (action === "Abandon") {
    if (authorization.guestSession === null) throw new CartError("CART_PERMISSION_DENIED");
    guestSessionReference = parseOrderingReference(
      guestForCart(authorization.guestSession, cart, observedAt).sessionReference,
    );
  } else if (authorization.guestSession !== null) {
    throw new CartError("CART_PERMISSION_DENIED");
  }
  const auditRecord = audit(authorization.audit, action, cart, observedAt);
  if (cart.aggregateVersion !== expectedAggregateVersion)
    throw new CartError("CART_VERSION_CONFLICT");
  const lifecycle =
    action === "Abandon"
      ? terminateCartLifecycle(cart.lifecycle, { status: "Abandoned", terminalAt: observedAt })
      : expireCartLifecycle(cart.lifecycle, observedAt);
  const result = parseCartAggregate({
    ...cart,
    aggregateVersion: expectedAggregateVersion + 1,
    updatedAt: observedAt,
    lifecycle,
  });
  const record: CartLifecycleOperationRecord = Object.freeze({
    action,
    operationReference,
    operationIntentHash: intent,
    guestSessionReference,
    cartReference,
    result,
    occurredAt: observedAt,
    expiresAt: idempotencyExpiry(observedAt),
  });
  const saved = await ports.repository
    .commit({ record, expectedAggregateVersion, audit: auditRecord })
    .catch(failure);
  const verified = parseRecord(saved);
  if (
    verified.action !== action ||
    verified.guestSessionReference !== guestSessionReference ||
    verified.occurredAt !== observedAt ||
    JSON.stringify(verified.result) !== JSON.stringify(result) ||
    verified.operationReference !== operationReference ||
    verified.cartReference !== cartReference ||
    verified.result.aggregateVersion !== result.aggregateVersion ||
    !ports.references.equals(verified.operationIntentHash, intent)
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({ status: "Applied" as const, aggregate: verified.result });
}

export function createCartLifecycleCommandService(ports: CartLifecycleCommandPorts) {
  return Object.freeze({
    abandon: (value: unknown) => execute(ports, "Abandon", value),
    expire: (value: unknown) => execute(ports, "Expire", value),
  });
}
