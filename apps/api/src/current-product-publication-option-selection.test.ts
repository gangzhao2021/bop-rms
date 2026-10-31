import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductOptionBinding,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  productPublicationFrozenFullOptionSetContentFields,
  type ProductPublicationFactsV2,
} from "@rms/catalog";
import {
  createCurrentProductPublicationOptionSelectionSource,
  type CurrentProductPublicationOptionSelection,
} from "./current-product-publication-option-selection.js";
import type {
  createProductPublicationFrozenFullOptionBindingRuleSource,
  FrozenFullOptionBindingRuleAssessment,
} from "./frozen-full-option-binding-rule-source.js";
import type {
  PublicationQualificationInput,
  WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";

type GraphOptions = Parameters<typeof createProductPublicationFrozenFullOptionBindingRuleSource>[0];
type Options = Parameters<typeof createCurrentProductPublicationOptionSelectionSource>[0];
type Tx = Options["transaction"];
type Binding = ReturnType<typeof parseProductOptionBinding>;
const graph = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
  asyncGuard: vi.fn(),
  finalAssert: vi.fn(),
}));
vi.mock("./frozen-full-option-binding-rule-source.js", async (original) => ({
  ...(await original<typeof import("./frozen-full-option-binding-rule-source.js")>()),
  // This is a controlled full-graph owner boundary. Actual private context and
  // Catalog OptionSelection assessment execute; no SQL or graph acquisition is
  // claimed by this suite. Every factory instance keeps its real callback API.
  createProductPublicationFrozenFullOptionBindingRuleSource(options: GraphOptions) {
    graph.create(options);
    return {
      async withPinnedAssessment<T>(
        tx: Tx,
        value: unknown,
        work: (assessment: FrozenFullOptionBindingRuleAssessment) => Promise<T>,
      ): Promise<T> {
        const binding = parseProductOptionBinding(value);
        await options.registerBeforeCommit(
          tx,
          async () => {
            await graph.asyncGuard(tx, binding);
          },
          () => {
            graph.finalAssert(tx, binding);
          },
        );
        return graph.read(tx, binding, work, options) as Promise<T>;
      },
    };
  },
}));
const id = (n: number) => "01902445-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString();
function binding(n: number) {
  return {
    bindingReference: id(900 + n),
    optionSetReference: id(100 + n),
    optionSetVersionReference: id(200 + n),
    purpose: "CUSTOMIZATION",
    sortOrder: n,
    enabledOptionReferences: [id(300 + n)],
    defaultSelections: [{ optionReference: id(300 + n), quantity: 1 }],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: ["WEB"],
    storeOverrideAllowed: false,
  };
}
function publication(
  count = 1,
  currentIndices: readonly number[] = [],
): PublicationQualificationInput {
  const bindings = Array.from({ length: count }, (_, i) => binding(i)),
    aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_OPTION_PRODUCT",
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
        localizedNames: { "en-CA": "Synthetic pinned option fixture" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: bindings,
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
          optionRules: bindings.map((b) => ({
            bindingReference: b.bindingReference,
            versionResolution: currentIndices.includes(b.sortOrder) ? "CurrentPublished" : "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          })),
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(8),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [
        { level: "Store", reference: id(30), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_OPTION_SOURCE",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    });
  return { command, aggregate, current: null, content: null, observedAt: at };
}
function acknowledgement(useCurrent = false): WarningAcknowledgementQualificationInput {
  const input = publication(1, useCurrent ? [0] : []),
    c = input.command,
    facts: ProductPublicationFactsV2 = {
      now: at,
      productAggregateVersion: 7,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      approval: null,
      reviewReference: null,
      replacement: null,
      validation: {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: c.replacementIntentDigest,
        evidenceReference: id(50),
        productAggregateVersion: 7,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        policyReference: id(20),
        policyVersion: 1,
        approvalPolicy: "Required",
        checks: productPublicationCheckCodes.map((code) => ({
          code,
          outcome:
            code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
        })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: plus(at, 3000),
      },
    },
    current = planCatalogProductPublicationV2(c, null, facts),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE_GAP",
          outcome: "Warning",
          subjectReference: id(80),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("controlled source"),
          generation: "1",
          relevantReferenceDigest: hash("controlled relevant references"),
          observedAt: at,
          validUntil: plus(at, 3000),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: c,
      publication: current,
      validation: facts.validation,
      details,
      recordedAt: at,
    }),
    aggregate = parseProductAggregate({ ...input.aggregate, aggregateVersion: 11 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(60),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 11,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: humanAt,
    });
  return {
    command,
    aggregate,
    current,
    report,
    observedAt: plus(humanAt, 10),
    validUntil: plus(humanAt, 2000),
  };
}
function observation(
  b: Binding,
  options: GraphOptions,
  changes: Partial<Omit<FrozenFullOptionBindingRuleAssessment, "digest">> = {},
): FrozenFullOptionBindingRuleAssessment {
  const body: Omit<FrozenFullOptionBindingRuleAssessment, "digest"> = {
    profile: "FrozenFullOptionBindingRuleAssessmentV1",
    tenantReference: id(1),
    brandReference: id(2),
    bindingReference: b.bindingReference,
    bindingDigest: hash(b),
    rootOptionSetReference: b.optionSetReference,
    rootVersionReference: b.optionSetVersionReference,
    graphDigest: hash({ graph: b.optionSetVersionReference }),
    sourceRecords: Object.freeze([
      Object.freeze({
        optionSetReference: b.optionSetReference,
        versionReference: b.optionSetVersionReference,
        recordDigest: hash({ record: b.optionSetVersionReference }),
        observedAt: options.observedAt,
      }),
    ]),
    rules: Object.freeze({ status: "Satisfiable", reason: null, searchNodes: 1 }),
    observedAt: options.observedAt,
    validUntil: options.validUntil,
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    ...changes,
  };
  return Object.freeze({ ...body, digest: hash(body) });
}
type Work = (assessment: FrozenFullOptionBindingRuleAssessment) => Promise<unknown>;
function fixture(input = publication(), currentPublished?: Options["currentPublished"]) {
  let time = input.observedAt;
  const query = vi.fn(async () => ({ rows: [] })),
    tx: Tx = { query: query as unknown as Tx["query"] },
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async (_tx, value) => ({
      observedAt: value.observedAt,
      validUntil: plus(value.observedAt, 3000),
    })),
    register = vi.fn<Options["registerBeforeCommit"]>(async (actual, guard, finalAssert) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(finalAssert);
    }),
    options: Options = {
      transaction: tx,
      ...(currentPublished ? { currentPublished } : {}),
      clock: { now: () => time },
      authority: { holdUntilTransactionCompletes: hold },
      registerBeforeCommit: register,
    },
    source = createCurrentProductPublicationOptionSelectionSource(options),
    work = vi.fn(async (value: CurrentProductPublicationOptionSelection) => value),
    validUntil = plus(input.observedAt, 3000);
  return {
    input,
    source,
    options,
    tx,
    query,
    hold,
    register,
    guards,
    finals,
    work,
    validUntil,
    setTime(value: string) {
      time = value;
    },
    run: () => source.withPublication(input, validUntil, work),
    async commitGuards() {
      for (const guard of guards) await guard();
      for (const final of finals) final();
    },
  };
}
beforeEach(() => {
  graph.create.mockReset();
  graph.read.mockReset();
  graph.asyncGuard.mockReset();
  graph.finalAssert.mockReset();
  graph.read.mockImplementation(async (_tx: Tx, b: Binding, work: Work, options: GraphOptions) =>
    work(observation(b, options)),
  );
});

it("assesses truly empty saved bindings without any graph read or invented other checks", async () => {
  const f = fixture(publication(0)),
    result = await f.run();
  expect(graph.create).not.toHaveBeenCalled();
  expect(graph.read).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    originalIntentDigest: hash(f.input.command),
    check: { code: "OptionSelection", outcome: "Pass" },
    findings: [],
    validUntil: f.validUntil,
  });
  expect(result).not.toHaveProperty("checks");
  expect(result).not.toHaveProperty("eligibility");
  await f.commitGuards();
});
it("retains complete publication intent and original lease through the graph boundary", async () => {
  const f = fixture(),
    result = await f.run(),
    sent = graph.create.mock.calls[0]?.[0] as GraphOptions | undefined;
  if (!sent) throw Error("Expected actual graph call");
  expect(sent.command).toEqual(f.input.command);
  expect(sent.observedAt).toBe(f.input.observedAt);
  expect(sent.validUntil).toBe(f.validUntil);
  expect(sent.defaultQuantityAssessment).toBe("Prerequisites");
  expect(graph.read.mock.calls[0]?.[0]).toBe(f.tx);
  expect(result.originalIntentDigest).toBe(hash(f.input.command));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.sources[0])).toBe(true);
  await f.commitGuards();
});
it("keeps independent Ack purpose, full command and fresh original lease after human reading", async () => {
  const input = acknowledgement(),
    f = fixture();
  f.setTime(input.observedAt);
  const result = await f.source.withAcknowledgement(input, f.work),
    sent = graph.create.mock.calls[0]?.[0] as GraphOptions | undefined;
  if (!sent) throw Error("Expected Ack graph call");
  expect(sent.command).toEqual(input.command);
  expect(sent.command).not.toHaveProperty("scopeSet");
  expect(sent).toMatchObject({ observedAt: input.observedAt, validUntil: input.validUntil });
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(result.validUntil).toBe(input.validUntil);
  expect(input.report.validation.validUntil < input.observedAt).toBe(true);
  await f.commitGuards();
});
it("keeps semantic reference digest stable across new operation, root and read time", async () => {
  const first = fixture(),
    a = await first.run(),
    old = publication(),
    observedAt = plus(at, 1000),
    aggregate = parseProductAggregate({ ...old.aggregate, aggregateVersion: 9 }),
    input = {
      ...old,
      aggregate,
      observedAt,
      command: parseProductPublicationCommandV2({
        ...old.command,
        operationReference: id(70),
        expectedProductAggregateVersion: 9,
        occurredAt: observedAt,
      }),
    },
    second = fixture(input),
    b = await second.run();
  expect(a.sources[0]?.relevantReferenceDigest).toBe(b.sources[0]?.relevantReferenceDigest);
  expect(a.sources[0]?.sourceDigest).not.toBe(b.sources[0]?.sourceDigest);
  expect(a.originalIntentDigest).not.toBe(b.originalIntentDigest);
});
it("preserves each contradictory binding and the precise immutable root record digest", async () => {
  const f = fixture(publication(2));
  graph.read.mockImplementation(async (_tx: Tx, b: Binding, work: Work, options: GraphOptions) =>
    work(
      observation(b, options, {
        rules: Object.freeze({
          status: "Unsatisfiable",
          reason: b.sortOrder === 0 ? "TriggerCycle" : "NoSelection",
          searchNodes: 3,
        }),
      }),
    ),
  );
  const result = await f.run();
  expect(graph.create).toHaveBeenCalledTimes(2);
  expect(graph.read.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
  expect(result.check.outcome).toBe("HardError");
  expect(result.findings).toEqual(
    f.input.aggregate.draft.optionBindings.map((b, index) => ({
      checkCode: "OptionSelection",
      outcome: "HardError",
      subjectReference: b.bindingReference,
      ruleCode: index === 0 ? "OPTION_TRIGGER_CYCLE" : "OPTION_RULES_UNSATISFIABLE",
      reasonCode: index === 0 ? "OPTION_TRIGGER_CYCLE" : "OPTION_RULES_UNSATISFIABLE",
      references: [
        {
          sourceCode: "PINNED_OPTION_RULES",
          resourceReference: b.optionSetReference,
          versionReference: b.optionSetVersionReference,
          referenceDigest: hash({ record: b.optionSetVersionReference }),
        },
      ],
    })),
  );
  expect(Object.isFrozen(result.findings[0]?.references)).toBe(true);
});
it("keeps the earliest graph deadline through consumer and both outer commit guards", async () => {
  const f = fixture(),
    end = plus(at, 1000);
  graph.read.mockImplementation(async (_tx: Tx, b: Binding, work: Work, options: GraphOptions) =>
    work(observation(b, options, { validUntil: end })),
  );
  expect((await f.run()).validUntil).toBe(end);
  const guard = f.guards[0],
    final = f.finals[0];
  if (!guard || !final) throw Error("Missing outer guards");
  await guard();
  expect(graph.asyncGuard).toHaveBeenCalledTimes(1);
  f.setTime(end);
  expect(final).toThrow(CatalogError);
  f.setTime(plus(at, 500));
  expect(final).toThrow(CatalogError);
});
it("uses one host slot for many held bindings and runs all child async guards before final assertions", async () => {
  const f = fixture(publication(8)),
    sequence: string[] = [];
  graph.asyncGuard.mockImplementation(async (_tx: Tx, b: Binding) => {
    sequence.push("async:" + b.bindingReference);
  });
  graph.finalAssert.mockImplementation((_tx: Tx, b: Binding) => {
    sequence.push("final:" + b.bindingReference);
  });
  await f.run();
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(graph.read).toHaveBeenCalledTimes(8);
  await f.commitGuards();
  const bindings = f.input.aggregate.draft.optionBindings;
  expect(sequence).toEqual([
    ...bindings.map((b) => "async:" + b.bindingReference),
    ...bindings.map((b) => "final:" + b.bindingReference),
  ]);
  expect(graph.asyncGuard.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
  expect(graph.finalAssert.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
});
it.each(["async", "final"])(
  "preserves a child %s refusal at the real outer guard",
  async (phase) => {
    const f = fixture();
    await f.run();
    const refusal = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    if (phase === "async") graph.asyncGuard.mockRejectedValue(refusal);
    else
      graph.finalAssert.mockImplementation(() => {
        throw refusal;
      });
    await expect(f.commitGuards()).rejects.toBe(refusal);
    const final = f.finals[0];
    if (!final) throw Error("Missing final assertion");
    expect(final).toThrow(CatalogError);
  },
);
it.each(["binding", "clock"])(
  "registers a poisoned host guard even when initial %s validation fails",
  async (mode) => {
    const input = structuredClone(publication(0)),
      f = fixture(input);
    if (mode === "binding") Object.assign(input.command, { expectedProductAggregateVersion: 99 });
    else f.setTime("invalid-clock");
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.work).not.toHaveBeenCalled();
    expect(graph.read).not.toHaveBeenCalled();
    f.setTime(at);
    await expect(f.commitGuards()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it.each([
  "expired",
  "future",
  "tenant",
  "binding",
  "target",
  "digest",
  "missing-root-record",
  "indeterminate",
])("refuses %s graph evidence before exposing a business result", async (mode) => {
  const f = fixture();
  graph.read.mockImplementation(async (_tx: Tx, b: Binding, work: Work, options: GraphOptions) => {
    let changes: Partial<Omit<FrozenFullOptionBindingRuleAssessment, "digest">> = {};
    if (mode === "expired") {
      f.setTime(plus(at, 1000));
      changes = { validUntil: plus(at, 1000) };
    }
    if (mode === "future") changes = { observedAt: plus(at, 1) };
    if (mode === "tenant") changes = { tenantReference: id(99) };
    if (mode === "binding") changes = { bindingDigest: hash("different binding") };
    if (mode === "target") changes = { rootVersionReference: id(99) };
    if (mode === "missing-root-record")
      changes = {
        sourceRecords: [],
        rules: { status: "Unsatisfiable", reason: "NoSelection", searchNodes: 1 },
      };
    if (mode === "indeterminate")
      changes = { rules: { status: "Indeterminate", reason: "SearchLimit", searchNodes: 100 } };
    const value = observation(b, options, changes);
    return work(mode === "digest" ? { ...value, digest: hash("unbound") } : value);
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["skip", "repeat-caught", "substitute", "swallow-consumer"])(
  "rejects graph callback protocol %s and poisons outer commit",
  async (mode) => {
    const f = fixture();
    if (mode === "swallow-consumer")
      f.work.mockRejectedValue(new Error("Controlled consumer refusal"));
    graph.read.mockImplementation(
      async (_tx: Tx, b: Binding, work: Work, options: GraphOptions) => {
        if (mode === "skip") return undefined;
        let result: unknown;
        try {
          result = await work(observation(b, options));
        } catch (error) {
          if (mode !== "swallow-consumer") throw error;
        }
        if (mode === "repeat-caught") {
          try {
            await work(observation(b, options));
          } catch {
            /* Owner must not hide the duplicate call. */
          }
        }
        return mode === "substitute" ? { substituted: true } : result;
      },
    );
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).toHaveBeenCalledTimes(mode === "skip" ? 0 : 1);
    await expect(f.commitGuards()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("refuses expiry after consumer work and retains failure when time moves back", async () => {
  const f = fixture();
  f.work.mockImplementation(async (value) => {
    f.setTime(f.validUntil);
    return value;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).toHaveBeenCalledTimes(1);
  f.setTime(at);
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("rejects transaction query replacement after consumer work even if the caller restores it", async () => {
  const f = fixture(),
    query = f.tx.query;
  f.work.mockImplementation(async (value) => {
    Object.assign(f.tx, { query: vi.fn() });
    return value;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  Object.assign(f.tx, { query });
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("poisons the outer operation when a consumer catches a same-source reentry", async () => {
  const f = fixture(),
    inner = vi.fn(async (value: CurrentProductPublicationOptionSelection) => value);
  let failure: unknown;
  f.work.mockImplementation(async (value) => {
    try {
      await f.source.withPublication(f.input, f.validUntil, inner);
    } catch (error) {
      failure = error;
    }
    return value;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(failure).toBeInstanceOf(CatalogError);
  expect(inner).not.toHaveBeenCalled();
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures parsed input before the first awaited hook and captures configured ports", async () => {
  const input = structuredClone(publication()),
    original = structuredClone(input),
    f = fixture(input);
  Object.assign(f.options.clock, {
    now: () => {
      throw Error("Replaced clock");
    },
  });
  Object.assign(f.options.authority, {
    holdUntilTransactionCompletes: () => {
      throw Error("Replaced authority");
    },
  });
  Object.assign(f.options, {
    registerBeforeCommit: () => {
      throw Error("Replaced hook");
    },
  });
  f.register.mockImplementation(async (_tx, guard, finalAssert) => {
    f.guards.push(guard);
    f.finals.push(finalAssert);
    Object.assign(input.command, { operationReference: id(90) });
    Object.assign(input.aggregate.draft.localizedNames, { "en-CA": "Caller mutation" });
    Object.assign(input.aggregate.draft, { optionBindings: [] });
  });
  const result = await f.run(),
    sent = graph.create.mock.calls[0]?.[0] as GraphOptions | undefined;
  if (!sent) throw Error("Expected captured graph options");
  expect(sent.command).toEqual(original.command);
  expect(sent.clock.now()).toBe(at);
  expect(result.originalIntentDigest).toBe(hash(original.command));
  expect(graph.read).toHaveBeenCalledTimes(1);
  const b = original.aggregate.draft.optionBindings[0];
  if (!b) throw Error("Expected original binding");
  await sent.authority.holdUntilTransactionCompletes(f.tx, {
    tenantReference: original.command.tenantReference,
    brandReference: original.command.brandReference,
    actorReference: original.command.actorReference,
    actorKind: original.command.actorKind,
    permission: "catalog.manage",
    action: "catalog.option_set.read",
    purposeCode: original.command.purposeCode,
    requiredFields: productPublicationFrozenFullOptionSetContentFields,
    command: original.command,
    originalIntentDigest: hash(original.command),
    replacementIntentDigest: original.command.replacementIntentDigest,
    warningBindingDigest: null,
    requestObservedAt: at,
    requestValidUntil: f.validUntil,
    optionSetReference: b.optionSetReference,
    versionReference: b.optionSetVersionReference,
    content: null,
    observedAt: at,
  });
  expect(f.hold).toHaveBeenCalledTimes(1);
  await f.commitGuards();
});

function currentObservation(
  b: Binding,
  input: Pick<PublicationQualificationInput, "observedAt">,
  until: string,
  release = id(600),
) {
  const frozen = observation(b, {
    observedAt: input.observedAt,
    validUntil: until,
  } as GraphOptions);
  const { digest: originalDigest, ...base } = frozen;
  expect(originalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  const body = {
    ...base,
    profile: "CurrentPublishedProductOptionBindingAssessmentV1" as const,
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent" as const,
    sourceRecords: frozen.sourceRecords.map((r) => ({
      ...r,
      publicationReference: release,
      releaseRecordDigest: hash({ release }),
      sealRecordDigest: r.recordDigest,
      approvalDisposition: "Approved" as const,
    })),
  };
  return { ...body, digest: hash(body) };
}
it("reads actual CurrentPublished authority without Pinned fallback and preserves mixed source evidence", async () => {
  const input = publication(2, [1]),
    until = plus(input.observedAt, 3000);
  const read = vi.fn();
  const f = fixture(input, {
    withBindingAssessment: async (tx, b, work) => {
      read(tx, b);
      return work(currentObservation(b, input, until));
    },
  });
  const result = await f.run();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe(f.tx);
  expect(graph.create).toHaveBeenCalledTimes(1);
  expect(result.sources.map((s) => s.sourceCode)).toEqual([
    "PINNED_OPTION_RULES",
    "CURRENT_PUBLISHED_OPTION_RULES",
  ]);
  expect(result.check.outcome).toBe("Pass");
  await f.commitGuards();
});
it("refuses CurrentPublished when actual current owner is absent rather than reading frozen history", async () => {
  const f = fixture(publication(1, [0]));
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(graph.create).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("binds warning continuity to actual release provenance while ignoring the read clock", async () => {
  async function assess(observedAt: string, release: string) {
    const original = publication(1, [0]);
    const input = { ...original, observedAt };
    const until = plus(observedAt, 3000);
    const f = fixture(input, {
      withBindingAssessment: async (_tx, b, work) =>
        work(currentObservation(b, input, until, release)),
    });
    return await f.run();
  }
  const first = await assess(at, id(600)),
    later = await assess(plus(at, 100), id(600)),
    changed = await assess(plus(at, 100), id(601));
  expect(first.sources[0]?.relevantReferenceDigest).toBe(later.sources[0]?.relevantReferenceDigest);
  expect(first.sources[0]?.sourceDigest).not.toBe(later.sources[0]?.sourceDigest);
  expect(changed.sources[0]?.relevantReferenceDigest).not.toBe(
    first.sources[0]?.relevantReferenceDigest,
  );
});
it.each([
  "profile",
  "provenance",
  "root",
  "release",
  "releaseArray",
  "seal",
  "sealArray",
  "extra",
  "observation",
])("poisons current assessment on invalid %s", async (field) => {
  const input = publication(1, [0]),
    until = plus(at, 3000);
  const f = fixture(input, {
    withBindingAssessment: async (_tx, b, work) => {
      const value = currentObservation(b, input, until);
      const body = { ...value, sourceRecords: value.sourceRecords.map((r) => ({ ...r })) };
      const record = body.sourceRecords[0];
      if (!record) throw Error("Expected actual root source record");
      if (field === "profile")
        Object.assign(body, { profile: "FrozenFullOptionBindingRuleAssessmentV1" });
      if (field === "provenance") Object.assign(body, { sourceAuthority: "RecordedFrozen" });
      if (field === "root") body.rootVersionReference = id(700);
      if (field === "release") record.releaseRecordDigest = "invalid";
      if (field === "releaseArray")
        Object.assign(record, { releaseRecordDigest: [record.releaseRecordDigest] });
      if (field === "sealArray")
        Object.assign(record, { sealRecordDigest: [record.sealRecordDigest] });
      if (field === "seal") record.sealRecordDigest = hash({ wrong: true });
      if (field === "extra") Object.assign(record, { extra: true });
      if (field === "observation") record.observedAt = plus(at, 1);
      const { digest: originalDigest, ...unsigned } = body;
      expect(originalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      return work({ ...unsigned, digest: hash(unsigned) });
    },
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commitGuards()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("preserves owning current head conflict without frozen fallback", async () => {
  const f = fixture(publication(1, [0]), {
    withBindingAssessment: async () => {
      throw new CatalogError("CATALOG_VERSION_CONFLICT");
    },
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(graph.create).not.toHaveBeenCalled();
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("rechecks actual current port identity in the final commit guard", async () => {
  const input = publication(1, [0]),
    until = plus(at, 3000);
  const owner = {
    withBindingAssessment: async <T>(
      _tx: Tx,
      b: Binding,
      work: (value: ReturnType<typeof currentObservation>) => Promise<T>,
    ) => work(currentObservation(b, input, until)),
  };
  const f = fixture(input, owner);
  await f.run();
  owner.withBindingAssessment = async () => {
    throw Error("replacement");
  };
  await expect(f.commitGuards()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("accepts earlier real graph observation inside the held current assessment", async () => {
  const input = publication(1, [0]),
    until = plus(at, 3000);
  const f = fixture(input, {
    withBindingAssessment: async (_tx, b, work) => {
      const original = currentObservation(b, input, until);
      const { digest, ...body } = original;
      void digest;
      const assessment = { ...body, observedAt: plus(at, 1) };
      f.setTime(plus(at, 2));
      return work({ ...assessment, digest: hash(assessment) });
    },
  });
  expect((await f.run()).check.outcome).toBe("Pass");
  await f.commitGuards();
});
it("uses independent Warning acknowledgement context with actual current provenance and original lease", async () => {
  const input = acknowledgement(true);
  const read = vi.fn();
  const f = fixture(publication(1, [0]), {
    withBindingAssessment: async (tx, b, work) => {
      read(tx, b);
      return work(currentObservation(b, input, input.validUntil));
    },
  });
  f.setTime(input.observedAt);
  const result = await f.source.withAcknowledgement(input, f.work);
  expect(result.sources.map((s) => s.sourceCode)).toEqual(["CURRENT_PUBLISHED_OPTION_RULES"]);
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(result.validUntil).toBe(input.validUntil);
  expect(read).toHaveBeenCalledTimes(1);
  expect(graph.create).not.toHaveBeenCalled();
  await f.commitGuards();
});
