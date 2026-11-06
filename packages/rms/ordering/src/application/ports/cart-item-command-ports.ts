import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type { CatalogSelectionValidationResult, ValidateCatalogSelectionInput } from "@rms/catalog";
import type {
  CartAggregate,
  OrderingHash,
  OrderingInstant,
  OrderingReference,
} from "../../domain/cart.js";

export type CartItemOperationAction = "Add" | "Update" | "Remove";

export interface CartItemOperationRecord {
  readonly action: CartItemOperationAction;
  readonly operationReference: OrderingReference;
  readonly operationIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly cartItemReference: OrderingReference;
  readonly result: CartAggregate;
  readonly occurredAt: OrderingInstant;
  readonly expiresAt: OrderingInstant;
}

/** Trusted context captured after current Guest/Cart authorization. Observations
 * may deny a new mutation; they never establish an Inventory reservation.
 */
export interface CartSelectionContext {
  readonly diningSessionReference: OrderingReference | null;
  readonly cartReference: OrderingReference;
  readonly cartVersion: number;
  readonly guestSessionReference: OrderingReference;
  readonly quantity: number;
}

/**
 * WP-2423 (same-table-ordering): whether the phone that added a table line can still act at this
 * table. `AtTable`: one of its sessions passes the binding check every cart command uses. `Gone`:
 * an owner fact records it left (removed by staff, table QR replaced, moved without following, or
 * its session ended), so the line is stranded. `Unknown`: neither could be shown (an outage);
 * only `Gone` lets another phone remove the line.
 */
export interface CartAdderStandingPort {
  standing(input: {
    readonly diningSessionReference: string;
    readonly participantReferences: readonly string[];
    readonly observedAt: string;
  }): Promise<
    readonly {
      readonly participantReference: string;
      readonly standing: "AtTable" | "Gone" | "Unknown" | (string & {});
    }[]
  >;
}

export interface CartItemCommandPorts {
  /** Optional; without it, or when it fails, another phone's line stays the adder's. */
  readonly adders?: CartAdderStandingPort;
  readonly catalog: {
    validateSelection(
      input: ValidateCatalogSelectionInput,
      context: CartSelectionContext,
    ): Promise<CatalogSelectionValidationResult>;
    /**
     * WP-2423 (guest-cart-503): each line's Catalog standing now (`CatalogLineStanding`). With it, a
     * table guest may remove another phone's line that a stable fact says can't be sold now, so the
     * table is never stuck; without it, or on any other answer, that remove stays refused.
     */
    explainMany?(inputs: readonly ValidateCatalogSelectionInput[]): Promise<readonly unknown[]>;
  };
  readonly authorization: {
    authorize(input: {
      readonly action: CartItemOperationAction;
      readonly cartReference: OrderingReference;
      readonly operationReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<{
      readonly guestSession: GuestSession;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    generate(purpose: "CartItem"): string;
    hashIntent(value: string): string;
    equals(left: OrderingHash, right: OrderingHash): boolean;
  };
  readonly repository: {
    resolveOperation(
      operationReference: OrderingReference,
    ): Promise<CartItemOperationRecord | null>;
    load(cartReference: OrderingReference): Promise<CartAggregate | null>;
    commit(input: {
      readonly record: CartItemOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<CartItemOperationRecord>;
  };
}
