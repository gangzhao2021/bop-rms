export type AvailabilityClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class AvailabilityClientError extends Error {
  constructor(readonly code: AvailabilityClientErrorCode) {
    super("Availability Workbench is unavailable");
    this.name = "AvailabilityClientError";
  }
}

export interface AvailabilityRuleView {
  readonly ruleReference: string;
  readonly itemName: string;
  readonly internalCode: string;
  readonly sellableType: "Product" | "Sku" | "Bundle";
  readonly lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
  readonly storeName: string;
  readonly channelSummary: string;
  readonly scheduleSummary: string;
  readonly source: "Manual" | "Stock" | "KillSwitch";
  readonly priority: number;
  readonly effectiveResult: "Available" | "Unavailable" | "Indeterminate";
  readonly reasonCode: string;
  readonly aggregateVersion: number;
}
export interface AvailabilityWorkbenchView {
  readonly screenId: "CAT-AVAILABILITY";
  readonly asOfUtc: string;
  readonly timeZone: string;
  readonly businessDate: string;
  readonly items: readonly AvailabilityRuleView[];
}
export interface AvailabilityClient {
  loadWorkbench(): Promise<AvailabilityWorkbenchView>;
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AvailabilityClientError("Unavailable");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new AvailabilityClientError("Unavailable");
  return value as Record<string, unknown>;
}
function safeText(value: unknown, maximum = 160): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new AvailabilityClientError("Unavailable");
  return value.trim();
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new AvailabilityClientError("Unavailable");
  return value as T;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new AvailabilityClientError("Unavailable");
  return value as number;
}
export function parseAvailabilityWorkbenchView(value: unknown): AvailabilityWorkbenchView {
  const view = record(value, ["screenId", "asOfUtc", "timeZone", "businessDate", "items"]);
  if (
    view.screenId !== "CAT-AVAILABILITY" ||
    !Array.isArray(view.items) ||
    typeof view.asOfUtc !== "string" ||
    typeof view.businessDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(view.businessDate)
  )
    throw new AvailabilityClientError("Unavailable");
  try {
    if (new Date(view.asOfUtc).toISOString() !== view.asOfUtc || typeof view.timeZone !== "string")
      throw new Error("invalid");
    new Intl.DateTimeFormat("en-CA", { timeZone: view.timeZone }).format(new Date(view.asOfUtc));
  } catch {
    throw new AvailabilityClientError("Unavailable");
  }
  return Object.freeze({
    screenId: "CAT-AVAILABILITY",
    asOfUtc: view.asOfUtc,
    timeZone: view.timeZone,
    businessDate: view.businessDate,
    items: Object.freeze(
      view.items.map((candidate) => {
        const item = record(candidate, [
          "ruleReference",
          "itemName",
          "internalCode",
          "sellableType",
          "lifecycle",
          "storeName",
          "channelSummary",
          "scheduleSummary",
          "source",
          "priority",
          "effectiveResult",
          "reasonCode",
          "aggregateVersion",
        ]);
        if (
          typeof item.ruleReference !== "string" ||
          !reference.test(item.ruleReference) ||
          typeof item.internalCode !== "string" ||
          !code.test(item.internalCode) ||
          typeof item.reasonCode !== "string" ||
          !code.test(item.reasonCode)
        )
          throw new AvailabilityClientError("Unavailable");
        return Object.freeze({
          ruleReference: item.ruleReference,
          itemName: safeText(item.itemName),
          internalCode: item.internalCode,
          sellableType: choice(item.sellableType, ["Product", "Sku", "Bundle"]),
          lifecycle: choice(item.lifecycle, ["Draft", "Active", "Inactive", "Archived"]),
          storeName: safeText(item.storeName),
          channelSummary: safeText(item.channelSummary),
          scheduleSummary: safeText(item.scheduleSummary),
          source: choice(item.source, ["Manual", "Stock", "KillSwitch"]),
          priority: positive(item.priority),
          effectiveResult: choice(item.effectiveResult, [
            "Available",
            "Unavailable",
            "Indeterminate",
          ]),
          reasonCode: item.reasonCode,
          aggregateVersion: positive(item.aggregateVersion),
        });
      }),
    ),
  });
}
export const unavailableAvailabilityClient: AvailabilityClient = Object.freeze({
  async loadWorkbench() {
    throw new AvailabilityClientError("Unavailable");
  },
});
