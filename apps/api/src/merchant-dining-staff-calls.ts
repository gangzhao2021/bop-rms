import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import { createPostgresDiningStaffCallStore, parseDiningReference } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 Q28 DEC-DINING-STAFF-CALL: staff see how many guests are waiting for them (navigation)
 * and answer a call from the Tables page. Both use the Tables page's own permission,
 * `dining.operate`; answering records the staff member.
 */
const denied = (): never => {
  throw new Error("DINING_STAFF_CALL_DENIED");
};
const intentHash = (value: string) => createHash("sha256").update(value).digest("hex");

/** The Dining owner store for a staff read or answer inside an authorized merchant transaction. */
export function merchantDiningStaffCallStore(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  scope: { tenantReference: string; brandReference: string; storeReference: string },
) {
  return createPostgresDiningStaffCallStore(
    { run: (work) => work(tx) },
    {
      scope,
      hashIntent: intentHash,
      equals: (a, b) => a === b,
      // Guest commands never run through a staff store.
      authorize: async () => false,
    },
  );
}

export function createMerchantDiningStaffCallCount(options: {
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
              "dining.operate",
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const current = authority.scope;
          const open = await merchantDiningStaffCallStore(tx, {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          }).countOpen(tx, () => authority.guard());
          return Object.freeze({ open });
        },
      ),
    );
  };
}

export function createMerchantDiningStaffCallAnswer(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, ["operationReference", "callReference"]);
    const operationReference = String(parseDiningReference(raw.operationReference));
    const callReference = String(parseDiningReference(raw.callReference));
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              "dining.operate",
              authenticated.sessionReference,
            );
            if ((await current.allowed()) !== true) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const current = authority.scope;
          const result = await merchantDiningStaffCallStore(tx, {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          }).answer(
            tx,
            {
              operationReference,
              callReference,
              actorReference: String(current.actorReference),
              observedAt: String(parseDiningInstantOf(options.persistence.now())),
            },
            () => authority.guard(),
          );
          if (result.status === "Closed")
            return Object.freeze({
              status:
                result.kind === "Answered" ? ("Answered" as const) : ("AlreadyClosed" as const),
            });
          if (result.status === "AlreadyClosed")
            return Object.freeze({ status: "AlreadyClosed" as const });
          return Object.freeze({ status: "NotFound" as const });
        },
      ),
    );
  };
}

/** The store's clock in the millisecond UTC form Dining records use. */
function parseDiningInstantOf(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error("DINING_STAFF_CALL_UNAVAILABLE");
  return new Date(at).toISOString();
}
