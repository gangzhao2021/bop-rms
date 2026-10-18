import { parseOrderingInstant } from "../domain/cart.js";

/** Timing eligibility only. Callers must resolve authoritative Payment and current owner facts. */
export function isPaidOrderWithinAcceptanceWindow(input: {
  orderType: string;
  committedAt: string;
  capacityExpiresAt: string;
  terminalOccurredAt: string;
  observedAt: string;
  /**
   * WP-2423 Q9-G1: a pickup order's current acceptance deadline from Ordering's hold facts
   * (`orderAcceptanceDeadlineInstant`): an extended instant, or null while it is held because the
   * Store was offline. Omitted: the capacity expiry. Payment must still have been captured in time.
   */
  acceptanceDeadline?: string | null;
}): boolean {
  const committed = Date.parse(parseOrderingInstant(input.committedAt));
  const expires = Date.parse(parseOrderingInstant(input.capacityExpiresAt));
  const captured = Date.parse(parseOrderingInstant(input.terminalOccurredAt));
  const observed = Date.parse(parseOrderingInstant(input.observedAt));
  if (input.orderType !== "DineIn" && input.orderType !== "Pickup") return false;
  const deadline =
    input.acceptanceDeadline === undefined
      ? expires
      : input.acceptanceDeadline === null
        ? null
        : Date.parse(parseOrderingInstant(input.acceptanceDeadline));
  if (deadline !== null && deadline < expires) return false;
  return (
    captured >= committed &&
    captured < expires &&
    observed >= captured &&
    (input.orderType === "DineIn" || deadline === null || observed < deadline)
  );
}
