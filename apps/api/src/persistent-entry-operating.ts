import {
  createPostgresPublishedStoreOperatingStatusReader,
  parseGetPublicStoreRequest,
} from "@rms/store";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
import type { CustomerEntryOperatingReader } from "./customer-entry-composition.js";
type Resolution = Parameters<typeof createConfiguredPublicStoreResolution>[0];
type Operating = Parameters<typeof createPostgresPublishedStoreOperatingStatusReader>[0];
/** Retains current public resolution and published Store authority in the caller's
 * entry transaction; never reconstructs a publication candidate from evaluated IDs.
 */
export function createPersistentEntryOperatingReader(options: {
  transaction: Resolution["transaction"];
  publicStore: Omit<Resolution, "transaction">;
  operating: Operating;
}): CustomerEntryOperatingReader {
  const { brandReference, storeReference } = options.operating;
  if (
    brandReference !== options.publicStore.binding.brandReference ||
    storeReference !== options.publicStore.binding.storeReference ||
    options.operating.tenantReference !== options.publicStore.binding.tenantReference
  )
    throw new Error("ENTRY_OPERATING_SCOPE_MISMATCH");
  const resolution = createConfiguredPublicStoreResolution({
    ...options.publicStore,
    transaction: options.transaction,
  });
  const read = createPostgresPublishedStoreOperatingStatusReader(options.operating);
  return Object.freeze({
    async readCurrent(input: Parameters<CustomerEntryOperatingReader["readCurrent"]>[0]) {
      try {
        if (input.brandReference !== brandReference || input.storeReference !== storeReference)
          return null;
        const request = parseGetPublicStoreRequest({
          publicStoreReference: input.publicStoreReference,
          evaluatedAt: input.evaluatedAt,
          purpose: "CustomerEntry",
          requestedLocale: "en-CA",
        });
        const current = await resolution.resolve({
          publicStoreReference: request.publicStoreReference,
          evaluatedAt: request.evaluatedAt,
          purpose: request.purpose,
        });
        if (
          !current ||
          current.brandReference !== brandReference ||
          current.storeReference !== storeReference
        )
          return null;
        const status = await read(options.transaction, request.evaluatedAt);
        if (
          status.businessDate.brandReference !== brandReference ||
          status.businessDate.storeReference !== storeReference ||
          status.evaluatedAt !== request.evaluatedAt
        )
          return null;
        return Object.freeze({
          brandReference,
          storeReference,
          evaluatedAt: status.evaluatedAt,
          state: status.state,
          availableServiceModes: status.availableServiceModes,
        });
      } catch {
        return null;
      }
    },
  });
}
