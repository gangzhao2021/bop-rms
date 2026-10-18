import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPriceQuote,
  createPostgresPriceQuoteRequestStore,
  parsePriceQuoteRequestIdentity,
  parsePriceQuoteRequestRecord,
  priceQuoteRequestIntent,
  PriceQuoteRequestError,
  type PriceQuoteQueryTransaction,
  type PriceQuoteQueryTransactionRunner,
  type PriceQuoteRequestRecord,
} from "../index.js";
import { input } from "./price-quote.fixture.js";
const mocks = vi.hoisted(() => ({ load: vi.fn(), append: vi.fn() }));
vi.mock("../infrastructure/persistence/price-quote-query-store.js", async (original) => ({
  ...(await original<typeof import("../infrastructure/persistence/price-quote-query-store.js")>()),
  createPostgresPriceQuoteHistoryReader: () => ({ load: mocks.load }),
}));
vi.mock("../infrastructure/persistence/price-quote-store.js", async (original) => ({
  ...(await original<typeof import("../infrastructure/persistence/price-quote-store.js")>()),
  createPostgresPriceQuoteStore: () => ({ append: mocks.append }),
}));
const id = (n: number) => `01902000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const quote = createPriceQuote(input());
const scope = { brandReference: quote.brandReference, storeReference: quote.storeReference };
const observedAt = "2026-08-02T16:00:01.000Z";
const identity = parsePriceQuoteRequestIdentity({
  ...scope,
  operationReference: id(1),
  guestSessionReference: id(2),
  cartReference: quote.cartReference,
  cartVersion: quote.cartVersion,
});
const hash = (v: string) => `sha256:${createHash("sha256").update(v).digest("hex")}`;
const original = () =>
  parsePriceQuoteRequestRecord({
    ...identity,
    recordVersion: 1,
    intentDigest: hash(priceQuoteRequestIntent(identity)),
    quoteReference: quote.quoteReference,
    quoteOutcome: "Created",
    createdAt: observedAt,
    idempotencyExpiresAt: "2026-08-03T16:00:01.000Z",
  });
const lookup = () => ({
  operationReference: identity.operationReference,
  guestSessionReference: identity.guestSessionReference,
  cartReference: identity.cartReference,
  cartVersion: identity.cartVersion,
  observedAt,
});
const audit = {
  auditId: id(700),
  brandId: scope.brandReference,
  storeId: scope.storeReference,
  actor: { type: "System" as const },
  actionCode: "PRICING_QUOTE_CREATE",
  targetType: "PricingPriceQuote",
  targetId: quote.quoteReference,
  reasonCode: "AUTHORIZED_CART_QUOTE",
  correlationId: id(701),
  occurredAt: quote.createdAt,
  sourceChannel: "CUSTOMER_PWA",
  dataClassification: "Restricted" as const,
  retentionPolicyCode: "SYNTHETIC_RETENTION",
  retentionPolicyVersion: 1,
};
const request = () => ({
  operationReference: identity.operationReference,
  guestSessionReference: identity.guestSessionReference,
  observedAt,
  quote,
  audit,
});
function fixture(initial: PriceQuoteRequestRecord | null = null) {
  let saved = initial;
  const entered = vi.fn(async () => undefined);
  const query = vi.fn<PriceQuoteQueryTransaction["query"]>(async (sql, values) => {
    if (sql.startsWith("SELECT jsonb_build_object"))
      return { rows: saved === null ? [] : [{ record: saved }] };
    if (sql.startsWith("INSERT INTO rms_pricing.price_quote_request")) {
      saved = parsePriceQuoteRequestRecord({
        operationReference: values[0],
        brandReference: values[1],
        storeReference: values[2],
        guestSessionReference: values[3],
        cartReference: values[4],
        cartVersion: values[5],
        recordVersion: 1,
        intentDigest: values[6],
        quoteReference: values[7],
        quoteOutcome: values[8],
        createdAt: values[9],
        idempotencyExpiresAt: values[10],
      });
      return { rows: [{ reference: values[0] }] };
    }
    return { rows: [] };
  });
  const runner: PriceQuoteQueryTransactionRunner = {
    async run(action) {
      await entered();
      return action({ query });
    },
  };
  const refs = {
    generateReference: () => id(1000),
    hashIntent: vi.fn(hash),
    equals: (a: string, b: string) => a === b,
  };
  mocks.load.mockResolvedValue(quote);
  mocks.append.mockResolvedValue({ status: "Created", quote });
  return {
    query,
    entered,
    runner,
    refs,
    store: createPostgresPriceQuoteRequestStore(runner, scope, refs),
  };
}
beforeEach(() => vi.resetAllMocks());
describe("scoped Quote request persistence", () => {
  it("opens nothing at construction and returns null without matching history", async () => {
    const f = fixture();
    expect(f.entered).not.toHaveBeenCalled();
    expect(await f.store.resolve(lookup())).toBeNull();
    expect(f.query.mock.calls[0]?.[1]).toEqual([scope.brandReference, scope.storeReference]);
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      identity.operationReference,
    ]);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("persists the original linked outcome in the same borrowed transaction", async () => {
    const f = fixture();
    const result = await f.store.append(request());
    expect(result).toEqual({ record: original(), quote });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(await f.store.resolve(lookup())).toEqual(result);
  });
  it("returns an original expired Quote without evaluating a new candidate", async () => {
    const f = fixture(original());
    const replacement = createPriceQuote(input({ quoteReference: id(800) as never }));
    const result = await f.store.append({
      ...request(),
      observedAt: "2026-08-02T17:00:00.000Z",
      quote: replacement,
      audit: { ...audit, targetId: replacement.quoteReference },
    });
    expect(result.quote.quoteReference).toBe(quote.quoteReference);
    expect(result.quote.expiresAt).toBe(quote.expiresAt);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("preserves an Existing Quote outcome", async () => {
    const f = fixture();
    mocks.append.mockResolvedValue({ status: "Existing", quote });
    expect((await f.store.append(request())).record.quoteOutcome).toBe("Existing");
  });
  it.each([
    ["guestSessionReference", id(9)],
    ["cartReference", id(9)],
    ["cartVersion", 8],
    ["observedAt", "2026-08-03T16:00:01.000Z"],
    ["observedAt", "2026-08-02T16:00:00.999Z"],
  ])("rejects changed or expired %s before reading the Quote", async (field, value) => {
    const f = fixture(original());
    await expect(f.store.resolve({ ...lookup(), [field as string]: value })).rejects.toMatchObject({
      code: "QUOTE_REQUEST_CONFLICT",
    });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it.each(["2026-08-02T15:59:59.999Z", "2026-08-02T16:05:00.000Z"])(
    "rejects a new request outside Quote validity at %s",
    async (at) => {
      const f = fixture();
      await expect(f.store.append({ ...request(), observedAt: at })).rejects.toThrow(
        PriceQuoteRequestError,
      );
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it("rejects corrupt digest before reading linked Quote", async () => {
    const f = fixture({ ...original(), intentDigest: `sha256:${"a".repeat(64)}` as never });
    await expect(f.store.resolve(lookup())).rejects.toMatchObject({
      code: "QUOTE_REQUEST_UNAVAILABLE",
    });
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([null, { ...quote, cartVersion: 99 }])(
    "rejects missing or mismatched linked Quote %#",
    async (value) => {
      const f = fixture(original());
      mocks.load.mockResolvedValue(value);
      await expect(f.store.resolve(lookup())).rejects.toThrow(PriceQuoteRequestError);
    },
  );
  it("rejects malformed inputs and accessors before transaction", async () => {
    const f = fixture();
    const get = vi.fn(() => identity.operationReference);
    await expect(
      f.store.resolve({
        ...lookup(),
        get operationReference() {
          return get();
        },
      }),
    ).rejects.toThrow(PriceQuoteRequestError);
    await expect(f.store.resolve({ ...lookup(), cartVersion: 0 })).rejects.toThrow(
      PriceQuoteRequestError,
    );
    await expect(
      f.store.append({
        ...request(),
        audit: {
          ...audit,
          get reasonCode() {
            return get();
          },
        },
      }),
    ).rejects.toThrow(PriceQuoteRequestError);
    expect(get).not.toHaveBeenCalled();
    expect(f.entered).not.toHaveBeenCalled();
  });
  it("copies caller input and Audit before awaits", async () => {
    const f = fixture();
    const value = structuredClone(request());
    f.entered.mockImplementation(async () => {
      Reflect.set(value, "operationReference", id(900));
      Reflect.set(value.audit, "targetId", id(901));
    });
    expect((await f.store.append(value)).record.operationReference).toBe(
      identity.operationReference,
    );
    expect(mocks.append.mock.calls[0]?.[0].audit).toEqual(audit);
  });
  it.each(["transaction", "select", "quote", "insert", "readback"])(
    "redacts %s failure",
    async (phase) => {
      const f = fixture();
      const error = new Error("private detail");
      if (phase === "transaction") f.entered.mockRejectedValue(error);
      if (phase === "quote") mocks.append.mockRejectedValue(error);
      if (phase === "readback") mocks.load.mockResolvedValue(null);
      if (phase === "select" || phase === "insert") {
        const originalQuery = f.query.getMockImplementation();
        if (originalQuery === undefined) throw new Error("fixture missing");
        f.query.mockImplementation(async (sql, values) => {
          if (sql.startsWith(phase === "select" ? "SELECT jsonb_build_object" : "INSERT INTO"))
            throw error;
          return originalQuery(sql, values);
        });
      }
      await expect(f.store.append(request())).rejects.toMatchObject({
        code: "QUOTE_REQUEST_UNAVAILABLE",
        message: "price quote request is unavailable",
      });
    },
  );
  it("rejects record getters and invalid insert witnesses", async () => {
    const f = fixture();
    const get = vi.fn(() => original());
    f.query.mockResolvedValue({
      rows: [
        {
          get record() {
            return get();
          },
        },
      ],
    });
    await expect(f.store.resolve(lookup())).rejects.toThrow(PriceQuoteRequestError);
    expect(get).not.toHaveBeenCalled();
    const next = fixture();
    const query = next.query.getMockImplementation();
    if (query === undefined) throw new Error("fixture missing");
    next.query.mockImplementation(async (sql, values) =>
      sql.startsWith("INSERT INTO") ? { rows: [] } : query(sql, values),
    );
    await expect(next.store.append(request())).rejects.toThrow(PriceQuoteRequestError);
  });
});
