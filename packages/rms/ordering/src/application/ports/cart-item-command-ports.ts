import type { CartItemPresentationSnapshot } from "../cart-item-presentation-snapshot.js";
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
  readonly presentationSnapshot?: CartItemPresentationSnapshot;
  readonly occurredAt: OrderingInstant;
  readonly expiresAt: OrderingInstant;
}

export interface CartItemCommandPorts {
  readonly presentation?: {
    prepare(result: CartAggregate): Promise<unknown>;
  };
  readonly catalog: {
    validateSelection(
      input: ValidateCatalogSelectionInput,
    ): Promise<CatalogSelectionValidationResult>;
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
