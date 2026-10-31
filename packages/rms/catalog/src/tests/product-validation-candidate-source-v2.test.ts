import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { productValidationCandidateFieldsV2 } from "../contracts/product-validation-candidate.js";
import { productEditorContentFields } from "../application/product-editor-content-authority.js";
import {
  createPostgresProductValidationCandidateSource,
  createPostgresProductValidationCandidateSourceV2,
} from "../infrastructure/persistence/product-draft-baseline-store.js";
import { productSnapshotSelectSql } from "../infrastructure/persistence/product-lifecycle-store.js";

const id = (n: number) => "01902432-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:00:00.000Z",
  until = "2026-10-02T12:00:30.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
type Options = Parameters<typeof createPostgresProductValidationCandidateSourceV2>[0];
type Transaction = Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[0];
type CategoryHolder = NonNullable<Options["categoryAssignments"]>["holdUntilTransactionCompletes"];
// SQL transport is controlled here; the lifecycle reader and candidate adapters
// are real. Separate native acceptance establishes PostgreSQL/RLS/rollback proof.
function fixture(complete = true, classified = true) {
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_V2",
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
        localizedNames: { "en-CA": "Synthetic" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        ...(classified
          ? { categoryClassification: { categoryReferences: [], primaryCategoryReference: null } }
          : {}),
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
                optionRules: [],
                allergenReferences: [],
                nutritionProfile: null,
              },
            }
          : {}),
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] },
    effectivePeriod = {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 4,
      previousIntentDigest: hash("original"),
      previousScopeDigest: hash([selector, { ...selector, reference: id(31) }]),
      previousPeriodDigest: hash(effectivePeriod),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    replacementIntent = { ...intentBody, digest: hash(intentBody) },
    command = {
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
    };
  let now = at,
    denied = false,
    categoryDenied = false,
    isolation = "read committed",
    snapshot: unknown = aggregate,
    codeRows: unknown[] = [{ candidate_matches: true, internal_code_unique: true }];
  const events: string[] = [],
    codeReads: unknown[][] = [];
  let onHold: (() => void) | undefined, afterRun: (() => void) | undefined;
  const sql = vi.fn(async (text: string, values: readonly unknown[]) => {
    events.push("SQL");
    if (text.includes(" AS isolation")) return { rows: [{ isolation }] };
    if (text === productSnapshotSelectSql)
      return { rows: snapshot === null ? [] : [{ snapshot, precise: true }] };
    if (text.includes(" AS internal_code_unique")) {
      codeReads.push([...values]);
      return { rows: codeRows };
    }
    return { rows: [] };
  });
  const tx = { query: sql as unknown as Transaction["query"] },
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async () => {
      events.push("AUTHORITY");
      onHold?.();
      if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    category = vi.fn<CategoryHolder>(async () => {
      events.push("CATEGORY");
      if (categoryDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    clock = { now: () => now },
    authority: Options["authority"] = { holdUntilTransactionCompletes: hold },
    categoryAssignments: NonNullable<Options["categoryAssignments"]> = {
      holdUntilTransactionCompletes: category,
    },
    transactions: Options["transactions"] = {
      async run(work) {
        events.push("BEGIN");
        try {
          const value = await work(tx);
          afterRun?.();
          events.push("COMMIT");
          return value;
        } catch (error) {
          events.push("ROLLBACK");
          throw error;
        }
      },
    },
    options: Options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock,
      transactions,
      authority,
      categoryAssignments,
    },
    source = createPostgresProductValidationCandidateSourceV2(options),
    work = vi.fn(
      async (value: Parameters<Parameters<typeof source.withCurrentCandidate>[1]>[0]) => value,
    );
  return {
    aggregate,
    command,
    source,
    options,
    tx,
    sql,
    hold,
    category,
    events,
    codeReads,
    work,
    clock,
    transactions,
    authority,
    categoryAssignments,
    setNow(value: string) {
      now = value;
    },
    deny() {
      denied = true;
    },
    denyCategory() {
      categoryDenied = true;
    },
    setRows(rows: unknown[]) {
      codeRows = rows;
    },
    setSnapshot(value: unknown) {
      snapshot = value;
    },
    setIsolation(value: string) {
      isolation = value;
    },
    onHold(callback: () => void) {
      onHold = callback;
    },
    afterRun(callback: () => void) {
      afterRun = callback;
    },
    run: () => source.withCurrentCandidate(command, work),
  };
}

it("uses actual lifecycle composition and bounded code checks with complete V2/category/editor authority", async () => {
  const f = fixture(),
    candidate = await f.run();
  expect(candidate).toMatchObject({
    profile: "CatalogProductValidationCandidateV2",
    replacementIntentDigest: f.command.replacementIntentDigest,
    completeContent: "Present",
    internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
  expect(candidate.aggregate).toEqual(f.aggregate);
  expect(candidate.originalIntentDigest).toBe(hash(f.command));
  expect(f.codeReads).toEqual([
    [id(2), "SYNTHETIC_V2", id(5)],
    [id(2), "SYNTHETIC_V2", id(5)],
  ]);
  expect(f.events.indexOf("AUTHORITY")).toBeLessThan(f.events.indexOf("SQL"));
  expect(f.sql).toHaveBeenCalledWith(productSnapshotSelectSql, [id(2), id(5)]);
  for (const [actual, input] of f.hold.mock.calls) {
    expect(actual).toBe(f.tx);
    expect(input).toMatchObject({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      productReference: id(5),
      owningAction: "catalog.product.validate",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      permission: "catalog.manage",
      requiredFields: productValidationCandidateFieldsV2,
    });
    expect(input.requiredFields).toEqual(expect.arrayContaining([...productEditorContentFields]));
  }
  expect(f.category).toHaveBeenCalledTimes(2);
  for (const [actual, input] of f.category.mock.calls) {
    expect(actual).toBe(f.tx);
    expect(input.mode).toBe("Read");
    expect(input.aggregate).toEqual(f.aggregate);
  }
});
it("keeps incomplete legacy candidate explicit without synthesizing editor or category data", async () => {
  const f = fixture(false, false),
    candidate = await f.run();
  expect(candidate.completeContent).toBe("Unavailable");
  expect(candidate.variantMappingPrerequisite).toBe("Unavailable");
  expect(Object.hasOwn(candidate.aggregate.draft, "editorContent")).toBe(false);
  expect(Object.hasOwn(candidate.aggregate.draft, "categoryClassification")).toBe(false);
  expect(f.category).not.toHaveBeenCalled();
});
it("captures every configured port, including the category method", async () => {
  const f = fixture(),
    replacement = vi.fn(async () => {
      throw new Error("mutated port");
    });
  f.transactions.run = replacement;
  f.authority.holdUntilTransactionCompletes = replacement;
  f.categoryAssignments.holdUntilTransactionCompletes = replacement;
  f.clock.now = () => {
    throw new Error("mutated clock");
  };
  expect((await f.run()).profile).toBe("CatalogProductValidationCandidateV2");
  expect(replacement).not.toHaveBeenCalled();
});
it("keeps both public source protocols closed before transport", async () => {
  const f = fixture(),
    legacy = Object.fromEntries(
      Object.entries(f.command).filter(
        ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
      ),
    ),
    v1 = createPostgresProductValidationCandidateSource({
      ...f.options,
      authority: {
        async holdUntilTransactionCompletes() {
          throw new Error("must not hold");
        },
      },
    });
  await expect(f.source.withCurrentCandidate(legacy, f.work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  await expect(v1.withCurrentCandidate(f.command, async () => null)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.sql).not.toHaveBeenCalled();
  expect(f.hold).not.toHaveBeenCalled();
});
it.each([
  { actorReference: id(90) },
  { tenantReference: id(90) },
  { brandReference: id(90) },
  { actorKind: "System" },
  { replacementIntentDigest: hash("wrong") },
])("rejects command admission drift before private queries %j", async (patch) => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate({ ...f.command, ...patch }, f.work),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.sql).not.toHaveBeenCalled();
  expect(f.hold).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
});
it("rejects unsafe input without executing a getter", async () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.command, "replacementIntent", { get: getter });
  await expect(f.run()).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.sql).not.toHaveBeenCalled();
});
it.each([
  { expectedProductAggregateVersion: 7 },
  { versionReference: id(90) },
  { contentDigest: hash("wrong") },
  { configurationDigest: hash("wrong") },
])("binds current full candidate before uniqueness work %j", async (patch) => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate({ ...f.command, ...patch }, f.work),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.codeReads).toHaveLength(0);
  expect(f.work).not.toHaveBeenCalled();
});
it.each(["missing", "isolation", "category"])("refuses absent owning %s", async (kind) => {
  const f = fixture();
  if (kind === "missing") f.setSnapshot(null);
  if (kind === "isolation") f.setIsolation("repeatable read");
  const source =
    kind === "category"
      ? createPostgresProductValidationCandidateSourceV2({
          tenantReference: f.options.tenantReference,
          brandReference: f.options.brandReference,
          actorReference: f.options.actorReference,
          transactions: f.options.transactions,
          clock: f.options.clock,
          authority: f.options.authority,
        })
      : f.source;
  await expect(source.withCurrentCandidate(f.command, f.work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.work).not.toHaveBeenCalled();
});
it("preserves initial field denial before any private query", async () => {
  const f = fixture();
  f.deny();
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.sql).not.toHaveBeenCalled();
});
it.each(["field", "category"])("rejects late %s denial after consumer work", async (kind) => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate(f.command, async (candidate) => {
      if (kind === "field") f.deny();
      else f.denyCategory();
      return candidate;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it.each(
  [
    [],
    [{ candidate_matches: false, internal_code_unique: true }],
    [{ candidate_matches: true, internal_code_unique: "true" }],
  ].map((rows) => ({ rows })),
)("refuses malformed uniqueness result $rows", async ({ rows }) => {
  const f = fixture();
  f.setRows(rows);
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
});
it("carries an actual negative code check without granting other validation and rejects later drift", async () => {
  const f = fixture();
  f.setRows([{ candidate_matches: true, internal_code_unique: false }]);
  expect((await f.run()).internalCodeCheck).toEqual({ code: "InternalCode", outcome: "HardError" });
  const g = fixture();
  await expect(
    g.source.withCurrentCandidate(g.command, async (candidate) => {
      g.setRows([{ candidate_matches: true, internal_code_unique: false }]);
      return candidate;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(g.codeReads).toHaveLength(2);
});
it.each(["hold", "consumer", "runner"])(
  "never renews the original exclusive lease at %s",
  async (stage) => {
    const f = fixture();
    if (stage === "hold") f.onHold(() => f.setNow(until));
    if (stage === "runner") f.afterRun(() => f.setNow(until));
    await expect(
      f.source.withCurrentCandidate(f.command, async (candidate) => {
        if (stage === "consumer") f.setNow(until);
        return candidate;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    if (stage === "hold") expect(f.sql).not.toHaveBeenCalled();
  },
);
it.each(["consumer", "runner"])(
  "rejects clock reversal at %s even while later than initial observation",
  async (stage) => {
    const f = fixture();
    f.onHold(() => f.setNow("2026-10-02T12:00:02.000Z"));
    if (stage === "runner") f.afterRun(() => f.setNow("2026-10-02T12:00:01.000Z"));
    await expect(
      f.source.withCurrentCandidate(f.command, async (candidate) => {
        if (stage === "consumer") f.setNow("2026-10-02T12:00:01.000Z");
        return candidate;
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["skip", "repeat", "substitute"])("refuses transaction runner %s abuse", async (mode) => {
  const f = fixture(),
    source = createPostgresProductValidationCandidateSourceV2({
      ...f.options,
      transactions: {
        async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
          if (mode === "skip") return undefined as T;
          const value = await work(f.tx);
          if (mode === "repeat") {
            try {
              await work(f.tx);
            } catch {
              /* A malicious runner cannot hide a second invocation. */
            }
          }
          return mode === "substitute" ? ({ unexpected: true } as T) : value;
        },
      },
    });
  await expect(source.withCurrentCandidate(f.command, f.work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.work).toHaveBeenCalledTimes(mode === "skip" ? 0 : 1);
});
