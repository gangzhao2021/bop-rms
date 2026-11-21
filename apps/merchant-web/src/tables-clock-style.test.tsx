import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { CurrentOrderLines } from "./CurrentOrderQueuePage.js";
import { paymentWindowNotice } from "./counter-payment.js";
import { compRecordText } from "./ItemCompAction.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { ClockStyleContext, SourceTime, StoreTimeZoneContext, storeTime } from "./StoreTime.js";

// b40 review: Tables mixed "12:30 a.m." (notices), "Nov 21, 2026, 12:30 AM" (checkout) and
// "01:23" (round headings). Every time on Tables reads as on the guest's phone at that table.
const zone = "America/Toronto";
const halfPastMidnight = "2026-11-21T05:30:00.000Z";

afterEach(() => setLanguageForTest("en"));

it("writes a time in the guests' style when asked, with or without the date", () => {
  expect(storeTime(halfPastMidnight, zone)).toBe("00:30");
  expect(storeTime(halfPastMidnight, zone, false, "Guest")).toBe("12:30 a.m.");
  expect(storeTime(halfPastMidnight, zone, true, "Guest")).toBe("Nov 21, 2026, 12:30 a.m.");
  expect(storeTime(halfPastMidnight, undefined, false, "Guest")).toBe("5:30 a.m. UTC");
  setLanguageForTest("zh-Hans");
  expect(storeTime(halfPastMidnight, zone, false, "Guest")).toBe("0:30");
});

it("the shared order lines and record times follow the screen's style", () => {
  const html = (style: "Staff" | "Guest") =>
    renderToStaticMarkup(
      <ClockStyleContext.Provider value={style}>
        <StoreTimeZoneContext.Provider value={zone}>
          <CurrentOrderLines
            lines={
              {
                items: [],
                totals: {
                  subtotal: { amountMinor: "0", currencyCode: "CAD" },
                  discount: { amountMinor: "0", currencyCode: "CAD" },
                  tax: { amountMinor: "0", currencyCode: "CAD" },
                  fee: { amountMinor: "0", currencyCode: "CAD" },
                  total: { amountMinor: "0", currencyCode: "CAD" },
                  taxRounding: { amountMinor: "0", currencyCode: "CAD" },
                  tip: null,
                },
              } as never
            }
            rounds={
              {
                timeZone: zone,
                today: "2026-11-21",
                batches: [
                  {
                    orderBatchReference: "00000000-0000-4000-8000-000000000051",
                    sequence: 1,
                    submittedAt: halfPastMidnight,
                    staffRound: null,
                    paymentDue: null,
                    kitchenRelease: null,
                    compedItems: [],
                  },
                ],
              } as never
            }
          />
          <SourceTime instant={halfPastMidnight} withDate={false} />
        </StoreTimeZoneContext.Provider>
      </ClockStyleContext.Provider>,
    );
  expect(html("Guest")).toContain(">12:30 a.m.</time>");
  expect(html("Guest")).not.toContain("00:30");
  // Orders and other back-office screens keep their own style.
  expect(html("Staff")).toContain(">00:30</time>");
});

it("a sentence ending in a guest-style time has one period, and comps say their time alike", () => {
  const ended = paymentWindowNotice({
    payBy: halfPastMidnight,
    now: Date.parse(halfPastMidnight) + 60_000,
    tableMode: true,
    timeZone: zone,
    clockStyle: "Guest",
  });
  expect(ended.text).toContain("ended at 12:30 a.m. It was not sent");
  expect(ended.text).not.toContain("a.m..");
  expect(
    compRecordText(
      { kind: "Comp", percent: null, decidedAt: halfPastMidnight, byLabel: "Li" },
      zone,
      "Guest",
    ),
  ).toBe("Comped · by Li, 12:30 a.m.");
});

it("every time a Tables-only screen writes is in the guests' style", () => {
  // Files only Tables renders; shared parts (order lines, payment panel) read ClockStyleContext.
  const tablesOnly = [
    "DiningSessionWorkspace.tsx",
    "TableCheckout.tsx",
    "TableGuestsLeft.tsx",
    "TablePhones.tsx",
    "TableOrderRounds.tsx",
  ];
  for (const name of tablesOnly) {
    const source = readFileSync(join(import.meta.dirname, name), "utf8");
    const calls = [
      ...source.matchAll(/\b(storeTime|orderWhen|compRecordText)\(([^;]*?)\)[,;}\s]/gsu),
    ];
    for (const call of calls) expect(call[2], `${name}: ${call[0]}`).toContain('"Guest"');
  }
  expect(readFileSync(join(import.meta.dirname, "DiningSessionWorkspace.tsx"), "utf8")).toContain(
    '<ClockStyleContext.Provider value="Guest">',
  );
});
