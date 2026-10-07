import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  assessCatalogProductPinnedOptionSelection as assess,
  assessCatalogProductOptionSelection as assessMixed,
} from "../application/product-publication-option-selection.js";
import { parseProductAggregate } from "../contracts/product.js";
import { parseCatalogOptionSetEditorContent } from "../contracts/option-set-editor-content.js";
import { assessCatalogFullProductOptionBindingPrerequisites } from "../contracts/option-set-rule-satisfiability.js";

const id = (n: number) => "01902449-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const first = <T>(values: readonly T[]): T => {
  const value = values[0];
  if (value === undefined) throw Error("Missing synthetic fixture entry");
  return value;
};
function fixture(count = 1) {
  const optionBindings = Array.from({ length: count }, (_, index) => ({
    bindingReference: id(100 + index),
    optionSetReference: id(20),
    optionSetVersionReference: id(21),
    purpose: "PURPOSE_" + index,
    sortOrder: index,
    enabledOptionReferences: [id(22)],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [id(7)],
    excludedSkuReferences: [],
    channelCodes: ["WEB"],
    storeOverrideAllowed: false,
  }));
  const aggregate = {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_OPTION_CHECK",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic Product" },
      taxClassificationReference: null,
      skus: [
        {
          skuReference: id(7),
          productReference: id(5),
          brandReference: id(2),
          skuCode: "SYNTHETIC_SKU",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [],
          unitOfSale: "EACH",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings,
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        allergenReferences: [],
        nutritionProfile: null,
        optionRules: optionBindings.map((binding) => ({
          bindingReference: binding.bindingReference,
          versionResolution: "Pinned",
          pricingRule: null,
          conditionalRule: null,
          conflictRule: null,
          variantCondition: [],
        })),
      },
    },
  };
  // These summaries model already acquired owning assessments. The pure check
  // neither acquires those sources nor creates current read authority.
  const assessments: {
    bindingReference: string;
    bindingDigest: string;
    rootOptionSetReference: string;
    rootVersionReference: string;
    status: string;
    reason: string | null;
  }[] = parseProductAggregate(aggregate).draft.optionBindings.map((binding) => ({
    bindingReference: binding.bindingReference,
    bindingDigest: hash(binding),
    rootOptionSetReference: binding.optionSetReference,
    rootVersionReference: binding.optionSetVersionReference,
    status: "Satisfiable",
    reason: null,
  }));
  return { aggregate, assessments };
}
function mixedFixture(count = 2) {
  const f = fixture(count);
  f.aggregate.draft.editorContent.optionRules.forEach((rule, index) => {
    rule.versionResolution = index % 2 === 0 ? "Pinned" : "CurrentPublished";
  });
  return {
    aggregate: f.aggregate,
    assessments: f.assessments.map((assessment, index) => ({
      ...assessment,
      versionResolution: index % 2 === 0 ? "Pinned" : "CurrentPublished",
      sourceAuthority:
        index % 2 === 0 ? "RecordedFrozen" : "CurrentPublishingReleaseAndFrozenContent",
    })),
  };
}
it("assesses mixed independent Binding identities sharing an exact Set/version without converting source modes", () => {
  const f = mixedFixture(3),
    original = structuredClone(f);
  expect(assessMixed({ ...f, assessments: [...f.assessments].reverse() })).toEqual({
    check: { code: "OptionSelection", outcome: "Pass" },
    findings: [],
  });
  expect(f).toEqual(original);
  unavailable(() => assess(f));
  first(f.assessments).status = "Unsatisfiable";
  first(f.assessments).reason = "NoSelection";
  const current = first(f.assessments.slice(1));
  current.status = "Unsatisfiable";
  current.reason = "TriggerCycle";
  const result = assessMixed(f);
  expect(result.check.outcome).toBe("HardError");
  expect(
    result.findings.map((finding) => ({
      binding: finding.subjectReference,
      code: first(finding.references).sourceCode,
      reason: finding.reasonCode,
    })),
  ).toEqual([
    { binding: id(100), code: "PINNED_OPTION_RULES", reason: "OPTION_RULES_UNSATISFIABLE" },
    { binding: id(101), code: "CURRENT_PUBLISHED_OPTION_RULES", reason: "OPTION_TRIGGER_CYCLE" },
  ]);
});
it.each([
  "versionResolution",
  "sourceAuthority",
  "bindingDigest",
  "rootVersionReference",
  "bindingReference",
  "rootOptionSetReference",
])(
  "mixed assessment refuses wrong %s instead of upgrading or borrowing another source",
  (field) => {
    const f = mixedFixture(),
      current = first(f.assessments.slice(1));
    unavailable(() =>
      assessMixed({
        ...f,
        assessments: [
          first(f.assessments),
          {
            ...current,
            [field]:
              field === "versionResolution"
                ? "Pinned"
                : field === "sourceAuthority"
                  ? "RecordedFrozen"
                  : field === "bindingDigest"
                    ? hash("another binding")
                    : id(99),
          },
        ],
      }),
    );
  },
);
it.each(["missing", "duplicate", "extra", "oldSixFields", "unclosed"])(
  "mixed assessment requires closed complete per-binding provenance: %s",
  (kind) => {
    const f = mixedFixture(),
      firstAssessment = first(f.assessments),
      { versionResolution, sourceAuthority, ...old } = firstAssessment;
    void versionResolution;
    void sourceAuthority;
    const assessments =
      kind === "missing"
        ? [firstAssessment]
        : kind === "duplicate"
          ? [firstAssessment, firstAssessment]
          : kind === "extra"
            ? [...f.assessments, firstAssessment]
            : kind === "oldSixFields"
              ? [old, first(f.assessments.slice(1))]
              : [{ ...firstAssessment, current: true }, first(f.assessments.slice(1))];
    unavailable(() => assessMixed({ ...f, assessments }));
  },
);
it.each(["conditionalRule", "conflictRule"] as const)(
  "does not silently assess independently referenced Product %s from only an Option graph",
  (field) => {
    const f = mixedFixture();
    const aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        editorContent: {
          ...f.aggregate.draft.editorContent,
          optionRules: f.aggregate.draft.editorContent.optionRules.map((rule) => ({
            ...rule,
            [field]: { reference: id(50), versionReference: id(51) },
          })),
        },
      },
    };
    unavailable(() => assessMixed({ ...f, aggregate }));
  },
);
it("keeps Indeterminate source results unavailable and preserves Pinned-only legacy output", () => {
  const f = mixedFixture();
  first(f.assessments).status = "Indeterminate";
  first(f.assessments).reason = "SearchLimit";
  unavailable(() => assessMixed(f));
  const pinned = fixture(),
    generic = {
      ...pinned,
      assessments: pinned.assessments.map((item) => ({
        ...item,
        versionResolution: "Pinned",
        sourceAuthority: "RecordedFrozen",
      })),
    };
  expect(canonicalizeRfc8785(assessMixed(generic))).toBe(canonicalizeRfc8785(assess(pinned)));
  expect(assessMixed({ aggregate: fixture(0).aggregate, assessments: [] })).toEqual({
    check: { code: "OptionSelection", outcome: "Pass" },
    findings: [],
  });
});
const unavailable = (work: () => unknown) =>
  expect(work).toThrowError(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
const invalid = (work: () => unknown) =>
  expect(work).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

it("accepts only actual complete empty bindings, without requiring an Option source or inventing findings", () => {
  const f = fixture(0),
    result = assess(f);
  expect(result).toEqual({ check: { code: "OptionSelection", outcome: "Pass" }, findings: [] });
  const { editorContent, ...legacyDraft } = f.aggregate.draft;
  expect(editorContent.optionRules).toEqual([]);
  unavailable(() => assess({ ...f, aggregate: { ...f.aggregate, draft: legacyDraft } }));
  unavailable(() => assess({ ...f, assessments: fixture().assessments }));
});

it("accepts every exact Pinned assessment even when different Binding purposes reuse the same Set/version", () => {
  const f = fixture(3),
    original = structuredClone(f);
  expect(assess({ ...f, assessments: [...f.assessments].reverse() })).toEqual({
    check: { code: "OptionSelection", outcome: "Pass" },
    findings: [],
  });
  expect(f).toEqual(original);
});

it("reports each proven contradiction in stable Binding order without a full publication or Actor claim", () => {
  const f = fixture(3);
  first(f.assessments).status = "Unsatisfiable";
  first(f.assessments).reason = "NoSelection";
  const last = first(f.assessments.slice(2));
  last.status = "Unsatisfiable";
  last.reason = "TriggerCycle";
  const result = assess({ ...f, assessments: [...f.assessments].reverse() });
  expect(result).toEqual({
    check: { code: "OptionSelection", outcome: "HardError" },
    findings: [
      {
        checkCode: "OptionSelection",
        outcome: "HardError",
        ruleCode: "OPTION_RULES_UNSATISFIABLE",
        subjectReference: id(100),
        reasonCode: "OPTION_RULES_UNSATISFIABLE",
        references: [
          {
            sourceCode: "PINNED_OPTION_RULES",
            resourceReference: id(20),
            versionReference: id(21),
          },
        ],
      },
      {
        checkCode: "OptionSelection",
        outcome: "HardError",
        ruleCode: "OPTION_TRIGGER_CYCLE",
        subjectReference: id(102),
        reasonCode: "OPTION_TRIGGER_CYCLE",
        references: [
          {
            sourceCode: "PINNED_OPTION_RULES",
            resourceReference: id(20),
            versionReference: id(21),
          },
        ],
      },
    ],
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.check)).toBe(true);
  expect(Object.isFrozen(result.findings)).toBe(true);
  expect(Object.isFrozen(first(result.findings))).toBe(true);
  expect(Object.isFrozen(first(result.findings).references)).toBe(true);
  expect(Object.isFrozen(first(first(result.findings).references))).toBe(true);
  first(f.assessments).reason = "TriggerCycle";
  expect(first(result.findings).reasonCode).toBe("OPTION_RULES_UNSATISFIABLE");
});

it("uses an actual inherited-default quantity contradiction from the full graph evaluator", () => {
  const f = fixture(),
    binding = first(parseProductAggregate(f.aggregate).draft.optionBindings);
  const source = {
    optionSetReference: id(20),
    brandReference: id(2),
    internalCode: "SYNTHETIC_SET",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(21),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic Set" },
      localizedDescriptions: {},
      displayStyle: "SingleChoice",
      minimumSelection: 1,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(22),
          optionSetReference: id(20),
          brandReference: id(2),
          stableCode: "SYNTHETIC_OPTION",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic Option" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  };
  const content = parseCatalogOptionSetEditorContent(source, {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(22),
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
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  }).content;
  const rules = assessCatalogFullProductOptionBindingPrerequisites({
    binding,
    graph: {
      brandReference: id(2),
      rootOptionSetReference: id(20),
      rootVersionReference: id(21),
      contents: [content],
    },
  });
  expect(rules.status).toBe("Unsatisfiable");
  const result = assess({
    ...f,
    assessments: [
      {
        ...first(f.assessments),
        status: rules.status,
        reason: "reason" in rules ? rules.reason : null,
      },
    ],
  });
  expect(result.check.outcome).toBe("HardError");
  expect(first(result.findings).reasonCode).toBe("OPTION_RULES_UNSATISFIABLE");
  const currentAggregate = {
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      editorContent: {
        ...f.aggregate.draft.editorContent,
        optionRules: f.aggregate.draft.editorContent.optionRules.map((rule) => ({
          ...rule,
          versionResolution: "CurrentPublished",
        })),
      },
    },
  };
  const currentResult = assessMixed({
    aggregate: currentAggregate,
    assessments: [
      {
        ...first(f.assessments),
        versionResolution: "CurrentPublished",
        sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
        status: rules.status,
        reason: "reason" in rules ? rules.reason : null,
      },
    ],
  });
  expect(currentResult.check.outcome).toBe("HardError");
  expect(first(first(currentResult.findings).references).sourceCode).toBe(
    "CURRENT_PUBLISHED_OPTION_RULES",
  );
});

it.each([
  "bindingReference",
  "bindingDigest",
  "rootOptionSetReference",
  "rootVersionReference",
] as const)("refuses an assessment with an unbound %s", (field) => {
  const f = fixture();
  unavailable(() =>
    assess({
      ...f,
      assessments: [
        {
          ...first(f.assessments),
          [field]: field === "bindingDigest" ? hash("another binding") : id(99),
        },
      ],
    }),
  );
});

it.each(["missing", "extra", "duplicate"] as const)(
  "refuses %s assessments instead of silently assessing a subset",
  (kind) => {
    const f = fixture(2),
      a = first(f.assessments);
    const assessments =
      kind === "missing" ? [a] : kind === "extra" ? [...f.assessments, a] : [a, a];
    unavailable(() => assess({ ...f, assessments }));
  },
);

it("binds the complete core Binding, including SKU/channel/override proposal changes", () => {
  const f = fixture();
  for (const change of [
    { channelCodes: ["POS"] },
    { includedSkuReferences: [], excludedSkuReferences: [id(7)] },
    { minimumSelectionOverride: 1 },
    { purpose: "ANOTHER_PURPOSE" },
  ]) {
    const aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        optionBindings: [{ ...first(f.aggregate.draft.optionBindings), ...change }],
      },
    };
    unavailable(() => assess({ ...f, aggregate }));
  }
});

it.each(["conditionalRule", "conflictRule", "versionResolution"] as const)(
  "does not infer an assessment for unsupported %s",
  (field) => {
    const f = fixture();
    const optionRules = [
      {
        ...first(f.aggregate.draft.editorContent.optionRules),
        [field]:
          field === "versionResolution"
            ? "CurrentPublished"
            : { reference: id(80), versionReference: id(81) },
      },
    ];
    const aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        editorContent: { ...f.aggregate.draft.editorContent, optionRules },
      },
    };
    unavailable(() => assess({ ...f, aggregate }));
  },
);

it.each([
  "IncompleteTriggerGraph",
  "AmbiguousTriggerVersion",
  "ComplexityLimit",
  "SearchLimit",
] as const)("keeps %s Indeterminate unavailable even beside a known contradiction", (reason) => {
  const f = fixture(2);
  first(f.assessments).status = "Unsatisfiable";
  first(f.assessments).reason = "NoSelection";
  const b = first(f.assessments.slice(1));
  b.status = "Indeterminate";
  b.reason = reason;
  unavailable(() => assess(f));
});

it.each([
  { status: "Satisfiable", reason: "NoSelection" },
  { status: "Unsatisfiable", reason: null },
  { status: "Unsatisfiable", reason: "SearchLimit" },
  { status: "Pass", reason: null },
  { status: "Indeterminate", reason: "NoSelection" },
])("refuses incoherent result tuple $status/$reason", (result) => {
  const f = fixture();
  unavailable(() => assess({ ...f, assessments: [{ ...first(f.assessments), ...result }] }));
});

it("rejects missing/foreign Product bindings as invalid content without inventing a finding", () => {
  const f = fixture();
  const noRule = {
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      editorContent: { ...f.aggregate.draft.editorContent, optionRules: [] },
    },
  };
  invalid(() => assess({ ...f, aggregate: noRule }));
  const foreignSku = {
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      optionBindings: [
        { ...first(f.aggregate.draft.optionBindings), includedSkuReferences: [id(99)] },
      ],
    },
  };
  invalid(() => assess({ ...f, aggregate: foreignSku }));
});

it("admits no caller payload, System/User authority or readiness assertion into the pure input", () => {
  const f = fixture();
  unavailable(() => assess({ ...f, actorKind: "System" }));
  unavailable(() => assess({ ...f, actorKind: "User" }));
  unavailable(() => assess({ ...f, assessments: [{ ...first(f.assessments), graph: {} }] }));
  unavailable(() =>
    assess({ ...f, assessments: [{ ...first(f.assessments), eligibility: "Ready" }] }),
  );
});

it("does not execute getters or accept sparse source summaries", () => {
  const f = fixture(),
    read = vi.fn(() => "Satisfiable"),
    source = { ...first(f.assessments) };
  Object.defineProperty(source, "status", { enumerable: true, get: read });
  invalid(() => assess({ ...f, assessments: [source] }));
  expect(read).not.toHaveBeenCalled();
  invalid(() => assess({ ...f, assessments: new Array(1) }));
});
