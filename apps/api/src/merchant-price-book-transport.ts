import { sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPriceBookSnapshot,
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingCode,
  parsePricingDigest,
  PriceBookWorkflowError,
  type PriceBookAction,
  type PriceBookSnapshot,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";

const invalid = (): never => {
  throw new PriceBookWorkflowError("PRICE_BOOK_INPUT_INVALID");
};
export function parseMerchantPriceBookTransport(action: PriceBookAction, value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "operationReference",
      "priceBookReference",
      "expectedAggregateVersion",
      "stableCode",
      "entries",
    ]);
    const expected = raw.expectedAggregateVersion;
    if (
      typeof expected !== "number" ||
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected >= Number.MAX_SAFE_INTEGER ||
      (action === "CreateDraft" ? expected !== 0 : expected === 0) ||
      !Array.isArray(raw.entries)
    )
      return invalid();
    const entries = raw.entries.map((value) => {
      const entry = readClosedRecord(value, [
        "sellableReference",
        "scopeKind",
        "scopeReference",
        "channelCode",
        "orderType",
        "amountMinor",
        "effectivePeriod",
        "reasonCode",
      ]);
      if (
        typeof entry.amountMinor !== "string" ||
        !/^(0|[1-9][0-9]{0,77})$/.test(entry.amountMinor)
      )
        return invalid();
      const amount = BigInt(entry.amountMinor);
      // Price entries persist in PostgreSQL bigint, not an unbounded numeric.
      if (amount > 9223372036854775807n) return invalid();
      return {
        sellableReference: entry.sellableReference,
        scopeKind: entry.scopeKind,
        scopeReference: entry.scopeReference,
        channelCode: entry.channelCode,
        orderType: entry.orderType,
        amountMinor: amount,
        effectivePeriod: entry.effectivePeriod,
        reasonCode: entry.reasonCode,
      };
    });
    return {
      operationReference: parsePricingReference(raw.operationReference),
      priceBookReference: parsePricingReference(raw.priceBookReference),
      expectedAggregateVersion: expected,
      stableCode: parsePricingCode(raw.stableCode),
      entries,
    };
  } catch {
    return invalid();
  }
}
function identity(operation: string, purpose: string) {
  const hash = sha256Hex("PricingHttp:" + purpose + ":" + operation);
  return parsePricingReference(
    operation.slice(0, 14) +
      "7" +
      hash.slice(0, 3) +
      "-8" +
      hash.slice(3, 6) +
      "-" +
      hash.slice(6, 18),
  );
}
function checkedSnapshot(value: PriceBookSnapshot): PriceBookSnapshot {
  try {
    return createPriceBookSnapshot(value);
  } catch {
    return invalid();
  }
}
/** Deterministic IDs and exact minor-unit wire conversion. First execution uses
 * the server clock; a persisted replay uses its original operation time.
 */
export function bindMerchantPriceBookTransport(
  action: PriceBookAction,
  raw: ReturnType<typeof parseMerchantPriceBookTransport>,
  context: {
    brandReference: string;
    currencyMetadata: CurrencyMetadataSnapshot;
    requestedAt: string;
  },
) {
  const at = parseCanonicalInstant(context.requestedAt);
  const currency = createCurrencyMetadataSnapshot(context.currencyMetadata);
  const snapshot = checkedSnapshot({
    priceBookReference: raw.priceBookReference,
    versionReference: identity(raw.operationReference, "Version"),
    brandReference: parsePricingReference(context.brandReference),
    stableCode: raw.stableCode,
    aggregateVersion: raw.expectedAggregateVersion + 1,
    versionNumber: raw.expectedAggregateVersion + 1,
    lifecycle: action === "Publish" ? "Published" : action === "Archive" ? "Archived" : "Draft",
    currencyMetadata: currency,
    createdAt: at,
    snapshotDigest: parsePricingDigest("sha256:" + "0".repeat(64)),
    entries: raw.entries.map((entry, index) => ({
      entryReference: identity(raw.operationReference, "Entry:" + index),
      sellableReference: entry.sellableReference,
      scopeKind: entry.scopeKind,
      scopeReference: entry.scopeReference,
      channelCode: entry.channelCode,
      orderType: entry.orderType,
      amount: { amountMinor: entry.amountMinor, currencyCode: currency.currencyCode },
      effectivePeriod: entry.effectivePeriod,
      reasonCode: entry.reasonCode,
    })) as PriceBookSnapshot["entries"],
  });
  const content = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== "snapshotDigest"),
  );
  const digest =
    "sha256:" +
    sha256Hex(
      JSON.stringify(content, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  return {
    candidate: checkedSnapshot({ ...snapshot, snapshotDigest: parsePricingDigest(digest) }),
    operationReference: raw.operationReference,
    requestedAt: at,
    ...(action === "CreateDraft"
      ? {}
      : {
          priceBookReference: raw.priceBookReference,
          expectedAggregateVersion: raw.expectedAggregateVersion,
        }),
  };
}
