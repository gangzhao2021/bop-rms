import type { CartMoney } from "./types.js";

const wholeUnits = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });

export function formatCartMoney(value: CartMoney): string {
  // The accepted Pilot uses CAD. Other currencies need their server metadata before display.
  if (value.currency !== "CAD" || !/^-?(?:0|[1-9][0-9]{0,20})$/u.test(value.amountMinor))
    return "Amount unavailable";
  const minor = BigInt(value.amountMinor);
  const magnitude = minor < 0n ? -minor : minor;
  const fraction = (magnitude % 100n).toString().padStart(2, "0");
  return `CAD ${minor < 0n ? "-" : ""}${wholeUnits.format(magnitude / 100n)}.${fraction}`;
}
