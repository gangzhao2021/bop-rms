// Same shape the customer menu accepts (customer-menu.ts).
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;

/**
 * Owner 2026-10-23 (customer English / Simplified Chinese): the optional `locale` query parameter
 * a customer read carries when the guest chose another language than the session's (for Chinese,
 * `zh-Hans-CA`, as the menu is asked). Item and option names are then chosen at read time from
 * the stored names in that locale, falling back to the session or menu language; frozen history
 * is never rewritten. Absent means the session's own locale (null). Any other query key, a
 * repeated key or a malformed locale is refused.
 */
export function customerDisplayLocale(
  query: unknown,
  otherKeys: readonly string[] = [],
): string | null {
  if (query === undefined) return null;
  if (typeof query !== "object" || query === null || Array.isArray(query))
    throw new TypeError("invalid query");
  const keys = Object.keys(query);
  if (keys.some((key) => key !== "locale" && !otherKeys.includes(key)))
    throw new TypeError("unknown query key");
  const value = (query as Record<string, unknown>).locale;
  if (value === undefined) return null;
  if (typeof value !== "string" || !localePattern.test(value))
    throw new TypeError("invalid locale");
  return value;
}
