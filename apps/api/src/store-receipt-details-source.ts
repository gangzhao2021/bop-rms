import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPublicStoreProfileService,
  parseGetPublicStoreRequest,
  readCurrentStoreReceiptProfile,
  storeReceiptTaxRegistrations,
} from "@rms/store";
import type { ReceiptBusinessAddress, ReceiptTaxRegistration } from "@rms/ordering";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";

export interface StoreReceiptDetails {
  readonly businessAddress: ReceiptBusinessAddress | null;
  readonly taxRegistrations: readonly ReceiptTaxRegistration[];
}

/**
 * WP-2423 Q15 (DEC-RECEIPT-TAX-AND-PRIVACY): the facts a new receipt prints about its issuer, read
 * in the issuing transaction from their owners — the registration numbers the Store's Owner
 * entered (Store receipt profile) and the Store's published address (Store public profile). A Store
 * without a published address or without registrations prints none; nothing is invented. Internal
 * composition only (no customer request reaches it).
 */
export function createStoreReceiptDetailsSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly publicProfile?: PersistentPublicStoreProfileOptions;
}) {
  return async (
    transaction: ConsumerTransaction,
    request: { readonly observedAt: string; readonly locale: string },
  ): Promise<StoreReceiptDetails> => {
    const profile = await readCurrentStoreReceiptProfile(transaction, options.scope);
    let businessAddress: ReceiptBusinessAddress | null = null;
    if (options.publicProfile !== undefined) {
      const publicRequest = parseGetPublicStoreRequest({
        publicStoreReference: options.publicProfile.binding.publicStoreReference,
        requestedLocale: request.locale,
        evaluatedAt: request.observedAt,
        purpose: "CustomerCart",
      });
      const result = await createPublicStoreProfileService(
        createPersistentPublicStoreProfilePorts(
          transaction as Parameters<typeof createPersistentPublicStoreProfilePorts>[0],
          options.publicProfile,
          publicRequest,
        ),
      ).getPublicStore(publicRequest);
      if (result.status === "Available") {
        const address = result.profile.address;
        businessAddress = Object.freeze({
          addressLines: Object.freeze([...address.addressLines]),
          locality: address.locality,
          regionCode: address.regionCode,
          postalCode: address.postalCode,
          countryCode: address.countryCode,
        });
      }
      // The public profile read sets its own scope; restore the Store scope for the caller.
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [options.scope.brandReference, options.scope.storeReference],
      );
    }
    return Object.freeze({
      businessAddress,
      taxRegistrations: storeReceiptTaxRegistrations(profile),
    });
  };
}

/**
 * WP-2423 Q16: the Store's privacy notice link for checkout (`null` until its Owner enters one).
 * Public Store fact, read in its own bounded transaction.
 */
export function createStorePrivacyNoticeReader(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
}) {
  return async (): Promise<string | null> =>
    options.transactions.run(
      async (transaction) =>
        (await readCurrentStoreReceiptProfile(transaction, options.scope))?.privacyNoticeUrl ??
        null,
    );
}
