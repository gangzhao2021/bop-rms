import { t } from "./i18n/i18n.js";
/** WP-2423 slice 4: CAT-OPTIONSET-LIST / CAT-OPTIONSET-EDIT view contract and same-origin client. */
export type OptionSetErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "Invalid"
  | "OptionSet"
  | "Offline"
  | "Unavailable";
/** WP-2423 (cart-unsellable-dishes): a Save refused because of the dishes it would change. */
export interface OptionSetProblem {
  readonly reason: "DefaultNeeded" | "DefaultChangeNeedsDishEditor";
  readonly optionName: string;
  readonly productNames: readonly string[];
}
export class OptionSetPageError extends Error {
  constructor(
    readonly code: OptionSetErrorCode,
    readonly problem: OptionSetProblem | null = null,
  ) {
    super(t("Option sets are unavailable"));
    this.name = "OptionSetPageError";
  }
}
/** What a Save did to the dishes using the set (WP-2423 cart-unsellable-dishes). */
export interface OptionSetSaveEffect {
  readonly defaultsCarried?: readonly { productName: string; startsWith: string | null }[];
  readonly notOfferedDefaults?: readonly { optionName: string; productNames: readonly string[] }[];
}
/** The staff words for a Save refused because of the dishes it would change. */
export function optionSetProblemText(problem: OptionSetProblem): string {
  const dishes = problem.productNames.join(", ");
  return problem.reason === "DefaultNeeded"
    ? t(
        "{set} needs a choice guests start with on {dishes}. Tick “Default” on another offered choice, then save. Nothing was saved.",
        { set: problem.optionName, dishes },
      )
    : t(
        "This changes what {dishes} start with. Ask someone who can edit dishes to save it. Nothing was saved.",
        { dishes },
      );
}
/** After a Save: which dishes now start with another choice, and which start with one now off. */
export function optionSetSaveEffectText(effect: OptionSetSaveEffect): string[] {
  const lines: string[] = [];
  const byChoice = new Map<string, string[]>();
  for (const carried of effect.defaultsCarried ?? []) {
    const key = carried.startsWith ?? "";
    byChoice.set(key, [...(byChoice.get(key) ?? []), carried.productName]);
  }
  for (const [choice, dishes] of byChoice)
    lines.push(
      choice === ""
        ? t("{dishes} now start with no choice. List the menu to show it to guests.", {
            dishes: dishes.join(", "),
          })
        : t("{dishes} now start with {option}. List the menu to show it to guests.", {
            dishes: dishes.join(", "),
            option: choice,
          }),
    );
  for (const off of effect.notOfferedDefaults ?? [])
    lines.push(offDefaultText(off.optionName, off.productNames));
  return lines;
}
/** A choice guests start with on some dishes is turned off (before and after Save). */
export function offDefaultText(option: string, dishes: readonly string[]): string {
  return t(
    "Guests start with {option} on {dishes}. While {option} isn't offered, guests choose another choice themselves, and the menu can't be listed. To list other changes meanwhile, make another option the Default. Tick Offered again when it's back.",
    { option, dishes: dishes.join(", ") },
  );
}
export type OptionChoiceKind = "One" | "Any" | "Quantity";
export interface OptionRow {
  readonly optionReference: string;
  readonly code: string;
  readonly name: string;
  /** Owner 2026-10-23: the Simplified Chinese name customers see ("" or absent when none). */
  readonly nameZh?: string;
  readonly offered: boolean;
  readonly defaultChoice: boolean;
  /** WP-2423 (cart-unsellable-dishes): the dishes whose draft starts guests with this option. */
  readonly startsOn?: readonly string[];
}
export interface OptionSetRow {
  readonly optionSetReference: string;
  readonly internalCode: string;
  readonly aggregateVersion: number;
  readonly archived: boolean;
  /** Products whose draft offers this set; customers see it once such a menu is published. */
  readonly productNames: readonly string[];
  readonly name: string;
  readonly nameZh?: string;
  readonly kind: OptionChoiceKind;
  readonly minimum: number;
  readonly maximum: number | null;
  readonly perOptionMaximum: number;
  readonly updatedAt: string;
  readonly options: readonly OptionRow[];
}
interface Base {
  readonly sourceAsOf: string;
  readonly permissions: { readonly mayEdit: boolean };
}
export interface OptionSetListView extends Base {
  readonly screenId: "CAT-OPTIONSET-LIST";
  readonly optionSets: readonly OptionSetRow[];
}
export interface OptionSetEditView extends Base {
  readonly screenId: "CAT-OPTIONSET-EDIT";
  readonly optionSet: OptionSetRow;
}
export interface OptionSetBody {
  readonly name: string;
  readonly nameZh: string;
  readonly kind: OptionChoiceKind;
  readonly minimum: number;
  readonly maximum: number | null;
  readonly perOptionMaximum: number;
  readonly options: readonly {
    readonly optionReference: string | null;
    readonly name: string;
    readonly nameZh: string;
    readonly offered: boolean;
    readonly defaultChoice: boolean;
  }[];
}
export type OptionSetCommand =
  | ({ readonly action: "Create"; readonly operationReference: string } & OptionSetBody)
  | ({
      readonly action: "Save";
      readonly operationReference: string;
      readonly optionSetReference: string;
      readonly expectedAggregateVersion: number;
    } & OptionSetBody)
  | {
      readonly action: "Archive";
      readonly operationReference: string;
      readonly optionSetReference: string;
      readonly expectedAggregateVersion: number;
    };
export interface OptionSetClient {
  list(): Promise<unknown>;
  load(optionSetReference: string): Promise<unknown>;
  command?(command: OptionSetCommand): Promise<unknown>;
}
const kinds = new Set(["One", "Any", "Quantity"]);
const validRow = (row: unknown) => {
  const r = row as Record<string, unknown> | null;
  return (
    r !== null &&
    typeof r === "object" &&
    typeof r.optionSetReference === "string" &&
    typeof r.name === "string" &&
    kinds.has(String(r.kind)) &&
    Array.isArray(r.options)
  );
};
export function parseOptionSetListView(value: unknown): OptionSetListView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "CAT-OPTIONSET-LIST" ||
    !Array.isArray(r.optionSets) ||
    !r.optionSets.every(validRow)
  )
    throw new Error("OPTION_SET_PAGE_INVALID");
  return r as unknown as OptionSetListView;
}
export function parseOptionSetEditView(value: unknown): OptionSetEditView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "CAT-OPTIONSET-EDIT" ||
    !validRow(r.optionSet)
  )
    throw new Error("OPTION_SET_PAGE_INVALID");
  return r as unknown as OptionSetEditView;
}
/** "Choose 1 (required)", "Choose up to 3", "Up to 3 of each" — the rule a customer sees. */
export function choiceRule(
  set: Pick<OptionSetRow, "kind" | "minimum" | "maximum" | "perOptionMaximum">,
) {
  const need =
    set.minimum > 0
      ? t(" (at least {minimum} required)", { minimum: set.minimum })
      : t(" (optional)");
  if (set.kind === "One")
    return set.minimum > 0 ? t("Choose 1 (required)") : t("Choose 1 (optional)");
  const total =
    set.maximum === null ? t("any number") : t("up to {maximum}", { maximum: set.maximum });
  if (set.kind === "Any") return t("Choose {total}{need}", { total: total, need: need });
  return t("Up to {perOptionMaximum} of each, {total} in total{need}", {
    perOptionMaximum: set.perOptionMaximum,
    total: total,
    need: need,
  });
}
export const unavailableOptionSetClient: OptionSetClient = {
  list: async () => {
    throw new OptionSetPageError("Unavailable");
  },
  load: async () => {
    throw new OptionSetPageError("Unavailable");
  },
};
const codes = new Set<OptionSetErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "Invalid",
  "OptionSet",
]);
const problemOf = (value: unknown): OptionSetProblem | null => {
  const r = value as Record<string, unknown> | null;
  return r !== null &&
    typeof r === "object" &&
    (r.reason === "DefaultNeeded" || r.reason === "DefaultChangeNeedsDishEditor") &&
    typeof r.optionName === "string" &&
    Array.isArray(r.productNames) &&
    r.productNames.every((item) => typeof item === "string")
    ? (r as unknown as OptionSetProblem)
    : null;
};
export function createOptionSetClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): OptionSetClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new OptionSetPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        problem?: unknown;
      } | null;
      const code = String(payload?.error) as OptionSetErrorCode;
      const problem = problemOf(payload?.problem);
      if (code === "OptionSet" && problem === null) throw new OptionSetPageError("Unavailable");
      throw new OptionSetPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        problem,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    list: () => post("/merchant/commerce/option-sets/query", {}),
    load: (optionSetReference) =>
      post("/merchant/commerce/option-sets/query", { optionSetReference }),
    command: (command) => post("/merchant/commerce/option-sets/command", command),
  };
}
/**
 * Where a set stands, in staff words: archived, not on any product yet (customers cannot see it),
 * or which products offer it. Never "in use" for a set no product offers.
 */
export function optionSetStateText(set: Pick<OptionSetRow, "archived" | "productNames">): string {
  if (set.archived) return t("Archived — it cannot be added to products.");
  if (set.productNames.length === 0)
    return t(
      "Saved, not on any product yet — customers cannot choose it until you add it to a product and publish a menu with that product.",
    );
  return t("On {value}.", { value: set.productNames.join(", ") });
}
