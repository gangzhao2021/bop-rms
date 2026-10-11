/**
 * WP-2423 Q4: whether the Store takes a customer order right now, from Store's public operating
 * status. Pickup (and a first dine-in order) needs the Store open with that service available; a
 * party already seated may keep ordering while online ordering is paused, but not once the Store
 * is closed for the day. Checked when checkout starts and again when payment starts.
 */
export interface CustomerStoreOperatingNow {
  readonly state: "Open" | "Closed" | "TemporarilyClosed";
  readonly availableServiceModes: readonly string[];
}
export type CustomerOrderKind = "Pickup" | "SeatedDineIn";

export class CustomerStoreClosedError extends Error {
  constructor() {
    super("store is not taking orders");
    this.name = "CustomerStoreClosedError";
  }
}

export function storeTakesOrder(
  status: CustomerStoreOperatingNow,
  kind: CustomerOrderKind,
): boolean {
  if (kind === "SeatedDineIn") return status.state !== "Closed";
  return status.state === "Open" && status.availableServiceModes.includes("Pickup");
}
