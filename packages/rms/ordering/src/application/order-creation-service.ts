import { validateAuditRecord } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import type { StoreBusinessDateResolution } from "@rms/store";
import { createOrderCreatedEnvelope } from "./order-created-event.js";
import {
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import {
  CheckoutValidationError,
  parseCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
import {
  OrderCreationError,
  parseOrderCreationRecord,
  type CreateOrderResult,
  type OrderCreationRecord,
} from "../domain/order-creation.js";
import { createOrderItemSnapshots, OrderItemSnapshotError } from "../domain/order-item-snapshot.js";
import { createOrderNumberAllocation } from "../domain/order-number.js";
import { createOrderAggregate, OrderError } from "../domain/order.js";
import type { OrderCreationPorts } from "./ports/order-creation-ports.js";

function fail(code: ConstructorParameters<typeof OrderCreationError>[0]): never {
  throw new OrderCreationError(code);
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return fail("ORDER_CREATE_INPUT_INVALID");
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("ORDER_CREATE_INPUT_INVALID");
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return fail("ORDER_CREATE_INPUT_INVALID");
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderCreationError) throw error;
    return fail("ORDER_CREATE_INPUT_INVALID");
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return fail("ORDER_CREATE_INPUT_INVALID");
  return value as number;
}

function dependency(error: unknown): never {
  if (error instanceof CheckoutValidationError || error instanceof OrderCreationError) throw error;
  if (
    (error instanceof OrderError && error.code === "ORDER_VALIDATION_EXPIRED") ||
    (error instanceof OrderItemSnapshotError &&
      error.code === "ORDER_ITEM_SNAPSHOT_VALIDATION_EXPIRED")
  )
    return fail("ORDER_CREATE_VALIDATION_EXPIRED");
  return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
}

function reference(
  ports: OrderCreationPorts,
  purpose: Parameters<typeof ports.references.generate>[0],
) {
  try {
    return parseOrderingReference(ports.references.generate(purpose));
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function session(value: GuestSession, observedAt: OrderingInstant): GuestSession {
  try {
    return assertGuestSessionUsable(createGuestSession(value), observedAt);
  } catch {
    return fail("ORDER_CREATE_PERMISSION_DENIED");
  }
}

function sessionReference(value: GuestSession): OrderingReference {
  try {
    return parseOrderingReference(value.sessionReference);
  } catch {
    return fail("ORDER_CREATE_PERMISSION_DENIED");
  }
}

function authorizedForEvidence(value: GuestSession, evidence: CheckoutValidationEvidence): void {
  try {
    if (
      parseOrderingReference(value.sessionReference) !== evidence.guestSessionReference ||
      parseOrderingReference(value.brandReference) !== evidence.brandReference ||
      parseOrderingReference(value.storeReference) !== evidence.storeReference ||
      value.channel !== evidence.orderType ||
      !["Qr", "Web"].includes(evidence.sourceChannel)
    )
      throw new Error("denied");
  } catch {
    return fail("ORDER_CREATE_PERMISSION_DENIED");
  }
}

function intentHash(
  ports: OrderCreationPorts,
  input: {
    submissionReference: OrderingReference;
    cartReference: OrderingReference;
    expectedCartVersion: number;
    quoteReference: OrderingReference;
  },
) {
  try {
    return parseOrderingHash(
      ports.references.hashIntent(
        `CreateOrder:${JSON.stringify({
          submissionReference: input.submissionReference,
          cartReference: input.cartReference,
          expectedCartVersion: input.expectedCartVersion,
          quoteReference: input.quoteReference,
        })}`,
      ),
    );
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function sourceSnapshotDigest(
  ports: OrderCreationPorts,
  record: Omit<OrderCreationRecord, "orderNumberAllocation">,
  resolution: StoreBusinessDateResolution,
) {
  try {
    const order = record.order;
    const batch = order.batches[0];
    return parseOrderingHash(
      ports.references.hashIntent(
        `OrderCreatedSource:v1:${JSON.stringify({
          orderReference: order.orderReference,
          brandReference: order.brandReference,
          storeReference: order.storeReference,
          submissionReference: record.submissionReference,
          orderBatchReference: batch.orderBatchReference,
          orderType: order.orderType,
          sourceChannel: order.sourceChannel,
          aggregateVersion: order.aggregateVersion,
          createdAt: record.createdAt,
          businessDate: resolution.businessDate,
          items: record.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            catalogSnapshotDigest: item.catalog.snapshotDigest,
            quoteInputDigest: item.pricing.quoteInputDigest,
            quantity: item.quantity,
            totalAmountMinor: item.pricing.total.amountMinor.toString(),
            currencyCode: item.pricing.total.currencyCode,
          })),
        })}`,
      ),
    );
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function verifyReplay(
  priorValue: unknown,
  expected: {
    submissionReference: OrderingReference;
    submissionIntentHash: string;
    guestSessionReference: OrderingReference;
  },
  ports: OrderCreationPorts,
): OrderCreationRecord {
  try {
    const prior = parseOrderCreationRecord(priorValue);
    if (
      prior.submissionReference !== expected.submissionReference ||
      prior.guestSessionReference !== expected.guestSessionReference ||
      !ports.references.equals(prior.submissionIntentHash, expected.submissionIntentHash)
    )
      return fail("ORDER_CREATE_IDEMPOTENCY_CONFLICT");
    return prior;
  } catch (error) {
    if (error instanceof OrderCreationError) throw error;
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function sourceScope(
  source: { cart: unknown; lines: readonly unknown[] },
  evidence: CheckoutValidationEvidence,
): CartAggregate {
  try {
    const cart = parseCartAggregate(source.cart);
    if (
      cart.cartReference !== evidence.cartReference ||
      cart.brandReference !== evidence.brandReference ||
      cart.storeReference !== evidence.storeReference ||
      cart.aggregateVersion !== evidence.cartVersion ||
      cart.orderType !== evidence.orderType ||
      cart.sourceChannel !== evidence.sourceChannel ||
      !Array.isArray(source.lines) ||
      source.lines.length !== cart.items.length
    )
      throw new Error("scope mismatch");
    return cart;
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function businessDate(
  value: StoreBusinessDateResolution,
  orderReference: OrderingReference,
  requestedAt: OrderingInstant,
  evidence: CheckoutValidationEvidence,
): StoreBusinessDateResolution {
  try {
    const verified = createOrderNumberAllocation({
      orderReference,
      allocatedAt: requestedAt,
      sequence: 1n,
      businessDateResolution: value,
    }).businessDateResolution;
    if (
      String(verified.brandReference) !== String(evidence.brandReference) ||
      String(verified.storeReference) !== String(evidence.storeReference)
    )
      throw new Error("scope mismatch");
    return verified;
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

function audit(value: unknown, order: OrderCreationRecord["order"], at: OrderingInstant) {
  try {
    const parsed = validateAuditRecord(value as never, Date.parse(at));
    if (
      parsed.brandId !== order.brandReference ||
      parsed.storeId !== order.storeReference ||
      parsed.actor.type !== "System" ||
      parsed.actionCode !== "ORDERING_ORDER_CREATE" ||
      parsed.targetType !== "OrderingOrder" ||
      parsed.targetId !== order.orderReference ||
      parsed.beforeSummary !== undefined ||
      parsed.afterSummary !== undefined ||
      parsed.reasonCode !== "AUTHORIZED_ORDER_CREATE" ||
      parsed.occurredAt !== at ||
      parsed.sourceChannel !== "CUSTOMER_PWA" ||
      parsed.dataClassification !== "Restricted"
    )
      throw new Error("denied");
    return parsed;
  } catch {
    return fail("ORDER_CREATE_PERMISSION_DENIED");
  }
}

function verifySaved(
  value: unknown,
  expected: Omit<OrderCreationRecord, "orderNumberAllocation">,
  ports: OrderCreationPorts,
): OrderCreationRecord {
  try {
    const saved = parseOrderCreationRecord(value);
    if (
      saved.submissionReference !== expected.submissionReference ||
      saved.guestSessionReference !== expected.guestSessionReference ||
      saved.order.orderReference !== expected.order.orderReference ||
      saved.order.batches[0].orderBatchReference !==
        expected.order.batches[0].orderBatchReference ||
      saved.items.length !== expected.items.length ||
      !ports.references.equals(saved.submissionIntentHash, expected.submissionIntentHash)
    )
      throw new Error("mismatch");
    return saved;
  } catch {
    return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  }
}

export function createOrderCreationService(ports: OrderCreationPorts) {
  return Object.freeze({
    async create(value: unknown): Promise<CreateOrderResult> {
      const raw = exact(value, [
        "submissionReference",
        "cartReference",
        "expectedCartVersion",
        "quoteReference",
        "requestedAt",
      ]);
      let submissionReference: OrderingReference;
      let cartReference: OrderingReference;
      let quoteReference: OrderingReference;
      let requestedAt: OrderingInstant;
      try {
        submissionReference = parseOrderingReference(raw.submissionReference);
        cartReference = parseOrderingReference(raw.cartReference);
        quoteReference = parseOrderingReference(raw.quoteReference);
        requestedAt = parseOrderingInstant(raw.requestedAt);
      } catch {
        return fail("ORDER_CREATE_INPUT_INVALID");
      }
      const expectedCartVersion = version(raw.expectedCartVersion);
      const submissionIntentHash = intentHash(ports, {
        submissionReference,
        cartReference,
        expectedCartVersion,
        quoteReference,
      });
      const authorized = await ports.authorization
        .authorize({
          action: "CreateOrder",
          submissionReference,
          cartReference,
          observedAt: requestedAt,
        })
        .catch(dependency);
      if (authorized === null) return fail("ORDER_CREATE_PERMISSION_DENIED");
      const guestSession = session(authorized.guestSession, requestedAt);
      const guestSessionReference = sessionReference(guestSession);
      const prior = await ports.repository.resolveSubmission(submissionReference).catch(dependency);
      if (prior !== null)
        return Object.freeze({
          status: "AlreadyCreated" as const,
          record: verifyReplay(
            prior,
            { submissionReference, submissionIntentHash, guestSessionReference },
            ports,
          ),
        });

      const validationReference = reference(ports, "CheckoutValidation");
      const checkoutEvidence = await ports.checkout
        .validate({
          validationReference,
          cartReference,
          expectedCartVersion,
          quoteReference,
          requestedAt,
        })
        .catch(dependency);
      let evidence: CheckoutValidationEvidence;
      try {
        evidence = parseCheckoutValidationEvidence(checkoutEvidence);
      } catch {
        return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
      }
      authorizedForEvidence(guestSession, evidence);
      const loaded = await ports.source.load({ evidence }).catch(dependency);
      const sourceCart = sourceScope(loaded, evidence);
      const orderReference = reference(ports, "Order");
      const orderBatchReference = reference(ports, "OrderBatch");
      const itemInputs = loaded.lines.map((line) => ({
        orderItemReference: reference(ports, "OrderItem"),
        cartItemReference: line.cartItemReference,
        catalog: line.catalog,
        pricing: line.pricing,
      }));
      let items;
      let order;
      try {
        items = createOrderItemSnapshots({
          orderReference,
          orderBatchReference,
          snapshotCapturedAt: requestedAt,
          checkoutValidationEvidence: evidence,
          cart: sourceCart,
          lines: itemInputs,
        });
        order = createOrderAggregate({
          orderReference,
          orderBatchReference,
          submissionReference,
          diningSessionReference: sourceCart.diningSessionReference,
          createdByActorReference: sourceCart.createdByActorReference,
          submittedByActorReference: guestSessionReference,
          submittedAt: requestedAt,
          checkoutValidationEvidence: evidence,
          items: items.map((item) => ({
            orderItemReference: item.orderItemReference,
            cartItemReference: item.cartItemReference,
          })),
        });
      } catch (error) {
        return dependency(error);
      }
      const resolution = await ports.businessDate
        .resolve({
          brandReference: evidence.brandReference,
          storeReference: evidence.storeReference,
          occurredAt: requestedAt,
        })
        .then((value) => businessDate(value, orderReference, requestedAt, evidence))
        .catch(dependency);
      const provisional = Object.freeze({
        submissionReference,
        submissionIntentHash,
        guestSessionReference,
        order,
        items,
        createdAt: requestedAt,
      });
      const auditEvidence = await ports.audit
        .create({
          order,
          submissionReference,
          observedAt: requestedAt,
        })
        .then((value) => audit(value, order, requestedAt))
        .catch(dependency);
      let event;
      try {
        event = createOrderCreatedEnvelope({
          eventReference: reference(ports, "Event"),
          correlationReference: auditEvidence.correlationId,
          sourceSnapshotDigest: sourceSnapshotDigest(ports, provisional, resolution),
          businessDate: resolution.businessDate,
          record: provisional,
        });
      } catch {
        return fail("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
      }
      const saved = await ports.repository
        .commit({
          record: provisional,
          businessDateResolution: resolution,
          audit: auditEvidence,
          event,
        })
        .catch(dependency);
      return Object.freeze({
        status: "Created" as const,
        record: verifySaved(saved, provisional, ports),
      });
    },
  });
}
