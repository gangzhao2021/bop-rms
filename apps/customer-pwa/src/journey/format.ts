/** Customer-facing presentation of exact server amounts and instants. No binary floating point. */

const wholeUnits = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });
const minorPattern = /^-?(?:0|[1-9][0-9]{0,20})$/u;

/** "$11.30" for CAD minor units; other currencies keep their ISO code; malformed input is never guessed. */
export function formatMoney(amountMinor: string | bigint, currency: string): string {
  const text = typeof amountMinor === "bigint" ? amountMinor.toString() : amountMinor;
  if (!/^[A-Z]{3}$/u.test(currency) || !minorPattern.test(text)) return "Amount unavailable";
  const minor = BigInt(text);
  const magnitude = minor < 0n ? -minor : minor;
  const fraction = (magnitude % 100n).toString().padStart(2, "0");
  const amount = `${wholeUnits.format(magnitude / 100n)}.${fraction}`;
  const sign = minor < 0n ? "-" : "";
  return currency === "CAD" ? `${sign}$${amount}` : `${sign}${currency} ${amount}`;
}

/**
 * Menu prices arrive as exact decimal text ("0.75", "4.5000"): "$0.75" / "$4.50" in the same style
 * as {@link formatMoney}. Digits past the cents are kept only when they are not zero, so nothing is
 * rounded; null for malformed input so the caller can show its own wording.
 */
export function formatDecimalMoney(amount: string, currency: string): string | null {
  const match = /^(0|[1-9][0-9]{0,20})(?:\.([0-9]{1,6}))?$/u.exec(amount);
  if (!match || !/^[A-Z]{3}$/u.test(currency)) return null;
  let fraction = (match[2] ?? "").padEnd(2, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const text = `${wholeUnits.format(BigInt(match[1] ?? "0"))}.${fraction}`;
  return currency === "CAD" ? `$${text}` : `${currency} ${text}`;
}

/** "Toronto, ON M5V 1A1": the one locality line for every postal address shown to customers. */
export function formatLocalityLine(address: {
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
}): string {
  return `${address.locality}, ${address.regionCode} ${address.postalCode}`;
}

/**
 * "5:10 p.m." in the device's own zone: the customer is standing at the Store. Canadian and other
 * locales end the time with an abbreviation period, so a sentence that ends with a formatted time
 * must use {@link endSentence} instead of appending "." itself ("9:46 p.m.." otherwise).
 */
export function formatClockTime(instant: string, locale = "en-CA"): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
}

/** "2026-09-02, 12:51 p.m." for records such as receipts. End a sentence with {@link endSentence}. */
export function formatDateTime(instant: string, locale = "en-CA"): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
}

/**
 * Ends a sentence once: "Valid until 9:46 p.m." stays as is, "Valid until 21:46" gains its period.
 * Use it whenever a sentence closes with a formatted time or date, whose locale text may already
 * end with an abbreviation period.
 */
export function endSentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/** "about 4 minutes" / "less than a minute" until an instant; null once it has passed. */
export function formatMinutesUntil(instant: string, nowMs: number): string | null {
  const remaining = Date.parse(instant) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 1) return "less than a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
}

/** A whole-number percentage of an amount in minor units, rounded half up, as minor-unit text. */
export function percentOfMinor(amountMinor: string, percent: number): string | null {
  if (!minorPattern.test(amountMinor) || !Number.isInteger(percent) || percent < 0) return null;
  const base = BigInt(amountMinor);
  if (base < 0n) return null;
  return ((base * BigInt(percent) + 50n) / 100n).toString();
}
