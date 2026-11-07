import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationVersion,
  type ProductPublicationCommand,
} from "../contracts/product-publication.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterialization,
} from "../contracts/product-publication-content.js";
import { catalogProductPublicationEventTypes } from "../contracts/product-publication-event.js";
import { parseProductAggregate, CatalogError } from "../contracts/product.js";
import {
  createPostgresProductTaxCoverageSourceStore,
  type ProductTaxCoverageSourceStoreOptions,
} from "../infrastructure/persistence/product-tax-coverage-source-store.js";
import { productTaxCoverageSourceFields } from "../contracts/product-tax-coverage-source.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction,
} from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T14:00:00.000Z",
  until = "2026-10-06T14:00:05.000Z";
function aggregate(n = 5, classification: string | null = id(7)) {
  return parseProductAggregate({
    productReference: id(n),
    brandReference: id(2),
    internalCode: `TAX_${n}`,
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draft: {
      versionReference: id(n + 100),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Controlled preparation" },
      taxClassificationReference: classification,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
    },
  });
}
function fixture() {
  let clock = at,
    lease = until,
    denied = false,
    registerValue: unknown = undefined;
  let roots = [aggregate()],
    history = false,
    precise = true;
  let beforeHold: () => Promise<void> = async () => {
    /* controlled authority hook */
  };
  let recordedRows: readonly unknown[] | undefined, sealedContent: unknown;
  const events: string[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const sql = vi.fn(async (statement: string, values: readonly unknown[]) => {
    events.push(
      statement === productSnapshotSelectSql
        ? "draft"
        : statement.includes("FROM rms_catalog.product p WHERE")
          ? "roster"
          : "sql",
    );
    if (statement.includes("statement_timeout")) {
      expect(Number(values[0])).toBeGreaterThan(0);
      expect(Number(values[0])).toBeLessThanOrEqual(Date.parse(lease) - Date.parse(clock));
    }
    if (statement.includes(" AS isolation")) return { rows: [{ isolation: "read committed" }] };
    if (statement.includes("FROM rms_catalog.product p WHERE"))
      return {
        rows: roots.map((r) => ({
          product_id: r.productReference,
          aggregate_version: r.aggregateVersion,
          lifecycle: r.lifecycle,
          has_history: history,
        })),
      };
    if (statement === productSnapshotSelectSql)
      return {
        rows: roots
          .filter((r) => r.productReference === values[1])
          .map((snapshot) => ({ snapshot, precise })),
      };
    if (statement.includes("current_setting('transaction_isolation')="))
      return { rows: [{ valid: true }] };
    if (statement.includes("SELECT h.source_revision::text"))
      return { rows: [{ source_revision: "3" }] };
    if (statement.includes("revisions,"))
      return {
        rows: [{ revisions: recordedRows?.length ?? 0, headers: 0, retirements: 0, bytes: "1000" }],
      };
    if (statement.includes("publication_action,r.snapshot_json publication"))
      return { rows: recordedRows ?? [] };
    if (statement.startsWith("SELECT snapshot_json FROM rms_catalog.product_publication_content"))
      return { rows: sealedContent ? [{ snapshot_json: sealedContent }] : [] };
    return { rows: [] };
  });
  const tx: ProductLifecycleTransaction = {
    async query<Row>(statement: string, values: readonly unknown[]) {
      const result = await sql(statement, values);
      return result as unknown as { rows: readonly Row[] };
    },
  };
  const options: ProductTaxCoverageSourceStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    transaction: tx,
    clock: { now: () => clock },
    originalObservedAt: at,
    originalValidUntil: until,
    registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      events.push("register");
      guards.push(guard);
      finals.push(final);
      return registerValue as undefined;
    },
    authority: {
      holdUntilTransactionCompletes: vi.fn(async (actual, request) => {
        expect(actual).toBe(tx);
        expect(request.requiredFields).toBe(productTaxCoverageSourceFields);
        expect(request.purposeCode).toBe("CATALOG_PRODUCT_TAX_COVERAGE_READ");
        expect(request.owningActions).toEqual([
          "catalog.product.read",
          "catalog.product.history.read",
          "catalog.sku.read",
        ]);
        await beforeHold();
        if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { validUntil: lease };
      }),
    },
  };
  const source = createPostgresProductTaxCoverageSourceStore(options);
  async function commit() {
    for (const guard of guards) await guard();
    for (const final of finals) final();
    events.push("commit");
    return source.assertFinalized(tx);
  }
  return {
    source,
    tx,
    options,
    events,
    sql,
    commit,
    guards,
    finals,
    roots(value: ReturnType<typeof aggregate>[]) {
      roots = value;
    },
    deny() {
      denied = true;
    },
    clock(value: string) {
      clock = value;
    },
    lease(value: string) {
      lease = value;
    },
    beforeHold(work: () => Promise<void>) {
      beforeHold = work;
    },
    recorded(rows: readonly unknown[], content: unknown, root: ReturnType<typeof aggregate>) {
      history = true;
      recordedRows = rows;
      sealedContent = content;
      roots = [root];
    },
    malformedHistory() {
      history = true;
    },
    imprecise() {
      precise = false;
    },
    badRegistration() {
      registerValue = true;
    },
  };
}
it("reads every saved Brand root and rechecks the complete roster before all final assertions", async () => {
  const f = fixture();
  f.roots([aggregate(), aggregate(6, null)]);
  const value = await f.source.readCurrent();
  expect(f.events[0]).toBe("register");
  expect(value.entries).toHaveLength(2);
  expect(value.completeness).toBe("Incomplete");
  expect(value.missingClassifications).toEqual([
    { productReference: id(6), versionReference: id(106), basis: "SavedDraftPreparation" },
  ]);
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("returns after real async and synchronous host guards with a shortest original lease", async () => {
  const f = fixture();
  f.lease("2026-10-06T14:00:02.000Z");
  const value = await f.source.readCurrent();
  expect(value.validUntil).toBe("2026-10-06T14:00:02.000Z");
  expect(await f.commit()).toBe(value.validUntil);
  expect(f.events.filter((e) => e === "roster")).toHaveLength(2);
  expect(f.events.filter((e) => e === "draft")).toHaveLength(2);
  await expect(f.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("does not omit empty Brand inputs or claim effective Store sellability", async () => {
  const f = fixture();
  f.roots([]);
  const value = await f.source.readCurrent();
  expect(value.entries).toEqual([]);
  expect(value.completeness).toBe("CompleteRecordedInputs");
  expect(value.sellability).toBe("NotEvaluated");
  await f.commit();
});
it("rejects added roots and same-revision actual Draft classification drift at COMMIT", async () => {
  for (const changed of [[aggregate(), aggregate(6)], [aggregate(5, id(999))]]) {
    const f = fixture();
    await f.source.readCurrent();
    f.roots(changed);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).not.toContain("commit");
  }
});
it("retains initial and late read/history permission checks without qualification shortcuts", async () => {
  const initial = fixture();
  initial.deny();
  await expect(initial.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(initial.events).not.toContain("roster");
  const late = fixture();
  await late.source.readCurrent();
  late.deny();
  await expect(late.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(late.events).not.toContain("commit");
});
it("rejects malformed recorded history rather than accepting a supplied Published label", async () => {
  const f = fixture();
  f.malformedHistory();
  await expect(f.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects oversized complete root sets and imprecise source timestamps", async () => {
  const f = fixture();
  f.roots(Array.from({ length: 1001 }, (_, i) => aggregate(1000 + i)));
  await expect(f.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  const precise = fixture();
  precise.imprecise();
  await expect(precise.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("poisons strict registration, foreign final host, port replacement and original clock expiry", async () => {
  const f = fixture();
  f.badRegistration();
  await expect(f.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.sql).not.toHaveBeenCalled();
  const drift = fixture();
  await drift.source.readCurrent();
  drift.tx.query = async () => ({ rows: [] });
  await expect(drift.commit()).rejects.toThrow();
  const expired = fixture();
  await expired.source.readCurrent();
  expired.clock(until);
  await expect(expired.commit()).rejects.toThrow();
  const foreign = fixture();
  await foreign.source.readCurrent();
  expect(() => foreign.source.assertFinalized({ query: async () => ({ rows: [] }) })).toThrow();
});
it("rejects monotonic clock reversal and swallowed nested reentry", async () => {
  const f = fixture();
  await f.source.readCurrent();
  f.clock("2026-10-06T14:00:01.000Z");
  await f.source.readCurrent();
  f.clock(at);
  await expect(f.commit()).rejects.toThrow();
  const reentry = fixture();
  reentry.beforeHold(async () => {
    await reentry.source.readCurrent().catch(() => undefined);
  });
  await expect(reentry.source.readCurrent()).rejects.toThrow();
});
function recordedPublication(publishedAt = at) {
  const digest = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
  let current = aggregate(),
    previous: ProductPublicationVersion | null = null;
  const rows: unknown[] = [];
  let sealed:
    ReturnType<typeof createCatalogProductPublicationMaterialization>["content"] | undefined;
  for (const [index, action] of (["Validate", "SubmitReview", "Publish"] as const).entries()) {
    const identity = deriveCatalogProductPublicationContentIdentity(current),
      scopeSet = [
        {
          level: "Store" as const,
          reference: id(3),
          channelCodes: ["WEB"],
          orderTypeCodes: ["PICKUP"],
        },
      ],
      effectivePeriod = {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      };
    const command: ProductPublicationCommand = {
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: current.productReference,
      versionReference: current.draft.versionReference,
      actorReference: id(4),
      actorKind: "User",
      operationReference: id(300 + index),
      expectedProductAggregateVersion: current.aggregateVersion,
      expectedPublicationVersion: previous?.publicationVersion ?? 0,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet,
      effectivePeriod,
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: action === "Publish" ? id(400) : null,
      occurredAt: publishedAt,
      reasonCode: "CONTROLLED_PUBLISH",
    };
    const publication: ProductPublicationVersion = planCatalogProductPublication(
      command,
      previous,
      {
        now: publishedAt,
        productAggregateVersion: current.aggregateVersion,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeDigest: digest(scopeSet),
        periodDigest: digest(effectivePeriod),
        validation: {
          evidenceReference: id(500),
          productAggregateVersion: current.aggregateVersion,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeDigest: digest(scopeSet),
          periodDigest: digest(effectivePeriod),
          policyReference: id(501),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" as const })),
          warningAcknowledgement: null,
          checkedAt: publishedAt,
          validUntil: "2026-10-07T14:00:00.000Z",
        },
        approval: null,
        reviewReference: action === "SubmitReview" ? id(502) : null,
        replacement: null,
      },
    );
    if (action === "Publish") {
      const materialized = createCatalogProductPublicationMaterialization(current, publication);
      sealed = materialized.content;
      current = materialized.successor;
    } else
      current = parseProductAggregate({
        ...current,
        aggregateVersion: current.aggregateVersion + 1,
        updatedAt: publishedAt,
      });
    rows.push({
      publication_action: action,
      publication,
      aggregate: current,
      content: action === "Publish" ? sealed : null,
      snapshot_digest: digest(current),
      source_revision: String(index + 1),
      event_type: catalogProductPublicationEventTypes[action],
      actor_reference: id(4),
      correlation_reference: command.operationReference,
      coherent: true,
    });
    previous = publication;
  }
  if (!sealed) throw Error("missing controlled sealed content");
  return { rows, sealed, current };
}
it("consumes the actual complete publication history kernel and immutable sealed classification independently of successor Draft", async () => {
  const recorded = recordedPublication(),
    f = fixture();
  const changed = parseProductAggregate({
    ...recorded.current,
    draft: { ...recorded.current.draft, taxClassificationReference: id(999) },
  });
  f.recorded(recorded.rows, recorded.sealed, changed);
  const value = await f.source.readCurrent(),
    entry = value.entries[0];
  expect(entry?.draft?.taxClassificationReference).toBe(id(999));
  expect(entry?.published[0]?.taxClassificationReference).toBe(id(7));
  expect(entry?.publicationCoverage?.history).toHaveLength(3);
  expect(entry?.publicationCoverage?.eligibility).toBe("NotEvaluated");
  expect(value.sellability).toBe("NotEvaluated");
  await f.commit();
});
it("refuses forged sealed body against real recorded content digest at initial acquisition", async () => {
  const recorded = recordedPublication(),
    f = fixture();
  f.recorded(
    recorded.rows,
    {
      ...recorded.sealed,
      sourceDraft: { ...recorded.sealed.sourceDraft, taxClassificationReference: id(999) },
    },
    recorded.current,
  );
  await expect(f.source.readCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});

it("observes publication completed after original request time without renewing the original deadline", async () => {
  const acquired = "2026-10-06T14:00:01.000Z",
    reobserved = "2026-10-06T14:00:02.000Z";
  const recorded = recordedPublication(acquired),
    f = fixture();
  f.recorded(recorded.rows, recorded.sealed, recorded.current);
  f.clock(acquired);
  const first = await f.source.readCurrent();
  expect(first.observedAt).toBe(acquired);
  expect(first.validUntil).toBe(until);
  f.clock(reobserved);
  const second = await f.source.readCurrent();
  expect(second.observedAt).toBe(reobserved);
  expect(second.sourceDigest).toBe(first.sourceDigest);
  expect(second.entries[0]?.publicationCoverage?.observedAt).toBe(reobserved);
  expect(second.entries[0]?.publicationCoverage?.digest).not.toBe(
    first.entries[0]?.publicationCoverage?.digest,
  );
  expect(await f.commit()).toBe(until);
});
