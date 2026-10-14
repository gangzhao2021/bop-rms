import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { ReceiptPage } from "./ReceiptPage.js";
import { parseReceiptView, type ReceiptController } from "./receipt-controller.js";
import type { ReceiptState } from "./types.js";
import { ContactDetailsSection } from "../order-status/ContactDetailsSection.js";
import { parsePrivacyNoticeUrl } from "../journey/PrivacyNotice.js";

/** WP-2423 Q15/Q16: tax receipt facts, privacy link and the contact section, as customers see them. */
const id = (n: number) => `018f8a15-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const wire = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
// TEST-ONLY registration number: shaped like a CRA number, not a real registration.
const taxDetails = {
  businessAddress: {
    addressLines: ["1 Test-only Street"],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "M5V 0A0",
    countryCode: "CA",
  },
  taxRegistrations: [{ label: "GST/HST", number: "000000000RT0001" }],
  taxLines: [
    { label: "GST", ratePercent: "5", included: false, amount: wire("50") },
    { label: "PST", ratePercent: "7", included: false, amount: wire("70") },
  ],
  paymentMethod: "Card",
};
function payload(snapshotExtra: Record<string, unknown> = { taxDetails }, extra = {}) {
  return {
    orderReference: id(1),
    freshnessStatus: "Stale",
    deliveryStatus: "Unavailable",
    supportEligible: false,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-10-14T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Issuer Ltd.",
          storeDisplayName: "Synthetic Store",
          orderNumber: "12",
          issuedAt: "2026-10-14T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: wire("1000"),
            },
          ],
          subtotal: wire("1000"),
          tax: wire("120"),
          tip: wire("0"),
          total: wire("1120"),
          paymentStatus: "PartiallyRefunded",
          refundedTotal: wire("100"),
          ...snapshotExtra,
        },
      },
    ],
    ...extra,
  };
}
function render(state: ReceiptState) {
  const controller: ReceiptController = {
    getState: () => state,
    subscribe: () => () => undefined,
    load: async () => undefined,
    setOnline: () => undefined,
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/orders/${id(1)}/receipt`]}>
      <Routes>
        <Route
          path="/orders/:orderReference/receipt"
          element={<ReceiptPage controller={controller} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WP-2423 Q15 tax receipt", () => {
  it("shows the address, registration, each tax with its rate, and the payment method", () => {
    const view = parseReceiptView(
      payload({ taxDetails }, { privacyNoticeUrl: "https://example.test/privacy" }),
      id(1),
    );
    const html = render({ status: "ready", view });
    expect(html).toContain("1 Test-only Street");
    expect(html).toContain("Toronto ON M5V 0A0");
    expect(html).toContain("GST/HST registration no. 000000000RT0001");
    expect(html).toContain("GST 5%");
    expect(html).toContain("$0.50");
    expect(html).toContain("PST 7%");
    expect(html).toContain("$0.70");
    expect(html).toContain("Card · Partly refunded");
    expect(html).not.toContain("PartiallyRefunded");
    expect(html).toContain('href="https://example.test/privacy"');
    expect(html).toContain("Privacy notice");
  });
  it("omits the registration line and the link when the Store has none, and keeps old receipts", () => {
    const none = parseReceiptView(
      payload({ taxDetails: { ...taxDetails, taxRegistrations: [], businessAddress: null } }),
      id(1),
    );
    const html = render({ status: "ready", view: none });
    expect(html).not.toContain("registration no.");
    expect(html).not.toContain("Privacy notice");
    expect(html).toContain("GST 5%");
    const old = render({ status: "ready", view: parseReceiptView(payload({}), id(1)) });
    expect(old).toContain("<dt>Tax</dt>");
  });
  it("rejects tax lines that do not add up and unsafe privacy links", () => {
    expect(() =>
      parseReceiptView(
        payload({ taxDetails: { ...taxDetails, taxLines: [taxDetails.taxLines[0]] } }),
        id(1),
      ),
    ).toThrow();
    expect(() =>
      parseReceiptView(payload({ taxDetails }, { privacyNoticeUrl: "javascript:alert(1)" }), id(1)),
    ).toThrow();
    expect(() => parsePrivacyNoticeUrl("http://example.test/privacy")).toThrow();
  });
});

describe("WP-2423 Q16 contact details on the order page", () => {
  const section = (contactDetails: "Stored" | "Removed" | "NotGiven" | undefined, url?: string) =>
    renderToStaticMarkup(
      <ContactDetailsSection
        orderReference={id(1)}
        contactDetails={contactDetails}
        privacyNoticeUrl={url}
        storeName="Synthetic Store"
        client={{ remove: async () => "Removed" }}
        onChanged={() => undefined}
      />,
    );
  it("says what is kept and why, for how long, and offers removal", () => {
    const html = section("Stored", "https://example.test/privacy");
    expect(html).toContain("only to contact you about this order");
    expect(html).toContain("30 days");
    expect(html).toContain("Remove my contact details");
    expect(html).toContain("Privacy notice");
  });
  it("confirms a removal and shows nothing when there is nothing to say", () => {
    expect(section("Removed")).toContain("have been removed");
    expect(section("Removed")).not.toContain("Remove my contact details");
    expect(section("NotGiven")).toBe("");
    expect(section(undefined)).toBe("");
  });
});
