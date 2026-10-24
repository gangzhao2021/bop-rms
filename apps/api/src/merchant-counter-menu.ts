import { staffContentLocale } from "./staff-content-locale.js";
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
 * WP-2423 Q7: the counter item picker shows exactly the menu a customer sees right now (pickup at
 * the counter; dine-in for a staff-entered table round): items, options, prices and sold-out state
 * from the published menu and the Store's stock, so
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
  return async (input: {
    sessionCookie: unknown;
    /** WP-2423 Q7 slice 2: a staff-entered table round sells the dine-in menu. */
    orderType?: "Pickup" | "DineIn";
  }): Promise<CustomerMenuFound> => {
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
        orderTypeCode: input.orderType === "DineIn" ? "DINE_IN" : "PICKUP",
        // Owner 2026-10-24: the menu in the staff member's chosen language (missing names fall
        // back to the menu language); what is ordered is the same either way.
        locale: staffContentLocale() ?? options.locale,
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
