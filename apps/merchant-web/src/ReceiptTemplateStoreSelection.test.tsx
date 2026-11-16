// Controlled public packets; rendered production/native acceptance belongs to the coordinator.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  ReceiptTemplateStoreSelection,
  applyReceiptTemplateStoreSelection,
  receiptTemplateStoreOptions,
} from "./ReceiptTemplateStoreSelection.js";
import { parseReceiptTemplatePublishedCurrent } from "./receipt-template-published-client.js";
import { receiptTemplateArtifactRequiredFields } from "./receipt-template-artifact-client.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const current = () =>
  parseReceiptTemplatePublishedCurrent(
    {
      profile: "DigitalReceiptTemplatePublishedCurrentV1",
      ...scope,
      templateReference: id(8),
      locale: "en",
      currentVersion: {
        templateReference: id(8),
        versionReference: id(9),
        versionNumber: 1,
        versionCode: "RECEIPT_1",
        brandReference: id(2),
        storeReference: id(3),
        locale: "en",
        dataContractVersion: 1,
        renderEngineVersion: 1,
        outputProfile: "AccessibleDigitalReceipt",
        layoutDefinitionReference: id(10),
        complianceRuleReference: id(11),
        requiredFields: receiptTemplateArtifactRequiredFields,
        publicationReference: id(12),
        publishedAt: at,
        effectiveFrom: at,
        effectiveUntil: null,
      },
      observedAt: at,
      validUntil: "2026-10-05T10:00:05.000Z",
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    },
    scope,
    id(8),
    "en",
  );
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("selection emits only stable template identity, never artifact/version/publication pins", () => {
  const selected = vi.fn();
  applyReceiptTemplateStoreSelection(current(), scope, "en", selected);
  expect(selected).toHaveBeenCalledExactlyOnceWith(id(8));
  expect(selected).not.toHaveBeenCalledWith(id(9));
  expect(selected).not.toHaveBeenCalledWith(id(12));
});
it("expired, foreign Actor or wrong store locale never updates parent draft", () => {
  const selected = vi.fn(),
    v = current();
  expect(() =>
    applyReceiptTemplateStoreSelection(v, { ...scope, actorReference: id(99) }, "en", selected),
  ).toThrow();
  expect(() => applyReceiptTemplateStoreSelection(v, scope, "fr", selected)).toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(v.validUntil));
  expect(() => applyReceiptTemplateStoreSelection(v, scope, "en", selected)).toThrow();
  expect(selected).not.toHaveBeenCalled();
});
// b24 (Owner 2026-11-16 "费用、税务和付款这个页面还是很难看"): one choice of template, a link to
// where templates are written, and no buttons to refresh, check or clear.
const selection = (
  props: Partial<Parameters<typeof ReceiptTemplateStoreSelection>[0]> & {
    value: { state: "Unconfigured" } | { state: "Configured"; value: string };
  },
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ReceiptTemplateStoreSelection
        scope={scope}
        locale="en"
        csrf={"A".repeat(43)}
        onSelect={() => undefined}
        {...props}
      />
    </MemoryRouter>,
  );
it("b24: the receipt is one choice and a link to edit templates, never a tool dump", () => {
  const html = selection({
    value: { state: "Configured", value: id(8) },
    editHref: "/app/organization/stores/x/setup?section=receipts#receipt-templates",
  });
  expect(html).toContain('aria-label="Receipt template"');
  expect(html).toContain(">The template saved in this setup</option>");
  expect(html).toContain(">None chosen yet (needed to publish)</option>");
  expect(html).toContain(">Edit receipt templates</a>");
  expect(html).not.toMatch(/Refresh|Next saved|Check published|Clear receipt|draft \d/u);
  expect(html).not.toContain("Provider ready");
  expect(html).not.toContain('value="' + id(9) + '"');
  expect(html.match(/<button/gu)).toBeNull();
});
it("WP-2423 v15: offers the template the Store issues receipts with today, and says when it is kept", () => {
  const render = (value: { state: "Unconfigured" } | { state: "Configured"; value: string }) =>
    selection({ value, liveTemplateReference: id(30) });
  const open = render({ state: "Unconfigured" });
  expect(open).toContain(">Receipt template in use today</option>");
  expect(open).toContain("needed to publish");
  const kept = render({ state: "Configured", value: id(30) });
  expect(kept).toContain("Guests get the receipt this store issues today.");
  expect(kept).not.toContain(id(30) + "</");
});
it("parent pending barrier disables the choice and a hidden step stays hidden", () => {
  const selected = vi.fn(),
    html = selection({
      hidden: true,
      disabled: true,
      value: { state: "Unconfigured" },
      onSelect: selected,
    });
  expect(html).toContain("hidden");
  expect(html.match(/disabled=""/gu)?.length).toBe(1);
  expect(html).toContain('aria-label="Receipt"');
  expect(selected).not.toHaveBeenCalled();
});
it("forged readiness and non-effective scheduled metadata cannot be applied as a current template", () => {
  const v = current(),
    selected = vi.fn();
  const corrupt = { ...v };
  Object.defineProperty(corrupt, "legalConclusion", { value: "Approved" });
  expect(() => applyReceiptTemplateStoreSelection(corrupt, scope, "en", selected)).toThrow();
  expect(() =>
    applyReceiptTemplateStoreSelection(
      { ...v, currentVersion: { ...v.currentVersion, effectiveFrom: "2026-10-06T10:00:00.000Z" } },
      scope,
      "en",
      selected,
    ),
  ).toThrow();
  expect(selected).not.toHaveBeenCalled();
});
it("WP-2423: always offers the receipt template the Store started with, in plain words", () => {
  // The Store moved to a template written in the product: the installed one is offered too.
  expect(
    receiptTemplateStoreOptions({ live: id(31), startedWith: id(30), saved: [id(31)] }),
  ).toEqual([{ value: id(30), label: "Receipt template the Store started with" }]);
  expect(receiptTemplateStoreOptions({ live: id(31), startedWith: id(30), saved: [] })).toEqual([
    { value: id(31), label: "Receipt template in use today" },
    { value: id(30), label: "Receipt template the Store started with" },
  ]);
  // Still on the installed template: one entry, said once.
  expect(receiptTemplateStoreOptions({ live: id(30), startedWith: id(30), saved: [] })).toEqual([
    {
      value: id(30),
      label: "Receipt template in use today (the one the Store started with)",
    },
  ]);
  // Not found (yet): nothing invented.
  expect(receiptTemplateStoreOptions({ live: null, startedWith: null, saved: [id(31)] })).toEqual(
    [],
  );
  for (const option of receiptTemplateStoreOptions({
    live: id(31),
    startedWith: id(30),
    saved: [],
  }))
    expect(option.label).not.toMatch(/RECEIPT_|[0-9a-f]{8}-/u);
});
