import type {
  StaffOrderEntryAction,
  StaffOrderEntryCommand,
  StaffOrderEntryReceipt,
} from "../../contracts/staff-order-entry.js";
import type { OrderingReference } from "../../domain/cart.js";

export interface StaffOrderEntryPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: OrderingReference;
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly actorReference: OrderingReference;
      readonly purpose: "StaffOrderEntry";
      readonly action: StaffOrderEntryAction;
      readonly requiredPermissions: readonly ["ordering.operate", "ordering.order.create_staff"];
    }): Promise<{ readonly authorized: true; readonly auditReference: OrderingReference } | null>;
  };
  readonly idempotency: {
    resolve(operationReference: OrderingReference): Promise<StaffOrderEntryReceipt | null>;
    commit(receipt: StaffOrderEntryReceipt): Promise<StaffOrderEntryReceipt>;
  };
  readonly sharedContracts: {
    execute(
      input: StaffOrderEntryCommand,
    ): Promise<Omit<StaffOrderEntryReceipt, "intentHash" | "auditReference">>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
