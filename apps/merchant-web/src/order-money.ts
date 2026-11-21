/**
 * The app's one money format for staff screens: "$6.78" for 678 CAD minor units, "$1,234.50" with
 * thousands grouped; the currency's own minor-unit exponent, no floating point. Only a currency
 * other than the Store's CAD shows its code.
 */
export function orderMoney(value: { readonly amountMinor: string; readonly currencyCode: string }) {
  const exponent =
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: value.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const negative = value.amountMinor.startsWith("-");
  const digits = (negative ? value.amountMinor.slice(1) : value.amountMinor).padStart(
    exponent + 1,
    "0",
  );
  const whole = (exponent === 0 ? digits : digits.slice(0, -exponent)).replace(
    /\B(?=(\d{3})+(?!\d))/gu,
    ",",
  );
  const amount = exponent === 0 ? whole : whole + "." + digits.slice(-exponent);
  return (
    (negative ? "−" : "") + (value.currencyCode === "CAD" ? "$" : value.currencyCode + " ") + amount
  );
}

/** The Store's CAD in the app's one money format ("$125.05"), from integer minor units. */
export const formatCad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });
