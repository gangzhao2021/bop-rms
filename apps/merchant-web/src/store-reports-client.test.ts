import { expect, it } from "vitest";
import { parseStoreReportsView } from "./store-reports-client.js";
import { storeReportsViewFixture } from "./store-reports.fixtures.js";

it("v15 2026-10-27: a day with online, card-machine and cash takings still reads", () => {
  // DEC-DINE-IN-PAY-LATER S3 added the Cash channel; the third channel blanked the Reports page.
  const view = storeReportsViewFixture();
  const channels = view.byChannel as Record<string, unknown>[];
  view.byChannel = [...channels, { ...channels[0], channel: "Cash" }];
  const tips = view.tips as { channels: Record<string, unknown>[] }[];
  view.tips = tips.map((day) => ({
    ...day,
    channels: [...day.channels, { ...day.channels[0], channel: "Cash" }],
  }));
  expect(parseStoreReportsView(view).byChannel.map((entry) => entry.channel)).toEqual([
    "Online",
    "CardMachine",
    "Cash",
  ]);
  expect(parseStoreReportsView(view).tips[0]?.channels.map((entry) => entry.channel)).toContain(
    "Cash",
  );
});
