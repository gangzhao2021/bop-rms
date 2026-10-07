import { expect, it, vi } from "vitest";
import type { AppendAuditRecordInput } from "@bop/audit";
import { CatalogError } from "../contracts/product.js";
import { createCatalogOptionSetContentReviewBinding } from "../contracts/option-set-review-binding.js";
import {
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "../contracts/option-set-editor-content.js";
import {
  createCatalogOptionSetReviewRecord,
  parseCatalogOptionSetReviewRecord,
  createCatalogOptionSetReleaseRecord,
} from "../contracts/option-set-review-record.js";
import {
  createPostgresOptionSetReviewContentStore,
  type OptionSetReviewContentAuthority,
} from "../infrastructure/persistence/option-set-review-content-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async () => ({
  ...(await vi.importActual<typeof import("@bop/audit")>("@bop/audit")),
  appendAuditRecordInTransaction: vi.fn(async () => undefined),
}));
vi.mock("@bop/eventing", () => ({ appendEventInTransaction: vi.fn(async () => undefined) }));
function requiredValue<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("required synthetic fixture item is missing");
  return value;
}
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T00:00:00.000Z",
  fingerprint = "sha256:" + "a".repeat(64);
function fixture() {
  const source = {
    optionSetReference: id(4),
    brandReference: id(2),
    internalCode: "SYNTHETIC_CHOICES",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(5),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(6),
          optionSetReference: id(4),
          brandReference: id(2),
          stableCode: "ONE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic one" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: null,
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
        optionReference: id(6),
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
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  };
  const prepared = parseCatalogOptionSetEditorContent(source, details);
  const binding = createCatalogOptionSetContentReviewBinding({
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    expectedAggregateVersion: 1,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    graphDigest: fingerprint,
    policyReference: id(7),
    policyVersion: 1,
    policyContentDigest: fingerprint,
    currentPolicyPublicationReference: id(8),
    originalIntentDigest: fingerprint,
    activationAt: at,
  });
  const review = createCatalogOptionSetReviewRecord({
    operationReference: id(10),
    sourceOperationReference: id(9),
    lifecycleReference: id(11),
    actorReference: id(3),
    auditReference: id(12),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    binding,
    content: prepared.content,
  });
  const sealed = createCatalogFullOptionSetPublicationMaterialization(source, details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(13),
    publicationIntentDigest: fingerprint,
    successorDraftVersionReference: id(14),
    sealedAt: at,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  }).content;
  const release = createCatalogOptionSetReleaseRecord({
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    operationReference: id(15),
    reviewOperationReference: review.operationReference,
    reviewRecordDigest: review.digest,
    reviewBindingDigest: binding.digest,
    sealOperationReference: id(13),
    sealRecordDigest: sealed.digest,
    publishingOperationReference: id(16),
    actorReference: id(3),
    auditReference: id(17),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    release: {
      releaseId: id(18),
      familyReference: id(4),
      configurationType: "CATALOG_OPTION_SET",
      purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
      snapshotReference: id(5),
      snapshotDigest: binding.digest,
      scope: { kind: "Brand", brandReference: id(2), storeReference: null },
      sequence: 1,
      sourceLifecycleId: id(11),
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    },
  });
  return { source, details, prepared, binding, review, sealed, release };
}

function storeFixture(currentActor = id(3), ownSeal = false) {
  const f = fixture(),
    materialized = createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, {
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(4),
      versionReference: id(5),
      sourceAggregateVersion: 1,
      publicationOperationReference: id(13),
      publicationIntentDigest: fingerprint,
      successorDraftVersionReference: id(14),
      sealedAt: at,
      sourceDigest: f.prepared.sourceDigest,
      contentDigest: f.prepared.contentDigest,
      configurationDigest: f.prepared.configurationDigest,
    }),
    reviews = new Map<string, unknown>(),
    releases = new Map<string, unknown>(),
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  let current = at,
    allowed = true,
    source: unknown = f.prepared.content,
    frozen: unknown = f.sealed;
  const calls: Parameters<OptionSetReviewContentAuthority["holdUntilTransactionCompletes"]>[1][] =
    [];
  const authority: OptionSetReviewContentAuthority = {
    async holdUntilTransactionCompletes(actual, input) {
      expect(actual).toBe(tx);
      calls.push(input);
      if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { observedAt: input.observedAt, validUntil: "2026-10-04T00:00:05.000Z" };
    },
  };
  const queries: string[] = [],
    queryValues: unknown[][] = [];
  let discoveryRows: readonly unknown[] | null = null;
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      queries.push(sql);
      queryValues.push([...values]);
      let rows: unknown[] = [];
      let rowCount = 0;
      if (sql.includes("current_setting('bop.tenant_id',true) tenant"))
        rows = [{ tenant: id(1), brand: id(2), store: null, isolation: "read committed" }];
      else if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT jsonb_build_object")) {
        const full = source as typeof f.prepared.content,
          { sourceAggregate, ...details } = full;
        rows = [{ aggregate: sourceAggregate, details, coherent: true }];
      } else if (sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN")) {
        if (sql.includes("WHERE f.operation_id=$1"))
          rows = [{ snapshot: f.prepared.content, coherent: true }];
        else {
          const full = source as typeof f.prepared.content;
          const { sourceAggregate, ...details } = full;
          const actual = parseCatalogOptionSetEditorContent(sourceAggregate, details);
          rows = [
            {
              snapshot: source,
              source_digest: actual.sourceDigest,
              content_digest: actual.contentDigest,
              configuration_digest: actual.configurationDigest,
              intent_digest: fingerprint,
              coherent: true,
              sourceOperationReference:
                sourceAggregate.aggregateVersion === 1 ? f.review.sourceOperationReference : id(13),
              sourceTenantReference: id(1),
              sourceBrandReference: id(2),
              sourceOptionSetReference: id(4),
              sourceVersionReference: sourceAggregate.draft.versionReference,
              sourceAggregateVersion: sourceAggregate.aggregateVersion,
            },
          ];
        }
      } else if (sql.includes("FROM rms_catalog.option_set_publication_content p")) {
        rows = [
          {
            snapshot: frozen,
            coherent: true,
            metadata: {
              tenantReference: id(1),
              brandReference: id(2),
              optionSetReference: id(4),
              versionReference: id(5),
              publicationOperationReference: id(13),
              publicationIntentDigest: fingerprint,
              successorDraftVersionReference: id(14),
              sourceAggregateVersion: 1,
              sealedAt: at,
              sourceDigest: f.sealed.sourceDigest,
              contentDigest: f.sealed.contentDigest,
              configurationDigest: f.sealed.configurationDigest,
              recordDigest: f.sealed.digest,
              resultAggregateVersion: 2,
            },
          },
        ];
      } else if (sql.includes("count(*)::text")) rows = [{ n: "1", conflicts: "0" }];
      else if (sql.startsWith("SELECT option_set_id")) rows = [{ option_set_id: id(4) }];
      else if (sql.startsWith("SELECT option_set_version_id"))
        rows = [
          {
            option_set_version_id: (source as typeof f.prepared.content).sourceAggregate.draft
              .versionReference,
          },
        ];
      else if (sql.startsWith("SELECT operation_id,option_set_id"))
        rows = discoveryRows
          ? [...discoveryRows]
          : [...reviews.values()]
              .map(parseCatalogOptionSetReviewRecord)
              .filter(
                (r) =>
                  r.binding.optionSetReference === values[2] &&
                  r.binding.versionReference === values[3] &&
                  r.sourceOperationReference === values[4],
              )
              .sort(
                (a, b) =>
                  b.recordedAt.localeCompare(a.recordedAt) ||
                  b.operationReference.localeCompare(a.operationReference),
              )
              .slice(0, 2)
              .map((r) => ({
                operation_id: r.operationReference,
                option_set_id: r.binding.optionSetReference,
                option_set_version_id: r.binding.versionReference,
                source_operation_id: r.sourceOperationReference,
                lifecycle_id: r.lifecycleReference,
                binding_digest: r.binding.digest,
                record_digest: r.digest,
                recorded_at: r.recordedAt,
                snapshot: r,
              }));
      else if (sql.startsWith("SELECT snapshot_json snapshot,source_digest"))
        rows = [
          {
            snapshot: ownSeal ? f.prepared.content : source,
            source_digest: f.binding.sourceDigest,
            content_digest: f.binding.contentDigest,
            configuration_digest: f.binding.configurationDigest,
          },
        ];
      else if (
        sql.startsWith(
          "SELECT snapshot_json snapshot FROM rms_catalog.option_set_publication_content",
        )
      )
        rows = [{ snapshot: frozen }];
      else if (sql.startsWith("SELECT snapshot_json snapshot")) {
        const map = sql.includes("option_set_review_content") ? reviews : releases;
        const value = sql.includes("release_id=$3")
          ? [...map.values()].find(
              (item) => (item as typeof f.release).release.releaseId === values[2],
            )
          : map.get(String(values[2]));
        if (value) rows = [{ snapshot: value }];
      } else if (sql.startsWith("INSERT")) {
        const map = sql.includes("option_set_review_content") ? reviews : releases;
        map.set(String(values[0]), JSON.parse(String(values[values.length - 1])));
        rowCount = 1;
      }
      return { rows: rows as Row[], rowCount };
    },
  };
  const store = createPostgresOptionSetReviewContentStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: currentActor,
    clock: { now: () => current },
    authority,
    ...(ownSeal
      ? {
          publicationSeal: {
            identity: {
              operationReference: id(13),
              publicationIntentDigest: fingerprint,
              occurredAt: at,
            },
            originalObservedAt: at,
            originalValidUntil: "2026-10-04T00:00:05.000Z",
            currentDraftAuthority: {
              async holdUntilTransactionCompletes(
                actual: ProductLifecycleTransaction,
                input: { observedAt: string },
              ) {
                expect(actual).toBe(tx);
                if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
                return { observedAt: input.observedAt, validUntil: "2026-10-04T00:00:05.000Z" };
              },
            },
            frozenAuthority: {
              async holdUntilTransactionCompletes(
                actual: ProductLifecycleTransaction,
                input: { observedAt: string },
              ) {
                expect(actual).toBe(tx);
                if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
                return { observedAt: input.observedAt, validUntil: "2026-10-04T00:00:05.000Z" };
              },
            },
          },
        }
      : {}),
    currentDraftAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        expect(input.actorReference).toBe(currentActor);
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { observedAt: input.observedAt, validUntil: "2026-10-04T00:00:05.000Z" };
      },
    },
    registerBeforeCommit: (actual, guard, finalAssert) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(finalAssert);
    },
    events: { generateReference: () => id(30) },
  });
  const audit = (record: typeof f.review | typeof f.release): AppendAuditRecordInput => ({
    auditId: record.auditReference,
    brandId: id(2),
    actor: { type: "User", reference: id(3) },
    actionCode:
      record.profile === "CatalogOptionSetReviewRecordV1"
        ? "CATALOG_OPTION_SET_REVIEW_RECORDED"
        : "CATALOG_OPTION_SET_RELEASE_RECORDED",
    targetType: "CatalogOptionSet",
    targetId: id(4),
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: record.operationReference,
    occurredAt: record.recordedAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return {
    ...f,
    materialized,
    tx,
    store,
    audit,
    calls,
    guards,
    finals,
    queries,
    queryValues,
    setDiscoveryRows: (rows: readonly unknown[] | null) => {
      discoveryRows = rows;
    },
    reviews,
    releases,
    revoke: () => {
      allowed = false;
    },
    advance: (time: string) => {
      current = time;
    },
    changeSource: (value: unknown) => {
      source = value;
    },
    changeFrozen: (value: unknown) => {
      frozen = value;
    },
  };
}
it("records exact original content and genuine public release linkage on the supplied transaction", async () => {
  const f = storeFixture();
  expect((await f.store.saveReview(f.tx, f.review, f.audit(f.review))).status).toBe("Recorded");
  expect((await f.store.saveRelease(f.tx, f.release, f.audit(f.release))).status).toBe("Recorded");
  expect(await f.store.readReview(f.tx, f.review.operationReference, id(4))).toEqual(f.review);
  expect(await f.store.readRelease(f.tx, f.release.operationReference, id(4))).toEqual(f.release);
  for (const guard of f.guards) await guard();
  expect(f.calls.filter((call) => call.phase === "Apply")).toHaveLength(6);
  expect(f.queries.some((sql) => sql.includes("bop_publishing"))).toBe(false);
  expect(f.calls.every((call) => call.requiredFields.includes("digest"))).toBe(true);
});
it("exact replay and historical Read do not requalify current references", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  const before = f.queries.filter((sql) => sql.startsWith("INSERT")).length;
  expect((await f.store.saveReview(f.tx, f.review, f.audit(f.review))).status).toBe("Replayed");
  expect(f.queries.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(before);
  const offset = f.calls.length;
  await f.store.readReview(f.tx, f.review.operationReference, id(4));
  expect(f.calls.slice(offset).every((call) => call.phase === "Read")).toBe(true);
});
it("refuses operation collision before another append", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  const { profile, digest, ...input } = f.review;
  void profile;
  void digest;
  const changed = createCatalogOptionSetReviewRecord({ ...input, lifecycleReference: id(99) });
  await expect(f.store.saveReview(f.tx, changed, f.audit(changed))).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(f.reviews.size).toBe(1);
});
it("rejects original source mismatch and missing original review before appending release", async () => {
  const f = storeFixture();
  f.changeSource({ ...f.prepared.content, defaultLocale: "fr-CA" });
  await expect(f.store.saveReview(f.tx, f.review, f.audit(f.review))).rejects.toThrow();
  expect(f.reviews.size).toBe(0);
  await expect(f.store.saveRelease(f.tx, f.release, f.audit(f.release))).rejects.toThrow();
  expect(f.releases.size).toBe(0);
});
it("rejects a different sealed full packet despite identical stored linkage selectors", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  f.changeFrozen({ ...f.sealed, digest: fingerprint });
  await expect(f.store.saveRelease(f.tx, f.release, f.audit(f.release))).rejects.toThrow();
  expect(f.releases.size).toBe(0);
});
it("late permission withdrawal vetoes outer COMMIT with no cached authorization", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  f.revoke();
  await expect(requiredValue(f.guards[0])()).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
it.each(["2026-10-04T00:00:05.000Z", "2026-10-03T23:59:59.999Z"])(
  "original lease and monotonic clock reject %s at outer COMMIT",
  async (time) => {
    const f = storeFixture();
    await f.store.saveReview(f.tx, f.review, f.audit(f.review));
    f.advance(time);
    await expect(requiredValue(f.guards[0])()).rejects.toThrow();
  },
);
it("current read permission is required before SQL, even for missing receipts", async () => {
  const f = storeFixture();
  f.revoke();
  await expect(f.store.readReview(f.tx, id(99), id(4))).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.queries).toHaveLength(0);
});
it("refuses a receipt belonging to another requested Set", async () => {
  const f = storeFixture();
  f.reviews.set(f.review.operationReference, f.review);
  await expect(f.store.readReview(f.tx, f.review.operationReference, id(99))).rejects.toThrow();
});

it("a swallowed parser or write failure poisons the original host before COMMIT", async () => {
  const f = storeFixture();
  await expect(
    f.store.saveReview(f.tx, { ...f.review, digest: fingerprint }, f.audit(f.review)),
  ).rejects.toThrow();
  expect(f.guards).toHaveLength(1);
  await expect(requiredValue(f.guards[0])()).rejects.toThrow();
  expect(() => requiredValue(f.finals[0])()).toThrow();
  await expect(f.store.readReview(f.tx, id(99), id(4))).rejects.toThrow();
});
it("synchronous final assertion catches a lease consumed by a later asynchronous owner check", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  await requiredValue(f.guards[0])();
  f.advance("2026-10-04T00:00:05.000Z");
  expect(() => requiredValue(f.finals[0])()).toThrow();
});
it("a successful synchronous final assertion closes the host against subsequent operations", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  await requiredValue(f.guards[0])();
  expect(requiredValue(f.finals[0])()).toBeUndefined();
  await expect(f.store.readReview(f.tx, f.review.operationReference, id(4))).rejects.toThrow();
});
it("transaction query substitution poisons the original host without calling its replacement", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  const replacement = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  f.tx.query = replacement;
  await expect(f.store.readReview(f.tx, f.review.operationReference, id(4))).rejects.toThrow();
  await expect(requiredValue(f.guards[0])()).rejects.toThrow();
  expect(replacement).not.toHaveBeenCalled();
});

it("resolves persisted linkage by actual public release ID without guessing its operation", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  await f.store.saveRelease(f.tx, f.release, f.audit(f.release));
  expect(
    await f.store.readReleaseForPublication(f.tx, String(f.release.release.releaseId), id(4)),
  ).toEqual(f.release);
  expect(await f.store.readReleaseForPublication(f.tx, id(99), id(4))).toBeNull();
});

it("another authorized Actor can read original facts but cannot replay the original writer", async () => {
  const f = storeFixture(id(99));
  f.reviews.set(f.review.operationReference, f.review);
  expect(await f.store.readReview(f.tx, f.review.operationReference, id(4))).toEqual(f.review);
  expect(f.calls.every((call) => call.actorReference === id(99) && call.phase === "Read")).toBe(
    true,
  );
  await expect(f.store.saveReview(f.tx, f.review, f.audit(f.review))).rejects.toThrow();
});
it("different transactions retain independent original source admissions and mandatory final guards", async () => {
  const a = storeFixture(),
    b = storeFixture();
  await a.store.saveReview(a.tx, a.review, a.audit(a.review));
  await b.store.saveReview(b.tx, b.review, b.audit(b.review));
  a.revoke();
  await expect(requiredValue(a.guards[0])()).rejects.toThrow();
  await expect(requiredValue(b.guards[0])()).resolves.toBeUndefined();
  expect(requiredValue(b.finals[0])()).toBeUndefined();
});

it("skipping the registered async guard refuses the synchronous final assertion", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  expect(() => requiredValue(f.finals[0])()).toThrow();
});
it("a repeated async guard poisons final assertion even after one successful run", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  await requiredValue(f.guards[0])();
  await expect(requiredValue(f.guards[0])()).rejects.toThrow();
  expect(() => requiredValue(f.finals[0])()).toThrow();
});
it("swallowing a refused async guard cannot admit the final assertion", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  f.revoke();
  await requiredValue(f.guards[0])().catch(() => undefined);
  expect(() => requiredValue(f.finals[0])()).toThrow();
});

const currentReviewRequest = { optionSetReference: id(4), expectedAggregateVersion: 1 };
function laterReview(
  f: ReturnType<typeof storeFixture>,
  operation = id(100),
  recordedAt = "2026-10-04T00:00:00.001Z",
) {
  const { profile, digest, ...body } = f.review;
  void profile;
  void digest;
  return createCatalogOptionSetReviewRecord({
    ...body,
    operationReference: operation,
    lifecycleReference: id(101),
    auditReference: id(102),
    recordedAt,
  });
}
it("independent reader discovers genuine current-root stored Review and actual lifecycle without deriving approval", async () => {
  const f = storeFixture(id(99));
  f.reviews.set(f.review.operationReference, f.review);
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toEqual(f.review);
  expect(
    f.calls.every(
      (c) =>
        c.phase === "Read" && c.action === "catalog.option_set.read" && c.actorReference === id(99),
    ),
  ).toBe(true);
  expect(f.queries.some((q) => q.includes("FOR SHARE"))).toBe(true);
  expect(
    f.queryValues.some(
      (v) => v[0] === "CatalogOptionCurrentReview:" + id(1) + ":" + id(2) + ":" + id(4),
    ),
  ).toBe(true);
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  expect(f.queries.some((q) => q.startsWith("INSERT"))).toBe(false);
});
it("current-root Review absence is truthful and held through commit, never approval or Publishing Abandoned", async () => {
  const f = storeFixture();
  expect(
    await f.store.readCurrentReviewForDraft(f.tx, {
      ...currentReviewRequest,
      expectedAggregateVersion: null,
    }),
  ).toBeNull();
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  expect(
    f.queries.some((q) =>
      q.includes("ORDER BY rms_catalog.option_set_review_content.recorded_at DESC"),
    ),
  ).toBe(true);
});
it("uses unique latest immutable recorded time rather than caller-selected operation or UUID ordering", async () => {
  const f = storeFixture(),
    latest = laterReview(f, id(7));
  f.advance("2026-10-04T00:00:00.002Z");
  f.reviews.set(f.review.operationReference, f.review);
  f.reviews.set(latest.operationReference, latest);
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toEqual(latest);
  for (const guard of f.guards) await guard();
});
it("rejects ambiguous current-root Review timestamp ties", async () => {
  const f = storeFixture(),
    other = laterReview(f, id(100), at);
  f.reviews.set(f.review.operationReference, f.review);
  f.reviews.set(other.operationReference, other);
  await expect(
    f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  await expect(requiredValue(f.guards[0])()).rejects.toThrow();
});
it.each([
  "operation_id",
  "option_set_id",
  "option_set_version_id",
  "source_operation_id",
  "lifecycle_id",
  "binding_digest",
  "record_digest",
  "recorded_at",
])(
  "refuses immutable Review %s metadata substitution against real current provenance",
  async (field) => {
    const f = storeFixture(),
      r = f.review,
      row = {
        operation_id: r.operationReference,
        option_set_id: r.binding.optionSetReference,
        option_set_version_id: r.binding.versionReference,
        source_operation_id: r.sourceOperationReference,
        lifecycle_id: r.lifecycleReference,
        binding_digest: r.binding.digest,
        record_digest: r.digest,
        recorded_at: r.recordedAt,
        snapshot: r,
      };
    Object.assign(row, { [field]: "other" });
    f.setDiscoveryRows([row]);
    await expect(
      f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);
it("does not accept caller-provided source operation, digest, Actor or scope as root authority", async () => {
  for (const extra of [
    "sourceOperationReference",
    "sourceDigest",
    "actorReference",
    "tenantReference",
  ]) {
    const f = storeFixture();
    await expect(
      f.store.readCurrentReviewForDraft(f.tx, { ...currentReviewRequest, [extra]: id(99) }),
    ).rejects.toHaveProperty("code", "CATALOG_INPUT_INVALID");
    expect(f.queries).toHaveLength(0);
  }
});
it("rereads authoritative latest/absence at beforeCommit and rejects changed own transaction selection", async () => {
  const f = storeFixture();
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toBeNull();
  f.reviews.set(f.review.operationReference, f.review);
  await expect(requiredValue(f.guards[0])()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(() => requiredValue(f.finals[0])()).toThrow();
});
it.each(["source", "permission", "expiry", "query"])(
  "discovery retains late %s guard through actual outer host",
  async (change) => {
    const f = storeFixture();
    f.reviews.set(f.review.operationReference, f.review);
    await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest);
    if (change === "source")
      f.changeSource({
        ...f.prepared.content,
        sourceAggregate: { ...f.prepared.content.sourceAggregate, aggregateVersion: 2 },
      });
    if (change === "permission") f.revoke();
    if (change === "expiry") f.advance("2026-10-04T00:00:05.000Z");
    if (change === "query") f.tx.query = async () => ({ rows: [] });
    await expect(requiredValue(f.guards[0])()).rejects.toThrow();
    expect(() => requiredValue(f.finals[0])()).toThrow();
  },
);
it("saveReview and discovery use same per-Set writer barrier with source-before-review-before-original order", async () => {
  const f = storeFixture();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest);
  const source = f.queryValues.findIndex(
      (v) => v[0] === "CatalogFullOptionSource:" + id(2) + ":" + id(4),
    ),
    writer = f.queryValues.findIndex(
      (v, i) =>
        v[0] === "CatalogOptionCurrentReview:" + id(1) + ":" + id(2) + ":" + id(4) &&
        f.queries[i]?.includes("pg_advisory_xact_lock("),
    ),
    original = f.queryValues.findIndex(
      (v) =>
        v[0] ===
        "CatalogOptionReviewOperation:" + id(1) + ":" + id(2) + ":" + f.review.operationReference,
    );
  expect(source).toBeGreaterThanOrEqual(0);
  expect(writer).toBeGreaterThan(source);
  expect(original).toBeGreaterThan(writer);
  expect(
    f.queryValues.some(
      (v, i) =>
        v[0] === "CatalogOptionCurrentReview:" + id(1) + ":" + id(2) + ":" + id(4) &&
        f.queries[i]?.includes("pg_advisory_xact_lock_shared"),
    ),
  ).toBe(true);
  expect(f.queries.some((q) => q.startsWith("LOCK TABLE"))).toBe(false);
});
it("legacy factory without current Draft authority cannot use new discovery shortcut", async () => {
  const f = storeFixture(),
    store = createPostgresOptionSetReviewContentStore({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      clock: { now: () => at },
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          return { observedAt: input.observedAt, validUntil: "2026-10-04T00:00:05.000Z" };
        },
      },
      registerBeforeCommit: () => undefined,
      events: { generateReference: () => id(30) },
    });
  await expect(store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.queries).toHaveLength(0);
});

// Controlled SQL rows exercise the actual Catalog transition kernel; native
// owning Seal/COMMIT is verified separately by the coordinator.
it("retains the actual recorded Review across precisely its own original Seal and successor", async () => {
  const f = storeFixture(id(3), true);
  f.reviews.set(f.review.operationReference, f.review);
  expect(
    await f.store.readCurrentReviewForDraft(f.tx, {
      optionSetReference: id(4),
      expectedAggregateVersion: 1,
    }),
  ).toEqual(f.review);
  f.changeSource(f.materialized.successorEditorContent);
  const receipt = {
    status: "Applied",
    content: f.sealed,
    successorDraftVersionReference: id(14),
    operationReference: id(13),
    referenceEligibility: "NotEvaluated",
  };
  const proof = await f.store.admitOwnSeal(f.tx, receipt);
  expect(proof.successor.content).toEqual(f.materialized.successorEditorContent);
  expect(proof.original.sourceOperationReference).toBe(id(9));
  expect(
    f.queries.some((sql) => sql.includes("octet_length(p.snapshot_json::text)<=3145728")),
  ).toBe(true);
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  expect(f.reviews.get(f.review.operationReference)).toEqual(f.review);
});
it.each([
  "different-operation",
  "different-successor",
  "second-admission",
  "late-revocation",
  "record-change",
  "extra-root",
])("poisons own Seal handoff on %s", async (failure) => {
  const f = storeFixture(id(3), true);
  f.reviews.set(f.review.operationReference, f.review);
  await f.store.readCurrentReviewForDraft(f.tx, {
    optionSetReference: id(4),
    expectedAggregateVersion: 1,
  });
  f.changeSource(f.materialized.successorEditorContent);
  const receipt = {
    status: "Applied",
    content: f.sealed,
    successorDraftVersionReference: id(14),
    operationReference: failure === "different-operation" ? id(90) : id(13),
    referenceEligibility: "NotEvaluated",
  };
  if (failure === "different-successor") receipt.successorDraftVersionReference = id(91);
  if (failure === "different-operation" || failure === "different-successor") {
    await expect(f.store.admitOwnSeal(f.tx, receipt)).rejects.toBeInstanceOf(CatalogError);
    return;
  }
  await f.store.admitOwnSeal(f.tx, receipt);
  if (failure === "second-admission") {
    await expect(f.store.admitOwnSeal(f.tx, receipt)).rejects.toBeInstanceOf(CatalogError);
    return;
  }
  if (failure === "late-revocation") f.revoke();
  if (failure === "record-change") f.reviews.clear();
  if (failure === "extra-root")
    f.changeSource({
      ...f.materialized.successorEditorContent,
      sourceAggregate: {
        ...f.materialized.successorEditorContent.sourceAggregate,
        aggregateVersion: 3,
      },
    });
  for (const guard of f.guards) await expect(guard()).rejects.toBeInstanceOf(CatalogError);
});

function releaseAtDistinctOriginalInstants(
  f: ReturnType<typeof storeFixture>,
  sealedAt: string,
  recordedAt: string,
  review = f.review,
) {
  const sealed = createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(13),
    publicationIntentDigest: fingerprint,
    successorDraftVersionReference: id(14),
    sealedAt,
    sourceDigest: f.prepared.sourceDigest,
    contentDigest: f.prepared.contentDigest,
    configurationDigest: f.prepared.configurationDigest,
  }).content;
  const { profile, digest, ...body } = f.release;
  void profile;
  void digest;
  const record = createCatalogOptionSetReleaseRecord({
    ...body,
    recordedAt,
    reviewOperationReference: review.operationReference,
    reviewRecordDigest: review.digest,
    reviewBindingDigest: review.binding.digest,
    sealRecordDigest: sealed.digest,
    release: {
      ...f.release.release,
      createdAt: recordedAt,
      sourceLifecycleId: review.lifecycleReference,
    },
  });
  f.changeFrozen(sealed);
  f.reviews.set(review.operationReference, review);
  return { sealed, record };
}
it("links genuine original Review, later Seal and still later actual public release clocks without rewriting history", async () => {
  const f = storeFixture();
  const { sealed, record } = releaseAtDistinctOriginalInstants(
    f,
    "2026-10-04T00:00:00.001Z",
    "2026-10-04T00:00:00.003Z",
  );
  f.advance("2026-10-04T00:00:00.004Z");
  expect(f.review.recordedAt < sealed.supportedContent.sealedAt).toBe(true);
  expect(sealed.supportedContent.sealedAt < record.recordedAt).toBe(true);
  expect(record.release.createdAt).toBe(record.recordedAt);
  expect((await f.store.saveRelease(f.tx, record, f.audit(record))).status).toBe("Recorded");
  expect((await f.store.saveRelease(f.tx, record, f.audit(record))).status).toBe("Replayed");
  expect(await f.store.readReleaseForPublication(f.tx, record.release.releaseId, id(4))).toEqual(
    record,
  );
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  expect(f.reviews.get(f.review.operationReference)).toEqual(f.review);
});
it("rejects a Seal later than the actual release without appending linkage", async () => {
  const f = storeFixture();
  const { record } = releaseAtDistinctOriginalInstants(
    f,
    "2026-10-04T00:00:00.003Z",
    "2026-10-04T00:00:00.002Z",
  );
  f.advance("2026-10-04T00:00:00.004Z");
  await expect(f.store.saveRelease(f.tx, record, f.audit(record))).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(f.releases.size).toBe(0);
});
it("rejects an original Review newer than the linked Seal", async () => {
  const f = storeFixture(),
    review = laterReview(f, f.review.operationReference, "2026-10-04T00:00:00.002Z");
  const { record } = releaseAtDistinctOriginalInstants(
    f,
    "2026-10-04T00:00:00.001Z",
    "2026-10-04T00:00:00.003Z",
    review,
  );
  f.advance("2026-10-04T00:00:00.004Z");
  await expect(f.store.saveRelease(f.tx, record, f.audit(record))).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(f.releases.size).toBe(0);
});

it("admits a first absent Review only after this owner appended its exact original receipt on the captured transaction", async () => {
  const f = storeFixture();
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toBeNull();
  const receipt = await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  expect(receipt.status).toBe("Recorded");
  expect(receipt.record).toEqual(f.review);
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
  expect(f.reviews.get(f.review.operationReference)).toEqual(receipt.record);
  expect(
    f.calls.some((input) => input.phase === "Read" && input.record?.digest === f.review.digest),
  ).toBe(true);
});
it("permits exact replay after its own first append without admitting a second own record", async () => {
  const f = storeFixture();
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toBeNull();
  await f.store.saveReview(f.tx, f.review, f.audit(f.review));
  expect((await f.store.saveReview(f.tx, f.review, f.audit(f.review))).status).toBe("Replayed");
  for (const guard of f.guards) await guard();
  for (const final of f.finals) final();
});
it.each([
  "foreign-append",
  "replayed-preexisting",
  "alternate-own",
  "substituted-own",
  "source-changed",
  "late-denied",
  "expired",
])("keeps original Review absence fail-closed on %s", async (failure) => {
  const f = storeFixture();
  expect(await f.store.readCurrentReviewForDraft(f.tx, currentReviewRequest)).toBeNull();
  if (failure === "foreign-append" || failure === "replayed-preexisting") {
    f.reviews.set(f.review.operationReference, f.review);
    if (failure === "replayed-preexisting")
      expect((await f.store.saveReview(f.tx, f.review, f.audit(f.review))).status).toBe("Replayed");
  } else {
    await f.store.saveReview(f.tx, f.review, f.audit(f.review));
    const another = laterReview(f);
    if (failure === "alternate-own") {
      f.advance(another.recordedAt);
      await f.store.saveReview(f.tx, another, f.audit(another));
    }
    if (failure === "substituted-own") {
      f.advance(another.recordedAt);
      f.reviews.set(f.review.operationReference, another);
    }
    if (failure === "source-changed")
      f.changeSource({
        ...f.prepared.content,
        sourceAggregate: { ...f.prepared.content.sourceAggregate, aggregateVersion: 2 },
      });
    if (failure === "late-denied") f.revoke();
    if (failure === "expired") f.advance("2026-10-04T00:00:05.000Z");
  }
  for (const guard of f.guards) await expect(guard()).rejects.toBeInstanceOf(CatalogError);
  for (const final of f.finals) expect(final).toThrow(CatalogError);
});
