import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { createPostgresInventoryRecipeConfigurationSource } from "../infrastructure/persistence/recipe-configuration-coverage-source.js";
import type { InventoryItemTransaction } from "../infrastructure/persistence/inventory-item-store.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-28T00:00:00.000Z";
const request = () => ({
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
const coverage = () => ({
  family: "Inventory",
  ...scope,
  snapshotReference: id(4),
  digest: `sha256:${createHash("sha256")
    .update(canonicalizeRfc8785({ family: "Inventory", ...scope, dependencies: [] }))
    .digest("hex")}`,
  complete: true,
  dependencies: [],
});
function setup(allowed = true) {
  const query = vi.fn<InventoryItemTransaction["query"]>(async (sql) => ({
      rows: sql.startsWith("SELECT coverage_json")
        ? [{ coverage: coverage(), capturedAtUtc: at }]
        : [],
    })),
    authorize = vi.fn(async () => allowed),
    generateReference = vi.fn(() => id(5));
  const source = createPostgresInventoryRecipeConfigurationSource({
    scope,
    runner: { run: async (work) => work({ query }) },
    authorize,
    generateReference,
  });
  return { source, query, authorize, generateReference };
}
describe("Inventory-owned Recipe configuration coverage", () => {
  it("reuses immutable complete empty owner history with current statement snapshots", async () => {
    const { source, query, generateReference } = setup();
    const read = await source.capture(request());
    expect(read.coverage).toEqual(coverage());
    expect(Object.isFrozen(read.coverage.dependencies)).toBe(true);
    expect(query.mock.calls[0]?.[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(generateReference).not.toHaveBeenCalled();
  });
  it("denies authority before any private collection read or lock", async () => {
    const { source, query } = setup(false);
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_PERMISSION_DENIED",
    });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes("FROM rms_inventory") || sql.startsWith("LOCK") || sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  });
  it("rejects caller scope injection and hostile request getters before query", async () => {
    const { source, query } = setup();
    for (const value of [
      { ...request(), tenantReference: id(99) },
      { ...request(), actorReference: "bad" },
      { ...request(), observedAtUtc: "invalid" },
    ])
      await expect(source.capture(value)).rejects.toMatchObject({
        code: "INVENTORY_SOURCE_INPUT_INVALID",
      });
    const getter = vi.fn(() => {
        throw Error();
      }),
      input = request();
    Object.defineProperty(input, "purpose", { get: getter });
    await expect(source.capture(input)).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("holds actual configuration collections through callback and rechecks authority", async () => {
    const { source, query, authorize } = setup();
    const read = await source.capture(request());
    expect(
      await source.withCurrent(request(), read, async () => {
        expect(
          query.mock.calls.some(
            ([sql]) =>
              sql ===
              "LOCK TABLE rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation IN SHARE MODE",
          ),
        ).toBe(true);
        return "read";
      }),
    ).toBe("read");
    expect(authorize).toHaveBeenCalledTimes(4);
    authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(source.withCurrent(request(), read, async () => "private")).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_PERMISSION_DENIED",
    });
  });
  it("bounds callback errors and rejects foreign or forged seals", async () => {
    const { source, authorize } = setup();
    const read = await source.capture(request());
    await expect(
      source.withCurrent(request(), read, async () => {
        throw Error("synthetic detail");
      }),
    ).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_UNAVAILABLE",
      message: "Inventory configuration coverage is unavailable",
    });
    authorize.mockClear();
    await expect(
      source.withCurrent(
        request(),
        { ...read, coverage: { ...read.coverage, brandReference: id(99) } },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_SOURCE_INPUT_INVALID" });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("rejects excessive source versions without truncating", async () => {
    const { source, query, generateReference } = setup();
    query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM rms_inventory.inventory_item r")
        ? Array.from({ length: 2049 }, () => ({}))
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_UNAVAILABLE",
    });
    expect(generateReference).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("rejects row accessors and unavailable transaction isolation safely", async () => {
    const { source, query, authorize } = setup();
    query.mockRejectedValueOnce(Error("synthetic existing snapshot"));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_UNAVAILABLE",
    });
    expect(authorize).not.toHaveBeenCalled();
    const getter = vi.fn(() => {
        throw Error();
      }),
      values: unknown[] = [];
    Object.defineProperty(values, "0", { get: getter, enumerable: true });
    query.mockImplementation(async () => ({ rows: values }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "INVENTORY_SOURCE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
