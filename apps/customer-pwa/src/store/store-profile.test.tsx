import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoreProfileClient,
  STORE_PROFILE_SHARE_MS,
  parseStoreProfile,
  storeDirectionsUrl,
  type StoreProfile,
} from "./store-profile-client.js";
import { createElement } from "react";
import { LanguageRoot } from "../i18n/i18n.js";
import {
  OrdersStoppedNotice,
  StoreIdentityCard,
  StoreStatusStrip,
  storeServiceNoticeText,
  storeStatusLine,
  todayHoursText,
} from "./StoreIdentity.js";
import { endSentence, formatStoreLocalTime } from "../journey/format.js";
import { takesNewOrders } from "./store-service.js";

afterEach(() => vi.restoreAllMocks());
function publishedHours() {
  const hours = parseStoreProfile(body()).hours;
  if (hours === null) throw new Error("the synthetic Store publishes its hours");
  return hours;
}

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
      ordersStopped: false,
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
    pausedUntil: null,
    ordersStopped: false,
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
      ordersStopped: false,
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

describe("WP-2423 item 8 ③ follow-up: after last orders", () => {
  const loaderOf = (ordersStopped: boolean) => {
    const parsed = parseStoreProfile(body());
    const profile = {
      ...parsed,
      hours: parsed.hours === null ? null : { ...parsed.hours, ordersStopped },
    };
    return Object.assign(async () => profile, { last: () => profile });
  };
  it("tells the guest the kitchen stopped taking orders and to ask staff", () => {
    // 12:00 in Toronto: not within the 30-minute countdown before 17:30.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-22T17:00:00.000Z"));
    const stopped = renderToStaticMarkup(<OrdersStoppedNotice load={loaderOf(true)} />);
    expect(stopped).toContain(
      `The kitchen stopped taking orders at ${formatStoreLocalTime("17:30:00")}`,
    );
    expect(stopped).toContain("To add something, ask a staff member.");
    expect(renderToStaticMarkup(<OrdersStoppedNotice load={loaderOf(false)} />)).toBe("");
    expect(renderToStaticMarkup(<StoreStatusStrip load={loaderOf(true)} />)).toContain(
      `Kitchen stopped taking orders at ${formatStoreLocalTime("17:30:00")}`,
    );
  });
});

describe("M117: after midnight in last night's overnight period", () => {
  const late = () => ({
    ...body(),
    store: {
      ...body().store,
      hours: {
        ...body().store.hours,
        localDate: "2026-12-23",
        todayHours: [{ startLocalTime: "11:00:00", endLocalTime: "02:00:00", endsNextDay: true }],
        closesAt: "02:00:00",
        lastOrdersAt: null,
        upcoming: [],
        tonight: { startLocalTime: "11:00:00", endLocalTime: "02:00:00" },
      },
    },
  });
  it("says open until 2:00 a.m. and tonight's hours, not the new date's", async () => {
    const profile = parseStoreProfile(late());
    expect(profile.hours?.tonight).toEqual({
      startLocalTime: "11:00:00",
      endLocalTime: "02:00:00",
    });
    expect(storeStatusLine(profile.hours as NonNullable<StoreProfile["hours"]>).detail).toBe(
      `until ${formatStoreLocalTime("02:00:00")}`,
    );
    const html = renderToStaticMarkup(
      <StoreIdentityCard load={Object.assign(async () => profile, { last: () => profile })} />,
    );
    expect(html).toContain("Tonight");
    expect(html).toContain("(next day)");
    expect(html).not.toContain(">Today<");
    expect(() =>
      parseStoreProfile({
        ...late(),
        store: {
          ...late().store,
          hours: { ...late().store.hours, tonight: { startLocalTime: "x" } },
        },
      }),
    ).toThrow();
  });
});

describe("WP-2423 store-service-controls (v15 M30/M34) the guest's own service", () => {
  const loaderOf = (hours: Record<string, unknown>) => {
    const parsed = parseStoreProfile(body());
    const profile = {
      ...parsed,
      hours: parsed.hours === null ? null : { ...parsed.hours, ...hours },
    };
    return Object.assign(async () => profile, { last: () => profile });
  };
  it("a pickup pause says until when and offers the counter, never 'ask a staff member'", () => {
    const pickup = renderToStaticMarkup(
      <OrdersStoppedNotice
        load={loaderOf({ status: "Paused", pausedUntil: "19:45:00" })}
        channel="Pickup"
      />,
    );
    expect(pickup).toContain(
      endSentence(`Online pickup ordering is paused until ${formatStoreLocalTime("19:45:00")}`),
    );
    expect(pickup).not.toContain("..");
    expect(pickup).toContain("You can order at the counter");
    expect(pickup).not.toContain("staff");
    const table = renderToStaticMarkup(
      <OrdersStoppedNotice load={loaderOf({ status: "Paused", pausedUntil: "19:45:00" })} />,
    );
    expect(table).toContain("A staff member can take your order.");
  });
  it("M30 review: the pause line says when ordering resumes, never the opening hours' 'until'", () => {
    const paused = {
      ...publishedHours(),
      status: "Paused" as const,
      closesAt: null,
      pausedUntil: "19:45:00",
    };
    expect(storeStatusLine(paused).detail).toBe(`resumes at ${formatStoreLocalTime("19:45:00")}`);
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    try {
      const detail = storeStatusLine(paused).detail ?? "";
      expect(detail).toContain("恢复");
      expect(detail).not.toContain("营业至");
    } finally {
      renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
    }
  });
  it("M34 review: closed says so in this service's words, and when a pickup guest can order next", () => {
    const closed = { status: "Closed" as const, closesAt: null, lastOrdersAt: null };
    const tomorrow = {
      ...closed,
      nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
    };
    const pickup = storeServiceNoticeText(
      parseStoreProfile({
        ...body(),
        store: { ...body().store, hours: { ...body().store.hours, ...tomorrow } },
      }).hours,
      "Closed",
      null,
      "Pickup",
    );
    expect(pickup).toEqual({
      headline: "Online pickup ordering is closed now.",
      detail: endSentence(`Opens tomorrow at ${formatStoreLocalTime("11:00:00")}`),
    });
    const later = renderToStaticMarkup(
      <OrdersStoppedNotice load={loaderOf({ ...closed, opensAt: "17:00:00" })} channel="Pickup" />,
    );
    expect(later).toContain(endSentence(`Opens today at ${formatStoreLocalTime("17:00:00")}`));
    expect(later).not.toContain("staff");
    const unknown = storeServiceNoticeText(
      { ...publishedHours(), ...closed, nextOpening: null },
      "Closed",
      null,
      "Pickup",
    );
    expect(unknown).toEqual({ headline: "Online pickup ordering is closed now.", detail: null });
    const table = renderToStaticMarkup(<OrdersStoppedNotice load={loaderOf(closed)} />);
    expect(table).toContain("Ordering from your phone is closed now.");
    expect(table).toContain("A staff member can help you.");
  });
  it("M30 live check: a pause sentence ending with a time like 8:08 a.m. has one period", () => {
    const hours = { ...publishedHours(), pausedUntil: "08:08:00" };
    const time = formatStoreLocalTime("08:08:00");
    expect(time).toBe("8:08 a.m.");
    const pickup = storeServiceNoticeText(hours, "Paused", null, "Pickup");
    expect(pickup).toEqual({
      headline: "Online pickup ordering is paused until 8:08 a.m.",
      detail: "You can order at the counter, or come back after 8:08 a.m.",
    });
    expect(storeServiceNoticeText(hours, "Paused", null, "DineIn")?.headline).toBe(
      "Ordering from your phone is paused until 8:08 a.m.",
    );
    // A time without the abbreviation keeps the sentence's own period.
    const evening = storeServiceNoticeText(
      { ...hours, pausedUntil: "20:08:00" },
      "Paused",
      null,
      "Pickup",
    );
    expect(evening?.headline).toBe("Online pickup ordering is paused until 8:08 p.m.");
  });
  it("M34 review: whenever the cart or checkout holds a new order back, there are words for why", () => {
    const base = publishedHours();
    for (const phase of ["Stopped", "Paused", "Closed"] as const)
      for (const channel of ["DineIn", "Pickup"] as const) {
        expect(takesNewOrders(phase)).toBe(false);
        expect(storeServiceNoticeText(base, phase, null, channel)?.headline).toBeTruthy();
      }
  });
  it("counts down the last 30 minutes before last orders", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-22T22:10:00.000Z")); // 17:10
    expect(renderToStaticMarkup(<OrdersStoppedNotice load={loaderOf({})} />)).toContain(
      `Last orders at ${formatStoreLocalTime("17:30:00")} — 20 min left.`,
    );
  });
});
