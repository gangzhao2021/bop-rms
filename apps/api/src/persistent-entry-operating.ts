import {
  type createPostgresPublishedStoreOperatingStatusReader,
  parseGetPublicStoreRequest,
} from "@rms/store";
import { createKitchenGatedOperatingStatusReader } from "./store-kitchen-open-gate.js";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
import {
  CustomerEntryServiceUnavailableError,
  type CustomerEntryOperatingReader,
} from "./customer-entry-composition.js";
import { withFailureCause } from "./customer-failure-diagnostic.js";
import { guestServiceModes } from "./merchant-store-features.js";
import { readBrandGuestIntake } from "@bop/tenant";
type Resolution = Parameters<typeof createConfiguredPublicStoreResolution>[0];
type Operating = Parameters<typeof createPostgresPublishedStoreOperatingStatusReader>[0];

const own = (value: unknown, key: PropertyKey): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const sqlStatePattern = /^[0-9A-Z]{5}$/u;
const connectionCodes = /^E(?:CONN[A-Z]+|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH|AI_AGAIN)$/u;

/** A query or connection that failed, in the error or anything it was written over. */
function databaseFault(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const code = own(current, "code");
    if (
      typeof code === "string" &&
      (code.startsWith("TENANT_DATABASE_") ||
        connectionCodes.test(code) ||
        // A driver error as it comes from PostgreSQL (SQLSTATE and severity).
        (sqlStatePattern.test(code) && typeof own(current, "severity") === "string"))
    )
      return true;
    current = own(current, "cause");
  }
  return false;
}
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
  const read = createKitchenGatedOperatingStatusReader(options.operating);
  // WP-2423: a database that could not answer is an outage (503, retry), not a code that can't be
  // used (422, rescan). The owners' sources write a failed query over with "unavailable" or null,
  // so it is told apart by the transaction: a failed query leaves it unable to answer.
  const unusable = async (): Promise<null> => {
    try {
      await options.transaction.query("SELECT 1", []);
    } catch (probe) {
      throw withFailureCause(new CustomerEntryServiceUnavailableError(), probe);
    }
    // Only what the facts say (no current publication, another Store's status): unusable here.
    return null;
  };
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
          return await unusable();
        // WP-2423 item 8 ⑦ 1b: guests are offered only what the Store's modules allow.
        const status = await guestServiceModes(
          options.transaction,
          {
            tenantReference: options.operating.tenantReference,
            brandReference,
            storeReference,
          },
          await read(options.transaction, request.evaluatedAt),
        );
        if (
          status.businessDate.brandReference !== brandReference ||
          status.businessDate.storeReference !== storeReference ||
          status.evaluatedAt !== request.evaluatedAt
        )
          return await unusable();
        // WP-2423 item 13 ② (Owner 2026-11-05): a merchant the platform paused starts no new visit.
        // Only said here; the Store's hours, services and open state stay as they are, so guests
        // already in a visit, staff, and paid orders (auto-acceptance) carry on unchanged.
        const paused =
          (
            await readBrandGuestIntake(
              options.transaction as Parameters<typeof readBrandGuestIntake>[0],
              brandReference,
            )
          ).state === "Paused";
        return Object.freeze({
          brandReference,
          storeReference,
          evaluatedAt: status.evaluatedAt,
          state: status.state,
          availableServiceModes: status.availableServiceModes,
          todayHours: status.todayHours,
          localTime: String(status.localTime),
          localDate: String(status.localDate),
          upcomingHours: status.upcomingHours,
          servicesTurnedOff: status.servicesTurnedOff,
          pausedModes: status.pausedModes,
          ...("kitchenNotSetUp" in status ? { notReadyForOrders: true } : {}),
          ...(paused ? { newGuestsPaused: true } : {}),
        });
      } catch (error) {
        if (error instanceof CustomerEntryServiceUnavailableError) throw error;
        if (databaseFault(error))
          throw withFailureCause(new CustomerEntryServiceUnavailableError(), error);
        return await unusable();
      }
    },
  });
}
