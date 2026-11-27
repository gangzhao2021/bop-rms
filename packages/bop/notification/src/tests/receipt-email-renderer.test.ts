import { describe, expect, it } from "vitest";
import { ReceiptEmailTemplateError, renderReceiptEmail } from "../index.js";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    locale: "en-CA",
    storeDisplayName: "Synthetic Store",
    orderNumber: "1001",
    issuedAt: "2026-08-12T14:00:00.000Z",
    lines: [
      { displayName: "Synthetic bowl", quantity: 1, amountMinor: 1000n, currencyCode: "CAD" },
    ],
    subtotalMinor: 1000n,
    taxMinor: 130n,
    tipMinor: 0n,
    totalMinor: 1130n,
    currencyCode: "CAD",
    ...overrides,
  };
}

describe("transactional receipt email renderer", () => {
  it.each([
    ["en-CA", "Your receipt is ready", "Your receipt", "CA$11.30"],
    ["fr-CA", "Votre reçu est prêt", "Votre reçu", "11,30 $ CA"],
  ] as const)(
    "renders localized equivalent plain text and accessible HTML for %s",
    (locale, subject, heading, total) => {
      const output = renderReceiptEmail(fixture({ locale }));
      expect(output.subject).toBe(subject);
      expect(output.text).toContain(heading);
      expect(output.text).toContain(total);
      expect(output.html).toContain(`<html lang="${locale}">`);
      expect(output.html).toContain(`<h1>${heading}</h1>`);
      expect(output.html).toContain("<table");
      expect(output.html).toContain(total);
      expect(output.headers["Content-Language"]).toBe(locale);
    },
  );

  it("escapes untrusted display values and emits no active or remote content", () => {
    const attack = `<script>alert('x')</script><img src="https://tracker.invalid/pixel">`;
    const output = renderReceiptEmail(
      fixture({
        storeDisplayName: attack,
        lines: [{ displayName: attack, quantity: 1, amountMinor: 1000n, currencyCode: "CAD" }],
      }),
    );
    expect(output.html).toContain("&lt;script&gt;");
    expect(output.html).not.toMatch(
      /<script|<img|<form|<a\s|(?:src|href)=["']https?:\/\/|onerror=|onclick=/iu,
    );
    expect(output.subject).not.toContain("1001");
    expect(JSON.stringify(output.headers)).not.toMatch(/[\r\n]/u);
  });

  it.each([
    () => fixture({ locale: "en-US" }),
    () => fixture({ currencyCode: "USD" }),
    () => fixture({ totalMinor: 1129n }),
    () => ({ ...fixture(), secret: "open-bag" }),
    () => fixture({ storeDisplayName: "bad\r\nBcc: victim@example.test" }),
  ])("rejects malformed or unsafe input %#", (candidate) => {
    expect(() => renderReceiptEmail(candidate())).toThrow(ReceiptEmailTemplateError);
  });

  it("rejects an accessor without invoking it", () => {
    const candidate = fixture();
    let invoked = false;
    Object.defineProperty(candidate, "orderNumber", {
      enumerable: true,
      get() {
        invoked = true;
        return "1001";
      },
    });
    expect(() => renderReceiptEmail(candidate)).toThrow(ReceiptEmailTemplateError);
    expect(invoked).toBe(false);
  });
});

describe("receipt adjustments", () => {
  it.each([
    ["en-CA", "Discount: -CA$2.00", "Fees: CA$0.50", "CA$9.80"],
    ["fr-CA", "Remise: -2,00 $ CA", "Frais: 0,50 $ CA", "9,80 $ CA"],
  ])(
    "renders explicit discount and fees in both formats for %s",
    (locale, discount, fee, total) => {
      const output = renderReceiptEmail(
        fixture({
          locale,
          adjustments: { discountMinor: 200n, feeMinor: 50n },
          totalMinor: 980n,
        }),
      );
      expect(output.text).toContain(discount);
      expect(output.text).toContain(fee);
      expect(output.text).toContain(total);
      expect(output.html).toContain(discount.split(": ")[0]);
      expect(output.html).toContain(fee.split(": ")[0]);
      expect(output.html).toContain(total);
    },
  );

  it("preserves legacy output without adjustment rows", () => {
    const output = renderReceiptEmail(fixture());
    expect(output.text).not.toMatch(/Discount|Fees/);
    expect(output.html).not.toMatch(/Discount|Fees/);
  });

  it.each([
    undefined,
    null,
    {},
    { discountMinor: 0n },
    { discountMinor: -1n, feeMinor: 0n },
    { discountMinor: 1001n, feeMinor: 0n },
    { discountMinor: 0n, feeMinor: 9223372036854775808n },
    { discountMinor: 0, feeMinor: 0n },
    { discountMinor: 0n, feeMinor: 0n, currencyCode: "USD" },
    { discountMinor: 1n, feeMinor: 0n },
  ])("rejects malformed pairs and inconsistent totals %#", (adjustments) => {
    expect(() => renderReceiptEmail(fixture({ adjustments }))).toThrow(ReceiptEmailTemplateError);
  });

  it("does not invoke an adjustment accessor", () => {
    let invoked = false;
    const adjustments = { feeMinor: 0n };
    Object.defineProperty(adjustments, "discountMinor", {
      enumerable: true,
      get() {
        invoked = true;
        return 0n;
      },
    });
    expect(() => renderReceiptEmail(fixture({ adjustments }))).toThrow(ReceiptEmailTemplateError);
    expect(invoked).toBe(false);
  });
});

it("renders int64 money without rounding through a Number", () => {
  const max = 9223372036854775807n;
  const output = renderReceiptEmail(
    fixture({
      subtotalMinor: max,
      taxMinor: 0n,
      totalMinor: max,
      adjustments: { discountMinor: 1n, feeMinor: 1n },
      lines: [
        { displayName: "Synthetic item", quantity: 1, amountMinor: max, currencyCode: "CAD" },
      ],
    }),
  );
  expect(output.text).toContain("CA$92233720368547758.07");
  expect(output.html).toContain("CA$92233720368547758.07");
});
