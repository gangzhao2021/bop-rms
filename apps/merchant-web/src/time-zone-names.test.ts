import { expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { storeTimeZoneChoices, timeZoneChoices, timeZoneLabel } from "./time-zone-names.js";

const at = new Date("2026-10-14T16:00:00Z");

it("labels zones by name and place instead of the identifier", () => {
  expect(timeZoneLabel("America/Toronto", at)).toBe("Eastern Time (Toronto, Ottawa and Montréal)");
  expect(timeZoneLabel("America/St_Johns", at)).toBe(
    "Newfoundland Time (St. John’s, Newfoundland and Labrador)",
  );
  expect(timeZoneLabel("America/Regina", at)).toBe(
    "Central Standard Time (Regina and Saskatoon, Saskatchewan)",
  );
  expect(timeZoneLabel("Africa/Abidjan", at)).toBe("Greenwich Mean Time (Abidjan)");
  expect(timeZoneLabel("America/Indiana/Knox", at)).toMatch(/\(Knox, Indiana\)$/u);
});

it("lists Canadian zones first, keeps the identifier as the value and shows no identifiers", () => {
  const supported = Intl.supportedValuesOf("timeZone");
  const { canada, other } = timeZoneChoices("", supported, at);
  expect(canada.slice(0, 2).map((zone) => zone.value)).toEqual([
    "America/St_Johns",
    "America/Halifax",
  ]);
  for (const id of [
    "America/Toronto",
    "America/Winnipeg",
    "America/Edmonton",
    "America/Vancouver",
    "America/Whitehorse",
  ])
    expect(canada.map((zone) => zone.value)).toContain(id);
  expect(other.map((zone) => zone.value)).not.toContain("America/Toronto");
  expect(other.map((zone) => zone.value)).toContain("Africa/Abidjan");
  const values = [...canada, ...other].map((zone) => zone.value);
  expect(new Set(values).size).toBe(values.length);
  expect(
    findInternalText([...canada, ...other].map((zone) => zone.label)),
    "every option label is plain",
  ).toEqual([]);
});

it("keeps a saved zone the browser does not list, so it is never silently replaced", () => {
  const { canada, other } = timeZoneChoices("America/Montreal", ["America/Toronto"], at);
  expect(canada.find((zone) => zone.value === "America/Montreal")?.label).toBe(
    "Eastern Time (Toronto, Ottawa and Montréal)",
  );
  expect(other).toEqual([]);
  const legacy = timeZoneChoices("Europe/Kiev", ["Africa/Abidjan"], at);
  expect(legacy.other.map((zone) => zone.value)).toContain("Europe/Kiev");
});

it("writes identifier spellings as the place is written", () => {
  expect(timeZoneLabel("Antarctica/DumontDUrville", at)).toMatch(/\(Dumont d’Urville\)$/u);
});

// b21 (v15 live check): Store setup offers the Canadian zones by plain name in both languages (the
// list opening a Store uses) and keeps a zone outside it selectable and readable; the value stays
// the IANA identifier.
it("Store setup lists the Canadian zones plainly and keeps a zone outside them", () => {
  expect(storeTimeZoneChoices([], at)).toEqual([
    { value: "America/Toronto", label: "Eastern time (Toronto, Ottawa, Montréal)" },
    { value: "America/Vancouver", label: "Pacific time (Vancouver)" },
    { value: "America/Edmonton", label: "Mountain time (Calgary, Edmonton)" },
    { value: "America/Winnipeg", label: "Central time (Winnipeg)" },
    { value: "America/Regina", label: "Saskatchewan (Regina, Saskatoon)" },
    { value: "America/Halifax", label: "Atlantic time (Halifax)" },
    { value: "America/St_Johns", label: "Newfoundland time (St. John's)" },
    { value: "America/Moncton", label: "Atlantic time (Moncton)" },
    { value: "America/Whitehorse", label: "Yukon (Whitehorse)" },
  ]);
  const kept = storeTimeZoneChoices(["America/Montreal", "America/Iqaluit", "Europe/Athens"], at);
  expect(kept[0]).toEqual({
    value: "America/Montreal",
    label: "Eastern time (Toronto, Ottawa, Montréal)",
  });
  expect(kept.slice(9)).toEqual([
    { value: "America/Iqaluit", label: timeZoneLabel("America/Iqaluit", at) },
    { value: "Europe/Athens", label: timeZoneLabel("Europe/Athens", at) },
  ]);
  expect(findInternalText(kept.map((zone) => zone.label))).toEqual([]);
  setLanguageForTest("zh-Hans");
  try {
    expect(storeTimeZoneChoices(["America/Vancouver"], at).map((zone) => zone.label)).toEqual([
      "东部时间（多伦多、渥太华、蒙特利尔）",
      "太平洋时间（温哥华）",
      "山地时间（卡尔加里、埃德蒙顿）",
      "中部时间（温尼伯）",
      "萨斯喀彻温（里贾纳、萨斯卡通）",
      "大西洋时间（哈利法克斯）",
      "纽芬兰时间（圣约翰斯）",
      "大西洋时间（蒙克顿）",
      "育空（白马市）",
    ]);
  } finally {
    setLanguageForTest("en");
  }
});
