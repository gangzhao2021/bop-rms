import { describe, expect, it } from "vitest";
import {
  MerchantDiningTableCartError,
  parseMerchantDiningTableCartCommand,
  staffCartReasonCode,
  staffGuestChoosing,
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
    const sent = Object.fromEntries(
      Object.entries(command).filter(([, value]) => value !== undefined),
    );
    expect(() => parseMerchantDiningTableCartCommand(sent)).toThrow(MerchantDiningTableCartError);
  });

  it("records each reason as its own Audit reason code", () => {
    expect(staffCartReasonCode("GuestAsked")).toBe("STAFF_CART_GUEST_ASKED");
    expect(staffCartReasonCode("GuestLeft")).toBe("STAFF_CART_GUEST_LEFT");
    expect(staffCartReasonCode("CantMake")).toBe("STAFF_CART_CANT_MAKE");
  });
});

describe("v15 batch 7: which phone is choosing what it pays, on the staff table cart", () => {
  const cart = { cartReference: id(2), cartVersion: 4 };
  const choice = (change: Record<string, unknown> = {}) => ({
    cartReference: id(2),
    cartVersion: 4,
    chooserParticipantReference: id(7),
    expiresAt: "2026-11-10T20:05:00.000Z",
    ...change,
  });
  const phones = new Map([[id(7), 2]]);
  const note = (
    read: () => Promise<ReturnType<typeof choice> | null>,
    change: { paying?: boolean; observedAt?: string; cartVersion?: number } = {},
  ) =>
    staffGuestChoosing({
      paying: change.paying ?? false,
      cart: { ...cart, cartVersion: change.cartVersion ?? cart.cartVersion },
      observedAt: change.observedAt ?? "2026-11-10T20:01:00.000Z",
      read,
      phoneNumberOf: (participant) => phones.get(participant) ?? null,
    });

  it("names the phone and until when its choice holds the others' dishes", async () => {
    await expect(note(async () => choice())).resolves.toEqual({
      phoneNumber: 2,
      until: "2026-11-10T20:05:00.000Z",
      held: true,
    });
  });

  it("a phone it does not know is 'a guest', never a reference", async () => {
    await expect(
      note(async () => choice({ chooserParticipantReference: id(8) })),
    ).resolves.toMatchObject({ phoneNumber: null });
  });

  it("after the hold ran out it says so, never 'until' a time already past", async () => {
    await expect(
      note(async () => choice(), { observedAt: "2026-11-10T20:40:00.000Z" }),
    ).resolves.toMatchObject({ held: false });
    await expect(
      note(async () => choice(), { observedAt: "2026-11-10T20:05:00.000Z" }),
    ).resolves.toMatchObject({ held: false });
  });

  it("nothing for another cart or version, none chosen, or while a guest is paying", async () => {
    await expect(note(async () => choice({ cartVersion: 3 }))).resolves.toBeNull();
    await expect(note(async () => choice({ cartReference: id(3) }))).resolves.toBeNull();
    await expect(note(async () => null)).resolves.toBeNull();
    let asked = false;
    await expect(
      note(
        async () => {
          asked = true;
          return choice();
        },
        { paying: true },
      ),
    ).resolves.toBeNull();
    expect(asked).toBe(false);
  });

  it("a failed read leaves the note out and never fails the staff read or removal", async () => {
    await expect(
      note(async () => {
        throw new Error("the choice could not be read");
      }),
    ).resolves.toBeNull();
  });
});
