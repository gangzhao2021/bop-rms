/** A paid order's receipt, as the API answers it. Synthetic. */
const id = (n: number) => "018f8815-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const orderReference = id(1);
const privacyNoticeUrl = "https://example.test/privacy";
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

export function receipt(withPrivacy: boolean) {
  return {
    schemaVersion: 1,
    receipt: {
      orderReference,
      freshnessStatus: "Stale",
      deliveryStatus: "Unavailable",
      supportEligible: false,
      cancellationEligible: false,
      ...(withPrivacy ? { privacyNoticeUrl } : {}),
      records: [
        {
          recordReference: id(2),
          version: 1,
          kind: "Original",
          recordedAt: "2026-10-14T14:00:00.000Z",
          reasonCode: null,
          snapshot: {
            receiptReference: id(3),
            operatingEntityDisplayName: "Synthetic Issuer Ltd. (TEST-ONLY)",
            storeDisplayName: "Synthetic Receipt Store",
            orderNumber: "12",
            issuedAt: "2026-10-14T14:00:00.000Z",
            locale: "en-CA",
            lines: [
              {
                lineReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 1,
                // WP-2423 D5: the frozen total after tax, and the price before tax that is printed.
                lineTotal: money("1130"),
                lineSubtotal: money("1000"),
              },
            ],
            subtotal: money("1000"),
            tax: money("130"),
            taxDetails: {
              businessAddress: {
                addressLines: ["1 Test-only Street"],
                locality: "Toronto",
                regionCode: "ON",
                postalCode: "M5V 0A0",
                countryCode: "CA",
              },
              taxRegistrations: withPrivacy
                ? [{ label: "GST/HST", number: "000000000RT0001" }]
                : [],
              taxLines: [
                { label: "HST", ratePercent: "13", included: false, amount: money("130") },
              ],
              paymentMethod: "Card",
            },
            tip: money("0"),
            total: money("1130"),
            paymentStatus: "Paid",
            refundedTotal: money("0"),
          },
        },
      ],
    },
  };
}
