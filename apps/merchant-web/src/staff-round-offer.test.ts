import { describe, expect, it } from "vitest";
import { staffRoundOffer } from "./staff-round-offer.js";

// Batch 55 (v15 b54 live): the Tables panel and order entry offer a staff round by the rule the
// send checks; a table checking out (paid or not) is refused there, so it is not offered here.
const table = {
  lifecycle: "Published" as const,
  operationalState: "Available" as const,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  currentDiningSessionReference: "01909955-0000-7000-8000-000000000029",
  session: { phase: "Active" },
};

describe("staffRoundOffer", () => {
  it("offers a round to a free or seated table that is ordering", () => {
    expect(
      staffRoundOffer({ ...table, currentDiningSessionReference: null, session: null }, false),
    ).toBe("Offered");
    expect(staffRoundOffer(table, false)).toBe("Offered");
    // A seated table's settled bill (nothing owed yet) is no reason to refuse while it orders.
    expect(staffRoundOffer(table, true)).toBe("Offered");
  });
  it("refuses a table checking out, saying whether its bill is paid", () => {
    expect(staffRoundOffer({ ...table, session: { phase: "Closing" } }, false)).toBe("CheckingOut");
    expect(staffRoundOffer({ ...table, session: { phase: "Closing" } }, true)).toBe("Paid");
  });
  it("refuses a table that is closed off, being cleaned or has no code", () => {
    expect(staffRoundOffer({ ...table, operationalState: "TemporarilyBlocked" }, false)).toBe(
      "Unavailable",
    );
    expect(staffRoundOffer({ ...table, lifecycle: "Draft" }, false)).toBe("Unavailable");
    expect(staffRoundOffer({ ...table, qrCodeValidUntil: null }, false)).toBe("NoCode");
  });
});
