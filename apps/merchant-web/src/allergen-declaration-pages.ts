/** WP-2423 / DEC-ALLERGEN-DECLARATIONS: CMP-ALLERGEN-REVIEW view contract and same-origin client. */
export type AllergenErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "RegistryMissing"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class AllergenPageError extends Error {
  constructor(readonly code: AllergenErrorCode) {
    super("Allergens are unavailable");
    this.name = "AllergenPageError";
  }
}
export type AllergenClassification = "Contains" | "CrossContactPossible";
export interface AllergenRegistryView {
  readonly registryVersionReference: string;
  readonly jurisdictionCode: string;
  readonly reviewedAt: string;
  readonly reviewerReference: string;
  readonly entries: readonly {
    readonly allergenReference: string;
    readonly code: string;
    readonly localizedNames: Readonly<Record<string, string>>;
  }[];
}
export interface IngredientDeclarationView {
  readonly evidenceReference: string;
  readonly itemReference: string;
  readonly itemVersionReference: string;
  readonly registryVersionReference: string;
  readonly allergens: readonly {
    readonly allergenReference: string;
    readonly classification: AllergenClassification;
  }[];
  readonly sourceKind: string;
  readonly documentReference: string;
  readonly note: string | null;
  readonly declaredBy: string;
  readonly reviewedAt: string;
  readonly validUntil: string;
  /** Last local date (Store time zone) the declaration is valid on. */
  readonly validThrough?: string;
}
export type DeclarationStatus =
  "Current" | "ExpiringSoon" | "ItemChanged" | "RegistryChanged" | "Missing";
export interface AllergenItemRow {
  readonly itemReference: string;
  readonly itemVersionReference: string;
  readonly internalCode: string;
  readonly name: string;
  readonly unitCode: string;
  readonly status: DeclarationStatus;
  readonly declaration: IngredientDeclarationView | null;
}
interface AllergenViewBase {
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly locale: string;
  readonly permissions: {
    readonly mayRead: boolean;
    readonly mayDeclare: boolean;
    readonly mayManageRegistry: boolean;
  };
  readonly registry: AllergenRegistryView | null;
  readonly registryTemplate: {
    readonly template: "CA_PRIORITY_TEST";
    readonly jurisdictionCode: string;
    readonly policyDocument: string;
    readonly allergens: readonly { readonly code: string; readonly name: string }[];
  };
  readonly sources: readonly string[];
}
export interface AllergenListView extends AllergenViewBase {
  readonly screenId: "CMP-ALLERGEN-REVIEW";
  readonly items: readonly AllergenItemRow[];
}
export interface AllergenItemView extends AllergenViewBase {
  readonly screenId: "CMP-ALLERGEN-ITEM";
  readonly item: AllergenItemRow;
  readonly history: readonly IngredientDeclarationView[];
}
export type AllergenCommand =
  | {
      readonly action: "ApproveRegistry";
      readonly operationReference: string;
      readonly template: "CA_PRIORITY_TEST";
    }
  | {
      readonly action: "Declare";
      readonly operationReference: string;
      readonly itemReference: string;
      readonly expectedItemVersion: string;
      readonly allergens: readonly {
        readonly allergenReference: string;
        readonly classification: AllergenClassification;
      }[];
      readonly sourceKind: string;
      readonly documentReference: string;
      readonly note: string | null;
      readonly validUntilDate: string;
    };
export interface AllergenClient {
  load(itemReference: string | null): Promise<unknown>;
  command?(command: AllergenCommand): Promise<unknown>;
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function base(r: Record<string, unknown> | null): r is Record<string, unknown> {
  return (
    r !== null &&
    typeof r.sourceAsOf === "string" &&
    object(r.permissions) !== null &&
    object(r.registryTemplate) !== null &&
    Array.isArray(r.sources)
  );
}
export function parseAllergenListView(value: unknown): AllergenListView {
  const r = object(value);
  if (!base(r) || r.screenId !== "CMP-ALLERGEN-REVIEW" || !Array.isArray(r.items))
    throw new Error("ALLERGEN_PAGE_INVALID");
  return r as unknown as AllergenListView;
}
export function parseAllergenItemView(value: unknown): AllergenItemView {
  const r = object(value);
  if (
    !base(r) ||
    r.screenId !== "CMP-ALLERGEN-ITEM" ||
    object(r.item) === null ||
    !Array.isArray(r.history)
  )
    throw new Error("ALLERGEN_PAGE_INVALID");
  return r as unknown as AllergenItemView;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const parseAllergenRouteReference = (value: string | undefined): string | null =>
  value !== undefined && uuid.test(value) ? value : null;
export const allergenName = (
  registry: AllergenRegistryView | null,
  reference: string,
  locale: string,
) => {
  const entry = registry?.entries.find((item) => item.allergenReference === reference);
  if (!entry) return "Allergen " + reference.slice(-4);
  return entry.localizedNames[locale] ?? Object.values(entry.localizedNames)[0] ?? entry.code;
};
/** "Contains milk, soy · May contain sesame" or "No priority allergens". */
export function declarationSummary(
  registry: AllergenRegistryView | null,
  declaration: IngredientDeclarationView,
  locale: string,
): string {
  const names = (kind: AllergenClassification) =>
    declaration.allergens
      .filter((a) => a.classification === kind)
      .map((a) => allergenName(registry, a.allergenReference, locale));
  const contains = names("Contains");
  const may = names("CrossContactPossible");
  if (!contains.length && !may.length) return "No priority allergens";
  return [
    contains.length ? "Contains " + contains.join(", ") : null,
    may.length ? "May contain " + may.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
/** A date one year after the given ISO date (same month and day; 28 Feb for 29 Feb). */
export function oneYearAfter(isoDate: string): string {
  const [y = "2000", m = "01", d = "01"] = isoDate.slice(0, 10).split("-");
  const year = String(Number(y) + 1);
  const day = m === "02" && d === "29" ? "28" : d;
  return `${year}-${m}-${day}`;
}
export const unavailableAllergenClient: AllergenClient = {
  load: async () => {
    throw new AllergenPageError("Unavailable");
  },
};
const codes = new Set<AllergenErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "RegistryMissing",
  "Invalid",
]);
export function createAllergenClient(csrf: string, fetcher: typeof fetch = fetch): AllergenClient {
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
      throw new AllergenPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as AllergenErrorCode;
      throw new AllergenPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (itemReference) => post("/merchant/compliance/allergens/query", { itemReference }),
    command: (command) => post("/merchant/compliance/allergens/command", command),
  };
}
