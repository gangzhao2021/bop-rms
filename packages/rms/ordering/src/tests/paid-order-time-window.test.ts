import { describe, expect, it } from "vitest";
import { isPaidOrderWithinAcceptanceWindow } from "../application/paid-order-time-window.js";

const base = {
  orderType: "DineIn",
  committedAt: "2026-09-20T10:00:00.000Z",
  capacityExpiresAt: "2026-09-20T10:30:00.000Z",
  terminalOccurredAt: "2026-09-20T10:29:59.999Z",
  observedAt: "2026-09-20T11:00:00.000Z",
};
describe("paid order acceptance timing", () => {
  it("retains on-time paid Dining eligibility after the unpaid deadline", () => {
    expect(isPaidOrderWithinAcceptanceWindow(base)).toBe(true);
    expect(isPaidOrderWithinAcceptanceWindow({ ...base, observedAt: base.capacityExpiresAt })).toBe(
      true,
    );
  });
  it.each(["2026-09-20T09:59:59.999Z", "2026-09-20T10:30:00.000Z", "2026-09-20T10:31:00.000Z"])(
    "rejects capture outside original window: %s",
    (terminalOccurredAt) => {
      expect(isPaidOrderWithinAcceptanceWindow({ ...base, terminalOccurredAt })).toBe(false);
    },
  );
  it("accepts the opening boundary and refuses observations preceding capture", () => {
    expect(
      isPaidOrderWithinAcceptanceWindow({ ...base, terminalOccurredAt: base.committedAt }),
    ).toBe(true);
    expect(isPaidOrderWithinAcceptanceWindow({ ...base, observedAt: base.committedAt })).toBe(
      false,
    );
  });
  it("preserves Pickup processing deadline", () => {
    expect(isPaidOrderWithinAcceptanceWindow({ ...base, orderType: "Pickup" })).toBe(false);
    expect(
      isPaidOrderWithinAcceptanceWindow({
        ...base,
        orderType: "Pickup",
        observedAt: base.terminalOccurredAt,
      }),
    ).toBe(true);
  });
  it("does not admit unknown order types", () => {
    expect(isPaidOrderWithinAcceptanceWindow({ ...base, orderType: "Delivery" })).toBe(false);
  });
});
