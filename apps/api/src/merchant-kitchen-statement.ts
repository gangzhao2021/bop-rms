import { readClosedRecord } from "@bop/identity";
import {
  loadStoreKitchenStatement,
  parseStoreKitchenStatement,
  recordStoreKitchenStatement,
  StoreKitchenStatementError,
} from "@rms/store";
import { kitchenStatementAllergens } from "./kitchen-statement-allergens.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { storeFeaturesPermission } from "./merchant-store-features.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M178): the owner says, with ticks, which allergens the
 * Store's kitchen handles and which equipment it shares; guests read it above every dish's own
 * allergens. Store setup's own permission (the Store features page).
 */
const denied = (): never => {
  throw new Error("STORE_KITCHEN_STATEMENT_DENIED");
};
export function createMerchantKitchenStatement(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const action = (input.command as { action?: unknown } | null)?.action;
    let change: {
      operationReference: string;
      handledAllergenCodes: readonly string[];
      sharedEquipment: readonly string[];
    } | null = null;
    if (action === "Change") {
      const raw = readClosedRecord(input.command, [
        "action",
        "operationReference",
        "handledAllergenCodes",
        "sharedEquipment",
      ]);
      try {
        const ticks = parseStoreKitchenStatement({
          handledAllergenCodes: raw.handledAllergenCodes,
          sharedEquipment: raw.sharedEquipment,
        });
        change = {
          operationReference: String(raw.operationReference),
          handledAllergenCodes: ticks.handledAllergenCodes,
          sharedEquipment: ticks.sharedEquipment,
        };
      } catch {
        return Object.freeze({ status: "Invalid" as const });
      }
    } else readClosedRecord(input.command, ["action"]);
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              storeFeaturesPermission,
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
          const scope = {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          const allergens = await kitchenStatementAllergens(tx, scope);
          if (change !== null) {
            const known = new Set(allergens.map((entry) => entry.code));
            if (change.handledAllergenCodes.some((code) => !known.has(code)))
              return Object.freeze({ status: "Invalid" as const });
            try {
              await recordStoreKitchenStatement(tx as never, scope, {
                statementReference: options.references.next(),
                handledAllergenCodes: change.handledAllergenCodes,
                sharedEquipment: change.sharedEquipment,
                actorReference: String(current.actorReference),
                operationReference: change.operationReference,
                recordedAt: new Date(Date.parse(options.persistence.now())).toISOString(),
              });
            } catch (error) {
              if (
                error instanceof StoreKitchenStatementError &&
                error.code === "STORE_KITCHEN_STATEMENT_CONFLICT"
              )
                return Object.freeze({ status: "Conflict" as const });
              throw error;
            }
            await authority.guard();
          }
          const statement = await loadStoreKitchenStatement(tx as never, scope);
          return Object.freeze({
            status: "Current" as const,
            statement,
            allergenChoices: allergens.map((entry) => ({
              code: entry.code,
              name: entry.names["en-CA"] ?? Object.values(entry.names)[0] ?? entry.code,
              nameZh: entry.names["zh-Hans"] ?? "",
            })),
          });
        },
      ),
    );
  };
}
