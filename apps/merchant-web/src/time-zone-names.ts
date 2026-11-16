import { storeOpeningTimeZones } from "./store-opening-client.js";
import { displayLocale, t } from "./i18n/i18n.js";
/**
 * Staff choose and read a store's time zone by name and place ("Eastern Time (Toronto, Ottawa
 * and Montréal)"), never by its IANA identifier. The identifier stays the submitted/stored value;
 * only the visible label changes. Canadian zones come first because pilot stores are Canadian.
 */
interface CanadianZone {
  /** Preferred identifier first; later entries are equivalent aliases some browsers list instead. */
  readonly ids: readonly string[];
  readonly place: string;
}

const canadianZones: readonly CanadianZone[] = [
  { ids: ["America/St_Johns"], place: t("St. John’s, Newfoundland and Labrador") },
  { ids: ["America/Halifax"], place: t("Halifax, Nova Scotia and Prince Edward Island") },
  { ids: ["America/Glace_Bay"], place: t("Glace Bay, Nova Scotia") },
  { ids: ["America/Moncton"], place: t("Moncton, New Brunswick") },
  { ids: ["America/Goose_Bay"], place: t("Goose Bay, Labrador") },
  { ids: ["America/Blanc-Sablon"], place: t("Blanc-Sablon, Quebec") },
  { ids: ["America/Toronto", "America/Montreal"], place: t("Toronto, Ottawa and Montréal") },
  { ids: ["America/Iqaluit"], place: t("Iqaluit, Nunavut") },
  { ids: ["America/Coral_Harbour", "America/Atikokan"], place: t("Atikokan, Ontario") },
  { ids: ["America/Winnipeg"], place: t("Winnipeg, Manitoba") },
  { ids: ["America/Rankin_Inlet"], place: t("Rankin Inlet, Nunavut") },
  { ids: ["America/Resolute"], place: t("Resolute, Nunavut") },
  { ids: ["America/Regina"], place: t("Regina and Saskatoon, Saskatchewan") },
  { ids: ["America/Swift_Current"], place: t("Swift Current, Saskatchewan") },
  { ids: ["America/Edmonton", "America/Yellowknife"], place: t("Edmonton and Calgary, Alberta") },
  { ids: ["America/Cambridge_Bay"], place: t("Cambridge Bay, Nunavut") },
  { ids: ["America/Inuvik"], place: t("Inuvik, Northwest Territories") },
  { ids: ["America/Vancouver"], place: t("Vancouver, British Columbia") },
  { ids: ["America/Creston"], place: t("Creston, British Columbia") },
  { ids: ["America/Dawson_Creek"], place: t("Dawson Creek, British Columbia") },
  { ids: ["America/Fort_Nelson"], place: t("Fort Nelson, British Columbia") },
  { ids: ["America/Whitehorse"], place: t("Whitehorse, Yukon") },
  { ids: ["America/Dawson"], place: t("Dawson City, Yukon") },
];

const canadianPlace = new Map(
  canadianZones.flatMap((zone) => zone.ids.map((id) => [id, zone.place] as const)),
);

function genericName(timeZone: string, at: Date): string | null {
  try {
    const name = new Intl.DateTimeFormat(displayLocale(), { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    // Zones without a common name fall back to an offset such as "GMT+03:00"; show the place only.
    return name && !/^(?:GMT|UTC)\b/u.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Identifier spellings that are not how the place is written. */
const placeSpelling: Readonly<Record<string, string>> = { DumontDUrville: t("Dumont d’Urville") };

/** "America/Indiana/Knox" → "Knox, Indiana"; "Africa/Abidjan" → "Abidjan". */
function placeFromId(timeZone: string): string {
  const parts = timeZone.split("/").map((part) => placeSpelling[part] ?? part.replace(/_/gu, " "));
  const city = parts.at(-1) ?? timeZone;
  return parts.length > 2 ? `${city}, ${parts.slice(1, -1).join(", ")}` : city;
}

/** A staff-readable label for an IANA time zone identifier, e.g. "Eastern Time (Toronto, …)". */
export function timeZoneLabel(timeZone: string, at: Date = new Date()): string {
  const place = canadianPlace.get(timeZone) ?? placeFromId(timeZone);
  const name = genericName(timeZone, at);
  return name ? `${name} (${place})` : place;
}

export interface TimeZoneChoice {
  /** The IANA identifier submitted and stored unchanged. */
  readonly value: string;
  readonly label: string;
}

/**
 * Canadian zones first, east to west, then every other zone sorted by label. A saved value that the browser does not
 * list (for example an older alias) is still offered so that it is never silently replaced.
 */
export function timeZoneChoices(
  saved: string,
  supported: readonly string[] = Intl.supportedValuesOf("timeZone"),
  at: Date = new Date(),
): { readonly canada: readonly TimeZoneChoice[]; readonly other: readonly TimeZoneChoice[] } {
  const available = new Set(supported);
  const used = new Set<string>();
  const canada: TimeZoneChoice[] = [];
  for (const zone of canadianZones) {
    const value =
      zone.ids.find((id) => id === saved) ??
      zone.ids.find((id) => available.has(id)) ??
      zone.ids[0];
    if (value === undefined) continue;
    for (const id of zone.ids) used.add(id);
    canada.push({ value, label: timeZoneLabel(value, at) });
  }
  const other = [...new Set([...(saved ? [saved] : []), ...supported])]
    .filter((id) => !used.has(id))
    .map((value) => ({ value, label: timeZoneLabel(value, at) }))
    .sort((a, b) => a.label.localeCompare(b.label, "en-CA") || a.value.localeCompare(b.value));
  return { canada, other };
}

/**
 * b21 (product definition: Chinese restaurants in Canada): the Canadian zones a restaurant runs
 * on, named plainly in the staff language. Opening a Store and Store setup use the same list.
 */
export const canadianStoreTimeZoneText = (): Record<
  (typeof storeOpeningTimeZones)[number],
  string
> => ({
  "America/Toronto": t("Eastern time (Toronto, Ottawa, Montréal)"),
  "America/Vancouver": t("Pacific time (Vancouver)"),
  "America/Edmonton": t("Mountain time (Calgary, Edmonton)"),
  "America/Winnipeg": t("Central time (Winnipeg)"),
  "America/Regina": t("Saskatchewan (Regina, Saskatoon)"),
  "America/Halifax": t("Atlantic time (Halifax)"),
  "America/St_Johns": t("Newfoundland time (St. John's)"),
  "America/Moncton": t("Atlantic time (Moncton)"),
  "America/Whitehorse": t("Yukon (Whitehorse)"),
});
/** Older identifiers of the same zone: a Store kept on one selects that zone with its own value. */
const sameZone: Readonly<Record<string, (typeof storeOpeningTimeZones)[number]>> = {
  "America/Montreal": "America/Toronto",
  "America/Nipigon": "America/Toronto",
  "America/Thunder_Bay": "America/Toronto",
  "America/Rainy_River": "America/Winnipeg",
  "America/Yellowknife": "America/Edmonton",
};

/**
 * b21 review: an older identifier of a listed zone, named as that zone plus where its id points,
 * so that it can stand beside the zone's own option without two options reading alike.
 */
function olderZoneName(timeZone: string): string | null {
  const zone = sameZone[timeZone];
  if (zone === undefined) return null;
  const place: Readonly<Record<string, string>> = {
    "America/Montreal": t("Montréal"),
    "America/Nipigon": t("Nipigon"),
    "America/Thunder_Bay": t("Thunder Bay"),
    "America/Rainy_River": t("Rainy River"),
    "America/Yellowknife": t("Yellowknife"),
  };
  return t("{zone}, older setting ({place})", {
    zone: canadianStoreTimeZoneText()[zone],
    place: place[timeZone] ?? placeFromId(timeZone),
  });
}

/**
 * The Store setup choices: the Canadian zones, then any zone the Store runs on or the draft holds
 * that is not one of them, still selectable and named by place. The value stays the IANA id.
 * b21 review: a listed zone held under more than one id (the Store runs on America/Montreal and
 * the draft holds America/Toronto) offers each id as its own option, so the field always has its
 * own value to show and choosing one never stores the other.
 */
export function storeTimeZoneChoices(
  kept: readonly string[],
  at: Date = new Date(),
): readonly TimeZoneChoice[] {
  const wanted = [...new Set(kept.filter((id) => id !== ""))];
  const text = canadianStoreTimeZoneText();
  const listed = storeOpeningTimeZones.flatMap((zone): TimeZoneChoice[] => {
    const held = wanted.filter((id) => id === zone || sameZone[id] === zone);
    const only = held.length === 1 ? held[0] : undefined;
    if (held.length === 0 || only !== undefined)
      return [{ value: only ?? zone, label: text[zone] }];
    // The zone's own id keeps the plain name; each older id says it is the older setting.
    return held.map((value) => ({ value, label: olderZoneName(value) ?? text[zone] }));
  });
  const covered = new Set<string>([...storeOpeningTimeZones, ...Object.keys(sameZone)]);
  const extra = wanted
    .filter((id) => !covered.has(id))
    .map((value) => ({ value, label: timeZoneLabel(value, at) }));
  return [...listed, ...extra];
}

/** b21: a Store's zone in Store setup's words: its Canadian name when listed, else name and place. */
export function storeTimeZoneName(timeZone: string, at: Date = new Date()): string {
  const text: Readonly<Record<string, string>> = canadianStoreTimeZoneText();
  return text[sameZone[timeZone] ?? timeZone] ?? timeZoneLabel(timeZone, at);
}

/**
 * b21 review: two zone ids compared in one sentence ("now … → changes to …"). When both read as the
 * same zone, the older id says so, so a change of id is never shown as "Eastern → Eastern" alone.
 */
export function storeTimeZoneNamesApart(
  now: string,
  next: string,
  at: Date = new Date(),
): { readonly now: string; readonly next: string } {
  const a = storeTimeZoneName(now, at),
    b = storeTimeZoneName(next, at);
  if (now === next || a !== b) return { now: a, next: b };
  return { now: olderZoneName(now) ?? a, next: olderZoneName(next) ?? b };
}
