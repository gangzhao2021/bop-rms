import { describe, expect, it } from "vitest";
import { nothingToPay } from "./TableCheckout.js";
import type { TableBill } from "./table-checkout-client.js";

const bill = (overrides: Partial<TableBill> = {}): TableBill =>
  ({
    settlement: null,
    writeOff: null,
    consistent: true,
    waitingRounds: [],
    onlinePayment: null,
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    split: null,
    ...overrides,
  }) as unknown as TableBill;

describe("v15 b12: a checkout with nothing to pay", () => {
  it("asks for no tip or payment once every dish was comped, split or not", () => {
    expect(nothingToPay(bill())).toBe(true);
    // A split made before the comps is stale; there is nothing left to split.
    expect(
      nothingToPay(
        bill({
          consistent: false,
          split: { mode: "Even", stale: true, paidParts: 0 } as never,
        }),
      ),
    ).toBe(true);
  });
  it("still takes payment when something is owed, a round is on its way, or a part was paid", () => {
    expect(
      nothingToPay(bill({ owed: { subtotalMinor: "100", taxMinor: "13", totalMinor: "113" } })),
    ).toBe(false);
    expect(nothingToPay(bill({ consistent: false }))).toBe(false);
    expect(nothingToPay(bill({ waitingRounds: [{}] as never }))).toBe(false);
    expect(
      nothingToPay(bill({ split: { mode: "Even", stale: false, paidParts: 2 } as never })),
    ).toBe(false);
    expect(nothingToPay(bill({ settlement: {} as never }))).toBe(false);
  });
});
