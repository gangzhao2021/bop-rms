import { expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import { timeZoneChoices, timeZoneLabel } from "./time-zone-names.js";

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
