export type BundleClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class BundleClientError extends Error {
  constructor(readonly code: BundleClientErrorCode) {
    super("Bundle view is unavailable");
    this.name = "BundleClientError";
  }
}
export interface BundleListItemView {
  readonly bundleReference: string;
  readonly name: string;
  readonly internalCode: string;
  readonly lifecycle: "Draft" | "Published" | "Suspended" | "Discontinued" | "Archived";
  readonly priceMode: "Fixed" | "Computed";
  readonly componentCount: number;
  readonly choiceCount: number;
  readonly menuReferenceCount: number;
  readonly effectiveVersion: number;
}
export interface BundleListView {
  readonly screenId: "CAT-BUNDLE-LIST";
  readonly asOfUtc: string;
  readonly items: readonly BundleListItemView[];
}
export interface BundleEditorView {
  readonly screenId: "CAT-BUNDLE-EDITOR";
  readonly bundleReference: string;
  readonly name: string;
  readonly internalCode: string;
  readonly lifecycle: BundleListItemView["lifecycle"];
  readonly aggregateVersion: number;
  readonly priceSummary: string;
  readonly availabilitySummary: string;
  readonly historySummary: string;
  readonly componentGroups: readonly {
    readonly groupReference: string;
    readonly name: string;
    readonly bounds: string;
    readonly eligibleSellableCount: number;
    readonly upgradeRuleSummary: string;
  }[];
}
export interface BundleClient {
  listBundles(): Promise<BundleListView>;
  loadEditor(bundleReference: string): Promise<BundleEditorView>;
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new BundleClientError("Unavailable");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new BundleClientError("Unavailable");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new BundleClientError("Unavailable");
  return value.trim();
}
function integer(value: unknown, mustBePositive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (mustBePositive ? 1 : 0))
    throw new BundleClientError("Unavailable");
  return value as number;
}
function lifecycle(value: unknown): BundleListItemView["lifecycle"] {
  if (!["Draft", "Published", "Suspended", "Discontinued", "Archived"].includes(String(value)))
    throw new BundleClientError("Unavailable");
  return value as BundleListItemView["lifecycle"];
}
function priceMode(value: unknown): BundleListItemView["priceMode"] {
  if (value !== "Fixed" && value !== "Computed") throw new BundleClientError("Unavailable");
  return value;
}
export function parseBundleRouteReference(value: unknown): string {
  if (typeof value !== "string" || !reference.test(value)) throw new BundleClientError("NotFound");
  return value;
}
export function parseBundleListView(value: unknown): BundleListView {
  const view = record(value, ["screenId", "asOfUtc", "items"]);
  if (
    view.screenId !== "CAT-BUNDLE-LIST" ||
    typeof view.asOfUtc !== "string" ||
    !Array.isArray(view.items)
  )
    throw new BundleClientError("Unavailable");
  try {
    if (new Date(view.asOfUtc).toISOString() !== view.asOfUtc) throw new Error("instant");
  } catch {
    throw new BundleClientError("Unavailable");
  }
  return Object.freeze({
    screenId: "CAT-BUNDLE-LIST",
    asOfUtc: view.asOfUtc,
    items: Object.freeze(
      view.items.map((candidate) => {
        const item = record(candidate, [
          "bundleReference",
          "name",
          "internalCode",
          "lifecycle",
          "priceMode",
          "componentCount",
          "choiceCount",
          "menuReferenceCount",
          "effectiveVersion",
        ]);
        return Object.freeze({
          bundleReference: parseBundleRouteReference(item.bundleReference),
          name: text(item.name),
          internalCode: text(item.internalCode, 64),
          lifecycle: lifecycle(item.lifecycle),
          priceMode: priceMode(item.priceMode),
          componentCount: integer(item.componentCount),
          choiceCount: integer(item.choiceCount),
          menuReferenceCount: integer(item.menuReferenceCount),
          effectiveVersion: integer(item.effectiveVersion, true),
        });
      }),
    ),
  });
}
export function parseBundleEditorView(value: unknown): BundleEditorView {
  const view = record(value, [
    "screenId",
    "bundleReference",
    "name",
    "internalCode",
    "lifecycle",
    "aggregateVersion",
    "priceSummary",
    "availabilitySummary",
    "historySummary",
    "componentGroups",
  ]);
  if (view.screenId !== "CAT-BUNDLE-EDITOR" || !Array.isArray(view.componentGroups))
    throw new BundleClientError("Unavailable");
  return Object.freeze({
    screenId: "CAT-BUNDLE-EDITOR",
    bundleReference: parseBundleRouteReference(view.bundleReference),
    name: text(view.name),
    internalCode: text(view.internalCode, 64),
    lifecycle: lifecycle(view.lifecycle),
    aggregateVersion: integer(view.aggregateVersion, true),
    priceSummary: text(view.priceSummary),
    availabilitySummary: text(view.availabilitySummary),
    historySummary: text(view.historySummary),
    componentGroups: Object.freeze(
      view.componentGroups.map((candidate) => {
        const group = record(candidate, [
          "groupReference",
          "name",
          "bounds",
          "eligibleSellableCount",
          "upgradeRuleSummary",
        ]);
        return Object.freeze({
          groupReference: parseBundleRouteReference(group.groupReference),
          name: text(group.name),
          bounds: text(group.bounds),
          eligibleSellableCount: integer(group.eligibleSellableCount),
          upgradeRuleSummary: text(group.upgradeRuleSummary),
        });
      }),
    ),
  });
}
export const unavailableBundleClient: BundleClient = Object.freeze({
  async listBundles() {
    throw new BundleClientError("Unavailable");
  },
  async loadEditor() {
    throw new BundleClientError("Unavailable");
  },
});
