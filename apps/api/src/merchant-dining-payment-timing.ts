import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningPaymentTimingStore,
  parseDiningPaymentTiming,
  parseDiningReference,
  type StoreDiningPaymentTiming,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: the Store's dine-in payment timing (pay first, or pay later for
 * the whole table), read and changed by whoever edits the Store's settings
 * (`organization.store.update`: the Owner and the Store Manager). A change records who and when,
 * and only tables opened after it take it.
 */
export const diningPaymentTimingPermission = "organization.store.update" as const;

const denied = (): never => {
  throw new Error("DINING_PAYMENT_TIMING_DENIED");
};
const intentHash = (value: string) => createHash("sha256").update(value).digest("hex");

export function merchantDiningPaymentTimingStore(scope: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}) {
  return createPostgresDiningPaymentTimingStore({
    scope,
    hashIntent: intentHash,
    equals: (a, b) => a === b,
  });
}

const view = (timing: StoreDiningPaymentTiming) =>
  Object.freeze({
    paymentTiming: timing.paymentTiming,
    version: timing.version,
    changedAt: timing.changedAt,
  });

const scopeOf = (current: {
  selected: { tenantReference: unknown };
  context: { brand: { brandReference: unknown } };
  store: { storeReference: unknown };
}) => ({
  tenantReference: String(current.selected.tenantReference),
  brandReference: String(current.context.brand.brandReference),
  storeReference: String(current.store.storeReference),
});

export function createMerchantDiningPaymentTimingRead(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    return runMerchantSnapshotRead(options.persistence.transactions, (tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              diningPaymentTimingPermission,
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) =>
          view(
            await merchantDiningPaymentTimingStore(scopeOf(authority.scope)).load(tx, () =>
              authority.guard(),
            ),
          ),
      ),
    );
  };
}

export function createMerchantDiningPaymentTimingChange(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "operationReference",
      "paymentTiming",
      "expectedVersion",
    ]);
    const operationReference = String(parseDiningReference(raw.operationReference));
    const paymentTiming = parseDiningPaymentTiming(raw.paymentTiming);
    if (
      typeof raw.expectedVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedVersion) ||
      raw.expectedVersion < 0
    )
      throw new Error("DINING_PAYMENT_TIMING_INPUT_INVALID");
    const expectedVersion = raw.expectedVersion;
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              diningPaymentTimingPermission,
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const result = await merchantDiningPaymentTimingStore(scopeOf(authority.scope)).change(
            tx,
            {
              operationReference,
              paymentTiming,
              expectedVersion,
              actorReference: String(authority.scope.actorReference),
              observedAt: millisecondInstant(options.persistence.now()),
            },
            () => authority.guard(),
          );
          return Object.freeze({ status: result.status, timing: view(result.timing) });
        },
      ),
    );
  };
}

/** The store's clock in the millisecond UTC form Dining records use. */
function millisecondInstant(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error("DINING_PAYMENT_TIMING_UNAVAILABLE");
  return new Date(at).toISOString();
}
