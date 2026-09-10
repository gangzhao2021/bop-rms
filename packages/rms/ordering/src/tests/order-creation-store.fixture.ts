import { createHash } from "node:crypto";
import { resolveStoreBusinessDate } from "@rms/store";
import {
  createOrderAggregate,
  createOrderItemSnapshots,
  parseCheckoutValidationEvidence,
  parseCartAggregate,
  createOrderCreatedEnvelope,
} from "../index.js";
import { orderCreatedSourceInput } from "../application/order-created-source.js";
import type { OrderCreationPorts } from "../application/ports/order-creation-ports.js";
import { orderSnapshotInput } from "./order-item-snapshot.fixture.js";
export function orderWriteFixture(options: { at?: string; namespace?: string } = {}) {
  const original = orderSnapshotInput();
  const at = options.at ?? new Date(Date.now() - 1000).toISOString();
  const namespace = options.namespace ?? "018f7700";
  const delta = Date.parse(at) - Date.parse(original.snapshotCapturedAt);
  function shift(value: unknown): unknown {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
      return new Date(Date.parse(value) + delta).toISOString();
    if (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    )
      return namespace + value.slice(8);
    if (Array.isArray(value)) return value.map(shift);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v)]));
    return value;
  }
  const input = shift(original) as typeof original;
  const id = (n: number) => namespace + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const evidence = parseCheckoutValidationEvidence(input.checkoutValidationEvidence);
  const cart = parseCartAggregate(input.cart);
  const items = createOrderItemSnapshots(input);
  const order = createOrderAggregate({
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    submissionReference: id(503),
    diningSessionReference: null,
    createdByActorReference: cart.createdByActorReference,
    submittedByActorReference: evidence.guestSessionReference,
    submittedAt: at,
    checkoutValidationEvidence: evidence,
    items: items.map((i) => ({
      orderItemReference: i.orderItemReference,
      cartItemReference: i.cartItemReference,
    })),
  });
  const resolution = resolveStoreBusinessDate({
    occurredAt: at,
    configuration: {
      configurationReference: id(504),
      configurationVersion: 1,
      brandReference: order.brandReference,
      storeReference: order.storeReference,
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
      businessDayStartSource: "PlatformDefault",
      contentDigest: "sha256:" + "a".repeat(64),
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: null,
    },
  });
  const record = {
    submissionReference: order.batches[0].submissionReference,
    submissionIntentHash: hash(
      "CreateOrder:" +
        JSON.stringify({
          submissionReference: id(503),
          cartReference: cart.cartReference,
          expectedCartVersion: cart.aggregateVersion,
          quoteReference: evidence.quoteReference,
        }),
    ) as never,
    guestSessionReference: evidence.guestSessionReference,
    order,
    items,
    createdAt: order.createdAt,
  };
  const request: Parameters<OrderCreationPorts["repository"]["commit"]>[0] = {
    record,
    businessDateResolution: resolution,
    checkoutValidationEvidence: evidence,
    audit: {
      auditId: id(500),
      brandId: order.brandReference,
      storeId: order.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_ORDER_CREATE",
      targetType: "OrderingOrder",
      targetId: order.orderReference,
      reasonCode: "AUTHORIZED_ORDER_CREATE",
      correlationId: id(502),
      occurredAt: at,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_STANDARD",
      retentionPolicyVersion: 1,
    },
    event: createOrderCreatedEnvelope({
      eventReference: id(501),
      correlationReference: id(502),
      sourceSnapshotDigest: hash(orderCreatedSourceInput(record, resolution)),
      businessDate: resolution.businessDate,
      record,
    }),
  };
  return {
    request,
    cart,
    scope: { brandReference: order.brandReference, storeReference: order.storeReference },
  };
}
