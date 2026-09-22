import { parseOrderingInstant } from "../domain/cart.js";

/** Timing eligibility only. Callers must resolve authoritative Payment and current owner facts. */
export function isPaidOrderWithinAcceptanceWindow(input: {
  orderType: string;
  committedAt: string;
  capacityExpiresAt: string;
  terminalOccurredAt: string;
  observedAt: string;
}): boolean {
  const committed = Date.parse(parseOrderingInstant(input.committedAt));
  const expires = Date.parse(parseOrderingInstant(input.capacityExpiresAt));
  const captured = Date.parse(parseOrderingInstant(input.terminalOccurredAt));
  const observed = Date.parse(parseOrderingInstant(input.observedAt));
  if (input.orderType !== "DineIn" && input.orderType !== "Pickup") return false;
  return (
    captured >= committed &&
    captured < expires &&
    observed >= captured &&
    (input.orderType === "DineIn" || observed < expires)
  );
}
