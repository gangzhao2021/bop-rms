import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  closeTableSession,
  tableCloseBlockers,
  TableSessionClose,
  type TableClosePlan,
} from "./TableSessionClose.js";
import type { DiningProgress } from "./dining-progress-client.js";
import type { StaffDiningTable } from "./dining-session-client.js";

const id = (n: number) => "01a4d500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const table: StaffDiningTable = {
  tableReference: id(1),
  stableLabel: "T12",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: id(2),
  elapsedMinutes: 4 * 24 * 60,
  qrCodeValidUntil: null,
  staffRoundsAwaitingPayment: [],
  session: { phase: "Active", version: 4, orderReference: id(3) },
};
const item = (phase: string, remainingQuantity: number, n: number) => ({
  orderItemReference: id(100 + n),
  displayName: "Latte",
  batchSequence: 2,
  itemOrdinal: 1,
  orderBatchReference: id(20),
  phase,
  orderedQuantity: 1,
  deliveredQuantity: 1 - remainingQuantity,
  remainingQuantity,
  itemServiceVersion: 1,
});
const progress: DiningProgress = {
  orderReference: id(3),
  tableLabel: "T12",
  orderVersion: 3,
  currentOrderVersion: 6,
  sessionVersion: 4,
  diningSessionReference: id(2),
  sessionPhase: "Active",
  tableAssignmentVersion: 1,
  closureStatus: "Open",
  closureVersion: 0,
  phase: "Fulfilled",
  observedAt: "2026-10-15T19:00:00.000Z",
  items: [item("Fulfilled", 0, 1)],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

it("WP-2423 D4: explains what stops a table from closing, in staff words, with what to do", () => {
  expect(tableCloseBlockers(table, progress)).toEqual([]);
  const blockers = tableCloseBlockers(
    { staffRoundsAwaitingPayment: [{ payBy: "2026-10-15T19:30:00.000Z" }] },
    {
      items: [
        item("Submitted", 1, 2),
        item("Accepted", 1, 3),
        item("Ready", 1, 4),
        item("Fulfilled", 0, 5),
        item("Cancelled", 0, 6),
      ],
    },
  );
  expect(blockers).toEqual([
    "1 round entered by staff still waits for card-machine payment. Record the payment on the Orders page, or cancel the round there.",
    "1 item is waiting for payment or for the kitchen to accept it. Take the payment or cancel the round on the Orders page.",
    "2 items haven't been served yet. Mark them served or cancel them on the Orders page.",
  ]);
  for (const text of blockers) expect(text).not.toMatch(/[0-9a-f]{8}-|Submitted|Accepted|Batch/u);
});

it("WP-2423 D4: stops ordering, closes the completed order and releases the table, in order", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closing", sessionVersion: 5 }))
    .mockResolvedValueOnce(json({ status: "Committed", closureVersion: 1, closedOrderVersion: 6 }))
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closed", sessionVersion: 6 }));
  const plan: TableClosePlan = { done: new Set() };
  await closeTableSession({
    diningSessionReference: id(2),
    session: { phase: "Active", version: 4, orderReference: id(3) },
    progress,
    plan,
    csrf,
    fetcher,
  });
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/merchant/dining/closing",
    "/merchant/orders/close",
    "/merchant/dining/closing",
  ]);
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
  expect(bodies[0]).toMatchObject({ action: "Begin", expectedSessionVersion: 4 });
  expect(bodies[1]).toMatchObject({
    orderReference: id(3),
    expectedOrderVersion: 6,
    expectedClosureVersion: 0,
    reasonCode: "ORDER_COMPLETED",
  });
  expect(bodies[2]).toMatchObject({ action: "Finalize", expectedSessionVersion: 5 });
});

it("WP-2423 D4: a lost result is retried with the same requests; confirmed steps are not resent", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closing", sessionVersion: 5 }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(json({ status: "AlreadyApplied", phase: "Closed", sessionVersion: 6 }));
  const plan: TableClosePlan = { done: new Set() };
  const input = {
    diningSessionReference: id(2),
    // Nobody ordered at this table: no order to close.
    session: { phase: "Active" as const, version: 4, orderReference: null },
    progress: null,
    plan,
    csrf,
    fetcher,
    recovery: { delaysMs: [], recheckTimeoutMs: 1000 },
  };
  await expect(closeTableSession(input)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await closeTableSession(input);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  // A refusal is reported as such (the screen then checks the table again).
  const refused = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "denied" }, 409));
  await expect(
    closeTableSession({
      ...input,
      session: { phase: "Closing", version: 5, orderReference: null },
      plan: { done: new Set() },
      fetcher: refused,
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
});

it("WP-2423 D4: offers closing a table nobody ordered at, behind a confirmation", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TableSessionClose
        table={table}
        session={{ phase: "Active", version: 4, orderReference: null }}
        csrf={csrf}
        locked={false}
        onBusy={() => undefined}
        onClosed={() => undefined}
        onRefresh={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("The guests at table T12 have left");
  expect(html).toContain("Close table T12");
  expect(html).toContain("disabled");
  // With an order, its rounds are checked before anything is offered.
  const checking = renderToStaticMarkup(
    <MemoryRouter>
      <TableSessionClose
        table={table}
        session={{ phase: "Active", version: 4, orderReference: id(3) }}
        csrf={csrf}
        locked={false}
        onBusy={() => undefined}
        onClosed={() => undefined}
        onRefresh={() => undefined}
      />
    </MemoryRouter>,
  );
  expect(checking).toContain("Checking this table");
  expect(checking).not.toContain("Close table T12");
});

it("WP-2423 item 2: a table whose every round was cancelled closes its cancelled order too", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closing", sessionVersion: 5 }))
    .mockResolvedValueOnce(json({ status: "Committed", closureVersion: 1, closedOrderVersion: 6 }))
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closed", sessionVersion: 6 }));
  await closeTableSession({
    diningSessionReference: id(2),
    session: { phase: "Active", version: 4, orderReference: id(3) },
    progress: { ...progress, phase: "Cancelled", items: [item("Cancelled", 1, 7)] },
    plan: { done: new Set() },
    csrf,
    fetcher,
  });
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
  expect(fetcher.mock.calls[1]?.[0]).toBe("/merchant/orders/close");
  expect(bodies[1]).toMatchObject({ reasonCode: "ORDER_CANCELLED" });
});

it("WP-2423 B759: a table left in Closing continues from there — order closed, then released", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ status: "Committed", closureVersion: 1, closedOrderVersion: 38 }))
    .mockResolvedValueOnce(json({ status: "Applied", phase: "Closed", sessionVersion: 21 }));
  await closeTableSession({
    diningSessionReference: id(2),
    session: { phase: "Closing", version: 20, orderReference: id(3) },
    progress: {
      ...progress,
      sessionPhase: "Closing",
      currentOrderVersion: 38,
      phase: "Cancelled",
      items: [item("Cancelled", 1, 7)],
    },
    plan: { done: new Set() },
    csrf,
    fetcher,
  });
  const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/merchant/orders/close",
    "/merchant/dining/closing",
  ]);
  expect(bodies[0]).toMatchObject({ expectedOrderVersion: 38, reasonCode: "ORDER_CANCELLED" });
  expect(bodies[1]).toMatchObject({ action: "Finalize", expectedSessionVersion: 20 });
});
