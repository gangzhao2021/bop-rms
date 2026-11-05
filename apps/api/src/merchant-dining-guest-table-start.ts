import { readClosedRecord } from "@bop/identity";
import {
  changeDiningServiceSetting,
  DiningSessionError,
  loadDiningServiceSetting,
  parseDiningReference,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: whoever may pause ordering may also stop guests starting
 * tables, from the Tables page, at the moment a queue forms. Turning it on stays with the owner, on
 * Store features. Only ever off: the same append-only versions record who and when.
 */
export const guestTableStartOffPermission = "operations.ordering.pause" as const;

export class GuestTableStartOffError extends Error {
  constructor(readonly code: "Denied" | "Changed" | "Unavailable") {
    super("guest table start off " + code);
    this.name = "GuestTableStartOffError";
  }
}
const denied = (): never => {
  throw new GuestTableStartOffError("Denied");
};

export function createMerchantGuestTableStartOff(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input).catch(denied);
    const raw = readClosedRecord(input.command, ["operationReference", "expectedVersion"]);
    const operationReference = String(parseDiningReference(raw.operationReference));
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 1
    )
      throw new GuestTableStartOffError("Unavailable");
    const expectedVersion = raw.expectedVersion;
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                guestTableStartOffPermission,
                authenticated.sessionReference,
              ).catch(denied);
              if ((await current.allowed()) !== true) return denied();
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied,
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadDiningServiceSetting>[0];
            const setting = await loadDiningServiceSetting(runner, scope);
            const next = await changeDiningServiceSetting(runner, scope, {
              operationReference,
              expectedVersion,
              staffCall: setting.staffCall,
              chaseDish: setting.chaseDish,
              guestTableStart: false,
              actorReference: String(current.actorReference),
              observedAt: new Date(Date.parse(options.persistence.now())).toISOString(),
            });
            return Object.freeze({ guestTableStart: next.guestTableStart, version: next.version });
          },
        ),
      );
    } catch (error) {
      if (error instanceof GuestTableStartOffError) throw error;
      if (
        error instanceof DiningSessionError &&
        error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT"
      )
        throw new GuestTableStartOffError("Changed");
      throw new GuestTableStartOffError("Unavailable");
    }
  };
}
