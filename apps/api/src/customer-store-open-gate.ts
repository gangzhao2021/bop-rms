/**
 * WP-2423 Q4: whether the Store takes a customer order right now, from Store's public operating
 * status. Pickup (and a first dine-in order) needs the Store open with that service available; a
 * party already seated may keep ordering while online ordering is paused, but not once the Store
 * is closed for the day. Checked when checkout starts and again when payment starts.
 */
export interface CustomerStoreOperatingNow {
  readonly state: "Open" | "Closed" | "TemporarilyClosed";
  readonly availableServiceModes: readonly string[];
  /** When the reader gives it: whether the current period's last orders have passed. */
  readonly upcomingHours?: { readonly pastLastOrders: boolean } | undefined;
}
export type CustomerOrderKind = "Pickup" | "SeatedDineIn";

export class CustomerStoreClosedError extends Error {
  constructor() {
    super("store is not taking orders");
    this.name = "CustomerStoreClosedError";
  }
}

/**
 * WP-2423 item 8 ③ follow-up (v15 2026-10-28): after the Store's last orders (its published
 * "stop taking orders N minutes before closing") a guest can't send a new order or round, so the
 * time guests are told is true. Staff still can — a staff round or counter order is recorded under
 * the staff member who entered it.
 */
export type CustomerOrderActor = "Guest" | "Staff";

export function storeTakesOrder(
  status: CustomerStoreOperatingNow,
  kind: CustomerOrderKind,
  actor: CustomerOrderActor = "Guest",
): boolean {
  if (actor === "Guest" && status.upcomingHours?.pastLastOrders === true) return false;
  if (kind === "SeatedDineIn") return status.state !== "Closed";
  return status.state === "Open" && status.availableServiceModes.includes("Pickup");
}
