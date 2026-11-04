import { staffContentLocale } from "./staff-content-locale.js";
import type { CustomerMenuFound, CustomerMenuQueryInput } from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { publicFound, type CustomerMenuPort } from "./customer-menu.js";
import { counterOrderPermission } from "./merchant-counter-order.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readStoreTipChoices, type StoreTipChoices } from "./merchant-store-features.js";

export class CounterMenuError extends Error {
  readonly code: "COUNTER_MENU_PERMISSION_DENIED" | "COUNTER_MENU_UNAVAILABLE";
  constructor(code: CounterMenuError["code"]) {
    super("counter menu is unavailable");
    this.name = "CounterMenuError";
    this.code = code;
  }
}

/** Each sellable's name, keyed by reference, from a read of the menu in another language. */
export function menuNames(found: CustomerMenuFound): Readonly<Record<string, string>> {
  return Object.fromEntries(
    found.menu.sections.flatMap((section) =>
      section.sellables.map((item) => [String(item.sellableReference), String(item.name)]),
    ),
  );
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
  }): Promise<{
    readonly menu: CustomerMenuFound;
    /** WP-2423 item 8 ⑦: the tips the Store offers now (its percentages, or tips off). */
    readonly tips: StoreTipChoices;
    /** The dishes' names in the staff's other language, so a search finds either. */
    readonly otherNames?: Readonly<Record<string, string>>;
  }> => {
    const scope = await options.persistence.transactions
      .run(async (transaction) => {
        const resolved = await resolveScope(
          transaction,
          input.sessionCookie,
          counterOrderPermission,
        );
        if ((await resolved.allowed()) !== true)
          throw new CounterMenuError("COUNTER_MENU_PERMISSION_DENIED");
        const scope = {
          brandReference: String(resolved.context.brand.brandReference),
          storeReference: String(resolved.store.storeReference),
        };
        const tips = await readStoreTipChoices(transaction, scope).catch(() => {
          throw new CounterMenuError("COUNTER_MENU_UNAVAILABLE");
        });
        return { ...scope, tips };
      })
      .catch((error: unknown) => {
        if (error instanceof CounterMenuError) throw error;
        throw new CounterMenuError("COUNTER_MENU_PERMISSION_DENIED");
      });
    const read = (locale: string) =>
      options.menu.getPublishedMenu({
        publicStoreReference: options.publicStoreReference(scope),
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: input.orderType === "DineIn" ? "DINE_IN" : "PICKUP",
        locale,
        requestedAt: options.persistence.now(),
        searchTerm: null,
        sectionReference: null,
      } as unknown as CustomerMenuQueryInput);
    // Owner 2026-10-24: the menu in the staff member's chosen language (missing names fall
    // back to the menu language); what is ordered is the same either way.
    const locale = staffContentLocale() ?? options.locale;
    let result;
    try {
      result = await read(locale);
    } catch {
      throw new CounterMenuError("COUNTER_MENU_UNAVAILABLE");
    }
    if (result.status !== "Found") throw new CounterMenuError("COUNTER_MENU_UNAVAILABLE");
    // Only helps search: without it staff still find a dish by the name they see.
    const other = await read(locale.startsWith("zh") ? "en" : "zh-Hans").catch(() => null);
    return Object.freeze({
      menu: publicFound(result),
      tips: scope.tips,
      ...(other?.status === "Found" ? { otherNames: menuNames(other) } : {}),
    });
  };
}
