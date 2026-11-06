import { createHash } from "node:crypto";
import type { CustomerCartPort, CustomerCartView } from "./customer-cart.js";

/**
 * WP-2423 M03: a pickup Order empties its Cart when it is created (so the same dishes can never be
 * paid twice). When that Order then won't be made — its payment closed unpaid, or it was closed or
 * cancelled — the guest puts its dishes back in the Cart with one tap instead of choosing
 * everything again. Each dish goes back through the ordinary add-to-cart command (current menu,
 * availability and stock, recorded and audited like any add), so a dish that can't be sold now is
 * left out and counted. Each ordered line has one fixed add operation, so pressing again (or a lost
 * answer) never adds a dish twice. Nothing here creates an Order or a charge.
 */
export interface CustomerCartRestoreInput {
  readonly guestCredential: string;
  readonly csrfCredential: string;
  readonly operationReference: string;
  readonly requestedAt: string;
  readonly orderReference: string;
}
export type CustomerCartRestoreResult =
  | {
      readonly status: "Restored";
      readonly view: CustomerCartView;
      /** Dishes put back now or by an earlier press. */
      readonly added: number;
      /** Dishes the Store can't sell now (off the menu, sold out, stock short). */
      readonly unavailable: number;
    }
  /** No such Order of this guest's Cart, or one that is still open or was paid. */
  | { readonly status: "NotRestorable" }
  | { readonly status: "SessionExpired" }
  | { readonly status: "Unavailable" };
export interface CustomerCartRestorePort {
  restore(
    input: CustomerCartRestoreInput,
    displayLocale?: string | null,
  ): Promise<CustomerCartRestoreResult>;
}
export interface CustomerPickupCartRestoreOptions {
  readonly cart: Pick<CustomerCartPort, "getCurrentCart" | "addItem">;
  readonly orders: {
    findRestorable(input: {
      readonly cartReference: string;
      readonly orderReference: string;
    }): Promise<{
      readonly orderNumber: string;
      readonly lines: readonly {
        readonly orderItemReference: string;
        readonly sellableReference: string;
        readonly quantity: number;
        readonly optionSelections: readonly {
          readonly optionReference: string;
          readonly quantity: number;
        }[];
        readonly customerNote: string | null;
      }[];
    } | null>;
  };
}
/** The one add operation that puts this ordered line back (UUIDv7 shape, time bits of the line). */
export function restoreOperationReference(orderItemReference: string): string {
  const h = createHash("sha256")
    .update("PickupCartRestore/v1:" + orderItemReference)
    .digest("hex");
  return (
    orderItemReference.slice(0, 14) +
    "7" +
    h.slice(0, 3) +
    "-8" +
    h.slice(3, 6) +
    "-" +
    h.slice(6, 18)
  );
}
export function createCustomerPickupCartRestore(
  options: CustomerPickupCartRestoreOptions,
): CustomerCartRestorePort {
  return Object.freeze({
    async restore(
      input: CustomerCartRestoreInput,
      displayLocale?: string | null,
    ): Promise<CustomerCartRestoreResult> {
      const locale = displayLocale == null ? [] : ([displayLocale] as [string]);
      const context = { guestCredential: input.guestCredential, requestedAt: input.requestedAt };
      const current = await options.cart.getCurrentCart(context, ...locale);
      if (current.status === "SessionExpired") return { status: "SessionExpired" };
      if (current.status === "NotFound") return { status: "NotRestorable" };
      if (
        current.status !== "Found" &&
        current.status !== "Applied" &&
        current.status !== "Current"
      )
        return { status: "Unavailable" };
      if (current.view.cart.orderType !== "Pickup") return { status: "NotRestorable" };
      const cartReference = current.view.cart.cartReference;
      const order = await options.orders.findRestorable({
        cartReference,
        orderReference: input.orderReference,
      });
      if (order === null) return { status: "NotRestorable" };
      let version = current.view.cart.version;
      let view = current.view;
      let added = 0,
        unavailable = 0;
      for (const line of order.lines) {
        const result = await options.cart.addItem(
          {
            guestCredential: input.guestCredential,
            csrfCredential: input.csrfCredential,
            requestedAt: input.requestedAt,
            operationReference: restoreOperationReference(line.orderItemReference),
            cartReference,
            expectedCartVersion: version,
            sellableReference: line.sellableReference,
            quantity: line.quantity,
            optionSelections: line.optionSelections,
            customerNote: line.customerNote,
          },
          ...locale,
        );
        if (
          result.status === "Applied" ||
          result.status === "Current" ||
          result.status === "Found"
        ) {
          view = result.view;
          version = result.view.cart.version;
          added++;
        } else if (result.status === "IdempotencyConflict") {
          // Put back by an earlier press; the guest may since have changed or removed it.
          added++;
        } else if (result.status === "SelectionInvalid") unavailable++;
        else if (result.status === "SessionExpired") return { status: "SessionExpired" };
        else return { status: "Unavailable" };
      }
      const latest = await options.cart.getCurrentCart(context, ...locale);
      if (latest.status === "Found" || latest.status === "Applied" || latest.status === "Current")
        view = latest.view;
      return { status: "Restored", view, added, unavailable };
    },
  });
}
