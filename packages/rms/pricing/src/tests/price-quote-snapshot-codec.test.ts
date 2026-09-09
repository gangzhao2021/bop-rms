import { describe, expect, it, vi } from "vitest";
import {
  createPriceQuote,
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
  PriceQuoteSnapshotCodecError,
  parsePricingReference,
  parsePricingCode,
  type PriceQuoteSnapshot,
} from "../index.js";
import { input } from "./price-quote.fixture.js";

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
function item<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("fixture requires an item");
  return value;
}
const fixture = () => createPriceQuote(input());
const copy = () => structuredClone(fixture()) as unknown as Mutable<PriceQuoteSnapshot>;
const id = parsePricingReference("018fb000-0000-7000-8000-000000000099");
function rejected(value: unknown) {
  expect(() => encodePriceQuoteSnapshot(value as PriceQuoteSnapshot)).toThrow(
    PriceQuoteSnapshotCodecError,
  );
}

describe("complete immutable PriceQuote snapshot codec", () => {
  it("round trips every historical field as immutable independent data", () => {
    const quote = fixture();
    const text = encodePriceQuoteSnapshot(quote);
    const result = decodePriceQuoteSnapshot(text);
    expect(result).toEqual(quote);
    expect(result).not.toBe(quote);
    expect(result.lines[0]?.taxLines[0]?.explanation).not.toBe(
      quote.lines[0]?.taxLines[0]?.explanation,
    );
    const frozen = (v: unknown): void => {
      if (v !== null && typeof v === "object") {
        expect(Object.isFrozen(v)).toBe(true);
        Object.values(v).forEach(frozen);
      }
    };
    frozen(result);
    expect(encodePriceQuoteSnapshot(result)).toBe(text);
    expect(text).toContain('"amountMinor":"2260"');
  });
  it("preserves amounts above Number safe precision", () => {
    const source = input();
    const entry = item(source.priceBook.entries);
    const quote = createPriceQuote({
      ...source,
      priceBook: {
        ...source.priceBook,
        entries: [{ ...entry, amount: { ...entry.amount, amountMinor: 9007199254740993n } }],
      },
    });
    const result = decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote));
    expect(result.lines[0]?.unitPrice.amountMinor).toBe(9007199254740993n);
    expect(result).toEqual(quote);
  });
  it("retains compound tax bases and explanations", () => {
    const source = input();
    const first = item(source.taxConfiguration.rules);
    const quote = createPriceQuote({
      ...source,
      taxConfiguration: {
        ...source.taxConfiguration,
        rules: [
          first,
          {
            ...first,
            ruleReference: id,
            taxComponentCode: parsePricingCode("SECOND_TAX"),
            calculationOrder: 2,
            compoundOnPriorTax: true,
          },
        ],
      },
    });
    expect(quote.tax.amountMinor).toBe(554n);
    expect(decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote))).toEqual(quote);
  });
  it.each(["Exempt", "ZeroRated"] as const)(
    "retains %s explanations without inventing evidence",
    (treatment) => {
      const source = input();
      const first = item(source.taxConfiguration.rules);
      const quote = createPriceQuote({
        ...source,
        taxConfiguration: {
          ...source.taxConfiguration,
          rules: [{ ...first, treatment, rate: "0" as never, exceptionEvidenceReference: id }],
        },
      });
      expect(quote.tax.amountMinor).toBe(0n);
      expect(decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote))).toEqual(quote);
    },
  );
  it("round trips multiple lines sharing the same immutable price entry", () => {
    const source = input();
    const quote = createPriceQuote({
      ...source,
      lines: [...source.lines, { ...item(source.lines), lineReference: id, quantity: 3 }],
    });
    expect(decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote))).toEqual(quote);
  });
  it.each(["price version", "tax version", "entry facts", "rule facts"])(
    "rejects inconsistent cross-line %s",
    (kind) => {
      const source = input();
      const quote = structuredClone(
        createPriceQuote({
          ...source,
          lines: [...source.lines, { ...item(source.lines), lineReference: id }],
        }),
      ) as unknown as Mutable<PriceQuoteSnapshot>;
      const line = item(quote.lines);
      if (kind === "price version") line.resolvedPrice.versionReference = id;
      if (kind === "tax version") line.taxResolution.versionReference = id;
      if (kind === "entry facts") line.resolvedPrice.reasonCode = parsePricingCode("OTHER_REASON");
      if (kind === "rule facts")
        item(line.taxResolution.rules).receiptPresentationCode = parsePricingCode("OTHER_RECEIPT");
      rejected(quote);
    },
  );
  it("is independent of native property order and caller mutations", () => {
    const source = copy();
    const reversed = Object.fromEntries(
      Object.entries(source).reverse(),
    ) as unknown as PriceQuoteSnapshot;
    const text = encodePriceQuoteSnapshot(reversed);
    expect(text).toBe(encodePriceQuoteSnapshot(fixture()));
    item(source.lines).total.amountMinor = 999n;
    expect(decodePriceQuoteSnapshot(text)).toEqual(fixture());
  });
  it.each([
    [
      "root total",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.total.amountMinor++;
      },
    ],
    [
      "line total",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).total.amountMinor++;
      },
    ],
    [
      "line quantity",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).quantity = 1000;
      },
    ],
    [
      "unit source",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).resolvedPrice.amount.amountMinor++;
      },
    ],
    [
      "currency",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.total.currencyCode = "USD" as never;
      },
    ],
    [
      "tax proof",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(item(q.lines).taxLines).explanation.rateNumerator = "14";
      },
    ],
    [
      "tax amount",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(item(q.lines).taxLines).taxAmount.amountMinor++;
      },
    ],
    [
      "tax reference",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(item(q.lines).taxLines).ruleReference = id;
      },
    ],
    [
      "tax order",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(item(q.lines).taxResolution.rules).calculationOrder = 2;
      },
    ],
    [
      "first compound",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(item(q.lines).taxResolution.rules).compoundOnPriorTax = true;
      },
    ],
    [
      "tax provenance",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).taxResolution.snapshotDigest = `sha256:${"c".repeat(64)}` as never;
      },
    ],
    [
      "price priority",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).resolvedPrice.priority = 1;
      },
    ],
    [
      "price scope",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).resolvedPrice.scopeReference = id;
      },
    ],
    [
      "sellable",
      (q: Mutable<PriceQuoteSnapshot>) => {
        item(q.lines).resolvedPrice.sellableReference = id;
      },
    ],
    [
      "duplicate line",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.lines.push(item(q.lines));
      },
    ],
    [
      "expiry",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.expiresAt = q.createdAt;
      },
    ],
    [
      "impossible date",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.createdAt = "2026-02-30T16:00:00.000Z";
      },
    ],
    [
      "ineffective price",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.createdAt = "2026-07-01T16:00:00.000Z";
      },
    ],
    [
      "unsupported promotion",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.appliedPromotionReferences.push(id);
      },
    ],
    [
      "discount",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.discount.amountMinor = 1n;
      },
    ],
    [
      "overflow",
      (q: Mutable<PriceQuoteSnapshot>) => {
        q.total.amountMinor = 2n ** 63n;
      },
    ],
  ] as const)("rejects inconsistent %s", (_label, mutate) => {
    const quote = copy();
    mutate(quote);
    rejected(quote);
  });
  it.each(["metadataVersionReference", "minorUnitExponent"])(
    "rejects missing metadata %s",
    (key) => {
      const q = copy();
      Reflect.deleteProperty(q.currencyMetadata, key);
      rejected(q);
    },
  );
  it("does not invoke nested getters or toJSON", () => {
    const getter = vi.fn(() => 1000n);
    const q = copy();
    Object.defineProperty(q.total, "amountMinor", { get: getter });
    rejected(q);
    const toJSON = vi.fn(() => ({}));
    rejected({ ...fixture(), toJSON });
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
  it("rejects symbols, hidden fields, cycles, custom prototypes and array extras", () => {
    rejected({ ...fixture(), [Symbol("extra")]: true });
    const hidden = copy();
    Object.defineProperty(hidden, "extra", { value: true });
    rejected(hidden);
    const cyclic = copy();
    Object.defineProperty(cyclic, "extra", { value: cyclic, enumerable: true });
    rejected(cyclic);
    rejected(Object.assign(Object.create({ inherited: true }), fixture()));
    const array = copy();
    Object.defineProperty(array.lines, "extra", { value: true, enumerable: true });
    rejected(array);
    const sparse = copy();
    Reflect.deleteProperty(sparse.lines, "0");
    rejected(sparse);
  });
  it("rejects native string/Number money", () => {
    for (const amountMinor of ["2260", 2260])
      rejected({ ...fixture(), total: { amountMinor, currencyCode: "CAD" } });
  });
  it.each([
    ["whitespace", (s: string) => ` ${s}`],
    [
      "duplicate key",
      (s: string) => s.replace('"codecVersion":1', '"codecVersion":1,"codecVersion":1'),
    ],
    ["future version", (s: string) => s.replace('"codecVersion":1', '"codecVersion":2')],
    ["Number money", (s: string) => s.replace('"amountMinor":"2260"', '"amountMinor":2260')],
    ["leading zero", (s: string) => s.replace('"amountMinor":"2260"', '"amountMinor":"02260"')],
    ["negative zero", (s: string) => s.replace('"amountMinor":"0"', '"amountMinor":"-0"')],
    ["exponent", (s: string) => s.replace('"amountMinor":"2260"', '"amountMinor":"2.260e3"')],
    ["unknown field", (s: string) => s.replace('"codecVersion":1', '"unknown":0,"codecVersion":1')],
    ["arithmetic", (s: string) => s.replace('"amountMinor":"2260"', '"amountMinor":"2261"')],
  ] as const)("rejects encoded %s", (_label, mutate) => {
    expect(() => decodePriceQuoteSnapshot(mutate(encodePriceQuoteSnapshot(fixture())))).toThrow(
      PriceQuoteSnapshotCodecError,
    );
  });
  it("bounds malformed, deep and oversized input with fixed errors", () => {
    for (const text of [
      "private invalid input",
      " ".repeat(16 * 1024 * 1024 + 1),
      "[".repeat(30) + "0" + "]".repeat(30),
    ]) {
      try {
        decodePriceQuoteSnapshot(text);
        throw new Error("accepted invalid input");
      } catch (error) {
        expect(error).toBeInstanceOf(PriceQuoteSnapshotCodecError);
        expect((error as Error).message).toBe("price quote snapshot is invalid");
        expect(Object.keys(error as object)).toEqual(["code", "name"]);
      }
    }
  });
});
