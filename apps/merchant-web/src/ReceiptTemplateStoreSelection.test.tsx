// Controlled public packets; rendered production/native acceptance belongs to the coordinator.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReceiptTemplateStoreSelection,
  applyReceiptTemplateStoreSelection,
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
it("rendered entry keeps discovery separate from current qualification and saves parent separately", () => {
  const html = renderToStaticMarkup(
    <ReceiptTemplateStoreSelection
      scope={scope}
      locale="en"
      csrf={"A".repeat(43)}
      value={{ state: "Configured", value: id(8) }}
      onSelect={() => undefined}
    />,
  );
  expect(html).toContain("Saved templates");
  expect(html).toContain("Check published receipt template");
  expect(html).toContain("Save the setup draft separately");
  expect(html).toContain("Leave receipt template unconfigured");
  expect(html).not.toContain("Provider ready");
  expect(html).not.toContain('value="' + id(9) + '"');
});
it("parent pending barrier disables every initial selection action and hidden step remains scoped", () => {
  const selected = vi.fn(),
    html = renderToStaticMarkup(
      <ReceiptTemplateStoreSelection
        scope={scope}
        locale="en"
        csrf={"A".repeat(43)}
        hidden
        disabled
        value={{ state: "Unconfigured" }}
        onSelect={selected}
      />,
    );
  expect(html).toContain("hidden");
  expect(html.match(/disabled=""/gu)?.length).toBe(5);
  expect(html).toContain('aria-label="Published receipt template selection"');
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
