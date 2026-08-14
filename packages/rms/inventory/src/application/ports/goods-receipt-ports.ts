import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  GoodsReceiptCommand,
  GoodsReceiptCommandRecord,
  GoodsReceiptProjection,
  GoodsReceiptQuery,
} from "../../contracts/goods-receipt.js";
import type {
  GoodsReceipt,
  GoodsReceiptCorrectionLine,
  GoodsReceiptLine,
} from "../../domain/goods-receipt.js";
import type { InventoryReference } from "../../domain/inventory-item.js";

export interface GoodsReceiptPorts {
  readonly authorization: {
    authorize(input: GoodsReceiptCommand | GoodsReceiptQuery): Promise<{
      readonly authorized: true;
      readonly mayViewCost?: boolean;
      readonly mayViewEvidence?: boolean;
      readonly mayViewTemperature?: boolean;
    } | null>;
  };
  readonly projection: { query(input: GoodsReceiptQuery): Promise<GoodsReceiptProjection> };
  readonly procurement: {
    /** Public contract only; never a Procurement private-table read. */ receivingSnapshot(
      command: GoodsReceiptCommand,
    ): Promise<unknown>;
  };
  readonly approvals: {
    validate(reference: InventoryReference, command: GoodsReceiptCommand): Promise<unknown>;
  };
  readonly evidence: {
    validate(
      references: readonly InventoryReference[],
      command: GoodsReceiptCommand,
    ): Promise<unknown>;
  };
  readonly ledger: {
    /** Prepares exact accepted movement facts; repository.commit is the atomic boundary. */
    preparePost(input: {
      readonly receipt: GoodsReceipt;
      readonly lines: readonly GoodsReceiptLine[];
      readonly command: GoodsReceiptCommand;
    }): Promise<
      {
        readonly receiptLineReference: InventoryReference;
        readonly movementReference: InventoryReference;
      }[]
    >;
    /** Prepares exact compensating facts without editing the original movement. */
    prepareCorrection(input: {
      readonly receipt: GoodsReceipt;
      readonly command: GoodsReceiptCommand;
      readonly correctionType: "Adjustment" | "Void";
      readonly correctionReference: InventoryReference;
      readonly reasonCode: string;
      readonly lines: readonly GoodsReceiptCorrectionLine[];
    }): Promise<readonly InventoryReference[]>;
  };
  readonly repository: {
    resolveOperation(reference: InventoryReference): Promise<GoodsReceiptCommandRecord | null>;
    load(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly stockSiteReference: InventoryReference;
      readonly goodsReceiptReference: InventoryReference;
    }): Promise<GoodsReceipt | null>;
    commit(record: GoodsReceiptCommandRecord): Promise<GoodsReceiptCommandRecord>;
  };
  readonly audit: {
    create(input: {
      readonly command: GoodsReceiptCommand;
      readonly before: GoodsReceipt | null;
      readonly after: GoodsReceipt;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
