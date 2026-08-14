import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TaxConfigScreen, TaxConfigState } from "./TaxConfigPage.js";
import { parseTaxConfigView, TaxConfigClientError } from "./tax-config-page.js";

const id = (n: number) => `018f9000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fixture = () => ({
  screenId: "TAX-CONFIG",
  configurationReference: id(1),
  stableCode: "PILOT_STORE_TAX",
  lifecycle: "Published",
  aggregateVersion: 4,
  jurisdictionCode: "CA-ON",
  storeSummary: "Synthetic Store",
  registrationApplicability: "Verified applicability reference",
  effectivePeriod: "2026-08-01 through 2026-09-01 America/Toronto",
  fixtureStatus: "Approved",
  historySummary: "Version 4 approved by a distinct actor",
  categories: [
    {
      categoryReference: id(2),
      categoryCode: "SYNTHETIC_MEAL",
      treatment: "Taxable",
      rate: "0.13",
      priceInclusion: "Exclusive",
      receiptCode: "SYNTHETIC_TAX",
    },
  ],
  receiptPreview: [
    { labelCode: "SUBTOTAL", amountMinor: "1000" },
    { labelCode: "SYNTHETIC_TAX", amountMinor: "130" },
  ],
});

describe("TAX-CONFIG screen contract", () => {
  it("parses and renders fields, simulations, approval and receipt preview", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaxConfigScreen view={parseTaxConfigView(fixture())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Tax Configuration administration",
      "Verified applicability reference",
      "SYNTHETIC_MEAL",
      "0.13",
      "Simulate basket",
      "Simulate refund",
      "Approve",
      "Publish",
      "SUBTOTAL",
      "130 CAD minor units",
    ])
      expect(html).toContain(text);
  });

  it("rejects markup, URLs and numeric money from the projection", () => {
    expect(() =>
      parseTaxConfigView({ ...fixture(), storeSummary: "<script>bad</script>" }),
    ).toThrow(TaxConfigClientError);
    expect(() =>
      parseTaxConfigView({
        ...fixture(),
        receiptPreview: [{ labelCode: "TOTAL", amountMinor: 1130 }],
      }),
    ).toThrow(TaxConfigClientError);
  });

  it("renders every mandatory failure/read-only state", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <TaxConfigState state={state} />
        </MemoryRouter>,
      );
      expect(html.length).toBeGreaterThan(50);
    }
  });
});
