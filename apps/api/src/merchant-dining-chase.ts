import { readClosedRecord } from "@bop/identity";
import { loadDiningServiceSetting, parseDiningReference } from "@rms/dining";
import {
  KitchenChaseTooSoonError,
  kitchenWorkChaseRecorded,
  listKitchenWorkChases,
  listKitchenWorkItemsToMake,
  recordKitchenWorkChase,
} from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantDiningChaseErrorCode =
  | "DINING_CHASE_INPUT_INVALID"
  | "DINING_CHASE_PERMISSION_DENIED"
  /** The Store has not turned chasing on. */
  | "DINING_CHASE_NOT_OFFERED"
  /** Nothing of this dish is still being made (made, served or cancelled). */
  | "DINING_CHASE_NOT_BEING_MADE"
  /** The round was chased in the last 5 minutes. */
  | "DINING_CHASE_TOO_SOON"
  | "DINING_CHASE_UNAVAILABLE";
export class MerchantDiningChaseError extends Error {
  constructor(
    readonly code: MerchantDiningChaseErrorCode,
    /** For DINING_CHASE_TOO_SOON: when the round may be chased again. */
    readonly retryAt: string | null = null,
  ) {
    super("dining chase " + code);
    this.name = "MerchantDiningChaseError";
  }
}
const fail = (code: MerchantDiningChaseErrorCode): never => {
  throw new MerchantDiningChaseError(code);
};

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 4): a server chases a dish not
 * yet served, from the table's page. The kitchen's ticket turns red and sounds, and shows how many
 * times it was chased. Only while the Store offers chasing, only for a dish still being made, and a
 * round at most once in any 5 minutes (the database refuses sooner). The same chase again (a retry
 * of its operation) records nothing new. Anyone running tables (`dining.operate`) may chase.
 */
export function createMerchantDiningChase(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ readonly status: "Chased" | "AlreadyChased"; readonly chaseCount: number }> => {
    const authenticated = await options.authentication.authorize(input);
    let command: { orderItemReference: string; operationReference: string };
    try {
      const raw = readClosedRecord(input.command, ["orderItemReference", "operationReference"]);
      command = {
        orderItemReference: String(parseDiningReference(raw.orderItemReference)),
        operationReference: String(parseDiningReference(raw.operationReference)),
      };
    } catch {
      return fail("DINING_CHASE_INPUT_INVALID");
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
              ).catch(() => fail("DINING_CHASE_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true) return fail("DINING_CHASE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("DINING_CHASE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const scope = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            const runner = tx as unknown as Parameters<typeof listKitchenWorkChases>[0];
            const setting = await loadDiningServiceSetting(
              tx as unknown as Parameters<typeof loadDiningServiceSetting>[0],
              scope,
            );
            if (!setting.chaseDish) return fail("DINING_CHASE_NOT_OFFERED");
            const count = async () =>
              (
                await listKitchenWorkChases(runner, scope, {
                  orderItemReferences: [command.orderItemReference],
                })
              ).reduce((sum, chase) => sum + chase.count, 0);
            // The same chase again (a lost answer, retried) records nothing new.
            if (await kitchenWorkChaseRecorded(runner, scope, command.operationReference))
              return Object.freeze({ status: "AlreadyChased" as const, chaseCount: await count() });
            const making = await listKitchenWorkItemsToMake(
              runner,
              scope,
              command.orderItemReference,
            );
            const first = making[0];
            if (first === undefined) return fail("DINING_CHASE_NOT_BEING_MADE");
            const result = await recordKitchenWorkChase(runner, scope, {
              chaseReference: command.operationReference,
              workItemReference: first.workItemReference,
              orderBatchReference: first.orderBatchReference,
              actorReference: String(current.actorReference),
              chasedAt: new Date(Date.parse(options.now())).toISOString(),
            });
            return Object.freeze({
              status: result.recorded ? ("Chased" as const) : ("AlreadyChased" as const),
              chaseCount: await count(),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof MerchantDiningChaseError) throw error;
      if (error instanceof KitchenChaseTooSoonError)
        throw new MerchantDiningChaseError("DINING_CHASE_TOO_SOON", error.retryAt);
      throw new MerchantDiningChaseError("DINING_CHASE_UNAVAILABLE");
    }
  };
}
