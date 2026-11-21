import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { OrderStatusProjectionError } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerDiningSessionHandler } from "./customer-dining-session.js";
import {
  DiningOrderStillProcessingError,
  DiningSessionReadBusyError,
  type CustomerDiningSessionView,
} from "./customer-dining-session-read.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
function view(): CustomerDiningSessionView {
  return {
    tableLabel: "12",
    orderNumber: "1042",
    checkedAt: "2026-10-13T18:00:00.000Z",
    paymentTiming: "PayFirst",
    rounds: [
      {
        roundNumber: 1,
        orderedBy: "AnotherGuest",
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
            lineTotal: cad(3000n),
          },
        ],
        itemsTotal: cad(3000n),
      },
    ],
    summary: { paid: cad(3390n), refunded: cad(0n), refundPending: cad(0n), due: cad(0n) },
  };
}
async function setup(enabled = true, processingRereadMs: readonly number[] = [1, 1]) {
  const read = vi.fn().mockResolvedValue(view());
  const server = createServer(
    createApp(
      enabled
        ? {
            customerDiningSession: new CustomerDiningSessionHandler({
              allowedOrigin: "https://pilot.example",
              port: { read },
              processingRereadMs,
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1/dine-in/session";
  return {
    read,
    send: (headers: Record<string, string> = {}, query = "", signal?: AbortSignal) =>
      fetch(url + query, {
        ...(signal === undefined ? {} : { signal }),
        headers: {
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
          "x-csrf-token": "c".repeat(43),
          ...headers,
        },
      }),
  };
}

it("b39 review: a merged-in round is sent with the table it was ordered at, others without", async () => {
  const f = await setup();
  const base = view();
  const first = base.rounds[0] as CustomerDiningSessionView["rounds"][number];
  f.read.mockResolvedValue({
    ...base,
    rounds: [first, { ...first, roundNumber: 2, fromTable: "H6" }],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: Record<string, unknown>[] };
  };
  expect(body.session.rounds[0]).not.toHaveProperty("fromTable");
  expect(body.session.rounds[1]?.fromTable).toBe("H6");
});

it("v15 batch-5: a round its payer stopped before paying is sent as such, others are not", async () => {
  const f = await setup();
  const base = view();
  const stopped = {
    ...(base.rounds[0] as CustomerDiningSessionView["rounds"][number]),
    status: "NotPaidCancelled" as const,
    payment: "NotCharged" as const,
  };
  f.read.mockResolvedValue({
    ...base,
    rounds: [
      { ...stopped, stoppedBeforePaying: true as const },
      { ...stopped, roundNumber: 2 },
    ],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: Record<string, unknown>[] };
  };
  expect(body.session.rounds[0]?.stoppedBeforePaying).toBe(true);
  expect(body.session.rounds[1]).not.toHaveProperty("stoppedBeforePaying");
});

it("WP-2423 Q8: returns the guest's own table view with money as strings and no-store", async () => {
  const f = await setup();
  const response = await f.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const body = (await response.json()) as {
    schemaVersion: number;
    session: { rounds: { orderedBy: string; itemsTotal: unknown }[]; summary: unknown };
  };
  expect(body.schemaVersion).toBe(1);
  expect(body.session.rounds[0]?.orderedBy).toBe("AnotherGuest");
  expect(body.session.rounds[0]?.itemsTotal).toEqual({ amountMinor: "3000", currencyCode: "CAD" });
  expect(f.read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
  });
});

it("refuses cross-site requests, missing CSRF and any caller-chosen table or session", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://foreign.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-csrf-token": "" },
    { cookie: "" },
  ])
    expect((await f.send(headers)).status).toBe(400);
  expect((await f.send({}, "?table=7")).status).toBe(400);
  expect((await f.send({}, "?session=" + "0".repeat(8))).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});

it("answers a non-participant with not found and hides dependency details", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  expect((await f.send()).status).toBe(404);
  f.read.mockRejectedValue(new Error("private SQL detail"));
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});

it("serializes only customer-safe fields and is unavailable when unconfigured", async () => {
  const f = await setup();
  const leaky = view() as unknown as Record<string, unknown>;
  leaky.diningSessionReference = "private";
  const firstRound = (leaky.rounds as Record<string, unknown>[])[0];
  if (firstRound === undefined) throw new Error("fixture");
  firstRound.submittedByActorReference = "private";
  f.read.mockResolvedValue(leaky);
  const response = await f.send();
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("private");
  const off = await setup(false);
  expect((await off.send()).status).toBe(503);
});

it("WP-2423 D5: sends item prices before tax and the round and table subtotal and tax as strings", async () => {
  const f = await setup();
  const priced = view();
  const round = priced.rounds[0];
  if (round === undefined || priced.summary === null) throw new Error("fixture");
  f.read.mockResolvedValueOnce({
    ...priced,
    rounds: [
      {
        ...round,
        items: round.items.map((entry) => ({ ...entry, priceBeforeTax: cad(2655n) })),
        subtotal: cad(2655n),
        tax: cad(345n),
      },
    ],
    summary: {
      ...priced.summary,
      ordered: { subtotal: cad(2655n), tax: cad(345n), total: cad(3000n) },
    },
  });
  const body = (await (await f.send()).json()) as {
    session: {
      rounds: {
        items: { priceBeforeTax: unknown; lineTotal: unknown }[];
        subtotal: unknown;
        tax: unknown;
        itemsTotal: unknown;
      }[];
      summary: { ordered: unknown; due: unknown };
    };
  };
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  expect(body.session.rounds[0]?.items[0]?.priceBeforeTax).toEqual(money("2655"));
  expect(body.session.rounds[0]?.items[0]?.lineTotal).toEqual(money("3000"));
  expect(body.session.rounds[0]?.subtotal).toEqual(money("2655"));
  expect(body.session.rounds[0]?.tax).toEqual(money("345"));
  expect(body.session.rounds[0]?.itemsTotal).toEqual(money("3000"));
  expect(body.session.summary.ordered).toEqual({
    subtotal: money("2655"),
    tax: money("345"),
    total: money("3000"),
  });
  expect(body.session.summary.due).toEqual(money("0"));
});

it("WP-2423 item 8b: says a round is a charge and what the Store calls its per-head item", async () => {
  const charged = view();
  const round = charged.rounds[0];
  if (round === undefined || charged.summary === null) throw new Error("fixture");
  const f = await setup();
  f.read.mockResolvedValue({
    ...charged,
    rounds: [{ ...round, charge: true }],
    summary: {
      ...charged.summary,
      teaCharge: { perGuest: cad(200n), guests: 4, name: "Sauce bar" },
    },
  });
  const body = (await (await f.send()).json()) as {
    session: {
      rounds: Record<string, unknown>[];
      summary: { teaCharge: unknown };
    };
  };
  expect(body.session.rounds[0]?.charge).toBe(true);
  expect(body.session.summary.teaCharge).toEqual({
    perGuest: { amountMinor: "200", currencyCode: "CAD" },
    guests: 4,
    name: "Sauce bar",
  });
});

it("WP-2423 Q26: tells the table which dish the kitchen is making again, and only that dish", async () => {
  const f = await setup();
  const remade = view();
  const round = remade.rounds[0];
  const ramen = round?.items[0];
  if (round === undefined || ramen === undefined) throw new Error("fixture");
  f.read.mockResolvedValueOnce({
    ...remade,
    rounds: [
      {
        ...round,
        items: [
          { ...ramen, beingRemade: true },
          { ...ramen, displayName: "Tea", cancelled: true, takenOff: true },
          {
            ...ramen,
            displayName: "Gyoza",
            quantity: 1,
            orderAgain: {
              sellableReference: "018f0000-0000-7000-8000-000000000040",
              optionSelections: [
                { optionReference: "018f0000-0000-7000-8000-000000000041", quantity: 1 },
              ],
            },
          },
        ],
      },
    ],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: { items: Record<string, unknown>[] }[] };
  };
  const items = body.session.rounds[0]?.items ?? [];
  expect(items[0]).toMatchObject({ displayName: "Ramen", beingRemade: true });
  // b25 final: a dish staff took off the table's bill says so; others carry no takenOff.
  expect(items[1]).toMatchObject({ displayName: "Tea", cancelled: true, takenOff: true });
  expect(items[0]).not.toHaveProperty("takenOff");
  items.splice(1, 1);
  expect(items[1]).not.toHaveProperty("beingRemade");
  // WP-2423 item 8 ③ (decision 13): "Order again" gets the public menu references only.
  expect(items[1]?.orderAgain).toEqual({
    sellableReference: "018f0000-0000-7000-8000-000000000040",
    optionSelections: [{ optionReference: "018f0000-0000-7000-8000-000000000041", quantity: 1 }],
  });
  expect(items[0]).not.toHaveProperty("orderAgain");
  // Without a remake the field is absent, not false.
  const plain = (await (await f.send()).json()) as {
    session: { rounds: { items: Record<string, unknown>[] }[] };
  };
  expect(plain.session.rounds[0]?.items[0]).not.toHaveProperty("beingRemade");
});

it("Owner 2026-10-23: asks item names in the guest's chosen language and refuses a malformed one", async () => {
  const f = await setup();
  expect((await f.send({}, "?locale=zh-Hans-CA")).status).toBe(200);
  expect(f.read).toHaveBeenLastCalledWith(
    { sessionCredential: "s".repeat(43), csrfCredential: "c".repeat(43) },
    "zh-Hans-CA",
  );
  await f.send();
  expect(f.read).toHaveBeenLastCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
  });
  f.read.mockClear();
  for (const query of ["?locale=zh_CN", "?locale=zh-Hans-CA&table=7"])
    expect((await f.send({}, query)).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});

it("v15 2026-10-27: a table whose first round's order is still being prepared waits, never 'not joined'", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new DiningOrderStillProcessingError());
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("2");
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    "dining_session_order_processing",
  );
});

// Batch 43 (v15 b42 live, Fireside Hotpot 18:31-18:50Z): 13 table reads answered 503 "order
// processing", each 50-110 ms after its round was written (OrderCreated / OrderSubmitted outbox
// rows), while the status view took the round 0.2-1.1 s after it was written. The read is run
// again on the server after short waits, so the guest's read right after placing a round answers
// the table instead of a 503.
it("batch 43: a table read in the status view's gap is read again and answers 200", async () => {
  const f = await setup();
  f.read
    .mockRejectedValueOnce(new DiningOrderStillProcessingError("ROUND_NOT_IN_STATUS_VIEW"))
    .mockRejectedValueOnce(new DiningOrderStillProcessingError("ROUND_NOT_IN_STATUS_VIEW"))
    .mockResolvedValueOnce(view());
  const response = await f.send({}, "?locale=zh-CN");
  expect(response.status).toBe(200);
  expect(f.read).toHaveBeenCalledTimes(3);
  // Each re-read keeps the guest's language.
  const locale = f.read.mock.calls[0]?.[1] as unknown;
  expect(locale).toEqual(expect.any(String));
  expect(f.read.mock.calls.every((call) => call[1] === locale)).toBe(true);
});

it("batch 43: the default waits cover the 1.1 s seen live, then still 'order processing'", async () => {
  const f = await setup(true, [400, 800]);
  f.read.mockRejectedValue(new DiningOrderStillProcessingError());
  const started = Date.now();
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("2");
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1150);
});

it("batch 43: other failures are never read again", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new Error("TENANT_DATABASE_ACQUIRE_FAILED"));
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(f.read).toHaveBeenCalledTimes(1);
});

// Batch 41 (v15 b40 live): api.log had 8 table reads answering 503 HTTP_RETRY_LATER in 6-26 ms,
// each 15-30 ms after a round's payment started, with no line saying why. Each now says, at
// information level: the round's status view was not built yet (a first round, or a later one).
it.each([
  ["ORDER_STATUS_VIEW_NOT_BUILT", new DiningOrderStillProcessingError()],
  ["ROUND_NOT_IN_STATUS_VIEW", new DiningOrderStillProcessingError("ROUND_NOT_IN_STATUS_VIEW")],
] as const)(
  "batch 41: a table read while the order is written logs why (%s), level 30, nothing private",
  async (cause, error) => {
    const f = await setup();
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((line: string | Uint8Array) => {
        lines.push(String(line));
        return true;
      });
    try {
      f.read.mockRejectedValue(error);
      const response = await f.send();
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("2");
    } finally {
      write.mockRestore();
    }
    const found = lines
      .filter((line) => line.includes("CUSTOMER_DINING_SESSION_ORDER_PROCESSING"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      level: 30,
      event: "CUSTOMER_DINING_SESSION_ORDER_PROCESSING",
      code: "DINING_ORDER_STILL_PROCESSING",
      causes: [cause],
    });
    // A fixed event, codes and the time only: no credential, guest or table.
    expect(Object.keys(found[0] ?? {}).sort()).toEqual([
      "causes",
      "code",
      "event",
      "level",
      "time",
    ]);
    expect(lines.join("")).not.toContain("s".repeat(43));
    expect(lines.join("")).not.toContain("c".repeat(43));
  },
);

// v15 b17: the table changed while it was read (a staff round being written): still processing,
// with a 5-second wait, one warning line naming what disagreed, never a server error.
it("v15 b17: a table read busy with a round being written answers still processing, Retry-After 5", async () => {
  const f = await setup();
  const lines: string[] = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((line: string | Uint8Array) => {
      lines.push(String(line));
      return true;
    });
  try {
    f.read.mockRejectedValue(
      new DiningSessionReadBusyError(new Error("ORDER_PROGRESS_CHANGED_WHILE_READING")),
    );
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "dining_session_order_processing",
    );
  } finally {
    write.mockRestore();
  }
  const warning = lines
    .filter((line) => line.includes("CUSTOMER_DINING_SESSION_READ_BUSY"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
  expect(warning).toMatchObject({
    level: 40,
    code: "DINING_SESSION_READ_BUSY",
    causes: ["ORDER_PROGRESS_CHANGED_WHILE_READING"],
  });
});

// v15 b17 review: an outage or a real contradiction is unavailable, with a failure-level line.
it("v15 b17 review: an unavailable table read answers 503 and logs one level-50 line", async () => {
  const f = await setup();
  const lines: string[] = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((line: string | Uint8Array) => {
      lines.push(String(line));
      return true;
    });
  try {
    f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"));
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).not.toBe(
      "dining_session_order_processing",
    );
  } finally {
    write.mockRestore();
  }
  const failure = lines
    .filter((line) => line.includes("CUSTOMER_DINING_SESSION_READ_FAILED"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
  expect(failure).toMatchObject({ level: 50, code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE" });
});

// v15 b20 (money-display-followups): the phone went on to another page before its table read
// answered (499 HTTP_CLIENT_CLOSED beside it); the read, cut, failed: information, not a failure.
it("v15 b20: a table read the phone left before it answered is logged at level 30, not as a failure", async () => {
  const f = await setup();
  const lines: string[] = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((line: string | Uint8Array) => {
      lines.push(String(line));
      return true;
    });
  const outage = () =>
    Object.assign(new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"), {
      cause: Object.assign(new Error("GUEST_SESSION_UNAVAILABLE"), {
        code: "GUEST_SESSION_UNAVAILABLE",
        cause: Object.assign(new Error("TENANT_DATABASE_TRANSACTION_FAILED"), {
          code: "TENANT_DATABASE_TRANSACTION_FAILED",
        }),
      }),
    });
  try {
    // The phone leaves (its connection closes), then the cut read fails.
    let fail: (error: unknown) => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      f.read.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
            resolve();
          }),
      );
    });
    const abort = new AbortController();
    const answered = f.send({}, "", abort.signal).catch(() => "closed");
    await started;
    abort.abort();
    expect(await answered).toBe("closed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    fail(outage());
    await vi.waitFor(() =>
      expect(lines.some((line) => line.includes("CUSTOMER_DINING_SESSION_READ"))).toBe(true),
    );
    // The same outage while the phone still waits stays a failure (level 50).
    f.read.mockRejectedValueOnce(outage());
    expect((await f.send()).status).toBe(503);
    // A real database refusal (a missing grant) the left read met stays a failure too.
    let failGrant: (error: unknown) => void = () => undefined;
    const grantStarted = new Promise<void>((resolve) => {
      f.read.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failGrant = reject;
            resolve();
          }),
      );
    });
    const grantAbort = new AbortController();
    const grantAnswered = f.send({}, "", grantAbort.signal).catch(() => "closed");
    await grantStarted;
    grantAbort.abort();
    await grantAnswered;
    await new Promise((resolve) => setTimeout(resolve, 50));
    failGrant(
      Object.assign(new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"), {
        cause: Object.assign(new Error("permission denied"), { severity: "ERROR", code: "42501" }),
      }),
    );
    await vi.waitFor(() =>
      expect(lines.filter((line) => line.includes("CUSTOMER_DINING_SESSION_READ"))).toHaveLength(3),
    );
  } finally {
    write.mockRestore();
  }
  const read = lines
    .filter((line) => line.includes("CUSTOMER_DINING_SESSION_READ"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(read).toMatchObject([
    {
      level: 30,
      event: "CUSTOMER_DINING_SESSION_READ_CLIENT_CLOSED",
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
      causes: ["GUEST_SESSION_UNAVAILABLE", "TENANT_DATABASE_TRANSACTION_FAILED"],
    },
    { level: 50, event: "CUSTOMER_DINING_SESSION_READ_FAILED" },
    { level: 50, event: "CUSTOMER_DINING_SESSION_READ_FAILED" },
  ]);
});

it("v15 b20: a round's refunds for its cancelled dishes are sent as money, only when present", async () => {
  const f = await setup();
  const base = view();
  const round = base.rounds[0];
  if (round === undefined) throw new Error("fixture");
  f.read.mockResolvedValueOnce({
    ...base,
    rounds: [{ ...round, refunded: cad(900n), refundPending: cad(100n) }],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: Record<string, unknown>[] };
  };
  expect(body.session.rounds[0]?.refunded).toEqual({ amountMinor: "900", currencyCode: "CAD" });
  expect(body.session.rounds[0]?.refundPending).toEqual({
    amountMinor: "100",
    currencyCode: "CAD",
  });
  const plain = (await (await f.send()).json()) as {
    session: { rounds: Record<string, unknown>[] };
  };
  expect(plain.session.rounds[0]).not.toHaveProperty("refunded");
  expect(plain.session.rounds[0]).not.toHaveProperty("refundPending");
});

it("DEC-DINE-IN-PAY-LATER: a paid table's summary carries its tip and cash rounding", async () => {
  const f = await setup();
  const paid = view();
  f.read.mockResolvedValue({
    ...paid,
    paymentTiming: "PayLater",
    summary: {
      paid: cad(544n),
      refunded: cad(0n),
      refundPending: cad(0n),
      due: cad(0n),
      tableTip: cad(64n),
      cashRounding: cad(-1n),
    },
  });
  const body = (await (await f.send()).json()) as {
    session: { summary: { tableTip: unknown; cashRounding: unknown } };
  };
  expect(body.session.summary.tableTip).toEqual({ amountMinor: "64", currencyCode: "CAD" });
  expect(body.session.summary.cashRounding).toEqual({ amountMinor: "-1", currencyCode: "CAD" });
});

it("M91/M41: sends each dish's progress and says a paid round is still waiting for the store", async () => {
  const f = await setup();
  const base = view();
  const round = base.rounds[0];
  const ramen = round?.items[0];
  if (round === undefined || ramen === undefined) throw new Error("fixture");
  f.read.mockResolvedValueOnce({
    ...base,
    rounds: [
      {
        ...round,
        status: "Received",
        awaitingStore: true,
        items: [
          { ...ramen, progress: "Making" },
          { ...ramen, displayName: "Gyoza", progress: "Ready" },
          { ...ramen, displayName: "Tea", cancelled: true },
        ],
      },
    ],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: (Record<string, unknown> & { items: Record<string, unknown>[] })[] };
  };
  const sent = body.session.rounds[0];
  expect(sent?.awaitingStore).toBe(true);
  expect(sent?.items[0]).toMatchObject({ displayName: "Ramen", progress: "Making" });
  expect(sent?.items[1]).toMatchObject({ displayName: "Gyoza", progress: "Ready" });
  // A dish with no progress (cancelled, or a charge) carries no field, never a guess.
  expect(sent?.items[2]).not.toHaveProperty("progress");
  // A round that is not waiting for the store does not carry the field at all.
  const plain = (await (await f.send()).json()) as {
    session: { rounds: Record<string, unknown>[] };
  };
  expect(plain.session.rounds[0]).not.toHaveProperty("awaitingStore");
});
