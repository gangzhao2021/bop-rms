import {
  applyStockPlaceCommand,
  createPostgresStockPlaceStore,
  StockPlaceError,
  type InventoryItemTransaction,
  type StockPlaceCommand,
  type StockSite,
  type StorageLocation,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-INV-LOCATIONS: INV-LOCATION-LIST for the selected Store. Reads need
 * inventory.location.read; changes need inventory.location.manage. A Store without stock places is
 * set up with its default Stock Site and default Storage Location in one transaction.
 */
export class MerchantStockPlaceError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "DefaultRequired"
      | "StockRemaining"
      | "Invalid"
      | "Unavailable",
  ) {
    super(code);
    this.name = "MerchantStockPlaceError";
  }
}
const fail = (code: MerchantStockPlaceError["code"]): never => {
  throw new MerchantStockPlaceError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 80
    ? value
    : fail("Invalid");
const zone = (value: unknown) =>
  value === "Ambient" || value === "Chilled" || value === "Frozen" ? value : fail("Invalid");
const version = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
const sortOrder = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 999
    ? (value as number)
    : fail("Invalid");
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{0,31}$/u.test(value) ? value : fail("Invalid");

export type StockPlaceCommandBody =
  | {
      readonly operation: "SetupDefaults";
      readonly siteOperationReference: string;
      readonly locationOperationReference: string;
      readonly siteName: string;
      readonly locationCode: string;
      readonly locationName: string;
      readonly temperatureZone: "Ambient" | "Chilled" | "Frozen";
    }
  | {
      readonly operation: "CreateLocation";
      readonly operationReference: string;
      readonly stockSiteReference: string;
      readonly code: string;
      readonly name: string;
      readonly temperatureZone: "Ambient" | "Chilled" | "Frozen";
      readonly sortOrder: number;
    }
  | {
      readonly operation: "UpdateLocation";
      readonly operationReference: string;
      readonly locationReference: string;
      readonly expectedVersion: number;
      readonly name: string;
      readonly temperatureZone: "Ambient" | "Chilled" | "Frozen";
      readonly sortOrder: number;
    }
  | {
      readonly operation: "ActivateLocation" | "DeactivateLocation";
      readonly operationReference: string;
      readonly locationReference: string;
      readonly expectedVersion: number;
    }
  | {
      readonly operation: "UpdateSite";
      readonly operationReference: string;
      readonly stockSiteReference: string;
      readonly expectedVersion: number;
      readonly name: string;
    };
export function parseStockPlaceCommandBody(value: unknown): StockPlaceCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  switch (r.operation) {
    case "SetupDefaults":
      if (
        keys !==
        "locationCode,locationName,locationOperationReference,operation,siteName,siteOperationReference,temperatureZone"
      )
        return fail("Invalid");
      if (r.siteOperationReference === r.locationOperationReference) return fail("Invalid");
      return {
        operation: "SetupDefaults",
        siteOperationReference: ref(r.siteOperationReference),
        locationOperationReference: ref(r.locationOperationReference),
        siteName: text(r.siteName),
        locationCode: code(r.locationCode),
        locationName: text(r.locationName),
        temperatureZone: zone(r.temperatureZone),
      };
    case "CreateLocation":
      if (
        keys !==
        "code,name,operation,operationReference,sortOrder,stockSiteReference,temperatureZone"
      )
        return fail("Invalid");
      return {
        operation: "CreateLocation",
        operationReference: ref(r.operationReference),
        stockSiteReference: ref(r.stockSiteReference),
        code: code(r.code),
        name: text(r.name),
        temperatureZone: zone(r.temperatureZone),
        sortOrder: sortOrder(r.sortOrder),
      };
    case "UpdateLocation":
      if (
        keys !==
        "expectedVersion,locationReference,name,operation,operationReference,sortOrder,temperatureZone"
      )
        return fail("Invalid");
      return {
        operation: "UpdateLocation",
        operationReference: ref(r.operationReference),
        locationReference: ref(r.locationReference),
        expectedVersion: version(r.expectedVersion),
        name: text(r.name),
        temperatureZone: zone(r.temperatureZone),
        sortOrder: sortOrder(r.sortOrder),
      };
    case "ActivateLocation":
    case "DeactivateLocation":
      if (keys !== "expectedVersion,locationReference,operation,operationReference")
        return fail("Invalid");
      return {
        operation: r.operation,
        operationReference: ref(r.operationReference),
        locationReference: ref(r.locationReference),
        expectedVersion: version(r.expectedVersion),
      };
    case "UpdateSite":
      if (keys !== "expectedVersion,name,operation,operationReference,stockSiteReference")
        return fail("Invalid");
      return {
        operation: "UpdateSite",
        operationReference: ref(r.operationReference),
        stockSiteReference: ref(r.stockSiteReference),
        expectedVersion: version(r.expectedVersion),
        name: text(r.name),
      };
    default:
      return fail("Invalid");
  }
}

export function createMerchantStockPlaces(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(
      tx,
      sessionCookie,
      "inventory.location.read",
      sessionReference,
    );
    if (!(await scope.allowed())) fail("PermissionDenied");
    return scope;
  }
  const storeFor = (tx: Tx, scope: Awaited<ReturnType<typeof scopeFor>>) =>
    createPostgresStockPlaceStore(
      { run: (work) => work(tx as unknown as InventoryItemTransaction) },
      {
        tenantReference: scope.selected.tenantReference,
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
      },
    );
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  const mapError = (error: unknown): never => {
    if (error instanceof StockPlaceError)
      return fail(
        error.code === "STOCK_PLACE_PERMISSION_DENIED"
          ? "PermissionDenied"
          : error.code === "STOCK_PLACE_NOT_FOUND"
            ? "NotFound"
            : error.code === "STOCK_PLACE_DEFAULT_REQUIRED"
              ? "DefaultRequired"
              : error.code === "STOCK_PLACE_INVALID"
                ? "Invalid"
                : error.code === "STOCK_PLACE_DEPENDENCY_UNAVAILABLE"
                  ? "Unavailable"
                  : "Conflict",
      );
    throw error;
  };

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const store = storeFor(tx, scope);
        const mayManage =
          (await scope.authorizeAction("inventory.location.manage"))?.effect === "Allow";
        try {
          const { sites, locations } = await store.list();
          const holding = new Set(await store.locationsHoldingStock());
          return {
            screenId: "INV-LOCATION-LIST" as const,
            sourceAsOf: options.persistence.now(),
            mayManage,
            needsSetup: sites.length === 0,
            sites: sites.map((site) => ({
              stockSiteReference: site.stockSiteReference,
              code: site.code,
              name: name(site.localizedNames, site.code),
              siteKind: site.siteKind,
              isDefault: site.isDefault,
              lifecycle: String(site.lifecycle),
              version: site.aggregateVersion,
            })),
            locations: locations.map((location) => ({
              locationReference: location.locationReference,
              stockSiteReference: location.stockSiteReference,
              code: location.code,
              name: name(location.localizedNames, location.code),
              temperatureZone: String(location.temperatureZone),
              sortOrder: location.sortOrder,
              isDefault: location.isDefault,
              lifecycle: String(location.lifecycle),
              version: location.aggregateVersion,
              holdsStock: holding.has(location.locationReference),
            })),
          };
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseStockPlaceCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if ((await scope.authorizeAction("inventory.location.manage"))?.effect !== "Allow")
          fail("PermissionDenied");
        const store = storeFor(tx, scope);
        const context = {
          tenantReference: scope.selected.tenantReference,
          brandReference: scope.context.brand.brandReference,
          storeReference: scope.store.storeReference,
          actorReference: String(scope.actorReference),
          occurredAt: options.persistence.now(),
        };
        const run = async (
          operationReference: string,
          command: StockPlaceCommand,
          currentPlace: StockSite | StorageLocation | null,
        ) => {
          const candidate = applyStockPlaceCommand(currentPlace, command, context);
          const target =
            "locationReference" in candidate
              ? candidate.locationReference
              : candidate.stockSiteReference;
          return store.commit({
            operationReference,
            command,
            candidate,
            audit: {
              auditId: options.references.next(),
              brandId: context.brandReference,
              storeId: context.storeReference,
              actor: { type: "User", reference: context.actorReference },
              actionCode:
                "INVENTORY_STOCK_PLACE_" +
                command.action.toUpperCase() +
                (command.kind === "StockSite" ? "_SITE" : "_LOCATION"),
              targetType: command.kind,
              targetId: target,
              reasonCode: "STORE_INVENTORY_SETUP",
              correlationId: operationReference,
              occurredAt: candidate.updatedAt,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Internal",
              retentionPolicyCode: "AUDIT_STANDARD",
              retentionPolicyVersion: 1,
            },
          });
        };
        const loaded = async (kind: "StockSite" | "StorageLocation", reference: string) =>
          (await store.load(kind, reference)) ?? fail("NotFound");
        try {
          switch (body.operation) {
            case "SetupDefaults": {
              // Setup runs once per Store; a Store with stock places is maintained place by place.
              if ((await store.list()).sites.length > 0) return fail("Conflict");
              const siteResult = await run(
                body.siteOperationReference,
                {
                  kind: "StockSite",
                  action: "Create",
                  stockSiteReference: options.references.next(),
                  payload: {
                    siteKind: "Store",
                    code: "STORE",
                    isDefault: true,
                    localizedNames: { [options.locale]: body.siteName },
                  },
                },
                null,
              );
              const siteReference = (siteResult.place as StockSite).stockSiteReference;
              const locationResult = await run(
                body.locationOperationReference,
                {
                  kind: "StorageLocation",
                  action: "Create",
                  locationReference: options.references.next(),
                  payload: {
                    stockSiteReference: siteReference,
                    code: body.locationCode,
                    isDefault: true,
                    localizedNames: { [options.locale]: body.locationName },
                    temperatureZone: body.temperatureZone,
                    sortOrder: 0,
                  },
                },
                null,
              );
              return { status: locationResult.status };
            }
            case "CreateLocation":
              return {
                status: (
                  await run(
                    body.operationReference,
                    {
                      kind: "StorageLocation",
                      action: "Create",
                      locationReference: options.references.next(),
                      payload: {
                        stockSiteReference: body.stockSiteReference,
                        code: body.code,
                        isDefault: false,
                        localizedNames: { [options.locale]: body.name },
                        temperatureZone: body.temperatureZone,
                        sortOrder: body.sortOrder,
                      },
                    },
                    null,
                  )
                ).status,
              };
            case "UpdateLocation": {
              const place = (await loaded(
                "StorageLocation",
                body.locationReference,
              )) as StorageLocation;
              return {
                status: (
                  await run(
                    body.operationReference,
                    {
                      kind: "StorageLocation",
                      action: "Update",
                      expectedVersion: body.expectedVersion,
                      payload: {
                        localizedNames: { ...place.localizedNames, [options.locale]: body.name },
                        temperatureZone: body.temperatureZone,
                        sortOrder: body.sortOrder,
                      },
                    },
                    place,
                  )
                ).status,
              };
            }
            case "ActivateLocation":
            case "DeactivateLocation": {
              const place = await loaded("StorageLocation", body.locationReference);
              if (
                body.operation === "DeactivateLocation" &&
                (await store.locationsHoldingStock()).includes(body.locationReference)
              )
                return fail("StockRemaining");
              return {
                status: (
                  await run(
                    body.operationReference,
                    {
                      kind: "StorageLocation",
                      action: body.operation === "ActivateLocation" ? "Activate" : "Deactivate",
                      expectedVersion: body.expectedVersion,
                    },
                    place,
                  )
                ).status,
              };
            }
            case "UpdateSite": {
              const place = await loaded("StockSite", body.stockSiteReference);
              return {
                status: (
                  await run(
                    body.operationReference,
                    {
                      kind: "StockSite",
                      action: "Update",
                      expectedVersion: body.expectedVersion,
                      payload: {
                        localizedNames: { ...place.localizedNames, [options.locale]: body.name },
                      },
                    },
                    place,
                  )
                ).status,
              };
            }
          }
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };
  return { query, command };
}
