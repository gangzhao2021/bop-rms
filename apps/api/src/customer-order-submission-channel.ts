import {
  assertGuestSessionUsable,
  createGuestSession,
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  type GuestSessionService,
} from "@bop/identity";
import { parseOrderingReference } from "@rms/ordering";
import type { CustomerOrderSubmissionPort } from "./customer-order-submission.js";

/** Select only from current server-authorized identity; owners retain Cart authority. */
export function createCustomerOrderSubmissionChannel(options: {
  scope: Readonly<{ brandReference: string; storeReference: string }>;
  sessions: Pick<GuestSessionService, "authorize">;
  now: () => string;
  pickup: CustomerOrderSubmissionPort;
  dining: CustomerOrderSubmissionPort;
}): CustomerOrderSubmissionPort {
  const scope = {
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  if (
    ![1, 2].includes(options.pickup.quoteVersion) ||
    options.pickup.quoteVersion !== options.dining.quoteVersion ||
    [options.pickup, options.dining].some((port) => typeof port.create !== "function")
  )
    throw new Error("LOCAL_ORDER_SUBMISSION_CONFIGURATION_INVALID");
  async function select(input: { sessionCredential: string; csrfCredential: string }) {
    const startedAt = parseCanonicalInstant(options.now());
    const session = createGuestSession(
      await options.sessions.authorize({
        sessionCredential: parseGuestRawCredential(input.sessionCredential),
        csrfCredential: parseGuestRawCredential(input.csrfCredential),
        observedAt: startedAt,
      }),
    );
    const completedAt = parseCanonicalInstant(options.now());
    if (completedAt < startedAt) throw new Error("LOCAL_CHECKOUT_CLOCK_INVALID");
    assertGuestSessionUsable(session, completedAt);
    if (
      String(session.brandReference) !== scope.brandReference ||
      String(session.storeReference) !== scope.storeReference ||
      (session.channel === "DineIn" && session.diningState !== "DiningBound")
    )
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    return session.channel === "Pickup" ? options.pickup : options.dining;
  }
  return Object.freeze<CustomerOrderSubmissionPort>({
    quoteVersion: options.pickup.quoteVersion,
    async create(value) {
      const input = structuredClone(value);
      return (await select(input)).create(input);
    },
  });
}
