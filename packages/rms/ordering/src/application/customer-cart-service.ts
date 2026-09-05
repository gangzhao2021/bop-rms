import { validateAuditRecord } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
} from "../domain/cart.js";
import { assertCartLifecycleActive, createActiveCartLifecycle } from "../domain/cart-lifecycle.js";
import type {
  CustomerCartCreationRecord,
  CustomerCartOwner,
  CustomerCartPorts,
} from "./ports/customer-cart-ports.js";

const retention = 86_400_000;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new CartError("CART_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    throw new CartError("CART_INPUT_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw new CartError("CART_INPUT_INVALID");
    result[key] = descriptor.value;
  }
  return result;
}

async function authorize(
  ports: CustomerCartPorts,
  action: "Create" | "Current",
  at: OrderingInstant,
) {
  const evidence = await ports.authorization.authorize({ action, observedAt: at });
  try {
    if (evidence === null) throw new Error();
    const session = assertGuestSessionUsable(createGuestSession(evidence), at);
    if (
      (session.channel === "Pickup" &&
        (session.diningState !== "ContextOnly" ||
          session.diningSessionReference !== null ||
          session.diningParticipantReference !== null)) ||
      (session.channel === "DineIn" &&
        (session.diningState !== "DiningBound" ||
          session.diningSessionReference === null ||
          session.diningParticipantReference === null)) ||
      !["Pickup", "DineIn"].includes(session.channel)
    )
      throw new Error();
    const sessionReference = parseOrderingReference(session.sessionReference);
    const owner: CustomerCartOwner = Object.freeze({
      brandReference: parseOrderingReference(session.brandReference),
      storeReference: parseOrderingReference(session.storeReference),
      orderType: session.channel as "Pickup" | "DineIn",
      ownerReference:
        session.channel === "Pickup"
          ? sessionReference
          : parseOrderingReference(session.diningSessionReference),
    });
    if (session.diningParticipantReference !== null)
      parseOrderingReference(session.diningParticipantReference);
    return { owner, sessionReference };
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function sameOwner(left: CustomerCartOwner, right: CustomerCartOwner) {
  return (
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.orderType === right.orderType &&
    left.ownerReference === right.ownerReference
  );
}
function owned(value: unknown, owner: CustomerCartOwner, at: OrderingInstant, active = true) {
  try {
    const cart = parseCartAggregate(value);
    if (
      cart.brandReference !== owner.brandReference ||
      cart.storeReference !== owner.storeReference ||
      cart.orderType !== owner.orderType ||
      !["Qr", "Web"].includes(cart.sourceChannel) ||
      (cart.orderType === "Pickup"
        ? cart.createdByActorReference !== owner.ownerReference
        : cart.diningSessionReference !== owner.ownerReference) ||
      Date.parse(cart.updatedAt) > Date.parse(at)
    )
      throw new Error();
    if (active) assertCartLifecycleActive(cart.lifecycle, at);
    return cart;
  } catch (error) {
    if (
      error instanceof CartError &&
      ["CART_EXPIRED", "CART_ABANDONED", "CART_LIFECYCLE_UNAVAILABLE"].includes(error.code)
    )
      throw error;
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

function replay(
  record: CustomerCartCreationRecord,
  owner: CustomerCartOwner,
  sessionReference: string,
  operationReference: string,
  hash: string,
  at: OrderingInstant,
) {
  if (
    !sameOwner(record.owner, owner) ||
    record.guestSessionReference !== sessionReference ||
    record.operationReference !== operationReference ||
    record.operationIntentHash !== hash ||
    Date.parse(at) >= Date.parse(parseOrderingInstant(record.expiresAt))
  )
    throw new CartError("CART_IDEMPOTENCY_CONFLICT");
  if (
    !["Created", "Current"].includes(record.outcome) ||
    Date.parse(parseOrderingInstant(record.occurredAt)) > Date.parse(at) ||
    Date.parse(record.expiresAt) - Date.parse(record.occurredAt) !== retention
  )
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  // Immutable result is replayed even if its deadlines have since elapsed; it grants no mutation.
  return Object.freeze({
    status: "AlreadyApplied" as const,
    aggregate: owned(record.aggregate, owner, record.occurredAt),
  });
}

async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CartError) throw error;
    throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
  }
}

export function createCustomerCartService(ports: CustomerCartPorts) {
  return Object.freeze({
    current(input: unknown) {
      return safe(async () => {
        const raw = exact(input, ["requestedAt"]);
        const at = parseOrderingInstant(raw.requestedAt);
        const { owner } = await authorize(ports, "Current", at);
        return ports.repository.run(owner, null, async (transaction) => {
          const cart = await transaction.loadCurrent();
          return cart === null
            ? Object.freeze({ status: "NotFound" as const })
            : Object.freeze({ status: "Found" as const, aggregate: owned(cart, owner, at) });
        });
      });
    },
    create(input: unknown) {
      return safe(async () => {
        const raw = exact(input, ["operationReference", "requestedAt"]);
        const operationReference = parseOrderingReference(raw.operationReference);
        const at = parseOrderingInstant(raw.requestedAt);
        const { owner, sessionReference } = await authorize(ports, "Create", at);
        const hash = parseOrderingHash(
          ports.references.hashIntent(
            JSON.stringify([
              "CreateCustomerCart:v1",
              owner.brandReference,
              owner.storeReference,
              owner.orderType,
              owner.ownerReference,
              sessionReference,
            ]),
          ),
        );
        return ports.repository.run(owner, operationReference, async (transaction) => {
          const prior = await transaction.resolveOperation(operationReference);
          if (prior !== null)
            return replay(prior, owner, sessionReference, operationReference, hash, at);
          const current = await transaction.loadCurrent();
          let aggregate: CartAggregate;
          if (current !== null) aggregate = owned(current, owner, at);
          else {
            const policy = await ports.policy.resolve(owner);
            if (policy === null || !["Qr", "Web"].includes(policy.sourceChannel))
              throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
            aggregate = parseCartAggregate({
              cartReference: ports.references.generate("Cart"),
              brandReference: owner.brandReference,
              storeReference: owner.storeReference,
              orderType: owner.orderType,
              sourceChannel: policy.sourceChannel,
              diningSessionReference: owner.orderType === "DineIn" ? owner.ownerReference : null,
              createdByActorReference: sessionReference,
              aggregateVersion: 1,
              createdAt: at,
              updatedAt: at,
              lifecycle: createActiveCartLifecycle({
                policyVersionReference: policy.policyVersionReference,
                policyDigest: policy.policyDigest,
                idleTimeoutSeconds: policy.idleTimeoutSeconds,
                absoluteTimeoutSeconds: policy.absoluteTimeoutSeconds,
                startedAt: at,
              }),
              items: [],
            });
          }
          const evidence = validateAuditRecord(
            await ports.audit.prepare({
              owner,
              cartReference: aggregate.cartReference,
              operationReference,
              occurredAt: at,
            }),
            Date.parse(at),
          );
          if (
            evidence.brandId !== owner.brandReference ||
            evidence.storeId !== owner.storeReference ||
            evidence.actor.type !== "System" ||
            evidence.actionCode !== "ORDERING_CART_CREATE" ||
            evidence.targetType !== "OrderingCart" ||
            evidence.targetId !== aggregate.cartReference ||
            evidence.occurredAt !== at ||
            evidence.sourceChannel !== "CUSTOMER_PWA" ||
            evidence.reasonCode !== "AUTHORIZED_CART_MUTATION" ||
            evidence.dataClassification !== "Restricted" ||
            evidence.beforeSummary !== undefined ||
            evidence.afterSummary !== undefined
          )
            throw new CartError("CART_PERMISSION_DENIED");
          const record: CustomerCartCreationRecord = Object.freeze({
            operationReference,
            operationIntentHash: hash,
            guestSessionReference: sessionReference,
            owner,
            outcome: current === null ? "Created" : "Current",
            aggregate,
            occurredAt: at,
            expiresAt: parseOrderingInstant(new Date(Date.parse(at) + retention).toISOString()),
          });
          await transaction.commit(record, evidence);
          return Object.freeze({ status: record.outcome, aggregate });
        });
      });
    },
  });
}
