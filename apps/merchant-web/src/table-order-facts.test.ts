import { expect, it, vi } from "vitest";
import { loadTableKitchenFacts, loadTableOrderFacts } from "./table-order-facts.js";
import { listFactsOf } from "./DiningSessionWorkspace.js";
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
  const table = CURRENT_ORDER_REFS.awaitingAcceptance;
  const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) =>
    json(
      progress(JSON.parse(String(init?.body)).orderReference as string, [
        "Ready",
        "Ready",
        "Ready",
      ]),
    ),
  );
  const kitchen = await loadTableKitchenFacts([table], csrf, new AbortController().signal, fetcher);
  expect(kitchen.get(table)).toEqual({ readyToServe: 3, inKitchen: false, allServed: false });
  const closing = {
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
  } as const;
  // The queue said nothing is ready and the bill says nothing is to pay: the progress stands.
  const queued = new Map([
    [
      table,
      { readyToServe: 0, inKitchen: false, allServed: true, bill: { totalMinor: "0", paid: null } },
    ],
  ]);
  const facts = listFactsOf(closing, queued, new Map(), 1, kitchen);
  expect(facts).toMatchObject({ readyToServe: 3, bill: { totalMinor: "0" } });
  const need = tableNeed(closing, facts, Date.parse("2026-11-13T12:00:00.000Z"));
  expect(need.step).toBe("ServeAll");
  // Before the queue or the bill answered, dishes at the pass are said already.
  expect(listFactsOf(closing, new Map(), new Map(), 0, kitchen)).toMatchObject({ readyToServe: 3 });
  // Nothing ready: still "Checking the bill" until the bill is read.
  const none = new Map([[table, { readyToServe: 0, inKitchen: false, allServed: true }]]);
  expect(listFactsOf(closing, new Map(), new Map(), 0, none)).toBeNull();
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
  });
  expect(none.size).toBe(0);
  // Without the table's own reads (an older caller), only the queue is read.
  const queueOnly = vi.fn(async () => json({ ...currentOrderQueueFixture(), items: [] }));
  await loadTableOrderFacts([missing], new AbortController().signal, queueOnly);
  expect(queueOnly).toHaveBeenCalledTimes(1);
});
