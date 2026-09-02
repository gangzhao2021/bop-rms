import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  PriceBookEditorScreen,
  PriceBookListScreen,
  PriceBookStatePanel,
} from "./PriceBookPages.js";
import { parsePriceBookEditorView, parsePriceBookListView } from "./price-book-pages.js";
const reference = "018fd200-0000-7000-8000-000000000001";
const list = parsePriceBookListView({
  screenId: "PRICE-BOOK-LIST",
  asOfUtc: "2026-08-13T18:00:00.000Z",
  items: [
    {
      priceBookReference: reference,
      stableCode: "CAD_BASE",
      lifecycle: "Draft",
      scopeSummary: "Brand default",
      currencyCode: "CAD",
      sourceSummary: "Brand",
      effectivePeriod: "Future 2026-09-01",
      entryCount: 3,
      coveredCount: 1,
      missingCount: 1,
      conflictCount: 1,
      aggregateVersion: 2,
    },
  ],
});
const editor = parsePriceBookEditorView({
  screenId: "PRICE-BOOK-EDITOR",
  priceBookReference: reference,
  stableCode: "CAD_BASE",
  lifecycle: "Draft",
  currencyCode: "CAD",
  aggregateVersion: 2,
  versionNumber: 2,
  scopeHierarchy: "Brand → Store → channel",
  roundingSummary: "Pinned currency metadata v1",
  taxCategorySummary: "Tax category refs validated",
  historySummary: "Draft created by a different authorized editor",
  entries: [
    {
      entryReference: "018fd200-0000-7000-8000-000000000002",
      sellableName: "Synthetic SKU",
      sellableCode: "SYNTHETIC_SKU",
      scopeSummary: "Store Queen",
      channelSummary: "Customer web / Pickup",
      amountMinor: "1299",
      effectivePeriod: "2026-09-01 onward",
      coverageStatus: "Conflict",
      reasonCode: "SYNTHETIC_PRICE",
    },
  ],
});
describe("PRICE-BOOK-LIST and PRICE-BOOK-EDITOR", () => {
  it("renders coverage, conflict, currency and fail-closed list actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PriceBookListScreen view={list} />
      </MemoryRouter>,
    );
    expect(html).toContain("PRICE-BOOK-LIST");
    expect(html).toContain("1 missing");
    expect(html).toContain("1 conflict");
    expect(html).toContain("CAD");
    expect(html).toContain("disabled");
  });
  it("renders minor-unit money, scope hierarchy and four-eyes publish actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PriceBookEditorScreen view={editor} />
      </MemoryRouter>,
    );
    expect(html).toContain("PRICE-BOOK-EDITOR");
    expect(html).toContain("1299 CAD");
    expect(html).toContain("Simulate resolution");
    expect(html).toContain("Approve");
    expect(html).toContain("Publish");
  });
  it("renders every registered state", () => {
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
    ] as const)
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <PriceBookStatePanel state={state} />
          </MemoryRouter>,
        ),
      ).toContain('role="status"');
  });
  it("rejects unsafe text and numeric money", () => {
    expect(() =>
      parsePriceBookEditorView({
        ...editor,
        entries: [{ ...editor.entries[0], amountMinor: 12.99 }],
      }),
    ).toThrow();
    expect(() =>
      parsePriceBookListView({ ...list, items: [{ ...list.items[0], scopeSummary: "<script>" }] }),
    ).toThrow();
  });
});
