import { describe, expect, it, vi } from "vitest";
import {
  createInventoryItem,
  executeInventoryItemCommand,
  parseInventoryReference,
  transitionInventoryItem,
  updateInventoryItem,
  type InventoryItemPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = `sha256:${"a".repeat(64)}`;
const baseUnit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
const trackingPolicy = {
  stockTrackingEnabled: true,
  lotTrackingMode: "LotExpiryRequired",
  defaultShelfLifeDays: 7,
  expiryWarningDays: 2,
  issuePolicy: "FEFO",
  negativeStockPolicy: "Block",
};

function aggregate() {
  return createInventoryItem({
    itemReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    internalCode: "ITEM_01",
    itemType: "RawMaterial",
    localizedNames: { "en-CA": "Synthetic ingredient" },
    baseUnit,
    trackingPolicy,
    occurredAt: "2026-09-21T10:00:00.000Z",
    actorReference: id(3),
  });
}

function command(action = "Create", payload: Record<string, unknown> = {}) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "InventoryItemManagement",
    operationReference: id(4),
    occurredAt: "2026-09-21T10:00:00.000Z",
    action,
    payload:
      action === "Create"
        ? {
            internalCode: "ITEM_01",
            itemType: "RawMaterial",
            localizedNames: { "en-CA": "Synthetic ingredient" },
            baseUnit,
            trackingPolicy,
            ...payload,
          }
        : payload,
  };
}

function ports(): InventoryItemPorts & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorization: {
      authorize: vi.fn(async () => {
        calls.push("authorize");
        return { authorized: true as const };
      }),
    },
    audit: { create: vi.fn(async () => ({ audit: "synthetic" }) as never) },
    references: {
      generate: vi.fn((purpose) => (purpose === "InventoryItem" ? id(10) : id(11))),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
    repository: {
      resolveOperation: vi.fn(async () => {
        calls.push("resolve");
        return null;
      }),
      load: vi.fn(async () => aggregate()),
      internalCodeExists: vi.fn(async () => false),
      commit: vi.fn(async (record) => record),
    },
  };
}

describe("Inventory Item aggregate and service", () => {
  it("creates separate Inventory identity with exact decimal-safe unit policy", () => {
    expect(aggregate()).toMatchObject({
      internalCode: "ITEM_01",
      lifecycle: "Inactive",
      baseUnit: { unitCode: "KG", ledgerPrecision: 4 },
      trackingPolicy: { issuePolicy: "FEFO" },
    });
  });

  it("authorizes before reads and creates idempotently without quantity fields", async () => {
    const adapter = ports();
    const result = await executeInventoryItemCommand(command(), adapter);
    expect(adapter.calls.slice(0, 2)).toEqual(["authorize", "resolve"]);
    expect(result.item.itemReference).toBe(id(10));
    await expect(
      executeInventoryItemCommand(command("Create", { onHand: "10.000" }), adapter),
    ).rejects.toMatchObject({ code: "INVENTORY_ITEM_INVALID" });
    await expect(
      executeInventoryItemCommand(
        command("Create", { baseUnit: { ...baseUnit, unexpected: true } }),
        adapter,
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_ITEM_INVALID" });
  });

  it("fails closed before repository reads when permission is absent", async () => {
    const adapter = ports();
    adapter.authorization.authorize = vi.fn(async () => null);
    await expect(executeInventoryItemCommand(command(), adapter)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_PERMISSION_DENIED",
    });
    expect(adapter.repository.resolveOperation).not.toHaveBeenCalled();
  });

  it("locks the base unit after a Movement exists", () => {
    const item = { ...aggregate(), hasMovementHistory: true };
    expect(() =>
      updateInventoryItem(item, {
        expectedVersion: 1,
        localizedNames: item.localizedNames,
        baseUnit: { ...baseUnit, unitCode: "G" },
        trackingPolicy,
        migrationPlanReference: null,
        occurredAt: "2026-09-21T11:00:00.000Z",
        actorReference: id(3),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_ITEM_BASE_UNIT_LOCKED" }));
  });

  it("requires a migration plan for tracking changes after Movement history", () => {
    const item = { ...aggregate(), hasMovementHistory: true };
    expect(() =>
      updateInventoryItem(item, {
        expectedVersion: 1,
        localizedNames: item.localizedNames,
        baseUnit,
        trackingPolicy: { ...trackingPolicy, negativeStockPolicy: "ManagerOverride" },
        migrationPlanReference: null,
        occurredAt: "2026-09-21T11:00:00.000Z",
        actorReference: id(3),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED" }));
  });

  it("blocks archive with stock/open work and restores only to Inactive", () => {
    expect(() =>
      transitionInventoryItem(aggregate(), "Archived", {
        expectedVersion: 1,
        hasOpenWork: false,
        hasNonZeroStock: true,
        occurredAt: "2026-09-21T11:00:00.000Z",
        actorReference: id(3),
      }),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_ITEM_ARCHIVE_BLOCKED" }));
    const archived = transitionInventoryItem(aggregate(), "Archived", {
      expectedVersion: 1,
      hasOpenWork: false,
      hasNonZeroStock: false,
      occurredAt: "2026-09-21T11:00:00.000Z",
      actorReference: id(3),
    });
    expect(
      transitionInventoryItem(archived, "Inactive", {
        expectedVersion: 2,
        hasOpenWork: false,
        hasNonZeroStock: false,
        occurredAt: "2026-09-21T12:00:00.000Z",
        actorReference: id(3),
      }).lifecycle,
    ).toBe("Inactive");
  });
});

describe("WP-2423 Inventory Item fine-grained permissions", () => {
  const permissions = (adapter: ReturnType<typeof ports>) =>
    (adapter.authorization.authorize as ReturnType<typeof vi.fn>).mock.calls.map(
      ([request]) => (request as { permission: string }).permission,
    );
  const update = (patch: Record<string, unknown>) =>
    command("Update", {
      itemReference: id(10),
      expectedVersion: 1,
      localizedNames: { "en-CA": "Renamed ingredient" },
      baseUnit,
      trackingPolicy,
      migrationPlanReference: null,
      ...patch,
    });
  it("asks only for the update permission when names change", async () => {
    const adapter = ports();
    await executeInventoryItemCommand(update({}), adapter);
    expect(permissions(adapter)).toEqual(["inventory.item.update"]);
  });
  it("also asks for unit and tracking permissions when those change", async () => {
    const adapter = ports();
    await executeInventoryItemCommand(
      update({
        baseUnit: { ...baseUnit, unitCode: "G", displayPrecision: 0, ledgerPrecision: 2 },
        trackingPolicy: { ...trackingPolicy, negativeStockPolicy: "ManagerOverride" },
      }),
      adapter,
    );
    expect(permissions(adapter)).toEqual([
      "inventory.item.update",
      "inventory.item.unit.manage",
      "inventory.item.tracking.manage",
    ]);
  });
  it("refuses a unit change without the unit permission and writes nothing", async () => {
    const adapter = ports();
    (adapter.authorization.authorize as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: { permission: string }) =>
        request.permission === "inventory.item.unit.manage" ? null : { authorized: true },
    );
    await expect(
      executeInventoryItemCommand(
        update({
          baseUnit: { ...baseUnit, unitCode: "G", displayPrecision: 0, ledgerPrecision: 2 },
        }),
        adapter,
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_ITEM_PERMISSION_DENIED" });
    expect(adapter.repository.commit).not.toHaveBeenCalled();
  });
  it.each([
    ["Create", "inventory.item.create"],
    ["Activate", "inventory.item.activate"],
    ["Deactivate", "inventory.item.deactivate"],
    ["Restore", "inventory.item.restore"],
  ])("maps %s to %s", async (action, permission) => {
    const adapter = ports();
    await executeInventoryItemCommand(
      command(
        action,
        action === "Create"
          ? {}
          : { itemReference: id(10), expectedVersion: 1, reasonCode: "SYNTHETIC" },
      ),
      adapter,
    ).catch(() => undefined);
    expect(permissions(adapter)[0]).toBe(permission);
  });
});
