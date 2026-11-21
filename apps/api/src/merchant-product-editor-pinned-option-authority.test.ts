import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate, productEditorContentFields } from "@rms/catalog";
import {
  createMerchantProductEditorPinnedOptionAuthority as create,
  type CurrentPublishedProductOptionBindingPort,
  type CurrentPublishedProductOptionBindingAssessment,
} from "./merchant-product-editor-pinned-option-authority.js";
import { remainingProductEditorVariantReferenceChecks } from "./merchant-product-editor-variant-content-authority.js";
const mock = vi.hoisted(() => ({ run: vi.fn(), options: vi.fn() }));
vi.mock("./frozen-full-option-binding-rule-source.js", () => ({
  createFrozenFullOptionBindingRuleSource: (options: unknown) => {
    mock.options(options);
    return { withPinnedAssessment: mock.run };
  },
}));
const id = (n: number) => `019a2448-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-01T01:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n).toISOString();
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
type Source = ReturnType<
  typeof import("./frozen-full-option-binding-rule-source.js").createFrozenFullOptionBindingRuleSource
>;
type Work = Parameters<Source["withPinnedAssessment"]>[2];
function fixture(count = 2) {
  let clock = at;
  const order: string[] = [];
  const bindings = Array.from({ length: count }, (_, i) => ({
    bindingReference: id(100 + i),
    optionSetReference: id(200 + i),
    optionSetVersionReference: id(300 + i),
    purpose: "CUSTOMIZATION",
    sortOrder: i,
    enabledOptionReferences: [],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  }));
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "OPTIONS",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 2,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [...bindings].reverse(),
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
        optionRules: bindings.map((binding) => ({
          bindingReference: binding.bindingReference,
          versionResolution: "Pinned",
          pricingRule: null,
          conditionalRule: null,
          conflictRule: null,
          variantCondition: [],
        })),
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const remaining = vi.fn<Options["remainingAuthority"]>(async () => {
    order.push("remaining");
  });
  const held = vi.fn<Options["optionAuthority"]["holdUntilTransactionCompletes"]>(
    async (_tx, r) => ({ observedAt: r.observedAt, validUntil: plus(30000) }),
  );
  const options: Options = {
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => clock },
    remainingAuthority: remaining,
    optionAuthority: { holdUntilTransactionCompletes: held },
  };
  const sourceFor = (
    binding: Readonly<{
      bindingReference: string;
      optionSetReference: string;
      optionSetVersionReference: string;
    }>,
  ) => ({
    profile: "FrozenFullOptionBindingRuleAssessmentV1" as const,
    tenantReference: id(10),
    brandReference: id(2),
    bindingReference: binding.bindingReference,
    bindingDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(binding)),
    rootOptionSetReference: binding.optionSetReference,
    rootVersionReference: binding.optionSetVersionReference,
    graphDigest: "sha256:" + "a".repeat(64),
    digest: "sha256:" + "b".repeat(64),
    sourceRecords: [],
    rules: { status: "Satisfiable" as const, reason: null, searchNodes: 1 },
    observedAt: at,
    validUntil: plus(5000),
    publishValidation: "Incomplete" as const,
    referenceEligibility: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
  mock.run.mockImplementation(
    async (actualTx: unknown, binding: (typeof bindings)[number], work: Work) => {
      expect(actualTx).toBe(tx);
      order.push("enter" + binding.sortOrder);
      const result = await work(sourceFor(binding));
      order.push("exit" + binding.sortOrder);
      return result;
    },
  );
  const base = {
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    storeReference: id(11),
    sessionReference: id(12),
    productReference: id(1),
    operationReference: id(13),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
    observedAt: at,
    validUntil: plus(5000),
    aggregate,
    requiredFields: productEditorContentFields,
  };
  return {
    tx,
    base,
    options,
    authority: create(options),
    remaining,
    held,
    order,
    bindings,
    aggregate,
    sourceFor,
    clock: (value: string) => {
      clock = value;
    },
    write: () => ({
      ...base,
      mode: "DraftWrite" as const,
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
    }),
    read: () => ({ ...base, mode: "Read" as const, requiredReferenceChecks: [] }),
  };
}
beforeEach(() => {
  mock.run.mockReset();
  mock.options.mockReset();
});
it("nests every sorted candidate Binding around remaining full fields and all five checks", async () => {
  const f = fixture();
  await f.authority(f.tx, f.write());
  expect(f.order).toEqual(["enter0", "enter1", "remaining", "exit1", "exit0"]);
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      requiredFields: productEditorContentFields,
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
      validUntil: plus(5000),
    }),
  );
});
it("empty Bindings still require the complete remaining holder", async () => {
  const f = fixture(0);
  await f.authority(f.tx, f.write());
  expect(mock.run).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("Read retains fields without historical source acquisition or qualification", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  expect(mock.options).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ requiredReferenceChecks: [] }),
  );
});
it("CurrentPublished without its actual source refuses before frozen acquisition", async () => {
  const f = fixture();
  const value = f.write();
  const editor = f.aggregate.draft.editorContent;
  if (!editor) throw new Error("synthetic full fixture missing");
  await expect(
    f.authority(f.tx, {
      ...value,
      aggregate: {
        ...f.aggregate,
        draft: {
          ...f.aggregate.draft,
          editorContent: {
            ...editor,
            optionRules: editor.optionRules.map((r) => ({
              ...r,
              versionResolution: "CurrentPublished",
            })),
          },
        },
      },
    }),
  ).rejects.toMatchObject(unavailable);
  expect(mock.run).not.toHaveBeenCalled();
});

function currentInput(f: ReturnType<typeof fixture>, indices: readonly number[]) {
  const editor = f.aggregate.draft.editorContent;
  if (!editor) throw new Error("synthetic complete editor required");
  return {
    ...f.write(),
    aggregate: parseProductAggregate({
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        editorContent: {
          ...editor,
          optionRules: editor.optionRules.map((rule, index) => ({
            ...rule,
            versionResolution: indices.includes(index) ? "CurrentPublished" : "Pinned",
          })),
        },
      },
    }),
  };
}
function currentPort(
  f: ReturnType<typeof fixture>,
  transform: (
    assessment: CurrentPublishedProductOptionBindingAssessment,
  ) => CurrentPublishedProductOptionBindingAssessment = (value) => value,
) {
  const port: CurrentPublishedProductOptionBindingPort = {
    async withBindingAssessment(tx, binding, work) {
      expect(tx).toBe(f.tx);
      f.order.push("current-enter" + binding.sortOrder);
      const assessment: CurrentPublishedProductOptionBindingAssessment = {
        ...f.sourceFor(binding),
        profile: "CurrentPublishedProductOptionBindingAssessmentV1",
        sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
      };
      const result = await work(transform(assessment));
      f.order.push("current-exit" + binding.sortOrder);
      return result;
    },
  };
  return port;
}
it("dispatches each actual resolution mode around the same mandatory remaining holder", async () => {
  const f = fixture();
  const authority = create({ ...f.options, currentPublished: currentPort(f) });
  await authority(f.tx, currentInput(f, [1]));
  expect(f.order).toEqual(["enter0", "current-enter1", "remaining", "current-exit1", "exit0"]);
  expect(mock.run).toHaveBeenCalledOnce();
  expect(f.remaining).toHaveBeenCalledOnce();
  expect(
    f.remaining.mock.calls[0]?.[1].aggregate.draft.editorContent?.optionRules[1]?.versionResolution,
  ).toBe("CurrentPublished");
});
it("CurrentPublished Read remains an authorized full-field read without reacquiring source qualification", async () => {
  const f = fixture(1),
    port = currentPort(f);
  const spy = vi.spyOn(port, "withBindingAssessment");
  const authority = create({ ...f.options, currentPublished: port });
  await authority(f.tx, { ...currentInput(f, [0]), mode: "Read", requiredReferenceChecks: [] });
  expect(spy).not.toHaveBeenCalled();
  expect(mock.run).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledOnce();
});
it.each(["version", "source", "profile", "lease", "getter"])(
  "CurrentPublished %s mismatch cannot become a Frozen or silently upgraded proof",
  async (mode) => {
    const f = fixture(1);
    const authority = create({
      ...f.options,
      currentPublished: currentPort(f, (assessment) => {
        if (mode === "getter") {
          const packet = { ...assessment };
          Object.defineProperty(packet, "graphDigest", {
            enumerable: true,
            get: () => {
              throw new Error("must not invoke");
            },
          });
          return packet;
        }
        if (mode === "profile") {
          const packet = { ...assessment };
          Object.defineProperty(packet, "profile", {
            enumerable: true,
            value: "FrozenFullOptionBindingRuleAssessmentV1",
          });
          return packet;
        }
        if (mode === "source") {
          const packet = { ...assessment };
          Object.defineProperty(packet, "sourceAuthority", {
            enumerable: true,
            value: "CallerClaimed",
          });
          return packet;
        }
        return {
          ...assessment,
          ...(mode === "version" ? { rootVersionReference: id(999) } : {}),
          ...(mode === "lease" ? { validUntil: plus(5001) } : {}),
        };
      }),
    });
    await expect(authority(f.tx, currentInput(f, [0]))).rejects.toMatchObject(unavailable);
    expect(mock.run).not.toHaveBeenCalled();
    expect(f.remaining).not.toHaveBeenCalled();
  },
);
it("CurrentPublished shortened lease and remaining denial retain the original request barrier", async () => {
  const f = fixture(1);
  const authority = create({
    ...f.options,
    currentPublished: currentPort(f, (assessment) => ({ ...assessment, validUntil: plus(1000) })),
  });
  f.remaining.mockImplementation(async () => {
    f.clock(plus(1000));
  });
  await expect(authority(f.tx, currentInput(f, [0]))).rejects.toMatchObject(unavailable);
  const g = fixture(1);
  const denied = create({ ...g.options, currentPublished: currentPort(g) });
  g.remaining.mockImplementation(async () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(denied(g.tx, currentInput(g, [0]))).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(g.remaining).toHaveBeenCalledOnce();
});
it("CurrentPublished reentry poisons the outer invocation and changed query refuses", async () => {
  const f = fixture(1),
    port = currentPort(f);
  const authority = create({ ...f.options, currentPublished: port });
  f.remaining.mockImplementation(async () => {
    await expect(authority(f.tx, currentInput(f, [0]))).rejects.toMatchObject(unavailable);
  });
  await expect(authority(f.tx, currentInput(f, [0]))).rejects.toMatchObject(unavailable);
  const g = fixture(1),
    changed = create({ ...g.options, currentPublished: currentPort(g) });
  g.remaining.mockImplementation(async () => {
    g.tx.query = vi.fn(async () => ({ rows: [] }));
  });
  await expect(changed(g.tx, currentInput(g, [0]))).rejects.toMatchObject(unavailable);
});
it("CurrentPublished port replacement refuses and late owner denial cannot be mistaken for success", async () => {
  const f = fixture(1),
    port = currentPort(f);
  const authority = create({ ...f.options, currentPublished: port });
  port.withBindingAssessment = async () => {
    throw new Error("rebound source must not run");
  };
  await expect(authority(f.tx, currentInput(f, [0]))).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
  const g = fixture(1),
    late = currentPort(g),
    original = late.withBindingAssessment.bind(late);
  late.withBindingAssessment = async (tx, binding, work) => {
    await original(tx, binding, work);
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  };
  const denied = create({ ...g.options, currentPublished: late });
  await expect(denied(g.tx, currentInput(g, [0]))).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(g.remaining).toHaveBeenCalledOnce();
});
it("33 Bindings refuse without truncation", async () => {
  const f = fixture(33);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(mock.run).not.toHaveBeenCalled();
});
it.each(["Unsatisfiable", "Indeterminate"] as const)(
  "%s is surfaced after source final holds",
  async (status) => {
    const f = fixture();
    mock.run.mockImplementation(
      async (_tx: unknown, binding: (typeof f.bindings)[number], work: Work) => {
        const result = await work({
          ...f.sourceFor(binding),
          rules: { status, reason: "Synthetic", searchNodes: 1 },
        });
        f.order.push("final");
        return result;
      },
    );
    await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
      code:
        status === "Unsatisfiable"
          ? "CATALOG_LIFECYCLE_CONFLICT"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.order).toEqual(["final"]);
    expect(f.remaining).not.toHaveBeenCalled();
  },
);
it("late source refusal beats known mechanical conflict", async () => {
  const f = fixture();
  mock.run.mockImplementation(
    async (_tx: unknown, binding: (typeof f.bindings)[number], work: Work) => {
      await work({
        ...f.sourceFor(binding),
        rules: { status: "Unsatisfiable", reason: "Synthetic", searchNodes: 1 },
      });
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  );
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
it.each(["skip", "repeat", "unknown", "foreign", "renewed"])("%s source refuses", async (mode) => {
  const f = fixture();
  mock.run.mockImplementation(
    async (_tx: unknown, binding: (typeof f.bindings)[number], work: Work) => {
      if (mode === "skip") return undefined;
      const s = f.sourceFor(binding);
      const value = {
        ...s,
        ...(mode === "foreign" ? { rootVersionReference: id(999) } : {}),
        ...(mode === "renewed" ? { validUntil: plus(5001) } : {}),
      };
      await work(value);
      if (mode === "repeat") await work(value);
      return mode === "unknown" ? "Allowed" : undefined;
    },
  );
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it.each([-1, 5000])("exclusive original clock boundary %sms refuses", async (delta) => {
  const f = fixture();
  f.clock(plus(delta));
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it("shorter source expiry remains enforced after remaining holder", async () => {
  const f = fixture(1);
  mock.run.mockImplementation(
    async (_tx: unknown, binding: (typeof f.bindings)[number], work: Work) =>
      work({ ...f.sourceFor(binding), validUntil: plus(1000) }),
  );
  f.remaining.mockImplementation(async () => {
    f.clock(plus(1000));
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it("source authority is captured and capped to original lease", async () => {
  const f = fixture(1);
  f.options.optionAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("rebound");
  };
  await f.authority(f.tx, f.write());
  const o = mock.options.mock.calls[0]?.[0] as Parameters<
    typeof import("./frozen-full-option-binding-rule-source.js").createFrozenFullOptionBindingRuleSource
  >[0];
  const r = {
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    observedAt: at,
    actorKind: "User" as const,
    permission: "catalog.manage" as const,
    action: "catalog.option_set.read" as const,
    purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
    requiredFields: [],
    optionSetReference: f.bindings[0]?.optionSetReference ?? id(200),
    versionReference: f.bindings[0]?.optionSetVersionReference ?? id(300),
    content: null,
  };
  expect(await o.authority.holdUntilTransactionCompletes(f.tx, r)).toEqual({
    observedAt: at,
    validUntil: plus(5000),
  });
  expect(f.held).toHaveBeenCalledOnce();
});
it("remaining denial and non-void poison the same transaction", async () => {
  const f = fixture(0);
  f.remaining.mockImplementation(async () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.remaining.mockImplementation(async () => undefined);
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
});
it.each(["tenantReference", "brandReference", "actorReference", "productReference"])(
  "foreign %s refuses",
  async (key) => {
    const f = fixture();
    await expect(f.authority(f.tx, { ...f.write(), [key]: id(999) })).rejects.toMatchObject(
      unavailable,
    );
  },
);
it("closed input/getters and partial fields cannot qualify", async () => {
  const f = fixture();
  const partial = { ...f.write(), requiredFields: [] };
  await expect(
    f.authority(f.tx, partial as unknown as Parameters<typeof f.authority>[1]),
  ).rejects.toMatchObject(unavailable);
  const g = fixture();
  const invalid = { ...g.write(), clientGraph: {} };
  await expect(g.authority(g.tx, invalid)).rejects.toMatchObject(unavailable);
});

it("unknown remaining holder result refuses", async () => {
  const f = fixture(0);
  f.remaining.mockImplementation(async () => "Allowed" as never);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});

it("accessor input refuses without invoking supplied getter", async () => {
  const f = fixture();
  const getter = vi.fn(() => f.aggregate);
  const value = { ...f.write() };
  Object.defineProperty(value, "aggregate", { enumerable: true, get: getter });
  await expect(f.authority(f.tx, value)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
});

it("Create keeps explicit original purpose through actual owning content and remaining holder", async () => {
  const f = fixture(),
    input = {
      ...f.write(),
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
      aggregate: parseProductAggregate({
        ...f.aggregate,
        aggregateVersion: 1,
        draft: {
          ...f.aggregate.draft,
          optionBindings: [],
          editorContent: { ...f.aggregate.draft.editorContent, optionRules: [] },
        },
      }),
    };
  await f.authority(f.tx, input);
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      purposeCode: "CATALOG_PRODUCT_CREATE",
      mode: "DraftWrite",
      aggregate: input.aggregate,
    }),
  );
});
it.each(["Read", "root"])("Create refuses %s without new source admission", async (kind) => {
  const f = fixture(),
    input = {
      ...f.write(),
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
      aggregate: parseProductAggregate({
        ...f.aggregate,
        aggregateVersion: 1,
        draft: {
          ...f.aggregate.draft,
          optionBindings: [],
          editorContent: { ...f.aggregate.draft.editorContent, optionRules: [] },
        },
      }),
    };
  const invalid =
    kind === "Read"
      ? { ...input, mode: "Read" as const, requiredReferenceChecks: [] }
      : { ...input, aggregate: parseProductAggregate({ ...input.aggregate, aggregateVersion: 2 }) };
  await expect(f.authority(f.tx, invalid)).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
});
