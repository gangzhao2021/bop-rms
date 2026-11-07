import { describe, expect, it } from "vitest";
import { showsUnconfirmedSave, startingPickupContact } from "./CheckoutDetailsForm.js";

const typed = { name: "Synthetic Guest", channel: "Phone" as const, value: "416 555 0123" };
const saved = { name: "Synthetic Saved", channel: "Phone" as const, value: "+14165550199" };

describe("checkout details form continuity", () => {
  it("starts a re-priced form from the contact the guest typed but had not saved", () => {
    expect(startingPickupContact("Pickup", typed, null)).toBe(typed);
    expect(startingPickupContact("Pickup", typed, saved)).toBe(typed);
  });

  it("falls back to the saved contact, then to an empty one", () => {
    expect(startingPickupContact("Pickup", null, saved)).toBe(saved);
    expect(startingPickupContact("Pickup", null, undefined)).toEqual({
      name: "",
      channel: "Phone",
      value: "",
    });
  });

  it("never carries a pickup contact into a dine-in order", () => {
    expect(startingPickupContact("DineIn", typed, saved)).toBeNull();
  });

  it("offers the unconfirmed-save retry only once the guest is back online", () => {
    expect(showsUnconfirmedSave(true, false)).toBe(false);
    expect(showsUnconfirmedSave(true, true)).toBe(true);
    expect(showsUnconfirmedSave(false, true)).toBe(false);
  });
});
