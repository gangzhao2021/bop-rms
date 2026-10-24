import { CartError } from "../domain/cart.js";
import { beforeEach, expect, it, vi } from "vitest";
import { appendAuditRecordInTransaction } from "@bop/audit";
import { createPostgresDiningCartReplacementStore } from "../infrastructure/persistence/dining-cart-replacement-store.js";
import type { CartQueryTransaction } from "../infrastructure/persistence/cart-query-store.js";
import { expireCartLifecycle } from "../domain/cart-lifecycle.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(async () => undefined),
}));
const id = (n: number) => "0190ed98-0000-7000-8000-" + n.toString(16).padStart(12, "0");
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const original = orderWriteFixture({ at: "2026-09-13T12:00:00.000Z", dineIn: true }).cart;
  if (!original.lifecycle) throw new Error("lifecycle");
  const at = original.lifecycle.absoluteExpiresAt;
  const cart = {
    ...original,
    aggregateVersion: original.aggregateVersion + 1,
    updatedAt: at,
    lifecycle: expireCartLifecycle(original.lifecycle, at),
  };
  const scope = { brandReference: cart.brandReference, storeReference: cart.storeReference };
  const command = {
    ...scope,
    operationReference: id(1),
    diningSessionReference: cart.diningSessionReference,
    guestSessionReference: id(2),
    participantReference: id(3),
    previousCartReference: cart.cartReference,
    expectedCartVersion: cart.aggregateVersion,
    observedAt: at,
  };
  let receipt: unknown = null,
    committed = 0,
    rolledBack = 0;
  const query = vi.fn<CartQueryTransaction["query"]>(async (sql, values) => {
    if (sql.startsWith("SELECT set_config") || sql.includes("pg_advisory")) return { rows: [] };
    if (sql.includes('intent_digest AS "intentDigest"')) return { rows: receipt ? [receipt] : [] };
    if (sql.includes('aggregate_version AS "cartVersion"'))
      return { rows: [{ cartReference: cart.cartReference, cartVersion: cart.aggregateVersion }] };
    if (sql.includes("AS cart")) return { rows: [{ cart }] };
    if (sql.startsWith("INSERT INTO rms_ordering.cart")) return { rows: [{ cart_id: id(4) }] };
    if (sql.startsWith("INSERT INTO rms_ordering.dining_cart_replacement")) {
      receipt = {
        intentDigest: values[9],
        cartReference: values[5],
        occurredAt: values[10],
        expiresAt: values[11],
      };
      return { rows: [{ operation_id: id(1) }] };
    }
    throw new Error("unexpected SQL");
  });
  const authorize = vi.fn(async () => true),
    clear = vi.fn(async () => true),
    now = vi.fn(() => at as string);
  const store = createPostgresDiningCartReplacementStore(
    {
      run: async (action) => {
        const before = receipt;
        try {
          const result = await action({ query });
          committed++;
          return result;
        } catch (error) {
          receipt = before;
          rolledBack++;
          throw error;
        }
      },
    },
    {
      scope,
      policy: {
        policyVersionReference: id(5),
        policyDigest: "sha256:" + "a".repeat(64),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: at,
        validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
      },
      generateReference: () => id(4),
      now,
      authorizeAndFence: authorize,
      settlementClear: clear,
      audit: (input) => ({
        auditId: id(6),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDERING_DINING_CART_REPLACE",
        targetType: "OrderingCart",
        targetId: input.cartReference,
        reasonCode: "AUTHORIZED_CART_REPLACEMENT",
        correlationId: input.operationReference,
        occurredAt: input.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  );
  return {
    store,
    command,
    query,
    authorize,
    clear,
    now,
    cart,
    state: () => ({ receipt, committed, rolledBack }),
  };
}
it("creates once and replays the historical result without repeating settlement or audit", async () => {
  const f = fixture();
  const first = await f.store.replace(f.command);
  expect(first.cartReference).toBe(id(4));
  expect(f.clear).toHaveBeenCalledTimes(1);
  expect(await f.store.replace(f.command)).toEqual(first);
  expect(f.clear).toHaveBeenCalledTimes(1);
  expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenCalledTimes(5);
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(2);
  expect(
    f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("DELETE")),
  ).toBe(false);
});
it("rejects changed intent and expired replay without creating another cart", async () => {
  const f = fixture();
  await f.store.replace(f.command);
  await expect(
    f.store.replace({ ...f.command, participantReference: id(9) }),
  ).rejects.toMatchObject({ code: "CART_IDEMPOTENCY_CONFLICT" });
  f.now.mockReturnValue(new Date(Date.parse(f.command.observedAt) + 86400000).toISOString());
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_IDEMPOTENCY_CONFLICT",
  });
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(2);
});
it("requires current authorization even for a successful prior operation", async () => {
  const f = fixture();
  await f.store.replace(f.command);
  f.authorize.mockResolvedValue(false);
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
});
it("does not write when settlement is unresolved", async () => {
  const f = fixture();
  f.clear.mockResolvedValue(false);
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state()).toEqual({ receipt: null, committed: 0, rolledBack: 1 });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it.each([1, 2, 3])("rolls back when authorization check %i rejects", async (n) => {
  const f = fixture();
  let calls = 0;
  f.authorize.mockImplementation(async () => ++calls !== n);
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state()).toEqual({ receipt: null, committed: 0, rolledBack: 1 });
});
it("rolls back association on audit failure and bounds its error", async () => {
  const f = fixture();
  vi.mocked(appendAuditRecordInTransaction).mockRejectedValueOnce(new Error("private"));
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
    message: "cart is unavailable",
  });
  expect(f.state()).toEqual({ receipt: null, committed: 0, rolledBack: 1 });
});
it("rejects a stale cart version before payment clearance", async () => {
  const f = fixture();
  await expect(f.store.replace({ ...f.command, expectedCartVersion: 99 })).rejects.toMatchObject({
    code: "CART_VERSION_CONFLICT",
  });
  expect(f.clear).not.toHaveBeenCalled();
});
it("rejects extra client fields before SQL", async () => {
  const f = fixture();
  await expect(f.store.replace({ ...f.command, settlementClear: true })).rejects.toMatchObject({
    code: "CART_INPUT_INVALID",
  });
  expect(f.query).not.toHaveBeenCalled();
});

it("rolls back and preserves a known replacement permission refusal", async () => {
  const f = fixture();
  f.authorize.mockRejectedValue(new CartError("CART_REPLACEMENT_FORBIDDEN"));
  await expect(f.store.replace(f.command)).rejects.toMatchObject({
    code: "CART_REPLACEMENT_FORBIDDEN",
  });
  expect(f.state()).toMatchObject({ committed: 0, rolledBack: 1, receipt: null });
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});
