import { parseOrderingInstant, parseOrderingReference } from "./cart.js";
import { summarizeOrderItemProgress, type OrderItemProgressFact } from "./order-item-progress.js";
import type { OrderStatusCanonicalPhase } from "./order-status-projection.js";

/**
 * Kitchen facts Ordering keeps in its own inbox record (WP-2423, DEC-PILOT-BATCH-PHASE-01).
 * Started: a dish's preparation began. Ready: a dish was fully made. BatchReady: every dish of the
 * Batch's kitchen ticket was made. Made / NotMade: a manager closed a stale ticket and the open dish
 * was (Made) or was not (NotMade) prepared.
 */
export const orderKitchenProgressFactKinds = [
  "Started",
  "Ready",
  "BatchReady",
  "Made",
  "NotMade",
] as const;
export type OrderKitchenProgressFactKind = (typeof orderKitchenProgressFactKinds)[number];

export interface OrderKitchenProgressFact {
  readonly orderBatchReference: string;
  /** Null only for BatchReady. */
  readonly orderItemReference: string | null;
  readonly kind: OrderKitchenProgressFactKind;
  readonly occurredAt: string;
}

/** Ordering's own append-only owner records for one Order, read under the caller's fence. */
export interface OrderCanonicalPhaseOwnerFacts {
  readonly items: readonly {
    readonly orderItemReference: string;
    readonly orderBatchReference: string;
  }[];
  /** Batches with an acceptance record (the source of OrderConfirmed). */
  readonly acceptedBatches: readonly string[];
  /** Batches cancelled as a whole: unpaid checkout cancellation or staff Batch cancellation. */
  readonly cancelledBatches: readonly string[];
  /** Lines staff cancelled while their Batch stayed open. */
  readonly cancelledItems: readonly string[];
  /** Whole-Order termination record, if any. */
  readonly termination: null | { readonly phase: "Cancelled" | "Rejected" };
  /** A pickup fulfillment completion record exists (the Order was collected). */
  readonly fulfilled: boolean;
  /**
   * The ready pickup was closed by staff as not collected (Fulfillment's PickupNotCollected). A
   * staff termination of the Order (Handoff 24.8 `Cancelled`, reason kept by Fulfillment); it never
   * outranks a recorded collection.
   */
  readonly notCollected?: boolean;
}

export class OrderCanonicalPhaseError extends Error {
  readonly code = "ORDER_CANONICAL_PHASE_INVALID" as const;
  constructor() {
    super("order phase facts are invalid");
    this.name = "OrderCanonicalPhaseError";
  }
}
function invalid(): never {
  throw new OrderCanonicalPhaseError();
}

const toCanonical = {
  Submitted: "Submitted",
  Accepted: "Accepted",
  InProgress: "In Progress",
  Ready: "Ready",
  Fulfilled: "Fulfilled",
  Rejected: "Rejected",
  Cancelled: "Cancelled",
} as const satisfies Record<OrderItemProgressFact["phase"], OrderStatusCanonicalPhase>;

/**
 * Dine-in delivery facts the caller read from the Dining owner's public served-quantity reader
 * under the same fence (Dining publishes no events). Lists only the Order's items whose whole
 * ordered quantity was served; a partly served item is not listed.
 */
export interface OrderDeliveredItemFacts {
  readonly servedItems: readonly string[];
}

/**
 * DEC-PILOT-BATCH-PHASE-01: the Order's overall phase merged from its Batches' and items' facts.
 * Pure and order-independent: facts may arrive in any order or be replayed and give the same result,
 * so a redelivered or late Kitchen event can never move the phase backwards. Grants no command
 * permission and never closes an Order. Rule 2: every remaining (not cancelled) item delivered —
 * a collected pickup, or every dine-in item served — is Fulfilled.
 */
export function resolveOrderCanonicalPhase(
  owner: OrderCanonicalPhaseOwnerFacts,
  kitchen: readonly OrderKitchenProgressFact[],
  delivered: OrderDeliveredItemFacts | null = null,
): {
  readonly canonicalPhase: OrderStatusCanonicalPhase;
  readonly everAccepted: boolean;
  readonly everStarted: boolean;
} {
  try {
    if (!Array.isArray(owner.items) || owner.items.length === 0 || owner.items.length > 10000)
      return invalid();
    const batchOf = new Map<string, string>();
    for (const item of owner.items) {
      const reference = parseOrderingReference(item.orderItemReference);
      if (batchOf.has(reference)) return invalid();
      batchOf.set(reference, parseOrderingReference(item.orderBatchReference));
    }
    const batches = new Set(batchOf.values());
    const known = (batch: string) => batches.has(parseOrderingReference(batch)) || invalid();
    const accepted = new Set(owner.acceptedBatches.filter(known));
    const cancelledBatches = new Set(owner.cancelledBatches.filter(known));
    const cancelledItems = new Set(
      owner.cancelledItems.map((item) => (batchOf.has(item) ? item : invalid())),
    );
    if (
      owner.termination !== null &&
      owner.termination.phase !== "Cancelled" &&
      owner.termination.phase !== "Rejected"
    )
      return invalid();
    if (typeof owner.fulfilled !== "boolean") return invalid();
    const notCollected = owner.notCollected ?? false;
    if (typeof notCollected !== "boolean") return invalid();
    if (delivered !== null && !Array.isArray(delivered.servedItems)) return invalid();
    const served = new Set<string>(
      (delivered?.servedItems ?? []).map((value): string => {
        const item = parseOrderingReference(value);
        return batchOf.has(item) ? item : invalid();
      }),
    );

    const started = new Set<string>();
    const made = new Set<string>();
    const notMade = new Set<string>();
    const readyBatches = new Set<string>();
    for (const fact of kitchen) {
      parseOrderingInstant(fact.occurredAt);
      const batch = parseOrderingReference(fact.orderBatchReference);
      known(batch);
      if (fact.kind === "BatchReady") {
        if (fact.orderItemReference !== null) return invalid();
        readyBatches.add(batch);
        continue;
      }
      const item = parseOrderingReference(fact.orderItemReference);
      if (batchOf.get(item) !== batch) return invalid();
      if (fact.kind === "Started") started.add(item);
      else if (fact.kind === "Ready" || fact.kind === "Made") made.add(item);
      else if (fact.kind === "NotMade") notMade.add(item);
      else return invalid();
    }

    const items: OrderItemProgressFact[] = [];
    for (const [orderItemReference, batch] of batchOf) {
      const isMade = made.has(orderItemReference) || readyBatches.has(batch);
      const everStarted = isMade || started.has(orderItemReference);
      // Kitchen work exists only for accepted Batches; the acceptance record is the authority.
      const everAccepted = accepted.has(batch) || everStarted;
      const itemCancelled =
        cancelledBatches.has(batch) ||
        cancelledItems.has(orderItemReference) ||
        notMade.has(orderItemReference);
      let phase: OrderItemProgressFact["phase"];
      if ((owner.fulfilled || served.has(orderItemReference)) && !itemCancelled)
        phase = "Fulfilled";
      else if (owner.termination !== null)
        phase = owner.termination.phase === "Rejected" && !everAccepted ? "Rejected" : "Cancelled";
      else if (itemCancelled || notCollected) phase = "Cancelled";
      else if (isMade) phase = "Ready";
      else if (everStarted) phase = "InProgress";
      else if (everAccepted) phase = "Accepted";
      else phase = "Submitted";
      // A collected pickup or served dish was accepted even when no kitchen fact was recorded.
      items.push({
        orderItemReference,
        phase,
        everAccepted: everAccepted || phase === "Fulfilled",
        everStarted,
      });
    }
    const summary = summarizeOrderItemProgress(items);
    return Object.freeze({
      canonicalPhase: toCanonical[summary.phase],
      everAccepted: summary.everAccepted,
      everStarted: summary.everStarted,
    });
  } catch (error) {
    if (error instanceof OrderCanonicalPhaseError) throw error;
    return invalid();
  }
}
