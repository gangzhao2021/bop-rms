import type { GuestSession } from "@bop/identity";
import type { CatalogSelectionValidationResult, ValidateCatalogSelectionInput } from "@rms/catalog";
import type { CheckoutFulfillmentValidationResult } from "../../contracts/checkout-validation.js";
import type { CartQuoteAttachment } from "../../domain/cart-quote-attachment.js";
import type { CartAggregate, OrderingInstant, OrderingReference } from "../../domain/cart.js";

/** WP-2423: one Cart line as the stock answer needs it (quantity may be lowered by Ordering). */
export interface CheckoutStockLine {
  readonly cartItemReference: OrderingReference;
  readonly sellableReference: OrderingReference;
  readonly quantity: number;
  readonly optionSelections: readonly {
    readonly optionReference: OrderingReference;
    readonly quantity: number;
  }[];
}

export interface CheckoutValidationPorts<V extends 1 | 2 = 1> {
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
  /**
   * WP-2423: Inventory's answer whether the Store's current stock covers these lines together
   * (each line's recipe demand, as the reservation at submission plans it). Read-only; the lines are
   * this Cart's own lines, some possibly with a lower quantity or left out. Ordering decides what
   * the guest is told; without this port a short Cart is only found at submission.
   */
  readonly stock?: {
    covers(input: {
      readonly lines: readonly CheckoutStockLine[];
      readonly observedAt: OrderingInstant;
    }): Promise<boolean>;
  };
  readonly repository: {
    loadCart(cartReference: OrderingReference): Promise<CartAggregate | null>;
    loadQuote(cartReference: OrderingReference): Promise<CartQuoteAttachment<V> | null>;
  };
}
