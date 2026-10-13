import type { CustomerMenuFound, CustomerMenuQueryInput } from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { publicFound, type CustomerMenuPort } from "./customer-menu.js";
import { counterOrderPermission } from "./merchant-counter-order.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export class CounterMenuError extends Error {
  readonly code: "COUNTER_MENU_PERMISSION_DENIED" | "COUNTER_MENU_UNAVAILABLE";
  constructor(code: CounterMenuError["code"]) {
    super("counter menu is unavailable");
    this.name = "CounterMenuError";
    this.code = code;
  }
}

/**
 * WP-2423 Q7: the counter item picker shows exactly the pickup menu a customer sees right now
 * (items, options, prices and sold-out state from the published menu and the Store's stock), so
 * staff and customers never disagree. Read under the staff ordering permission.
 */
export function createMerchantCounterMenu(options: {
  persistence: PersistentMerchantBffOptions;
  menu: CustomerMenuPort;
  /** The Store's public reference its pickup menu is published under. */
  publicStoreReference(scope: { brandReference: string; storeReference: string }): string;
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown }): Promise<CustomerMenuFound> => {
    const scope = await options.persistence.transactions
      .run(async (transaction) => {
        const resolved = await resolveScope(
          transaction,
          input.sessionCookie,
          counterOrderPermission,
        );
        if ((await resolved.allowed()) !== true)
          throw new CounterMenuError("COUNTER_MENU_PERMISSION_DENIED");
        return {
          brandReference: String(resolved.context.brand.brandReference),
          storeReference: String(resolved.store.storeReference),
        };
      })
      .catch((error: unknown) => {
        if (error instanceof CounterMenuError) throw error;
        throw new CounterMenuError("COUNTER_MENU_PERMISSION_DENIED");
      });
    let result;
    try {
      result = await options.menu.getPublishedMenu({
        publicStoreReference: options.publicStoreReference(scope),
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
        locale: options.locale,
        requestedAt: options.persistence.now(),
        searchTerm: null,
        sectionReference: null,
      } as unknown as CustomerMenuQueryInput);
    } catch {
      throw new CounterMenuError("COUNTER_MENU_UNAVAILABLE");
    }
    if (result.status !== "Found") throw new CounterMenuError("COUNTER_MENU_UNAVAILABLE");
    return publicFound(result);
  };
}
