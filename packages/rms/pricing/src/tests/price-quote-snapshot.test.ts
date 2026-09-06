import { describe, expect, it } from "vitest";
import {
  createPriceQuote,
  decodePriceQuoteSnapshot,
  encodePriceQuoteSnapshot,
  parsePriceQuoteSnapshot,
  parsePricingReference,
  parsePricingCode,
  parseTaxRate,
  type PriceQuoteSnapshot,
} from "../index.js";
import { input } from "./price-quote.fixture.js";

type Mutable<T> = T extends string | number | boolean | bigint | null
  ? T
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type Wire<T> = T extends bigint
  ? string
  : T extends string | number | boolean | null
    ? T
    : T extends readonly (infer U)[]
      ? Wire<U>[]
      : T extends object
        ? { -readonly [K in keyof T]: Wire<T[K]> }
        : T;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("SYNTHETIC_FIXTURE_MISSING");
  return value;
}
const id = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
function fixture() {
  const source = structuredClone(input()) as Mutable<ReturnType<typeof input>>;
  required(source.priceBook.entries[0]).amount.amountMinor = 9007199254740993n;
  required(source.lines[0]).quantity = 1;
  source.lines.unshift({ ...required(source.lines[0]), lineReference: id(80) });
  source.taxConfiguration.rules.push({
    ...required(source.taxConfiguration.rules[0]),
    ruleReference: id(81),
    calculationOrder: 2,
    compoundOnPriorTax: true,
    taxComponentCode: parsePricingCode("SYNTHETIC_SECOND"),
    rate: parseTaxRate("0.05"),
  });
  return createPriceQuote(source);
}
function document() {
  return JSON.parse(JSON.stringify(encodePriceQuoteSnapshot(fixture()))) as {
    version: 1;
    snapshot: Wire<PriceQuoteSnapshot>;
  };
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(frozen);
  }
}

describe("lossless versioned Quote snapshot", () => {
  it("round-trips all evidence, compound tax, line order and exact bigint amounts", () => {
    const quote = fixture();
    const encoded = encodePriceQuoteSnapshot(quote);
    const wire = document();
    const restored = decodePriceQuoteSnapshot(wire);
    expect(restored).toEqual(quote);
    expect(restored.lines.map((line) => line.lineReference)).toEqual([id(80), id(22)]);
    expect(required(wire.snapshot.lines[0]).unitPrice.amountMinor).toBe("9007199254740993");
    expect(required(restored.lines[0]).taxLines).toHaveLength(2);
    expect(restored.currencyMetadata.minorUnitExponent).toBe(2);
    expect(restored).not.toBe(quote);
    frozen(encoded);
    frozen(restored);
    required(required(wire.snapshot.lines[0]).taxResolution.rules[0]).receiptPresentationCode =
      parsePricingCode("CHANGED");
    expect(
      required(required(restored.lines[0]).taxResolution.rules[0]).receiptPresentationCode,
    ).not.toBe("CHANGED");
  });

  it("accepts JSON object key reordering without consulting mutable source facts", () => {
    const wire = document();
    const explanation = required(required(wire.snapshot.lines[0]).taxLines[0]).explanation;
    required(required(wire.snapshot.lines[0]).taxLines[0]).explanation = Object.fromEntries(
      Object.entries(explanation).reverse(),
    ) as typeof explanation;
    expect(decodePriceQuoteSnapshot(wire)).toEqual(fixture());
  });

  it.each(["HalfUp", "HalfEven", "TowardZero", "AwayFromZero"] as const)(
    "retains %s rounding evidence",
    (roundingMode) => {
      const source = structuredClone(input()) as Mutable<ReturnType<typeof input>>;
      required(source.priceBook.entries[0]).amount.amountMinor = 7n;
      required(source.lines[0]).quantity = 1;
      required(source.taxConfiguration.rules[0]).roundingMode = roundingMode;
      const quote = createPriceQuote(source);
      expect(
        decodePriceQuoteSnapshot(JSON.parse(JSON.stringify(encodePriceQuoteSnapshot(quote)))),
      ).toEqual(quote);
    },
  );

  const corruptions: readonly [string, (quote: Wire<PriceQuoteSnapshot>) => void][] = [
    [
      "duplicate rule identity with matching explanation",
      (q) => {
        const item = required(q.lines[0]);
        const reference = required(item.taxResolution.rules[0]).resolvedRule.ruleVersionReference;
        required(item.taxResolution.rules[1]).resolvedRule.ruleVersionReference = reference;
        required(item.taxLines[1]).ruleReference = reference;
        required(item.taxLines[1]).explanation.ruleVersionReference = reference;
      },
    ],
    [
      "duplicate tax component with matching explanation",
      (q) => {
        const item = required(q.lines[0]);
        const code = required(item.taxResolution.rules[0]).resolvedRule.taxComponentCode;
        required(item.taxResolution.rules[1]).resolvedRule.taxComponentCode = code;
        required(item.taxLines[1]).explanation.taxComponentCode = code;
      },
    ],
    [
      "noncontiguous tax order",
      (q) => {
        const item = required(q.lines[0]);
        required(item.taxResolution.rules[1]).calculationOrder = 3;
        required(item.taxLines[1]).calculationOrder = 3;
      },
    ],
    [
      "tax configuration digest",
      (q) => {
        required(q.lines[0]).taxResolution.snapshotDigest = `sha256:${"f".repeat(64)}` as never;
      },
    ],
    [
      "total",
      (q) => {
        q.total.amountMinor = "1";
      },
    ],
    [
      "line subtotal",
      (q) => {
        required(q.lines[0]).subtotal.amountMinor = "1";
      },
    ],
    [
      "currency",
      (q) => {
        required(q.lines[0]).total.currencyCode = "USD" as never;
      },
    ],
    [
      "quote reference",
      (q) => {
        q.quoteReference = "sensitive-invalid-reference" as never;
      },
    ],
    [
      "digest",
      (q) => {
        q.inputDigest = "invalid" as never;
      },
    ],
    [
      "exponent",
      (q) => {
        q.currencyMetadata.minorUnitExponent = 7;
      },
    ],
    [
      "timestamp",
      (q) => {
        q.createdAt = "2026-02-30T16:00:00.000Z";
      },
    ],
    [
      "expiry",
      (q) => {
        q.expiresAt = q.createdAt;
      },
    ],
    [
      "duplicate line",
      (q) => {
        q.lines.push(required(q.lines[0]));
      },
    ],
    [
      "quantity",
      (q) => {
        required(q.lines[0]).quantity = 1000;
      },
    ],
    [
      "price amount",
      (q) => {
        required(q.lines[0]).resolvedPrice.amount.amountMinor = "1";
      },
    ],
    [
      "price priority",
      (q) => {
        required(q.lines[0]).resolvedPrice.priority = 1;
      },
    ],
    [
      "missing tax evidence",
      (q) => {
        required(q.lines[0]).taxLines.pop();
      },
    ],
    [
      "compound rule",
      (q) => {
        required(required(q.lines[0]).taxResolution.rules[1]).compoundOnPriorTax = false;
      },
    ],
    [
      "tax amount",
      (q) => {
        required(required(q.lines[0]).taxLines[0]).taxAmount.amountMinor = "1";
      },
    ],
    [
      "tax explanation",
      (q) => {
        required(required(q.lines[0]).taxLines[0]).explanation.rateNumerator = "999";
      },
    ],
    [
      "rule evidence",
      (q) => {
        required(required(q.lines[0]).taxLines[0]).ruleReference = id(99);
      },
    ],
    [
      "unknown field",
      (q) => {
        Object.assign(required(q.lines[0]), { privateNote: "sensitive-marker" });
      },
    ],
    [
      "missing field",
      (q) => {
        Reflect.deleteProperty(required(q.lines[0]), "menuVersionReference");
      },
    ],
    [
      "future adjustment",
      (q) => {
        q.discount.amountMinor = "1";
      },
    ],
    [
      "future warning",
      (q) => {
        q.warnings.push("FUTURE_WARNING");
      },
    ],
  ];
  it.each(corruptions)("rejects inconsistent %s with controlled errors", (_label, corrupt) => {
    const wire = document();
    corrupt(wire.snapshot);
    expect(() => decodePriceQuoteSnapshot(wire)).toThrowError("quote snapshot is invalid");
    try {
      decodePriceQuoteSnapshot(wire);
    } catch (error) {
      expect(error).toMatchObject({ code: "QUOTE_SNAPSHOT_INVALID" });
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
      expect(String(error)).not.toContain("sensitive");
    }
  });

  it.each(["01", "-1", "+1", "1.0", "1e3", "9223372036854775808", "", 1, 1n])(
    "rejects noncanonical or out-of-range stored amount %s",
    (amount) => {
      const wire = document();
      required(wire.snapshot.lines[0]).unitPrice.amountMinor = amount as never;
      expect(() => decodePriceQuoteSnapshot(wire)).toThrowError("quote snapshot is invalid");
    },
  );

  it("rejects unknown envelope versions, absent fields and unsafe objects without invoking getters", () => {
    const wire = document();
    for (const value of [
      null,
      [],
      { version: 2, snapshot: wire.snapshot },
      { version: 1 },
      { ...wire, extra: true },
    ])
      expect(() => decodePriceQuoteSnapshot(value)).toThrow();
    let invoked = false;
    Object.defineProperty(wire.snapshot, "total", {
      enumerable: true,
      get() {
        invoked = true;
        return null;
      },
    });
    expect(() => decodePriceQuoteSnapshot(wire)).toThrow();
    expect(invoked).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => decodePriceQuoteSnapshot(cyclic)).toThrow();
    const sparse = document();
    Reflect.deleteProperty(sparse.snapshot.lines, "0");
    expect(() => decodePriceQuoteSnapshot(sparse)).toThrow();
    const custom = Object.create({ inherited: true }) as object;
    expect(() => parsePriceQuoteSnapshot(custom)).toThrow();
  });

  it("validates native snapshots before encoding and does not accept client numeric amounts", () => {
    const quote = structuredClone(fixture()) as Mutable<PriceQuoteSnapshot>;
    quote.total.amountMinor = 1 as never;
    expect(() => encodePriceQuoteSnapshot(quote)).toThrow();
  });
});
