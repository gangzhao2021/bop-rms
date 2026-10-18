/** WP-2423: INV-ITEM-LIST / DETAIL / CREATE / EDIT view contract and same-origin client. */
export type SupplyItemErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "StockRemaining"
  | "Locked"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class SupplyItemError extends Error {
  constructor(readonly code: SupplyItemErrorCode) {
    super("Inventory items are unavailable");
    this.name = "SupplyItemError";
  }
}
export type LotTracking = "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
export type NegativeStockPolicy = "Block" | "ManagerOverride" | "AllowWithWarning";
export interface SupplyItemView {
  readonly itemReference: string;
  readonly internalCode: string;
  readonly itemType: string;
  readonly name: string;
  readonly lifecycle: "Active" | "Inactive" | "Archived";
  readonly unitCode: string;
  readonly stockTracked: boolean;
  readonly lotTracking: LotTracking;
  readonly shelfLifeDays: number | null;
  readonly expiryWarningDays: number | null;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly version: number;
  readonly updatedAt: string;
}
export interface SupplyUnitView {
  readonly unitCode: string;
  readonly label: string;
  readonly dimension: string;
}
export interface SupplyItemPageView {
  readonly screenId: "INV-ITEM-LIST" | "INV-ITEM-DETAIL";
  readonly sourceAsOf: string;
  readonly permissions: Readonly<
    Record<
      | "mayCreate"
      | "mayUpdate"
      | "mayChangeUnit"
      | "mayChangeTracking"
      | "mayActivate"
      | "mayDeactivate"
      | "mayArchive"
      | "mayRestore",
      boolean
    >
  >;
  readonly units: readonly SupplyUnitView[];
  readonly items: readonly SupplyItemView[];
  readonly stockRemaining: boolean | null;
  readonly hasMore: boolean;
}
export interface SupplyItemFields {
  readonly internalCode?: string;
  readonly itemType?: string;
  readonly name: string;
  readonly unitCode: string;
  readonly stockTracked: boolean;
  readonly lotTracking: LotTracking;
  readonly shelfLifeDays: number | null;
  readonly expiryWarningDays: number | null;
  readonly negativeStockPolicy: NegativeStockPolicy;
}
export interface SupplyItemCommand {
  readonly action: "Create" | "Update" | "Activate" | "Deactivate" | "Archive" | "Restore";
  readonly operationReference: string;
  readonly itemReference: string | null;
  readonly expectedVersion: number | null;
  readonly fields: SupplyItemFields | null;
  readonly reasonCode: string | null;
}
export interface SupplyItemQuery {
  readonly itemReference: string | null;
  readonly search: string | null;
  readonly lifecycle: "Active" | "Inactive" | "Archived" | null;
  readonly afterInternalCode: string | null;
}
export interface SupplyItemClient {
  load(query: SupplyItemQuery): Promise<unknown>;
  command?(command: SupplyItemCommand): Promise<{ readonly item: unknown }>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  code = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,120}$/u;
const invalid = (): never => {
  throw new Error("SUPPLY_ITEM_PAGE_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, pattern = safe) =>
  typeof value === "string" && pattern.test(value) ? value : invalid();
const days = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
    ? (value as number | null)
    : invalid();
function item(value: unknown): SupplyItemView {
  const r = closed(value, [
    "itemReference",
    "internalCode",
    "itemType",
    "name",
    "lifecycle",
    "unitCode",
    "stockTracked",
    "lotTracking",
    "shelfLifeDays",
    "expiryWarningDays",
    "negativeStockPolicy",
    "version",
    "updatedAt",
  ]);
  if (
    !["Active", "Inactive", "Archived"].includes(String(r.lifecycle)) ||
    typeof r.stockTracked !== "boolean" ||
    !["NoLot", "LotOptional", "LotRequired", "LotExpiryRequired"].includes(String(r.lotTracking)) ||
    !["Block", "ManagerOverride", "AllowWithWarning"].includes(String(r.negativeStockPolicy)) ||
    !Number.isSafeInteger(r.version) ||
    (r.version as number) < 1
  )
    return invalid();
  return Object.freeze({
    itemReference: text(r.itemReference, uuid),
    internalCode: text(r.internalCode, code),
    itemType: text(r.itemType),
    name: text(r.name),
    lifecycle: r.lifecycle as SupplyItemView["lifecycle"],
    unitCode: text(r.unitCode, code),
    stockTracked: r.stockTracked,
    lotTracking: r.lotTracking as LotTracking,
    shelfLifeDays: days(r.shelfLifeDays),
    expiryWarningDays: days(r.expiryWarningDays),
    negativeStockPolicy: r.negativeStockPolicy as NegativeStockPolicy,
    version: r.version as number,
    updatedAt: text(r.updatedAt, instant),
  });
}
export function parseSupplyItemPageView(
  value: unknown,
  screenId: SupplyItemPageView["screenId"],
): SupplyItemPageView {
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "permissions",
    "units",
    "items",
    "stockRemaining",
    "hasMore",
  ]);
  if (r.screenId !== screenId || typeof r.hasMore !== "boolean") invalid();
  const permissions = closed(r.permissions, [
    "mayCreate",
    "mayUpdate",
    "mayChangeUnit",
    "mayChangeTracking",
    "mayActivate",
    "mayDeactivate",
    "mayArchive",
    "mayRestore",
  ]);
  if (Object.values(permissions).some((flag) => typeof flag !== "boolean")) invalid();
  if (!Array.isArray(r.units) || !Array.isArray(r.items)) invalid();
  const items = Object.freeze((r.items as unknown[]).map(item));
  if (screenId === "INV-ITEM-DETAIL" && items.length !== 1) invalid();
  if (r.stockRemaining !== null && typeof r.stockRemaining !== "boolean") invalid();
  return Object.freeze({
    screenId,
    sourceAsOf: text(r.sourceAsOf, instant),
    permissions: Object.freeze(permissions) as SupplyItemPageView["permissions"],
    units: Object.freeze(
      (r.units as unknown[]).map((unit) => {
        const u = closed(unit, [
          "unitCode",
          "label",
          "dimension",
          "displayPrecision",
          "ledgerPrecision",
          "roundingMode",
        ]);
        return Object.freeze({
          unitCode: text(u.unitCode, code),
          label: text(u.label),
          dimension: text(u.dimension),
        });
      }),
    ),
    items,
    stockRemaining: r.stockRemaining as boolean | null,
    hasMore: r.hasMore as boolean,
  });
}
export function parseSupplyItemRouteReference(value: unknown): string {
  return text(value, uuid);
}
export const unavailableSupplyItemClient: SupplyItemClient = {
  load: async () => {
    throw new SupplyItemError("Unavailable");
  },
};
const errorCodes: Record<string, SupplyItemErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  StockRemaining: "StockRemaining",
  Locked: "Locked",
  Invalid: "Invalid",
  Unavailable: "Unavailable",
};
export function createSupplyItemClient(csrf: string, fetcher: typeof fetch = fetch) {
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
      throw new SupplyItemError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new SupplyItemError(
        errorCodes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (query: SupplyItemQuery) => post("/merchant/supply/items/query", query),
    command: async (command: SupplyItemCommand) =>
      (await post("/merchant/supply/items/command", command)) as { readonly item: unknown },
  } satisfies SupplyItemClient;
}
