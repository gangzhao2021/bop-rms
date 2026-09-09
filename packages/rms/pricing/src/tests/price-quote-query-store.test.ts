import { describe, expect, it, vi } from "vitest";
import {
  createPriceQuote,
  encodePriceQuoteSnapshot,
  createPostgresPriceQuoteHistoryReader,
  PriceQuoteQueryError,
  type PriceQuoteQueryTransactionRunner,
  type PriceQuoteQueryTransaction,
} from "../index.js";
import { input } from "./price-quote.fixture.js";
const quote = createPriceQuote(input());
const scope = { brandReference: quote.brandReference, storeReference: quote.storeReference };
const other = "018fb000-0000-7000-8000-000000000099";
function row() {
  return {
    snapshotText: encodePriceQuoteSnapshot(quote),
    summary: {
      quoteReference: quote.quoteReference,
      quoteVersion: 1,
      ...scope,
      cartReference: quote.cartReference,
      cartVersion: 4,
      inputDigest: quote.inputDigest,
      currencyCode: "CAD",
      currencyMetadataVersion: 1,
      currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
      currencyMetadataDigest: quote.currencyMetadata.metadataDigest,
      subtotal: "2000",
      discount: "0",
      tax: "260",
      fee: "0",
      total: "2260",
      appliedPromotionReferences: "[]",
      warnings: "[]",
      blockingReasons: "[]",
      createdAt: "2026-08-02T16:00:00.000000Z",
      expiresAt: "2026-08-02T16:05:00.000000Z",
    },
  };
}
function fixture(result: unknown = { rows: [row()] }) {
  const query = vi.fn<PriceQuoteQueryTransaction["query"]>(async () => result);
  const run = vi.fn(async () => undefined);
  const runner: PriceQuoteQueryTransactionRunner = {
    async run(action) {
      await run();
      return action({ query });
    },
  };
  return { query, run, runner, reader: createPostgresPriceQuoteHistoryReader(runner, scope) };
}

describe("owner-scoped complete Quote history reader", () => {
  it("opens no connection until an explicit read and sets local context before exact parameterized lookup", async () => {
    const f = fixture();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    const result = await f.reader.load(quote.quoteReference);
    expect(result).toEqual(quote);
    expect(result).not.toBe(quote);
    expect(Object.isFrozen(result?.lines)).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[0]).toEqual([
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [scope.brandReference, scope.storeReference],
    ]);
    expect(f.query.mock.calls[1]?.[0]).toContain(
      "WHERE q.brand_id=$1 AND q.store_id=$2 AND q.price_quote_id=$3",
    );
    expect(f.query.mock.calls[1]?.[0]).not.toContain(scope.storeReference);
    expect(f.query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      quote.quoteReference,
    ]);
    expect(result?.expiresAt).toBe("2026-08-02T16:05:00.000Z");
  });
  it("snapshots constructor scope against later mutation", async () => {
    const f = fixture();
    const mutable = { ...scope };
    const reader = createPostgresPriceQuoteHistoryReader(f.runner, mutable);
    mutable.storeReference = other as never;
    expect(await reader.load(quote.quoteReference)).toEqual(quote);
    expect(f.query.mock.calls[0]?.[1]).toEqual([scope.brandReference, scope.storeReference]);
  });
  it("returns null only for an empty result", async () => {
    expect(await fixture({ rows: [] }).reader.load(quote.quoteReference)).toBeNull();
  });
  it.each(["private bad reference", null, 3])(
    "rejects invalid identity before I/O: %s",
    async (value) => {
      const f = fixture();
      await expect(f.reader.load(value as string)).rejects.toThrow(PriceQuoteQueryError);
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed and accessor scope without invoking the accessor", () => {
    const get = vi.fn(() => scope.storeReference);
    expect(() =>
      createPostgresPriceQuoteHistoryReader(fixture().runner, { ...scope, extra: true } as never),
    ).toThrow(PriceQuoteQueryError);
    expect(() =>
      createPostgresPriceQuoteHistoryReader(fixture().runner, {
        brandReference: scope.brandReference,
        get storeReference() {
          return get();
        },
      }),
    ).toThrow(PriceQuoteQueryError);
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { rows: null },
    { rows: [row(), row()] },
    { rows: [null] },
    { rows: [{ ...row(), extra: true }] },
    { rows: [{ ...row(), snapshotText: null }] },
    { rows: [{ ...row(), snapshotText: "private corrupt value" }] },
  ])("rejects partial or malformed driver data %#", async (result) => {
    await expect(fixture(result).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
  });
  it("rejects a complete snapshot for a different requested identity or scope", async () => {
    const f = fixture();
    await expect(f.reader.load(other)).rejects.toThrow(PriceQuoteQueryError);
    const reader = createPostgresPriceQuoteHistoryReader(f.runner, {
      ...scope,
      brandReference: other,
    });
    await expect(reader.load(quote.quoteReference)).rejects.toThrow(PriceQuoteQueryError);
  });
  it.each([
    ["total", "2261"],
    ["cartVersion", 5],
    ["inputDigest", `sha256:${"a".repeat(64)}`],
    ["currencyCode", "USD"],
    ["currencyMetadataVersionReference", other],
    ["brandReference", other],
    ["quoteReference", other],
    ["warnings", '["STALE"]'],
    ["createdAt", "2026-08-02T16:00:00.000001Z"],
    ["expiresAt", "2026-08-02T16:05:00.000001Z"],
  ])("rejects stored summary mismatch in %s", async (field, value) => {
    const record = row();
    Reflect.set(record.summary, field as string, value);
    await expect(fixture({ rows: [record] }).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
  });
  it("rejects missing summary fields", async () => {
    const record = row();
    Reflect.deleteProperty(record.summary, "subtotal");
    await expect(fixture({ rows: [record] }).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
  });
  it("does not invoke row/summary getters", async () => {
    const get = vi.fn(() => row());
    const records: unknown[] = [null];
    Object.defineProperty(records, "0", { get });
    await expect(fixture({ rows: records }).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
    const record = row();
    Object.defineProperty(record.summary, "total", { get });
    await expect(fixture({ rows: [record] }).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
    const response = {};
    Object.defineProperty(response, "rows", { get });
    await expect(fixture(response).reader.load(quote.quoteReference)).rejects.toThrow(
      PriceQuoteQueryError,
    );
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["context", "select", "transaction"])(
    "redacts %s failures and stops subsequent work",
    async (phase) => {
      const f = fixture();
      const error = new Error("private database detail");
      if (phase === "context") f.query.mockRejectedValueOnce(error);
      if (phase === "select")
        f.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
      if (phase === "transaction") f.run.mockRejectedValueOnce(error);
      await expect(f.reader.load(quote.quoteReference)).rejects.toMatchObject({
        code: "QUOTE_HISTORY_UNAVAILABLE",
        message: "price quote history is unavailable",
      });
      expect(f.query).toHaveBeenCalledTimes(phase === "context" ? 1 : phase === "select" ? 2 : 0);
    },
  );
});
