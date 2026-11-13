import { expect, it, vi } from "vitest";
import { loadTableOrderFacts } from "./table-order-facts.js";
import { CURRENT_ORDER_REFS, currentOrderQueueFixture } from "./current-order-queue.fixtures.js";
import { tableNeed } from "./table-needs.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
const id = (n: number) => "018f7600-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const progress = (orderReference: string, phases: readonly string[]) => ({
  tableLabel: "SBC 1 (TEST)",
  orderReference,
  observedAt: "2026-11-13T12:00:00.000Z",
  items: phases.map((phase, index) => ({
    orderItemReference: id(700 + index),
    displayName: "Beef noodles (TEST)",
    batchSequence: index + 1,
    itemOrdinal: 1,
    orderBatchReference: id(800 + index),
    phase,
    orderedQuantity: 1,
    deliveredQuantity: phase === "Fulfilled" ? 1 : 0,
    remainingQuantity: phase === "Fulfilled" ? 0 : 1,
    itemServiceVersion: 1,
  })),
  closureStatus: "Open",
  sessionPhase: "Closing",
  diningSessionReference: id(900),
  closureVersion: 0,
  currentOrderVersion: 4,
  orderVersion: 4,
  sessionVersion: 3,
  tableAssignmentVersion: 2,
  phase: "Accepted",
});
const csrf = "a".repeat(43);

// v15 b12 live (SBC 1): a table comped to $0 with 3 dishes ready read "Nothing to pay · close
// when the guests leave" and offered no Serve all, while the table's own Mark served showed them.
it("b13: a table checking out is said from its own serving progress, so ready dishes offer Serve all", async () => {
  const queue = currentOrderQueueFixture();
  const table = CURRENT_ORDER_REFS.awaitingAcceptance;
  // The queue says nothing is ready for this table.
  const queued = {
    ...queue,
    items: queue.items.map((item) =>
      item.orderReference === table ? { ...item, readyToServeItemCount: 0 } : item,
    ),
  };
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) =>
    String(path) === "/merchant/dining/order-progress"
      ? json(
          progress(JSON.parse(String(init?.body)).orderReference as string, [
            "Ready",
            "Ready",
            "Ready",
          ]),
        )
      : json(queued),
  );
  const facts = await loadTableOrderFacts([table], new AbortController().signal, fetcher, {
    csrf,
    closing: new Set([table]),
  });
  expect(facts.get(table)).toMatchObject({ readyToServe: 3, inKitchen: false, allServed: false });
  // The Tables row then offers Serve all, before "Nothing to pay".
  const need = tableNeed(
    {
      tableReference: id(1),
      stableLabel: "SBC 1 (TEST)",
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      blockReasonCode: null,
      aggregateVersion: 1,
      currentDiningSessionReference: id(900),
      elapsedMinutes: 30,
      qrCodeValidUntil: "2027-01-01T00:00:00.000Z",
      paymentTiming: "PayLater",
      staffRoundsAwaitingPayment: [],
      guestRoundsAwaitingPayment: [],
      roundsAwaitingAcceptance: [],
      session: { phase: "Closing", version: 3, orderReference: table },
      staffCall: null,
    },
    {
      ...(facts.get(table) as NonNullable<ReturnType<typeof facts.get>>),
      bill: { totalMinor: "0", paid: null },
    },
    Date.parse("2026-11-13T12:00:00.000Z"),
  );
  expect(need.step).toBe("ServeAll");
});

it("b13: a table's Order the queue pages did not bring is read on its own; one that can't be read stays unsaid", async () => {
  const missing = id(42);
  const fetcher = vi.fn(async (path: RequestInfo | URL) =>
    String(path) === "/merchant/dining/order-progress"
      ? json(progress(missing, ["Ready", "Fulfilled"]))
      : json({ ...currentOrderQueueFixture(), items: [] }),
  );
  const facts = await loadTableOrderFacts([missing], new AbortController().signal, fetcher, {
    csrf,
    closing: new Set(),
  });
  expect(facts.get(missing)).toEqual({
    readyToServe: 1,
    inKitchen: false,
    allServed: false,
    bill: null,
  });
  const failing = vi.fn(async (path: RequestInfo | URL) =>
    String(path) === "/merchant/dining/order-progress"
      ? json({ error: "retry_later" }, 503)
      : json({ ...currentOrderQueueFixture(), items: [] }),
  );
  const none = await loadTableOrderFacts([missing], new AbortController().signal, failing, {
    csrf,
    closing: new Set(),
  });
  expect(none.size).toBe(0);
  // Without the table's own reads (an older caller), only the queue is read.
  const queueOnly = vi.fn(async () => json({ ...currentOrderQueueFixture(), items: [] }));
  await loadTableOrderFacts([missing], new AbortController().signal, queueOnly);
  expect(queueOnly).toHaveBeenCalledTimes(1);
});
