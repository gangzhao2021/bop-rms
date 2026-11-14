import { afterEach, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { supportLogShown, supportLogSummary } from "./StoreSupportAccessPanel.js";
import { storeNameExample, storeNameLabel } from "./StorePublicProfilePanel.js";
import { plainLanguageName } from "./staff-text.js";

afterEach(() => setLanguageForTest("en"));

it("b18: the support log leads with what support changed or tried, and counts the looks", () => {
  const entry = (kind: string, minute: number) => ({
    occurredAt: new Date(Date.UTC(2026, 10, 14, 18, 60 - minute)).toISOString(),
    supportName: "Support",
    kind: kind as "Viewed" | "Changed" | "Refused",
    subjectCode: "MerchantOverview",
  });
  const log = [
    entry("Viewed", 1),
    entry("Changed", 2),
    entry("Viewed", 3),
    entry("Refused", 4),
    entry("Viewed", 5),
  ];
  const summary = supportLogSummary(log);
  expect(summary.acted.map((value) => value.kind)).toEqual(["Changed", "Refused"]);
  expect(summary.looks).toBe(3);
  expect(summary.lastLook).toBe(log[0]?.occurredAt);
  expect(supportLogShown).toBe(5);
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
