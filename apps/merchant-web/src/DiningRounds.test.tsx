import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CurrentOrderLines } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { parseDiningProgress } from "./dining-progress-client.js";
import { readyToServe } from "./dining-serve-ready.js";
import {
  DiningRoundsContext,
  roundServedCount,
  roundStateText,
  type DiningRoundsProgress,
} from "./DiningRounds.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const line = (n: number, round: number, name: string, subtotal: string) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(90 + round),
  name,
  options: n === 1 ? [{ name: "Less spicy", quantity: 1 }] : [],
  quantity: 1,
  customerNote: null,
  unitPrice: money(subtotal),
  subtotal: money(subtotal),
  discount: money("0"),
  tax: money("0"),
  fee: money("0"),
  total: money(subtotal),
  canCancel: false,
  cancellation: null,
});
const batch = (round: number, submittedAt: string) => ({
  orderBatchReference: id(90 + round),
  sequence: round,
  submittedAt,
  acceptanceStatus: "Accepted",
  canRequestAcceptance: false,
  canCancel: false,
  staffCancellation: null,
  canCancelItems: false,
});
const detail = parseCurrentOrderDetail(
  {
    screenId: "OPS-ORDER-DETAIL",
    pickupContact: null,
    order: {
      orderReference: id(1),
      orderNumber: "ORD-1002",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-10-26T23:00:00.000Z",
      observedAt: "2026-10-26T23:30:00.000Z",
      initialBatchReference: id(91),
      batches: [batch(1, "2026-10-26T23:00:00.000Z"), batch(2, "2026-10-26T23:20:00.000Z")],
      canRequestAcceptance: false,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: false,
      currentPhase: "InProgress",
      currentVersion: 5,
    },
    lines: {
      items: [
        line(1, 1, "TEST beef noodles", "1800"),
        line(2, 1, "TEST green tea", "400"),
        line(3, 2, "TEST dumplings", "1200"),
        line(4, 2, "TEST spring rolls", "900"),
      ],
      totals: {
        subtotal: money("4300"),
        discount: money("0"),
        tax: money("0"),
        fee: money("0"),
        total: money("4300"),
      },
    },
  },
  id(1),
);
const progressItem = (
  n: number,
  round: number,
  name: string,
  phase: string,
  delivered = 0,
  extra: Record<string, unknown> = {},
) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(90 + round),
  displayName: name,
  batchSequence: round,
  itemOrdinal: n,
  phase,
  orderedQuantity: 1,
  deliveredQuantity: delivered,
  remainingQuantity: 1 - delivered,
  itemServiceVersion: 1,
  ...extra,
});
const progress = (items: unknown[], extra: Record<string, unknown> = {}) =>
  parseDiningProgress(
    {
      orderReference: id(1),
      tableLabel: "T1",
      sessionVersion: 2,
      diningSessionReference: id(55),
      sessionPhase: "Active",
      tableAssignmentVersion: 3,
      closureStatus: "Open",
      closureVersion: 0,
      currentOrderVersion: 5,
      orderVersion: 5,
      phase: "InProgress",
      observedAt: "2026-10-26T23:30:00.000Z",
      items,
      ...extra,
    },
    id(1),
  );
const context = (view: ReturnType<typeof progress> | null): DiningRoundsProgress => ({
  view,
  unavailable: null,
  busy: false,
  retrying: new Set(),
  serveItem: () => undefined,
  serveRound: () => undefined,
});
const text = (html: string) =>
  html
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ");
const render = (view: ReturnType<typeof progress> | null) =>
  renderToStaticMarkup(
    <DiningRoundsContext.Provider value={context(view)}>
      <CurrentOrderLines
        lines={detail.lines}
        rounds={{
          batches: detail.order.batches,
          timeZone: "America/Toronto",
          today: "2026-10-26",
        }}
      />
    </DiningRoundsContext.Provider>,
  );

describe("Orders v3: a table's order read round by round (Owner 2026-10-26)", () => {
  const busy = progress([
    progressItem(1, 1, "TEST beef noodles", "Fulfilled", 1),
    progressItem(2, 1, "TEST green tea", "Ready"),
    progressItem(3, 2, "TEST dumplings", "InProgress"),
    progressItem(4, 2, "TEST spring rolls", "Ready"),
  ]);

  it("lists each round's own dishes with when it was sent and its amount", () => {
    const html = render(null);
    const sections = html.split('class="order-round order-round--lines"').slice(1);
    expect(sections).toHaveLength(2);
    expect(text(sections[0] ?? "")).toContain("Round 1 19:00");
    expect(text(sections[0] ?? "")).toContain("TEST beef noodles");
    expect(text(sections[0] ?? "")).toContain("Less spicy");
    expect(text(sections[0] ?? "")).toContain("$22.00");
    expect(text(sections[0] ?? "")).not.toContain("TEST dumplings");
    expect(text(sections[1] ?? "")).toContain("Round 2 19:20");
    expect(text(sections[1] ?? "")).toContain("TEST spring rolls");
    expect(text(sections[1] ?? "")).toContain("$21.00");
    // The order's totals stay once, after the rounds; no switch to open the progress.
    expect(html.match(/order-lines-totals/gu)).toHaveLength(1);
    expect(html).not.toContain("View serving progress");
    expect(html).not.toContain("<h3>Items</h3>");
  });

  it("shows each round's serving count and state, and each dish's state, always", () => {
    const html = text(render(busy));
    expect(html).toContain("Served 1/2");
    expect(html).toContain("Served 0/2");
    expect(html).toContain("Being made · 1 ready to serve");
    expect(html).toContain("Served");
    expect(html).toContain("Ready to serve");
    expect(html).toContain("Being made");
    expect(roundServedCount(busy.items, 1)).toEqual({ served: 1, ordered: 2 });
    expect(roundStateText(busy.items, 1)).toBe("1 ready to serve");
    expect(
      roundStateText(progress([progressItem(1, 1, "TEST beef noodles", "Fulfilled", 1)]).items, 1),
    ).toBe("All served");
  });

  it("serves in one tap, with no confirmation box: 'Served' on a ready dish, 'All served' on a round", () => {
    const html = render(busy);
    // One "Served" per ready dish, named for screen readers.
    expect(html.match(/class="dining-round-item__serve"/gu)).toHaveLength(2);
    expect(html).toContain('aria-label="Mark 1 × TEST green tea served"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("<dialog");
    // A round with one ready dish needs no round button; two ready → "All served".
    expect(html).not.toContain("dining-round__serve-all");
    const allReady = render(
      progress([
        progressItem(1, 1, "TEST beef noodles", "Ready"),
        progressItem(2, 1, "TEST green tea", "Ready"),
        progressItem(3, 2, "TEST dumplings", "Ready"),
        progressItem(4, 2, "TEST spring rolls", "InProgress"),
      ]),
    );
    expect(text(allReady)).toContain("All served");
    expect(allReady.match(/class="dining-round__serve-all"/gu)).toHaveLength(1);
  });

  it("serves a table checking out (DEC-DINE-IN-PAY-LATER), never a closed one", () => {
    const closing = progress(
      [
        progressItem(1, 1, "TEST beef noodles", "Ready"),
        progressItem(2, 1, "TEST green tea", "Ready"),
      ],
      { sessionPhase: "Closing" },
    );
    expect(render(closing)).toContain("dining-round-item__serve");
    expect(render(closing)).toContain("dining-round__serve-all");
    expect(readyToServe(closing)).toHaveLength(2);
    for (const extra of [{ sessionPhase: "Closed" }]) {
      const view = progress(
        [
          progressItem(1, 1, "TEST beef noodles", "Ready"),
          progressItem(2, 1, "TEST green tea", "Ready"),
        ],
        extra,
      );
      const html = render(view);
      expect(html).not.toContain("dining-round-item__serve");
      expect(html).not.toContain("dining-round__serve-all");
      expect(readyToServe(view)).toEqual([]);
    }
  });

  it("never offers a dish the kitchen is remaking (WP-2423 2026-10-18)", () => {
    const view = progress([
      progressItem(1, 1, "TEST beef noodles", "Ready", 0, { remakingQuantity: 1 }),
      progressItem(2, 1, "TEST green tea", "Ready"),
    ]);
    const html = text(render(view));
    expect(html).toContain("Being remade");
    expect(html).toContain("Remaking — don't serve it until the kitchen marks the remake done.");
    expect(readyToServe(view).map((item) => item.displayName)).toEqual(["TEST green tea"]);
    expect(render(view)).not.toContain('aria-label="Mark 1 × TEST beef noodles served"');
  });
});
