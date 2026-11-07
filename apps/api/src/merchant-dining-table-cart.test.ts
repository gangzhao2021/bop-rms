import { describe, expect, it } from "vitest";
import {
  MerchantDiningTableCartError,
  parseMerchantDiningTableCartCommand,
  staffCartReasonCode,
} from "./merchant-dining-table-cart.js";

// WP-2423 shared-table-checkout (c): staff read a table's unsent cart and remove a dish with one
// of three reasons; anything else is refused before any read.

const id = (n: number) => "018f0000-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("Table cart command", () => {
  it("reads a table's cart", () => {
    expect(
      parseMerchantDiningTableCartCommand({ action: "Read", diningSessionReference: id(1) }),
    ).toEqual({ action: "Read", diningSessionReference: id(1) });
  });

  it("removes a dish with a reason and the version staff saw", () => {
    const command = {
      action: "Remove",
      diningSessionReference: id(1),
      cartReference: id(2),
      cartItemReference: id(3),
      expectedCartVersion: 4,
      reason: "CantMake",
      operationReference: id(5),
    };
    expect(parseMerchantDiningTableCartCommand(command)).toEqual(command);
  });

  it.each([
    ["no reason", { reason: undefined }],
    ["an unknown reason", { reason: "Comp" }],
    ["no version", { expectedCartVersion: 0 }],
    ["an extra field", { price: 0 }],
    ["a bad reference", { cartItemReference: "line-1" }],
  ])("refuses %s", (_name, change) => {
    const command: Record<string, unknown> = {
      action: "Remove",
      diningSessionReference: id(1),
      cartReference: id(2),
      cartItemReference: id(3),
      expectedCartVersion: 4,
      reason: "GuestAsked",
      operationReference: id(5),
      ...change,
    };
    for (const [key, value] of Object.entries(command))
      if (value === undefined) delete command[key];
    expect(() => parseMerchantDiningTableCartCommand(command)).toThrow(
      MerchantDiningTableCartError,
    );
  });

  it("records each reason as its own Audit reason code", () => {
    expect(staffCartReasonCode("GuestAsked")).toBe("STAFF_CART_GUEST_ASKED");
    expect(staffCartReasonCode("GuestLeft")).toBe("STAFF_CART_GUEST_LEFT");
    expect(staffCartReasonCode("CantMake")).toBe("STAFF_CART_CANT_MAKE");
  });
});
