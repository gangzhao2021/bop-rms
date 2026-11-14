import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { parseDiningReference } from "@rms/dining";
import { staffContentLocale } from "./staff-content-locale.js";
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
import { onlyRefusal, withCause } from "./merchant-failure.js";

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
      const current = await staffIn(tx as unknown as ConsumerTransaction).catch(
        onlyRefusal(() => null),
      );
      if (current === null || (await current.allowed()) !== true) return null;
      return { scope: scopeOf(current), actorReference: String(current.actorReference) };
    });
    if (first === null) throw new DiningTableCheckoutError("TABLE_CHECKOUT_PERMISSION_DENIED");
    // M89: one staff resolve per transaction, re-checked with its own allowed() (as every other
    // checkout route does): dozens of fresh resolves per bill read were dozens of chances to turn
    // a stop that already happened into a refusal.
    const resolved = new WeakMap<object, ReturnType<typeof staffIn>>();
    const authority = {
      diningSessionReference: session,
      guestSessionReference: null,
      displayLocale: staffContentLocale(),
      allowed: async (tx: ConsumerTransaction) => {
        let found = resolved.get(tx as object);
        if (found === undefined) {
          found = staffIn(tx);
          resolved.set(tx as object, found);
        }
        const current = await found.catch(onlyRefusal(() => null));
        return (
          current !== null &&
          String(current.actorReference) === first.actorReference &&
          (await current.allowed()) === true
        );
      },
    };
    const payments = options.payments(first.scope);
    try {
      await payments.stopAndRecord(authority, first.actorReference);
    } catch (error) {
      if (
        error instanceof DiningTableOnlinePaymentError &&
        error.code === "TABLE_ONLINE_PAYMENT_STILL_PROCESSING"
      )
        throw new DiningTableCheckoutError("TABLE_CHECKOUT_GUEST_PAYING");
      throw error instanceof DiningTableCheckoutError
        ? error
        : withCause(new DiningTableCheckoutError("TABLE_CHECKOUT_UNAVAILABLE"), error);
    }
    // The stop is recorded. A failure of the reply's bill read never reports it as failed or
    // refused: the answer is Stopped without a bill, and the screen reads the bill again.
    const bill = await payments
      .read(authority)
      .then((view) => view.bill)
      .catch(() => null);
    return Object.freeze({ status: "Stopped" as const, bill });
  };
}
