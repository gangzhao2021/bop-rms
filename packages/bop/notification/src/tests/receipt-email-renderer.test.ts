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
