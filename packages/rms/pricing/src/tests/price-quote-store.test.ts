import { describe, expect, it } from "vitest";
import type { AppendAuditRecordInput } from "@bop/audit";
import {
  createPostgresPriceQuoteStore,
  createPriceQuote,
  encodePriceQuoteSnapshot,
  parsePricingReference,
  type PriceQuoteDatabaseTransaction,
} from "../index.js";
import { input } from "./price-quote.fixture.js";

const q = createPriceQuote(input());
const id = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const audit: AppendAuditRecordInput = {
  auditId: id(100),
  brandId: q.brandReference,
  storeId: q.storeReference,
  actor: { type: "System" },
  actionCode: "PRICING_QUOTE_CREATE",
  targetType: "PricingQuote",
  targetId: q.quoteReference,
  reasonCode: "AUTHORIZED_PRICE_QUOTE",
  correlationId: id(101),
  occurredAt: q.createdAt,
  sourceChannel: "CUSTOMER_PWA",
  dataClassification: "Restricted",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
};
function factory(query: PriceQuoteDatabaseTransaction["query"]) {
  return createPostgresPriceQuoteStore({
    brandReference: q.brandReference,
    storeReference: q.storeReference,
    nextTaxLineReference: () => id(200),
    runner: { run: (action) => action({ query }) },
  });
}
describe("scoped Quote store boundaries", () => {
  it("returns null for absent scoped rows", async () => {
    const store = factory(async (_sql, values) => {
      expect(values).toEqual([q.brandReference, q.storeReference, q.quoteReference]);
      return { rows: [] };
    });
    expect(await store.load(q.quoteReference)).toBeNull();
  });
  it("refuses legacy records instead of reconstructing incomplete evidence", async () => {
    const store = factory(async () => ({ rows: [{ quote: { snapshot_json: null } }] }));
    await expect(store.load(q.quoteReference)).rejects.toMatchObject({
      code: "QUOTE_STORE_SNAPSHOT_UNAVAILABLE",
    });
  });
  it("refuses a malformed driver result", async () => {
    await expect(
      factory(async () => ({ rows: null })).load(q.quoteReference),
    ).rejects.toMatchObject({ code: "QUOTE_STORE_UNAVAILABLE" });
  });
  it("redacts unknown driver errors without retaining their cause", async () => {
    const result = factory(async () => {
      throw new Error("synthetic-private-sql-marker");
    }).load(q.quoteReference);
    await expect(result).rejects.toMatchObject({
      code: "QUOTE_STORE_UNAVAILABLE",
      message: "price quote storage is unavailable",
    });
    await result.catch((error: Error) => {
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect(String(error)).not.toContain("marker");
    });
  });
  it("refuses foreign candidate scope before querying", async () => {
    let queried = false;
    const store = factory(async () => {
      queried = true;
      return { rows: [] };
    });
    await expect(
      store.save({ snapshot: { ...q, brandReference: id(300) }, audit }),
    ).rejects.toMatchObject({ code: "QUOTE_STORE_UNAVAILABLE" });
    expect(queried).toBe(false);
  });
  it("requires exact Audit purpose and target before querying", async () => {
    let queried = false;
    const store = factory(async () => {
      queried = true;
      return { rows: [] };
    });
    await expect(
      store.save({ snapshot: q, audit: { ...audit, targetId: id(300) } }),
    ).rejects.toMatchObject({ code: "QUOTE_STORE_UNAVAILABLE" });
    expect(queried).toBe(false);
  });
  it("checks the returned snapshot against the requested Quote identity", async () => {
    const store = factory(async () => ({
      rows: [{ quote: { snapshot_json: encodePriceQuoteSnapshot(q) } }],
    }));
    await expect(store.load(id(300))).rejects.toMatchObject({ code: "QUOTE_STORE_UNAVAILABLE" });
  });
});
