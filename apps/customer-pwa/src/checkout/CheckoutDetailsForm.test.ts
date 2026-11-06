import { describe, expect, it } from "vitest";
import {
  firstDetailsProblem,
  showsUnconfirmedSave,
  startingPickupContact,
} from "./CheckoutDetailsForm.js";

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

describe("WP-2423 M112: Continue goes to the field that needs fixing", () => {
  const draft = (
    contact: { name: string; channel: "Phone" | "Email"; value: string } | null,
    receipt:
      { choice: "InSession"; email: null } | { choice: "TransactionalEmail"; email: string } = {
      choice: "InSession",
      email: null,
    },
  ) => ({ pickupContact: contact, receipt });
  it("finds the empty name, a bad phone or email, the receipt email, then the policy tick", () => {
    expect(
      firstDetailsProblem(draft({ name: "  ", channel: "Phone", value: "4165550123" }), 0, false),
    ).toBe("name");
    expect(
      firstDetailsProblem(draft({ name: "Ana", channel: "Phone", value: "555" }), 0, false),
    ).toBe("value");
    expect(
      firstDetailsProblem(draft({ name: "Ana", channel: "Email", value: "ana@" }), 0, false),
    ).toBe("value");
    expect(
      firstDetailsProblem(
        draft(
          { name: "Ana", channel: "Phone", value: "416 555 0123" },
          { choice: "TransactionalEmail", email: "x" },
        ),
        0,
        false,
      ),
    ).toBe("receiptEmail");
    expect(
      firstDetailsProblem(
        draft({ name: "Ana", channel: "Phone", value: "416 555 0123" }),
        1,
        false,
      ),
    ).toBe("policies");
    expect(
      firstDetailsProblem(draft({ name: "Ana", channel: "Phone", value: "416 555 0123" }), 1, true),
    ).toBeNull();
    // A table guest gives no contact.
    expect(firstDetailsProblem(draft(null), 0, false)).toBeNull();
  });
});
