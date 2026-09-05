import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type {
  CartAggregate,
  OrderingHash,
  OrderingInstant,
  OrderingReference,
} from "../../domain/cart.js";

export interface CustomerCartOwner {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderType: "Pickup" | "DineIn";
  readonly ownerReference: OrderingReference;
}

export interface CustomerCartCreationRecord {
  readonly operationReference: OrderingReference;
  readonly operationIntentHash: OrderingHash;
  readonly guestSessionReference: OrderingReference;
  readonly owner: CustomerCartOwner;
  readonly outcome: "Created" | "Current";
  readonly aggregate: CartAggregate;
  readonly occurredAt: OrderingInstant;
  readonly expiresAt: OrderingInstant;
}

export interface CustomerCartTransaction {
  resolveOperation(
    operationReference: OrderingReference,
  ): Promise<CustomerCartCreationRecord | null>;
  loadCurrent(): Promise<CartAggregate | null>;
  // One atomic commit of the Cart (only for Created), ownership, immutable operation and Audit.
  // Current must still identify the same version read under the owner lock.
  commit(record: CustomerCartCreationRecord, audit: AppendAuditRecordInput): Promise<void>;
}

export interface CustomerCartPorts {
  readonly authorization: {
    // The composition verifies the credential and, for Create, CSRF. No raw credential enters Ordering.
    authorize(input: {
      readonly action: "Create" | "Current";
      readonly observedAt: OrderingInstant;
    }): Promise<GuestSession | null>;
  };
  readonly policy: {
    resolve(owner: CustomerCartOwner): Promise<{
      readonly policyVersionReference: string;
      readonly policyDigest: string;
      readonly idleTimeoutSeconds: number;
      readonly absoluteTimeoutSeconds: number;
      readonly sourceChannel: "Qr" | "Web";
    } | null>;
  };
  readonly references: {
    generate(purpose: "Cart"): string;
    hashIntent(value: string): string;
  };
  readonly audit: {
    prepare(input: {
      readonly owner: CustomerCartOwner;
      readonly cartReference: OrderingReference;
      readonly operationReference: OrderingReference;
      readonly occurredAt: OrderingInstant;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly repository: {
    // Dedicated scoped transaction: serialize owner AND scoped operation key before invoking action;
    // hold locks until commit, rollback every effect on failure, resolve only after commit, no retry.
    run<T>(
      owner: CustomerCartOwner,
      operationReference: OrderingReference | null,
      action: (transaction: CustomerCartTransaction) => Promise<T>,
    ): Promise<T>;
  };
}
