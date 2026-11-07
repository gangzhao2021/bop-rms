import { formatMoney } from "../journey/format.js";
import type { CartMoney } from "./types.js";

/** Cart and quote amounts: "$11.30" for the Pilot's CAD; never a guessed precision. */
export function formatCartMoney(value: CartMoney): string {
  return formatMoney(value.amountMinor, value.currency);
}
