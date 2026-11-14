import { expect, it, vi } from "vitest";
import {
  evaluateCatalogFullProductOptionBindingRules as evaluate,
  assessCatalogFullProductOptionBindingPrerequisites as assess,
  evaluateCatalogOptionSetRuleSatisfiability as graphEvaluate,
} from "../contracts/option-set-rule-satisfiability.js";
import { parseCatalogOptionSetEditorContent } from "../contracts/option-set-editor-content.js";

const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-30T12:00:00.000Z";
function fixture(n = 1, count = 2) {
  const set = id(n * 100),
    version = id(n * 100 + 1);
  const source = {
    optionSetReference: set,
    brandReference: id(2),
    internalCode: "SET_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic rule set" },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: Math.max(2, count * 2) as number | null,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: Math.max(2, count * 2) as number | null,
      createdAt: at,
      updatedAt: at,
      options: Array.from({ length: count }, (_, i) => ({
        optionReference: id(n * 100 + 10 + i),
        optionSetReference: set,
        brandReference: id(2),
        stableCode: "OPTION_" + i,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        localizedDescriptions: {},
        sortOrder: i,
        defaultEligible: true,
        triggeredOptionSetReference: null as string | null,
        conflictOptionReferences: [] as string[],
        createdAt: at,
        createdByActorReference: id(3),
      })),
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: source.draft.options.map((o) => ({
      optionReference: o.optionReference,
      quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
      media: null,
      pricingRule: null,
      consumption: null,
      triggeredOptionSetVersionReference: null as string | null,
    })),
    conditionalRules: [] as {
      ruleReference: string;
      whenAllSelected: string[];
      requiredOptionReferences: string[];
    }[],
    conflictRules: [] as { ruleReference: string; forbiddenTogether: string[] }[],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  };
  return { source, details };
}
type Fixture = ReturnType<typeof fixture>;
const option = (f: Fixture, i: number) => {
  const o = f.source.draft.options[i];
  if (!o) throw new Error("missing synthetic option");
  return o;
};
const detail = (f: Fixture, i: number) => {
  const d = f.details.optionDetails[i];
  if (!d) throw new Error("missing synthetic detail");
  return d;
};
function trigger(from: Fixture, i: number, to: Fixture) {
  option(from, i).triggeredOptionSetReference = to.source.optionSetReference;
  detail(from, i).triggeredOptionSetVersionReference = to.source.draft.versionReference;
}
const input = (...nodes: Fixture[]) => ({
  brandReference: id(2),
  rootOptionSetReference: id(100),
  rootVersionReference: id(101),
  contents: nodes.map((f) => parseCatalogOptionSetEditorContent(f.source, f.details).content),
});

function binding(f: Fixture, selections: readonly (readonly [number, number])[] = [[0, 1]]) {
  return {
    bindingReference: id(900),
    optionSetReference: f.source.optionSetReference,
    optionSetVersionReference: f.source.draft.versionReference,
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: f.source.draft.options.map((o) => o.optionReference),
    defaultSelections: selections.map(([i, quantity]) => ({
      optionReference: option(f, i).optionReference,
      quantity,
    })),
    minimumSelectionOverride: null as number | null,
    maximumSelectionOverride: null as number | null,
    includedSkuReferences: [] as string[],
    excludedSkuReferences: [] as string[],
    channelCodes: ["POS"],
    storeOverrideAllowed: false,
  };
}
const run = (f: Fixture, b = binding(f), ...children: Fixture[]) =>
  evaluate({ graph: input(f, ...children), binding: b });
const invalid = (action: () => unknown) =>
  expect(action).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

it("keeps exact explicit default quantities and original graph identities without publication eligibility", () => {
  const f = fixture();
  const graph = input(f),
    b = binding(f, [[0, 2]]);
  const before = JSON.stringify({ graph, binding: b });
  const result = evaluate({ graph, binding: b });
  expect(result).toMatchObject({
    status: "Satisfiable",
    eligibility: "NotEvaluated",
    bindingReference: b.bindingReference,
  });
  if (result.status !== "Satisfiable") throw new Error("missing completion");
  expect(result.witness[0]?.options).toEqual(b.defaultSelections);
  expect(result.graphDigest).toBe(graphEvaluate(graph).graphDigest);
  expect(result.identities).toEqual(graphEvaluate(graph).identities);
  expect(result.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.witness[0]?.options)).toBe(true);
  expect(JSON.stringify({ graph, binding: b })).toBe(before);
  b.channelCodes.push("DELIVERY");
  expect(evaluate({ graph, binding: b }).bindingDigest).not.toBe(result.bindingDigest);
  expect(evaluate({ graph, binding: b }).graphDigest).toBe(result.graphDigest);
});
it("does not invent defaults from defaultEligible or enabled choices", () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  child.source.draft.minimumSelection = 1;
  const result = run(f, binding(f, []), child);
  expect(result.status).toBe("Satisfiable");
  if (result.status === "Satisfiable") {
    expect(result.witness.flatMap((g) => g.options)).toEqual([]);
    expect(
      result.witness.find((g) => g.optionSetReference === child.source.optionSetReference)?.active,
    ).toBe(false);
  }
});
it.each([
  [1, "Unsatisfiable"],
  [2, "Satisfiable"],
])("honors full per-Option lower bound for explicit quantity %i", (quantity, status) => {
  const f = fixture();
  detail(f, 0).quantityRule.minimumQuantity = 2;
  expect(run(f, binding(f, [[0, quantity as number]])).status).toBe(status);
});
it("rejects a full upper-bound breach which nominal legacy capacity alone permits", () => {
  const f = fixture();
  detail(f, 0).quantityRule.maximumQuantity = 1;
  expect(run(f, binding(f, [[0, 2]]))).toMatchObject({
    status: "Unsatisfiable",
    reason: "NoSelection",
  });
  expect(run(f).status).toBe("Satisfiable");
});
it.each([true, false])(
  "never auto-inserts a required root default, even if enabled=%s",
  (enabled) => {
    const f = fixture();
    f.details.conditionalRules = [
      {
        ruleReference: id(801),
        whenAllSelected: [option(f, 0).optionReference],
        requiredOptionReferences: [option(f, 1).optionReference],
      },
    ];
    const b = binding(f);
    if (!enabled) b.enabledOptionReferences = [option(f, 0).optionReference];
    expect(run(f, b).status).toBe("Unsatisfiable");
    expect(
      run(
        f,
        binding(f, [
          [0, 1],
          [1, 1],
        ]),
      ).status,
    ).toBe("Satisfiable");
  },
);
it("checks transitive default implications beyond direct contradiction checks", () => {
  const f = fixture(1, 3);
  f.details.conditionalRules = [0, 1].map((i) => ({
    ruleReference: id(810 + i),
    whenAllSelected: [option(f, i).optionReference],
    requiredOptionReferences: [option(f, i + 1).optionReference],
  }));
  expect(
    run(
      f,
      binding(f, [
        [0, 1],
        [1, 1],
      ]),
    ).status,
  ).toBe("Unsatisfiable");
  expect(
    run(
      f,
      binding(f, [
        [0, 1],
        [1, 1],
        [2, 1],
      ]),
    ).status,
  ).toBe("Satisfiable");
});
it.each([
  [
    [
      [0, 1],
      [2, 1],
      [3, 1],
    ],
    "Unsatisfiable",
  ],
  [
    [
      [0, 1],
      [2, 1],
    ],
    "Satisfiable",
  ],
  [
    [
      [0, 1],
      [1, 1],
    ],
    "Unsatisfiable",
  ],
  [
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    "Satisfiable",
  ],
] as const)("checks conjunction and full three-member default conflict %j", (defaults, status) => {
  const f = fixture(1, 4);
  f.details.conditionalRules = [
    {
      ruleReference: id(820),
      whenAllSelected: [option(f, 0).optionReference, option(f, 1).optionReference],
      requiredOptionReferences: [option(f, 2).optionReference],
    },
  ];
  f.details.conflictRules = [
    {
      ruleReference: id(821),
      forbiddenTogether: [
        option(f, 0).optionReference,
        option(f, 2).optionReference,
        option(f, 3).optionReference,
      ],
    },
  ];
  expect(run(f, binding(f, defaults)).status).toBe(status);
});
it("applies allowed root narrowing and preserves exact quantities", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 1;
  const b = binding(f, [[0, 2]]);
  b.minimumSelectionOverride = 2;
  b.maximumSelectionOverride = 2;
  expect(run(f, b).status).toBe("Satisfiable");
  for (const replacement of [
    { ...b, minimumSelectionOverride: 0 },
    { ...b, maximumSelectionOverride: 5 },
    { ...b, defaultSelections: [{ optionReference: option(f, 0).optionReference, quantity: 1 }] },
  ])
    invalid(() => run(f, replacement));
});
it.each(["Inactive", "Archived"])("retains legacy refusal for a %s default", (lifecycle) => {
  const f = fixture();
  option(f, 0).lifecycle = lifecycle;
  invalid(() => run(f));
});
it("retains default-ineligible, pair conflict and pin refusals", () => {
  const f = fixture();
  option(f, 0).defaultEligible = false;
  invalid(() => run(f));
  option(f, 0).defaultEligible = true;
  option(f, 0).conflictOptionReferences = [option(f, 1).optionReference];
  invalid(() =>
    run(
      f,
      binding(f, [
        [0, 1],
        [1, 1],
      ]),
    ),
  );
  invalid(() => run(f, { ...binding(f), optionSetVersionReference: id(555) }));
  invalid(() => run(f, { ...binding(f), optionSetReference: id(556) }));
});
it("finds a shared child's feasible completion once, without inserting root defaults", () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  trigger(f, 1, child);
  child.source.draft.minimumSelection = 2;
  const b = binding(f, [
      [0, 1],
      [1, 1],
    ]),
    result = run(f, b, child);
  expect(result.status).toBe("Satisfiable");
  if (result.status === "Satisfiable") {
    expect(result.witness).toHaveLength(2);
    expect(result.witness[0]?.options).toEqual(b.defaultSelections);
    expect(result.witness[1]?.options.reduce((sum, o) => sum + o.quantity, 0)).toBe(2);
  }
  child.source.draft.options.forEach((o) => {
    o.lifecycle = "Inactive";
  });
  expect(run(f, b, child).status).toBe("Unsatisfiable");
});
it("preserves structural trigger closure and cycle checks even when root defaults are empty", () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  expect(run(f, binding(f, []))).toMatchObject({
    status: "Indeterminate",
    reason: "IncompleteTriggerGraph",
  });
  trigger(child, 0, f);
  expect(run(f, binding(f, []), child)).toMatchObject({
    status: "Unsatisfiable",
    reason: "TriggerCycle",
  });
});
it("applies Binding constraints to a root whose identity sorts after its child", () => {
  const f = fixture(3),
    child = fixture(2);
  trigger(f, 0, child);
  child.source.draft.minimumSelection = 1;
  const graph = {
    ...input(f, child),
    rootOptionSetReference: f.source.optionSetReference,
    rootVersionReference: f.source.draft.versionReference,
  };
  const b = binding(f, [[0, 2]]),
    result = evaluate({ graph, binding: b });
  expect(result.status).toBe("Satisfiable");
  if (result.status === "Satisfiable") {
    expect(
      result.witness.find((g) => g.optionSetReference === f.source.optionSetReference)?.options,
    ).toEqual(b.defaultSelections);
    expect(
      result.witness.find((g) => g.optionSetReference === child.source.optionSetReference)?.active,
    ).toBe(true);
  }
});
it("retains representable inactive non-default choices without selecting them", () => {
  const f = fixture();
  option(f, 1).lifecycle = "Inactive";
  expect(run(f).status).toBe("Satisfiable");
});
it("budget exhaustion remains Indeterminate for triggered child search", () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  child.source.draft.minimumSelection = 1;
  expect(
    evaluate({ graph: input(f, child), binding: binding(f) }, { maximumSearchNodes: 1 }),
  ).toMatchObject({ status: "Indeterminate", reason: "SearchLimit", eligibility: "NotEvaluated" });
  expect(run(f, binding(f), child).status).toBe("Satisfiable");
});
it("rejects descriptor getters, sparse defaults and caller readiness without invoking accessors", () => {
  const f = fixture(),
    b = binding(f),
    graph = input(f),
    getter = vi.fn(() => b);
  invalid(() =>
    evaluate({
      graph,
      get binding() {
        return getter();
      },
    }),
  );
  expect(getter).not.toHaveBeenCalled();
  invalid(() => evaluate({ graph, binding: b, ready: true }));
  invalid(() => evaluate({ graph, binding: { ...b, ready: true } }));
  const sparse = Array(2) as typeof b.defaultSelections;
  sparse[1] = { optionReference: option(f, 0).optionReference, quantity: 1 };
  invalid(() => evaluate({ graph, binding: { ...b, defaultSelections: sparse } }));
  invalid(() => evaluate({ graph, binding: b }, { maximumSearchNodes: 0 }));
});

// Independent exhaustive root oracle: enumerates explicit quantities and evaluates
// conjunction/conflicts directly, rather than consuming solver witness/search.
for (const a of [0, 1, 2])
  for (const b of [0, 1, 2])
    for (const c of [0, 1, 2]) {
      it(`matches explicit-root integer rule oracle ${a}/${b}/${c}`, () => {
        const f = fixture(1, 3);
        detail(f, 0).quantityRule.minimumQuantity = 2;
        f.details.conditionalRules = [0, 1].map((i) => ({
          ruleReference: id(830 + i),
          whenAllSelected: [option(f, i).optionReference],
          requiredOptionReferences: [option(f, i + 1).optionReference],
        }));
        f.details.conflictRules = [
          {
            ruleReference: id(833),
            forbiddenTogether: [option(f, 0).optionReference, option(f, 2).optionReference],
          },
        ];
        const quantities = [a, b, c],
          defaults = quantities.flatMap((q, i) => (q > 0 ? [[i, q] as [number, number]] : []));
        const expected =
          (a === 0 || a >= 2) && !(a > 0 && b === 0) && !(b > 0 && c === 0) && !(a > 0 && c > 0);
        const result = run(f, binding(f, defaults));
        expect(result.status).toBe(expected ? "Satisfiable" : "Unsatisfiable");
        if (result.status === "Satisfiable")
          expect(result.witness[0]?.options).toEqual(binding(f, defaults).defaultSelections);
      });
    }

it.each(["inherited", "explicit", "maximum", "per-option"])(
  "assesses exact %s default quantity contradiction without relaxing legacy refusal",
  (mode) => {
    const f = fixture();
    const b = binding(f, []);
    if (mode === "inherited") f.source.draft.minimumSelection = 1;
    if (mode === "explicit") b.minimumSelectionOverride = 1;
    if (mode === "maximum") {
      b.maximumSelectionOverride = 1;
      b.defaultSelections = binding(f, [[0, 2]]).defaultSelections;
    }
    if (mode === "per-option") b.defaultSelections = binding(f, [[0, 3]]).defaultSelections;
    const v = { graph: input(f), binding: b };
    invalid(() => evaluate(v));
    expect(assess(v)).toMatchObject({
      status: "Unsatisfiable",
      reason: "NoSelection",
      eligibility: "NotEvaluated",
    });
  },
);
it("does not convert unknown graph or malformed default references into quantity evidence", () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  f.source.draft.minimumSelection = 1;
  const b = binding(f, []);
  expect(assess({ graph: input(f), binding: b })).toMatchObject({
    status: "Indeterminate",
    reason: "IncompleteTriggerGraph",
  });
  const foreign = { ...b, optionSetVersionReference: id(555) };
  invalid(() => assess({ graph: input(f), binding: foreign }));
  option(f, 0).defaultEligible = false;
  invalid(() => assess({ graph: input(f, child), binding: binding(f) }));
});
