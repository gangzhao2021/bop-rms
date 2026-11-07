/**
 * Owner 2026-10-23: customers can read the menu in Simplified Chinese. Staff enter an optional
 * Chinese version beside each customer-facing name; it is stored under this locale, which the
 * customer app requests when Chinese is chosen (the menu language is the fallback).
 */
export const CHINESE_LOCALE = "zh-Hans-CA";

/** The names with their Chinese version set; "" removes it; undefined leaves it as it is. */
export function withChinese(
  names: Readonly<Record<string, string>>,
  chinese: string | undefined,
): Record<string, string> {
  if (chinese === undefined) return { ...names };
  const others = Object.fromEntries(
    Object.entries(names).filter(([locale]) => locale !== CHINESE_LOCALE),
  );
  return chinese === "" ? others : { ...others, [CHINESE_LOCALE]: chinese };
}

/** The Chinese version staff entered ("" when none). */
export function chineseOf(names: Readonly<Record<string, string>> | undefined): string {
  return names?.[CHINESE_LOCALE] ?? "";
}

/** An optional Chinese text from a request: absent → undefined; "" clears it. */
export function optionalChinese(
  value: unknown,
  maximum: number,
  invalid: () => never,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid();
  const text = value.normalize("NFC").trim();
  if ([...text].length > maximum || /\p{Cc}/u.test(text)) return invalid();
  return text;
}
