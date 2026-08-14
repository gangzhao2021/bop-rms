import type {
  SupplierAction,
  SupplierCommand,
  SupplierCommandRecord,
  SupplierProjection,
  SupplierQuery,
} from "../../contracts/supplier.js";
import type { SupplierAggregate, SupplierReference } from "../../domain/aggregates/supplier.js";
import type { AppendAuditRecordInput } from "@bop/audit";
export interface SupplierPorts {
  readonly authorization: {
    authorize(input: {
      tenantReference: SupplierReference;
      brandReference: SupplierReference;
      actorReference: SupplierReference;
      purpose: "SupplierRead" | "SupplierManagement";
      permission:
        | "procurement.supplier.read"
        | "procurement.supplier.manage"
        | "procurement.qualification.review";
      action: SupplierAction | "List" | "Detail";
    }): Promise<{
      authorized: true;
      mayViewContactFields?: boolean;
      mayViewQualificationEvidence?: boolean;
      mayViewPurchaseOrderReferences?: boolean;
      mayViewPerformance?: boolean;
      mayManageSupplier?: boolean;
      mayReviewQualification?: boolean;
    } | null>;
  };
  readonly projection: { query(input: SupplierQuery): Promise<SupplierProjection> };
  readonly repository: {
    resolveOperation(reference: SupplierReference): Promise<SupplierCommandRecord | null>;
    load(input: {
      tenantReference: SupplierReference;
      brandReference: SupplierReference;
      supplierReference: SupplierReference;
    }): Promise<SupplierAggregate | null>;
    isCodeAvailable(input: {
      brandReference: SupplierReference;
      supplierCode: string;
      excludingSupplierReference: SupplierReference | null;
    }): Promise<boolean>;
    commit(record: SupplierCommandRecord): Promise<SupplierCommandRecord>;
  };
  readonly qualificationPolicy: {
    evaluateActivation(input: {
      command: SupplierCommand;
      supplier: SupplierAggregate;
    }): Promise<unknown>;
  };
  readonly impact: {
    inspect(input: { command: SupplierCommand; supplier: SupplierAggregate }): Promise<unknown>;
  };
  readonly audit: {
    create(input: {
      command: SupplierCommand;
      before: SupplierAggregate | null;
      after: SupplierAggregate;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "Supplier"): string;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
