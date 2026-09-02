export type TaxConfigClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class TaxConfigClientError extends Error {
  constructor(readonly code: TaxConfigClientErrorCode) {
    super("Tax Configuration view is unavailable");
    this.name = "TaxConfigClientError";
  }
}

export interface TaxConfigView {
  readonly screenId: "TAX-CONFIG";
  readonly configurationReference: string;
  readonly stableCode: string;
  readonly lifecycle: "Draft" | "Published";
  readonly aggregateVersion: number;
  readonly jurisdictionCode: string;
  readonly storeSummary: string;
  readonly registrationApplicability: string;
  readonly effectivePeriod: string;
  readonly fixtureStatus: "Missing" | "Approved" | "Failed";
  readonly historySummary: string;
  readonly categories: readonly {
    readonly categoryReference: string;
    readonly categoryCode: string;
    readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
    readonly rate: string;
    readonly priceInclusion: "Exclusive" | "Inclusive";
    readonly receiptCode: string;
  }[];
  readonly receiptPreview: readonly {
    readonly labelCode: string;
    readonly amountMinor: string;
  }[];
}

export interface TaxConfigClient {
  load(): Promise<TaxConfigView>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const rate = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?$/u;
const minor = /^-?(?:0|[1-9][0-9]{0,29})$/u;

function safeText(value: unknown, max = 180): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new TaxConfigClientError("Unavailable");
  return value.trim();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TaxConfigClientError("Unavailable");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new TaxConfigClientError("Unavailable");
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new TaxConfigClientError("Unavailable");
  return value as T;
}

export function parseTaxConfigView(value: unknown): TaxConfigView {
  const raw = object(value, [
    "screenId",
    "configurationReference",
    "stableCode",
    "lifecycle",
    "aggregateVersion",
    "jurisdictionCode",
    "storeSummary",
    "registrationApplicability",
    "effectivePeriod",
    "fixtureStatus",
    "historySummary",
    "categories",
    "receiptPreview",
  ]);
  if (
    raw.screenId !== "TAX-CONFIG" ||
    typeof raw.configurationReference !== "string" ||
    !uuid.test(raw.configurationReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    typeof raw.jurisdictionCode !== "string" ||
    !code.test(raw.jurisdictionCode) ||
    !Number.isSafeInteger(raw.aggregateVersion) ||
    (raw.aggregateVersion as number) < 1 ||
    !Array.isArray(raw.categories) ||
    !Array.isArray(raw.receiptPreview)
  )
    throw new TaxConfigClientError("Unavailable");
  return Object.freeze({
    screenId: "TAX-CONFIG",
    configurationReference: raw.configurationReference,
    stableCode: raw.stableCode,
    lifecycle: choice(raw.lifecycle, ["Draft", "Published"]),
    aggregateVersion: raw.aggregateVersion as number,
    jurisdictionCode: raw.jurisdictionCode,
    storeSummary: safeText(raw.storeSummary),
    registrationApplicability: safeText(raw.registrationApplicability),
    effectivePeriod: safeText(raw.effectivePeriod),
    fixtureStatus: choice(raw.fixtureStatus, ["Missing", "Approved", "Failed"]),
    historySummary: safeText(raw.historySummary),
    categories: Object.freeze(
      raw.categories.map((candidate) => {
        const item = object(candidate, [
          "categoryReference",
          "categoryCode",
          "treatment",
          "rate",
          "priceInclusion",
          "receiptCode",
        ]);
        if (
          typeof item.categoryReference !== "string" ||
          !uuid.test(item.categoryReference) ||
          typeof item.categoryCode !== "string" ||
          !code.test(item.categoryCode) ||
          typeof item.rate !== "string" ||
          !rate.test(item.rate) ||
          typeof item.receiptCode !== "string" ||
          !code.test(item.receiptCode)
        )
          throw new TaxConfigClientError("Unavailable");
        return Object.freeze({
          categoryReference: item.categoryReference,
          categoryCode: item.categoryCode,
          treatment: choice(item.treatment, ["Taxable", "Exempt", "ZeroRated"]),
          rate: item.rate,
          priceInclusion: choice(item.priceInclusion, ["Exclusive", "Inclusive"]),
          receiptCode: item.receiptCode,
        });
      }),
    ),
    receiptPreview: Object.freeze(
      raw.receiptPreview.map((candidate) => {
        const item = object(candidate, ["labelCode", "amountMinor"]);
        if (
          typeof item.labelCode !== "string" ||
          !code.test(item.labelCode) ||
          typeof item.amountMinor !== "string" ||
          !minor.test(item.amountMinor)
        )
          throw new TaxConfigClientError("Unavailable");
        return Object.freeze({ labelCode: item.labelCode, amountMinor: item.amountMinor });
      }),
    ),
  });
}

export const unavailableTaxConfigClient: TaxConfigClient = Object.freeze({
  async load() {
    throw new TaxConfigClientError("Unavailable");
  },
});
