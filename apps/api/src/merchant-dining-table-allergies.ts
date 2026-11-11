import { readClosedRecord } from "@bop/identity";
import { currentAllergenRegistry } from "@rms/catalog";
import {
  DiningTableAllergyError,
  listOpenDiningTableAllergies,
  parseDiningReference,
  parseDiningTableAllergyCodes,
  setDiningTableAllergies,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M171, Owner decision 17): front-of-house marks the
 * allergens a table must avoid (ticks from the Brand's allergen list, no free text), so every
 * kitchen ticket of that table shows them in red. The Tables page's own permission,
 * `dining.operate`; the record names who set it and when. Codes are never logged or echoed in
 * an error.
 * A save from a screen that no longer matches the table answers `Changed` with the current set.
 */
const denied = (): never => {
  throw new Error("DINING_TABLE_ALLERGY_DENIED");
};

interface Tx {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

/** The allergen list staff tick from: code and its names, in list order. */
export async function tableAllergenChoices(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<readonly { readonly code: string; readonly name: string; readonly nameZh: string }[]> {
  // The list is the Brand's (read with no Store selected); the caller's Store is restored.
  const before = (
    (await tx.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows: { brand: string | null; store: string | null }[] }
  ).rows[0];
  const registry = await currentAllergenRegistry(tx as never, scope);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    before?.brand ?? "",
    before?.store ?? "",
  ]);
  return Object.freeze(
    (registry?.entries ?? []).map((entry) => {
      const names = entry.localizedNames as Readonly<Record<string, string>>;
      return Object.freeze({
        code: String(entry.code),
        name: names["en-CA"] ?? Object.values(names)[0] ?? String(entry.code),
        nameZh: names["zh-Hans"] ?? "",
      });
    }),
  );
}

export { listOpenDiningTableAllergies };

export function createMerchantDiningTableAllergies(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "operationReference",
      "diningSessionReference",
      "allergenCodes",
      "basedOnAllergenCodes",
    ]);
    const operationReference = String(parseDiningReference(raw.operationReference));
    const diningSessionReference = String(parseDiningReference(raw.diningSessionReference));
    let codes: readonly string[];
    let basedOnAllergenCodes: readonly string[];
    try {
      codes = parseDiningTableAllergyCodes(raw.allergenCodes);
      basedOnAllergenCodes = parseDiningTableAllergyCodes(raw.basedOnAllergenCodes);
    } catch {
      return Object.freeze({ status: "Invalid" as const });
    }
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
          const scope = {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          // Only allergens on the Brand's list: the kitchen reads them by name.
          const known = new Set((await tableAllergenChoices(tx, scope)).map((c) => c.code));
          if (codes.some((code) => !known.has(code)))
            return Object.freeze({ status: "Invalid" as const });
          try {
            const result = await setDiningTableAllergies(tx as never, scope, {
              markReference: options.references.next(),
              diningSessionReference,
              allergenCodes: codes,
              basedOnAllergenCodes,
              actorReference: String(current.actorReference),
              operationReference,
              recordedAt: new Date(Date.parse(options.persistence.now())).toISOString(),
            });
            await authority.guard();
            return Object.freeze({ status: result.status, allergenCodes: result.codes });
          } catch (error) {
            if (
              error instanceof DiningTableAllergyError &&
              error.code === "DINING_TABLE_ALLERGY_NOT_OPEN"
            )
              return Object.freeze({ status: "TableNotOpen" as const });
            if (
              error instanceof DiningTableAllergyError &&
              error.code === "DINING_TABLE_ALLERGY_CONFLICT"
            )
              return Object.freeze({ status: "Conflict" as const });
            throw error;
          }
        },
      ),
    );
  };
}
