import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { TimeOfDayInput, wallClockParts, wallClockValue } from "./TimeOfDayInput.js";

/**
 * Batch 47 (v15 b46: the hours editor's browser time fields read "12:00:00 PM" and "01:00:00 AM",
 * even in Chinese, beside "12:00 p.m." on the same page). The Lane Dessert period as v15 sent it.
 */
afterEach(() => setLanguageForTest("en"));

const shown = (html: string) =>
  [...html.matchAll(/<option value="[^"]*" selected="">([^<]*)<\/option>/gu)].map((m) => m[1]);

// Batch 64: the staff clock, 00–23, in English as in Chinese (v15 b63: Hours wrote "p.m." where
// every other staff page wrote 24-hour times).
it("shows hours and minutes on the 24-hour clock in English, with no seconds", () => {
  const start = renderToStaticMarkup(
    <TimeOfDayInput label="Start 1" value="12:00:00" onChange={() => undefined} />,
  );
  expect(shown(start)).toEqual(["12", "00"]);
  expect(start).not.toMatch(/a\.m\.|p\.m\./u);
  expect(start).toContain('role="group"');
  expect(start).toMatch(/aria-labelledby="([^"]+)"[^]*id="\1">Start 1</u);
  expect(start).toContain('aria-label="Hour"');
  expect(start).not.toContain('type="time"');
  const end = renderToStaticMarkup(
    <TimeOfDayInput label="End 1" value="01:00:00" onChange={() => undefined} />,
  );
  expect(shown(end)).toEqual(["01", "00"]);
  // Test Merchant 2's whole day is saved as 23:59:59; it reads 23:59 and is kept as saved.
  expect(
    shown(
      renderToStaticMarkup(
        <TimeOfDayInput label="End 1" value="23:59:59" onChange={() => undefined} />,
      ),
    ),
  ).toEqual(["23", "59"]);
});

it("shows a 24-hour clock with no a.m./p.m. in Chinese", () => {
  setLanguageForTest("zh-Hans");
  const html = renderToStaticMarkup(
    <TimeOfDayInput label="开始 1" value="17:30:00" onChange={() => undefined} />,
  );
  expect(shown(html)).toEqual(["17", "30"]);
  expect(html).not.toMatch(/上午|下午|AM|PM/u);
});

it("saves a picked time to the minute and reads any saved value safely", () => {
  expect(wallClockParts("17:05:00")).toEqual({ hour: 17, minute: 5 });
  expect(wallClockParts("23:59:59")).toEqual({ hour: 23, minute: 59 });
  expect(wallClockParts("nonsense")).toEqual({ hour: 0, minute: 0 });
  expect(wallClockValue({ hour: 9, minute: 5 })).toBe("09:05:00");
});
