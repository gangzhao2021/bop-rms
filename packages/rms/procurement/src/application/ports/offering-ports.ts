import type {
  OfferingCommand,
  OfferingCommandRecord,
  OfferingProjection,
  OfferingQuery,
} from "../../contracts/offering.js";
import type { OfferingReference, SupplierItemOffering } from "../../domain/aggregates/offering.js";

export interface OfferingPorts {
  readonly authorization: {
    authorize(input: {
      tenantReference: OfferingReference;
      brandReference: OfferingReference;
      actorReference: OfferingReference;
      purpose: string;
      permission: string;
      action: string;
    }): Promise<{
      authorized: boolean;
      mayManage: boolean;
      mayApprove: boolean;
      mayPublish: boolean;
      mayViewCost: boolean;
      mayViewQualification: boolean;
      mayViewHistory: boolean;
    }>;
  };
  readonly projection: { query(input: OfferingQuery): Promise<OfferingProjection> };
  readonly repository: {
    resolveOperation(operationReference: OfferingReference): Promise<OfferingCommandRecord | null>;
    load(input: {
      tenantReference: OfferingReference;
      brandReference: OfferingReference;
      offeringReference: OfferingReference;
    }): Promise<SupplierItemOffering | null>;
    identityAvailable(input: {
      brandReference: OfferingReference;
      supplierReference: OfferingReference;
      inventoryItemReference: OfferingReference;
      supplierItemCode: string;
      excludingOfferingReference: OfferingReference | null;
    }): Promise<boolean>;
    commit(record: OfferingCommandRecord): Promise<OfferingCommandRecord>;
  };
  readonly publicationPolicy: {
    validate(input: { command: OfferingCommand; offering: SupplierItemOffering }): Promise<{
      tenantReference: OfferingReference;
      brandReference: OfferingReference;
      offeringReference: OfferingReference;
      offeringVersion: number;
      supplierReference: OfferingReference;
      inventoryItemReference: OfferingReference;
      supplierActive: boolean;
      itemPurchasable: boolean;
      baseUnit: string;
      conversionValid: boolean;
      qualificationEligible: boolean;
      approvedPriceAvailable: boolean;
      approvalReference: OfferingReference;
      approvedAt: string;
      blockers: readonly string[];
    }>;
  };
  readonly priceApproval: {
    validate(input: { command: OfferingCommand; offering: SupplierItemOffering }): Promise<{
      tenantReference: OfferingReference;
      brandReference: OfferingReference;
      offeringReference: OfferingReference;
      offeringVersion: number;
      priceRecordReference: OfferingReference;
      priceVersionReference: OfferingReference;
      approvalReference: OfferingReference;
      approvedAt: string;
      approved: boolean;
    }>;
  };
  readonly impact: {
    inspect(input: { command: OfferingCommand; offering: SupplierItemOffering }): Promise<{
      tenantReference: OfferingReference;
      brandReference: OfferingReference;
      offeringReference: OfferingReference;
      offeringVersion: number;
      openPurchaseOrderCount: number;
      historicalPurchaseOrdersMutated: false;
    }>;
  };
  readonly audit: {
    create(input: {
      command: OfferingCommand;
      before: SupplierItemOffering | null;
      after: SupplierItemOffering;
    }): Promise<{ auditReference: OfferingReference }>;
  };
  readonly references: {
    generate(kind: "Offering"): OfferingReference;
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
}
