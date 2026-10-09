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

/** "5:10 p.m." in the device's own zone: the customer is standing at the Store. */
export function formatClockTime(instant: string, locale = "en-CA"): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );
}

/** "2026-09-02, 12:51 p.m." for records such as receipts. */
export function formatDateTime(instant: string, locale = "en-CA"): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
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
