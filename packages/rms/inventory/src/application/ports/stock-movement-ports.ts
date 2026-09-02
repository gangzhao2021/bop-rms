import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  CorrectStockMovementCommand,
  StockMovementCorrectionRecord,
  StockMovementQuery,
} from "../../contracts/stock-movement.js";
import type { InventoryReference } from "../../domain/inventory-item.js";
import type { StockMovementFact } from "../../domain/stock-movement.js";

export interface StockMovementPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "StockMovementRead" | "StockMovementCorrection";
      readonly permission: "inventory.movement.read" | "inventory.movement.correct";
      readonly action: "List" | "Detail" | "Correct";
    }): Promise<{ readonly authorized: true } | null>;
  };
  readonly projection: {
    query(input: StockMovementQuery): Promise<unknown>;
  };
  readonly ledger: {
    resolveOperation(
      operationReference: InventoryReference,
    ): Promise<StockMovementCorrectionRecord | null>;
    load(movementReference: InventoryReference): Promise<unknown | null>;
    findCorrection(movementReference: InventoryReference): Promise<unknown | null>;
    currentBalanceVersion(input: {
      readonly original: StockMovementFact;
      readonly command: CorrectStockMovementCommand;
    }): Promise<number>;
    /** Atomically enforces operation idempotency and one unique correction per original. */
    commitCorrection(input: {
      readonly command: CorrectStockMovementCommand;
      readonly original: StockMovementFact;
      readonly intentHash: string;
      readonly audit: AppendAuditRecordInput;
    }): Promise<StockMovementCorrectionRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: CorrectStockMovementCommand;
      readonly original: StockMovementFact;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
