import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SupportAccessLog, supportLogSummary } from "./StoreSupportAccessPanel.js";
import { storeNameExample, storeNameLabel } from "./StorePublicProfilePanel.js";
import { plainLanguageName } from "./staff-text.js";

afterEach(() => setLanguageForTest("en"));

it("b18: what the support log says comes from the whole log, not the records on screen", () => {
  const entry = (kind: string, minute: number) => ({
    occurredAt: new Date(Date.UTC(2026, 10, 14, 18, 0) - minute * 60_000).toISOString(),
    supportName: "Support",
    kind: kind as "Viewed" | "Changed" | "Refused",
    subjectCode: kind === "Changed" ? "KitchenLine" : "MerchantOverview",
  });
  // The first page is all looks; the one change is older than every one of them (b18 review).
  const log = Array.from({ length: 50 }, (_, n) => entry("Viewed", n));
  const changed = entry("Changed", 500);
  const view = {
    version: 1,
    mode: "Off" as const,
    allowedUntil: null,
    log,
    logNext: { before: "2026-11-14T17:10:00.000000Z", skip: 1 },
    summary: {
      total: 160,
      looks: 159,
      lastLookAt: log[0]?.occurredAt ?? null,
      actedCount: 1,
      acted: [changed],
    },
  };
  const summary = supportLogSummary(view.summary);
  expect(summary).toMatchObject({ actedCount: 1, looks: 159, total: 160 });
  const html = renderToStaticMarkup(createElement(SupportAccessLog, { view }));
  expect(html).toContain("Set up your kitchen");
  expect(html).not.toContain("hasn&#x27;t changed or tried");
  expect(html).toContain("Support looked at your Store 159 times");
  // b18 polish: the access log repeats the looks counted above, so it starts folded; one toggle opens it.
  expect(html).toContain("View all 160 access records");
  expect(html).not.toContain("Looked at whether your Store is ready");
});

it("b18: a Store name field says its language plainly, with an example in that language", () => {
  setLanguageForTest("zh-Hans");
  expect(storeNameLabel("en-CA")).toBe("店名（英文）");
  expect(storeNameLabel("zh-Hans-CA")).toBe("店名（中文）");
  expect(storeNameExample("en-CA")).toContain("Maple Noodle House");
  expect(storeNameExample("en-CA")).not.toContain("枫叶");
  expect(storeNameExample("zh-Hans-CA")).toContain("枫叶面馆");
  expect(plainLanguageName("en-CA")).not.toContain("加拿大");
});
