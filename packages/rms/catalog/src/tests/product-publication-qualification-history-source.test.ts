import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import { parseCatalogProductWarningAcknowledgementReferenceRequest } from "../contracts/product-warning-acknowledgement-reference-request.js";
import {
  createPostgresProductPublicationQualificationHistorySource,
  createPostgresProductWarningAcknowledgementQualificationHistorySource,
  type ProductPublicationQualificationHistorySourceOptions,
} from "../infrastructure/persistence/product-reference-history-source-store.js";
import {
  productPublicationQualificationHistoryFields,
  productWarningAcknowledgementQualificationHistoryFields,
  type CatalogProductPublicationReferenceProvenance,
} from "../contracts/product-publication-reference-provenance.js";
type Options = ProductPublicationQualificationHistorySourceOptions;
type Transaction = Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[0];
const id = (n: number) => "01902500-0004-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-03T12:00:00.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Controlled immutable history and command metadata; no publication qualification is asserted.
function fixture(kind: "User" | "System" | "Ack" = "User", legacy = false) {
  const editorContent = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: {},
    localizedDescriptions: { "en-CA": "Private prose" },
    preparationNotes: {},
    tagReferences: [],
    attributeValues: [],
    media: [],
    variantDimensions: [],
    variantCombinations: [],
    optionRules: [],
    allergenReferences: [],
    nutritionProfile: null,
  };
  const first = parseProductAggregate({
    productReference: id(4),
    brandReference: id(2),
    internalCode: "PROVENANCE",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(3),
    draft: {
      versionReference: id(5),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "First" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      ...(legacy ? {} : { editorContent }),
    },
  });
  const second = parseProductAggregate({
    ...first,
    aggregateVersion: 2,
    updatedAt: time(1),
    draft: { ...first.draft, updatedAt: time(1), localizedNames: { "en-CA": "Second" } },
  });
  const aggregate = parseProductAggregate({ ...second, aggregateVersion: 3, updatedAt: time(2) });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const command = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: kind === "System" ? "System" : "User",
    operationReference: id(8),
    productReference: id(4),
    versionReference: id(5),
    expectedProductAggregateVersion: 3,
    expectedPublicationVersion: kind === "System" ? 1 : 0,
    action: kind === "System" ? "ActivateScheduled" : "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Store", reference: id(6), channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: kind === "System" ? id(12) : null,
    replacementVersionReference: null,
    successorDraftVersionReference: kind === "System" ? id(13) : null,
    occurredAt: time(3),
    reasonCode: "SYNTHETIC",
    replacementIntent: { ...body, digest: hash(body) },
    replacementIntentDigest: hash(body),
  });
  const ack = {
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(8),
    productReference: id(4),
    versionReference: id(5),
    expectedProductAggregateVersion: 3,
    reportOperationReference: id(20),
    reportDigest: hash("report"),
    warningBindingDigest: hash("warning"),
    warningCodes: ["ChangeImpact"],
    reasonCode: "EXPLICIT_REVIEW",
    occurredAt: time(3),
  };
  const common = {
    originalIntentDigest: hash(kind === "Ack" ? ack : command),
    replacementIntentDigest: command.replacementIntentDigest,
    aggregateSnapshotDigest: hash(aggregate),
    observedAt: time(3),
    validUntil: time(1000),
  };
  const request =
    kind === "Ack"
      ? parseCatalogProductWarningAcknowledgementReferenceRequest({
          ...common,
          profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
          command: ack,
          currentPublicationDigest: hash("held publication"),
          publicationVersion: 1,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeDigest: hash(command.scopeSet),
          periodDigest: hash(command.effectivePeriod),
          policyReference: id(21),
          policyVersion: 1,
        })
      : parseCatalogProductPublicationReferenceRequestV2({
          ...common,
          profile: "CatalogProductPublicationReferenceRequestV2",
          command,
          currentPublicationDigest: kind === "System" ? hash("held publication") : null,
        });
  const source = {
    aggregateVersion: 3,
    observedAt: time(3),
    history: [first, second, aggregate].map((value, i) => ({
      aggregate: value,
      operationReference: id(30 + i),
      snapshotDigest: hash(value),
      coherent: true,
    })),
  };
  return { request, source, aggregate, first, second, command };
}

function harness(kind: "User" | "System" | "Ack" = "User") {
  const f = fixture(kind),
    state = {
      at: time(3),
      denied: false,
      source: f.source as unknown,
      statements: [] as string[],
      holders: [] as unknown[],
      guards: [] as (() => Promise<void>)[],
      finals: [] as (() => void)[],
      committed: false,
    };
  const query: Transaction["query"] = async <Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ) => {
    state.statements.push(sql);
    void values;
    const rows = sql.includes("transaction_isolation")
      ? [{ isolation: "read committed" }]
      : sql.startsWith("SELECT jsonb_build_object('aggregateVersion'")
        ? [{ source: state.source }]
        : [];
    return { rows: rows as unknown as Row[], rowCount: rows.length };
  };
  const tx: Transaction = { query };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: kind === "System" ? ("System" as const) : ("User" as const),
    clock: { now: () => state.at },
    transactions: {
      async run<T>(work: (actual: Transaction) => Promise<T>) {
        return work(tx);
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual: Transaction, input: unknown) {
        expect(actual).toBe(tx);
        state.holders.push(input);
        if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
    async registerBeforeCommit(
      actual: Transaction,
      guard: () => Promise<void>,
      finalAssert: () => void,
    ) {
      expect(actual).toBe(tx);
      state.guards.push(guard);
      state.finals.push(finalAssert);
    },
  };
  type Work<T> = (
    snapshot: CatalogProductPublicationReferenceProvenance,
    actual: Transaction,
  ) => Promise<T>;
  const read =
    kind === "Ack"
      ? (() => {
          const request = parseCatalogProductWarningAcknowledgementReferenceRequest(f.request);
          const source = createPostgresProductWarningAcknowledgementQualificationHistorySource({
            ...options,
            actorKind: "User",
          });
          return <T>(work: Work<T>): Promise<T> =>
            source.withCurrentQualificationHistory(request, work);
        })()
      : (() => {
          const request = parseCatalogProductPublicationReferenceRequestV2(f.request);
          const source = createPostgresProductPublicationQualificationHistorySource(options);
          return <T>(work: Work<T>): Promise<T> =>
            source.withCurrentQualificationHistory(request, work);
        })();
  const commit = async () => {
    for (const guard of state.guards) await guard();
    for (const final of state.finals) expect(final()).toBeUndefined();
    state.committed = true;
  };
  return { f, state, tx, options, read, commit };
}
for (const kind of ["User", "System", "Ack"] as const) {
  it(`${kind}: one immutable-history SQL supplies both views under exact original authority`, async () => {
    const h = harness(kind);
    const snapshot = await h.read(async (value, tx) => {
      expect(tx).toBe(h.tx);
      return value;
    });
    await h.commit();
    expect(snapshot.request).toEqual(h.f.request);
    expect(snapshot.operationProvenance).toHaveLength(3);
    expect(
      h.state.statements.filter((sql) =>
        sql.startsWith("SELECT jsonb_build_object('aggregateVersion'"),
      ),
    ).toHaveLength(1);
    expect(
      h.state.statements.some(
        (sql) =>
          sql.startsWith("WITH recorded AS") || sql.startsWith("SELECT s.snapshot_json aggregate"),
      ),
    ).toBe(false);
    expect(h.state.holders).toContainEqual(
      expect.objectContaining({
        request: h.f.request,
        actorKind: kind === "System" ? "System" : "User",
        requiredScope: "FullBrandScope",
        requiredFields:
          kind === "Ack"
            ? productWarningAcknowledgementQualificationHistoryFields
            : productPublicationQualificationHistoryFields,
        purposeCode:
          kind === "Ack"
            ? "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_QUALIFICATION_HISTORY_READ"
            : "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ",
      }),
    );
    expect(h.state.committed).toBe(true);
  });
  it(`${kind}: late denial after consumer refuses outer commit`, async () => {
    const h = harness(kind);
    let consumers = 0;
    await h.read(async () => {
      consumers++;
    });
    h.state.denied = true;
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(consumers).toBe(1);
    expect(h.state.committed).toBe(false);
  });
  it(`${kind}: global final phase refuses original expiry consumed by a later async guard`, async () => {
    const h = harness(kind);
    let consumers = 0;
    await h.read(async () => {
      consumers++;
    });
    h.state.guards.push(async () => {
      h.state.at = h.f.request.validUntil;
    });
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumers).toBe(1);
    expect(h.state.committed).toBe(false);
  });
  it(`${kind}: caught same-source reentry poisons the actual borrowed transaction`, async () => {
    const h = harness(kind);
    let consumers = 0,
      nested = 0;
    await expect(
      h.read(async () => {
        consumers++;
        await expect(
          h.read(async () => {
            nested++;
          }),
        ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumers).toBe(1);
    expect(nested).toBe(0);
    expect(h.state.committed).toBe(false);
  });
}
it("captured ports survive replacement, but transaction query replacement poisons the lease", async () => {
  const h = harness();
  h.options.clock.now = () => time(9999);
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced");
  };
  h.options.transactions.run = async () => {
    throw new Error("replaced");
  };
  await h.read(async () => undefined);
  await h.commit();
  const other = harness();
  await expect(
    other.read(async () => {
      other.tx.query = async () => ({ rows: [], rowCount: 0 });
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("clock advancement then partial rollback and caught corrupt history remain poisoned", async () => {
  const h = harness();
  await h.read(async () => {
    h.state.at = time(5);
  });
  h.state.at = time(4);
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const broken = harness();
  broken.state.source = { ...broken.f.source, history: [] };
  await expect(
    broken.read(async () => {
      throw new Error("must not consume");
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(broken.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(broken.state.committed).toBe(false);
});
