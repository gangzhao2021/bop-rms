import { createHash } from "node:crypto";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  InventoryItemError,
  parseInventoryReference,
  type InventoryItemAggregate,
  type InventoryItemPermission,
  type InventoryItemTransaction,
} from "@rms/inventory";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423: Section 60.14 / 88 INV-ITEM-LIST, INV-ITEM-DETAIL, INV-ITEM-CREATE and INV-ITEM-EDIT for
 * the selected Store's Brand. Reads need inventory.item.read; every command is authorized by the
 * Inventory service for its exact permissions (unit and tracking changes need their own). Archive
 * is decided against the ledger's Brand-wide stock exposure, never a client claim.
 */
export class MerchantInventoryItemError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "Invalid"
      | "StockRemaining"
      | "Locked"
      | "Unavailable",
  ) {
    super(code);
    this.name = "MerchantInventoryItemError";
  }
}
const fail = (code: MerchantInventoryItemError["code"]): never => {
  throw new MerchantInventoryItemError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Standard Store units: display precision for staff, ledger precision for exact stock arithmetic. */
export const inventoryUnitPresets = Object.freeze([
  {
    unitCode: "KG",
    label: "Kilogram",
    dimension: "Mass",
    displayPrecision: 3,
    ledgerPrecision: 4,
    roundingMode: "HalfEven",
  },
  {
    unitCode: "G",
    label: "Gram",
    dimension: "Mass",
    displayPrecision: 0,
    ledgerPrecision: 2,
    roundingMode: "HalfEven",
  },
  {
    unitCode: "L",
    label: "Litre",
    dimension: "Volume",
    displayPrecision: 3,
    ledgerPrecision: 4,
    roundingMode: "HalfEven",
  },
  {
    unitCode: "ML",
    label: "Millilitre",
    dimension: "Volume",
    displayPrecision: 0,
    ledgerPrecision: 2,
    roundingMode: "HalfEven",
  },
  {
    unitCode: "EA",
    label: "Each",
    dimension: "Count",
    displayPrecision: 0,
    ledgerPrecision: 0,
    roundingMode: "HalfEven",
  },
  {
    unitCode: "PACK",
    label: "Pack",
    dimension: "Count",
    displayPrecision: 0,
    ledgerPrecision: 0,
    roundingMode: "HalfEven",
  },
] as const);
const unitByCode = new Map<string, (typeof inventoryUnitPresets)[number]>(
  inventoryUnitPresets.map((unit) => [unit.unitCode, unit]),
);
const actionPermissions = {
  mayCreate: "inventory.item.create",
  mayUpdate: "inventory.item.update",
  mayChangeUnit: "inventory.item.unit.manage",
  mayChangeTracking: "inventory.item.tracking.manage",
  mayActivate: "inventory.item.activate",
  mayDeactivate: "inventory.item.deactivate",
  mayArchive: "inventory.item.archive",
  mayRestore: "inventory.item.restore",
} as const satisfies Record<string, InventoryItemPermission>;

export interface InventoryItemCommandBody {
  readonly action: "Create" | "Update" | "Activate" | "Deactivate" | "Archive" | "Restore";
  readonly operationReference: string;
  readonly itemReference: string | null;
  readonly expectedVersion: number | null;
  readonly fields: {
    readonly internalCode?: string;
    readonly itemType?: string;
    readonly name: string;
    readonly unitCode: string;
    readonly stockTracked: boolean;
    readonly lotTracking: "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
    readonly shelfLifeDays: number | null;
    readonly expiryWarningDays: number | null;
    readonly negativeStockPolicy: "Block" | "ManagerOverride" | "AllowWithWarning";
  } | null;
  readonly reasonCode: string | null;
}
export function parseInventoryItemCommandBody(value: unknown): InventoryItemCommandBody {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !==
      "action,expectedVersion,fields,itemReference,operationReference,reasonCode"
  )
    return fail("Invalid");
  const action = ["Create", "Update", "Activate", "Deactivate", "Archive", "Restore"].find(
    (item) => item === r.action,
  ) as InventoryItemCommandBody["action"] | undefined;
  if (!action || typeof r.operationReference !== "string" || !uuid.test(r.operationReference))
    return fail("Invalid");
  const create = action === "Create";
  if (
    (create
      ? r.itemReference !== null || r.expectedVersion !== null
      : typeof r.itemReference !== "string" ||
        !uuid.test(r.itemReference) ||
        !Number.isSafeInteger(r.expectedVersion) ||
        (r.expectedVersion as number) < 1) ||
    (action === "Create" || action === "Update") !== (r.fields !== null) ||
    (["Activate", "Deactivate", "Archive", "Restore"].includes(action)
      ? typeof r.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(r.reasonCode)
      : r.reasonCode !== null)
  )
    return fail("Invalid");
  let fields: InventoryItemCommandBody["fields"] = null;
  if (r.fields !== null) {
    const f = r.fields as Record<string, unknown>;
    const keys = [
      "expiryWarningDays",
      "lotTracking",
      "name",
      "negativeStockPolicy",
      "shelfLifeDays",
      "stockTracked",
      "unitCode",
      ...(create ? ["internalCode", "itemType"] : []),
    ].sort();
    if (
      typeof f !== "object" ||
      Array.isArray(f) ||
      Object.keys(f).sort().join(",") !== keys.join(",") ||
      typeof f.name !== "string" ||
      typeof f.unitCode !== "string" ||
      !unitByCode.has(f.unitCode) ||
      typeof f.stockTracked !== "boolean" ||
      !["NoLot", "LotOptional", "LotRequired", "LotExpiryRequired"].includes(
        String(f.lotTracking),
      ) ||
      !["Block", "ManagerOverride", "AllowWithWarning"].includes(String(f.negativeStockPolicy)) ||
      (f.shelfLifeDays !== null && !Number.isSafeInteger(f.shelfLifeDays)) ||
      (f.expiryWarningDays !== null && !Number.isSafeInteger(f.expiryWarningDays)) ||
      (create &&
        (typeof f.internalCode !== "string" ||
          !["RawMaterial", "Packaging", "SemiFinished", "FinishedGood", "NonFoodSupply"].includes(
            String(f.itemType),
          )))
    )
      return fail("Invalid");
    fields = f as unknown as InventoryItemCommandBody["fields"];
  }
  return {
    action,
    operationReference: r.operationReference,
    itemReference: (r.itemReference as string | null) ?? null,
    expectedVersion: (r.expectedVersion as number | null) ?? null,
    fields,
    reasonCode: (r.reasonCode as string | null) ?? null,
  };
}

export function createMerchantInventoryItems(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  /** Locale used for the item name entered on Store screens. */
  locale: string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, "inventory.item.read", sessionReference);
    if (!(await scope.allowed())) fail("PermissionDenied");
    return scope;
  }
  const storeFor = (tx: Tx, scope: Awaited<ReturnType<typeof scopeFor>>) =>
    createPostgresInventoryItemStore(
      { run: (work) => work(tx as unknown as InventoryItemTransaction) },
      {
        tenantReference: scope.selected.tenantReference,
        brandReference: scope.context.brand.brandReference,
      },
    );
  const itemView = (item: InventoryItemAggregate) => ({
    itemReference: item.itemReference,
    internalCode: item.internalCode,
    itemType: item.itemType,
    name:
      item.localizedNames[options.locale] ??
      Object.values(item.localizedNames)[0] ??
      item.internalCode,
    lifecycle: item.lifecycle,
    unitCode: item.baseUnit.unitCode,
    stockTracked: item.trackingPolicy.stockTrackingEnabled,
    lotTracking: item.trackingPolicy.lotTrackingMode,
    shelfLifeDays: item.trackingPolicy.defaultShelfLifeDays,
    expiryWarningDays: item.trackingPolicy.expiryWarningDays,
    negativeStockPolicy: item.trackingPolicy.negativeStockPolicy,
    version: item.aggregateVersion,
    updatedAt: item.updatedAt,
  });
  async function permissions(scope: Awaited<ReturnType<typeof scopeFor>>) {
    const result: Record<string, boolean> = {};
    for (const [key, action] of Object.entries(actionPermissions))
      result[key] = (await scope.authorizeAction(action))?.effect === "Allow";
    return result as Record<keyof typeof actionPermissions, boolean>;
  }
  const mapError = (error: unknown): never => {
    if (error instanceof InventoryItemError)
      return fail(
        error.code === "INVENTORY_ITEM_PERMISSION_DENIED"
          ? "PermissionDenied"
          : error.code === "INVENTORY_ITEM_NOT_FOUND"
            ? "NotFound"
            : error.code === "INVENTORY_ITEM_INVALID"
              ? "Invalid"
              : error.code === "INVENTORY_ITEM_BASE_UNIT_LOCKED" ||
                  error.code === "INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED"
                ? "Locked"
                : error.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE"
                  ? "Unavailable"
                  : "Conflict",
      );
    throw error;
  };

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    itemReference: string | null;
    search: string | null;
    lifecycle: "Active" | "Inactive" | "Archived" | null;
    afterInternalCode: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const store = storeFor(tx, scope);
        const may = await permissions(scope);
        try {
          if (input.itemReference !== null) {
            const item = await store.load(parseInventoryReference(input.itemReference));
            if (item === null) return fail("NotFound");
            return {
              screenId: "INV-ITEM-DETAIL" as const,
              sourceAsOf: options.persistence.now(),
              permissions: may,
              units: inventoryUnitPresets,
              items: [itemView(item)],
              stockRemaining: await store.stockExposure(item.itemReference),
              hasMore: false,
            };
          }
          const page = await store.list({
            search: input.search,
            lifecycle: input.lifecycle,
            afterInternalCode: input.afterInternalCode,
            limit: 50,
          });
          return {
            screenId: "INV-ITEM-LIST" as const,
            sourceAsOf: options.persistence.now(),
            permissions: may,
            units: inventoryUnitPresets,
            items: page.items.map(itemView),
            stockRemaining: null,
            hasMore: page.hasMore,
          };
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseInventoryItemCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const store = storeFor(tx, scope);
        const tenantReference = scope.selected.tenantReference,
          brandReference = scope.context.brand.brandReference,
          actorReference = String(scope.actorReference);
        const fields = body.fields;
        const unit = fields === null ? null : unitByCode.get(fields.unitCode);
        const tracking =
          fields === null
            ? null
            : {
                stockTrackingEnabled: fields.stockTracked,
                lotTrackingMode: fields.stockTracked ? fields.lotTracking : "NoLot",
                defaultShelfLifeDays: fields.shelfLifeDays,
                expiryWarningDays: fields.expiryWarningDays,
                issuePolicy: fields.lotTracking === "LotExpiryRequired" ? "FEFO" : "FIFO",
                negativeStockPolicy: fields.negativeStockPolicy,
              };
        const baseUnit =
          unit === null || unit === undefined
            ? null
            : {
                unitCode: unit.unitCode,
                dimension: unit.dimension,
                displayPrecision: unit.displayPrecision,
                ledgerPrecision: unit.ledgerPrecision,
                roundingMode: unit.roundingMode,
              };
        let payload: Record<string, unknown>;
        switch (body.action) {
          case "Create":
            payload = {
              internalCode: fields?.internalCode,
              itemType: fields?.itemType,
              localizedNames: { [options.locale]: fields?.name },
              baseUnit,
              trackingPolicy: tracking,
            };
            break;
          case "Update": {
            const before = await store.load(parseInventoryReference(body.itemReference));
            if (before === null) return fail("NotFound");
            payload = {
              itemReference: body.itemReference,
              expectedVersion: body.expectedVersion,
              localizedNames: { ...before.localizedNames, [options.locale]: fields?.name },
              baseUnit,
              trackingPolicy: tracking,
              migrationPlanReference: null,
            };
            break;
          }
          case "Archive":
            if (await store.stockExposure(String(body.itemReference)))
              return fail("StockRemaining");
            payload = {
              itemReference: body.itemReference,
              expectedVersion: body.expectedVersion,
              reasonCode: body.reasonCode,
              // Open documents (receipts, counts, transfers) join this guard as those flows land.
              hasOpenWork: false,
              hasNonZeroStock: await store.stockExposure(String(body.itemReference)),
            };
            break;
          default:
            payload = {
              itemReference: body.itemReference,
              expectedVersion: body.expectedVersion,
              reasonCode: body.reasonCode,
            };
        }
        try {
          const record = await executeInventoryItemCommand(
            {
              tenantReference,
              brandReference,
              actorReference,
              purpose: "InventoryItemManagement",
              operationReference: body.operationReference,
              occurredAt: options.persistence.now(),
              action: body.action,
              payload,
            },
            {
              authorization: {
                authorize: async (request) =>
                  (await scope.authorizeAction(request.permission))?.effect === "Allow"
                    ? { authorized: true }
                    : null,
              },
              audit: {
                create: async ({ command, after }) => ({
                  auditId: options.references.next(),
                  brandId: command.brandReference,
                  actor: { type: "User", reference: command.actorReference },
                  actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
                  targetType: "InventoryItem",
                  targetId: after.itemReference,
                  reasonCode:
                    typeof command.payload.reasonCode === "string"
                      ? command.payload.reasonCode
                      : "INVENTORY_ITEM_MAINTENANCE",
                  correlationId: command.operationReference,
                  occurredAt: command.occurredAt,
                  sourceChannel: "MERCHANT_WEB",
                  dataClassification: "Internal",
                  retentionPolicyCode: "AUDIT_STANDARD",
                  retentionPolicyVersion: 1,
                }),
              },
              references: {
                generate: () => options.references.next(),
                hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
                equals: (left, right) => left === right,
              },
              // A stock account opened in the item's unit fixes that unit even before the first
              // movement marks the item, so administration locks it the same way.
              repository: {
                ...store,
                load: async (reference) => {
                  const item = await store.load(reference);
                  return item === null ||
                    item.hasMovementHistory ||
                    !(await store.stockAccountsOpened(reference))
                    ? item
                    : Object.freeze({ ...item, hasMovementHistory: true });
                },
              },
            },
          );
          return { item: itemView(record.item), outcome: record.outcome };
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };
  return { query, command };
}
