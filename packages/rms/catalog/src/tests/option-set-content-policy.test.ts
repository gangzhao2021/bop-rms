import { expect, it, vi } from "vitest";
import { assessCatalogOptionSetContentPolicy as assess } from "../contracts/option-set-content-policy.js";
import { parseCatalogOptionSetEditorContent } from "../contracts/option-set-editor-content.js";
import { evaluateCatalogOptionSetRuleSatisfiability } from "../contracts/option-set-rule-satisfiability.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  end = "2026-09-30T12:00:30.000Z";
function node(n = 1) {
  const set = id(n * 100),
    version = id(n * 100 + 1);
  const source = {
    optionSetReference: set,
    brandReference: id(2),
    internalCode: "SET_" + n,
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic set" } as Record<string, string>,
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 1,
      maximumSelection: 2,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 2,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(n * 100 + 10),
          optionSetReference: set,
          brandReference: id(2),
          stableCode: "OPT",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic option" } as Record<string, string>,
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null as string | null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(n * 100 + 10),
        quantityRule: { minimumQuantity: 1, maximumQuantity: 2 },
        media: null as null | {
          mediaReference: string;
          assetReference: string;
          assetVersionReference: string;
          altText: Record<string, string>;
        },
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null as string | null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
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
function choice(n: ReturnType<typeof node>) {
  const item = n.source.draft.options[0];
  if (!item) throw new Error("missing synthetic choice");
  return item;
}
function detail(n: ReturnType<typeof node>) {
  const item = n.details.optionDetails[0];
  if (!item) throw new Error("missing synthetic detail");
  return item;
}
function fixture(...nodes: ReturnType<typeof node>[]) {
  if (nodes.length === 0) nodes = [node()];
  const contents = nodes.map(
    (n) => parseCatalogOptionSetEditorContent(n.source, n.details).content,
  );
  const root = nodes[0];
  if (!root) throw new Error("missing synthetic root");
  const p = parseCatalogOptionSetEditorContent(root.source, root.details);
  const graph = {
    brandReference: id(2),
    rootOptionSetReference: root.source.optionSetReference,
    rootVersionReference: root.source.draft.versionReference,
    contents,
  };
  const binding = {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: root.source.optionSetReference,
    versionReference: root.source.draft.versionReference,
    expectedAggregateVersion: 7,
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
    graphDigest: evaluateCatalogOptionSetRuleSatisfiability(graph).graphDigest,
    originalIntentDigest: "sha256:" + "a".repeat(64),
    observedAt: at,
    validUntil: end,
    activationAt: at,
  };
  const policy = {
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(4),
    policyReference: id(5),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null as string | null,
  };
  return { graph, binding, policy };
}
const run = (f: ReturnType<typeof fixture>) => assess(f.graph, f.policy, f.binding);
const outcome = (r: ReturnType<typeof assess>, code: string) =>
  r.checks.find((c) => c.code === code)?.outcome;
it("pins the complete graph and policy while returning minimal incomplete assessment", () => {
  const f = fixture(),
    r = run(f);
  expect(r.decision).toBe("PassForAssessedRules");
  expect(r.checks).toHaveLength(7);
  expect(r).toMatchObject({
    eligibility: "NotEvaluated",
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    independentApproval: "NotEvaluated",
    scopeTopology: "NotEvaluated",
    mediaReadiness: "NotEvaluated",
  });
  expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(r)).toBe(true);
  expect(Object.isFrozen(r.checks)).toBe(true);
  expect(JSON.stringify(r)).not.toContain("Synthetic");
  expect(r).not.toHaveProperty("witness");
  expect(r).not.toHaveProperty("contents");
  expect(run(f)).toEqual(r);
});
it("requires Set and all retained Option names without requiring optional descriptions", () => {
  const n = node();
  choice(n).lifecycle = "Inactive";
  const f = fixture(n);
  f.policy.requiredLocales.push("fr-CA");
  expect(outcome(run(f), "RequiredSetNames")).toBe("HardError");
  expect(outcome(run(f), "RequiredOptionNames")).toBe("HardError");
  n.source.draft.localizedNames["fr-CA"] = "Synthetic set FR";
  choice(n).localizedNames["fr-CA"] = "Synthetic option FR";
  const valid = fixture(n);
  valid.policy.requiredLocales.push("fr-CA");
  expect(outcome(run(valid), "RequiredSetNames")).toBe("Pass");
  expect(outcome(run(valid), "RequiredOptionNames")).toBe("Pass");
});
it("Required Media tests presence independently from alt locales and never asset readiness", () => {
  const n = node(),
    f = fixture(n);
  f.policy.mediaRequirement = "Required";
  expect(outcome(run(f), "RequiredMediaPresence")).toBe("HardError");
  detail(n).media = {
    mediaReference: id(900),
    assetReference: id(901),
    assetVersionReference: id(902),
    altText: { "en-CA": "Synthetic illustration" },
  };
  const present = fixture(n);
  present.policy.mediaRequirement = "Required";
  expect(run(present).decision).toBe("PassForAssessedRules");
  expect(run(present).mediaReadiness).toBe("NotEvaluated");
  present.policy.requiredLocales.push("fr-CA");
  expect(outcome(run(present), "RequiredMediaAltText")).toBe("HardError");
  present.policy.mediaRequirement = "Optional";
  expect(outcome(run(present), "RequiredMediaAltText")).toBe("HardError");
});
it("Archived retained Options still require names but not new Required Media", () => {
  const n = node();
  choice(n).lifecycle = "Archived";
  n.source.draft.minimumSelection = 0;
  const f = fixture(n);
  f.policy.mediaRequirement = "Required";
  f.policy.requiredLocales.push("fr-CA");
  expect(outcome(run(f), "RequiredMediaPresence")).toBe("Pass");
  expect(outcome(run(f), "RequiredOptionNames")).toBe("HardError");
});
it("refuses Archived candidate through the existing complete-content parser", () => {
  const f = fixture();
  const content = f.graph.contents[0];
  if (!content) throw new Error("missing synthetic content");
  expect(() =>
    assess(
      {
        ...f.graph,
        contents: [
          { ...content, sourceAggregate: { ...content.sourceAggregate, lifecycle: "Archived" } },
        ],
      },
      f.policy,
      f.binding,
    ),
  ).toThrow();
});
it("assesses dormant triggered nodes instead of trusting a successful root witness", () => {
  const root = node(),
    child = node(2);
  root.source.draft.minimumSelection = 0;
  choice(root).triggeredOptionSetReference = child.source.optionSetReference;
  detail(root).triggeredOptionSetVersionReference = child.source.draft.versionReference;
  root.source.draft.localizedNames["fr-CA"] = "Synthetic root FR";
  choice(root).localizedNames["fr-CA"] = "Synthetic root option FR";
  const f = fixture(root, child);
  f.policy.requiredLocales.push("fr-CA");
  const r = run(f);
  expect(r.mechanicalStatus).toBe("Satisfiable");
  expect(r.decision).toBe("HardError");
  expect(outcome(r, "RequiredSetNames")).toBe("HardError");
});
it("missing exact child is Indeterminate and warning override cannot promote it", () => {
  const root = node();
  choice(root).triggeredOptionSetReference = id(200);
  detail(root).triggeredOptionSetVersionReference = id(201);
  const f = fixture(root);
  f.policy.warningOverrideAllowed = true;
  expect(run(f)).toMatchObject({
    decision: "Indeterminate",
    mechanicalReason: "IncompleteTriggerGraph",
    eligibility: "NotEvaluated",
  });
  f.policy.requiredLocales.push("fr-CA");
  expect(run(f).decision).toBe("HardError");
});
it("unsatisfiable candidate is a hard error even when warning override and no approval are configured", () => {
  const n = node();
  choice(n).lifecycle = "Inactive";
  const f = fixture(n);
  f.policy.warningOverrideAllowed = true;
  f.policy.approvalPolicy = "NotRequired";
  expect(run(f)).toMatchObject({
    decision: "HardError",
    mechanicalStatus: "Unsatisfiable",
    independentApproval: "NotEvaluated",
  });
});
it("budget exhaustion remains Indeterminate", () => {
  const n = node();
  const option = n.source.draft.options[0],
    detail = n.details.optionDetails[0];
  if (!option || !detail) throw new Error("missing synthetic alternative");
  n.source.draft.options.push({
    ...option,
    optionReference: id(111),
    stableCode: "ALT",
    sortOrder: 1,
  });
  n.details.optionDetails.push({ ...detail, optionReference: id(111) });
  const f = fixture(n);
  const r = assess(f.graph, f.policy, f.binding, { maximumSearchNodes: 1 });
  expect(r).toMatchObject({ decision: "Indeterminate", mechanicalReason: "SearchLimit" });
});
it("candidate start is inclusive, end exclusive, and a future schedule is only prospective", () => {
  const n = node();
  n.details.effectivePeriod.effectiveUntil = {
    instant: end,
    localDateTime: end.slice(0, 23),
    utcOffsetMinutes: 0,
  };
  const f = fixture(n);
  expect(run(f).decision).toBe("PassForAssessedRules");
  f.binding.activationAt = end;
  expect(outcome(run(f), "CandidateEffectiveAtActivation")).toBe("HardError");
  n.details.effectivePeriod.effectiveFrom = {
    instant: end,
    localDateTime: end.slice(0, 23),
    utcOffsetMinutes: 0,
  };
  n.details.effectivePeriod.effectiveUntil = null;
  const future = fixture(n);
  expect(outcome(run(future), "CandidateEffectiveAtActivation")).toBe("HardError");
  future.binding.activationAt = end;
  expect(run(future).decision).toBe("PassForAssessedRules");
  expect(run(future).sourceAuthority).toBe("NotEvaluated");
});
it("policy must be effective now and at activation, with no lease extension past its end", () => {
  const f = fixture();
  f.policy.effectiveUntil = end;
  f.binding.activationAt = end;
  expect(outcome(run(f), "PolicyEffectiveAtActivation")).toBe("HardError");
  f.policy.effectiveUntil = "2026-09-30T12:00:20.000Z";
  expect(() => run(f)).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  f.binding.validUntil = f.policy.effectiveUntil;
  expect(outcome(run(f), "PolicyEffectiveAtActivation")).toBe("HardError");
  f.policy.effectiveFrom = end;
  f.policy.effectiveUntil = null;
  expect(() => run(f)).toThrow();
});
it.each(["tenantReference", "brandReference", "optionSetReference", "versionReference"])(
  "refuses mismatched identity %s",
  (key) => {
    const f = fixture();
    expect(() => assess(f.graph, f.policy, { ...f.binding, [key]: id(999) })).toThrow();
  },
);
it.each(["sourceDigest", "contentDigest", "configurationDigest", "graphDigest"])(
  "refuses stale complete pin %s",
  (key) => {
    const f = fixture();
    expect(() =>
      assess(f.graph, f.policy, { ...f.binding, [key]: "sha256:" + "b".repeat(64) }),
    ).toThrow();
  },
);
it.each([0, -1, 2147483648, 1.1, "7", 8])(
  "refuses invalid/stale aggregate revision %s",
  (version) => {
    const f = fixture();
    expect(() =>
      assess(f.graph, f.policy, { ...f.binding, expectedAggregateVersion: version }),
    ).toThrow();
  },
);
it.each([at, "2026-09-30T12:00:30.001Z", "2026-09-30T11:59:59.999Z"])(
  "refuses invalid original lease %s",
  (validUntil) => {
    const f = fixture();
    expect(() => assess(f.graph, f.policy, { ...f.binding, validUntil })).toThrow();
  },
);
it("changed body requires new identity, and changed policy or intent changes assessment identity", () => {
  const n = node(),
    f = fixture(n);
  n.source.draft.localizedNames["en-CA"] = "Changed synthetic";
  expect(() => assess(fixture(n).graph, f.policy, f.binding)).toThrow();
  const r = run(f);
  f.policy.approvalPolicy = "NotRequired";
  expect(run(f).digest).not.toBe(r.digest);
  const next = run(f);
  f.binding.originalIntentDigest = "sha256:" + "b".repeat(64);
  expect(run(f).digest).not.toBe(next.digest);
});
it("future content metadata, past activation, extra readiness and Product policy cannot supply authority", () => {
  const n = node();
  n.source.draft.updatedAt = end;
  expect(() => run(fixture(n))).toThrow();
  const f = fixture();
  expect(() =>
    assess(f.graph, f.policy, { ...f.binding, activationAt: "2026-09-30T11:59:59.999Z" }),
  ).toThrow();
  expect(() => assess({ ...f.graph, eligibility: "Ready" }, f.policy, f.binding)).toThrow();
  expect(() =>
    assess(f.graph, { ...f.policy, profile: "PublishingProductPublicationPolicyV1" }, f.binding),
  ).toThrow();
});
it("detaches policy/binding and refuses accessors without invoking them", () => {
  const f = fixture(),
    r = run(f),
    saved = JSON.stringify(r),
    getter = vi.fn(() => f.graph.contents);
  const malicious = { ...f.graph };
  Object.defineProperty(malicious, "contents", { get: getter, enumerable: true });
  expect(() => assess(malicious, f.policy, f.binding)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  f.policy.requiredLocales.push("fr-CA");
  f.binding.originalIntentDigest = "sha256:" + "c".repeat(64);
  expect(JSON.stringify(r)).toBe(saved);
});
