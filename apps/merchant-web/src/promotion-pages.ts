export type PromotionClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class PromotionClientError extends Error {
  constructor(readonly code: PromotionClientErrorCode) {
    super("Promotion view is unavailable");
    this.name = "PromotionClientError";
  }
}
export interface PromotionListItemView {
  readonly promotionReference: string;
  readonly name: string;
  readonly stableCode: string;
  readonly promotionType: string;
  readonly lifecycle: "Draft" | "Published" | "Paused" | "Archived";
  readonly scopeSummary: string;
  readonly eligibilitySummary: string;
  readonly benefitSummary: string;
  readonly budgetMinor: string;
  readonly usageMinor: string;
  readonly effectivePeriod: string;
  readonly scheduleStatus: "Active" | "Scheduled" | "Ended";
  readonly stacking: "Exclusive" | "SameGroupExclusive" | "Stackable";
  readonly conflictCount: number;
  readonly aggregateVersion: number;
}
export interface PromotionListView {
  readonly screenId: "PROMO-LIST";
  readonly asOfUtc: string;
  readonly items: readonly PromotionListItemView[];
}
export interface PromotionEditorView extends PromotionListItemView {
  readonly screenId: "PROMO-EDITOR";
  readonly audienceSummary: string;
  readonly eligibleItemsSummary: string;
  readonly limitsSummary: string;
  readonly priority: number;
  readonly scheduleSummary: string;
  readonly customerCopy: string;
  readonly impactSummary: string;
  readonly historySummary: string;
  readonly simulations: readonly {
    readonly basketCode: string;
    readonly subtotalMinor: string;
    readonly discountMinor: string;
    readonly totalMinor: string;
    readonly decisionSummary: string;
  }[];
}
export interface PromotionClient {
  list(): Promise<PromotionListView>;
  load(reference: string): Promise<PromotionEditorView>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const minor = /^(?:0|[1-9][0-9]{0,29})$/u;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new PromotionClientError("Unavailable");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new PromotionClientError("Unavailable");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 180) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new PromotionClientError("Unavailable");
  return value.trim();
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new PromotionClientError("Unavailable");
  return value as T;
}
function integer(value: unknown, positive = false) {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0))
    throw new PromotionClientError("Unavailable");
  return value as number;
}
function common(raw: Record<string, unknown>): PromotionListItemView {
  if (
    typeof raw.promotionReference !== "string" ||
    !uuid.test(raw.promotionReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    typeof raw.budgetMinor !== "string" ||
    !minor.test(raw.budgetMinor) ||
    typeof raw.usageMinor !== "string" ||
    !minor.test(raw.usageMinor)
  )
    throw new PromotionClientError("Unavailable");
  return Object.freeze({
    promotionReference: raw.promotionReference,
    name: text(raw.name, 120),
    stableCode: raw.stableCode,
    promotionType: text(raw.promotionType, 64),
    lifecycle: choice(raw.lifecycle, ["Draft", "Published", "Paused", "Archived"]),
    scopeSummary: text(raw.scopeSummary),
    eligibilitySummary: text(raw.eligibilitySummary),
    benefitSummary: text(raw.benefitSummary),
    budgetMinor: raw.budgetMinor,
    usageMinor: raw.usageMinor,
    effectivePeriod: text(raw.effectivePeriod),
    scheduleStatus: choice(raw.scheduleStatus, ["Active", "Scheduled", "Ended"]),
    stacking: choice(raw.stacking, ["Exclusive", "SameGroupExclusive", "Stackable"]),
    conflictCount: integer(raw.conflictCount),
    aggregateVersion: integer(raw.aggregateVersion, true),
  });
}
const commonKeys = [
  "promotionReference",
  "name",
  "stableCode",
  "promotionType",
  "lifecycle",
  "scopeSummary",
  "eligibilitySummary",
  "benefitSummary",
  "budgetMinor",
  "usageMinor",
  "effectivePeriod",
  "scheduleStatus",
  "stacking",
  "conflictCount",
  "aggregateVersion",
] as const;
export function parsePromotionRouteReference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new PromotionClientError("NotFound");
  return value;
}
export function parsePromotionListView(value: unknown): PromotionListView {
  const raw = object(value, ["screenId", "asOfUtc", "items"]);
  if (raw.screenId !== "PROMO-LIST" || typeof raw.asOfUtc !== "string" || !Array.isArray(raw.items))
    throw new PromotionClientError("Unavailable");
  try {
    if (new Date(raw.asOfUtc).toISOString() !== raw.asOfUtc) throw new Error("instant");
  } catch {
    throw new PromotionClientError("Unavailable");
  }
  return Object.freeze({
    screenId: "PROMO-LIST",
    asOfUtc: raw.asOfUtc,
    items: Object.freeze(raw.items.map((item) => common(object(item, commonKeys)))),
  });
}
export function parsePromotionEditorView(value: unknown): PromotionEditorView {
  const raw = object(value, [
    "screenId",
    ...commonKeys,
    "audienceSummary",
    "eligibleItemsSummary",
    "limitsSummary",
    "priority",
    "scheduleSummary",
    "customerCopy",
    "impactSummary",
    "historySummary",
    "simulations",
  ]);
  if (raw.screenId !== "PROMO-EDITOR" || !Array.isArray(raw.simulations))
    throw new PromotionClientError("Unavailable");
  return Object.freeze({
    ...common(raw),
    screenId: "PROMO-EDITOR",
    audienceSummary: text(raw.audienceSummary),
    eligibleItemsSummary: text(raw.eligibleItemsSummary),
    limitsSummary: text(raw.limitsSummary),
    priority: integer(raw.priority),
    scheduleSummary: text(raw.scheduleSummary),
    customerCopy: text(raw.customerCopy, 280),
    impactSummary: text(raw.impactSummary),
    historySummary: text(raw.historySummary),
    simulations: Object.freeze(
      raw.simulations.map((candidate) => {
        const item = object(candidate, [
          "basketCode",
          "subtotalMinor",
          "discountMinor",
          "totalMinor",
          "decisionSummary",
        ]);
        if (
          typeof item.basketCode !== "string" ||
          !code.test(item.basketCode) ||
          typeof item.subtotalMinor !== "string" ||
          !minor.test(item.subtotalMinor) ||
          typeof item.discountMinor !== "string" ||
          !minor.test(item.discountMinor) ||
          typeof item.totalMinor !== "string" ||
          !minor.test(item.totalMinor)
        )
          throw new PromotionClientError("Unavailable");
        return Object.freeze({
          basketCode: item.basketCode,
          subtotalMinor: item.subtotalMinor,
          discountMinor: item.discountMinor,
          totalMinor: item.totalMinor,
          decisionSummary: text(item.decisionSummary),
        });
      }),
    ),
  });
}
export const unavailablePromotionClient: PromotionClient = Object.freeze({
  async list() {
    throw new PromotionClientError("Unavailable");
  },
  async load() {
    throw new PromotionClientError("Unavailable");
  },
});
