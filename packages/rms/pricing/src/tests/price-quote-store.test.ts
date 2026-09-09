import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPriceQuote,
  createPostgresPriceQuoteStore,
  PriceQuoteStoreError,
  type PriceQuoteQueryTransaction,
  type PriceQuoteQueryTransactionRunner,
} from "../index.js";
import { input } from "./price-quote.fixture.js";
const mocks = vi.hoisted(() => ({ load: vi.fn(), audit: vi.fn() }));
vi.mock("../infrastructure/persistence/price-quote-query-store.js", async (original) => ({
  ...(await original<typeof import("../infrastructure/persistence/price-quote-query-store.js")>()),
  createPostgresPriceQuoteHistoryReader: () => ({ load: mocks.load }),
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const quote = createPriceQuote(input());
const scope = { brandReference: quote.brandReference, storeReference: quote.storeReference };
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
function fixture() {
  let next = 1000;
  const generateReference = vi.fn(() => id(next++));
  const query = vi.fn<PriceQuoteQueryTransaction["query"]>(async (sql, values) => ({
    rows: sql.startsWith("INSERT") ? [{ reference: values[0] }] : [],
  }));
  const entered = vi.fn(async () => undefined);
  const runner: PriceQuoteQueryTransactionRunner = {
    async run(action) {
      await entered();
      return action({ query });
    },
  };
  mocks.load.mockResolvedValue(quote).mockResolvedValueOnce(null);
  mocks.audit.mockResolvedValue(undefined);
  return {
    query,
    entered,
    generateReference,
    store: createPostgresPriceQuoteStore(runner, scope, { generateReference }),
  };
}
beforeEach(() => vi.resetAllMocks());
describe("atomic Quote append adapter", () => {
  it("writes root, fresh physical line/tax references and one required public Audit", async () => {
    const f = fixture();
    expect(f.entered).not.toHaveBeenCalled();
    const result = await f.store.append({ quote, audit });
    expect(result).toEqual({ status: "Created", quote });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.query.mock.calls[0]?.[1]).toEqual([scope.brandReference, scope.storeReference]);
    expect(f.query.mock.calls[1]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`pricing.quote:${quote.quoteReference}`],
    ]);
    expect(f.query.mock.calls[2]?.[0]).not.toContain("ON CONFLICT");
    expect(f.query.mock.calls[2]?.[1][10]).toBe("2000");
    expect(f.query.mock.calls[3]?.[1][0]).toBe(id(1000));
    expect(f.query.mock.calls[3]?.[1][22]).toBe(quote.lines[0]?.lineReference);
    expect(f.query.mock.calls[4]?.[1][2]).toBe(id(1000));
    expect(f.generateReference).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]?.[1]).toEqual(audit);
  });
  it("returns identical stored evidence without child allocation or a second Audit", async () => {
    const f = fixture();
    mocks.load.mockReset().mockResolvedValue(quote);
    expect(await f.store.append({ quote, audit })).toEqual({ status: "Existing", quote });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.generateReference).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("rejects conflicting stored evidence", async () => {
    const f = fixture();
    mocks.load.mockReset().mockResolvedValue(createPriceQuote(input({ cartVersion: 5 })));
    await expect(f.store.append({ quote, audit })).rejects.toMatchObject({
      code: "QUOTE_SNAPSHOT_CONFLICT",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["missing write witness", "read error"])("rejects %s", async (kind) => {
    const f = fixture();
    f.query.mockResolvedValue({ rows: [] });
    if (kind === "missing write witness") mocks.load.mockResolvedValue(null);
    else mocks.load.mockReset().mockRejectedValue(new Error("private database error"));
    await expect(f.store.append({ quote, audit })).rejects.toThrow(PriceQuoteStoreError);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([
    ["brandId", id(999)],
    ["storeId", id(999)],
    ["actionCode", "OTHER_ACTION"],
    ["targetType", "OtherTarget"],
    ["targetId", id(999)],
    ["reasonCode", "OTHER_REASON"],
    ["occurredAt", "2026-08-02T16:00:01.000Z"],
    ["sourceChannel", "OTHER_SOURCE"],
    ["dataClassification", "Public"],
    ["beforeSummary", {}],
    ["afterSummary", {}],
    ["correctsAuditId", id(998)],
    ["deviceNetworkReference", "SYNTHETIC_DEVICE"],
    ["actor", { type: "Service", reference: id(997) }],
  ])("rejects wrong Audit %s before effects", async (field, value) => {
    const f = fixture();
    await expect(
      f.store.append({ quote, audit: { ...audit, [field as string]: value } }),
    ).rejects.toThrow(PriceQuoteStoreError);
    expect(f.entered).not.toHaveBeenCalled();
    expect(f.generateReference).not.toHaveBeenCalled();
  });
  it("rejects unknown/getter input and foreign Quote scope before effects", async () => {
    const f = fixture();
    const get = vi.fn(() => quote);
    await expect(
      f.store.append({
        get quote() {
          return get();
        },
        audit,
      }),
    ).rejects.toThrow(PriceQuoteStoreError);
    await expect(f.store.append({ quote, audit, extra: true } as never)).rejects.toThrow(
      PriceQuoteStoreError,
    );
    await expect(
      f.store.append({ quote: { ...quote, brandReference: id(999) as never }, audit }),
    ).rejects.toThrow(PriceQuoteStoreError);
    expect(get).not.toHaveBeenCalled();
    expect(f.entered).not.toHaveBeenCalled();
  });
  it.each(["root", "line", "tax"])("rejects incorrect %s write witnesses", async (kind) => {
    const f = fixture();
    const bad = kind === "root" ? 2 : kind === "line" ? 3 : 4;
    const original = f.query.getMockImplementation();
    if (original === undefined) throw new Error("fixture missing");
    let count = 0;
    f.query.mockImplementation(async (...args) =>
      count++ === bad ? { rows: [{ reference: id(998) }] } : original(...args),
    );
    await expect(f.store.append({ quote, audit })).rejects.toThrow(PriceQuoteStoreError);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["invalid", "duplicate", "source line"])(
    "rejects %s generated identity",
    async (kind) => {
      const f = fixture();
      f.generateReference.mockReturnValue(
        kind === "invalid"
          ? "bad"
          : kind === "duplicate"
            ? id(1000)
            : String(quote.lines[0]?.lineReference),
      );
      await expect(f.store.append({ quote, audit })).rejects.toThrow(PriceQuoteStoreError);
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
  it("rejects changed readback before Audit", async () => {
    const f = fixture();
    mocks.load.mockResolvedValue(null);
    await expect(f.store.append({ quote, audit })).rejects.toThrow(PriceQuoteStoreError);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["transaction", "query", "Audit"])("redacts %s failure", async (phase) => {
    const f = fixture();
    const error = new Error("private persistence detail");
    if (phase === "transaction") f.entered.mockRejectedValue(error);
    if (phase === "query") f.query.mockRejectedValue(error);
    if (phase === "Audit") mocks.audit.mockRejectedValue(error);
    await expect(f.store.append({ quote, audit })).rejects.toMatchObject({
      code: "QUOTE_WRITE_UNAVAILABLE",
      message: "price quote could not be saved",
    });
  });
  it("rejects Audit getters and owns the validated Audit before awaiting", async () => {
    const f = fixture();
    const get = vi.fn(() => audit.reasonCode);
    await expect(
      f.store.append({
        quote,
        audit: {
          ...audit,
          get reasonCode() {
            return get();
          },
        },
      }),
    ).rejects.toThrow(PriceQuoteStoreError);
    expect(get).not.toHaveBeenCalled();
    expect(f.entered).not.toHaveBeenCalled();
    const mutable = structuredClone(audit);
    f.entered.mockImplementation(async () => {
      mutable.targetId = id(999) as never;
    });
    await f.store.append({ quote, audit: mutable });
    expect(mocks.audit.mock.calls[0]?.[1]).toEqual(audit);
  });
  it("owns a snapshot before awaiting the transaction", async () => {
    const f = fixture();
    const mutable = structuredClone(quote);
    f.entered.mockImplementation(async () => {
      Reflect.set(mutable, "cartVersion", 9);
    });
    expect((await f.store.append({ quote: mutable, audit })).quote.cartVersion).toBe(4);
    expect(f.query.mock.calls[2]?.[1][4]).toBe(4);
  });
});
