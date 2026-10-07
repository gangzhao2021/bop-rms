import { parseOptionSetEditorContent } from "./option-set-authoring-client.js";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  materializeFullOptionSetCreation,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../../packages/rms/catalog/src/index.js";
import {
  OptionSetHistoryPanel,
  OptionSetHistoryRecordedContent,
  OptionSetHistoryValues,
} from "./OptionSetHistoryPanel.js";
import type { OptionSetHistorySelectedView } from "./option-set-history-client.js";

const id = (n: number) =>
  parseCatalogReference("01902421-7c00-7000-8000-" + n.toString(16).padStart(12, "0"));
const at = parseCatalogInstant("2026-10-05T12:00:00.000Z");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const digest = "sha256:" + "a".repeat(64);
function content() {
  return parseOptionSetEditorContent(
    materializeFullOptionSetCreation(
      {
        internalCode: "SYNTH_HISTORY",
        operationReference: id(7),
        occurredAt: at,
        reasonCode: "AUTHORIZED_OPERATION",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Recorded choices" },
          localizedDescriptions: { "en-CA": "Original description" },
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 1,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 1,
          options: [
            {
              stableCode: "CHOICE",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Recorded Option" },
              localizedDescriptions: {},
              sortOrder: 0,
              defaultEligible: true,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
          ],
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: [
            {
              stableCode: "CHOICE",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: null,
              consumption: null,
              triggeredOptionSetVersionReference: null,
            },
          ],
          conditionalRules: [],
          conflictRules: [],
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
      },
      {
        brandReference: scope.brandReference,
        actorReference: scope.actorReference,
        allocations: {
          optionSetReference: id(6),
          versionReference: id(8),
          options: [{ stableCode: "CHOICE", optionReference: id(9) }],
        },
      },
    ).content,
  );
}
function selected(frozen = false): OptionSetHistorySelectedView {
  return {
    profile: frozen ? "CatalogOptionSetHistoricalFrozenV1" : "CatalogOptionSetHistoricalDraftV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    originalTuple: {
      operationReference: id(7),
      versionReference: id(8),
      resultAggregateVersion: frozen ? 2 : 1,
      action: frozen ? "Publish" : "Create",
      intentDigest: digest,
      occurredAt: at,
    },
    // This static-render fixture does not assert a verified Frozen envelope.
    // The production browser client verifies the actual envelope before rendering.
    content: frozen ? { editorContent: content() } : content(),
    sourceDigest: digest,
    contentDigest: digest,
    configurationDigest: digest,
    referenceEligibility: "NotEvaluated",
    observedAt: at,
    validUntil: "2026-10-05T12:00:05.000Z",
    ...(frozen ? { recordingStatus: "RecordedFrozen" as const, recordDigest: digest } : {}),
  };
}

it("renders the existing Detail history region without performing reads during server rendering", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    const html = renderToStaticMarkup(
      <OptionSetHistoryPanel
        optionSetReference={id(6)}
        scope={scope}
        csrf={"A".repeat(43)}
        refreshKey={0}
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain('aria-label="Option Set history and comparison"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Refresh history");
    expect(html).toContain("Recorded versions");
    expect(html).toContain("Publication timeline");
    expect(html).toContain("Compare selected versions");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(scope.actorReference);
    expect(html).not.toContain("A".repeat(43));
    expect(html).not.toContain("/option-sets/");
  } finally {
    fetcher.mockRestore();
  }
});

it("renders complete original Draft business content and provenance as read-only values", () => {
  const html = renderToStaticMarkup(<OptionSetHistoryRecordedContent view={selected()} />);
  for (const text of [
    "Recorded Draft content",
    "Original source and version",
    "Original description",
    "Recorded Option",
    "Minimum selections",
    "Maximum selections",
    "Repeated selections allowed",
    "Option references, quantities and media",
    "Conditional rules",
    "Conflict rules",
    "Scope",
    "Effective period",
    "UTC",
    id(7),
    id(8),
    digest,
  ])
    expect(html).toContain(text);
  expect(html).toContain("not evaluated");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("<form");
  expect(html).toContain("overflow-wrap:anywhere");
});

it("labels Frozen as a recorded version without inventing publication status", () => {
  const html = renderToStaticMarkup(<OptionSetHistoryRecordedContent view={selected(true)} />);
  expect(html).toContain("Recorded Frozen content");
  expect(html).toContain("Frozen content alone does not establish a Published release");
  expect(html).not.toContain("Published frozen version confirmed");
  expect(html).toContain("Recorded choices");
});

it("renders actual timeline and comparison facts with explicit empty and boolean values", () => {
  const html = renderToStaticMarkup(
    <OptionSetHistoryValues
      value={{
        actorKind: "User",
        actorReference: id(4),
        operation: "Approve",
        occurredAt: at,
        recordedAt: at,
        fromState: "InReview",
        toState: "Approved",
        releaseReference: null,
        fields: [],
        businessContentChanged: false,
      }}
    />,
  );
  expect(html).toContain("Actor kind");
  expect(html).toContain("Approve");
  expect(html).toContain("Approved");
  expect(html).toContain("None recorded");
  expect(html).toContain("No");
  expect(html).toContain("Release reference");
  expect(html).not.toContain("Published release confirmed");
});

it("escapes recorded text and wraps long source references without horizontal tables", () => {
  const html = renderToStaticMarkup(
    <OptionSetHistoryValues
      value={{
        localizedDescriptions: { "en-CA": "<script>synthetic</script>" },
        sourceDigest: digest,
      }}
    />,
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("overflow-wrap:anywhere");
  expect(html).not.toContain("<table");
});
