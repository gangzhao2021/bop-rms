import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DiningSessionScreen } from "./DiningSessionPage.js";
import type { DiningRound, DiningSessionView } from "./dining-session-client.js";
import { tableOrderedCounts } from "./table-ordered.js";

/**
 * WP-2423 item 8 ③ (Owner decision 13): "Order again" on the table page puts one more of a dish
 * the table ordered into this guest's own cart; the menu says how many the table already ordered.
 */
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const at = "2026-10-28T23:00:00.000Z";
const dumpling = "018f8a30-0000-7000-8000-000000000001";
const spicy = "018f8a30-0000-7000-8000-000000000002";
const item = (
  displayName: string,
  quantity: number,
  extra: Partial<DiningRound["items"][number]> = {},
) => ({
  displayName,
  quantity,
  servedQuantity: 0,
  cancelled: false,
  lineTotal: cad("1200"),
  ...extra,
});
function view(rounds: DiningRound[]): DiningSessionView {
  return {
    tableLabel: "8",
    orderNumber: "2001",
    checkedAt: at,
    paymentTiming: "PayLater",
    rounds,
    summary: null,
  };
}
const round = (roundNumber: number, items: DiningRound["items"]): DiningRound => ({
  roundNumber,
  orderedBy: roundNumber === 1 ? "You" : "AnotherGuest",
  submittedAt: at,
  status: "Preparing",
  payment: "OnTableBill",
  cancelsAt: null,
  storeCancellationReason: null,
  items,
  itemsTotal: cad("2400"),
});
const again = {
  sellableReference: dumpling,
  optionSelections: [{ optionReference: spicy, quantity: 1 }],
};

describe("WP-2423 item 8 ③ decision 13: order again and already ordered", () => {
  it("counts each dish the table ordered, leaving out cancelled ones", () => {
    const counts = tableOrderedCounts(
      view([
        round(1, [item("Pork dumplings", 2, { orderAgain: again })]),
        round(2, [
          item("Pork dumplings", 1, { orderAgain: again }),
          item("Pork dumplings", 3, { orderAgain: again, cancelled: true }),
          item("Tea", 1),
        ]),
      ]),
    );
    expect([...counts]).toEqual([[dumpling, 3]]);
  });
  it("offers Order again on a dish that can be ordered again, only while the table orders", () => {
    const rounds = [
      round(1, [
        item("Pork dumplings", 2, { orderAgain: again }),
        item("Tea", 1),
        item("Fish", 1, { orderAgain: { ...again, optionSelections: [] }, cancelled: true }),
      ]),
    ];
    const render = (state: Parameters<typeof DiningSessionScreen>[0]["state"]) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <DiningSessionScreen state={state} onRefresh={() => undefined} />
        </MemoryRouter>,
      );
    const html = render({ status: "ready", view: view(rounds), refreshing: false });
    expect(html.match(/>Order again</gu)).toHaveLength(1);
    expect(html).toContain('aria-label="Order one more Pork dumplings"');
    // A table loaded before but not current now can't add dishes.
    expect(render({ status: "unavailable", view: view(rounds), offline: true })).not.toContain(
      "Order again",
    );
  });
});
