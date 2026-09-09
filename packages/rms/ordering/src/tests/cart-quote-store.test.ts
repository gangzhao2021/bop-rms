import { describe, expect, it, vi } from "vitest";
import {
  createPostgresCartQuoteStore,
  createPostgresCartQuoteReader,
} from "../infrastructure/persistence/cart-quote-store.js";
const id = (n: number) => `018f5700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(2), storeReference: id(3) };
const references = { hashIntent: () => "invalid", equals: (a: string, b: string) => a === b };
function attachment() {
  const money = (amountMinor: unknown) => ({ amountMinor, currencyCode: "CAD" });
  return {
    ...scope,
    operationReference: id(1),
    operationIntentHash: `sha256:${"a".repeat(64)}`,
    guestSessionReference: id(5),
    cartReference: id(4),
    cartVersion: 1,
    quoteReference: id(6),
    quoteVersion: 1,
    quoteInputDigest: `sha256:${"b".repeat(64)}`,
    currencyCode: "CAD",
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: id(7),
    subtotal: money("9007199254740993"),
    discount: money("0"),
    tax: money("0"),
    fee: money("0"),
    total: money("9007199254740993"),
    lines: [
      {
        lineReference: id(8),
        sellableReference: id(9),
        productVersionReference: id(10),
        menuVersionReference: id(11),
        quantity: 1,
      },
    ],
    warnings: [],
    quoteCreatedAt: "2026-09-08T12:00:00.000Z",
    quoteExpiresAt: "2026-09-08T12:05:00.000Z",
    attachedAt: "2026-09-08T12:00:00.000Z",
    idempotencyExpiresAt: "2026-09-09T12:00:00.000Z",
  };
}
function reader(value: unknown, lineCount = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [{ attachment: value, lineCount }] });
  return createPostgresCartQuoteStore(
    { run: async (action) => action({ query }) },
    scope,
    references,
  );
}
describe("Cart Quote persistence boundary", () => {
  it("hydrates bigint amounts above Number's exact integer range", async () => {
    const result = await reader(attachment()).resolveOperation(id(1));
    expect(result?.total.amountMinor).toBe(9007199254740993n);
  });
  it.each(["01", "-1", "1.0", "1e3", "9223372036854775808", 9007199254740992])(
    "denies noncanonical or unsafe money %s",
    async (value) => {
      const raw = attachment();
      raw.total.amountMinor = value;
      await expect(reader(raw).resolveOperation(id(1))).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
    },
  );
  it.each(["scope", "operation", "count", "extra"])(
    "denies substituted reader %s",
    async (kind) => {
      let raw: unknown = attachment();
      if (kind === "scope") raw = { ...attachment(), storeReference: id(99) };
      if (kind === "operation") raw = { ...attachment(), operationReference: id(99) };
      if (kind === "extra") raw = { ...attachment(), secret: "synthetic" };
      await expect(reader(raw, kind === "count" ? 2 : 1).resolveOperation(id(1))).rejects.toThrow();
    },
  );
  it.each([null, {}, { attachment: {} }, { attachment: {}, expectedCartVersion: 1, audit: {} }])(
    "rejects malformed attach before SQL",
    async (input) => {
      const run = vi.fn();
      const store = createPostgresCartQuoteStore({ run }, scope, references);
      const error = await store.attach(input as never).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
        message: "cart is unavailable",
      });
      expect(error).not.toHaveProperty("cause");
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("bounds driver failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("synthetic restricted driver payload"));
    const error = await createPostgresCartQuoteStore({ run }, scope, references)
      .resolveOperation(id(1))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
      message: "cart is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
});

describe.each(["full", "read-only"])("latest Cart Quote reader %s", (mode) => {
  const request = { cartReference: id(4), cartVersion: 1, observedAt: "2026-09-08T12:01:00.000Z" };
  function fixture(
    selection: unknown = { rows: [{ operation_id: id(1) }] },
    value: unknown = attachment(),
  ) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(selection)
      .mockResolvedValue({ rows: [{ attachment: value, lineCount: 1 }] });
    const run = vi.fn();
    return {
      query,
      run,
      store: (mode === "full" ? createPostgresCartQuoteStore : createPostgresCartQuoteReader)(
        {
          run: async (action) => {
            run();
            return action({ query });
          },
        },
        scope,
        references,
      ),
    };
  }
  it("constructs without acquiring resources and exposes only read capability", () => {
    const f = fixture();
    expect(f.run).not.toHaveBeenCalled();
    if (mode === "read-only") expect(Object.keys(f.store)).toEqual(["loadLatest"]);
    expect(Object.isFrozen(f.store)).toBe(true);
  });
  it("selects an exact version and hydrates the immutable attachment with exact money", async () => {
    const f = fixture();
    expect((await f.store.loadLatest(request))?.total.amountMinor).toBe(9007199254740993n);
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      id(4),
      1,
      request.observedAt,
    ]);
    expect(f.query.mock.calls[1]?.[0]).toContain(
      "ORDER BY attached_at DESC, operation_id DESC LIMIT 1",
    );
    expect(f.run).toHaveBeenCalledOnce();
  });
  it("preserves absence without resolving an invented operation", async () => {
    const f = fixture({ rows: [] });
    expect(await f.store.loadLatest(request)).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    { ...request, cartVersion: 0 },
    { ...request, observedAt: "invalid" },
    { ...request, extra: true },
  ])("denies invalid request %j before SQL", async (value) => {
    const f = fixture();
    await expect(f.store.loadLatest(value as typeof request)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("denies ambiguous selection and substituted attachment", async () => {
    for (const f of [
      fixture({ rows: [{ operation_id: id(1) }, { operation_id: id(2) }] }),
      fixture(undefined, { ...attachment(), cartReference: id(99) }),
      fixture(undefined, { ...attachment(), cartVersion: 2 }),
      fixture(undefined, { ...attachment(), attachedAt: "2026-09-08T12:02:00.000Z" }),
      fixture({ rows: [{}] }),
    ])
      await expect(f.store.loadLatest(request)).rejects.toMatchObject({
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
  });
});

it.each([false, true])(
  "rejects a committed expiry fence before any Cart write (changed intent %s)",
  async (changed) => {
    const raw = attachment();
    const next = {
      ...raw,
      ...Object.fromEntries(
        (["subtotal", "discount", "tax", "fee", "total"] as const).map((field) => [
          field,
          {
            amountMinor: BigInt(raw[field].amountMinor as string),
            currencyCode: "CAD",
          },
        ]),
      ),
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM rms_ordering.cart_quote_expiry_record"))
        return {
          rows: [
            {
              cart_id: id(4),
              cart_version: 1,
              guest_session_id: id(5),
              quote_id: id(changed ? 99 : 6),
              quote_input_digest: raw.quoteInputDigest,
            },
          ],
        };
      if (sql.includes("FOR UPDATE")) return { rows: [{ cart_id: id(4) }] };
      return { rows: [] };
    });
    const store = createPostgresCartQuoteStore(
      { run: async (action) => action({ query }) },
      scope,
      { hashIntent: () => raw.operationIntentHash, equals: (a, b) => a === b },
    );
    await expect(
      store.attach({
        attachment: next as never,
        expectedCartVersion: 1,
        audit: {
          auditId: id(12),
          brandId: id(2),
          storeId: id(3),
          actor: { type: "System" },
          actionCode: "ORDERING_CART_ATTACH_QUOTE",
          reasonCode: "AUTHORIZED_CART_QUOTE",
          targetType: "OrderingCart",
          targetId: id(4),
          occurredAt: raw.attachedAt,
          correlationId: id(13),
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ code: changed ? "CART_IDEMPOTENCY_CONFLICT" : "CART_QUOTE_EXPIRED" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
  },
);
