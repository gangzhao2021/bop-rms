import { Buffer } from "node:buffer";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";

/**
 * Test-only: creates and activates synthetic Inventory Items through the owner service and store
 * (authorization granted by the test). `tx(work)` runs work in one committed transaction.
 */
export function syntheticInventoryItems({ tx, scope, actor, next, clock }) {
  const itemStore = createPostgresInventoryItemStore(
    { run: tx },
    { tenantReference: scope.tenantReference, brandReference: scope.brandReference },
  );
  const command = (action, payload) =>
    executeInventoryItemCommand(
      {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        actorReference: actor,
        purpose: "InventoryItemManagement",
        operationReference: next(),
        occurredAt: clock(),
        action,
        payload,
      },
      {
        authorization: { authorize: async () => ({ authorized: true }) },
        audit: {
          create: async ({ command: c, after }) => ({
            auditId: next(),
            brandId: c.brandReference,
            actor: { type: "User", reference: c.actorReference },
            actionCode: "INVENTORY_ITEM_" + c.action.toUpperCase(),
            targetType: "InventoryItem",
            targetId: after.itemReference,
            reasonCode: "SYNTHETIC_CHANGE",
            correlationId: c.operationReference,
            occurredAt: c.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_STANDARD",
            retentionPolicyVersion: 1,
          }),
        },
        references: {
          generate: next,
          hashIntent: (value) =>
            "sha256:" + Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64),
          equals: (a, b) => a === b,
        },
        repository: itemStore,
      },
    );
  return {
    itemStore,
    async create(code, unit, lotTrackingMode, extra = {}) {
      const created = (
        await command("Create", {
          internalCode: code,
          itemType: "RawMaterial",
          localizedNames: { en: code },
          baseUnit: unit,
          trackingPolicy: {
            stockTrackingEnabled: true,
            lotTrackingMode,
            defaultShelfLifeDays: null,
            expiryWarningDays: null,
            issuePolicy: "FIFO",
            negativeStockPolicy: "Block",
            ...extra,
          },
        })
      ).item;
      await command("Activate", {
        itemReference: created.itemReference,
        expectedVersion: 1,
        reasonCode: "READY",
      });
      return created.itemReference;
    },
  };
}
export const litre = {
  unitCode: "L",
  dimension: "Volume",
  displayPrecision: 3,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
export const kilogram = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 3,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
export const expiryTracked = {
  defaultShelfLifeDays: 10,
  expiryWarningDays: 2,
  issuePolicy: "FEFO",
};
