import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/** Same shape the customer menu accepts (customer-menu.ts). */
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const storage = new AsyncLocalStorage<string | null>();

/** The header the staff back office sends while a staff member chose another language. */
export const staffContentLocaleHeader = "x-bop-content-locale";

/**
 * Owner 2026-10-24 (staff English / Simplified Chinese): the locale a staff member chose for Store
 * content shown on operational screens (item and option names on orders, the kitchen, pickup,
 * tables, counter order, refunds and item availability), from `X-Bop-Content-Locale`. It only
 * chooses among names the Store already has, falling back to the Store's own language; it never
 * changes what is written. A malformed or repeated header is ignored (the Store's language).
 */
export function staffContentLocaleMiddleware(): RequestHandler {
  return (request, _response, next) => {
    const value = request.headers[staffContentLocaleHeader];
    const locale = typeof value === "string" && localePattern.test(value) ? value : null;
    storage.run(locale, next);
  };
}

/** Runs `work` as a request whose staff member chose `locale` (also used by acceptance tests). */
export function withStaffContentLocale<T>(locale: string | null, work: () => T): T {
  return storage.run(locale, work);
}

/** The staff member's chosen content locale for this request, or null for the Store's own. */
export function staffContentLocale(): string | null {
  return storage.getStore() ?? null;
}

/** The locales to choose Store content names from: the staff member's choice first. */
export function staffNameLocales(storeLocale: string): readonly string[] {
  const chosen = staffContentLocale();
  return chosen === null || chosen === storeLocale ? [storeLocale] : [chosen, storeLocale];
}

/**
 * A Store content name (item, option, size) for a staff screen: the staff member's chosen
 * language, then the Store's, then the same language, then any name it has ("" when none).
 */
export function staffContentName(
  names: Readonly<Record<string, string>>,
  storeLocale: string,
): string {
  const usable = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  for (const locale of staffNameLocales(storeLocale)) {
    const language = locale.split("-")[0] ?? locale;
    const name =
      usable(names[locale]) ??
      usable(names[language]) ??
      usable(Object.entries(names).find(([key]) => key.split("-")[0] === language)?.[1]);
    if (name !== undefined) return name;
  }
  return Object.values(names).find((value) => usable(value) !== undefined) ?? "";
}
