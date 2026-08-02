import type { AppendAuditRecordInput } from "@bop/audit";
import type { GuestSession } from "@bop/identity";
import type { PriceQuoteSnapshot } from "@rms/pricing";
import type { CartQuoteAttachment } from "../../domain/cart-quote-attachment.js";
import type {
  CartAggregate,
  CatalogSelectionEvidence,
  OrderingHash,
  OrderingInstant,
  OrderingReference,
} from "../../domain/cart.js";

export interface PricingCartLineInput {
  readonly lineReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly quantity: number;
  readonly optionSelections: CartAggregate["items"][number]["optionSelections"];
  readonly catalogSelectionEvidence: CatalogSelectionEvidence;
}

export interface PricingCartInput {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly cartReference: OrderingReference;
  readonly cartVersion: number;
  readonly sourceChannel: CartAggregate["sourceChannel"];
  readonly orderType: CartAggregate["orderType"];
  readonly lines: readonly PricingCartLineInput[];
  readonly requestedAt: OrderingInstant;
}

export interface CartQuoteAttachmentPorts {
  readonly pricing: {
    quoteCart(input: PricingCartInput): Promise<PriceQuoteSnapshot>;
  };
  readonly authorization: {
    authorize(input: {
      readonly action: "AttachQuote";
      readonly cartReference: OrderingReference;
      readonly operationReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<{
      readonly guestSession: GuestSession;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: OrderingHash, right: OrderingHash): boolean;
  };
  readonly repository: {
    resolveOperation(operationReference: OrderingReference): Promise<CartQuoteAttachment | null>;
    loadCart(cartReference: OrderingReference): Promise<CartAggregate | null>;
    attach(input: {
      readonly attachment: CartQuoteAttachment;
      readonly expectedCartVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<CartQuoteAttachment>;
  };
}
