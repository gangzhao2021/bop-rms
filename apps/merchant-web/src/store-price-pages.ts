/** WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: PRICE-BOOK-LIST / PRICE-BOOK-EDITOR view contract and client. */
export type PriceErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "CodeTaken"
  | "ApprovalRequired"
  | "NotCovered"
  | "NotPublished"
  | "AlreadyAssigned"
  | "Lifecycle"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class PricePageError extends Error {
  constructor(
    readonly code: PriceErrorCode,
    readonly sellableReferences: readonly string[] = [],
  ) {
    super("Prices are unavailable");
    this.name = "PricePageError";
  }
}
export interface PriceSellable {
  readonly sellableReference: string;
  readonly skuCode: string;
  readonly productReference: string;
  readonly productName: string;
  readonly sizeName: string;
  readonly active: boolean;
}
export interface StoreAssignment {
  readonly assignmentReference: string;
  readonly priceBookReference: string;
  readonly versionReference: string;
  readonly stableCode: string;
  readonly effectiveFrom: string;
  readonly endedAt: string | null;
  readonly assignedBy: string;
}
interface PriceViewBase {
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly permissions: {
    readonly mayRead: boolean;
    readonly mayEdit: boolean;
    readonly mayApprove: boolean;
  };
  readonly currencyCode: string;
  readonly storeAssignment: StoreAssignment | null;
  readonly assignmentHistory: readonly StoreAssignment[];
  readonly sellables: readonly PriceSellable[];
  readonly menuSellables: readonly string[];
}
export interface PriceBookSummary {
  readonly priceBookReference: string;
  readonly stableCode: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly versionReference: string;
  readonly entries: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface PriceBookListView extends PriceViewBase {
  readonly screenId: "PRICE-BOOK-LIST";
  readonly books: readonly PriceBookSummary[];
}
export interface PriceBookEditorView extends PriceViewBase {
  readonly screenId: "PRICE-BOOK-EDITOR";
  readonly book: {
    readonly priceBookReference: string;
    readonly versionReference: string;
    readonly stableCode: string;
    readonly lifecycle: string;
    readonly aggregateVersion: number;
    readonly createdAt: string;
    readonly prices: readonly {
      readonly sellableReference: string;
      readonly amountMinor: string;
    }[];
    readonly otherEntries: number;
  };
  readonly draftAuthor: string | null;
  readonly uncovered: readonly string[];
}
export type PriceCommand =
  | {
      readonly action: "CreateDraft";
      readonly operationReference: string;
      readonly stableCode: string;
      readonly copyFrom: string | null;
    }
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly priceBookReference: string;
      readonly expectedAggregateVersion: number;
      readonly prices: readonly {
        readonly sellableReference: string;
        readonly amountMinor: string;
      }[];
    }
  | {
      readonly action: "Publish" | "Discard";
      readonly operationReference: string;
      readonly priceBookReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "AssignToStore";
      readonly operationReference: string;
      readonly priceBookReference: string;
    };
export interface PriceClient {
  load(priceBookReference: string | null): Promise<unknown>;
  command?(command: PriceCommand): Promise<unknown>;
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
    Array.isArray(r.sellables) &&
    Array.isArray(r.assignmentHistory) &&
    Array.isArray(r.menuSellables)
  );
}
export function parsePriceBookListView(value: unknown): PriceBookListView {
  const r = object(value);
  if (!base(r) || r.screenId !== "PRICE-BOOK-LIST" || !Array.isArray(r.books))
    throw new Error("PRICE_PAGE_INVALID");
  return r as unknown as PriceBookListView;
}
export function parsePriceBookEditorView(value: unknown): PriceBookEditorView {
  const r = object(value);
  const book = object(r?.book);
  if (
    !base(r) ||
    r.screenId !== "PRICE-BOOK-EDITOR" ||
    book === null ||
    !Array.isArray(book.prices) ||
    !Array.isArray(r.uncovered)
  )
    throw new Error("PRICE_PAGE_INVALID");
  return r as unknown as PriceBookEditorView;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const parsePriceRouteReference = (value: string | undefined): string | null =>
  value !== undefined && uuid.test(value) ? value : null;
/** "4.5" / "4.50" / "4" → "450"; null when not an amount up to 99,999.99. */
export function dollarsToMinor(value: string): string | null {
  const match = /^(\d{1,5})(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (!match) return null;
  return String(BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(2, "0")));
}
/** "450" → "4.50" (exact). */
export function minorToDollars(minor: string): string {
  const digits = minor.replace(/^0+(?=\d)/u, "");
  return digits.length <= 2
    ? "0." + digits.padStart(2, "0")
    : digits.slice(0, -2) + "." + digits.slice(-2);
}
export const suggestPriceBookCode = (date: string) => "PRICES-" + date.replaceAll("-", "");
export const unavailablePriceClient: PriceClient = {
  load: async () => {
    throw new PricePageError("Unavailable");
  },
};
const codes = new Set<PriceErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "CodeTaken",
  "ApprovalRequired",
  "NotCovered",
  "NotPublished",
  "AlreadyAssigned",
  "Lifecycle",
  "Invalid",
]);
export function createPriceClient(csrf: string, fetcher: typeof fetch = fetch): PriceClient {
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
      throw new PricePageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        sellableReferences?: unknown;
      } | null;
      const code = String(payload?.error) as PriceErrorCode;
      throw new PricePageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        Array.isArray(payload?.sellableReferences)
          ? payload.sellableReferences.filter((item): item is string => typeof item === "string")
          : [],
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (priceBookReference) => post("/merchant/commerce/pricing/query", { priceBookReference }),
    command: (command) => post("/merchant/commerce/pricing/command", command),
  };
}
