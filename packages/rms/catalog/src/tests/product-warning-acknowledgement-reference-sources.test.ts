import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import { buildCatalogProductPublicationValidationReport } from "../contracts/product-publication-validation-report.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import { buildCatalogProductWarningAcknowledgementReferenceRequest as build } from "../contracts/product-warning-acknowledgement-reference-request.js";
const id = (n: number) => "01902500-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  humanAt = "2026-10-03T13:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(humanAt) + ms).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Synthetic facts prove request binding, not publication permission/qualification.
function fixture(exact = false) {
  const original = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "ACK_REFERENCES",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
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
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(original),
    selector = { level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] };
  const body = exact
    ? {
        profile: "CatalogProductExactStoreSelectorReplacementV1",
        mode: "PermanentSelectorRetirement",
        previousVersionReference: id(40),
        previousPublicationOperationReference: id(41),
        expectedPreviousPublicationVersion: 2,
        previousIntentDigest: hash("old intent"),
        previousScopeDigest: hash([selector]),
        previousPeriodDigest: hash("old period"),
        previousSelectorIndex: 0,
        previousSelectorDigest: hash(selector),
      }
    : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const publicationCommand = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(8),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [selector],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
    replacementIntent: { ...body, digest: hash(body) },
    replacementIntentDigest: hash(body),
  });
  const validation = {
    profile: "CatalogProductPublicationValidationV2" as const,
    replacementIntentDigest: publicationCommand.replacementIntentDigest,
    evidenceReference: id(20),
    productAggregateVersion: 1,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeDigest: hash(publicationCommand.scopeSet),
    periodDigest: hash(publicationCommand.effectivePeriod),
    policyReference: id(21),
    policyVersion: 1,
    approvalPolicy: "Required" as const,
    checks: productPublicationCheckCodes.map((code) => ({
      code,
      outcome:
        code === "ApprovalPolicy"
          ? ("Pending" as const)
          : code === "ChangeImpact"
            ? ("Warning" as const)
            : ("Pass" as const),
    })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: "2026-10-03T12:00:05.000Z",
  };
  const current = planCatalogProductPublicationV2(publicationCommand, null, {
    now: at,
    productAggregateVersion: 1,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeDigest: validation.scopeDigest,
    periodDigest: validation.periodDigest,
    validation,
    approval: null,
    reviewReference: null,
    replacement: null,
  });
  const report = buildCatalogProductPublicationValidationReport({
    command: publicationCommand,
    publication: current,
    validation,
    recordedAt: at,
    details: {
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE",
          outcome: "Warning",
          subjectReference: id(5),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC",
          sourceDigest: hash("source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant"),
          observedAt: at,
          validUntil: validation.validUntil,
        },
      ],
    },
  });
  const aggregate = parseProductAggregate({ ...original, aggregateVersion: 2 });
  const command = parseCatalogProductPublicationWarningAcknowledgementCommand({
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(9),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 2,
    reportOperationReference: report.operationReference,
    reportDigest: report.digest,
    warningBindingDigest: report.warningBindingDigest,
    warningCodes: ["ChangeImpact"],
    reasonCode: "EXPLICIT_REVIEW",
    occurredAt: humanAt,
  });
  const input = {
    command,
    aggregate,
    current,
    report,
    observedAt: humanAt,
    validUntil: plus(1000),
  };
  return { ...input, input, request: build(input), publicationCommand, identity };
}
import {
  buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
  parseProductWarningAcknowledgementMenuReferenceSourceSnapshot,
  parseProductPublicationMenuReferenceSourceSnapshotV2,
  productWarningAcknowledgementMenuReferenceSourceFields,
} from "../contracts/menu-reference-source.js";
import {
  createPostgresProductWarningAcknowledgementMenuReferenceSource,
  type MenuReferenceTransaction,
} from "../infrastructure/persistence/menu-reference-source-store.js";
import {
  buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
  parseProductWarningAcknowledgementBundleReferenceSourceSnapshot,
  parseProductPublicationBundleReferenceSourceSnapshotV2,
  productWarningAcknowledgementBundleReferenceSourceFields,
} from "../contracts/bundle-reference-source.js";
import { createPostgresProductWarningAcknowledgementBundleReferenceSource } from "../infrastructure/persistence/bundle-reference-source-store.js";
import {
  buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
  parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
  parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
  productWarningAcknowledgementAvailabilityReferenceSourceFields,
} from "../contracts/availability-reference-source.js";
import { createPostgresProductWarningAcknowledgementAvailabilityReferenceSource } from "../infrastructure/persistence/availability-reference-source-store.js";
import {
  buildProductWarningAcknowledgementReferenceHistorySnapshot,
  parseProductWarningAcknowledgementReferenceHistorySnapshot,
  parseProductPublicationReferenceHistorySnapshotV2,
  productWarningAcknowledgementReferenceHistoryFields,
} from "../contracts/product-reference-history-source.js";
import {
  createPostgresProductWarningAcknowledgementReferenceHistorySource,
  type ProductWarningAcknowledgementReferenceHistorySourceOptions,
} from "../infrastructure/persistence/product-reference-history-source-store.js";
function menu(empty = false) {
  const parent = {
    reviewReference: id(10),
    brandReference: id(2),
    menuReference: id(11),
    menuVersionReference: id(12),
    snapshotDigest: hash("menu"),
  };
  return {
    generation: empty ? null : "1",
    observedAt: humanAt,
    counts: {
      reviews: empty ? "0" : "1",
      placements: empty ? "0" : "2",
      revisions: empty ? "0" : "1",
      releases: "0",
      periods: "0",
    },
    reviews: empty ? [] : [{ ...parent, createdAt: at, precise: true }],
    placements: empty
      ? []
      : [60, 70].map((n) => ({
          reviewReference: id(10),
          sectionReference: id(13),
          placementReference: id(n),
          skuReference: id(n + 1),
          productVersionReference: id(n + 2),
        })),
    revisions: empty
      ? []
      : [{ ...parent, lifecycleVersion: 1, state: "InReview", changedAt: at, precise: true }],
    releases: [],
    periods: [],
  };
}
function bundle(empty = false) {
  const root = { bundleReference: id(10), brandReference: id(2) },
    versions = [11, 12].map((n) => ({
      ...root,
      bundleVersionReference: id(n),
      versionStatus: n === 11 ? "Draft" : "Published",
      versionUpdatedAt: at,
      publishedAt: n === 11 ? null : at,
      validationDigest: n === 11 ? null : hash("bundle"),
      precise: true,
    })),
    groups = [11, 12].map((n) => ({
      ...root,
      groupReference: id(n + 20),
      bundleVersionReference: id(n),
    }));
  return {
    generation: empty ? null : "1",
    observedAt: humanAt,
    counts: {
      bundles: empty ? "0" : "1",
      versions: empty ? "0" : "2",
      groups: empty ? "0" : "2",
      members: empty ? "0" : "2",
    },
    bundles: empty
      ? []
      : [
          {
            ...root,
            aggregateVersion: 1,
            lifecycle: "Draft",
            currentVersionReference: id(11),
            updatedAt: at,
            precise: true,
          },
        ],
    versions: empty ? [] : versions,
    groups: empty ? [] : groups,
    members: empty
      ? []
      : groups.map((group, index) => ({
          ...group,
          sellableType: index ? "Sku" : "Product",
          sellableReference: id(index ? 61 : 5),
        })),
  };
}
function availability(empty = false) {
  return {
    generation: empty ? null : "1",
    observedAt: humanAt,
    rootCount: empty ? "0" : "2",
    rules: empty
      ? []
      : [60, 70].map((n) => ({
          ruleReference: id(n),
          brandReference: id(2),
          sellableType: n === 60 ? "Product" : "Sku",
          sellableReference: id(n === 60 ? 5 : 61),
          storeReference: null,
          aggregateVersion: 1,
          lifecycle: "Draft",
          effectiveFrom: plus(10000),
          effectiveUntil: null,
          updatedAt: at,
          precise: true,
        })),
  };
}

const entries = [
  {
    kind: "History",
    create: createPostgresProductWarningAcknowledgementReferenceHistorySource,
    build: buildProductWarningAcknowledgementReferenceHistorySnapshot,
    parse: parseProductWarningAcknowledgementReferenceHistorySnapshot,
    oldParse: parseProductPublicationReferenceHistorySnapshotV2,
    fields: productWarningAcknowledgementReferenceHistoryFields,
  },
  {
    kind: "Menu",
    create: createPostgresProductWarningAcknowledgementMenuReferenceSource,
    build: buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
    parse: parseProductWarningAcknowledgementMenuReferenceSourceSnapshot,
    oldParse: parseProductPublicationMenuReferenceSourceSnapshotV2,
    fields: productWarningAcknowledgementMenuReferenceSourceFields,
  },
  {
    kind: "Bundle",
    create: createPostgresProductWarningAcknowledgementBundleReferenceSource,
    build: buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
    parse: parseProductWarningAcknowledgementBundleReferenceSourceSnapshot,
    oldParse: parseProductPublicationBundleReferenceSourceSnapshotV2,
    fields: productWarningAcknowledgementBundleReferenceSourceFields,
  },
  {
    kind: "Availability",
    create: createPostgresProductWarningAcknowledgementAvailabilityReferenceSource,
    build: buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
    parse: parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
    oldParse: parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
    fields: productWarningAcknowledgementAvailabilityReferenceSourceFields,
  },
] as const;
type Entry = (typeof entries)[number];
type Snapshot = ReturnType<Entry["build"]>;
interface Source {
  withCurrentSnapshot<T>(
    input: ReturnType<typeof build>,
    work: (snapshot: Snapshot, tx: MenuReferenceTransaction) => Promise<T>,
  ): Promise<T>;
}
type Transaction = Parameters<
  ProductWarningAcknowledgementReferenceHistorySourceOptions["transactions"]["run"]
>[0] extends (tx: infer T) => unknown
  ? T
  : never;
function history(f: ReturnType<typeof fixture>) {
  return {
    observedAt: humanAt,
    targetExists: true,
    recordedAggregateVersion: 2,
    recordCoverage: true,
    configurations: [
      {
        versionReference: f.command.versionReference,
        categoryClassificationKnown: false,
        categoryReferences: null,
        primaryCategoryReference: null,
        taxClassificationReference: null,
        skuReferences: [],
        bindings: [],
      },
    ],
  };
}
function harness(entry: Entry, empty = false) {
  const f = fixture(),
    state = {
      at: humanAt,
      denied: false,
      generation: empty ? "0" : "1",
      coherent: true,
      publicationCoherent: true,
      current: f.current as unknown,
      aggregate: f.aggregate as unknown,
      source: (entry.kind === "History"
        ? history(f)
        : entry.kind === "Menu"
          ? menu(empty)
          : entry.kind === "Bundle"
            ? bundle(empty)
            : availability(empty)) as unknown,
      committed: false,
      holders: [] as unknown[],
      sql: [] as string[],
      guards: [] as { guard: () => Promise<void>; finalAssert: () => void }[],
    };
  const query: Transaction["query"] = async <Row = Record<string, unknown>>(
    sql: string,
    _values: readonly unknown[],
  ) => {
    void _values;
    state.sql.push(sql);
    const rows = sql.includes("transaction_isolation")
      ? [{ isolation: "read committed" }]
      : sql.startsWith("SELECT s.snapshot_json aggregate")
        ? [
            {
              aggregate: state.aggregate,
              snapshot_digest: hash(state.aggregate),
              publication: state.current,
              coherent: state.coherent,
              publication_coherent: state.publicationCoherent,
            },
          ]
        : sql.startsWith("SELECT COALESCE")
          ? [{ generation: state.generation }]
          : sql.startsWith("WITH recorded AS") || sql.startsWith("SELECT jsonb_build_object")
            ? [{ source: state.source }]
            : [];
    return { rows: rows as unknown as readonly Row[] };
  };
  const tx: Transaction = { query };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User" as const,
    clock: { now: () => state.at },
    transactions: {
      async run<T>(work: (actual: Transaction) => Promise<T>): Promise<T> {
        return work(tx);
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual: unknown, input: unknown) {
        expect(actual).toBe(tx);
        state.holders.push(input);
        if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
    async registerBeforeCommit(
      actual: unknown,
      guard: () => Promise<void>,
      finalAssert: () => void,
    ) {
      expect(actual).toBe(tx);
      state.guards.push({ guard, finalAssert });
    },
  };
  const source: Source = entry.create(options);
  const commit = async () => {
    for (const item of state.guards) await item.guard();
    for (const item of state.guards) expect(item.finalAssert()).toBeUndefined();
    state.committed = true;
  };
  return { f, state, tx, options, source, commit };
}
for (const entry of entries) {
  it(`${entry.kind}: preserves full Ack binding, original lease and real owning source authority`, async () => {
    const h = harness(entry);
    let consumers = 0;
    const value = await h.source.withCurrentSnapshot(h.f.request, async (snapshot, actual) => {
      consumers++;
      expect(actual).toBe(h.tx);
      expect(snapshot.request).toEqual(h.f.request);
      return snapshot;
    });
    expect(value.digest).toMatch(/^sha256:/);
    expect(value.profile).toContain("WarningAcknowledgement");
    expect(value.observedAt).toBe(humanAt);
    expect(entry.parse(value, h.f.request, humanAt)).toEqual(value);
    expect(() => entry.oldParse(value, h.f.request as never, humanAt)).toThrow();
    expect(h.state.holders).toContainEqual(
      expect.objectContaining({
        request: h.f.request,
        actorKind: "User",
        requiredFields: entry.fields,
        requiredScope: "FullBrandScope",
        purposeCode: expect.stringContaining("WARNING_ACKNOWLEDGEMENT"),
      }),
    );
    await h.commit();
    expect(consumers).toBe(1);
    expect(h.state.committed).toBe(true);
    if (entry.kind === "History")
      expect(value).toMatchObject({
        publicationCoverage: "Unavailable",
        futureScheduleCoverage: "Unavailable",
      });
  });
  it(`${entry.kind}: original observed instant and graph digest cannot be changed`, () => {
    const h = harness(entry),
      snapshot = entry.build(h.state.source, h.f.request, humanAt);
    expect(() => entry.parse({ ...snapshot, observedAt: plus(1) }, h.f.request, plus(1))).toThrow();
    expect(() =>
      entry.parse({ ...snapshot, digest: hash("other") }, h.f.request, humanAt),
    ).toThrow();
  });
  it(`${entry.kind}: late authority rejects real consumed work at outer commit`, async () => {
    const h = harness(entry);
    let consumers = 0;
    await h.source.withCurrentSnapshot(h.f.request, async () => {
      consumers++;
    });
    h.state.denied = true;
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(consumers).toBe(1);
    expect(h.state.committed).toBe(false);
  });
  it(`${entry.kind}: later async work exhausting the original lease is rejected by final sync guard`, async () => {
    const h = harness(entry);
    let consumers = 0;
    await h.source.withCurrentSnapshot(h.f.request, async () => {
      consumers++;
    });
    h.state.guards.push({
      guard: async () => {
        h.state.at = h.f.request.validUntil;
      },
      finalAssert: () => undefined,
    });
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumers).toBe(1);
    expect(h.state.committed).toBe(false);
  });
  it(`${entry.kind}: caught nested source reuse poisons the same actual transaction`, async () => {
    const h = harness(entry);
    let outer = 0,
      inner = 0;
    await expect(
      h.source.withCurrentSnapshot(h.f.request, async () => {
        outer++;
        await expect(
          h.source.withCurrentSnapshot(h.f.request, async () => {
            inner++;
          }),
        ).rejects.toThrow();
      }),
    ).rejects.toThrow();
    await expect(h.commit()).rejects.toThrow();
    expect(outer).toBe(1);
    expect(inner).toBe(0);
    expect(h.state.committed).toBe(false);
  });
  it(`${entry.kind}: malformed early input cannot be caught and committed as an empty source`, async () => {
    const h = harness(entry);
    let consumers = 0;
    await expect(
      h.source.withCurrentSnapshot(
        { ...h.f.request, originalIntentDigest: hash("foreign") },
        async () => {
          consumers++;
        },
      ),
    ).rejects.toThrow();
    await expect(h.commit()).rejects.toThrow();
    expect(consumers).toBe(0);
    expect(h.state.committed).toBe(false);
    expect(h.state.holders).toHaveLength(0);
  });
  it(`${entry.kind}: captured ports and partial clock rollback stay bound through completion`, async () => {
    const h = harness(entry);
    await h.source.withCurrentSnapshot(h.f.request, async () => {
      h.state.at = plus(2);
      h.options.authority.holdUntilTransactionCompletes = async () => {
        throw Error("uncaptured replacement");
      };
    });
    h.state.at = plus(1);
    await expect(h.commit()).rejects.toThrow();
    expect(h.state.committed).toBe(false);
  });
  if (entry.kind !== "History") {
    it(`${entry.kind}: actual empty graph remains CompleteStoredReferences and generation change is unavailable`, async () => {
      const h = harness(entry, true);
      const snapshot = await h.source.withCurrentSnapshot(h.f.request, async (value) => value);
      expect(snapshot).toMatchObject({
        coverage: "CompleteStoredReferences",
        generation: "0",
        applicability: "Unavailable",
      });
      h.state.generation = "1";
      await expect(h.commit()).rejects.toThrow();
      expect(h.state.committed).toBe(false);
    });
  }
}
it.each(["head", "root", "scope", "policy", "coherence"])(
  "History rejects actual current %s transplant before consumer",
  async (mode) => {
    const h = harness(entries[0]);
    let consumers = 0;
    if (mode === "head") h.state.current = { ...h.f.current, operationReference: id(90) };
    if (mode === "root") h.state.aggregate = { ...h.f.aggregate, aggregateVersion: 3 };
    if (mode === "scope") h.state.current = { ...h.f.current, scopeDigest: hash("foreign") };
    if (mode === "policy") h.state.current = { ...h.f.current, policyReference: id(90) };
    if (mode === "coherence") h.state.publicationCoherent = false;
    await expect(
      h.source.withCurrentSnapshot(h.f.request, async () => {
        consumers++;
      }),
    ).rejects.toThrow();
    await expect(h.commit()).rejects.toThrow();
    expect(consumers).toBe(0);
    expect(h.state.committed).toBe(false);
  },
);
it("History unavailable or missing rows never become a complete empty graph", async () => {
  const h = harness(entries[0]);
  h.state.source = { ...history(h.f), configurations: [], recordCoverage: false };
  await expect(h.source.withCurrentSnapshot(h.f.request, async () => undefined)).rejects.toThrow();
  await expect(h.commit()).rejects.toThrow();
});
