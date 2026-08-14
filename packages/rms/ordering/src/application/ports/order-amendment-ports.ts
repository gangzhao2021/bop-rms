import type { AppendAuditRecordInput } from "@bop/audit";
import type {
  AmendmentChange,
  AmendmentCode,
  AmendmentDigest,
  AmendmentReference,
  OrderAmendment,
} from "../../domain/order-amendment.js";

export type OrderAmendmentAction =
  "Submit" | "ConfirmKitchen" | "RejectKitchen" | "Approve" | "Abort";
export interface OrderAmendedEvent {
  readonly eventType: "OrderAmended";
  readonly amendmentReference: AmendmentReference;
  readonly orderReference: AmendmentReference;
  readonly brandReference: AmendmentReference;
  readonly storeReference: AmendmentReference;
  readonly aggregateVersion: string;
  readonly amendmentKind: AmendmentChange["kind"];
  readonly quoteReference: AmendmentReference;
  readonly quoteVersion: string;
  readonly deltaMinor: string;
  readonly currencyCode: string;
  readonly occurredAt: string;
}
export interface OrderAmendmentOperationRecord {
  readonly operationReference: AmendmentReference;
  readonly operationIntentHash: AmendmentDigest;
  readonly amendment: OrderAmendment;
  readonly audit: AppendAuditRecordInput;
  readonly event: OrderAmendedEvent | null;
}
export interface OrderAmendmentPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: OrderAmendmentAction;
      readonly amendmentReference: AmendmentReference;
      readonly orderReference: AmendmentReference;
      readonly observedAt: string;
    }): Promise<null | {
      readonly tenantReference: AmendmentReference;
      readonly brandReference: AmendmentReference;
      readonly storeReference: AmendmentReference;
      readonly actorReference: AmendmentReference;
      readonly purpose: "order-amendment";
      readonly permission: {
        readonly effect: "Allow" | "Deny";
        readonly action:
          "ordering.order.amend" | "ordering.order.amend.approve" | "kitchen.amendment.resolve";
        readonly scopeKind: "Store";
      };
      readonly audit: AppendAuditRecordInput;
    }>;
  };
  readonly source: {
    load(input: {
      readonly orderReference: AmendmentReference;
      readonly brandReference: AmendmentReference;
      readonly storeReference: AmendmentReference;
      readonly change: AmendmentChange;
    }): Promise<{
      readonly aggregateVersion: number;
      readonly canonicalPhase:
        "Submitted" | "Accepted" | "InPreparation" | "Ready" | "Fulfilled" | "Closed";
      readonly closureStatus: "Open" | "Closed";
      readonly currencyCode: string;
      readonly totalMinor: string;
      readonly targetEligible: boolean;
    }>;
  };
  readonly impact: {
    assess(input: {
      readonly orderReference: AmendmentReference;
      readonly change: AmendmentChange;
      readonly expectedOrderVersion: number;
    }): Promise<{
      readonly kitchenStatus: OrderAmendment["kitchenStatus"];
      readonly fulfillmentStatus: OrderAmendment["fulfillmentStatus"];
      readonly approvalRequired: boolean;
      readonly customerNoticeCode: AmendmentCode;
    }>;
  };
  readonly pricing: {
    reprice(input: {
      readonly orderReference: AmendmentReference;
      readonly expectedOrderVersion: number;
      readonly change: AmendmentChange;
      readonly originalTotalMinor: string;
      readonly currencyCode: string;
    }): Promise<{
      readonly quoteReference: AmendmentReference;
      readonly quoteVersion: number;
      readonly quoteInputDigest: AmendmentDigest;
      readonly originalTotalMinor: string;
      readonly revisedTotalMinor: string;
      readonly currencyCode: string;
    }>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(
      operationReference: AmendmentReference,
    ): Promise<OrderAmendmentOperationRecord | null>;
    load(amendmentReference: AmendmentReference): Promise<OrderAmendment | null>;
    commit(record: OrderAmendmentOperationRecord): Promise<void>;
  };
}
