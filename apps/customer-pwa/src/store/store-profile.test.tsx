import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createStoreProfileClient,
  STORE_PROFILE_SHARE_MS,
  parseStoreProfile,
  storeDirectionsUrl,
  type StoreProfile,
} from "./store-profile-client.js";
import { StoreStatusStrip, storeStatusLine, todayHoursText } from "./StoreIdentity.js";
import { formatStoreLocalTime } from "../journey/format.js";

const body = () => ({
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
    hours: {
      status: "Open",
      todayHours: [{ startLocalTime: "07:00:00", endLocalTime: "18:00:00", endsNextDay: false }],
      closesAt: "18:00:00",
      opensAt: null,
      localDate: "2026-12-22",
      todayKind: null,
      lastOrdersAt: "17:30:00",
      nextOpening: null,
      upcoming: [
        {
          localDate: "2026-12-24",
          kind: "Override",
          intervals: [{ startLocalTime: "11:00:00", endLocalTime: "16:00:00", endsNextDay: false }],
        },
        { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
      ],
    },
  },
});

describe("WP-2423 store profile client", () => {
  it("parses exactly the published fields", () => {
    const profile = parseStoreProfile(body());
    expect(profile.address.addressLines).toEqual(["100 Synthetic Street"]);
    expect(profile.hours?.closesAt).toBe("18:00:00");
    expect(() => parseStoreProfile({ ...body(), extra: 1 })).toThrow();
    expect(() =>
      parseStoreProfile({ ...body(), store: { ...body().store, phone: "416 555 0100" } }),
    ).toThrow();
    expect(() =>
      parseStoreProfile({
        ...body(),
        store: { ...body().store, hours: { ...body().store.hours, status: "Busy" } },
      }),
    ).toThrow();
    expect(parseStoreProfile({ ...body(), store: { ...body().store, hours: null } }).hours).toBe(
      null,
    );
  });

  it("reads the guest's own Store and treats any failure as unknown", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("/api/v1/customer/store");
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
      return new Response(JSON.stringify(body()), { status: 200 });
    });
    expect((await createStoreProfileClient(fetch)())?.storeDisplayName).toBe("Synthetic Store");
    const failing = vi.fn(async () => new Response("{}", { status: 503 }));
    expect(await createStoreProfileClient(failing)()).toBeNull();
    const malformed = vi.fn(async () => new Response("not json", { status: 200 }));
    expect(await createStoreProfileClient(malformed)()).toBeNull();
  });

  it("WP-2423 Q30: shares one read between the parts of a page, and reads again later", async () => {
    let clock = 1_000;
    const fetch = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }));
    const load = createStoreProfileClient(fetch, () => clock);
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += STORE_PROFILE_SHARE_MS;
    await load();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("links directions to a map search for the published address", () => {
    const url = storeDirectionsUrl(parseStoreProfile(body()));
    expect(url.startsWith("https://www.google.com/maps/search/?api=1&query=")).toBe(true);
    expect(decodeURIComponent(url)).toContain("100 Synthetic Street, Toronto, ON M5V 0A1, CA");
  });
});

describe("WP-2423 store status wording", () => {
  const hours = (value: Partial<NonNullable<StoreProfile["hours"]>>) => ({
    status: "Open" as const,
    todayHours: [{ startLocalTime: "07:00:00", endLocalTime: "18:00:00", endsNextDay: false }],
    closesAt: null,
    opensAt: null,
    localDate: "2026-12-22",
    todayKind: null,
    lastOrdersAt: null,
    nextOpening: null,
    upcoming: [],
    ...value,
  });
  it("says open until, closed and opening at, and a pause in plain words", () => {
    expect(storeStatusLine(hours({ closesAt: "18:00:00" }))).toEqual({
      label: "Open now",
      detail: `until ${formatStoreLocalTime("18:00:00")}`,
    });
    expect(storeStatusLine(hours({ status: "Closed", opensAt: "07:00:00" }))).toEqual({
      label: "Closed",
      detail: `opens at ${formatStoreLocalTime("07:00:00")}`,
    });
    expect(storeStatusLine(hours({ status: "Closed", todayHours: [] }))).toEqual({
      label: "Closed",
      detail: "closed today",
    });
    expect(storeStatusLine(hours({ status: "Paused" })).label).toBe("Online ordering paused");
    expect(todayHoursText(hours({}))).toBe(
      `${formatStoreLocalTime("07:00:00")}–${formatStoreLocalTime("18:00:00")}`,
    );
    expect(todayHoursText(hours({ todayHours: [] }))).toBe("Closed today");
  });
  it("formats the Store's own clock time without converting it", () => {
    expect(formatStoreLocalTime("13:05:00")).toMatch(/^1:05\sp\.m\.$/u);
    expect(formatStoreLocalTime("00:30:00")).toMatch(/^12:30\sa\.m\.$/u);
    expect(formatStoreLocalTime("25:00")).toBe("");
  });
  it("keeps the strip's line before the Store's facts arrive and hides it for previews", () => {
    const html = renderToStaticMarkup(<StoreStatusStrip load={async () => null} />);
    expect(html).toBe(
      '<section class="store-strip" aria-label="Store hours and address"></section>',
    );
    expect(renderToStaticMarkup(<StoreStatusStrip load={null} />)).toBe("");
  });
});

describe("WP-2423 item 8 ③ decision 16: the Store at the bottom of the menu", () => {
  it("says the kitchen's last orders while open and the next opening while closed", () => {
    const hours = parseStoreProfile(body()).hours;
    if (hours === null) throw new Error("hours expected");
    expect(storeStatusLine(hours)).toEqual({
      label: "Open now",
      detail: `until ${formatStoreLocalTime("18:00:00")} · last orders ${formatStoreLocalTime("17:30:00")}`,
    });
    const closed = {
      ...hours,
      status: "Closed" as const,
      todayHours: [],
      todayKind: "Holiday" as const,
      lastOrdersAt: null,
      nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
    };
    expect(storeStatusLine(closed).detail).toBe(
      `opens tomorrow at ${formatStoreLocalTime("11:00:00")}`,
    );
  });
  it("rejects an unknown day kind or a malformed next opening", () => {
    const withHours = (hours: Record<string, unknown>) => ({
      ...body(),
      store: { ...body().store, hours: { ...body().store.hours, ...hours } },
    });
    expect(() => parseStoreProfile(withHours({ todayKind: "Party" }))).toThrow();
    expect(() =>
      parseStoreProfile(withHours({ nextOpening: { localDate: "tomorrow" } })),
    ).toThrow();
  });
});
