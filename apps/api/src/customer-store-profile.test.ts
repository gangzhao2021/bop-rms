import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestSessionError } from "@bop/identity";
import { createApp } from "./app.js";
import {
  createCustomerStoreProfileHandler,
  describeCustomerStoreHours,
  type CustomerStoreProfileView,
} from "./customer-store-profile.js";
import { apiRouteTemplates } from "./http-route-templates.js";

const day = [
  { startLocalTime: "07:00:00", endLocalTime: "11:00:00", endsNextDay: false },
  { startLocalTime: "13:00:00", endLocalTime: "18:00:00", endsNextDay: false },
];

describe("WP-2423 today's hours for the store identity", () => {
  it("says until when an open Store serves, from today's published interval", () => {
    expect(
      describeCustomerStoreHours({
        state: "Open",
        servesChannel: true,
        localTime: "09:30:00",
        todayHours: day,
      }),
    ).toEqual({
      status: "Open",
      todayHours: day,
      closesAt: "11:00:00",
      opensAt: null,
      localDate: null,
      todayKind: null,
      lastOrdersAt: null,
      ordersStopped: false,
      nextOpening: null,
      upcoming: [],
    });
  });
  it("WP-2423 item 8 ③ decision 16: last orders only while open, the next opening only while not", () => {
    const upcoming = {
      todayKind: "Override" as const,
      lastOrdersAt: "10:30:00",
      lastOrders: { localDate: "2026-12-22", localTime: "10:30:00" },
      pastLastOrders: false,
      nextOpening: { localDate: "2026-12-23", startLocalTime: "07:00:00" },
      upcoming: [{ localDate: "2026-12-25", kind: "Holiday" as const, intervals: [] }],
    };
    const input = { servesChannel: true, localTime: "09:30:00", todayHours: day, upcoming };
    expect(
      describeCustomerStoreHours({ ...input, state: "Open", localDate: "2026-12-22" }),
    ).toMatchObject({
      localDate: "2026-12-22",
      todayKind: "Override",
      lastOrdersAt: "10:30:00",
      nextOpening: null,
      upcoming: upcoming.upcoming,
    });
    expect(describeCustomerStoreHours({ ...input, state: "Closed" })).toMatchObject({
      lastOrdersAt: null,
      nextOpening: upcoming.nextOpening,
    });
  });
  it("follow-up: open but past last orders says orders stopped, only while open", () => {
    const upcoming = {
      todayKind: null,
      lastOrdersAt: "10:30:00",
      lastOrders: { localDate: "2026-12-22", localTime: "10:30:00" },
      pastLastOrders: true,
      nextOpening: null,
      upcoming: [],
    };
    const input = { servesChannel: true, localTime: "10:40:00", todayHours: day, upcoming };
    expect(describeCustomerStoreHours({ ...input, state: "Open" }).ordersStopped).toBe(true);
    expect(describeCustomerStoreHours({ ...input, state: "Closed" }).ordersStopped).toBe(false);
  });
  it("says when a closed Store opens later today, and nothing when it doesn't", () => {
    expect(
      describeCustomerStoreHours({
        state: "Closed",
        servesChannel: false,
        localTime: "11:30:00",
        todayHours: [...day].reverse(),
      }),
    ).toMatchObject({ status: "Closed", opensAt: "13:00:00", closesAt: null, todayHours: day });
    expect(
      describeCustomerStoreHours({
        state: "Closed",
        servesChannel: false,
        localTime: "19:00:00",
        todayHours: day,
      }),
    ).toMatchObject({ status: "Closed", opensAt: null });
  });
  it("treats an open Store that doesn't serve this guest's service now as closed", () => {
    expect(
      describeCustomerStoreHours({
        state: "Open",
        servesChannel: false,
        localTime: "06:00:00",
        todayHours: day,
      }),
    ).toMatchObject({ status: "Closed", opensAt: "07:00:00", closesAt: null });
  });
  it("reports a pause without inventing when it ends", () => {
    expect(
      describeCustomerStoreHours({
        state: "TemporarilyClosed",
        servesChannel: false,
        localTime: "09:00:00",
        todayHours: day,
      }),
    ).toMatchObject({ status: "Paused", opensAt: null, closesAt: null });
  });
  it("keeps an overnight period open past midnight and leaves out times it can't state", () => {
    const late = [{ startLocalTime: "18:00:00", endLocalTime: "02:00:00", endsNextDay: true }];
    expect(
      describeCustomerStoreHours({
        state: "Open",
        servesChannel: true,
        localTime: "23:15:00",
        todayHours: late,
      }),
    ).toMatchObject({ closesAt: "02:00:00" });
    // 01:00 is yesterday's period; today's list does not state its end.
    expect(
      describeCustomerStoreHours({
        state: "Open",
        servesChannel: true,
        localTime: "01:00:00",
        todayHours: late,
      }),
    ).toMatchObject({ status: "Open", closesAt: null, opensAt: null });
    expect(
      describeCustomerStoreHours({
        state: "Closed",
        servesChannel: false,
        localTime: null,
        todayHours: day,
      }),
    ).toMatchObject({ opensAt: null, closesAt: null });
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const view: CustomerStoreProfileView = {
  storeDisplayName: "Synthetic Store",
  brandDisplayName: "Synthetic Brand",
  timeZone: "America/Toronto",
  address: {
    addressLines: ["100 Synthetic Street"],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "M5V 0A1",
    countryCode: "CA",
  },
  phone: "+15555550100",
  hours: {
    status: "Open",
    todayHours: day,
    closesAt: "11:00:00",
    opensAt: null,
    localDate: "2026-12-22",
    todayKind: null,
    lastOrdersAt: "10:30:00",
    ordersStopped: false,
    nextOpening: null,
    upcoming: [
      {
        localDate: "2026-12-24",
        kind: "Override",
        intervals: [{ startLocalTime: "07:00:00", endLocalTime: "12:00:00", endsNextDay: false }],
      },
      { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
    ],
  },
};

async function setup(read = vi.fn().mockResolvedValue(view), enabled = true) {
  const server = createServer(
    createApp(
      enabled
        ? {
            customerStoreProfile: createCustomerStoreProfileHandler({
              allowedOrigin: "https://store.example",
              port: { read },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/customer/store`;
  const headers = {
    "sec-fetch-site": "same-origin",
    cookie: "__Host-bop-guest=" + "A".repeat(43),
  };
  return {
    read,
    request: (extra: Record<string, string> = {}, suffix = "") =>
      fetch(url + suffix, { headers: { ...headers, ...extra } }),
  };
}

describe("GET /api/v1/customer/store", () => {
  it("is a registered route template", () => {
    expect(apiRouteTemplates).toContain("/api/v1/customer/store");
  });
  it("returns only the Store's public fields, briefly cacheable by this browser", async () => {
    const f = await setup();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.read).toHaveBeenCalledWith("A".repeat(43));
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      store: {
        storeDisplayName: "Synthetic Store",
        brandDisplayName: "Synthetic Brand",
        timeZone: "America/Toronto",
        address: {
          addressLines: ["100 Synthetic Street"],
          locality: "Toronto",
          regionCode: "ON",
          postalCode: "M5V 0A1",
          countryCode: "CA",
        },
        phone: "+15555550100",
        hours: view.hours,
      },
    });
  });
  it("states no hours when they can't be read", async () => {
    const f = await setup(vi.fn().mockResolvedValue({ ...view, hours: null }));
    const body = (await (await f.request()).json()) as { store: { hours: unknown } };
    expect(body.store.hours).toBeNull();
  });
  it("rejects cross-site and query input before reading, and a missing Session as 401", async () => {
    const f = await setup();
    expect((await f.request({ "sec-fetch-site": "cross-site" })).status).toBe(400);
    expect((await f.request({ origin: "https://other.example" })).status).toBe(400);
    expect((await f.request({}, "?x=1")).status).toBe(400);
    const missing = await f.request({ cookie: "" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("answers 401 for an ended Session and 503 for any other failure, never cached", async () => {
    const ended = await setup(
      vi.fn().mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE")),
    );
    expect((await ended.request()).status).toBe(401);
    const failing = await setup(vi.fn().mockRejectedValue(new Error("boom")));
    const response = await failing.request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: { code: "store_unavailable" },
    });
    const absent = await setup(undefined, false);
    expect((await absent.request()).status).toBe(503);
  });
});
