import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentOrderQueueRows } from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import { currentOrderQueueFixture } from "./current-order-queue.fixtures.js";
import {
  businessDateLabel,
  parseStoreBusinessDay,
  StoreBusinessDayContext,
  trackStoreBusinessDay,
} from "./StoreBusinessDay.js";
import { paidAtInstant } from "./StaffOrderEntryPage.js";
import { storeLocalInstant } from "./StoreTime.js";

const day = {
  businessDate: "2026-10-14",
  startsAt: "2026-10-14T08:00:00.000Z",
  endsAt: "2026-10-15T08:00:00.000Z",
  timeZone: "America/Toronto",
  observedAt: "2026-10-15T05:30:00.000Z",
};

describe("WP-2423 Q21: the Store business day read", () => {
  it("accepts the Store's day with its boundaries and refuses anything else", () => {
    expect(parseStoreBusinessDay(day)).toEqual({ ...day, lastOrdersAt: null });
    // A 25-hour day (clocks fall back) and a 23-hour day (spring forward) are real days.
    expect(
      parseStoreBusinessDay({
        ...day,
        businessDate: "2026-10-31",
        startsAt: "2026-10-31T08:00:00.000Z",
        endsAt: "2026-11-01T09:00:00.000Z",
        observedAt: "2026-11-01T06:30:00.000Z",
      }).endsAt,
    ).toBe("2026-11-01T09:00:00.000Z");
    for (const bad of [
      { ...day, businessDate: "2026-02-30" },
      { ...day, observedAt: "2026-10-15T08:00:00.000Z" },
      { ...day, endsAt: "2026-10-16T08:00:00.000Z" },
      { ...day, extra: 1 },
      { ...day, startsAt: "2026-10-14 08:00" },
    ])
      expect(() => parseStoreBusinessDay(bad)).toThrow();
  });

  it("labels business dates against the Store's current business day", () => {
    expect(businessDateLabel("2026-10-14", "2026-10-14")).toBe("Today · Wed, Oct 14");
    expect(businessDateLabel("2026-10-13", "2026-10-14")).toBe("Yesterday · Tue, Oct 13");
    expect(businessDateLabel("2026-10-12", "2026-10-14")).toBe("Mon, Oct 12");
    expect(businessDateLabel("2026-10-12", null)).toBe("Mon, Oct 12");
  });
});

describe("WP-2423 Q21: the day turns over at the Store's business-day start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const next = {
    businessDate: "2026-10-15",
    startsAt: "2026-10-15T08:00:00.000Z",
    endsAt: "2026-10-16T08:00:00.000Z",
  };

  it("reads the Store's day, and reads again one second after it ends", async () => {
    // 01:30 in Toronto on Oct 15: the device's calendar says Oct 15, the Store says Oct 14.
    vi.setSystemTime(new Date("2026-10-15T05:30:00.000Z"));
    const seen: string[] = [];
    // The Store answers with the day in force when asked.
    const load = vi.fn(async () => (Date.now() < Date.parse(day.endsAt) ? day : next));
    const tracker = trackStoreBusinessDay({
      load,
      onDay: (value) => seen.push(value.businessDate),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["2026-10-14"]);
    // Before 04:00 local the day stays (rechecked at most every 15 minutes).
    await vi.advanceTimersByTimeAsync(2.5 * 3_600_000 - 1_000);
    expect(seen.at(-1)).toBe("2026-10-14");
    expect(load.mock.calls.length).toBeLessThanOrEqual(12);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(seen.at(-1)).toBe("2026-10-15");
    tracker.stop();
  });

  it("tries again after a failed read and rechecks at once when woken after the day ended", async () => {
    vi.setSystemTime(new Date("2026-10-15T05:30:00.000Z"));
    const seen: string[] = [];
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(day)
      .mockResolvedValue(next);
    const tracker = trackStoreBusinessDay({
      load,
      onDay: (value) => seen.push(value.businessDate),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual(["2026-10-14"]);
    tracker.recheck(); // the day has not ended: nothing is read
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z")); // device slept past 04:00
    tracker.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe("2026-10-15");
    tracker.stop();
  });
});

describe("WP-2423 Q21: Orders are grouped by the Store business day", () => {
  it("heads each business day once, with Today for the Store's current day", () => {
    const fixture = currentOrderQueueFixture();
    const [first, second, third] = fixture.items;
    const view = parseCurrentOrderQueue({
      ...fixture,
      items: [
        // 00:40 on Oct 15 in Toronto: after midnight, still the Oct 14 business day.
        {
          ...first,
          businessDate: "2026-10-14",
          submittedAt: "2026-10-15T04:40:00.000Z",
          observedAt: "2026-10-15T05:00:00.000Z",
        },
        { ...second, businessDate: "2026-10-14" },
        { ...third, businessDate: "2026-10-13" },
      ],
    });
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <StoreBusinessDayContext.Provider
          value={{ businessDate: "2026-10-14", startsAt: null, endsAt: null }}
        >
          <CurrentOrderQueueRows
            view={view}
            timeZone="America/Toronto"
            expanded={{
              opened: new Set([view.items[0]?.orderReference ?? ""]),
              setOpened: () => undefined,
            }}
          />
        </StoreBusinessDayContext.Provider>
      </MemoryRouter>,
    );
    expect(markup.match(/class="order-workbench-day"/g)).toHaveLength(2);
    expect(markup).toContain(">Today · Wed, Oct 14</h2>");
    expect(markup).toContain(">Yesterday · Tue, Oct 13</h2>");
    expect(markup.indexOf("Today · Wed, Oct 14")).toBeLessThan(markup.indexOf("Yesterday"));
    // The time shown is the Store's local time.
    expect(markup).toContain(">00:40</time>");
    expect(markup).toContain("<dt>Business day</dt><dd>Today · Wed, Oct 14</dd>");
  });

  it("shows no day headings for one Order or for an older server without business dates", () => {
    const fixture = currentOrderQueueFixture();
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <CurrentOrderQueueRows view={parseCurrentOrderQueue(fixture)} />
      </MemoryRouter>,
    );
    expect(markup).not.toContain("order-workbench-day");
  });
});

describe("WP-2423 Q21: Store times typed by staff are read in the Store's zone", () => {
  it("converts a Store wall-clock time whatever the device's zone, across DST", () => {
    expect(storeLocalInstant("2026-10-13T14:05", "America/Toronto")).toBe(
      "2026-10-13T18:05:00.000Z",
    );
    expect(storeLocalInstant("2026-01-13T14:05", "America/Toronto")).toBe(
      "2026-01-13T19:05:00.000Z",
    );
    // Repeated 01:30 on the fall-back night: the first (EDT) occurrence.
    expect(storeLocalInstant("2026-11-01T01:30", "America/Toronto")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    // 02:30 does not exist on the spring-forward night: the same wall time after the change.
    expect(storeLocalInstant("2026-03-08T02:30", "America/Toronto")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(storeLocalInstant("2026-02-30T10:00", "America/Toronto")).toBeNull();
    expect(storeLocalInstant("2026-10-13T14:05", "Not/AZone")).toBeNull();
  });

  it("reads a paper order's paid time as Store time", () => {
    const now = Date.parse("2026-10-13T22:00:00.000Z");
    expect(paidAtInstant("2026-10-13T14:05", now, "America/Toronto")).toBe(
      "2026-10-13T18:05:00.000Z",
    );
    expect(paidAtInstant("2026-10-13T14:05", now, "America/Vancouver")).toBe(
      "2026-10-13T21:05:00.000Z",
    );
    expect(paidAtInstant("2026-10-13T18:30", now, "America/Toronto")).toBeNull();
  });
});

it("WP-2423 D4: names the day an older table was opened and that it ordered again today", async () => {
  const { openedEarlierText } = await import("./StoreBusinessDay.js");
  expect(openedEarlierText("2026-10-11", "2026-10-15", "2026-10-15")).toBe(
    "Opened Sun, Oct 11 · ordered again Today · Thu, Oct 15",
  );
});

it("WP-2423 D4: an older table's Order with a round today is under Today, not its opening day", () => {
  const fixture = currentOrderQueueFixture();
  const [first, second, third] = fixture.items;
  const view = parseCurrentOrderQueue({
    ...fixture,
    items: [
      { ...third, businessDate: "2026-10-12", listedBusinessDate: "2026-10-14" },
      { ...first, businessDate: "2026-10-14", listedBusinessDate: "2026-10-14" },
      { ...second, businessDate: "2026-10-14", listedBusinessDate: "2026-10-14" },
    ],
  });
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <StoreBusinessDayContext.Provider
        value={{ businessDate: "2026-10-14", startsAt: null, endsAt: null }}
      >
        <CurrentOrderQueueRows
          view={view}
          timeZone="America/Toronto"
          expanded={{
            opened: new Set([view.items[0]?.orderReference ?? ""]),
            setOpened: () => undefined,
          }}
        />
      </StoreBusinessDayContext.Provider>
    </MemoryRouter>,
  );
  expect(markup.match(/class="order-workbench-day"/g)).toHaveLength(1);
  expect(markup).toContain(">Today · Wed, Oct 14</h2>");
  expect(markup).not.toContain("Mon, Oct 12</h2>");
  expect(markup).toContain(
    "<dt>Business day</dt><dd>Opened Mon, Oct 12 · ordered again Today · Wed, Oct 14</dd>",
  );
});
