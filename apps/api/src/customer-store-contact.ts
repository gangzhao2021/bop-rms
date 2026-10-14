import type { ConsumerTransaction } from "@bop/eventing";
import { createPublicStoreProfileService, parseGetPublicStoreRequest } from "@rms/store";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";

/**
 * WP-2423 Q10: how a customer reaches the Store about an order — the published business phone and
 * address from the Store's public profile (Store owner, existing publication path). Never staff,
 * customer or internal data.
 */
export interface CustomerStoreContact {
  readonly phone: string | null;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
}

/**
 * Read in the caller's transaction after the Guest is authorized. A Store whose public profile is
 * not currently available yields `null`: the order view stays usable and simply omits the contact
 * card (it never shows invented or stale contact facts).
 */
export async function readCustomerStoreContact(
  transaction: ConsumerTransaction,
  options: PersistentPublicStoreProfileOptions,
  guest: { readonly publicStoreReference: string; readonly locale: string },
  evaluatedAt: string,
): Promise<CustomerStoreContact | null> {
  const request = parseGetPublicStoreRequest({
    publicStoreReference: guest.publicStoreReference,
    requestedLocale: guest.locale,
    evaluatedAt,
    purpose: "CustomerCart",
  });
  const result = await createPublicStoreProfileService(
    createPersistentPublicStoreProfilePorts(
      transaction as Parameters<typeof createPersistentPublicStoreProfilePorts>[0],
      options,
      request,
    ),
  ).getPublicStore(request);
  if (result.status !== "Available") return null;
  const { address, businessPhone } = result.profile;
  return Object.freeze({
    phone: businessPhone,
    addressLines: Object.freeze([...address.addressLines]),
    locality: address.locality,
    regionCode: address.regionCode,
    postalCode: address.postalCode,
  });
}

/** Explicit public-field serialization for HTTP responses. */
export function storeContactJson(contact: CustomerStoreContact) {
  return {
    phone: contact.phone,
    addressLines: [...contact.addressLines],
    locality: contact.locality,
    regionCode: contact.regionCode,
    postalCode: contact.postalCode,
  };
}
