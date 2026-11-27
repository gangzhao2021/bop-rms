import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  bindCatalogProductValidationCandidateV2,
  createCatalogFullOptionSetPublicationMaterialization,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogOptionSetEditorContent,
  parseProductPublicationCommandV2,
  type createPostgresFrozenFullOptionSetContentStore,
} from "@rms/catalog";
import { createCurrentProductCandidateOptionRuleSourceV2 } from "./current-product-candidate-option-rules-v2.js";
import { createCurrentProductCandidateOptionRuleSource } from "./current-product-candidate-option-rules.js";

type FrozenOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type Options = Parameters<typeof createCurrentProductCandidateOptionRuleSourceV2>[0];
type Tx = Parameters<Options["optionAuthority"]["holdUntilTransactionCompletes"]>[0];
const mock = vi.hoisted(() => ({ read: vi.fn(), transactions: [] as unknown[], fault: "normal" }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  // Exact recorded content is controlled here. The graph walker, parsers and
  // mechanical evaluator remain actual; native SQL is separate acceptance.
  createPostgresFrozenFullOptionSetContentStore: (options: FrozenOptions) => ({
    readPinned: (pin: {
      optionSetReference: string;
      versionReference: string;
      expectedRecordDigest: string | null;
    }) =>
      options.transactions.run(async (tx) => {
        mock.transactions.push(tx);
        const observedAt = options.clock.now(),
          lease = await options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            actorKind: "User",
            permission: "catalog.manage",
            action: "catalog.option_set.read",
            purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT",
            requiredFields: ["synthetic complete record"],
            optionSetReference: pin.optionSetReference,
            versionReference: pin.versionReference,
            content: null,
            observedAt,
          });
        const content = await mock.read(pin);
        return { content, observedAt, validUntil: lease.validUntil, eligibility: "NotEvaluated" };
      }),
  }),
}));
vi.mock("./frozen-full-option-binding-rule-source.js", async (original) => {
  const actual = await original<typeof import("./frozen-full-option-binding-rule-source.js")>();
  return {
    ...actual,
    createFrozenFullOptionBindingRuleSource(
      options: Parameters<typeof actual.createFrozenFullOptionBindingRuleSource>[0],
    ) {
      const source = actual.createFrozenFullOptionBindingRuleSource(options);
      return {
        async withPinnedAssessment<T>(
          tx: Tx,
          value: unknown,
          work: (
            assessment: import("./frozen-full-option-binding-rule-source.js").FrozenFullOptionBindingRuleAssessment,
          ) => Promise<T>,
        ): Promise<T> {
          if (mock.fault === "skip") return undefined as T;
          const answer = await source.withPinnedAssessment(tx, value, async (assessment) => {
            const result = await work(assessment);
            if (mock.fault === "repeat") {
              try {
                await work(assessment);
              } catch {
                /* A hostile owner cannot conceal the second callback. */
              }
            }
            return result;
          });
          return mock.fault === "substitute" ? ({ unexpected: true } as T) : answer;
        },
      };
    },
  };
});
const id = (n: number) => "01902433-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T13:00:00.000Z",
  plus = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
function node(n: number) {
  const source = {
    optionSetReference: id(n * 100),
    brandReference: id(2),
    internalCode: "SYNTHETIC_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(n * 100 + 1),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic options" },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: 2,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 2,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(n * 100 + 10),
          optionSetReference: id(n * 100),
          brandReference: id(2),
          stableCode: "ONE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic option" },
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
        quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null as string | null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
  };
  return { source, details };
}
type Node = ReturnType<typeof node>;
function stored(n: Node) {
  const full = parseCatalogOptionSetEditorContent(n.source, n.details),
    ref = Number.parseInt(n.source.optionSetReference.slice(-12), 16);
  return createCatalogFullOptionSetPublicationMaterialization(n.source, n.details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: n.source.optionSetReference,
    versionReference: n.source.draft.versionReference,
    sourceAggregateVersion: 1,
    publicationOperationReference: id(ref + 40),
    publicationIntentDigest: hash("synthetic publication"),
    successorDraftVersionReference: id(ref + 41),
    sealedAt: plus(1),
    sourceDigest: full.sourceDigest,
    contentDigest: full.contentDigest,
    configurationDigest: full.configurationDigest,
  }).content;
}
function fixture(count = 1, complete = true, resolution = "Pinned") {
  const nodes = Array.from({ length: count }, (_, i) => node(i + 1));
  const bindings = nodes.map((n, i) => ({
    bindingReference: id(900 + i),
    optionSetReference: n.source.optionSetReference,
    optionSetVersionReference: n.source.draft.versionReference,
    purpose: "CUSTOMIZATION",
    sortOrder: i,
    enabledOptionReferences: n.source.draft.options.map((o) => o.optionReference),
    defaultSelections: [{ optionReference: id((i + 1) * 100 + 10), quantity: 1 }],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: ["WEB"],
    storeOverrideAllowed: false,
  }));
  const aggregate = {
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_PRODUCT",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 8,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(6),
        baseVersionReference: id(40),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic candidate" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: bindings,
        createdAt: at,
        updatedAt: at,
        ...(complete
          ? {
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
                  versionResolution: resolution,
                  pricingRule: null,
                  conditionalRule: null,
                  conflictRule: null,
                  variantCondition: [],
                })),
                allergenReferences: [],
                nutritionProfile: null,
              },
            }
          : {}),
      },
    },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = {
      level: "Store",
      reference: id(30),
      channelCodes: ["WEB"],
      orderTypeCodes: ["PICKUP"],
    },
    effectivePeriod = { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
    intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 4,
      previousIntentDigest: hash("old"),
      previousScopeDigest: hash([selector, { ...selector, reference: id(31) }]),
      previousPeriodDigest: hash(effectivePeriod),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    replacementIntent = { ...intentBody, digest: hash(intentBody) },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
      effectivePeriod,
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_VALIDATE",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    }),
    candidate = {
      ...bindCatalogProductValidationCandidateV2(command, aggregate, plus(2)),
      internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
    };
  let time = plus(2),
    optionUntil = plus(7),
    denied = false,
    candidateDenied = false,
    afterHold: (() => void) | undefined;
  const contents = new Map(
    nodes.map((n) => [
      n.source.optionSetReference + ":" + n.source.draft.versionReference,
      stored(n),
    ]),
  );
  mock.read.mockImplementation(async (pin) => {
    const result = contents.get(pin.optionSetReference + ":" + pin.versionReference);
    if (!result) throw new CatalogError("CATALOG_UNAVAILABLE");
    if (pin.expectedRecordDigest !== null && pin.expectedRecordDigest !== result.digest)
      throw new CatalogError("CATALOG_VERSION_CONFLICT");
    return result;
  });
  const query = vi.fn(async (sql: string) => {
      if (sql.includes(" AS isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.includes("FROM rms_catalog.product p JOIN rms_catalog.product_version"))
        return { rows: [{ snapshot: aggregate, precise: true }] };
      if (sql.includes(" AS internal_code_unique"))
        return { rows: [{ candidate_matches: true, internal_code_unique: true }] };
      return { rows: [] };
    }),
    tx: Tx = { query: query as unknown as Tx["query"] },
    hold = vi.fn<Options["optionAuthority"]["holdUntilTransactionCompletes"]>(
      async (_tx, input) => {
        if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        afterHold?.();
        return { observedAt: input.observedAt, validUntil: optionUntil };
      },
    ),
    candidateHold = vi.fn<Options["candidateAuthority"]["holdUntilTransactionCompletes"]>(
      async () => {
        if (candidateDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    ),
    options: Options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => time },
      optionAuthority: { holdUntilTransactionCompletes: hold },
      candidateAuthority: { holdUntilTransactionCompletes: candidateHold },
    },
    source = createCurrentProductCandidateOptionRuleSourceV2(options),
    work = vi.fn(
      async (assessment: Parameters<Parameters<typeof source.withCurrentAssessment>[2]>[0]) =>
        assessment,
    );
  return {
    source,
    options,
    tx,
    query,
    hold,
    candidateHold,
    command,
    candidate,
    aggregate,
    nodes,
    contents,
    work,
    setTime(value: string) {
      time = value;
    },
    setOptionUntil(value: string) {
      optionUntil = value;
    },
    deny() {
      denied = true;
    },
    denyCandidate() {
      candidateDenied = true;
    },
    afterHold(fn: () => void) {
      afterHold = fn;
    },
    held: () => source.withHeldCandidateAssessment(tx, command, candidate, work),
    current: () => source.withCurrentAssessment(tx, command, work),
  };
}
beforeEach(() => {
  mock.read.mockReset();
  mock.transactions.length = 0;
  mock.fault = "normal";
});

it("acquires actual current candidate then exact full Frozen graphs and preserves full V2 authority binding", async () => {
  const f = fixture(2),
    result = await f.current();
  expect(result).toMatchObject({
    profile: "CurrentProductCandidateOptionRulesV2",
    originalIntentDigest: hash(f.command),
    replacementIntentDigest: f.command.replacementIntentDigest,
    candidateObservedAt: plus(2),
    candidateValidUntil: plus(32),
    validUntil: plus(7),
    bindingCount: 2,
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(result.bindings.map((b) => b.rules.status)).toEqual(["Satisfiable", "Satisfiable"]);
  expect(result.digest).toBe(
    hash(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "digest"))),
  );
  expect(f.candidateHold).toHaveBeenCalled();
  expect(f.query).toHaveBeenCalled();
  expect(mock.read).toHaveBeenCalledTimes(4);
  expect(mock.transactions.every((tx) => tx === f.tx)).toBe(true);
  for (const [actual, input] of f.hold.mock.calls) {
    expect(actual).toBe(f.tx);
    expect(input.command).toEqual(f.command);
    expect(input.originalIntentDigest).toBe(hash(f.command));
    expect(input.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  }
  expect(Object.isFrozen(result.bindings)).toBe(true);
  expect(Object.isFrozen(result.bindings[0]?.rules)).toBe(true);
});
it("reads pinned triggered closure and rechecks every original record after work", async () => {
  const f = fixture(),
    parent = f.nodes[0],
    child = node(2);
  if (!parent || !parent.source.draft.options[0] || !parent.details.optionDetails[0])
    throw new Error("missing fixture");
  parent.source.draft.options[0].triggeredOptionSetReference = child.source.optionSetReference;
  parent.details.optionDetails[0].triggeredOptionSetVersionReference =
    child.source.draft.versionReference;
  f.contents.set(
    parent.source.optionSetReference + ":" + parent.source.draft.versionReference,
    stored(parent),
  );
  f.contents.set(
    child.source.optionSetReference + ":" + child.source.draft.versionReference,
    stored(child),
  );
  expect((await f.held()).bindingCount).toBe(1);
  expect(mock.read).toHaveBeenCalledTimes(4);
  expect(
    mock.read.mock.calls.slice(2).every(([pin]) => pin.expectedRecordDigest?.startsWith("sha256:")),
  ).toBe(true);
});
it("keeps zero bindings as an incomplete necessary condition without Option reads", async () => {
  const f = fixture(0),
    result = await f.held();
  expect(result).toMatchObject({
    bindingCount: 0,
    bindings: [],
    validUntil: plus(32),
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(mock.read).not.toHaveBeenCalled();
  expect(f.hold).not.toHaveBeenCalled();
});
it("retains a proven default quantity contradiction as Unsatisfiable", async () => {
  const f = fixture(),
    root = f.nodes[0];
  if (!root) throw new Error("missing fixture");
  root.source.draft.minimumSelection = 2;
  f.contents.set(
    root.source.optionSetReference + ":" + root.source.draft.versionReference,
    stored(root),
  );
  const result = await f.held();
  expect(result.bindings[0]?.rules.status).toBe("Unsatisfiable");
  expect(result.publishValidation).toBe("Incomplete");
  expect(mock.read).toHaveBeenCalledTimes(2);
});
it.each(["missing", "unpinned", "incomplete", "tooMany"])(
  "refuses %s inputs without delivering a partial rule graph",
  async (kind) => {
    const f = fixture(
      kind === "tooMany" ? 33 : 1,
      kind !== "incomplete",
      kind === "unpinned" ? "CurrentPublished" : "Pinned",
    );
    if (kind === "missing") f.contents.clear();
    await expect(f.held()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).not.toHaveBeenCalled();
    if (kind !== "missing") expect(mock.read).not.toHaveBeenCalled();
  },
);
it.each([
  { originalIntentDigest: hash("wrong") },
  { replacementIntentDigest: hash("wrong") },
  { contentDigest: hash("wrong") },
  { configurationDigest: hash("wrong") },
  { validUntil: plus(33) },
  { profile: "CatalogProductValidationCandidateV1" },
  { internalCodeCheck: { code: "InternalCode", outcome: "Unknown" } },
  { authority: "Current" },
])("rebinds every candidate field and refuses tampering %j", async (patch) => {
  const f = fixture();
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, { ...f.candidate, ...patch }, f.work),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mock.read).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
});
it("refuses changed aggregate at the same root and accessors without executing them", async () => {
  const f = fixture(),
    candidate = {
      ...f.candidate,
      aggregate: {
        ...f.aggregate,
        draft: { ...f.aggregate.draft, localizedNames: { "en-CA": "Changed" } },
      },
    };
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, candidate, f.work),
  ).rejects.toThrow();
  const g = fixture(),
    get = vi.fn();
  Object.defineProperty(g.candidate, "aggregate", { get });
  await expect(g.held()).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(mock.read).not.toHaveBeenCalled();
});
it("keeps V1 and V2 public command protocols closed", async () => {
  const f = fixture(),
    legacy = Object.fromEntries(
      Object.entries(f.command).filter(
        ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
      ),
    );
  await expect(f.source.withCurrentAssessment(f.tx, legacy, f.work)).rejects.toThrow();
  const v1 = createCurrentProductCandidateOptionRuleSource({
    ...f.options,
    candidateAuthority: {
      async holdUntilTransactionCompletes() {
        throw new Error("must not hold");
      },
    },
    optionAuthority: {
      async holdUntilTransactionCompletes() {
        throw new Error("must not hold");
      },
    },
  });
  await expect(v1.withCurrentAssessment(f.tx, f.command, async () => null)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  expect(mock.read).not.toHaveBeenCalled();
});
it("captures all configured methods before later mutation", async () => {
  const f = fixture(),
    mutated = vi.fn(async () => {
      throw new Error("mutated");
    });
  f.options.clock.now = () => {
    throw new Error("mutated clock");
  };
  f.options.candidateAuthority.holdUntilTransactionCompletes = mutated;
  f.options.optionAuthority.holdUntilTransactionCompletes = mutated;
  expect((await f.current()).bindingCount).toBe(1);
  expect(mutated).not.toHaveBeenCalled();
});
it("captures and finally reholds the actual candidate Category method", async () => {
  const f = fixture(),
    classification = { categoryReferences: [], primaryCategoryReference: null };
  Object.assign(f.aggregate.draft, { categoryClassification: classification });
  const identity = deriveCatalogProductPublicationContentIdentity(f.aggregate),
    command = parseProductPublicationCommandV2({
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    }),
    holdCategory = vi.fn<
      NonNullable<Options["categoryAssignments"]>["holdUntilTransactionCompletes"]
    >(async () => {
      /* Controlled owning Category lease. */
    }),
    categoryAssignments: NonNullable<Options["categoryAssignments"]> = {
      holdUntilTransactionCompletes: holdCategory,
    },
    source = createCurrentProductCandidateOptionRuleSourceV2({ ...f.options, categoryAssignments });
  categoryAssignments.holdUntilTransactionCompletes = async () => {
    throw new Error("mutated category");
  };
  await source.withCurrentAssessment(f.tx, command, f.work);
  expect(holdCategory).toHaveBeenCalledTimes(2);
  for (const [actual, input] of holdCategory.mock.calls) {
    expect(actual).toBe(f.tx);
    expect(input.mode).toBe("Read");
    expect(input.aggregate.draft.categoryClassification).toEqual(classification);
  }
});
it("preserves initial current-candidate denial before any private or Option read", async () => {
  const f = fixture();
  f.denyCandidate();
  await expect(f.current()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.query).not.toHaveBeenCalled();
  expect(mock.read).not.toHaveBeenCalled();
});
it.each(["option", "candidate"])("refuses late %s authority denial after work", async (kind) => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(f.tx, f.command, async (result) => {
      if (kind === "option") f.deny();
      else f.denyCandidate();
      return result;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it.each(["expiry", "backward", "narrower", "query"])("rejects post-work %s drift", async (kind) => {
  const f = fixture();
  f.afterHold(() => f.setTime(plus(3)));
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, f.candidate, async (result) => {
      if (kind === "expiry") f.setTime(plus(7));
      if (kind === "backward") f.setTime(plus(2));
      if (kind === "narrower") f.setOptionUntil(plus(6));
      if (kind === "query") f.tx.query = vi.fn();
      return result;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("does not renew the original candidate lease using a later Option observation", async () => {
  const f = fixture();
  f.setTime(plus(31));
  f.setOptionUntil(plus(50));
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, f.candidate, async (result) => {
      expect(result.validUntil).toBe(plus(32));
      f.setTime(plus(32));
      return result;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["skip", "repeat", "substitute"])(
  "refuses nested owner callback %s abuse",
  async (fault) => {
    const f = fixture();
    mock.fault = fault;
    await expect(f.held()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).toHaveBeenCalledTimes(fault === "skip" ? 0 : 1);
  },
);
it("poisons caught reentry and prevents reuse of the failed transaction", async () => {
  const f = fixture();
  await expect(
    f.source.withHeldCandidateAssessment(f.tx, f.command, f.candidate, async (result) => {
      await expect(
        f.source.withHeldCandidateAssessment(f.tx, f.command, f.candidate, f.work),
      ).rejects.toThrow();
      return result;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const reads = mock.read.mock.calls.length;
  await expect(f.held()).rejects.toThrow();
  expect(mock.read).toHaveBeenCalledTimes(reads);
});
