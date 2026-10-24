import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantInventoryItems,
  parseInventoryItemCommandBody,
} from "./merchant-inventory-items.js";

const id = (n: number) => "01909a0e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const fields = {
  name: "Whole milk",
  unitCode: "L",
  stockTracked: true,
  lotTracking: "LotExpiryRequired",
  shelfLifeDays: 10,
  expiryWarningDays: 2,
  negativeStockPolicy: "Block",
};
const body = (overrides: Record<string, unknown> = {}) => ({
  action: "Create",
  operationReference: id(1),
  itemReference: null,
  expectedVersion: null,
  fields: { ...fields, internalCode: "MILK-WHOLE", itemType: "RawMaterial" },
  reasonCode: null,
  ...overrides,
});
describe("WP-2423 Inventory Item command body", () => {
  it("accepts create, update and lifecycle commands", () => {
    expect(parseInventoryItemCommandBody(body()).action).toBe("Create");
    expect(
      parseInventoryItemCommandBody(
        body({ action: "Update", itemReference: id(2), expectedVersion: 3, fields }),
      ).action,
    ).toBe("Update");
    expect(
      parseInventoryItemCommandBody(
        body({
          action: "Archive",
          itemReference: id(2),
          expectedVersion: 3,
          fields: null,
          reasonCode: "ITEM_DISCONTINUED",
        }),
      ).reasonCode,
    ).toBe("ITEM_DISCONTINUED");
  });
  it.each([
    [
      "an unknown unit",
      body({ fields: { ...fields, unitCode: "TON", internalCode: "X", itemType: "RawMaterial" } }),
    ],
    [
      "a client stock claim",
      body({
        action: "Archive",
        itemReference: id(2),
        expectedVersion: 1,
        fields: null,
        reasonCode: "ITEM_DISCONTINUED",
        hasNonZeroStock: false,
      }),
    ],
    [
      "identity on update",
      body({
        action: "Update",
        itemReference: id(2),
        expectedVersion: 1,
        fields: { ...fields, internalCode: "X", itemType: "RawMaterial" },
      }),
    ],
    [
      "fields on a lifecycle change",
      body({
        action: "Activate",
        itemReference: id(2),
        expectedVersion: 1,
        reasonCode: "READY",
        fields,
      }),
    ],
    [
      "a missing reason",
      body({ action: "Deactivate", itemReference: id(2), expectedVersion: 1, fields: null }),
    ],
    ["an item reference on create", body({ itemReference: id(2) })],
    ["reorder policy (not offered here)", body({ action: "SetReorderPolicy" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseInventoryItemCommandBody(value)).toThrow(/Invalid/u);
  });
});

const d = vi.hoisted(() => ({ resolve: vi.fn(), store: vi.fn(), execute: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => d.resolve }));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<object>()),
  createPostgresInventoryItemStore: d.store,
  executeInventoryItemCommand: d.execute,
}));
type Options = Parameters<typeof createMerchantInventoryItems>[0];
const item = {
  itemReference: id(2),
  internalCode: "MILK-WHOLE",
  itemType: "RawMaterial",
  localizedNames: { "en-CA": "Whole milk" },
  lifecycle: "Active",
  baseUnit: { unitCode: "L" },
  trackingPolicy: {
    stockTrackingEnabled: true,
    lotTrackingMode: "NoLot",
    defaultShelfLifeDays: null,
    expiryWarningDays: null,
    negativeStockPolicy: "Block",
  },
  aggregateVersion: 3,
  updatedAt: "2026-10-15T12:00:00.000Z",
  hasMovementHistory: false,
};
const allowAll = async (actions: readonly string[]) =>
  new Map(actions.map((action) => [action, { effect: "Allow" as "Allow" | "Deny" }]));
function setup() {
  const tx = { query: vi.fn() };
  const allowed = vi.fn(async () => true);
  const authorizeActions = vi.fn(allowAll);
  d.resolve.mockResolvedValue({
    selected: { tenantReference: id(7) },
    context: { brand: { brandReference: id(8) } },
    actorReference: id(9),
    allowed,
    authorizeActions,
  });
  d.store.mockReturnValue({
    load: vi.fn(async () => item),
    list: vi.fn(async () => ({ items: [item], hasMore: false })),
    stockExposure: vi.fn(async () => false),
    stockAccountsOpened: vi.fn(async () => false),
  });
  d.execute.mockImplementation(
    async (
      _command: unknown,
      ports: { authorization: { authorize(r: { permission: string }): Promise<unknown> } },
    ) => {
      if ((await ports.authorization.authorize({ permission: "inventory.item.update" })) === null)
        throw new Error("denied");
      if (
        (await ports.authorization.authorize({ permission: "inventory.item.unit.manage" })) === null
      )
        throw new Error("denied");
      return { item, outcome: "Applied" };
    },
  );
  const run = vi.fn(async (work: (t: object) => Promise<unknown>) => work(tx));
  const service = createMerchantInventoryItems({
    persistence: { transactions: { run }, now: () => "2026-10-15T12:00:00.000Z" },
    authentication: { authorize: async () => ({ sessionReference: id(6) }) },
    references: { next: () => id(5) },
    locale: "en-CA",
  } as unknown as Options);
  const input = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
  const query = {
    ...input,
    itemReference: null,
    search: null,
    lifecycle: null,
    afterInternalCode: null,
  };
  const update = {
    ...input,
    body: body({ action: "Update", itemReference: id(2), expectedVersion: 3, fields }),
  };
  return { tx, allowed, authorizeActions, service, query, update };
}
describe("WP-2423 Inventory Item authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("lists items with one start resolution (read and every item permission) and one recheck", async () => {
    const f = setup();
    const view = await f.service.query(f.query);
    expect(view.permissions.mayArchive).toBe(true);
    expect(f.authorizeActions).toHaveBeenCalledOnce();
    expect(f.authorizeActions.mock.calls[0]?.[0]).toHaveLength(9);
    expect(f.allowed).toHaveBeenCalledOnce();
    expect(d.resolve).toHaveBeenCalledOnce();
  });
  it("refuses a caller without inventory.item.read before reading items", async () => {
    const f = setup();
    f.authorizeActions.mockResolvedValue(new Map());
    await expect(f.service.query(f.query)).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(d.store).not.toHaveBeenCalled();
  });
  it("a permission withdrawn during the read refuses the reply", async () => {
    const f = setup();
    f.allowed.mockResolvedValue(false);
    await expect(f.service.query(f.query)).rejects.toMatchObject({ code: "PermissionDenied" });
  });
  it("commands use the start decisions (true during the run, refused after) and re-check the used permissions", async () => {
    const f = setup();
    await expect(f.service.command(f.update)).resolves.toMatchObject({ outcome: "Applied" });
    expect(f.authorizeActions).toHaveBeenCalledTimes(2);
    expect(f.authorizeActions.mock.calls[1]?.[0]).toEqual([
      "inventory.item.read",
      "inventory.item.update",
      "inventory.item.unit.manage",
    ]);
    expect(f.allowed).not.toHaveBeenCalled();
    const ports = d.execute.mock.calls[0]?.[1] as {
      authorization: { authorize(r: { permission: string }): Promise<unknown> };
    };
    expect(await ports.authorization.authorize({ permission: "inventory.item.update" })).toBe(null);
  });
  it("refuses a command whose permission was not allowed at the start", async () => {
    const f = setup();
    f.authorizeActions.mockImplementation(async (actions: readonly string[]) => {
      const decisions = await allowAll(actions);
      decisions.set("inventory.item.unit.manage", { effect: "Deny" });
      return decisions;
    });
    await expect(f.service.command(f.update)).rejects.toThrow("denied");
  });
  it("a permission withdrawn or Session ended during the command refuses it inside the transaction", async () => {
    const f = setup();
    f.authorizeActions.mockImplementationOnce(allowAll).mockResolvedValue(new Map());
    await expect(f.service.command(f.update)).rejects.toMatchObject({ code: "PermissionDenied" });
    expect(d.execute).toHaveBeenCalledOnce();
  });
});
