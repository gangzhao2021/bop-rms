import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ServiceHoursSummary, serviceTime } from "./StoreServiceControlPanel.js";

it("WP-2423 Q4: writes published hours in staff language", () => {
  expect(serviceTime("09:00:00")).toBe("9:00 AM");
  expect(serviceTime("00:00:00")).toBe("12:00 AM");
  expect(serviceTime("12:30:00")).toBe("12:30 PM");
  expect(serviceTime("23:59:59")).toBe("11:59 PM");
  const interval = {
    startLocalTime: "11:00:00",
    endLocalTime: "21:30:00",
    endsNextDay: false,
    serviceModes: ["DineIn", "Pickup"],
    orderCutoffSeconds: 900,
    leadTimeSeconds: 0,
  };
  const html = renderToStaticMarkup(
    <ServiceHoursSummary
      timeZone="America/Toronto"
      hours={
        {
          configurationSource: "StoreOverride",
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: [
            { isoWeekday: 1, intervals: [interval] },
            { isoWeekday: 2, intervals: [] },
          ],
          exceptions: [],
        } as never
      }
    />,
  );
  expect(html).toContain(
    "11:00 AM–9:30 PM · Dine-in, Pickup · last orders 15 minutes before closing",
  );
  expect(html).toContain("Business day starts at 4:00 AM.");
  expect(html).not.toContain("DineIn");
  expect(html).not.toContain("0 seconds");
  expect(html).toContain("<h3>Tuesday</h3><p>Closed</p>");
});
