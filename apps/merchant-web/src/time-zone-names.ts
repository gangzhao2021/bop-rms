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
