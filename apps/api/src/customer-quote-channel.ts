import {
  assertGuestSessionUsable,
  createGuestSession,
  GuestSessionError,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionService,
} from "@bop/identity";
import { parseOrderingInstant, parseOrderingReference } from "@rms/ordering";
import type { CustomerQuotePort, QuoteCartCommand } from "./customer-quote.js";
import { readStoreTipChoices } from "./merchant-store-features.js";

/** Current credential/CSRF selects the channel; each quote owner retains its
 * current Cart/participant authorization and original-operation recovery.
 */
export function createCustomerQuoteChannelPort(options: {
  scope: Readonly<{ brandReference: string; storeReference: string }>;
  sessions: Pick<GuestSessionService, "authorize">;
  now: () => string;
  pickup: CustomerQuotePort;
  dining: CustomerQuotePort;
  /**
   * WP-2423 item 8 ⑦: reads the Store's tip choices for the priced Cart (absent: the quote says
   * nothing about tips). Unreadable: the quote is unavailable, never tips on a guess.
   */
  tips?: {
    run<T>(
      action: (tx: {
        query(sql: string, values: readonly unknown[]): Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T>;
  };
}): CustomerQuotePort {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  return Object.freeze<CustomerQuotePort>({
    async quoteCart(value: Readonly<QuoteCartCommand>) {
      try {
        const raw = readClosedRecord(value, [
          "cartReference",
          "expectedCartVersion",
          "guestCredential",
          "csrfCredential",
          "idempotencyKey",
          "requestedAt",
        ]);
        const input = Object.freeze({ ...raw }) as unknown as Readonly<QuoteCartCommand>;
        const startedAt = parseOrderingInstant(options.now());
        const session = createGuestSession(
          await options.sessions.authorize({
            sessionCredential: parseGuestRawCredential(input.guestCredential),
            csrfCredential: parseGuestRawCredential(input.csrfCredential),
            observedAt: startedAt,
          }),
        );
        const completedAt = parseOrderingInstant(options.now());
        if (completedAt < startedAt) return { status: "Unavailable" };
        assertGuestSessionUsable(session, completedAt);
        if (
          String(session.brandReference) !== scope.brandReference ||
          String(session.storeReference) !== scope.storeReference
        )
          return { status: "NotFound" };
        if (session.channel === "DineIn" && session.diningState !== "DiningBound")
          return { status: "NotFound" };
        const result = await (
          session.channel === "Pickup" ? options.pickup : options.dining
        ).quoteCart(input);
        if (
          options.tips === undefined ||
          (result.status !== "Created" && result.status !== "Current" && result.status !== "Requoted")
        )
          return result;
        const tips = await options.tips.run((tx) => readStoreTipChoices(tx, scope));
        return Object.freeze({ ...result, tips });
      } catch (error) {
        if (error instanceof GuestSessionError && error.code === "GUEST_SESSION_UNAVAILABLE")
          return { status: "NotFound" };
        return { status: "Unavailable" };
      }
    },
  });
}
