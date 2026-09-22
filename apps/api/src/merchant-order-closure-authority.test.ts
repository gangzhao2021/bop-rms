import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
import { createMerchantOrderClosureAuthority } from "./merchant-order-closure-authority.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function setup() {
  const record = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    actorType: "User",
    status: "Closed",
    closureReference: id(5),
    operationReference: id(6),
    orderReference: id(7),
    closureVersion: 1,
    orderVersion: 3,
    previousClosureReference: null,
    financialFinalityReference: id(8),
    evidenceDigest: "sha256:" + "a".repeat(64),
    reasonCode: "ORDER_SETTLED",
    occurredAt: "2026-09-20T00:00:00.000Z",
  };
  const allowed = vi.fn(async () => true),
    current = {
      selected: { tenantReference: id(1) },
      context: { brand: { brandReference: id(2) } },
      store: { storeReference: id(3) },
      actorReference: id(4),
      allowed,
    };
  mock.resolve.mockResolvedValue(current);
  const tx = { query: vi.fn() },
    authorize = createMerchantOrderClosureAuthority(
      {} as PersistentMerchantBffOptions,
      "opaque-test-cookie",
    );
  return { record, current, allowed, run: (value: unknown = record) => authorize(tx, value), tx };
}
it("uses current order.close and exact acting employee scope", async () => {
  const f = setup();
  expect(await f.run()).toBe(true);
  expect(mock.resolve).toHaveBeenCalledWith(f.tx, "opaque-test-cookie", "order.close");
  expect(f.allowed).toHaveBeenCalledOnce();
});
it.each(["tenantReference", "brandReference", "storeReference", "actorReference"])(
  "rejects a foreign %s",
  async (field) => {
    const f = setup();
    expect(await f.run({ ...f.record, [field]: id(99) })).toBe(false);
    expect(f.allowed).not.toHaveBeenCalled();
  },
);
it("cannot use merchant authority for System close", async () => {
  const f = setup();
  expect(await f.run({ ...f.record, actorType: "System", actorReference: null })).toBe(false);
  expect(mock.resolve).not.toHaveBeenCalled();
});
it("does not authorize controlled reopen", async () => {
  const f = setup();
  expect(
    await f.run({
      ...f.record,
      status: "Open",
      closureVersion: 2,
      previousClosureReference: id(10),
      financialFinalityReference: null,
    }),
  ).toBe(false);
  expect(mock.resolve).not.toHaveBeenCalled();
});
it("requires current permission every time, including replay", async () => {
  const f = setup();
  expect(await f.run()).toBe(true);
  f.allowed.mockResolvedValue(false);
  expect(await f.run()).toBe(false);
  expect(mock.resolve).toHaveBeenCalledTimes(2);
});
it("session or membership failure denies without exposing details", async () => {
  const f = setup();
  mock.resolve.mockRejectedValue(new Error("session revoked"));
  expect(await f.run()).toBe(false);
});
it("malformed record cannot reach authorization lookup", async () => {
  const f = setup();
  expect(await f.run({})).toBe(false);
  expect(mock.resolve).not.toHaveBeenCalled();
});
