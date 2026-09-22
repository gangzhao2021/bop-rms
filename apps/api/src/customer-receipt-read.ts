import {
  readCustomerReceiptFinancial,
  type CustomerReceiptFinancialOptions,
} from "./customer-receipt-financial.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionService,
  GuestSessionError,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  createDigitalReceiptQueryService,
  createPostgresDigitalReceiptStore,
  DigitalReceiptError,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";

/** Side-effect-free receipt retrieval under the same current Guest transaction. */
export function createCustomerReceiptRead(
  options: Omit<CustomerCheckoutSessionAuthorizationOptions, "transactions"> & {
    readonly financial?: CustomerReceiptFinancialOptions;
    readonly transactions: {
      run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
    };
  },
) {
  async function readView(value: unknown, includeFinancial: boolean) {
    let credentials: { sessionCredential: string; csrfCredential: string };
    let orderReference: string;
    try {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "orderReference",
      ]);
      credentials = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      };
      orderReference = String(parseOrderingReference(raw.orderReference));
    } catch {
      throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
    }
    try {
      return await options.transactions.run(async (transaction) => {
        const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
        let previous: string | undefined;
        const now = () => {
          const at = String(parseCanonicalInstant(options.now()));
          if (previous !== undefined && at < previous)
            throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
          previous = at;
          return at;
        };
        const identity = new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(runner, options.scope),
          credentials: options.credentials,
          binding: options.binding(transaction),
          now,
          admission: { consume: async () => null },
        });
        const authorize = async () => {
          const guest = await identity.authorize({ ...credentials, observedAt: now() });
          if (
            guest.brandReference !== options.scope.brandReference ||
            guest.storeReference !== options.scope.storeReference
          )
            throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
          return guest;
        };
        const guest = await authorize();
        const fingerprint = JSON.stringify(guest);
        const stillAuthorized = async () => JSON.stringify(await authorize()) === fingerprint;
        const store = createPostgresDigitalReceiptStore({
          ...options.scope,
          authorize: async (_tx, access) =>
            access.action === "Read" &&
            access.orderReference === orderReference &&
            (await stillAuthorized()),
          validateSources: async () => false,
        });
        const query = createDigitalReceiptQueryService({
          authorization: {
            authorizeGuest: async (input) =>
              input.orderReference === orderReference && (await stillAuthorized())
                ? { guestSession: guest }
                : null,
            authorizeResume: async () => null,
          },
          receipts: {
            load: (reference) => store.load({ transaction, orderReference: reference }),
          },
        });
        const chain = await query.getCustomer({
          orderReference,
          observedAt: now(),
          resumeGrantReference: null,
        });
        if (!(await stillAuthorized()))
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        let financial = null;
        if (includeFinancial && options.financial !== undefined) {
          if (
            options.financial.scope.brandReference !== options.scope.brandReference ||
            options.financial.scope.storeReference !== options.scope.storeReference
          )
            throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
          financial = await readCustomerReceiptFinancial(
            transaction,
            options.financial,
            { orderReference, observedAt: now() },
            stillAuthorized,
          );
        }
        if (!(await stillAuthorized()))
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        return { chain, financial };
      });
    } catch (error) {
      if (error instanceof DigitalReceiptError) throw error;
      if (error instanceof GuestSessionError)
        throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
      throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
    }
  }
  return Object.freeze({
    read: async (value: unknown) => (await readView(value, false)).chain,
    readView: (value: unknown) => readView(value, true),
  });
}
