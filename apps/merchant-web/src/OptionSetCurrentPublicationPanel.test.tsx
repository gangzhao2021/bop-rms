import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  materializeFullOptionSetCreation,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../../packages/rms/catalog/src/index.js";
import { parseOptionSetCurrentPublicationView } from "./option-set-current-publication-client.js";
import {
  OptionSetCurrentPublicationPanel,
  OptionSetCurrentPublicationViewContent,
} from "./OptionSetCurrentPublicationPanel.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    operationReference: id(7),
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
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
          localizedNames: { "en-CA": "Synthetic choice" },
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
  };
}
function owningCreate(value: unknown = creation(), brandReference = scope.brandReference) {
  return materializeFullOptionSetCreation(
    {
      ...(value as ReturnType<typeof creation>),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference,
      actorReference: scope.actorReference,
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  );
}

function fixture(state: "Absent" | "NotCurrentlyPublished" | "Published" = "Published") {
  const full = owningCreate(),
    release = {
      publicationReference: id(20),
      releaseSequence: 1,
      releasedAt: at,
      lifecycleReference: id(21),
      lifecycleVersion: 4,
      snapshotReference: id(8),
      snapshotDigest: digest,
      approvalDisposition: "Approved",
    };
  return {
    profile: "CatalogOptionSetCurrentPublicationResultV1",
    ...scope,
    optionSetReference: id(6),
    currentAggregateVersion: 2,
    publicationState: state,
    currentLifecycleReference: state === "Absent" ? null : id(21),
    lastReleaseReference: state === "Absent" ? null : id(20),
    release: state === "Published" ? release : null,
    published:
      state === "Published"
        ? {
            profile: "CatalogOptionSetCurrentPublishedContentV1",
            content: full.content,
            sourceDigest: full.sourceDigest,
            contentDigest: full.contentDigest,
            configurationDigest: full.configurationDigest,
            sourceRecords: [
              {
                optionSetReference: id(6),
                versionReference: id(8),
                publicationReference: id(20),
                releaseRecordDigest: digest,
                sealRecordDigest: digest,
                approvalDisposition: "Approved",
              },
            ],
            graphDigest: digest,
            rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
            observedAt: at,
            validUntil: until,
            sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
            referenceEligibility: "NotEvaluated",
            eligibility: "NotEvaluated",
            publishValidation: "Incomplete",
          }
        : null,
    observedAt: at,
    validUntil: until,
  };
}

it("renders the ordinary Detail current publication region with loading and explicit refresh, without SSR reads", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    const html = renderToStaticMarkup(
      <OptionSetCurrentPublicationPanel
        optionSetReference={id(6)}
        scope={scope}
        csrf={"A".repeat(43)}
        refreshKey={0}
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(html).toContain('aria-label="Current Option Set publication"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Loading current publication");
    expect(html).toContain("Refresh current publication");
    expect(html).not.toContain("No release has been recorded");
    expect(html).not.toContain(scope.actorReference);
    expect(html).not.toContain("A".repeat(43));
  } finally {
    fetcher.mockRestore();
  }
});
it.each(["Absent", "NotCurrentlyPublished"] as const)(
  "shows verified %s distinctly and never creates Published content",
  async (state) => {
    const view = await parseOptionSetCurrentPublicationView(
        fixture(state),
        { optionSetReference: id(6), expectedAggregateVersion: null },
        scope,
        at,
      ),
      html = renderToStaticMarkup(<OptionSetCurrentPublicationViewContent view={view} />);
    expect(html).toContain(
      state === "Absent" ? "No release has been recorded" : "not currently Published",
    );
    expect(html).not.toContain("Current Published version");
    expect(html).not.toContain("Synthetic choices");
  },
);
it("renders the complete actual released root separately from the editable Draft and eligibility", async () => {
  const view = await parseOptionSetCurrentPublicationView(
      fixture(),
      { optionSetReference: id(6), expectedAggregateVersion: null },
      scope,
      at,
    ),
    html = renderToStaticMarkup(<OptionSetCurrentPublicationViewContent view={view} />);
  for (const text of [
    "Current Published version",
    "editable Draft is separate",
    "sale availability are not evaluated",
    "Independently approved",
    "Synthetic choices",
    "Synthetic choice",
    "Mechanical rule assessment",
    "Recorded release and source provenance",
    "Satisfiable",
    id(8),
    view.published?.sourceDigest ?? "",
  ])
    expect(html).toContain(text);
  expect(html).toContain('aria-label="Current Published content"');
  expect(html).toMatch(/datetime="2026-10-05T12:00:00.000Z"/iu);
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("<form");
});
it("labels an actual PolicyWaived release without inventing independent approval", async () => {
  const raw = fixture(),
    p = raw.published;
  if (!p) throw new Error("Missing fixture");
  const view = await parseOptionSetCurrentPublicationView(
      {
        ...raw,
        release: { ...raw.release, approvalDisposition: "PolicyWaived" },
        published: {
          ...p,
          sourceRecords: p.sourceRecords.map((s) => ({
            ...s,
            approvalDisposition: "PolicyWaived",
          })),
        },
      },
      { optionSetReference: id(6), expectedAggregateVersion: null },
      scope,
      at,
    ),
    html = renderToStaticMarkup(<OptionSetCurrentPublicationViewContent view={view} />);
  expect(html).toContain("Approval waived by the recorded policy");
  expect(html).not.toContain("Independently approved");
});
