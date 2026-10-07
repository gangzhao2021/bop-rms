/** WP-2423 / DEC-INV-LOCATIONS: INV-LOCATION-LIST view contract and same-origin client. */
export type StockLocationErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "DefaultRequired"
  | "StockRemaining"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class StockLocationError extends Error {
  constructor(readonly code: StockLocationErrorCode) {
    super("Stock locations are unavailable");
    this.name = "StockLocationError";
  }
}
export type TemperatureZone = "Ambient" | "Chilled" | "Frozen";
export interface StockSiteView {
  readonly stockSiteReference: string;
  readonly code: string;
  readonly name: string;
  readonly siteKind: string;
  readonly isDefault: boolean;
  readonly lifecycle: string;
  readonly version: number;
}
export interface StockLocationView {
  readonly locationReference: string;
  readonly stockSiteReference: string;
  readonly code: string;
  readonly name: string;
  readonly temperatureZone: TemperatureZone;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly lifecycle: "Active" | "Inactive";
  readonly version: number;
  readonly holdsStock: boolean;
}
export interface StockLocationPageView {
  readonly screenId: "INV-LOCATION-LIST";
  readonly sourceAsOf: string;
  readonly mayManage: boolean;
  readonly needsSetup: boolean;
  readonly sites: readonly StockSiteView[];
  readonly locations: readonly StockLocationView[];
}
export type StockLocationCommand = Readonly<Record<string, unknown>> & {
  readonly operation:
    | "SetupDefaults"
    | "CreateLocation"
    | "UpdateLocation"
    | "ActivateLocation"
    | "DeactivateLocation"
    | "UpdateSite";
};
export interface StockLocationClient {
  load(): Promise<unknown>;
  command?(command: StockLocationCommand): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  code = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,80}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const invalid = (): never => {
  throw new Error("STOCK_LOCATION_PAGE_INVALID");
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
const flag = (value: unknown) => (typeof value === "boolean" ? value : invalid());
const count = (value: unknown, minimum: number) =>
  Number.isSafeInteger(value) && (value as number) >= minimum ? (value as number) : invalid();
export function parseStockLocationPageView(value: unknown): StockLocationPageView {
  const r = closed(value, [
    "screenId",
    "sourceAsOf",
    "mayManage",
    "needsSetup",
    "sites",
    "locations",
  ]);
  if (r.screenId !== "INV-LOCATION-LIST" || !Array.isArray(r.sites) || !Array.isArray(r.locations))
    invalid();
  return Object.freeze({
    screenId: "INV-LOCATION-LIST",
    sourceAsOf: text(r.sourceAsOf, instant),
    mayManage: flag(r.mayManage),
    needsSetup: flag(r.needsSetup),
    sites: Object.freeze(
      (r.sites as unknown[]).map((item) => {
        const s = closed(item, [
          "stockSiteReference",
          "code",
          "name",
          "siteKind",
          "isDefault",
          "lifecycle",
          "version",
        ]);
        return Object.freeze({
          stockSiteReference: text(s.stockSiteReference, uuid),
          code: text(s.code, code),
          name: text(s.name),
          siteKind: text(s.siteKind),
          isDefault: flag(s.isDefault),
          lifecycle: text(s.lifecycle),
          version: count(s.version, 1),
        });
      }),
    ),
    locations: Object.freeze(
      (r.locations as unknown[]).map((item) => {
        const l = closed(item, [
          "locationReference",
          "stockSiteReference",
          "code",
          "name",
          "temperatureZone",
          "sortOrder",
          "isDefault",
          "lifecycle",
          "version",
          "holdsStock",
        ]);
        if (!["Ambient", "Chilled", "Frozen"].includes(String(l.temperatureZone))) invalid();
        if (!["Active", "Inactive"].includes(String(l.lifecycle))) invalid();
        return Object.freeze({
          locationReference: text(l.locationReference, uuid),
          stockSiteReference: text(l.stockSiteReference, uuid),
          code: text(l.code, code),
          name: text(l.name),
          temperatureZone: l.temperatureZone as TemperatureZone,
          sortOrder: count(l.sortOrder, 0),
          isDefault: flag(l.isDefault),
          lifecycle: l.lifecycle as "Active" | "Inactive",
          version: count(l.version, 1),
          holdsStock: flag(l.holdsStock),
        });
      }),
    ),
  });
}
export const unavailableStockLocationClient: StockLocationClient = {
  load: async () => {
    throw new StockLocationError("Unavailable");
  },
};
const codes: Record<string, StockLocationErrorCode> = {
  PermissionDenied: "PermissionDenied",
  NotFound: "NotFound",
  Conflict: "Conflict",
  DefaultRequired: "DefaultRequired",
  StockRemaining: "StockRemaining",
  Invalid: "Invalid",
  Unavailable: "Unavailable",
};
export function createStockLocationClient(csrf: string, fetcher: typeof fetch = fetch) {
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
      throw new StockLocationError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new StockLocationError(
        codes[String(payload?.error)] ??
          (response.status === 403 ? "PermissionDenied" : "Unavailable"),
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: () => post("/merchant/supply/locations/query", {}),
    command: (command: StockLocationCommand) => post("/merchant/supply/locations/command", command),
  } satisfies StockLocationClient;
}
