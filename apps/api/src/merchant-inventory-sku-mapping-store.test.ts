import { describe, expect, it } from "vitest";
import { InventoryItemError, type InventorySkuMappingCommand } from "@rms/inventory";
import {
  createMerchantInventorySkuMappingStore as create,
  type MerchantInventorySkuMappingOptions,
} from "./merchant-inventory-sku-mapping-store.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const command: InventorySkuMappingCommand = {
  purpose: "InventorySkuMappingManagement",
  permission: "inventory.item.update",
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(4),
  occurredAt: "2026-09-29T00:00:00.000Z",
  mappingReference: id(5),
  itemReference: id(6),
  expectedMappingVersion: 0,
  expectedItemVersion: 1,
  configurationOperationReference: id(7),
  action: "Set",
  target: {
    productReference: id(8),
    productVersionReference: id(9),
    skuReference: id(10),
    catalogConfigurationDigest: "sha256:" + "a".repeat(64),
  },
  reasonCode: "LINK_FINISHED_GOOD",
};
const refusal = () => {
  throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
};
function options(
  transactions: MerchantInventorySkuMappingOptions["transactions"],
): MerchantInventorySkuMappingOptions {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => command.occurredAt },
    transactions,
    inventoryAuthority: { holdUntilTransactionCompletes: async () => refusal() },
    catalogAuthority: { holdUntilTransactionCompletes: async () => refusal() },
    audit: { create: () => refusal() },
  };
}
describe("Inventory SKU command public adapter boundary", () => {
  it("rejects uncalled runner success without accepting a fabricated result", async () => {
    const store = create(options({ run: async <T>() => ({ outcome: "Applied" }) as T }));
    await expect(store.execute(command)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("sanitizes runner failure without leaking driver detail", async () => {
    const store = create(
      options({
        run: async () => {
          throw new Error("SYNTHETIC_DRIVER_PRIVATE_DETAIL");
        },
      }),
    );
    await expect(store.execute(command)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
    });
    await expect(store.execute(command)).rejects.not.toThrow("SYNTHETIC_DRIVER_PRIVATE_DETAIL");
  });
  it("requires Inventory current authority before any SQL", async () => {
    let queries = 0;
    const store = create(
      options({
        run: (work) =>
          work({
            query: async () => {
              queries++;
              throw new Error("Unexpected SQL");
            },
          }),
      }),
    );
    await expect(store.execute(command)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_PERMISSION_DENIED",
    });
    expect(queries).toBe(0);
  });
  it("refuses actor scope substitution before authority or SQL", async () => {
    let queries = 0;
    const store = create(
      options({
        run: (work) =>
          work({
            query: async () => {
              queries++;
              throw new Error("Unexpected SQL");
            },
          }),
      }),
    );
    await expect(store.execute({ ...command, actorReference: id(99) })).rejects.toMatchObject({
      code: "INVENTORY_ITEM_PERMISSION_DENIED",
    });
    expect(queries).toBe(0);
  });
  it("refuses closed-command extras before opening a transaction", async () => {
    let calls = 0;
    const store = create(
      options({
        run: async () => {
          calls++;
          throw new Error("Unexpected runner");
        },
      }),
    );
    await expect(
      store.execute(Object.assign({}, command, { untrustedHeldSku: command.target })),
    ).rejects.toMatchObject({ code: "INVENTORY_ITEM_INVALID" });
    expect(calls).toBe(0);
  });
});
