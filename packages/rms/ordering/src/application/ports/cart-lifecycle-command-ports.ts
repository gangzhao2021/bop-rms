import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type {
  CartAggregate,
  OrderingHash,
  OrderingInstant,
  OrderingReference,
} from "../../domain/cart.js";

export type CartLifecycleAction = "Abandon" | "Expire";

export interface CartLifecycleOperationRecord {
  readonly action: CartLifecycleAction;
  readonly operationReference: OrderingReference;
  readonly operationIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference | null;
  readonly cartReference: OrderingReference;
  readonly result: CartAggregate;
  readonly occurredAt: OrderingInstant;
  readonly expiresAt: OrderingInstant;
}

export interface CartLifecycleCommandPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: CartLifecycleAction;
      readonly cartReference: OrderingReference;
      readonly operationReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<{
      readonly guestSession: GuestSession | null;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: OrderingHash, right: OrderingHash): boolean;
  };
  readonly repository: {
    resolveOperation(
      operationReference: OrderingReference,
    ): Promise<CartLifecycleOperationRecord | null>;
    load(cartReference: OrderingReference): Promise<CartAggregate | null>;
    commit(input: {
      readonly record: CartLifecycleOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<CartLifecycleOperationRecord>;
  };
}
