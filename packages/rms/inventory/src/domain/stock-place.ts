import {
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";

/** WP-2423 / DEC-INV-LOCATIONS (Section 30.4): Store-scoped Stock Site and Storage Location. */
export type StockPlaceLifecycle = "Active" | "Inactive";
export type TemperatureZone = "Ambient" | "Chilled" | "Frozen";
export type LocalizedNames = Readonly<Record<string, string>>;
interface StockPlaceCommon {
  readonly schemaVersion: 1;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly storeReference: InventoryReference;
  readonly code: string;
  readonly isDefault: boolean;
  readonly localizedNames: LocalizedNames;
  readonly lifecycle: StockPlaceLifecycle;
  readonly aggregateVersion: number;
  readonly createdBy: InventoryReference;
  readonly createdAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
}
export interface StockSite extends StockPlaceCommon {
  readonly stockSiteReference: InventoryReference;
  readonly siteKind: "Store" | "Warehouse";
}
export interface StorageLocation extends StockPlaceCommon {
  readonly locationReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly temperatureZone: TemperatureZone;
  readonly sortOrder: number;
}
export class StockPlaceError extends Error {
  constructor(
    readonly code:
      | "STOCK_PLACE_INVALID"
      | "STOCK_PLACE_CONFLICT"
      | "STOCK_PLACE_NOT_FOUND"
      | "STOCK_PLACE_DEFAULT_REQUIRED"
      | "STOCK_PLACE_PERMISSION_DENIED"
      | "STOCK_PLACE_IDEMPOTENCY_CONFLICT"
      | "STOCK_PLACE_DEPENDENCY_UNAVAILABLE",
    options?: { readonly cause?: unknown },
  ) {
    // The cause is kept for server-side diagnosis only; callers expose the code, never the cause.
    super("Stock place operation failed", options);
    this.name = "StockPlaceError";
  }
}
const invalid = (): never => {
  throw new StockPlaceError("STOCK_PLACE_INVALID");
};
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
function names(value: unknown): LocalizedNames {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 8) return invalid();
  for (const [locale, name] of entries)
    if (
      !localePattern.test(locale) ||
      typeof name !== "string" ||
      name.trim() !== name ||
      name.length < 1 ||
      name.length > 80 ||
      /\p{Cc}/u.test(name)
    )
      return invalid();
  return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))));
}
function code(value: unknown) {
  return typeof value === "string" && codePattern.test(value) ? value : invalid();
}
function zone(value: unknown): TemperatureZone {
  return value === "Ambient" || value === "Chilled" || value === "Frozen" ? value : invalid();
}
function order(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 999
    ? Number(value)
    : invalid();
}

export type StockPlaceCommand =
  | {
      readonly kind: "StockSite";
      readonly action: "Create";
      readonly stockSiteReference: string;
      readonly payload: {
        readonly siteKind: "Store" | "Warehouse";
        readonly code: string;
        readonly isDefault: boolean;
        readonly localizedNames: LocalizedNames;
      };
    }
  | {
      readonly kind: "StorageLocation";
      readonly action: "Create";
      readonly locationReference: string;
      readonly payload: {
        readonly stockSiteReference: string;
        readonly code: string;
        readonly isDefault: boolean;
        readonly localizedNames: LocalizedNames;
        readonly temperatureZone: TemperatureZone;
        readonly sortOrder: number;
      };
    }
  | {
      readonly kind: "StockSite" | "StorageLocation";
      readonly action: "Update";
      readonly expectedVersion: number;
      readonly payload: {
        readonly localizedNames: LocalizedNames;
        readonly temperatureZone?: TemperatureZone;
        readonly sortOrder?: number;
      };
    }
  | {
      readonly kind: "StockSite" | "StorageLocation";
      readonly action: "Activate" | "Deactivate";
      readonly expectedVersion: number;
    };

/**
 * Pure candidate transition. Owner persistence still fences identity, version, default uniqueness,
 * remaining stock on deactivation and atomic Audit; this only validates the requested change.
 */
export function applyStockPlaceCommand<T extends StockSite | StorageLocation>(
  current: T | null,
  command: StockPlaceCommand,
  context: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
    occurredAt: string;
  }>,
): T {
  const actor = parseInventoryReference(context.actorReference);
  const at = parseInventoryInstant(context.occurredAt);
  const scope = {
    tenantReference: parseInventoryReference(context.tenantReference),
    brandReference: parseInventoryReference(context.brandReference),
    storeReference: parseInventoryReference(context.storeReference),
  };
  if (command.action === "Create") {
    if (current !== null) throw new StockPlaceError("STOCK_PLACE_CONFLICT");
    const common = {
      schemaVersion: 1 as const,
      ...scope,
      code: code(command.payload.code),
      isDefault: command.payload.isDefault === true,
      localizedNames: names(command.payload.localizedNames),
      lifecycle: "Active" as const,
      aggregateVersion: 1,
      createdBy: actor,
      createdAt: at,
      updatedBy: actor,
      updatedAt: at,
    };
    if (command.kind === "StockSite") {
      if (command.payload.siteKind !== "Store" && command.payload.siteKind !== "Warehouse")
        return invalid();
      return Object.freeze({
        ...common,
        stockSiteReference: parseInventoryReference(command.stockSiteReference),
        siteKind: command.payload.siteKind,
      }) as unknown as T;
    }
    return Object.freeze({
      ...common,
      locationReference: parseInventoryReference(command.locationReference),
      stockSiteReference: parseInventoryReference(command.payload.stockSiteReference),
      temperatureZone: zone(command.payload.temperatureZone),
      sortOrder: order(command.payload.sortOrder),
    }) as unknown as T;
  }
  if (current === null) throw new StockPlaceError("STOCK_PLACE_NOT_FOUND");
  if (
    current.tenantReference !== scope.tenantReference ||
    current.brandReference !== scope.brandReference ||
    current.storeReference !== scope.storeReference
  )
    throw new StockPlaceError("STOCK_PLACE_NOT_FOUND");
  if (command.expectedVersion !== current.aggregateVersion || at < current.updatedAt)
    throw new StockPlaceError("STOCK_PLACE_CONFLICT");
  const isLocation = "locationReference" in current;
  if ((command.kind === "StorageLocation") !== isLocation) return invalid();
  const advanced = {
    aggregateVersion: current.aggregateVersion + 1,
    updatedBy: actor,
    updatedAt: at,
  };
  if (command.action === "Update") {
    if (
      !isLocation &&
      (command.payload.temperatureZone !== undefined || command.payload.sortOrder !== undefined)
    )
      return invalid();
    return Object.freeze({
      ...current,
      ...advanced,
      localizedNames: names(command.payload.localizedNames),
      ...(isLocation
        ? {
            temperatureZone: zone(
              command.payload.temperatureZone ?? (current as StorageLocation).temperatureZone,
            ),
            sortOrder: order(command.payload.sortOrder ?? (current as StorageLocation).sortOrder),
          }
        : {}),
    }) as unknown as T;
  }
  const lifecycle = command.action === "Activate" ? "Active" : "Inactive";
  if (lifecycle === current.lifecycle) throw new StockPlaceError("STOCK_PLACE_CONFLICT");
  if (lifecycle === "Inactive" && current.isDefault)
    throw new StockPlaceError("STOCK_PLACE_DEFAULT_REQUIRED");
  return Object.freeze({ ...current, ...advanced, lifecycle }) as unknown as T;
}
