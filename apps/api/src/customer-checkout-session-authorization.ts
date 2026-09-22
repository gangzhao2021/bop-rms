import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionBindingPort,
  type GuestSessionCredentialPort,
} from "@bop/identity";
import {
  createPostgresCartQueryStore,
  parseOrderingReference,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
  type CheckoutSessionAuthority,
  type CheckoutSessionRequest,
} from "@rms/ordering";

export interface CustomerCheckoutSessionAuthorizationOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly transactions: CartQueryTransactionRunner;
  readonly credentials: GuestSessionCredentialPort;
  readonly binding: (tx: CartQueryTransaction) => GuestSessionBindingPort;
  readonly now: () => string;
}
/** Per-request capability; raw credentials never become persisted session/Audit fields. */
export function createCustomerCheckoutSessionAuthorization(
  options: CustomerCheckoutSessionAuthorizationOptions,
  value: unknown,
) {
  const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential", "cartReference"]);
  const credentials = Object.freeze({
    sessionCredential: parseGuestRawCredential(raw.sessionCredential),
    csrfCredential: parseGuestRawCredential(raw.csrfCredential),
  });
  const cartReference = parseOrderingReference(raw.cartReference);
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  let fingerprint: string | undefined, last: string | undefined;
  const now = () => {
    const at = parseCanonicalInstant(options.now());
    if (last !== undefined && at < last) throw new Error("checkout authorization unavailable");
    last = at;
    return at;
  };
  async function current(
    tx: CartQueryTransaction,
    observedAt: string,
  ): Promise<CheckoutSessionAuthority | null> {
    try {
      const observed = parseCanonicalInstant(observedAt);
      if (observed > now()) return null;
      const runner: CartQueryTransactionRunner = { run: async (work) => work(tx) };
      const identity = new GuestSessionService({
        store: createPostgresGuestSessionEntryStore(runner, scope),
        credentials: options.credentials,
        binding: options.binding(tx),
        now,
        admission: { consume: async () => null },
      });
      const guest = await identity.authorize({ ...credentials, observedAt: observed });
      if (
        guest.brandReference !== scope.brandReference ||
        guest.storeReference !== scope.storeReference
      )
        return null;
      const cart = await createPostgresCartQueryStore(runner, scope).load(cartReference);
      if (!cart || cart.orderType !== guest.channel) return null;
      if (guest.channel === "Pickup") {
        if (
          String(cart.createdByActorReference) !== String(guest.sessionReference) ||
          guest.diningState !== "ContextOnly" ||
          guest.diningSessionReference !== null ||
          guest.diningParticipantReference !== null ||
          cart.diningSessionReference !== null
        )
          return null;
      } else if (
        guest.diningState !== "DiningBound" ||
        guest.diningSessionReference === null ||
        guest.diningParticipantReference === null ||
        String(cart.diningSessionReference) !== String(guest.diningSessionReference)
      )
        return null;
      const confirmed = await identity.authorize({ ...credentials, observedAt: now() });
      const next = JSON.stringify(confirmed);
      if (JSON.stringify(guest) !== next || (fingerprint !== undefined && fingerprint !== next))
        return null;
      fingerprint ??= next;
      const deadlines = [confirmed.idleExpiresAt, confirmed.absoluteExpiresAt];
      if (confirmed.closureExpiresAt !== null) deadlines.push(confirmed.closureExpiresAt);
      const validUntil = [...deadlines].sort()[0];
      if (!validUntil || validUntil <= now()) return null;
      return Object.freeze({
        guestSessionReference: String(confirmed.sessionReference),
        ...scope,
        checkedAt: observed,
        validUntil: String(validUntil),
        audit: null,
      });
    } catch {
      return null;
    }
  }
  return Object.freeze({
    async authorize(input: CheckoutSessionRequest, observedAt: string) {
      if (input.cartReference !== cartReference) return null;
      try {
        return await options.transactions.run((tx) => current(tx, observedAt));
      } catch {
        return null;
      }
    },
    async authorizeInTransaction(
      tx: CartQueryTransaction,
      authority: CheckoutSessionAuthority,
      observedAt: string,
    ) {
      const found = await current(tx, observedAt);
      return (
        found !== null &&
        found.guestSessionReference === authority.guestSessionReference &&
        found.brandReference === authority.brandReference &&
        found.storeReference === authority.storeReference
      );
    },
  });
}
