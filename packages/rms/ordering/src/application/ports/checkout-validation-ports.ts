import type { GuestSession } from "@bop/identity";
import type { CatalogSelectionValidationResult, ValidateCatalogSelectionInput } from "@rms/catalog";
import type { CheckoutFulfillmentValidationResult } from "../../contracts/checkout-validation.js";
import type { CartQuoteAttachment } from "../../domain/cart-quote-attachment.js";
import type { CartAggregate, OrderingInstant, OrderingReference } from "../../domain/cart.js";

export interface CheckoutValidationPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ValidateCheckout";
      readonly cartReference: OrderingReference;
      readonly validationReference: OrderingReference;
      readonly observedAt: OrderingInstant;
    }): Promise<{ readonly guestSession: GuestSession } | null>;
  };
  readonly catalog: {
    validateSelection(
      input: ValidateCatalogSelectionInput,
    ): Promise<CatalogSelectionValidationResult>;
  };
  readonly fulfillment: {
    validate(input: {
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly cartReference: OrderingReference;
      readonly cartVersion: number;
      readonly quoteReference: OrderingReference;
      readonly orderType: CartAggregate["orderType"];
      readonly sourceChannel: CartAggregate["sourceChannel"];
      readonly observedAt: OrderingInstant;
    }): Promise<CheckoutFulfillmentValidationResult>;
  };
  readonly references: {
    hashIntent(value: string): string;
  };
  readonly repository: {
    loadCart(cartReference: OrderingReference): Promise<CartAggregate | null>;
    loadQuote(cartReference: OrderingReference): Promise<CartQuoteAttachment | null>;
  };
}
