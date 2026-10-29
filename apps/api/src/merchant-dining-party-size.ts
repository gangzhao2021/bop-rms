import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningSessionReadStore,
  DiningSessionError,
  loadDiningPartySizes,
  loadDiningServiceSetting,
  parseDiningReference,
  recordDiningPartySize,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningPartySizeErrorCode =
  | "DINING_PARTY_SIZE_INPUT_INVALID"
  | "DINING_PARTY_SIZE_PERMISSION_DENIED"
  /** Another staff member changed the table's party size first: read it again. */
  | "DINING_PARTY_SIZE_CHANGED"
  /** The table closed or was cancelled. */
  | "DINING_PARTY_SIZE_TABLE_CLOSED"
  | "DINING_PARTY_SIZE_UNAVAILABLE";
export class MerchantDiningPartySizeError extends Error {
  constructor(readonly code: MerchantDiningPartySizeErrorCode) {
    super("dining party size " + code);
    this.name = "MerchantDiningPartySizeError";
  }
}
const fail = (code: MerchantDiningPartySizeErrorCode): never => {
  throw new MerchantDiningPartySizeError(code);
};

export type MerchantDiningPartySizeResult =
  | {
      readonly askPartySize: boolean;
      readonly partySizes: readonly {
        readonly diningSessionReference: string;
        readonly partySize: number;
        readonly version: number;
      }[];
    }
  | {
      readonly diningSessionReference: string;
      readonly partySize: number;
      readonly version: number;
    };

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2): how many guests sit at a
 * table. "Read" answers whether the Store asks when opening a table and the party size of the
 * tables shown; "Record" saves a table's next party size against the version staff saw (another
 * change in between is a conflict, the same operation again returns it). Anyone running tables
 * (`dining.operate`) may record it; a table that closed takes none.
 */
export function createMerchantDiningPartySize(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<MerchantDiningPartySizeResult> => {
    const authenticated = await options.authentication.authorize(input);
    let command:
      | { action: "Read"; sessions: string[] }
      | {
          action: "Record";
          diningSessionReference: string;
          operationReference: string;
          expectedVersion: number;
          partySize: number;
        };
    try {
      const action =
        input.command !== null && typeof input.command === "object"
          ? Object.getOwnPropertyDescriptor(input.command, "action")?.value
          : undefined;
      if (action === "Read") {
        const raw = readClosedRecord(input.command, ["action", "diningSessionReferences"]);
        if (!Array.isArray(raw.diningSessionReferences) || raw.diningSessionReferences.length > 200)
          return fail("DINING_PARTY_SIZE_INPUT_INVALID");
        command = {
          action,
          sessions: raw.diningSessionReferences.map((value: unknown) =>
            String(parseDiningReference(value)),
          ),
        };
      } else {
        const raw = readClosedRecord(input.command, [
          "action",
          "diningSessionReference",
          "operationReference",
          "expectedVersion",
          "partySize",
        ]);
        if (
          raw.action !== "Record" ||
          !Number.isSafeInteger(raw.expectedVersion) ||
          Number(raw.expectedVersion) < 0 ||
          !Number.isSafeInteger(raw.partySize) ||
          Number(raw.partySize) < 1 ||
          Number(raw.partySize) > 99
        )
          return fail("DINING_PARTY_SIZE_INPUT_INVALID");
        command = {
          action: "Record",
          diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
          operationReference: String(parseDiningReference(raw.operationReference)),
          expectedVersion: Number(raw.expectedVersion),
          partySize: Number(raw.partySize),
        };
      }
    } catch (error) {
      if (error instanceof MerchantDiningPartySizeError) throw error;
      return fail("DINING_PARTY_SIZE_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const current = await resolve(
                tx,
                input.sessionCookie,
                "dining.operate",
                authenticated.sessionReference,
              ).catch(() => fail("DINING_PARTY_SIZE_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("DINING_PARTY_SIZE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("DINING_PARTY_SIZE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof loadDiningPartySizes>[0];
            if (command.action === "Read") {
              const setting = await loadDiningServiceSetting(runner, scope);
              const sizes = await loadDiningPartySizes(runner, scope, command.sessions);
              return Object.freeze({
                askPartySize: setting.askPartySize,
                partySizes: Object.freeze(
                  [...sizes].map(([diningSessionReference, size]) =>
                    Object.freeze({ diningSessionReference, ...size }),
                  ),
                ),
              });
            }
            const [found] = await createPostgresDiningSessionReadStore(
              { run: (work) => work(tx as never) },
              scope,
            ).loadSessions([command.diningSessionReference]);
            if (found === undefined || found === null)
              return fail("DINING_PARTY_SIZE_INPUT_INVALID");
            if (found.phase !== "Active" && found.phase !== "Closing")
              return fail("DINING_PARTY_SIZE_TABLE_CLOSED");
            const recorded = await recordDiningPartySize(runner, scope, {
              diningSessionReference: command.diningSessionReference,
              operationReference: command.operationReference,
              expectedVersion: command.expectedVersion,
              partySize: command.partySize,
              actorReference: String(current.actorReference),
              observedAt: new Date(Date.parse(options.now())).toISOString(),
            });
            return Object.freeze({
              diningSessionReference: command.diningSessionReference,
              ...recorded,
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningPartySizeError) throw error;
      if (
        error instanceof DiningSessionError &&
        error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT"
      )
        throw new MerchantDiningPartySizeError("DINING_PARTY_SIZE_CHANGED");
      throw new MerchantDiningPartySizeError("DINING_PARTY_SIZE_UNAVAILABLE");
    }
  };
}
