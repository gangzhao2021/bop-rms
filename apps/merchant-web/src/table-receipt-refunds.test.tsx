import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseTableBill } from "./table-checkout-client.js";
import { TableReceipt } from "./TableCheckout.js";

/**
 * b62 (v15 b61 live, S61 B / order 63): paid $32.00 by phone ($28.25 and a $3.75 tip), then all
 * $32.00 refunded to the card. The Tables panel's checkout still read "Total paid $32.00 / Paid by
 * Guest's phone / Paid in full. Close the table when the guests have left." with no refund, while
 * the Orders detail ended "Fully refunded $32.00". The bill as the server sends it.
 */
const ref = (n: number) => "0190a62b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const bill = (refunds: Record<string, string>) =>
  parseTableBill({
    ...refunds,
    diningSessionReference: ref(2),
    sessionPhase: "Closing",
    sessionVersion: 9,
    paymentTiming: "PayLater",
    tableLabel: "S61 B (TEST)",
    orderReference: ref(63),
    rounds: [],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    settlement: {
      method: "Online",
      roundsMinor: "2825",
      tipMinor: "375",
      roundingMinor: "0",
      totalMinor: "3200",
      tenderedMinor: null,
      changeMinor: null,
      recordedAt: "2026-11-24T22:45:00.000Z",
      recordedAfterOutage: false,
    },
  });
const text = (refunds: Record<string, string>) =>
  renderToStaticMarkup(
    <TableReceipt bill={bill(refunds)} tableLabel="S61 B (TEST)" timeZone="America/Toronto" />,
  )
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ");

describe("b62: a paid table bill's checkout says what went back", () => {
  it("says Fully refunded, never Paid in full, once everything went back", () => {
    const read = text({ refundedMinor: "3200" });
    // b64 (v15 b62 live, S62 E): paid, then refunded in full, net $0.00; never "Total paid".
    expect(read).toContain("Total $32.00");
    expect(read).toContain("Fully refunded −$32.00");
    expect(read).toContain("Total after refunds $0.00");
    expect(read).not.toContain("Total paid");
    expect(read).toContain("Fully refunded. Close the table when the guests have left.");
    expect(read).not.toContain("Paid in full");
  });

  it("takes a part refund off what was paid", () => {
    const read = text({ refundedMinor: "500" });
    expect(read).toContain("Refunded −$5.00");
    expect(read).toContain("Total after refunds $27.00");
    expect(read).not.toContain("Fully refunded");
  });

  it("says a refund the card company has not answered as on its way, never as given back", () => {
    const read = text({ refundedMinor: "3200", refundPendingMinor: "3200" });
    expect(read).toContain("Refund on its way $32.00");
    expect(read).not.toContain("Fully refunded");
    expect(read).not.toContain("Total after refunds");
    // b64: all of it is on its way back: never "Paid in full" over it.
    expect(read).toContain("Being refunded in full. Close the table when the guests have left.");
    expect(read).not.toContain("Paid in full");
  });

  it("reads as before with no refund (and from an older server)", () => {
    const read = text({});
    expect(read).toContain("Paid in full. Close the table when the guests have left.");
    expect(read).not.toContain("refund");
    expect(bill({}).refunds).toEqual({ givenMinor: "0", onItsWayMinor: "0" });
    expect(() => bill({ refundedMinor: "100", refundPendingMinor: "300" })).toThrow();
  });
});
