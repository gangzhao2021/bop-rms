import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import {
  DiningTableCheckoutError,
  diningTableCheckoutPermission,
  scopeOf,
} from "./merchant-dining-table-checkout.js";
import {
  DiningTableOnlinePaymentError,
  type createDiningTableOnlinePayments,
} from "./dining-table-online-payment.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER S4: staff stop a phone payment a guest gave up on, so the table
 * can be paid another way. The Provider is asked first: a payment the guest did finish is recorded
 * as the table's payment; an unfinished one is cancelled with the Provider and recorded as such,
 * with who stopped it. One that is still being processed is left alone (try again shortly).
 */
export function createMerchantDiningTableOnlinePaymentStop(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  payments(scope: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
  }): ReturnType<typeof createDiningTableOnlinePayments>;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    let session: string;
    try {
      session = String(
        parseDiningReference(
          readClosedRecord(input.command, ["diningSessionReference"]).diningSessionReference,
        ),
      );
    } catch {
      throw new DiningTableCheckoutError("TABLE_CHECKOUT_INPUT_INVALID");
    }
    const staffIn = (tx: ConsumerTransaction) =>
      resolve(
        tx as never,
        input.sessionCookie,
        diningTableCheckoutPermission,
        authenticated.sessionReference,
      );
    const first = await options.persistence.transactions.run(async (tx) => {
      const current = await staffIn(tx as unknown as ConsumerTransaction).catch(() => null);
      if (current === null || (await current.allowed()) !== true) return null;
      return { scope: scopeOf(current), actorReference: String(current.actorReference) };
    });
    if (first === null) throw new DiningTableCheckoutError("TABLE_CHECKOUT_PERMISSION_DENIED");
    try {
      const view = await options.payments(first.scope).stop(
        {
          diningSessionReference: session,
          guestSessionReference: null,
          allowed: async (tx) => {
            const current = await staffIn(tx).catch(() => null);
            return (
              current !== null &&
              String(current.actorReference) === first.actorReference &&
              (await current.allowed()) === true
            );
          },
        },
        first.actorReference,
      );
      return Object.freeze({ status: "Stopped" as const, bill: view.bill });
    } catch (error) {
      if (
        error instanceof DiningTableOnlinePaymentError &&
        error.code === "TABLE_ONLINE_PAYMENT_STILL_PROCESSING"
      )
        throw new DiningTableCheckoutError("TABLE_CHECKOUT_GUEST_PAYING");
      throw error instanceof DiningTableCheckoutError
        ? error
        : new DiningTableCheckoutError("TABLE_CHECKOUT_UNAVAILABLE");
    }
  };
}
