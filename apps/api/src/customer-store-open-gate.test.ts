import { expect, it } from "vitest";
import { storeTakesOrder } from "./customer-store-open-gate.js";

it("WP-2423 Q4: pickup needs the Store open for pickup; a seated party only needs it not closed", () => {
  const open = { state: "Open" as const, availableServiceModes: ["DineIn", "Pickup"] };
  const pickupPaused = { state: "Open" as const, availableServiceModes: ["DineIn"] };
  const paused = { state: "TemporarilyClosed" as const, availableServiceModes: [] };
  const closed = { state: "Closed" as const, availableServiceModes: [] };
  expect(storeTakesOrder(open, "Pickup")).toBe(true);
  expect(storeTakesOrder(pickupPaused, "Pickup")).toBe(false);
  expect(storeTakesOrder(paused, "Pickup")).toBe(false);
  expect(storeTakesOrder(closed, "Pickup")).toBe(false);
  expect(storeTakesOrder(open, "SeatedDineIn")).toBe(true);
  expect(storeTakesOrder(paused, "SeatedDineIn")).toBe(true);
  expect(storeTakesOrder(closed, "SeatedDineIn")).toBe(false);
});

it("follow-up: after last orders a guest can't order, staff still can", () => {
  const past = {
    state: "Open" as const,
    availableServiceModes: ["DineIn", "Pickup"],
    upcomingHours: { pastLastOrders: true },
  };
  const before = { ...past, upcomingHours: { pastLastOrders: false } };
  expect(storeTakesOrder(past, "Pickup")).toBe(false);
  expect(storeTakesOrder(past, "SeatedDineIn")).toBe(false);
  expect(storeTakesOrder(past, "SeatedDineIn", "Staff")).toBe(true);
  expect(storeTakesOrder(past, "Pickup", "Staff")).toBe(true);
  expect(storeTakesOrder(before, "SeatedDineIn")).toBe(true);
  // Closed is closed for staff too (as before).
  expect(storeTakesOrder({ ...past, state: "Closed" as const }, "SeatedDineIn", "Staff")).toBe(
    false,
  );
});
