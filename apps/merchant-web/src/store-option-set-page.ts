/** WP-2423 slice 4: CAT-OPTIONSET-LIST / CAT-OPTIONSET-EDIT view contract and same-origin client. */
export type OptionSetErrorCode =
  "PermissionDenied" | "NotFound" | "Conflict" | "Invalid" | "Offline" | "Unavailable";
export class OptionSetPageError extends Error {
  constructor(readonly code: OptionSetErrorCode) {
    super("Option sets are unavailable");
    this.name = "OptionSetPageError";
  }
}
export type OptionChoiceKind = "One" | "Any" | "Quantity";
export interface OptionRow {
  readonly optionReference: string;
  readonly code: string;
  readonly name: string;
  readonly offered: boolean;
  readonly defaultChoice: boolean;
}
export interface OptionSetRow {
  readonly optionSetReference: string;
  readonly internalCode: string;
  readonly aggregateVersion: number;
  readonly archived: boolean;
  readonly name: string;
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
  readonly kind: OptionChoiceKind;
  readonly minimum: number;
  readonly maximum: number | null;
  readonly perOptionMaximum: number;
  readonly options: readonly {
    readonly optionReference: string | null;
    readonly name: string;
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
  const need = set.minimum > 0 ? ` (at least ${set.minimum} required)` : " (optional)";
  if (set.kind === "One") return set.minimum > 0 ? "Choose 1 (required)" : "Choose 1 (optional)";
  const total = set.maximum === null ? "any number" : `up to ${set.maximum}`;
  if (set.kind === "Any") return `Choose ${total}${need}`;
  return `Up to ${set.perOptionMaximum} of each, ${total} in total${need}`;
}
export const unavailableOptionSetClient: OptionSetClient = {
  list: async () => {
    throw new OptionSetPageError("Unavailable");
  },
  load: async () => {
    throw new OptionSetPageError("Unavailable");
  },
};
const codes = new Set<OptionSetErrorCode>(["PermissionDenied", "NotFound", "Conflict", "Invalid"]);
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
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as OptionSetErrorCode;
      throw new OptionSetPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
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
