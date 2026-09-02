import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  LotExpiryProjection,
  LotExpiryQuery,
  LotHoldAction,
  LotHoldCommand,
  LotHoldCommandRecord,
} from "../../contracts/lot-expiry.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { LotHoldAggregate } from "../../domain/lot-hold.js";
import type { MovementStockScope } from "../../domain/stock-movement.js";

export interface LotExpiryPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "LotExpiryRead" | "LotHoldManagement";
      readonly permission: "inventory.manage";
      readonly action: LotHoldAction | "List" | "Trace";
      readonly stockScope: MovementStockScope;
    }): Promise<{
      readonly authorized: true;
      readonly mayViewSupplierTrace?: boolean;
      readonly mayOpenComplianceTrace?: boolean;
      readonly mayManageHold?: boolean;
    } | null>;
  };
  readonly projection: {
    query(input: LotExpiryQuery): Promise<LotExpiryProjection>;
  };
  readonly snapshot: {
    /** Rebinds the exact scoped Item, lot, expiry, Balance and current hold state. */
    inspect(command: LotHoldCommand): Promise<unknown>;
  };
  readonly compliance: {
    /** Resolves an authorized public Compliance decision only; never a private Compliance row. */
    resolveDecision(command: LotHoldCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(operationReference: InventoryReference): Promise<LotHoldCommandRecord | null>;
    load(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly stockScope: MovementStockScope;
      readonly lotReference: InventoryReference;
      readonly locationReference: InventoryReference;
    }): Promise<LotHoldAggregate | null>;
    commit(record: LotHoldCommandRecord): Promise<LotHoldCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: LotHoldCommand;
      readonly before: LotHoldAggregate | null;
      readonly after: LotHoldAggregate;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "LotHold"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
