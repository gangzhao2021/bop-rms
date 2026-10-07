import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import {
  OptionSetListPage,
  OptionSetListRecords,
  OptionSetListState,
} from "./OptionSetListPage.js";
import { parseOptionSetListView } from "./option-set-list-client.js";
const id = (n: number) => "01902421-7910-7000-8000-" + n.toString(16).padStart(12, "0");
function view() {
  const at = "2026-10-05T12:00:00.000Z";
  return parseOptionSetListView({
    projection: {
      name: "catalog_option_set_search_v1",
      version: 1,
      asOfUtc: at,
      stale: false,
      partial: true,
      sourceGeneration: "sha256:" + "a".repeat(64),
    },
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
    },
    locale: "fr-CA",
    hasMore: false,
    nextCursor: null,
    items: [
      {
        optionSetReference: id(10),
        internalCode: "SYNTHETIC_CHOICE",
        lifecycle: "Draft",
        aggregateVersion: 2,
        draftVersionReference: id(11),
        createdAt: at,
        updatedAt: at,
        name: "Synthetic choices",
        nameLocale: "en-CA",
        localeFallback: true,
        selectionRule: {
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 2,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 2,
        },
        optionCount: 2,
        activeOptionCount: 0,
        productBindingCount: 1,
        recordedPricingReference: { status: "Known", present: true },
        recordedConsumptionReference: { status: "Unknown" },
        recordedConflict: { status: "Known", present: false },
        publishingStatus: { status: "Unavailable" },
        referenceEligibility: "NotEvaluated",
      },
    ],
  });
}
it("renders complete current summaries, preserved total counts and canonical Detail entry", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OptionSetListRecords view={view()} />
    </MemoryRouter>,
  );
  expect(html).toContain("Synthetic choices");
  expect(html).toContain("SYNTHETIC_CHOICE");
  expect(html).toContain(`/app/commerce/option-sets/${id(10)}`);
  expect(html).toContain("Draft version 2");
  expect(html).toContain("0 active / 2 total");
  expect(html).toContain("1 recorded Product bindings");
  expect(html).toContain("Name in en-CA (locale fallback)");
  expect(html).toContain("Consumption: Unknown");
  expect(html).toContain("Conflict: Not recorded");
  expect(html).not.toContain(id(11));
  expect(html).not.toContain("Published");
  expect(html).not.toContain("CAD");
  expect(html).toContain('scope="col"');
  expect(html).toContain('scope="row"');
});
it("requires a selected Store without issuing a misleading empty list or Create permission", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OptionSetListPage brandReference={null} storeReference={null} csrf={"A".repeat(43)} />
    </MemoryRouter>,
  );
  expect(html).toContain("Select a Store");
  expect(html).not.toContain("No Option Sets");
  expect(html).not.toContain("Create Option Set");
});
it("starts at loading with accessible live filters and explicit partial publication boundary", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OptionSetListPage
        brandReference={null}
        storeReference={id(3)}
        storeLabel="Synthetic Store"
        csrf={"A".repeat(43)}
      />
    </MemoryRouter>,
  );
  for (const label of [
    "Loading Option Sets",
    "Synthetic Store",
    "Search names, codes or Options",
    "Locale",
    "Recorded Product bindings",
    "Recorded pricing references",
    "Recorded consumption references",
    "Recorded conflicts",
    "Missing translation locale",
    "Sort direction",
    "Refresh first page",
    "Next page",
  ])
    expect(html).toContain(label);
  expect(html).toContain("Publishing status unavailable; reference eligibility not evaluated");
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("Create Option Set");
  expect(html).not.toContain('value="Published"');
  expect(html).not.toContain(id(3));
});
it.each([
  "Loading",
  "Empty",
  "Denied",
  "FeatureDisabled",
  "Stale",
  "Offline",
  "ScopeChanged",
  "Unavailable",
  "Invalid",
] as const)("renders %s as an explicit accessible state", (state) => {
  const html = renderToStaticMarkup(<OptionSetListState state={state} />);
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Create Option Set");
  if (state === "Stale") expect(html).toContain("Refresh the first page");
});
