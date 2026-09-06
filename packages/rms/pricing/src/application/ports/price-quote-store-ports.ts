import type { AppendAuditRecordInput } from "@bop/audit";
import type { PriceQuoteSnapshot } from "../../domain/price-quote.js";
import type { PricingReference } from "../../domain/money-tax-contract.js";

export interface PriceQuoteStore {
  load(quoteReference: PricingReference): Promise<PriceQuoteSnapshot | null>;
  save(input: {
    readonly snapshot: PriceQuoteSnapshot;
    readonly audit: AppendAuditRecordInput;
  }): Promise<PriceQuoteSnapshot>;
}
export class PriceQuoteStoreError extends Error {
  constructor(
    readonly code:
      "QUOTE_STORE_UNAVAILABLE" | "QUOTE_STORE_CONFLICT" | "QUOTE_STORE_SNAPSHOT_UNAVAILABLE",
  ) {
    super("price quote storage is unavailable");
    this.name = "PriceQuoteStoreError";
  }
}
