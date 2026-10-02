import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { expect, it, vi } from "vitest";
import {
  createPostgresProductDraftStore,
  CatalogError,
  parseProductAggregate,
  type ProductLifecycleTransaction,
} from "../index.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "ORIGINAL_1",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Original" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
    },
  });
  const indexed: Record<string, unknown>[] = [{ operation_id: id(5) }];
  const receipt: Record<string, unknown>[] = [
    {
      product_id: id(1),
      action_code: "Create",
      intent_digest: "sha256:" + "a".repeat(64),
      result_aggregate_version: 1,
      occurred_at: new Date(at),
      snapshot_json: aggregate,
      snapshot_brand: id(2),
      snapshot_product: id(1),
      snapshot_version: 1,
      snapshot_time: new Date(at),
    },
  ];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (
      sql.startsWith("SELECT operation_id,action_code FROM rms_catalog.product_operation_record")
    ) {
      expect(values).toEqual([id(2), id(1), 1]);
      expect(sql).toContain("LIMIT 2");
      return { rows: indexed };
    }
    if (sql.startsWith("SELECT r.product_id")) {
      expect(values).toEqual([id(2), id(5)]);
      return { rows: receipt };
    }
    if (sql.includes("FROM rms_catalog.product p"))
      throw new Error("Unexpected mutable Draft fallback");
    return { rows: [] };
  });
  const tx = { query } as ProductLifecycleTransaction;
  const events: string[] = [];
  const authorize = vi.fn(async () => true);
  const store = createPostgresProductDraftStore({
    brandReference: id(2),
    authorize,
    transactions: {
      async run(work) {
        events.push("BEGIN");
        try {
          const result = await work(tx);
          events.push("COMMIT");
          return result;
        } catch (error) {
          events.push("ROLLBACK");
          throw error;
        }
      },
    },
  });
  return { aggregate, indexed, receipt, query, authorize, events, store };
}
it("returns exact original owning snapshot without mutable Draft read", async () => {
  const f = fixture();
  expect(await f.store.loadAggregateVersion(id(1), 1)).toEqual(f.aggregate);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it("absent version evidence is null, never current data", async () => {
  const f = fixture();
  f.indexed.length = 0;
  expect(await f.store.loadAggregateVersion(id(1), 1)).toBeNull();
  expect(f.receipt).toHaveLength(1);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("ambiguous operation history is unavailable", async () => {
  const f = fixture();
  f.indexed.push({ operation_id: id(6) });
  await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
it.each(["missing", "brand", "product", "version", "time", "snapshot", "operation"])(
  "rejects %s original evidence instead of reconstructing it",
  async (kind) => {
    const f = fixture();
    const row = f.receipt[0];
    if (!row) throw new Error("Missing synthetic receipt");
    if (kind === "missing") f.receipt.length = 0;
    if (kind === "brand") row.snapshot_brand = id(90);
    if (kind === "product") row.snapshot_product = id(90);
    if (kind === "version") row.result_aggregate_version = 2;
    if (kind === "time") row.snapshot_time = new Date(Date.parse(at) + 1);
    if (kind === "snapshot") row.snapshot_json = null;
    if (kind === "operation") f.indexed[0] = { operation_id: "invalid" };
    await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it.each([0, -1, 1.5, 2147483648, Number.NaN])(
  "rejects invalid version %s before transaction",
  (version) => {
    const f = fixture();
    expect(() => f.store.loadAggregateVersion(id(1), version)).toThrowError(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(f.events).toEqual([]);
  },
);
it.each([1, 3])("requires current authorization at check %s", async (check) => {
  const f = fixture();
  let calls = 0;
  f.authorize.mockImplementation(async () => ++calls !== check);
  await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  if (check === 1) expect(f.query).not.toHaveBeenCalled();
});
it("propagates bounded owner dependency failures to outer transport", async () => {
  const f = fixture();
  const error = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  f.query.mockRejectedValue(error);
  await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toBe(error);
});

it.each(["product", "version"])(
  "rejects internally consistent receipt for wrong requested %s",
  async (kind) => {
    const f = fixture();
    const row = f.receipt[0];
    if (!row) throw new Error("Missing synthetic receipt");
    if (kind === "product") {
      row.product_id = id(90);
      row.snapshot_product = id(90);
      row.snapshot_json = { ...f.aggregate, productReference: id(90) };
    } else {
      row.result_aggregate_version = 2;
      row.snapshot_version = 2;
      row.snapshot_json = { ...f.aggregate, aggregateVersion: 2 };
    }
    await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
  },
);
it("legacy operation without a snapshot is unavailable", async () => {
  const f = fixture();
  const row = f.receipt[0];
  if (!row) throw new Error("Missing synthetic receipt");
  Object.assign(row, {
    snapshot_brand: null,
    snapshot_product: null,
    snapshot_version: null,
    snapshot_time: null,
    snapshot_json: null,
  });
  await expect(f.store.loadAggregateVersion(id(1), 1)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});

// Synthetic exact receipt tuples; actual publication-successor HTTP/SQL is
// covered by the owning isolated acceptance scenario, not by this mock.
function publicationFixture() {
  const legacy = fixture();
  const aggregate = parseProductAggregate({ ...legacy.aggregate, aggregateVersion: 2 });
  const scopeSet = [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }];
  const effectivePeriod = {
    timeZone: "UTC",
    effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
    effectiveUntil: null,
  };
  const publication = {
    tenantReference: id(9),
    brandReference: id(2),
    productReference: id(1),
    versionReference: id(4),
    publicationVersion: 1,
    productAggregateVersion: 1,
    state: "Draft",
    contentDigest: "sha256:" + "b".repeat(64),
    configurationDigest: "sha256:" + "c".repeat(64),
    scopeSet,
    scopeDigest: digest(scopeSet),
    effectivePeriod,
    periodDigest: digest(effectivePeriod),
    validationEvidenceReference: id(6),
    validationDecision: "Pass",
    policyReference: id(7),
    policyVersion: 1,
    approvalPolicy: "NotRequired",
    reviewReference: null,
    reviewVersion: null,
    submittedByActorReference: null,
    approvalEvidenceReference: null,
    scheduleReference: null,
    scheduleVersion: 0,
    publishedAt: null,
    supersededAt: null,
    supersededByVersionReference: null,
    successorDraftVersionReference: null,
    operationReference: id(5),
    intentDigest: "sha256:" + "a".repeat(64),
    actorReference: id(3),
    actorKind: "User",
    occurredAt: at,
    reasonCode: "SYNTHETIC_HISTORY",
  };
  const receipt: Record<string, unknown> = {
    aggregate,
    publication,
    tenant_id: id(9),
    action_code: "Validate",
    event_type: "ProductValidationCompleted",
    snapshot_digest: digest(aggregate),
    coherent: true,
    publication_time: new Date(at),
    publication_intent: publication.intentDigest,
  };
  legacy.query.mockImplementation(async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("SELECT operation_id,action_code")) {
      expect(values).toEqual([id(2), id(1), 2]);
      return { rows: [{ operation_id: id(5), action_code: "ProductPublication" }] };
    }
    if (sql.startsWith("SELECT CASE WHEN octet_length")) {
      expect(values).toEqual([id(2), id(1), id(5), 2]);
      expect(sql).toContain("rms_catalog.product_source_commit");
      expect(sql).toContain("rms_catalog.product_publication_revision");
      expect(sql).toContain("current_setting('bop.tenant_id',true)");
      expect(sql).toContain("LIMIT 2");
      return { rows: [receipt] };
    }
    if (sql.startsWith("SELECT r.product_id"))
      throw Error("Legacy replay is not publication recovery");
    return { rows: [] };
  });
  return { ...legacy, aggregate, publication, receipt };
}
it("reads exact publication-produced aggregate version while preserving legacy command replay restrictions", async () => {
  const f = publicationFixture();
  expect(await f.store.loadAggregateVersion(id(1), 2)).toEqual(f.aggregate);
  expect(f.events).toEqual(["BEGIN", "COMMIT"]);
});
it("reads the actual successor Draft identity from a Published receipt", async () => {
  const f = publicationFixture();
  const successor = parseProductAggregate({
    ...f.aggregate,
    draft: { ...f.aggregate.draft, versionReference: id(10), baseVersionReference: id(4) },
  });
  Object.assign(f.receipt, {
    aggregate: successor,
    snapshot_digest: digest(successor),
    action_code: "Publish",
    event_type: "ProductVersionPublished",
  });
  Object.assign(f.publication, {
    publicationVersion: 3,
    state: "Published",
    reviewReference: id(11),
    reviewVersion: 2,
    submittedByActorReference: id(3),
    publishedAt: at,
    successorDraftVersionReference: id(10),
  });
  expect(await f.store.loadAggregateVersion(id(1), 2)).toEqual(successor);
});
it.each([
  "coherence",
  "digest",
  "tenant",
  "product",
  "brand",
  "version",
  "operation",
  "event",
  "action",
  "time",
  "intent",
  "state",
  "actor",
  "successor",
])("rejects publication %s receipt mismatch", async (kind) => {
  const f = publicationFixture();
  if (kind === "coherence") f.receipt.coherent = null;
  if (kind === "digest") f.receipt.snapshot_digest = "sha256:" + "d".repeat(64);
  if (kind === "tenant") f.receipt.tenant_id = id(99);
  if (kind === "product") f.publication.productReference = id(99);
  if (kind === "brand") f.publication.brandReference = id(99);
  if (kind === "version") f.publication.productAggregateVersion = 2;
  if (kind === "operation") f.publication.operationReference = id(99);
  if (kind === "event") f.receipt.event_type = "ProductVersionPublished";
  if (kind === "action") f.receipt.action_code = "FutureAction";
  if (kind === "time") f.receipt.publication_time = new Date(Date.parse(at) + 1);
  if (kind === "intent") f.receipt.publication_intent = "sha256:" + "d".repeat(64);
  if (kind === "state") f.receipt.action_code = "SubmitReview";
  if (kind === "actor") f.receipt.action_code = "ActivateScheduled";
  if (kind === "successor") f.publication.versionReference = id(99);
  await expect(f.store.loadAggregateVersion(id(1), 2)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toEqual(["BEGIN", "ROLLBACK"]);
});
