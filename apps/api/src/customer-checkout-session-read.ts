import {
  GuestSessionService,
  GuestSessionError,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  CheckoutSessionServiceError,
  createPostgresCheckoutSessionStore,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import {
  createCustomerCheckoutSessionAuthorization,
  type CustomerCheckoutSessionAuthorizationOptions,
} from "./customer-checkout-session-authorization.js";

/** Internal read: no record escapes before current Guest and source Cart authorization. */
export function createCustomerCheckoutSessionRead(
  options: CustomerCheckoutSessionAuthorizationOptions,
) {
  return Object.freeze({
    async read(value: unknown) {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let reference: string;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "checkoutSessionReference",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        reference = String(parseOrderingReference(raw.checkoutSessionReference));
      } catch {
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      }
      try {
        return await options.transactions.run(async (tx) => {
          const runner: CartQueryTransactionRunner = { run: async (work) => work(tx) };
          let last: string | undefined;
          const now = () => {
            const at = String(parseCanonicalInstant(options.now()));
            if (last !== undefined && at < last)
              throw new CheckoutSessionServiceError("PERMISSION_DENIED");
            last = at;
            return at;
          };
          const identity = new GuestSessionService({
            store: createPostgresGuestSessionEntryStore(runner, options.scope),
            credentials: options.credentials,
            binding: options.binding(tx),
            now,
            admission: { consume: async () => null },
          });
          const observedAt = now();
          const guest = await identity.authorize({ ...credentials, observedAt });
          if (
            String(guest.brandReference) !== options.scope.brandReference ||
            String(guest.storeReference) !== options.scope.storeReference
          )
            throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          const fingerprint = JSON.stringify(guest);
          const deadlines = [
            guest.idleExpiresAt,
            guest.absoluteExpiresAt,
            ...(guest.closureExpiresAt === null ? [] : [guest.closureExpiresAt]),
          ].sort();
          const validUntil = deadlines[0];
          if (!validUntil) throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          const authority = {
            guestSessionReference: String(guest.sessionReference),
            ...options.scope,
            checkedAt: observedAt,
            validUntil: String(validUntil),
            audit: null,
          };
          // Bootstrap only within this transaction using the credential-derived Guest selector.
          // Exact source Cart is learned from owner history, then authorized before returning.
          const store = createPostgresCheckoutSessionStore(runner, options.scope, {
            authorize: async (_tx, candidate, at) => {
              if (candidate.guestSessionReference !== authority.guestSessionReference || at > now())
                return false;
              try {
                const current = await identity.authorize({ ...credentials, observedAt: at });
                return JSON.stringify(current) === fingerprint;
              } catch (error) {
                if (error instanceof GuestSessionError) return false;
                throw error;
              }
            },
            audit: () => {
              throw new Error("read cannot append audit");
            },
          });
          const session = await store.load(reference, authority);
          if (!session) throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          const access = createCustomerCheckoutSessionAuthorization(
            { ...options, transactions: runner, now },
            {
              ...credentials,
              cartReference: session.validation.cartReference,
            },
          );
          const current = await access.authorize(
            {
              createOperationReference: session.createOperationReference,
              cartReference: session.validation.cartReference,
              cartVersion: session.validation.cartVersion,
              quoteReference: session.validation.quoteReference,
              quoteVersion: session.validation.quoteVersion,
            },
            now(),
          );
          if (
            !current ||
            current.guestSessionReference !== authority.guestSessionReference ||
            !(await access.authorizeInTransaction(tx, authority, now()))
          )
            throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          const confirmed = await identity.authorize({ ...credentials, observedAt: now() });
          if (JSON.stringify(confirmed) !== fingerprint)
            throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          return session;
        });
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        if (error instanceof GuestSessionError)
          throw new CheckoutSessionServiceError("PERMISSION_DENIED");
        throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
