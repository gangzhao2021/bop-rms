import { expect, it, vi } from "vitest";
import { evaluateCatalogOptionSetRuleSatisfiability as evaluate } from "../contracts/option-set-rule-satisfiability.js";
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
const run = (...nodes: Fixture[]) => evaluate(input(...nodes));
const references = (result: ReturnType<typeof evaluate>) =>
  result.status === "Satisfiable"
    ? result.witness.flatMap((g) => g.options.map((o) => o.optionReference))
    : [];

it("produces an integer feasible witness while retaining NotEvaluated full graph identities", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 3;
  detail(f, 0).quantityRule.minimumQuantity = 2;
  const result = run(f);
  expect(result.status).toBe("Satisfiable");
  expect(result.eligibility).toBe("NotEvaluated");
  expect(result.identities).toHaveLength(1);
  expect(result.graphDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  if (result.status !== "Satisfiable") throw new Error("missing witness");
  expect(result.witness[0]?.options.reduce((s, o) => s + o.quantity, 0)).toBe(3);
  for (const o of result.witness[0]?.options ?? []) expect(Number.isInteger(o.quantity)).toBe(true);
  expect(Object.isFrozen(result.witness)).toBe(true);
});
it("per-Option minimum applies only when selected; quantity capacity is not distinct choice count", () => {
  const f = fixture(1, 1);
  f.source.draft.minimumSelection = 2;
  detail(f, 0).quantityRule.minimumQuantity = 2;
  const result = run(f);
  expect(result.status).toBe("Satisfiable");
  if (result.status === "Satisfiable") expect(result.witness[0]?.options[0]?.quantity).toBe(2);
  f.source.draft.minimumSelection = 0;
  expect(references(run(f))).toEqual([]);
});
it("finds transitive conditional/conflict contradiction beyond direct parser checks", () => {
  const f = fixture(1, 3);
  f.source.draft.minimumSelection = 6;
  f.details.conditionalRules = [
    {
      ruleReference: id(800),
      whenAllSelected: [option(f, 0).optionReference],
      requiredOptionReferences: [option(f, 1).optionReference],
    },
    {
      ruleReference: id(801),
      whenAllSelected: [option(f, 1).optionReference],
      requiredOptionReferences: [option(f, 2).optionReference],
    },
  ];
  f.details.conflictRules = [
    {
      ruleReference: id(802),
      forbiddenTogether: [option(f, 0).optionReference, option(f, 2).optionReference],
    },
  ];
  expect(() => input(f)).not.toThrow();
  expect(run(f)).toMatchObject({
    status: "Unsatisfiable",
    reason: "NoSelection",
    eligibility: "NotEvaluated",
  });
});
it("excludes disabled choices and honors asymmetric pair conflicts", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 3;
  option(f, 0).conflictOptionReferences = [option(f, 1).optionReference];
  expect(run(f).status).toBe("Unsatisfiable");
  option(f, 0).conflictOptionReferences = [];
  option(f, 0).lifecycle = "Inactive";
  expect(run(f).status).toBe("Unsatisfiable");
  f.source.draft.minimumSelection = 1;
  expect(references(run(f))).toEqual([option(f, 1).optionReference]);
  option(f, 1).lifecycle = "Archived";
  f.source.draft.minimumSelection = 0;
  expect(references(run(f))).toEqual([]);
});
it("enforces per-Option upper capacity even when root nominal capacity is higher", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 3;
  f.details.optionDetails.forEach((d) => (d.quantityRule.maximumQuantity = 1));
  expect(run(f).status).toBe("Unsatisfiable");
});
it("enforces conditional lower quantities against set maxima", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 1;
  f.source.draft.maximumSelection = 1;
  detail(f, 0).quantityRule.minimumQuantity = 2;
  option(f, 1).lifecycle = "Inactive";
  expect(run(f).status).toBe("Unsatisfiable");
});
it("does not impose a minimum on an unreachable triggered branch", () => {
  const root = fixture(),
    child = fixture(2);
  root.source.draft.minimumSelection = 1;
  child.source.draft.minimumSelection = 1;
  child.source.draft.options.forEach((o) => (o.lifecycle = "Inactive"));
  trigger(root, 0, child);
  const result = run(root, child);
  expect(result.status).toBe("Satisfiable");
  expect(references(result)).toEqual([option(root, 1).optionReference]);
  if (result.status === "Satisfiable")
    expect(
      result.witness.find((g) => g.optionSetReference === child.source.optionSetReference),
    ).toMatchObject({ active: false, options: [] });
  root.source.draft.minimumSelection = 3;
  expect(run(root, child).status).toBe("Unsatisfiable");
});
it("activates shared child exactly once from multiple selected parents", () => {
  const root = fixture(),
    child = fixture(2, 1);
  root.source.draft.minimumSelection = 3;
  child.source.draft.minimumSelection = 2;
  trigger(root, 0, child);
  trigger(root, 1, child);
  const result = run(root, child);
  expect(result.status).toBe("Satisfiable");
  if (result.status === "Satisfiable")
    expect(
      result.witness.find((g) => g.optionSetReference === child.source.optionSetReference)?.options,
    ).toHaveLength(1);
});
it("rejects complete trigger cycles even on disabled edges", () => {
  const root = fixture(),
    child = fixture(2);
  trigger(root, 0, child);
  trigger(child, 0, root);
  option(child, 0).lifecycle = "Inactive";
  expect(run(root, child)).toMatchObject({
    status: "Unsatisfiable",
    reason: "TriggerCycle",
    searchNodes: 0,
  });
});
it("missing root or exact pinned child is Indeterminate, including disabled trigger metadata", () => {
  const root = fixture(),
    child = fixture(2);
  trigger(root, 0, child);
  option(root, 0).lifecycle = "Inactive";
  expect(run(root)).toMatchObject({ status: "Indeterminate", reason: "IncompleteTriggerGraph" });
  detail(root, 0).triggeredOptionSetVersionReference = id(299);
  expect(run(root, child)).toMatchObject({
    status: "Indeterminate",
    reason: "IncompleteTriggerGraph",
  });
  expect(evaluate({ ...input(fixture()), rootVersionReference: id(199) }).status).toBe(
    "Indeterminate",
  );
  expect(evaluate({ ...input(fixture()), contents: [] })).toMatchObject({
    status: "Indeterminate",
    reason: "IncompleteTriggerGraph",
  });
});
it("unsupported multiple pins to one Set remain Indeterminate", () => {
  const f = fixture(),
    other = fixture();
  other.source.draft.versionReference = id(102);
  expect(run(f, other)).toMatchObject({
    status: "Indeterminate",
    reason: "AmbiguousTriggerVersion",
  });
});
it("budget exhaustion cannot be reported as unsatisfiable or qualified", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 1;
  expect(evaluate(input(f), { maximumSearchNodes: 1 })).toMatchObject({
    status: "Indeterminate",
    reason: "SearchLimit",
    searchNodes: 1,
    eligibility: "NotEvaluated",
  });
  expect(evaluate(input(f), { maximumSearchNodes: 2 }).status).toBe("Satisfiable");
});
it("whole graph variable limit is explicit and no nodes are truncated", () => {
  const root = fixture(1, 100),
    child = fixture(2, 29);
  trigger(root, 0, child);
  expect(run(root, child)).toMatchObject({
    status: "Indeterminate",
    reason: "ComplexityLimit",
    searchNodes: 0,
  });
});
it("normalization/order yields deterministic witness and graph identity", () => {
  const root = fixture(),
    child = fixture(2);
  root.source.draft.minimumSelection = 3;
  child.source.draft.minimumSelection = 1;
  trigger(root, 0, child);
  const first = run(root, child),
    second = evaluate({ ...input(root, child), contents: input(root, child).contents.reverse() });
  expect(second).toEqual(first);
  root.source.draft.localizedNames["en-CA"] = "Later synthetic prose";
  const changed = run(root, child);
  expect(changed.graphDigest).not.toBe(first.graphDigest);
  expect(references(changed)).toEqual(references(first));
});
it("returns detached witnesses/identities when candidate values later change", () => {
  const f = fixture();
  f.source.draft.minimumSelection = 1;
  const supplied = input(f),
    result = evaluate(supplied),
    prior = JSON.stringify(result);
  const source = supplied.contents[0]?.sourceAggregate;
  expect(Object.isFrozen(source)).toBe(true);
  f.source.draft.options.splice(0);
  expect(JSON.stringify(result)).toBe(prior);
});
it.each([0, -1, 65537, 1.5, Infinity, null, "2"])(
  "refuses invalid server search budget %s",
  (budget) => {
    expect(() => evaluate(input(fixture()), { maximumSearchNodes: budget })).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
  },
);
it("refuses getters, sparse sources, extra readiness, duplicate nodes, foreign Brand and unrelated bodies", () => {
  const f = fixture(),
    value = input(f),
    getter = vi.fn(() => value.contents);
  const accessor = { ...value };
  Object.defineProperty(accessor, "contents", { enumerable: true, get: getter });
  expect(() => evaluate(accessor)).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  expect(getter).not.toHaveBeenCalled();
  expect(() => evaluate({ ...value, contents: Array(1) })).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  expect(() => evaluate({ ...value, eligibility: "Ready" })).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  expect(() =>
    evaluate({ ...value, contents: [...value.contents, ...value.contents] }),
  ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  expect(() => evaluate({ ...value, brandReference: id(9) })).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  expect(() => run(f, fixture(2))).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});

/** Independent small integer enumeration, rather than the production presence
 * propagation/interval algorithm. Every q in [0,1,2] is checked directly. */
function validQuantities(nodes: Fixture[], quantities: ReadonlyMap<string, number>): boolean {
  const rows = nodes.flatMap((f) => f.source.draft.options.map((o) => ({ f, o })));
  const q = (r: string) => quantities.get(r) ?? 0;
  return nodes.every((f, i) => {
    const active =
      i === 0 ||
      rows.some(
        (r) =>
          r.o.triggeredOptionSetReference === f.source.optionSetReference &&
          q(r.o.optionReference) > 0,
      );
    const opts = f.source.draft.options,
      total = opts.reduce((s, o) => s + q(o.optionReference), 0);
    if (!active) return total === 0;
    if (
      total < f.source.draft.minimumSelection ||
      (f.source.draft.maximumSelection !== null && total > f.source.draft.maximumSelection) ||
      (f.source.draft.maximumTotalQuantity !== null && total > f.source.draft.maximumTotalQuantity)
    )
      return false;
    if (
      opts.some((o, j) => {
        const amount = q(o.optionReference),
          d = detail(f, j);
        return (
          (amount > 0 &&
            (o.lifecycle === "Inactive" ||
              o.lifecycle === "Archived" ||
              amount < Math.max(1, d.quantityRule.minimumQuantity) ||
              amount > d.quantityRule.maximumQuantity)) ||
          (amount > 0 && o.conflictOptionReferences.some((r) => q(r) > 0))
        );
      })
    )
      return false;
    if (f.details.conflictRules.some((r) => r.forbiddenTogether.every((ref) => q(ref) > 0)))
      return false;
    if (
      f.details.conditionalRules.some(
        (r) =>
          r.whenAllSelected.every((ref) => q(ref) > 0) &&
          r.requiredOptionReferences.some((ref) => q(ref) === 0),
      )
    )
      return false;
    return true;
  });
}
function brute(nodes: Fixture[]): boolean {
  const rows = nodes.flatMap((f) =>
    f.source.draft.options.map((o, i) => ({ f, o, d: detail(f, i) })),
  );
  const quantities = new Map<string, number>();
  const enumerate = (i: number): boolean => {
    const row = rows[i];
    if (!row) return validQuantities(nodes, quantities);
    for (const amount of [0, 1, 2]) {
      quantities.set(row.o.optionReference, amount);
      if (enumerate(i + 1)) return true;
    }
    return false;
  };
  return enumerate(0);
}
it.each(Array.from({ length: 81 }, (_, i) => i))(
  "matches independent full integer enumeration for small graph %i",
  (n) => {
    const root = fixture(),
      child = fixture(2);
    trigger(root, 0, child);
    root.source.draft.minimumSelection = n % 3;
    child.source.draft.minimumSelection = Math.floor(n / 3) % 3;
    detail(root, 1).quantityRule.minimumQuantity = Math.floor(n / 9) % 3;
    if (n % 2 === 0) option(child, 0).lifecycle = "Inactive";
    if (n % 5 === 0) option(root, 1).lifecycle = "Inactive";
    if (n % 7 === 0)
      root.details.conditionalRules = [
        {
          ruleReference: id(800),
          whenAllSelected: [option(root, 0).optionReference],
          requiredOptionReferences: [option(root, 1).optionReference],
        },
      ];
    if (n % 4 === 0)
      child.details.conflictRules = [
        {
          ruleReference: id(801),
          forbiddenTogether: child.source.draft.options.map((o) => o.optionReference),
        },
      ];
    const result = run(root, child);
    expect(result.status).toBe(brute([root, child]) ? "Satisfiable" : "Unsatisfiable");
    checkWitness([root, child], result);
  },
);

function checkWitness(nodes: Fixture[], result: ReturnType<typeof evaluate>): void {
  if (result.status !== "Satisfiable") return;
  const quantities = new Map(
    result.witness.flatMap((g) => g.options.map((o) => [o.optionReference, o.quantity] as const)),
  );
  expect(validQuantities(nodes, quantities)).toBe(true);
  expect(result.witness).toHaveLength(nodes.length);
  for (const g of result.witness) {
    const node = nodes.find((n) => n.source.optionSetReference === g.optionSetReference);
    if (!node) throw new Error("unknown witness source");
    expect(g.versionReference).toBe(node.source.draft.versionReference);
    const active =
      node === nodes[0] ||
      nodes.some((n) =>
        n.source.draft.options.some(
          (o) =>
            o.triggeredOptionSetReference === g.optionSetReference &&
            (quantities.get(o.optionReference) ?? 0) > 0,
        ),
      );
    expect(g.active).toBe(active);
    for (const o of g.options) {
      expect(node.source.draft.options.some((v) => v.optionReference === o.optionReference)).toBe(
        true,
      );
      expect(Number.isInteger(o.quantity) && o.quantity > 0).toBe(true);
    }
  }
}
it.each(Array.from({ length: 18 }, (_, i) => i))(
  "matches multi-antecedent/hyper-conflict and optional grandchild enumeration %i",
  (n) => {
    const root = fixture(1, 4),
      child = fixture(2, 1),
      leaf = fixture(3, 1);
    trigger(root, 0, child);
    trigger(root, 1, child);
    trigger(child, 0, leaf);
    root.source.draft.minimumSelection = n % 8;
    child.source.draft.minimumSelection = Math.floor(n / 8);
    leaf.source.draft.minimumSelection = 1;
    if (n % 2 === 0) option(leaf, 0).lifecycle = "Inactive";
    root.details.conditionalRules = [
      {
        ruleReference: id(800),
        whenAllSelected: [option(root, 0).optionReference, option(root, 1).optionReference],
        requiredOptionReferences: [option(root, 2).optionReference],
      },
    ];
    root.details.conflictRules = [
      {
        ruleReference: id(801),
        forbiddenTogether: [
          option(root, 0).optionReference,
          option(root, 2).optionReference,
          option(root, 3).optionReference,
        ],
      },
    ];
    const nodes = [root, child, leaf],
      result = run(...nodes);
    expect(result.status).toBe(brute(nodes) ? "Satisfiable" : "Unsatisfiable");
    checkWitness(nodes, result);
  },
);
it("evaluates a later-sorting root and earlier child with independent witness evidence", () => {
  const root = fixture(2),
    child = fixture(1);
  root.source.draft.minimumSelection = 3;
  child.source.draft.minimumSelection = 1;
  trigger(root, 0, child);
  trigger(root, 1, child);
  const result = evaluate({
    ...input(root, child),
    rootOptionSetReference: root.source.optionSetReference,
    rootVersionReference: root.source.draft.versionReference,
  });
  expect(result.status).toBe(brute([root, child]) ? "Satisfiable" : "Unsatisfiable");
  checkWitness([root, child], result);
});
