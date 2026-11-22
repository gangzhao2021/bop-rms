import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpDiningSessionClient,
  DiningSessionClientError,
  loadTableQuietly,
  parseDiningSessionView,
  type DiningSessionView,
} from "./dining-session-client.js";
import {
  setCustomerCsrfCredential,
  setSettledTable,
  setEmptyTable,
} from "../session/customer-transaction-context.js";

const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
function payload() {
  return {
    schemaVersion: 1,
    session: {
      tableLabel: "12",
      orderNumber: "1042",
      checkedAt: "2026-10-13T18:00:00.000Z",
      rounds: [
        {
          roundNumber: 1,
          orderedBy: "You",
          submittedAt: "2026-10-13T17:50:00.000Z",
          status: "Preparing",
          payment: "Paid",
          cancelsAt: null,
          storeCancellationReason: null,
          items: [
            {
              displayName: "Ramen",
              quantity: 2,
              servedQuantity: 0,
              cancelled: false,
              lineTotal: cad("3000"),
            },
          ],
          itemsTotal: cad("3000"),
        },
      ],
      summary: { paid: cad("3390"), refunded: cad("0"), refundPending: cad("0"), due: cad("0") },
    },
  };
}
afterEach(() => setCustomerCsrfCredential(null));
function firstRound(p: ReturnType<typeof payload>) {
  const round = p.session.rounds[0];
  if (round === undefined) throw new Error("fixture");
  return round;
}

describe("WP-2423 Q8 dining session client", () => {
  it("WP-2423 item 8 ⑦ 4b-3: decodes the per-head tea on the bill, and rejects anything else", () => {
    const base = payload() as { session: { summary: Record<string, unknown> } };
    const withTea = structuredClone(base);
    withTea.session.summary.teaCharge = { perGuest: cad("150"), guests: 4 };
    expect(parseDiningSessionView(withTea).summary?.teaCharge).toEqual({
      perGuest: cad("150"),
      guests: 4,
    });
    for (const teaCharge of [
      { perGuest: cad("150"), guests: 0 },
      { perGuest: cad("150") },
      { perGuest: "1.50", guests: 4 },
    ]) {
      const value = structuredClone(base);
      value.session.summary.teaCharge = teaCharge;
      expect(() => parseDiningSessionView(value)).toThrow();
    }
  });

  it("b13: decodes a bill read as printed for the table and a round; lines that don't add up are not shown", () => {
    const lines = {
      items: cad("5000"),
      takenOff: cad("2750"),
      pointsUsed: cad("0"),
      subtotal: cad("2250"),
      tax: cad("293"),
      total: cad("2543"),
    };
    const base = payload() as unknown as {
      session: { summary: Record<string, unknown>; rounds: Record<string, unknown>[] };
    };
    const billed = structuredClone(base);
    billed.session.summary.bill = lines;
    (billed.session.rounds[0] as Record<string, unknown>).bill = lines;
    const view = parseDiningSessionView(billed);
    expect(view.summary?.bill).toEqual(lines);
    expect(view.rounds[0]?.bill).toEqual(lines);
    expect(parseDiningSessionView(base).summary?.bill).toBeUndefined();
    // b13 review: a line with an order-time discount or fee leaves the lines not adding up: only
    // those lines go unsaid, the guest's table page still reads (never "unavailable").
    for (const uneven of [
      { ...lines, tax: cad("294") },
      { ...lines, takenOff: cad("2700") },
    ]) {
      const value = structuredClone(base);
      value.session.summary.bill = uneven;
      (value.session.rounds[0] as Record<string, unknown>).bill = uneven;
      const read = parseDiningSessionView(value);
      expect(read.summary?.bill).toBeUndefined();
      expect(read.rounds[0]?.bill).toBeUndefined();
      expect(read.summary?.due).toEqual(parseDiningSessionView(base).summary?.due);
    }
    // A malformed value is still refused.
    for (const broken of [
      { ...lines, takenOff: cad("-1") },
      { ...lines, extra: cad("0") },
    ]) {
      const value = structuredClone(base);
      value.session.summary.bill = broken;
      expect(() => parseDiningSessionView(value)).toThrow();
    }
  });

  it("WP-2423 item 8b: decodes a charge round and the charge's name; absence stays fine", () => {
    const p = payload();
    const charged = structuredClone(p) as unknown as {
      session: {
        rounds: Record<string, unknown>[];
        summary: { teaCharge?: unknown };
      };
    };
    (charged.session.rounds[0] as Record<string, unknown>).charge = true;
    charged.session.summary.teaCharge = {
      perGuest: cad("200"),
      guests: 4,
      name: "Sauce bar",
    };
    const view = parseDiningSessionView(charged);
    expect(view.rounds[0]?.charge).toBe(true);
    expect(view.summary?.teaCharge?.name).toBe("Sauce bar");
    expect(parseDiningSessionView(p).rounds[0]).not.toHaveProperty("charge");
    (charged.session.rounds[0] as Record<string, unknown>).charge = false;
    expect(() => parseDiningSessionView(charged)).toThrow();
    (charged.session.rounds[0] as Record<string, unknown>).charge = true;
    charged.session.summary.teaCharge = { perGuest: cad("200"), guests: 4, name: "<b>" };
    expect(() => parseDiningSessionView(charged)).toThrow();
  });

  it("v15 2026-10-29: decodes a round that is only the tea, and nothing but true", () => {
    const p = payload();
    const tea = structuredClone(p) as unknown as { session: { rounds: Record<string, unknown>[] } };
    (tea.session.rounds[0] as Record<string, unknown>).tea = true;
    expect(parseDiningSessionView(tea).rounds[0]?.tea).toBe(true);
    expect(parseDiningSessionView(p).rounds[0]).not.toHaveProperty("tea");
    (tea.session.rounds[0] as Record<string, unknown>).tea = false;
    expect(() => parseDiningSessionView(tea)).toThrow();
  });

  it("decodes the closed table view", () => {
    const view = parseDiningSessionView(payload());
    expect(view.rounds[0]?.orderedBy).toBe("You");
    expect(view.summary?.paid.amountMinor).toBe("3390");
  });

  it.each([
    ["an extra field", (p: ReturnType<typeof payload>) => Object.assign(p.session, { guest: "x" })],
    [
      "an unknown status",
      (p: ReturnType<typeof payload>) => Object.assign(firstRound(p), { status: "Lost" }),
    ],
    [
      "served beyond ordered",
      (p: ReturnType<typeof payload>) =>
        Object.assign(firstRound(p).items[0] as object, { servedQuantity: 3 }),
    ],
    [
      "a fractional amount",
      (p: ReturnType<typeof payload>) => Object.assign(firstRound(p), { itemsTotal: cad("30.00") }),
    ],
    [
      "a summary without rounds",
      (p: ReturnType<typeof payload>) => Object.assign(p.session, { rounds: [] }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = payload();
    mutate(value);
    expect(() => parseDiningSessionView(value)).toThrow(DiningSessionClientError);
  });

  it("says the table was settled for a guest whose visit ended at a settled table", async () => {
    setCustomerCsrfCredential(null);
    const request = vi.fn();
    const client = createHttpDiningSessionClient(request as unknown as typeof fetch);
    await expect(client.load()).rejects.toMatchObject({ code: "not-joined" });
    setSettledTable({ tableLabel: "DEMO-02", csrfToken: "C".repeat(43) });
    try {
      await expect(client.load()).rejects.toMatchObject({
        code: "settled",
        tableLabel: "DEMO-02",
      });
    } finally {
      setSettledTable(null);
    }
    expect(request).not.toHaveBeenCalled();
  });

  // Batch 45 (v15 b44 live): a table staff closed with nothing ordered is said ended, never
  // "join your table first", and nothing is asked of the server.
  it("says the visit ended for a guest whose table closed with nothing ordered", async () => {
    setCustomerCsrfCredential(null);
    const request = vi.fn();
    const client = createHttpDiningSessionClient(request as unknown as typeof fetch);
    setEmptyTable({ tableLabel: "V44 A (TEST)" });
    try {
      await expect(client.load()).rejects.toMatchObject({
        code: "ended-empty",
        tableLabel: "V44 A (TEST)",
      });
    } finally {
      setEmptyTable(null);
    }
    await expect(client.load()).rejects.toMatchObject({ code: "not-joined" });
    expect(request).not.toHaveBeenCalled();
  });

  // v15 b17 review: "still processing" carries the server's Retry-After, so phones read again
  // when the server asks (5 s in a burst), within 1 to 30 seconds, and 2 s when it does not say.
  it.each([
    ["5", 5],
    ["2", 2],
    [null, 2],
    ["0", 2],
    ["abc", 2],
    ["600", 30],
  ])("v15 b17 review: still processing with Retry-After %s waits %d s", async (header, wait) => {
    setCustomerCsrfCredential("c".repeat(43));
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "dining_session_order_processing" } }), {
          status: 503,
          headers: header === null ? {} : { "retry-after": header },
        }),
    );
    const client = createHttpDiningSessionClient(request as unknown as typeof fetch);
    await expect(client.load()).rejects.toMatchObject({
      code: "processing",
      retryAfterSeconds: wait,
    });
  });

  it("sends only the CSRF header to the fixed route and maps refusals to not joined", async () => {
    setCustomerCsrfCredential("c".repeat(43));
    const request = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 }));
    const client = createHttpDiningSessionClient(request as unknown as typeof fetch);
    await expect(client.load()).resolves.toMatchObject({ tableLabel: "12" });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/session");
    expect(init.headers).toEqual({ accept: "application/json", "x-csrf-token": "c".repeat(43) });
    request.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(client.load()).rejects.toMatchObject({ code: "not-joined" });
    request.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(client.load()).rejects.toMatchObject({ code: "unavailable" });
    request.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.load()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("WP-2423 item 8 ③ decision 13: decodes what Order again adds, and rejects anything else", () => {
    const reference = (n: number) => "018f8a30-0000-7000-8000-" + String(n).padStart(12, "0");
    const again = {
      sellableReference: reference(1),
      optionSelections: [{ optionReference: reference(2), quantity: 1 }],
    };
    const withAgain = payload();
    Object.assign(firstRound(withAgain).items[0] as object, { orderAgain: again });
    expect(parseDiningSessionView(withAgain).rounds[0]?.items[0]?.orderAgain).toEqual(again);
    for (const wrong of [
      { ...again, sellableReference: "not-a-reference" },
      { ...again, optionSelections: [{ optionReference: reference(2), quantity: 0 }] },
      { ...again, customerNote: "spicy" },
    ]) {
      const value = payload();
      Object.assign(firstRound(value).items[0] as object, { orderAgain: wrong });
      expect(() => parseDiningSessionView(value)).toThrow();
    }
  });

  it("WP-2423 Q26: decodes a dish the kitchen is making again, and rejects any other value", () => {
    const remade = payload();
    Object.assign(firstRound(remade).items[0] as object, { beingRemade: true });
    expect(parseDiningSessionView(remade).rounds[0]?.items[0]).toMatchObject({
      beingRemade: true,
    });
    expect(parseDiningSessionView(payload()).rounds[0]?.items[0]).not.toHaveProperty("beingRemade");
    for (const value of [false, "true", 1, null]) {
      const wrong = payload();
      Object.assign(firstRound(wrong).items[0] as object, { beingRemade: value });
      expect(() => parseDiningSessionView(wrong)).toThrow(DiningSessionClientError);
    }
  });

  it("b25 final: decodes a dish staff took off the bill, and rejects any other value", () => {
    const off = payload();
    Object.assign(firstRound(off).items[0] as object, { cancelled: true, takenOff: true });
    expect(parseDiningSessionView(off).rounds[0]?.items[0]).toMatchObject({
      cancelled: true,
      takenOff: true,
    });
    expect(parseDiningSessionView(payload()).rounds[0]?.items[0]).not.toHaveProperty("takenOff");
    for (const change of [
      { cancelled: true, takenOff: false },
      { cancelled: true, takenOff: "true" },
      { cancelled: true, takenOff: null },
      // Only a cancelled dish can have been taken off the bill.
      { cancelled: false, takenOff: true },
    ]) {
      const wrong = payload();
      Object.assign(firstRound(wrong).items[0] as object, change);
      expect(() => parseDiningSessionView(wrong)).toThrow(DiningSessionClientError);
    }
  });

  it("b39: decodes a dish taken off because it sold out, only with takenOff", () => {
    const off = payload();
    Object.assign(firstRound(off).items[0] as object, {
      cancelled: true,
      takenOff: true,
      soldOut: true,
    });
    expect(parseDiningSessionView(off).rounds[0]?.items[0]).toMatchObject({ soldOut: true });
    for (const change of [
      { cancelled: true, takenOff: true, soldOut: false },
      { cancelled: true, soldOut: true },
    ]) {
      const wrong = payload();
      Object.assign(firstRound(wrong).items[0] as object, change);
      expect(() => parseDiningSessionView(wrong)).toThrow(DiningSessionClientError);
    }
  });

  it("b39 review: decodes the table a merged-in round was ordered at, and refuses a bad one", () => {
    const merged = payload();
    Object.assign(firstRound(merged), { fromTable: "H6" });
    expect(parseDiningSessionView(merged).rounds[0]?.fromTable).toBe("H6");
    expect(parseDiningSessionView(payload()).rounds[0]).not.toHaveProperty("fromTable");
    for (const fromTable of ["", 6, null, "<b>H6</b>", "x".repeat(41)]) {
      const wrong = payload();
      Object.assign(firstRound(wrong), { fromTable });
      expect(() => parseDiningSessionView(wrong)).toThrow(DiningSessionClientError);
    }
  });

  it("does not call the server without this browser's session", async () => {
    const request = vi.fn();
    await expect(
      createHttpDiningSessionClient(request as unknown as typeof fetch).load(),
    ).rejects.toMatchObject({ code: "not-joined" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("WP-2423 D5 item prices before tax", () => {
  function priced() {
    const p = payload();
    const round = firstRound(p);
    const item = round.items[0];
    if (item === undefined) throw new Error("fixture");
    Object.assign(item, { priceBeforeTax: cad("2655") });
    Object.assign(round, { subtotal: cad("2655"), tax: cad("345") });
    Object.assign(p.session.summary, {
      ordered: { subtotal: cad("2655"), tax: cad("345"), total: cad("3000") },
    });
    return p;
  }

  it("decodes item prices before tax and the round and table subtotal and tax", () => {
    const view = parseDiningSessionView(priced());
    expect(view.rounds[0]?.items[0]?.priceBeforeTax).toEqual(cad("2655"));
    expect(view.rounds[0]?.items[0]?.lineTotal).toEqual(cad("3000"));
    expect(view.rounds[0]?.subtotal).toEqual(cad("2655"));
    expect(view.rounds[0]?.tax).toEqual(cad("345"));
    expect(view.rounds[0]?.itemsTotal).toEqual(cad("3000"));
    expect(view.summary?.ordered).toEqual({
      subtotal: cad("2655"),
      tax: cad("345"),
      total: cad("3000"),
    });
    // Without them (an older server) nothing before tax is invented.
    const plain = parseDiningSessionView(payload());
    expect(plain.rounds[0]).not.toHaveProperty("subtotal");
    expect(plain.summary).not.toHaveProperty("ordered");
  });

  it.each([
    [
      "a subtotal that is not the items before tax",
      (p: ReturnType<typeof priced>) => Object.assign(firstRound(p), { subtotal: cad("2600") }),
    ],
    [
      "a subtotal without tax",
      (p: ReturnType<typeof priced>) => {
        const round = firstRound(p) as Record<string, unknown>;
        delete round.tax;
      },
    ],
    [
      "an item without its price before tax",
      (p: ReturnType<typeof priced>) => {
        const item = firstRound(p).items[0] as Record<string, unknown>;
        delete item.priceBeforeTax;
      },
    ],
    [
      "a table breakdown with an unpriced round",
      (p: ReturnType<typeof priced>) => {
        const round = firstRound(p) as Record<string, unknown>;
        delete round.subtotal;
        delete round.tax;
        delete (firstRound(p).items[0] as Record<string, unknown>).priceBeforeTax;
      },
    ],
    [
      "a priced round without the table breakdown",
      (p: ReturnType<typeof priced>) => {
        delete (p.session.summary as Record<string, unknown>).ordered;
      },
    ],
    [
      "a negative tax",
      (p: ReturnType<typeof priced>) => Object.assign(firstRound(p), { tax: cad("-1") }),
    ],
  ])("refuses %s", (_label, change) => {
    const p = priced();
    change(p);
    expect(() => parseDiningSessionView(p)).toThrow(DiningSessionClientError);
  });
});

describe("WP-2423 item 8 ⑤ a round waiting for staff", () => {
  it("decodes the waiting round and why, and refuses an unknown reason", () => {
    const p = payload();
    Object.assign(firstRound(p), {
      status: "WaitingForStaff",
      payment: "NotCharged",
      waitingReason: "FirstOrder",
    });
    const round = parseDiningSessionView(p).rounds[0];
    expect(round?.status).toBe("WaitingForStaff");
    expect(round?.waitingReason).toBe("FirstOrder");
    Object.assign(firstRound(p), { waitingReason: "Suspicious" });
    expect(() => parseDiningSessionView(p)).toThrow();
  });
});

describe("v15 batch-5: a round stopped before anyone paid", () => {
  it("decodes it only on a round cancelled unpaid", () => {
    const p = payload();
    Object.assign(firstRound(p), {
      status: "NotPaidCancelled",
      payment: "NotCharged",
      stoppedBeforePaying: true,
    });
    expect(parseDiningSessionView(p).rounds[0]?.stoppedBeforePaying).toBe(true);
    Object.assign(firstRound(p), { status: "Preparing", payment: "Paid" });
    expect(() => parseDiningSessionView(p)).toThrow(DiningSessionClientError);
  });
});

describe("v15 b20: what went back for a round's cancelled dishes", () => {
  it("decodes the refund on its round, and refuses zero, more than the round or another currency", () => {
    const p = payload();
    Object.assign(firstRound(p), { refunded: cad("900") });
    expect(parseDiningSessionView(p).rounds[0]?.refunded).toEqual(cad("900"));
    expect(parseDiningSessionView(p).rounds[0]).not.toHaveProperty("refundPending");
    Object.assign(firstRound(p), { refundPending: cad("2100") });
    expect(parseDiningSessionView(p).rounds[0]?.refundPending).toEqual(cad("2100"));
    for (const broken of [
      { refunded: cad("0") },
      { refundPending: cad("2101") },
      { refunded: { amountMinor: "900", currencyCode: "USD" } },
    ]) {
      const q = payload();
      Object.assign(firstRound(q), { refunded: cad("900"), refundPending: cad("100") }, broken);
      expect(() => parseDiningSessionView(q)).toThrow(DiningSessionClientError);
    }
    expect(parseDiningSessionView(payload()).rounds[0]).not.toHaveProperty("refunded");
  });
});

describe("DEC-DINING-GUEST-TABLE-START: the table view", () => {
  const session = (changes: object) => ({
    schemaVersion: 1,
    session: {
      tableLabel: "T1",
      orderNumber: null,
      checkedAt: "2026-11-05T12:00:00.000Z",
      paymentTiming: "PayFirst",
      rounds: [],
      summary: null,
      ...changes,
    },
  });
  it("says a guest started this table only when it did, and reads a table without the key", () => {
    expect(parseDiningSessionView(session({})).startedByGuest).toBeUndefined();
    expect(parseDiningSessionView(session({ startedByGuest: true })).startedByGuest).toBe(true);
    expect(() => parseDiningSessionView(session({ startedByGuest: "yes" }))).toThrow();
  });
  it("WP-2423 table-move-payment: reads the table a moved party came from, a label only", () => {
    expect(parseDiningSessionView(session({})).movedFromTableLabel).toBeUndefined();
    expect(parseDiningSessionView(session({ movedFromTableLabel: "T6" })).movedFromTableLabel).toBe(
      "T6",
    );
    for (const bad of ["", 7, null, "x".repeat(81)])
      expect(() => parseDiningSessionView(session({ movedFromTableLabel: bad }))).toThrow();
  });
});

describe("M91/M41: dish progress and a paid round the store has not accepted", () => {
  it("decodes each dish's progress and the waiting round, and rejects anything else", () => {
    const view = payload();
    Object.assign(firstRound(view).items[0] as object, { progress: "Making" });
    Object.assign(firstRound(view), { awaitingStore: true });
    const round = parseDiningSessionView(view).rounds[0];
    expect(round?.items[0]?.progress).toBe("Making");
    expect(round?.awaitingStore).toBe(true);
    expect(parseDiningSessionView(payload()).rounds[0]).not.toHaveProperty("awaitingStore");
    const wrongProgress = payload();
    Object.assign(firstRound(wrongProgress).items[0] as object, { progress: "Cooking" });
    expect(() => parseDiningSessionView(wrongProgress)).toThrow(DiningSessionClientError);
    const wrongWait = payload();
    Object.assign(firstRound(wrongWait), { awaitingStore: false });
    expect(() => parseDiningSessionView(wrongWait)).toThrow(DiningSessionClientError);
  });
});

describe("v15 batch 7 table-pay-by-dish: a table paying by dish after the first guest paid", () => {
  it("reads a bill paid by dish with one payment so far, and still refuses a broken split", () => {
    const base = payload() as { session: { summary: Record<string, unknown> } };
    const byDish = structuredClone(base);
    byDish.session.summary.splitParts = { count: null, paid: 1 };
    expect(parseDiningSessionView(byDish).summary?.splitParts).toEqual({ count: null, paid: 1 });
    const even = structuredClone(base);
    even.session.summary.splitParts = { count: 2, paid: 1 };
    expect(parseDiningSessionView(even).summary?.splitParts).toEqual({ count: 2, paid: 1 });
    for (const splitParts of [
      { count: 1, paid: 1 },
      { count: 2, paid: 3 },
      { count: null, paid: -1 },
      { paid: 1 },
    ]) {
      const value = structuredClone(base);
      value.session.summary.splitParts = splitParts;
      expect(() => parseDiningSessionView(value)).toThrow(DiningSessionClientError);
    }
  });
});

// Batch 41 (v15 b40 live): the table read answers "still being prepared" (503, Retry-After 2) for
// the second after a round is written. A page reading the table once waits and reads again.
describe("batch 41: a one-off table read waits out 'still being prepared'", () => {
  const view = parseDiningSessionView(payload()) as DiningSessionView;
  const processing = () => new DiningSessionClientError("processing", null, false, 2);
  afterEach(() => vi.useRealTimers());
  it("reads again after the wait the server asked for, then answers the table", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<DiningSessionView>>()
      .mockRejectedValueOnce(processing())
      .mockResolvedValueOnce(view);
    const result = loadTableQuietly({ load }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(view);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("any other answer ends it at once, and so does a lasting 'still being prepared'", async () => {
    vi.useFakeTimers();
    const unavailable = new DiningSessionClientError("unavailable");
    const once = vi.fn<() => Promise<DiningSessionView>>().mockRejectedValue(unavailable);
    await expect(loadTableQuietly({ load: once }, new AbortController().signal)).rejects.toBe(
      unavailable,
    );
    expect(once).toHaveBeenCalledTimes(1);
    const always = vi.fn<() => Promise<DiningSessionView>>().mockRejectedValue(processing());
    const result = loadTableQuietly({ load: always }, new AbortController().signal, 3);
    const settled = expect(result).rejects.toMatchObject({ code: "processing" });
    await vi.advanceTimersByTimeAsync(4000);
    await settled;
    expect(always).toHaveBeenCalledTimes(3);
  });
  it("a page that went away stops waiting, with no further read", async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<DiningSessionView>>().mockRejectedValue(processing());
    const controller = new AbortController();
    const result = loadTableQuietly({ load }, controller.signal);
    const settled = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// Batch 47: the open tabs' "still at the table?" read (table-visit-watch) never changes how the
// page thinks the table pays (a pay-at-the-end refusal taught the cart "Place order").
it("batch 47: a read that only checks the table leaves the known table timing alone", async () => {
  const { getTablePaymentTiming, setTablePaymentTiming } =
    await import("../session/customer-transaction-context.js");
  setCustomerCsrfCredential("A".repeat(43));
  setTablePaymentTiming("PayLater");
  const answer = () =>
    new Response(
      JSON.stringify({
        ...payload(),
        session: { ...payload().session, paymentTiming: "PayFirst" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await createHttpDiningSessionClient(
    vi.fn(async () => answer()),
    {
      learnsTiming: false,
    },
  ).load();
  expect(getTablePaymentTiming()).toBe("PayLater");
  await createHttpDiningSessionClient(vi.fn(async () => answer())).load();
  expect(getTablePaymentTiming()).toBe("PayFirst");
  setCustomerCsrfCredential(null);
});
