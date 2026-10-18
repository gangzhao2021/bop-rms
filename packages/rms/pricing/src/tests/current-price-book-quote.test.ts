import { describe, it, expect } from "vitest";
import { createCurrentPriceBookQuoteService } from "../index.js";
import { input } from "./price-quote.fixture.js";

function fixture() {
  const { priceBook, ...request } = input();
  let at = request.createdAt;
  let calls = 0;
  let result: typeof priceBook | null = priceBook;
  const service = createCurrentPriceBookQuoteService({
    scope: request,
    priceBookReference: priceBook.priceBookReference,
    books: {
      load: async (query) => {
        calls++;
        expect(query).toEqual({
          priceBookReference: priceBook.priceBookReference,
          observedAt: request.createdAt,
        });
        return result;
      },
    },
    clock: { now: () => at },
  });
  return {
    service,
    request,
    priceBook,
    calls: () => calls,
    setAt: (value: string) => {
      at = value;
    },
    setBook: (value: typeof result) => {
      result = value;
    },
  };
}
const error = { code: "CURRENT_PRICE_BOOK_QUOTE_UNAVAILABLE" };
describe("current PriceBook quote service", () => {
  it("calculates using the loaded owner's price and provenance", async () => {
    const f = fixture();
    f.setBook({
      ...f.priceBook,
      entries: f.priceBook.entries.map((e) => ({
        ...e,
        amount: { ...e.amount, amountMinor: 1250n },
      })),
    });
    const quote = await f.service.create(f.request);
    expect(quote.lines[0]?.unitPrice.amountMinor).toBe(1250n);
    expect(quote.lines[0]?.resolvedPrice.versionReference).toBe(f.priceBook.versionReference);
    expect(f.calls()).toBe(1);
  });
  it("rejects foreign Store before loading configuration", async () => {
    const f = fixture();
    await expect(
      f.service.create({ ...f.request, storeReference: f.request.brandReference }),
    ).rejects.toMatchObject(error);
    expect(f.calls()).toBe(0);
  });
  it.each(["expired", "future"] as const)("rejects %s input before I/O", async (mode) => {
    const f = fixture();
    f.setAt(
      mode === "expired"
        ? f.request.expiresAt
        : new Date(Date.parse(f.request.createdAt) - 1).toISOString(),
    );
    await expect(f.service.create(f.request)).rejects.toMatchObject(error);
    expect(f.calls()).toBe(0);
  });
  it.each(["missing", "draft", "foreign", "currency", "future"] as const)(
    "rejects %s owner result",
    async (mode) => {
      const f = fixture();
      f.setBook(
        mode === "missing"
          ? null
          : mode === "draft"
            ? { ...f.priceBook, lifecycle: "Draft" }
            : mode === "foreign"
              ? { ...f.priceBook, priceBookReference: f.request.cartReference }
              : mode === "currency"
                ? {
                    ...f.priceBook,
                    currencyMetadata: { ...f.priceBook.currencyMetadata, metadataVersion: 2 },
                  }
                : { ...f.priceBook, createdAt: f.request.expiresAt },
      );
      await expect(f.service.create(f.request)).rejects.toMatchObject(error);
    },
  );
  it.each(["expired", "regressed"] as const)("rejects time %s during owner read", async (mode) => {
    const f = fixture();
    let count = 0;
    const checked = createCurrentPriceBookQuoteService({
      scope: f.request,
      priceBookReference: f.priceBook.priceBookReference,
      books: { load: async () => f.priceBook },
      clock: {
        now: () =>
          ++count === 1
            ? f.request.createdAt
            : mode === "expired"
              ? f.request.expiresAt
              : new Date(Date.parse(f.request.createdAt) - 1).toISOString(),
      },
    });
    await expect(checked.create(f.request)).rejects.toMatchObject(error);
  });
});
