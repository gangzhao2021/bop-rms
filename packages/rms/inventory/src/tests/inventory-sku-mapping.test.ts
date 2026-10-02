import { describe, it, expect } from "vitest";
import {
  parseInventorySkuMappingCommand,
  parseInventorySkuMappingCurrentItem,
  parseInventorySkuMappingHeldSku,
  inventorySkuMappingIntentDigest,
  verifyInventorySkuMappingVersion,
  planInventorySkuMapping,
  recoverInventorySkuMapping,
  type InventorySkuMappingCommand,
  type InventorySkuMappingCurrentItem,
  type InventorySkuMappingHeldSku,
} from "../index.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function command(): InventorySkuMappingCommand {
  return {
    purpose: "InventorySkuMappingManagement",
    permission: "inventory.item.update",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    operationReference: id(4),
    occurredAt: at,
    mappingReference: id(5),
    itemReference: id(6),
    expectedMappingVersion: 0,
    expectedItemVersion: 2,
    configurationOperationReference: id(7),
    action: "Set",
    target: {
      productReference: id(8),
      productVersionReference: id(9),
      skuReference: id(10),
      catalogConfigurationDigest: digest,
    },
    reasonCode: "LINK_FINISHED_GOOD",
  };
}
function item(): InventorySkuMappingCurrentItem {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(6),
    itemType: "FinishedGood",
    lifecycle: "Inactive",
    itemVersion: 2,
    configurationOperationReference: id(7),
    recordedAt: at,
    coverage: "CurrentConfiguration",
    observedAt: at,
  };
}
function sku(c = command()): InventorySkuMappingHeldSku {
  if (!c.target) throw new Error("fixture target missing");
  return {
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    actorReference: c.actorReference,
    operationReference: c.operationReference,
    mappingIntentDigest: inventorySkuMappingIntentDigest(c),
    ...c.target,
    coverage: "HeldCurrentSku",
    observedAt: at,
  };
}
const invalid = expect.objectContaining({ code: "INVENTORY_ITEM_INVALID" }),
  unavailable = expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
  conflict = expect.objectContaining({ code: "INVENTORY_ITEM_CONFLICT" }),
  idempotency = expect.objectContaining({ code: "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT" });
describe("explicit Inventory-owned FinishedGood SKU mapping", () => {
  it.each(["0_REASON", "lower", ""])(
    "refuses reason %s incompatible with generic Audit controlled codes",
    (reasonCode) => {
      expect(() => parseInventorySkuMappingCommand({ ...command(), reasonCode })).toThrow(invalid);
    },
  );
  it("creates distinct stable mapping, Item and SKU identities with pinned operation/versions", () => {
    const c = command(),
      v = planInventorySkuMapping(c, null, item(), sku(c), at);
    expect(v.mappingVersion).toBe(1);
    expect(v.mappingReference).toBe(id(5));
    expect(v.itemReference).toBe(id(6));
    expect(v.target?.skuReference).toBe(id(10));
    expect(v.sourceItemVersion).toBe(2);
    expect(v.sourceConfigurationOperationReference).toBe(id(7));
    expect(v.mappingIntentDigest).toBe(inventorySkuMappingIntentDigest(c));
    expect(verifyInventorySkuMappingVersion(v)).toEqual(v);
    expect(Object.isFrozen(v.target)).toBe(true);
    expect(Object.isFrozen(v)).toBe(true);
  });
  it("records explicit Clear as a new immutable version without rewriting the prior link", () => {
    const first = planInventorySkuMapping(command(), null, item(), sku(), at),
      c = {
        ...command(),
        operationReference: id(11),
        expectedMappingVersion: 1,
        action: "Clear" as const,
        target: null,
        reasonCode: "UNLINK_FINISHED_GOOD",
      };
    const next = planInventorySkuMapping(c, first, item(), null, at);
    expect(next.mappingVersion).toBe(2);
    expect(next.mappingReference).toBe(first.mappingReference);
    expect(next.target).toBe(null);
    expect(first.target?.skuReference).toBe(id(10));
    expect(verifyInventorySkuMappingVersion(next)).toEqual(next);
  });
  it("recovers only the original intent after later facts/time have changed", () => {
    const c = command(),
      first = planInventorySkuMapping(c, null, item(), sku(c), at);
    expect(recoverInventorySkuMapping(c, first)).toEqual(first);
    expect(() => recoverInventorySkuMapping({ ...c, expectedMappingVersion: 1 }, first)).toThrow(
      idempotency,
    );
    expect(() => recoverInventorySkuMapping({ ...c, actorReference: id(90) }, first)).toThrow(
      idempotency,
    );
    expect(() => recoverInventorySkuMapping({ ...c, reasonCode: "CHANGED" }, first)).toThrow(
      idempotency,
    );
  });
  it("binds target, expected versions, scope, Actor, original operation and time into canonical intent", () => {
    const c = command();
    expect(inventorySkuMappingIntentDigest({ ...c, target: c.target })).toBe(
      inventorySkuMappingIntentDigest(c),
    );
    for (const change of [
      { tenantReference: id(90) },
      { brandReference: id(90) },
      { actorReference: id(90) },
      { operationReference: id(90) },
      { occurredAt: "2026-09-29T12:00:00.001Z" },
      { expectedItemVersion: 3 },
      { expectedMappingVersion: 1 },
      { configurationOperationReference: id(90) },
      { mappingReference: id(90) },
      { target: { ...c.target, skuReference: id(90) } },
    ])
      expect(inventorySkuMappingIntentDigest({ ...c, ...change })).not.toBe(
        inventorySkuMappingIntentDigest(c),
      );
  });
  it.each([
    "purpose",
    "permission",
    "setNull",
    "clearTarget",
    "unknownAction",
    "negativeMapping",
    "unsafeItem",
    "noninteger",
    "invalidUuid",
    "calendar",
    "invalidDigest",
    "reason",
    "extra",
    "targetExtra",
  ])("refuses malformed closed command %s", (kind) => {
    const c = command();
    if (kind === "purpose") Object.assign(c, { purpose: "StockManagement" });
    if (kind === "permission") Object.assign(c, { permission: "inventory.manage" });
    if (kind === "setNull") Object.assign(c, { target: null });
    if (kind === "clearTarget") Object.assign(c, { action: "Clear" });
    if (kind === "unknownAction") Object.assign(c, { action: "AutoInfer" });
    if (kind === "negativeMapping") Object.assign(c, { expectedMappingVersion: -1 });
    if (kind === "unsafeItem") Object.assign(c, { expectedItemVersion: 9007199254740992 });
    if (kind === "noninteger") Object.assign(c, { expectedItemVersion: 1.5 });
    if (kind === "invalidUuid") Object.assign(c, { itemReference: "unscoped" });
    if (kind === "calendar") Object.assign(c, { occurredAt: "2026-02-30T00:00:00.000Z" });
    if (kind === "invalidDigest")
      Object.assign(c.target ?? {}, { catalogConfigurationDigest: "sha256:invalid" });
    if (kind === "reason") Object.assign(c, { reasonCode: "Free text" });
    if (kind === "extra") Object.assign(c, { onHand: 1 });
    if (kind === "targetExtra") Object.assign(c.target ?? {}, { labels: [] });
    expect(() => parseInventorySkuMappingCommand(c)).toThrow(invalid);
  });
  it.each([
    "tenant",
    "brand",
    "item",
    "itemVersion",
    "configurationOperation",
    "type",
    "archived",
    "partial",
    "observedFuture",
    "stale",
    "recordedFuture",
  ])("refuses unfit current Item %s", (kind) => {
    const c = command(),
      i = item();
    const changes: Record<string, Record<string, unknown>> = {
      tenant: { tenantReference: id(90) },
      brand: { brandReference: id(90) },
      item: { itemReference: id(90) },
      itemVersion: { itemVersion: 3 },
      configurationOperation: { configurationOperationReference: id(90) },
      type: { itemType: "RawMaterial" },
      archived: { lifecycle: "Archived" },
      partial: { coverage: "Partial" },
      observedFuture: { observedAt: "2026-09-29T12:00:00.001Z" },
      stale: { observedAt: "2026-09-29T11:59:54.999Z" },
      recordedFuture: { recordedAt: "2026-09-29T12:00:00.001Z" },
    };
    const code =
      kind === "itemVersion" || kind === "configurationOperation"
        ? conflict
        : kind === "type" || kind === "archived" || kind === "partial"
          ? invalid
          : unavailable;
    expect(() => planInventorySkuMapping(c, null, { ...i, ...changes[kind] }, sku(c), at)).toThrow(
      code,
    );
  });
  it.each([
    "tenantReference",
    "brandReference",
    "actorReference",
    "operationReference",
    "productReference",
    "productVersionReference",
    "skuReference",
    "catalogConfigurationDigest",
    "mappingIntentDigest",
    "coverage",
    "observedAt",
  ])("refuses substituted held SKU %s", (key) => {
    const c = command(),
      s = sku(c),
      v = key.includes("Digest")
        ? "sha256:" + "b".repeat(64)
        : key === "coverage"
          ? "CallerAssertion"
          : key === "observedAt"
            ? "2026-09-29T11:59:54.999Z"
            : id(90);
    expect(() => planInventorySkuMapping(c, null, item(), { ...s, [key]: v }, at)).toThrow(
      key === "coverage" ? invalid : unavailable,
    );
  });
  it("refuses unexpected/missing SKU evidence and stale first-write command", () => {
    const c = command();
    expect(() => planInventorySkuMapping(c, null, item(), null, at)).toThrow(unavailable);
    expect(() =>
      planInventorySkuMapping({ ...c, action: "Clear", target: null }, null, item(), sku(c), at),
    ).toThrow(unavailable);
    expect(() =>
      planInventorySkuMapping(c, null, item(), sku(c), "2026-09-29T12:00:05.001Z"),
    ).toThrow(unavailable);
  });
  it("protects existing child identity/version/time and original stored intent", () => {
    const c = command(),
      before = planInventorySkuMapping(c, null, item(), sku(c), at),
      next = { ...c, operationReference: id(11), expectedMappingVersion: 1 };
    expect(() =>
      planInventorySkuMapping({ ...next, mappingReference: id(90) }, before, item(), sku(next), at),
    ).toThrow(conflict);
    expect(() =>
      planInventorySkuMapping(
        { ...next, expectedMappingVersion: 0 },
        before,
        item(),
        sku(next),
        at,
      ),
    ).toThrow(conflict);
    expect(() =>
      planInventorySkuMapping(
        { ...next, operationReference: c.operationReference },
        before,
        item(),
        sku(next),
        at,
      ),
    ).toThrow(idempotency);
    expect(() => verifyInventorySkuMappingVersion({ ...before, reasonCode: "ALTERED" })).toThrow(
      unavailable,
    );
    expect(() =>
      planInventorySkuMapping(next, { ...before, target: null }, item(), sku(next), at),
    ).toThrow(invalid);
  });
  it("rejects getters and coercion hooks without invoking them", () => {
    let calls = 0;
    const c = command();
    Object.defineProperty(c, "itemReference", {
      enumerable: true,
      get() {
        calls++;
        return id(6);
      },
    });
    expect(() => parseInventorySkuMappingCommand(c)).toThrow(invalid);
    const i = {
      ...item(),
      itemType: {
        toString() {
          calls++;
          return "FinishedGood";
        },
      },
    };
    expect(() => parseInventorySkuMappingCurrentItem(i)).toThrow(invalid);
    const s = sku();
    Object.defineProperty(s, "mappingIntentDigest", {
      enumerable: true,
      get() {
        calls++;
        return digest;
      },
    });
    expect(() => parseInventorySkuMappingHeldSku(s)).toThrow(invalid);
    expect(calls).toBe(0);
  });
});
