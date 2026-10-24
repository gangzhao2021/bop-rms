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
  listOrderItemPrices,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import type { PersistentPublicStoreProfileOptions } from "./persistent-public-store-profile.js";
import { readCustomerStoreContact, type CustomerStoreContact } from "./customer-store-contact.js";
import { readCurrentStoreReceiptProfile } from "@rms/store";
import { isGuestTableOrder } from "./customer-order-status-read.js";
import type { CustomerReceiptItemNames } from "./customer-receipt.js";

/** Side-effect-free receipt retrieval under the same current Guest transaction. */
export function createCustomerReceiptRead(
  options: Omit<CustomerCheckoutSessionAuthorizationOptions, "transactions"> & {
    readonly financial?: CustomerReceiptFinancialOptions;
    /** WP-2423 Q10: the Store's published phone and address for questions about the receipt. */
    readonly publicProfile?: PersistentPublicStoreProfileOptions;
    /** WP-2423 Q16: link the Store's privacy notice (Store receipt profile) from the receipt. */
    readonly privacyNotice?: boolean;
    readonly transactions: {
      run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
    };
  },
) {
  async function readView(value: unknown, includeFinancial: boolean, displayLocale?: string) {
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
        // WP-2423 (v15 3cd0f8dd M5): a visit that ended (its table closed, or it sat idle) can
        // still read its own receipt on the same device, read only, within the Session's absolute
        // lifetime. Decided once per read: the current visit first, then the ended visit.
        let endedVisit = false;
        const authorize = async () => {
          const guest = endedVisit
            ? await identity.authorizeEndedVisit({ ...credentials, observedAt: now() })
            : await identity.authorize({ ...credentials, observedAt: now() });
          if (
            guest.brandReference !== options.scope.brandReference ||
            guest.storeReference !== options.scope.storeReference
          )
            throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
          return guest;
        };
        await transaction.query("SAVEPOINT customer_receipt_visit", []);
        let current: Awaited<ReturnType<typeof authorize>>;
        try {
          current = await authorize();
          await transaction.query("RELEASE SAVEPOINT customer_receipt_visit", []);
        } catch (error) {
          if (!(error instanceof GuestSessionError)) throw error;
          await transaction.query("ROLLBACK TO SAVEPOINT customer_receipt_visit", []);
          await transaction.query("RELEASE SAVEPOINT customer_receipt_visit", []);
          endedVisit = true;
          current = await authorize();
        }
        const guest = current;
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
        // WP-2423 (v15 8c4480dd M1): a guest at a shared table who placed a later round reads the
        // table's receipt; decided from Ordering's order header after the owner check refused it.
        let tableOrder = false;
        const query = createDigitalReceiptQueryService({
          authorization: {
            authorizeGuest: async (input) =>
              input.orderReference === orderReference && (await stillAuthorized())
                ? {
                    guestSession: guest,
                    ...(endedVisit ? { endedVisit: true as const } : {}),
                    ...(tableOrder ? { tableOrder: true as const } : {}),
                  }
                : null,
            authorizeResume: async () => null,
          },
          receipts: {
            load: (reference) => store.load({ transaction, orderReference: reference }),
          },
        });
        const request = { orderReference, observedAt: now(), resumeGrantReference: null };
        let chain: Awaited<ReturnType<typeof query.getCustomer>>;
        try {
          chain = await query.getCustomer(request);
        } catch (error) {
          if (
            !(error instanceof DigitalReceiptError) ||
            error.code !== "DIGITAL_RECEIPT_PERMISSION_DENIED"
          )
            throw error;
          tableOrder = await isGuestTableOrder(transaction, {
            scope: options.scope,
            guest,
            orderReference,
            now,
            stillAuthorized,
          });
          if (!tableOrder) throw error;
          chain = await query.getCustomer({ ...request, observedAt: now() });
        }
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
        let storeContact: CustomerStoreContact | null = null;
        if (includeFinancial && options.publicProfile !== undefined && (await stillAuthorized()))
          storeContact = await readCustomerStoreContact(
            transaction,
            options.publicProfile,
            {
              publicStoreReference: String(guest.publicStoreReference),
              locale: String(guest.locale),
            },
            now(),
          );
        let privacyNoticeUrl: string | null = null;
        if (includeFinancial && options.privacyNotice === true && (await stillAuthorized()))
          privacyNoticeUrl =
            (await readCurrentStoreReceiptProfile(transaction, options.scope))?.privacyNoticeUrl ??
            null;
        // Owner 2026-10-23: the guest's chosen language for item and option names, chosen from the
        // names frozen with each Order item (the issued receipt versions are left as issued). If
        // they can't be read, the receipt keeps the names it was issued with.
        let itemNames: Map<string, CustomerReceiptItemNames> | null = null;
        if (includeFinancial && displayLocale !== undefined && (await stillAuthorized())) {
          try {
            await transaction.query("SAVEPOINT customer_receipt_item_names", []);
            const prices = await listOrderItemPrices(transaction, options.scope, orderReference, [
              displayLocale,
              String(guest.locale),
            ]);
            await transaction.query("RELEASE SAVEPOINT customer_receipt_item_names", []);
            itemNames = new Map(
              prices.map((price) => [
                price.orderItemReference,
                Object.freeze({
                  displayName: price.displayName,
                  options: Object.freeze(price.options.map((option) => option.displayName)),
                }),
              ]),
            );
          } catch {
            await transaction.query("ROLLBACK TO SAVEPOINT customer_receipt_item_names", []);
            await transaction.query("RELEASE SAVEPOINT customer_receipt_item_names", []);
          }
        }
        if (!(await stillAuthorized()))
          throw new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED");
        return {
          chain,
          ...(itemNames === null ? {} : { itemNames }),
          financial,
          storeContact,
          privacyNoticeUrl,
          // WP-2423 (v15 3cd0f8dd M5): until when this device can still open the receipt.
          ...(endedVisit ? { visitEnded: { receiptAvailableUntil: guest.absoluteExpiresAt } } : {}),
        };
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
    readView: (value: unknown, displayLocale?: string) => readView(value, true, displayLocale),
  });
}
