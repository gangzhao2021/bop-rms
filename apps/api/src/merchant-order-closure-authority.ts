import { parseOrderClosureRecord } from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
/** Current employee authority for an explicit Order Close. Does not authorize
 * Reopen, refunds, automatic System closure or DiningSession Close. No grants. */
export function createMerchantOrderClosureAuthority(
  source: PersistentMerchantBffOptions,
  sessionCookie: unknown,
) {
  const resolve = createMerchantStoreScope(source);
  return async (tx: Parameters<typeof resolve>[0], value: unknown): Promise<boolean> => {
    try {
      const record = parseOrderClosureRecord(value);
      if (record.status !== "Closed" || record.actorType !== "User") return false;
      const current = await resolve(tx, sessionCookie, "order.close");
      if (
        String(record.tenantReference) !== String(current.selected.tenantReference) ||
        String(record.brandReference) !== String(current.context.brand.brandReference) ||
        String(record.storeReference) !== String(current.store.storeReference) ||
        String(record.actorReference) !== String(current.actorReference)
      )
        return false;
      return (await current.allowed()) === true;
    } catch {
      return false;
    }
  };
}
