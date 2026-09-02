export type PriceBookClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class PriceBookClientError extends Error {
  constructor(readonly code: PriceBookClientErrorCode) {
    super("Price Book view is unavailable");
    this.name = "PriceBookClientError";
  }
}
export interface PriceBookListItemView {
  readonly priceBookReference: string;
  readonly stableCode: string;
  readonly lifecycle: "Draft" | "Published" | "Archived";
  readonly scopeSummary: string;
  readonly currencyCode: string;
  readonly sourceSummary: string;
  readonly effectivePeriod: string;
  readonly entryCount: number;
  readonly coveredCount: number;
  readonly missingCount: number;
  readonly conflictCount: number;
  readonly aggregateVersion: number;
}
export interface PriceBookListView {
  readonly screenId: "PRICE-BOOK-LIST";
  readonly asOfUtc: string;
  readonly items: readonly PriceBookListItemView[];
}
export interface PriceBookEditorView {
  readonly screenId: "PRICE-BOOK-EDITOR";
  readonly priceBookReference: string;
  readonly stableCode: string;
  readonly lifecycle: PriceBookListItemView["lifecycle"];
  readonly currencyCode: string;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly scopeHierarchy: string;
  readonly roundingSummary: string;
  readonly taxCategorySummary: string;
  readonly historySummary: string;
  readonly entries: readonly {
    readonly entryReference: string;
    readonly sellableName: string;
    readonly sellableCode: string;
    readonly scopeSummary: string;
    readonly channelSummary: string;
    readonly amountMinor: string;
    readonly effectivePeriod: string;
    readonly coverageStatus: "Covered" | "Missing" | "Conflict";
    readonly reasonCode: string;
  }[];
}
export interface PriceBookClient {
  listPriceBooks(): Promise<PriceBookListView>;
  loadEditor(reference: string): Promise<PriceBookEditorView>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PriceBookClientError("Unavailable");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new PriceBookClientError("Unavailable");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 180) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > max ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new PriceBookClientError("Unavailable");
  return value.trim();
}
function integer(value: unknown, positive = false) {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0))
    throw new PriceBookClientError("Unavailable");
  return value as number;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new PriceBookClientError("Unavailable");
  return value as T;
}
export function parsePriceBookRouteReference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new PriceBookClientError("NotFound");
  return value;
}
function common(raw: Record<string, unknown>): PriceBookListItemView {
  if (
    typeof raw.priceBookReference !== "string" ||
    !uuid.test(raw.priceBookReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode)
  )
    throw new PriceBookClientError("Unavailable");
  return Object.freeze({
    priceBookReference: raw.priceBookReference,
    stableCode: raw.stableCode,
    lifecycle: choice(raw.lifecycle, ["Draft", "Published", "Archived"]),
    scopeSummary: text(raw.scopeSummary),
    currencyCode: raw.currencyCode,
    sourceSummary: text(raw.sourceSummary),
    effectivePeriod: text(raw.effectivePeriod),
    entryCount: integer(raw.entryCount),
    coveredCount: integer(raw.coveredCount),
    missingCount: integer(raw.missingCount),
    conflictCount: integer(raw.conflictCount),
    aggregateVersion: integer(raw.aggregateVersion, true),
  });
}
export function parsePriceBookListView(value: unknown): PriceBookListView {
  const raw = record(value, ["screenId", "asOfUtc", "items"]);
  if (
    raw.screenId !== "PRICE-BOOK-LIST" ||
    typeof raw.asOfUtc !== "string" ||
    !Array.isArray(raw.items)
  )
    throw new PriceBookClientError("Unavailable");
  try {
    if (new Date(raw.asOfUtc).toISOString() !== raw.asOfUtc) throw new Error("instant");
  } catch {
    throw new PriceBookClientError("Unavailable");
  }
  return Object.freeze({
    screenId: "PRICE-BOOK-LIST",
    asOfUtc: raw.asOfUtc,
    items: Object.freeze(
      raw.items.map((item) =>
        common(
          record(item, [
            "priceBookReference",
            "stableCode",
            "lifecycle",
            "scopeSummary",
            "currencyCode",
            "sourceSummary",
            "effectivePeriod",
            "entryCount",
            "coveredCount",
            "missingCount",
            "conflictCount",
            "aggregateVersion",
          ]),
        ),
      ),
    ),
  });
}
export function parsePriceBookEditorView(value: unknown): PriceBookEditorView {
  const raw = record(value, [
    "screenId",
    "priceBookReference",
    "stableCode",
    "lifecycle",
    "currencyCode",
    "aggregateVersion",
    "versionNumber",
    "scopeHierarchy",
    "roundingSummary",
    "taxCategorySummary",
    "historySummary",
    "entries",
  ]);
  if (
    raw.screenId !== "PRICE-BOOK-EDITOR" ||
    typeof raw.priceBookReference !== "string" ||
    !uuid.test(raw.priceBookReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode) ||
    !Array.isArray(raw.entries)
  )
    throw new PriceBookClientError("Unavailable");
  return Object.freeze({
    screenId: "PRICE-BOOK-EDITOR",
    priceBookReference: raw.priceBookReference,
    stableCode: raw.stableCode,
    lifecycle: choice(raw.lifecycle, ["Draft", "Published", "Archived"]),
    currencyCode: raw.currencyCode,
    aggregateVersion: integer(raw.aggregateVersion, true),
    versionNumber: integer(raw.versionNumber, true),
    scopeHierarchy: text(raw.scopeHierarchy),
    roundingSummary: text(raw.roundingSummary),
    taxCategorySummary: text(raw.taxCategorySummary),
    historySummary: text(raw.historySummary),
    entries: Object.freeze(
      raw.entries.map((candidate) => {
        const item = record(candidate, [
          "entryReference",
          "sellableName",
          "sellableCode",
          "scopeSummary",
          "channelSummary",
          "amountMinor",
          "effectivePeriod",
          "coverageStatus",
          "reasonCode",
        ]);
        if (
          typeof item.entryReference !== "string" ||
          !uuid.test(item.entryReference) ||
          typeof item.sellableCode !== "string" ||
          !code.test(item.sellableCode) ||
          typeof item.amountMinor !== "string" ||
          !/^(0|[1-9][0-9]{0,29})$/u.test(item.amountMinor) ||
          typeof item.reasonCode !== "string" ||
          !code.test(item.reasonCode)
        )
          throw new PriceBookClientError("Unavailable");
        return Object.freeze({
          entryReference: item.entryReference,
          sellableName: text(item.sellableName),
          sellableCode: item.sellableCode,
          scopeSummary: text(item.scopeSummary),
          channelSummary: text(item.channelSummary),
          amountMinor: item.amountMinor,
          effectivePeriod: text(item.effectivePeriod),
          coverageStatus: choice(item.coverageStatus, ["Covered", "Missing", "Conflict"]),
          reasonCode: item.reasonCode,
        });
      }),
    ),
  });
}
export const unavailablePriceBookClient: PriceBookClient = Object.freeze({
  async listPriceBooks() {
    throw new PriceBookClientError("Unavailable");
  },
  async loadEditor() {
    throw new PriceBookClientError("Unavailable");
  },
});
