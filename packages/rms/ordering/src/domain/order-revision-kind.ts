/**
 * The single source of truth for Ordering order revision kinds (WP-2423).
 *
 * Every reader and writer of `rms_ordering.order_revision` decides what a revision means from
 * `ORDER_REVISION_KIND_POLICY`, never from its own list of kind strings. Adding a kind to
 * `ORDER_REVISION_KINDS` fails compilation until its policy (and the persistence owner-record
 * binding for its `ownerRecord`) is defined. The database CHECK constraint lives in the latest
 * migration that redefines `order_revision_kind_check`; a unit test keeps the two in step.
 */
export const ORDER_REVISION_KINDS = [
  "Initial",
  "AdditionalBatch",
  "Acceptance",
  "Termination",
  "Fulfillment",
  "BatchCancellation",
  "StaffBatchCancellation",
  "StaffItemCancellation",
] as const;

export type OrderRevisionKind = (typeof ORDER_REVISION_KINDS)[number];

/** The persisted owner record that must describe a revision exactly. Persistence maps each key to
 * its SQL EXISTS predicate with an exhaustive switch. */
export type OrderRevisionOwnerRecord =
  | "InitialSubmission"
  | "AdditionalBatchRecord"
  | "AcceptanceRecord"
  | "TerminationRecord"
  | "FulfillmentCompletionRecord"
  | "CheckoutBatchCancellation"
  | "StaffBatchCancellation"
  | "StaffItemCancellation";

export interface OrderRevisionKindPolicy {
  /** Only the version-1 revision of an Order; never a later revision in the chain. */
  readonly root: boolean;
  /** Ends the Order: no later revision may follow and no further checkout is granted. */
  readonly terminal: boolean;
  /** The table may still order another round (AdditionalBatch) after this revision. */
  readonly continuesDiningOrder: boolean;
  /** Appends one additional Batch (the Initial revision carries the first Batch). */
  readonly addsAdditionalBatch: boolean;
  /** Records the merchant's acceptance (canonical phase becomes Accepted). */
  readonly recordsAcceptance: boolean;
  /** What, if anything, the revision cancels while the Order stays open. */
  readonly cancellation: null | "UnpaidBatch" | "StaffBatch" | "StaffItems";
  readonly ownerRecord: OrderRevisionOwnerRecord;
}

export const ORDER_REVISION_KIND_POLICY = {
  Initial: {
    root: true,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: null,
    ownerRecord: "InitialSubmission",
  },
  AdditionalBatch: {
    root: false,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: true,
    recordsAcceptance: false,
    cancellation: null,
    ownerRecord: "AdditionalBatchRecord",
  },
  Acceptance: {
    root: false,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: false,
    recordsAcceptance: true,
    cancellation: null,
    ownerRecord: "AcceptanceRecord",
  },
  Termination: {
    root: false,
    terminal: true,
    continuesDiningOrder: false,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: null,
    ownerRecord: "TerminationRecord",
  },
  Fulfillment: {
    root: false,
    terminal: true,
    continuesDiningOrder: false,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: null,
    ownerRecord: "FulfillmentCompletionRecord",
  },
  // WP-2423 Q6: the System cancels one unpaid Batch; the table may keep ordering.
  BatchCancellation: {
    root: false,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: "UnpaidBatch",
    ownerRecord: "CheckoutBatchCancellation",
  },
  // WP-2423 Q6: staff cancel one paid, accepted Batch; the dine-in Order stays open.
  StaffBatchCancellation: {
    root: false,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: "StaffBatch",
    ownerRecord: "StaffBatchCancellation",
  },
  // WP-2423 Q6 step 2a: staff cancel item lines of one Batch; the Order stays open.
  StaffItemCancellation: {
    root: false,
    terminal: false,
    continuesDiningOrder: true,
    addsAdditionalBatch: false,
    recordsAcceptance: false,
    cancellation: "StaffItems",
    ownerRecord: "StaffItemCancellation",
  },
} as const satisfies Record<OrderRevisionKind, OrderRevisionKindPolicy>;

type Policy = typeof ORDER_REVISION_KIND_POLICY;
type KindsWhere<Field extends keyof OrderRevisionKindPolicy, Value> = {
  [K in OrderRevisionKind]: Policy[K][Field] extends Value ? K : never;
}[OrderRevisionKind];

/** Kinds that may follow the root revision in a chain. */
export type ChainedOrderRevisionKind = KindsWhere<"root", false>;
export type TerminalOrderRevisionKind = KindsWhere<"terminal", true>;

export function isOrderRevisionKind(value: unknown): value is OrderRevisionKind {
  return typeof value === "string" && (ORDER_REVISION_KINDS as readonly string[]).includes(value);
}

export function orderRevisionKindPolicy(kind: OrderRevisionKind): OrderRevisionKindPolicy {
  return ORDER_REVISION_KIND_POLICY[kind];
}

/** Policy lookup for an untyped persisted kind; unknown kinds have no policy and fail closed. */
export function persistedOrderRevisionKindPolicy(value: unknown): OrderRevisionKindPolicy | null {
  return isOrderRevisionKind(value) ? ORDER_REVISION_KIND_POLICY[value] : null;
}

export function isChainedOrderRevisionKind(value: unknown): value is ChainedOrderRevisionKind {
  return isOrderRevisionKind(value) && !ORDER_REVISION_KIND_POLICY[value].root;
}

export function isTerminalOrderRevisionKind(value: unknown): value is TerminalOrderRevisionKind {
  return isOrderRevisionKind(value) && ORDER_REVISION_KIND_POLICY[value].terminal;
}

/** Kinds matching a policy predicate, in canonical order. */
export function orderRevisionKindsWhere(
  predicate: (policy: OrderRevisionKindPolicy, kind: OrderRevisionKind) => boolean,
): readonly OrderRevisionKind[] {
  return ORDER_REVISION_KINDS.filter((kind) => predicate(ORDER_REVISION_KIND_POLICY[kind], kind));
}
