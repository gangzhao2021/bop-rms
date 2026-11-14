import { validateDomainEventEnvelope, type DomainEventEnvelope } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import type { OrderKitchenProgressFactKind } from "../domain/order-canonical-phase.js";

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: the Kitchen events Ordering consumes to merge preparation
 * progress into the Order phase. Ordering keeps its own reading of the published contract (no
 * Kitchen import); only order/item references, the fact and its time are kept (no actor).
 */
export const orderKitchenProgressEventTypes = [
  "KitchenWorkStarted",
  "KitchenItemReady",
  "KitchenOrderReady",
  "KitchenTicketClosed",
] as const;
export type OrderKitchenProgressEventType = (typeof orderKitchenProgressEventTypes)[number];

export interface OrderKitchenProgressEventFact {
  /** Null when the event names only the item (KitchenWorkStarted); Ordering resolves its Batch. */
  readonly orderBatchReference: string | null;
  readonly orderItemReference: string | null;
  readonly kind: OrderKitchenProgressFactKind;
  readonly occurredAt: string;
}

export interface OrderKitchenProgressEvent {
  readonly eventId: string;
  readonly eventType: OrderKitchenProgressEventType;
  readonly brandReference: string;
  readonly storeReference: string;
  /** Null when the event names only the item. */
  readonly orderReference: string | null;
  readonly facts: readonly OrderKitchenProgressEventFact[];
}

export class OrderKitchenProgressEventError extends Error {
  readonly code = "ORDERING_KITCHEN_PROGRESS_EVENT_INVALID" as const;
  constructor() {
    super("kitchen progress event is invalid");
    this.name = "OrderKitchenProgressEventError";
  }
}
function invalid(): never {
  throw new OrderKitchenProgressEventError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Readonly<Record<string, unknown>>;
}
const version = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) ? value : invalid();
const quantity = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 999
    ? (value as number)
    : invalid();

const aggregateTypes: Record<OrderKitchenProgressEventType, string> = {
  KitchenWorkStarted: "KitchenTicket",
  KitchenItemReady: "KitchenOrderItemReadyResult",
  KitchenOrderReady: "KitchenTicket",
  KitchenTicketClosed: "KitchenTicket",
};

function facts(
  eventType: OrderKitchenProgressEventType,
  payload: unknown,
): Pick<OrderKitchenProgressEvent, "orderReference" | "facts"> {
  if (eventType === "KitchenWorkStarted") {
    const raw = exact(payload, [
      "kitchenTicketReference",
      "kitchenWorkItemReference",
      "orderItemReference",
      "ticketVersion",
      "workItemVersion",
      "fromStatus",
      "toStatus",
      "startedAt",
    ]);
    parseOrderingReference(raw.kitchenTicketReference);
    parseOrderingReference(raw.kitchenWorkItemReference);
    version(raw.ticketVersion);
    version(raw.workItemVersion);
    if (raw.fromStatus !== "Queued" || raw.toStatus !== "In Progress") return invalid();
    return {
      orderReference: null,
      facts: [
        {
          orderBatchReference: null,
          orderItemReference: parseOrderingReference(raw.orderItemReference),
          kind: "Started",
          occurredAt: parseOrderingInstant(raw.startedAt),
        },
      ],
    };
  }
  if (eventType === "KitchenItemReady") {
    const raw = exact(payload, [
      "kitchenTicketReference",
      "orderReference",
      "orderBatchReference",
      "orderItemReference",
      "readyResultReference",
      "readyQuantity",
      "requiredQuantity",
      "readyAt",
    ]);
    parseOrderingReference(raw.kitchenTicketReference);
    parseOrderingReference(raw.readyResultReference);
    if (quantity(raw.readyQuantity) < 1 || raw.readyQuantity !== quantity(raw.requiredQuantity))
      return invalid();
    return {
      orderReference: parseOrderingReference(raw.orderReference),
      facts: [
        {
          orderBatchReference: parseOrderingReference(raw.orderBatchReference),
          orderItemReference: parseOrderingReference(raw.orderItemReference),
          kind: "Ready",
          occurredAt: parseOrderingInstant(raw.readyAt),
        },
      ],
    };
  }
  if (eventType === "KitchenOrderReady") {
    const raw = exact(payload, [
      "kitchenTicketReference",
      "orderReference",
      "orderBatchReference",
      "readyItemCount",
      "itemCount",
      "readyAt",
    ]);
    parseOrderingReference(raw.kitchenTicketReference);
    if (quantity(raw.itemCount) < 1 || raw.readyItemCount !== raw.itemCount) return invalid();
    return {
      orderReference: parseOrderingReference(raw.orderReference),
      facts: [
        {
          orderBatchReference: parseOrderingReference(raw.orderBatchReference),
          orderItemReference: null,
          kind: "BatchReady",
          occurredAt: parseOrderingInstant(raw.readyAt),
        },
      ],
    };
  }
  const raw = exact(payload, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "reasonCode",
    "foodMade",
    "orderBusinessDate",
    "ticketVersion",
    "openWorkItems",
    "closedAt",
  ]);
  parseOrderingReference(raw.kitchenTicketReference);
  version(raw.ticketVersion);
  if (
    !["ALREADY_SERVED", "CANCELLED_ELSEWHERE", "NOT_MADE_ABANDONED"].includes(
      String(raw.reasonCode),
    ) ||
    typeof raw.foodMade !== "boolean" ||
    typeof raw.orderBusinessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(raw.orderBusinessDate) ||
    !Array.isArray(raw.openWorkItems) ||
    raw.openWorkItems.length > 100
  )
    return invalid();
  const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
  const occurredAt = parseOrderingInstant(raw.closedAt);
  const seen = new Set<string>();
  return {
    orderReference: parseOrderingReference(raw.orderReference),
    facts: raw.openWorkItems.map((value: unknown) => {
      const item = exact(value, [
        "kitchenWorkItemReference",
        "orderItemReference",
        "status",
        "requiredQuantity",
        "completedQuantity",
      ]);
      parseOrderingReference(item.kitchenWorkItemReference);
      const orderItemReference = parseOrderingReference(item.orderItemReference);
      if (
        !["Queued", "Held", "In Progress", "Completed"].includes(String(item.status)) ||
        quantity(item.requiredQuantity) < 1 ||
        quantity(item.completedQuantity) > (item.requiredQuantity as number) ||
        seen.has(orderItemReference)
      )
        return invalid();
      seen.add(orderItemReference);
      // A closed ticket's dish counts as made when the manager recorded the food as made (e.g.
      // already served) or the dish was completed; otherwise it was not made (not prepared).
      return {
        orderBatchReference,
        orderItemReference,
        kind: raw.foodMade === true || item.status === "Completed" ? "Made" : "NotMade",
        occurredAt,
      } as const;
    }),
  };
}

export function parseOrderKitchenProgressEnvelope(value: unknown): OrderKitchenProgressEvent {
  try {
    const envelope = validateDomainEventEnvelope(value as DomainEventEnvelope);
    const eventType = envelope.eventType as OrderKitchenProgressEventType;
    if (
      !orderKitchenProgressEventTypes.includes(eventType) ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/kitchen" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== aggregateTypes[eventType]
    )
      return invalid();
    const parsed = facts(eventType, envelope.payload);
    return Object.freeze({
      eventId: parseOrderingReference(envelope.eventId),
      eventType,
      brandReference: parseOrderingReference(envelope.tenantId),
      storeReference: parseOrderingReference(envelope.storeId),
      orderReference: parsed.orderReference,
      facts: Object.freeze(parsed.facts.map((fact) => Object.freeze(fact))),
    });
  } catch (error) {
    if (error instanceof OrderKitchenProgressEventError) throw error;
    return invalid();
  }
}
