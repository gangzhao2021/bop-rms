import { expect, it } from "vitest";
import { customerDisplayLocale } from "./customer-display-locale.js";

it("Owner 2026-10-23: reads only a well-formed `locale`, else the session's own (null)", () => {
  expect(customerDisplayLocale(undefined)).toBeNull();
  expect(customerDisplayLocale({})).toBeNull();
  expect(customerDisplayLocale({ locale: "zh-Hans-CA" })).toBe("zh-Hans-CA");
  expect(customerDisplayLocale({ locale: "en-CA" })).toBe("en-CA");
  expect(customerDisplayLocale({ locale: "fr-CA", section: "x" }, ["section"])).toBe("fr-CA");
  for (const query of [
    { locale: ["zh-Hans-CA", "en-CA"] },
    { locale: "zh_CN" },
    { locale: "" },
    { locale: "zh-Hans-CA", other: "1" },
    [],
    null,
    "locale=zh-Hans-CA",
  ])
    expect(() => customerDisplayLocale(query)).toThrow();
});
