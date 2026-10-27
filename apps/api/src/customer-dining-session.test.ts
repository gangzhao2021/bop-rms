import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { OrderStatusProjectionError } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerDiningSessionHandler } from "./customer-dining-session.js";
import type { CustomerDiningSessionView } from "./customer-dining-session-read.js";

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
async function setup(enabled = true) {
  const read = vi.fn().mockResolvedValue(view());
  const server = createServer(
    createApp(
      enabled
        ? {
            customerDiningSession: new CustomerDiningSessionHandler({
              allowedOrigin: "https://pilot.example",
              port: { read },
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
    send: (headers: Record<string, string> = {}, query = "") =>
      fetch(url + query, {
        headers: {
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
          "x-csrf-token": "c".repeat(43),
          ...headers,
        },
      }),
  };
}

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
          { ...ramen, displayName: "Gyoza", quantity: 1 },
        ],
      },
    ],
  });
  const body = (await (await f.send()).json()) as {
    session: { rounds: { items: Record<string, unknown>[] }[] };
  };
  const items = body.session.rounds[0]?.items ?? [];
  expect(items[0]).toMatchObject({ displayName: "Ramen", beingRemade: true });
  expect(items[1]).not.toHaveProperty("beingRemade");
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
