import { afterEach, describe, expect, it, vi } from "vitest";
import type { StaffDiningTable } from "./dining-session-client.js";
import type { TableBill } from "./table-checkout-client.js";
import { listBillsByOrder, readListBills, type ListBill } from "./table-list-bills.js";

const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const table = (n: number, phase: "Active" | "Closing" = "Closing") =>
  ({
    tableReference: id(n),
    stableLabel: "T" + String(n),
    currentDiningSessionReference: id(100 + n),
    session: { phase, version: 3, orderReference: id(200 + n) },
  }) as unknown as StaffDiningTable;
const bill = (paid: boolean, totalMinor = "4238") =>
  ({
    paymentTiming: "PayLater",
    owed: paid
      ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
      : { subtotalMinor: "3750", taxMinor: "488", totalMinor },
    settlement: paid ? { roundsMinor: totalMinor, totalMinor } : null,
    split: null,
    rounds: [],
  }) as unknown as TableBill;

const failure = () => Object.assign(new Error("retry_later"), { code: "ServerProblem" });

function setup() {
  let reads = 0;
  return {
    kept: new Map<string, ListBill>(),
    inFlight: new Set<string>(),
    nextRead: () => (reads += 1),
    signal: new AbortController().signal,
    shown: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe("v15 batch 11: the Tables list reads each table's bill on its own", () => {
  it("one table whose bill read fails never stops the tables after it, nor drops those read", async () => {
    const state = setup();
    const items = [table(1), table(2), table(3), table(4)];
    // Table 2's bill answers 503 every time (as BR C did at Test Merchant 2).
    const read = vi.fn(async (session: string) => {
      if (session === id(102)) throw failure();
      return bill(session === id(104));
    });
    await readListBills({ items, queued: new Map(), poll: 1, read, ...state });
    expect(read).toHaveBeenCalledTimes(4);
    const byOrder = listBillsByOrder(items, state.kept);
    expect([...byOrder.keys()].sort()).toEqual([id(201), id(203), id(204)]);
    expect(byOrder.get(id(204))?.facts.bill?.paid).toEqual({ amountMinor: "4238" });
    expect(byOrder.get(id(201))?.facts.bill).toMatchObject({ totalMinor: "4238", paid: null });
    // Each table is shown as its answer comes, not after the slowest one.
    expect(state.shown).toHaveBeenCalledTimes(3);
  });

  it("a table whose read fails keeps what was read for it before", async () => {
    const state = setup();
    const items = [table(1)];
    await readListBills({
      items,
      queued: new Map(),
      poll: 1,
      read: async () => bill(false),
      ...state,
    });
    await readListBills({
      items,
      queued: new Map(),
      poll: 2,
      read: async () => Promise.reject(failure()),
      ...state,
    });
    expect(state.kept.get(id(101))?.facts.bill?.totalMinor).toBe("4238");
  });

  it("a read that never answers is given up at its time limit, and the others still show", async () => {
    vi.useFakeTimers();
    const state = setup();
    const items = [table(1), table(2)];
    const aborted: string[] = [];
    const read = (session: string, signal: AbortSignal) =>
      session === id(101)
        ? new Promise<TableBill>((_, reject) =>
            signal.addEventListener("abort", () => {
              aborted.push(session);
              reject(new Error("aborted"));
            }),
          )
        : Promise.resolve(bill(true));
    const done = readListBills({
      items,
      queued: new Map(),
      poll: 1,
      read,
      limitMs: 15_000,
      ...state,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.kept.has(id(102))).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(aborted).toEqual([id(101)]);
    expect(state.inFlight.size).toBe(0);
  });

  it("a late answer from an older read never replaces a newer one", async () => {
    const state = setup();
    const items = [table(1)];
    let answerOld: (value: TableBill) => void = () => undefined;
    const old = readListBills({
      items,
      queued: new Map(),
      poll: 1,
      read: () => new Promise<TableBill>((resolve) => (answerOld = resolve)),
      ...state,
    });
    // The older read is still out: a newer list read does not send a second one for this table…
    const skipped = vi.fn(async () => bill(true));
    await readListBills({ items, queued: new Map(), poll: 2, read: skipped, ...state });
    expect(skipped).not.toHaveBeenCalled();
    answerOld(bill(false));
    await old;
    // …the next one does, and its paid bill stays when a read started before it answers late.
    let answerSlow: (value: TableBill) => void = () => undefined;
    state.kept.delete(id(101));
    const slow = readListBills({
      items,
      queued: new Map(),
      poll: 3,
      read: () => new Promise<TableBill>((resolve) => (answerSlow = resolve)),
      ...state,
    });
    state.inFlight.clear();
    await readListBills({
      items,
      queued: new Map(),
      poll: 4,
      read: async () => bill(true),
      ...state,
    });
    answerSlow(bill(false));
    await slow;
    expect(state.kept.get(id(101))?.facts.bill?.paid).toEqual({ amountMinor: "4238" });
  });

  it("a table checking out is read once per list read; another only when the queue changed", async () => {
    const state = setup();
    const items = [table(1), table(2, "Active")];
    const read = vi.fn(async () => bill(false));
    const queued = new Map([
      [id(202), { readyToServe: 0, inKitchen: true, allServed: false, bill: null }],
    ]);
    await readListBills({ items, queued, poll: 1, read, ...state });
    await readListBills({ items, queued, poll: 1, read, ...state });
    expect(read).toHaveBeenCalledTimes(2);
    await readListBills({ items, queued, poll: 2, read, ...state });
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith(id(101), expect.anything());
  });

  it("stops reading when the page is left, and forgets tables no longer open", async () => {
    const state = setup();
    await readListBills({
      items: [table(1), table(2)],
      queued: new Map(),
      poll: 1,
      read: async () => bill(false),
      ...state,
    });
    const left = new AbortController();
    left.abort();
    const read = vi.fn(async () => bill(false));
    await readListBills({
      items: [table(1)],
      queued: new Map(),
      poll: 2,
      read,
      ...state,
      signal: left.signal,
    });
    expect(read).not.toHaveBeenCalled();
    expect([...state.kept.keys()]).toEqual([id(101)]);
  });
});
