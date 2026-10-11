/** "$6.78" for 678 CAD minor units; the currency's own minor-unit exponent, no floating point. */
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
  const amount =
    exponent === 0 ? digits : digits.slice(0, -exponent) + "." + digits.slice(-exponent);
  return (
    (negative ? "−" : "") + (value.currencyCode === "CAD" ? "$" : value.currencyCode + " ") + amount
  );
}
