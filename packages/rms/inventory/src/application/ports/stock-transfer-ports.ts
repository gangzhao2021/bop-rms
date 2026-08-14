import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  StockTransferAction,
  StockTransferCommand,
  StockTransferCommandRecord,
  StockTransferDetailProjection,
  StockTransferDetailQuery,
  StockTransferListProjection,
  StockTransferListQuery,
  StockTransferPermission,
} from "../../contracts/stock-transfer.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { StockTransferAggregate } from "../../domain/stock-transfer.js";
import type { MovementStockScope } from "../../domain/stock-movement.js";

export interface StockTransferPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "StockTransferManagement" | "StockTransferRead";
      readonly permission: StockTransferPermission;
      readonly action: StockTransferAction | "List" | "Detail";
      readonly sourceScope: MovementStockScope;
      readonly destinationScope: MovementStockScope;
    }): Promise<{ readonly authorized: true } | null>;
  };
  readonly snapshot: {
    /** Rebinds Item, lot, expiry, Unit conversion, source Balance and negative policy for Create/Revise. */
    resolve(command: StockTransferCommand): Promise<unknown>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<StockTransferCommandRecord | null>;
    load(transferReference: InventoryReference): Promise<StockTransferAggregate | null>;
  };
  readonly transaction: {
    /** Atomically commits the command, Audit, Aggregate and any immutable Transfer Movements. */
    commit(input: {
      readonly command: StockTransferCommand;
      readonly before: StockTransferAggregate | null;
      readonly after: StockTransferAggregate;
      readonly intentHash: string;
      readonly audit: AppendAuditRecordInput;
    }): Promise<StockTransferCommandRecord>;
  };
  readonly projection: {
    list(query: StockTransferListQuery): Promise<StockTransferListProjection>;
    detail(query: StockTransferDetailQuery): Promise<StockTransferDetailProjection>;
  };
  readonly audit: {
    create(input: {
      readonly command: StockTransferCommand;
      readonly before: StockTransferAggregate | null;
      readonly after: StockTransferAggregate;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "StockTransfer" | "StockTransferLine"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
