import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import {
  CatalogProductListPage,
  ProductListRecords,
  ProductListState,
} from "./CatalogProductListPage.js";
import { parseProductListView } from "./catalog-product-list-client.js";
// Isolated fixture, not a production row or business acceptance result.
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function view() {
  const unavailable = { status: "Unavailable" };
  return parseProductListView(
    {
      projection: {
        name: "catalog_product_search_v1",
        version: 1,
        asOfUtc: "2026-09-28T12:00:00.000Z",
        stale: false,
        partial: true,
      },
      scope: { brandReference: id(2), storeReference: id(3) },
      locale: "en-CA",
      hasMore: false,
      nextCursor: null,
      items: [
        {
          productReference: id(10),
          internalCode: "SYNTH_TEA",
          name: "Synthetic tea",
          nameLocale: "fr-CA",
          localeFallback: true,
          productType: "PreparedFood",
          lifecycle: "Active",
          aggregateVersion: 7,
          updatedAt: "2026-09-28T12:00:00.000Z",
          createdAt: "2026-09-28T12:00:00.000Z",
          source: { productVersionReference: id(11), configuration: "Draft" },
          skuCount: 3,
          activeSkuCount: 1,
          category: unavailable,
          menuCount: unavailable,
          availability: unavailable,
          storeCoverage: unavailable,
          tax: unavailable,
          updatedBy: unavailable,
        },
      ],
    },
    id(3),
  );
}
it("renders actual named Draft facts and unavailable summaries without raw references or safety/pricing inference", () => {
  const html = renderToStaticMarkup(<ProductListRecords view={view()} />);
  expect(html).toContain("Synthetic tea");
  expect(html).toContain("Draft configuration");
  expect(html).toContain("1 active / 3 total");
  expect(html).toContain("Name in fr-CA");
  expect(html).toContain("Unavailable");
  expect(html).not.toContain(id(10));
  expect(html).not.toContain(id(11));
  expect(html).not.toContain("CAD");
  expect(html).not.toContain("allergen");
});
it("renders source-backed zero active SKUs, not unknown as zero", () => {
  const value = view();
  const row = value.items[0];
  if (!row) throw new Error("fixture missing");
  const html = renderToStaticMarkup(
    <ProductListRecords view={{ ...value, items: [{ ...row, skuCount: 0, activeSkuCount: 0 }] }} />,
  );
  expect(html).toContain("0 active / 0 total");
  expect(html).toContain("Tax unavailable");
});
it("renders empty filters distinctly from unavailable source", () => {
  expect(renderToStaticMarkup(<ProductListRecords view={{ ...view(), items: [] }} />)).toContain(
    "No products match these filters",
  );
  expect(renderToStaticMarkup(<ProductListState state="Unavailable" />)).toContain(
    "Product data unavailable",
  );
});
it.each([
  "Denied",
  "FeatureDisabled",
  "Stale",
  "NotFound",
  "Conflict",
  "CommandFailed",
  "Offline",
] as const)("renders explicit non-color %s state without fixture facts", (state) => {
  const html = renderToStaticMarkup(<ProductListState state={state} />);
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Synthetic tea");
});
it("normal screen starts loading with disabled unsupported actions and accessible filters", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CatalogProductListPage
        storeReference={id(3)}
        storeLabel="Synthetic Store"
        brandLabel="Synthetic Brand"
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Loading products");
  expect(html).toContain("Apply filters");
  expect(html).toContain("Has active SKUs");
  expect(html).toContain("Draft name missing locale");
  expect(html).toContain("a fallback name does not count as a translation");
  expect(html).toContain("No active SKUs");
  expect(html).toContain("Updated from (UTC, included)");
  expect(html).toContain("Updated until (UTC, excluded)");
  expect(html).toContain("datetime-local");
  expect(html).toContain("Created from (UTC, included)");
  expect(html).toContain("Created until (UTC, excluded)");
  expect(html).toContain("Sort products by");
  expect(html).toContain("Sort direction");
  expect(html).toContain('value="name">Name</option>');
  expect(html).not.toContain("Name · unavailable");
  expect(html).not.toContain("Name and publishing-status sorting are unavailable");
  expect(html).toContain("Publishing-status sorting is unavailable");
  expect(html).toContain("Create product · unavailable");
  expect(html).toContain('aria-label="Product pages"');
  expect(html).not.toContain("SYNTH_TEA");
});

it("renders current primary Category name/fallback and known-not-set without raw source references", () => {
  const base = view();
  const category = {
    status: "Known" as const,
    configuration: "Draft" as const,
    primary: {
      categoryReference: id(20),
      name: "Catégorie synthétique",
      nameLocale: "fr-CA",
      localeFallback: true,
    },
    matchedCategoryReference: null,
    source: { revision: "7", digest: "sha256:" + "2".repeat(64), asOfUtc: base.projection.asOfUtc },
  };
  const known = { ...base, items: base.items.map((row) => ({ ...row, category })) };
  const html = renderToStaticMarkup(<ProductListRecords view={known} />);
  expect(html).toContain("Catégorie synthétique");
  expect(html).toContain("Draft classification");
  expect(html).toContain("Name in fr-CA");
  expect(html).not.toContain(id(20));
  expect(html).not.toContain(category.source.digest);
  expect(html).not.toContain("Primary category not set");
  const empty = {
    ...base,
    items: base.items.map((row) => ({ ...row, category: { ...category, primary: null } })),
  };
  expect(renderToStaticMarkup(<ProductListRecords view={empty} />)).toContain(
    "Primary category not set",
  );
  expect(renderToStaticMarkup(<ProductListRecords view={base} />)).not.toContain(
    "Primary category not set",
  );
});

it("renders canonical history navigation only when enabled and keeps read revision out of URL", () => {
  const value = view(),
    row = value.items[0];
  if (!row) throw Error("fixture missing");
  const hidden = renderToStaticMarkup(<ProductListRecords view={value} />);
  expect(hidden).not.toContain("Publication history");
  const visible = renderToStaticMarkup(
    <MemoryRouter>
      <ProductListRecords view={value} historyNavigation />
    </MemoryRouter>,
  );
  expect(visible).toContain(`/app/commerce/products/${row.productReference}/edit`);
  expect(visible).not.toContain("?expectedAggregateVersion");
});
