import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  parseCatalogOptionSetEditorContent,
  materializeFullOptionSetEdit,
} from "../../../packages/rms/catalog/src/index.js";
import {
  parseOptionSetEditorContent,
  createOptionSetAuthoringClient,
} from "./option-set-authoring-client.js";
import {
  OptionSetCreatePage,
  OptionSetDetailPage,
  OptionSetEditPage,
  OptionSetFullDraftForm,
  emptyOptionSetForm,
  optionSetFormFromContent,
  optionSetCommandFromForm,
} from "./OptionSetAuthoringPages.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z";
function fixture() {
  const source = {
    optionSetReference: id(1),
    brandReference: id(2),
    internalCode: "MILK",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic milk" },
      localizedDescriptions: { "en-CA": "Synthetic choices" },
      displayStyle: "Quantity",
      minimumSelection: 1,
      maximumSelection: 3,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 3,
      createdAt: at,
      updatedAt: at,
      options: [5, 6, 7].map((n) => ({
        optionReference: id(n),
        optionSetReference: id(1),
        brandReference: id(2),
        stableCode: "OPTION_" + n,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        localizedDescriptions: {},
        sortOrder: n - 5,
        defaultEligible: true,
        triggeredOptionSetReference: n === 5 ? id(50) : null,
        conflictOptionReferences: n === 6 ? [id(7)] : [],
        createdAt: at,
        createdByActorReference: id(3),
      })),
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [5, 6, 7].map((n) => ({
      optionReference: id(n),
      quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
      media:
        n === 5
          ? {
              mediaReference: id(100),
              assetReference: id(101),
              assetVersionReference: id(102),
              altText: { "en-CA": "Synthetic milk image" },
            }
          : null,
      pricingRule: n === 5 ? { reference: id(110), versionReference: id(111) } : null,
      consumption:
        n === 7
          ? null
          : {
              kind: n === 5 ? "Inventory" : "Recipe",
              reference: id(120 + n),
              versionReference: id(130 + n),
              quantity: n === 5 ? "0.125000" : "1.000000",
              unitCode: "GRAM",
            },
      triggeredOptionSetVersionReference: n === 5 ? id(51) : null,
    })),
    conditionalRules: [
      { ruleReference: id(200), whenAllSelected: [id(5)], requiredOptionReferences: [id(6)] },
    ],
    conflictRules: [{ ruleReference: id(201), forbiddenTogether: [id(5), id(7)] }],
    scopeSet: [
      {
        level: "Brand",
        reference: null as string | null,
        channelCodes: ["POS", "CUSTOMER_PWA"],
        orderTypeCodes: [] as string[],
      },
    ],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null as null | {
        instant: string;
        localDateTime: string;
        utcOffsetMinutes: number;
      },
    },
  };
  return { source, details };
}

function content() {
  const f = fixture();
  return parseOptionSetEditorContent(
    parseCatalogOptionSetEditorContent(f.source, f.details).content,
  );
}
const scope = {
  tenantReference: id(10),
  brandReference: id(2),
  storeReference: id(11),
  actorReference: id(3),
};
it("complete recorded content roundtrips through ordinary form without dropping additional fields or stable identity", () => {
  const c = content(),
    form = optionSetFormFromContent(c),
    command = optionSetCommandFromForm(form, "Edit", id(300), c),
    prepared = createOptionSetAuthoringClient().prepareDraft(command, scope, c);
  expect(prepared.command).toEqual(command);
  const changed = materializeFullOptionSetEdit(
    { ...command, occurredAt: "2026-10-05T12:00:00.000Z", reasonCode: "AUTHORIZED_OPERATION" },
    c,
    { actorReference: id(3), newOptions: [] },
  );
  expect(changed.content.optionDetails).toEqual(c.optionDetails);
  expect(changed.content.conditionalRules).toEqual(c.conditionalRules);
  expect(changed.content.conflictRules).toEqual(c.conflictRules);
  expect(changed.content.scopeSet).toEqual(c.scopeSet);
  expect(changed.content.effectivePeriod).toEqual(c.effectivePeriod);
  expect(changed.content.sourceAggregate.createdAt).toBe(c.sourceAggregate.createdAt);
  expect(changed.content.sourceAggregate.createdByActorReference).toBe(
    c.sourceAggregate.createdByActorReference,
  );
  expect(changed.content.sourceAggregate.draft.options).toEqual(c.sourceAggregate.draft.options);
});
it("New plus explicit Archive delegates only New identities to server and preserves original history", () => {
  const c = content(),
    form = optionSetFormFromContent(c),
    old = form.options.find((o) => o.stableCode === "OPTION_6");
  if (!old || old.identity.kind !== "Existing") throw Error("fixture missing");
  form.archiveOptionReferences = [old.identity.optionReference];
  form.conditionalRules = [];
  form.options.push({
    identity: { kind: "New" },
    stableCode: "NEW",
    lifecycle: "Draft",
    localizedNames: { "en-CA": "Synthetic newly entered option" },
    localizedDescriptions: {},
    sortOrder: 3,
    defaultEligible: false,
    triggeredOptionSetReference: null,
    conflictOptionCodes: [],
  });
  form.optionDetails.push({
    stableCode: "NEW",
    quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
    media: null,
    pricingRule: null,
    consumption: null,
    triggeredOptionSetVersionReference: null,
  });
  const command = optionSetCommandFromForm(form, "Edit", id(301), c);
  createOptionSetAuthoringClient().prepareDraft(command, scope, c);
  const actual = materializeFullOptionSetEdit(
    { ...command, occurredAt: "2026-10-05T12:00:00.000Z", reasonCode: "AUTHORIZED_OPERATION" },
    c,
    { actorReference: id(3), newOptions: [{ stableCode: "NEW", optionReference: id(302) }] },
  );
  expect(
    actual.content.sourceAggregate.draft.options.find((o) => o.stableCode === "OPTION_6"),
  ).toMatchObject({
    optionReference: id(6),
    lifecycle: "Archived",
    createdAt: at,
    createdByActorReference: id(3),
  });
  expect(
    actual.content.sourceAggregate.draft.options.find((o) => o.stableCode === "NEW")
      ?.optionReference,
  ).toBe(id(302));
});
it("form renders full accessible named fields and recorded sources without raw IDs or invented source picker", () => {
  const c = content(),
    html = renderToStaticMarkup(
      <OptionSetFullDraftForm
        value={optionSetFormFromContent(c)}
        onChange={() => undefined}
        onSubmit={() => undefined}
        disabled={false}
        editing
        storeReference={id(11)}
      />,
    );
  for (const label of [
    "Selection rules",
    "Minimum selections",
    "Per-option maximum quantity",
    "Conditional and conflict rules",
    "Channel codes",
    "Order type codes",
    "IANA time zone",
    "Effective until",
    "Recorded media retained",
    "Recorded Pricing rule retained",
    "consumption quantity",
    "Archive OPTION_5 explicitly",
  ])
    expect(html).toContain(label);
  expect(html).not.toContain(id(100));
  expect(html).not.toContain(id(110));
  expect(html).not.toContain("JSON editor");
  expect(html).toContain("source selection are not connected yet");
  expect(html).toContain("readOnly");
});
it("Create starts without invented locale, scope, effective dates or readiness", () => {
  const f = emptyOptionSetForm();
  expect(f.defaultLocale).toBe("");
  expect(f.scopeSet).toEqual([]);
  expect(f.options).toEqual([]);
  expect(f.timeZone).toBe("");
  expect(f.fromLocal).toBe("");
  expect(f.acknowledged).toBe(false);
  expect(() => optionSetCommandFromForm(f, "Create", id(300))).toThrow();
});
it.each([OptionSetCreatePage, OptionSetDetailPage, OptionSetEditPage])(
  "ordinary page starts locked while actual context/source/journal initializes",
  (Page) => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Page
          brandReference={null}
          storeReference={id(11)}
          csrf={"A".repeat(43)}
          optionSetReference={id(1)}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading current identity and pending operation");
    expect(html).toContain("disabled");
    expect(html).toContain("Back to Option Sets");
  },
);
it("complete disabled form cannot expose an enabled submit while an original is pending", () => {
  const f = optionSetFormFromContent(content());
  f.acknowledged = true;
  const html = renderToStaticMarkup(
    <OptionSetFullDraftForm
      value={f}
      onChange={() => undefined}
      onSubmit={() => undefined}
      disabled
      editing
      storeReference={id(11)}
    />,
  );
  expect(html).toContain('<button type="submit" disabled="">Save complete Draft</button>');
});
it("invalid explicit effective boundary and missing Edit baseline are rejected before any transport", () => {
  const form = optionSetFormFromContent(content());
  form.fromOffset = "";
  expect(() => optionSetCommandFromForm(form, "Edit", id(300), content())).toThrow();
  form.fromOffset = "0";
  expect(() => optionSetCommandFromForm(form, "Edit", id(300))).toThrow();
});
it("Detail and Edit keep the editor locked before publication journal admission while Create remains independent", () => {
  for (const Page of [OptionSetDetailPage, OptionSetEditPage]) {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Page
          brandReference={id(2)}
          storeReference={id(11)}
          csrf={"A".repeat(43)}
          optionSetReference={id(1)}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("Loading current identity and pending operation");
    expect(html).not.toContain("Published · current root");
  }
});
