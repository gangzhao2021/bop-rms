// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergedIntoText } from "./CurrentOrderQueuePage.js";
import { DiningRoundsProvider } from "./DiningRounds.js";
import { mount, until } from "./dom-test-kit.fixture.js";

/**
 * b62 (v15 b61 live, TM2 order 73): S61 D was merged into S61 C and paid there. The order's serving
 * progress follows the host table's session (Checking out), so its Orders detail said
 * "Checking out" and offered "Close the table", which would have closed S61 C from S61 D's order.
 */
const csrf = "A".repeat(43);
const id = (n: number) => `0190a62b-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
// The read as v15 answered it for order 73: the host's session, in checkout.
const progress = {
  orderReference: id(73),
  tableLabel: "S61 C (TEST)",
  sessionVersion: 7,
  diningSessionReference: id(72),
  sessionPhase: "Closing",
  tableAssignmentVersion: 3,
  closureStatus: "Open",
  closureVersion: 0,
  currentOrderVersion: 4,
  orderVersion: 4,
  phase: "Fulfilled",
  observedAt: "2026-11-24T22:53:00.000Z",
  items: [
    {
      orderItemReference: id(201),
      orderBatchReference: id(91),
      displayName: "Beef noodles (TEST)",
      batchSequence: 1,
      itemOrdinal: 1,
      phase: "Fulfilled",
      orderedQuantity: 1,
      deliveredQuantity: 1,
      remainingQuantity: 0,
      itemServiceVersion: 2,
    },
  ],
};

afterEach(() => {
  document.body.innerHTML = "";
});

async function detail(mergedInto?: { tableLabel: string | null; paid: boolean }) {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(progress), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  );
  const { container } = await mount(
    <DiningRoundsProvider
      orderReference={id(73)}
      csrf={csrf}
      refreshKey="1"
      fetcher={fetcher}
      mergedInto={mergedInto}
    >
      <p>Rounds</p>
    </DiningRoundsProvider>,
  );
  await until(() => container.textContent?.includes("Close order") === true);
  return container.textContent ?? "";
}

describe("b62: the Orders detail of a table merged into another", () => {
  it("never offers the host table's close or says its state", async () => {
    const text = await detail({ tableLabel: "S61 C (TEST)", paid: true });
    expect(text).not.toContain("Close the table");
    expect(text).not.toContain("Checking out");
    // The order's own close stays (its own record).
    expect(text).toContain("Close order");
  });

  it("still offers them on the table's own order", async () => {
    const text = await detail();
    expect(text).toContain("Close the table");
    expect(text).toContain("Checking out");
  });

  it("says where its rounds are billed and whether they were paid there", () => {
    expect(mergedIntoText({ tableLabel: "S61 C (TEST)", paid: true })).toBe(
      "Merged into S61 C (TEST). Its rounds are on that table's bill and were paid there.",
    );
    expect(mergedIntoText({ tableLabel: "S61 C (TEST)", paid: false })).toBe(
      "Merged into S61 C (TEST). Its rounds are on that table's bill and are paid there.",
    );
    expect(mergedIntoText({ tableLabel: null, paid: true })).toBe(
      "Merged into another table. Its rounds are on that table's bill and were paid there.",
    );
  });
});
