import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { bindCatalogProductPublicationValidationContextV2 } from "../contracts/product-publication-validation-context-v2.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import { buildCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
import {
  buildProductPublicationReferenceHistorySnapshotV2 as build,
  parseProductPublicationReferenceHistorySnapshotV2 as parse,
  buildProductReferenceHistorySourceSnapshot,
  productPublicationReferenceHistoryFieldsV2,
  type ProductPublicationReferenceHistorySnapshotV2,
} from "../contracts/product-reference-history-source.js";
import {
  createPostgresProductPublicationReferenceHistorySourceV2,
  type ProductPublicationReferenceHistorySourceOptionsV2,
} from "../infrastructure/persistence/product-reference-history-source-store.js";
type Options = ProductPublicationReferenceHistorySourceOptionsV2;
type Transaction = Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[0];
const id = (n: number) => "01902445-0001-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
function fixture(system = false) {
  const initialAggregate = parseProductAggregate({
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTHETIC_HISTORY",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(5),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic history" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(initialAggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    initialCommand = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(7),
      productReference: id(4),
      versionReference: id(5),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(6), channelCodes: [], orderTypeCodes: [] }],
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
  // Structural fixtures deliberately retain HardError; this source neither
  // authorizes activation nor manufactures a successful full validation.
  const current = system
    ? planCatalogProductPublicationV2(initialCommand, null, {
        now: at,
        productAggregateVersion: 1,
        contentDigest: initialCommand.contentDigest,
        configurationDigest: initialCommand.configurationDigest,
        scopeDigest: hash(initialCommand.scopeSet),
        periodDigest: hash(initialCommand.effectivePeriod),
        validation: {
          profile: "CatalogProductPublicationValidationV2",
          replacementIntentDigest: initialCommand.replacementIntentDigest,
          evidenceReference: id(30),
          productAggregateVersion: 1,
          contentDigest: initialCommand.contentDigest,
          configurationDigest: initialCommand.configurationDigest,
          scopeDigest: hash(initialCommand.scopeSet),
          periodDigest: hash(initialCommand.effectivePeriod),
          policyReference: id(31),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "HardError" })),
          warningAcknowledgement: null,
          checkedAt: at,
          validUntil: time(1000),
        },
        approval: null,
        reviewReference: null,
        replacement: null,
      })
    : null;
  const aggregate = system
      ? parseProductAggregate({ ...initialAggregate, aggregateVersion: 2 })
      : initialAggregate,
    command = system
      ? parseProductPublicationCommandV2({
          ...initialCommand,
          actorKind: "System",
          action: "ActivateScheduled",
          operationReference: id(8),
          expectedProductAggregateVersion: 2,
          expectedPublicationVersion: 1,
          scheduleReference: id(40),
          successorDraftVersionReference: id(41),
        })
      : initialCommand,
    context = bindCatalogProductPublicationValidationContextV2({
      command,
      aggregate,
      current,
      content: null,
      observedAt: at,
    }),
    request = buildCatalogProductPublicationReferenceRequestV2(context, time(1000)),
    configuration = {
      versionReference: id(5),
      categoryClassificationKnown: false,
      categoryReferences: null,
      primaryCategoryReference: null,
      taxClassificationReference: null,
      skuReferences: [],
      bindings: [],
    };
  return {
    context,
    request,
    aggregate,
    current,
    source: {
      observedAt: at,
      targetExists: true,
      recordedAggregateVersion: aggregate.aggregateVersion,
      recordCoverage: true,
      configurations: [configuration],
    },
  };
}
// Controlled SQL/authority collaborator. The separately owned native helper
// exercises actual snapshots, RLS, owning writers and transaction rollback.
function harness(system = false) {
  const f = fixture(system),
    state = {
      at,
      denied: false,
      isolation: "read committed",
      currentMissing: false,
      current: {
        aggregate: f.aggregate,
        snapshot_digest: hash(f.aggregate),
        publication: f.current,
        coherent: true,
        publication_coherent: true,
      } as Record<string, unknown>,
      source: f.source as unknown,
      statements: [] as string[],
      holders: [] as Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[1][],
      guards: [] as (() => Promise<void>)[],
      finals: [] as (() => void)[],
      afterHold: undefined as (() => void) | undefined,
      afterWork: undefined as ((tx: Transaction) => void) | undefined,
      double: false,
      substitute: false,
      swallow: false,
      swallowed: false,
      committed: false,
      skip: false,
    },
    query: Transaction["query"] = async <Row = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[],
    ) => {
      state.statements.push(sql);
      void values;
      const rows = sql.includes("transaction_isolation")
        ? [{ isolation: state.isolation }]
        : sql.startsWith("SELECT s.snapshot_json aggregate")
          ? state.currentMissing
            ? []
            : [state.current]
          : sql.startsWith("WITH recorded AS")
            ? [{ source: state.source }]
            : [];
      return { rows: rows as readonly Row[] };
    },
    tx: Transaction = { query },
    options: Options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: system ? "System" : "User",
      clock: { now: () => state.at },
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          expect(actual).toBe(tx);
          state.holders.push(input);
          if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          state.afterHold?.();
        },
      },
      async registerBeforeCommit(actual, guard, finalAssert) {
        expect(actual).toBe(tx);
        state.guards.push(guard);
        state.finals.push(finalAssert);
      },
      transactions: {
        async run<T>(work: (actual: Transaction) => Promise<T>): Promise<T> {
          state.guards = [];
          state.finals = [];
          state.committed = false;
          if (state.skip) return undefined as T;
          let value: T;
          try {
            value = await work(tx);
          } catch (error) {
            if (!state.swallow) throw error;
            state.swallowed = true;
            value = undefined as T;
          }
          if (state.double) {
            try {
              await work(tx);
            } catch {
              /* adversarial swallowed duplicate */
            }
          }
          state.afterWork?.(tx);
          for (const guard of state.guards) await guard();
          for (const finalAssert of state.finals) finalAssert();
          state.committed = true;
          return state.substitute ? (Object.freeze({}) as T) : value;
        },
      },
    };
  return {
    ...f,
    state,
    tx,
    options,
    store: createPostgresProductPublicationReferenceHistorySourceV2(options),
  };
}
it("retains complete recorded graphs and unknown classification without inventing publication coverage", () => {
  const f = fixture(),
    snapshot = build(f.source, f.request, at);
  expect(snapshot).toMatchObject({
    profile: "RecordedDraftConfigurationsForPublicationV2",
    coverage: "Complete",
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    recordedAggregateVersion: 1,
  });
  expect(snapshot.configurations[0]).toMatchObject({
    categoryCoverage: "Unavailable",
    categoryReferences: null,
    bindings: [],
  });
  expect(parse(snapshot, f.request, at)).toEqual(snapshot);
  expect(() =>
    buildProductReferenceHistorySourceSnapshot(f.source, f.request as never, at),
  ).toThrow();
  const legacyRequest = {
    purposeCode: "CATALOG_LIFECYCLE_REVIEW",
    brandReference: id(2),
    actorReference: id(3),
    productReference: id(4),
    skuReference: null,
    operationReference: id(7),
    expectedAggregateVersion: 1,
    originalProductVersionReference: id(5),
    beforeLifecycle: "Draft",
    targetLifecycle: "Archived",
    reasonCode: "SYNTHETIC",
    activeSkuCount: 0,
  };
  expect(() => build(f.source, legacyRequest as never, at)).toThrow();
});
it.each([
  "missing",
  "coverage",
  "root",
  "version",
  "overflow",
  "future",
  "oldObservation",
  "expiry",
  "accessor",
  "digest",
  "publicCoverage",
])("rejects incomplete or rebound publication history: %s", (fault) => {
  const f = fixture(),
    raw = { ...f.source },
    getter = vi.fn(() => []);
  if (fault === "missing") raw.configurations = [];
  if (fault === "coverage") raw.recordCoverage = false;
  if (fault === "root") raw.recordedAggregateVersion = 2;
  if (fault === "version")
    raw.configurations = raw.configurations.map((r) => ({ ...r, versionReference: id(99) }));
  if (fault === "overflow") {
    const configuration = f.source.configurations[0];
    if (configuration === undefined) throw new Error("Missing synthetic configuration");
    raw.configurations = Array.from({ length: 1001 }, () => configuration);
  }
  if (fault === "future") raw.observedAt = time(1);
  if (fault === "oldObservation") raw.observedAt = time(-1);
  if (fault === "accessor")
    Object.defineProperty(raw, "configurations", { enumerable: true, get: getter });
  if (fault === "digest" || fault === "publicCoverage") {
    const parsed = {
      ...build(raw, f.request, at),
      ...(fault === "digest" ? { digest: hash("wrong") } : { publicationCoverage: "Complete" }),
    };
    expect(() => parse(parsed, f.request, at)).toThrow();
  } else expect(() => build(raw, f.request, fault === "expiry" ? time(1000) : at)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([false, true])(
  "acquires actual root and history for the unchanged User/System intent: %s",
  async (system) => {
    const h = harness(system),
      consumer = vi.fn(
        async (snapshot: ProductPublicationReferenceHistorySnapshotV2, tx: Transaction) => {
          expect(tx).toBe(h.tx);
          return snapshot;
        },
      ),
      result = await h.store.withCurrentSnapshot(h.request, consumer);
    expect(result.request).toEqual(h.request);
    expect(h.state.holders).toHaveLength(4);
    expect(
      h.state.holders.every(
        (held) =>
          held.request === result.request ||
          canonicalizeRfc8785(held.request) === canonicalizeRfc8785(result.request),
      ),
    ).toBe(true);
    expect(h.state.holders[0]).toMatchObject({
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_REFERENCE_HISTORY_READ",
      permission: "catalog.manage",
      owningAction: "catalog.product.history.read",
      requiredScope: "FullBrandScope",
      actorKind: system ? "System" : "User",
      requiredFields: productPublicationReferenceHistoryFieldsV2,
    });
    const barrier = h.state.statements.findIndex((s) => s.includes("pg_advisory_xact_lock")),
      root = h.state.statements.findIndex((s) => s.startsWith("SELECT s.snapshot_json aggregate"));
    expect(barrier).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(barrier);
    expect(h.state.statements.some((s) => s.includes("set_config('bop.tenant_id'"))).toBe(true);
    expect(consumer).toHaveBeenCalledOnce();
    expect(h.state.committed).toBe(true);
  },
);
it.each([
  "missing",
  "coherent",
  "receipt",
  "snapshotDigest",
  "body",
  "draft",
  "currentPublication",
  "historyGraph",
  "isolation",
])("refuses unproven actual owning input before consumer: %s", async (fault) => {
  const h = harness(),
    consumer = vi.fn();
  if (fault === "missing") h.state.currentMissing = true;
  if (fault === "coherent") h.state.current.coherent = false;
  if (fault === "receipt") h.state.current.publication_coherent = false;
  if (fault === "snapshotDigest") h.state.current.snapshot_digest = hash("wrong");
  if (fault === "body") h.state.current.aggregate = { ...h.aggregate, internalCode: "OTHER" };
  if (fault === "draft") {
    h.state.current.aggregate = {
      ...h.aggregate,
      draft: { ...h.aggregate.draft, versionReference: id(99) },
    };
    h.state.current.snapshot_digest = hash(h.state.current.aggregate);
  }
  if (fault === "currentPublication") h.state.current.publication = {};
  if (fault === "historyGraph")
    h.state.source = {
      ...h.source,
      configurations: h.source.configurations.map((r) => ({
        ...r,
        taxClassificationReference: id(99),
      })),
    };
  if (fault === "isolation") h.state.isolation = "repeatable read";
  await expect(h.store.withCurrentSnapshot(h.request, consumer)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(consumer).not.toHaveBeenCalled();
  expect(h.state.committed).toBe(false);
});
it("refuses scope/actor mismatches before transaction and keeps actual authority denial typed", async () => {
  const h = harness(),
    foreign = createPostgresProductPublicationReferenceHistorySourceV2({
      ...h.options,
      tenantReference: id(99),
    });
  await expect(foreign.withCurrentSnapshot(h.request, async () => true)).rejects.toThrow();
  expect(h.state.statements).toHaveLength(0);
  h.state.denied = true;
  await expect(h.store.withCurrentSnapshot(h.request, async () => true)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.state.statements).toHaveLength(0);
});
it.each(["expiry", "denial", "query", "rollback", "consumerThrow"])(
  "holds original lease, transaction identity and authority through consumer completion: %s",
  async (fault) => {
    const h = harness();
    let entered = false;
    await expect(
      h.store.withCurrentSnapshot(h.request, async (_snapshot, tx) => {
        entered = true;
        if (fault === "expiry") h.state.at = time(1000);
        if (fault === "denial") h.state.denied = true;
        if (fault === "query") tx.query = vi.fn();
        if (fault === "rollback") h.state.at = time(-1);
        if (fault === "consumerThrow") throw new Error("synthetic private failure");
        return true;
      }),
    ).rejects.toMatchObject({
      code: fault === "denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(entered).toBe(true);
    expect(h.state.committed).toBe(false);
  },
);
it("detects intermediate clock advance then partial rollback and refuses malformed clocks", async () => {
  const h = harness();
  h.state.afterHold = () => {
    h.state.at = time(h.state.holders.length === 1 ? 2 : 1);
  };
  await expect(h.store.withCurrentSnapshot(h.request, async () => true)).rejects.toThrow();
  const malformed = harness();
  malformed.state.at = "invalid";
  await expect(
    malformed.store.withCurrentSnapshot(malformed.request, async () => true),
  ).rejects.toThrow();
});
it.each(["expiry", "query"])(
  "runs final synchronous assertions after all later async guards: %s",
  async (fault) => {
    const h = harness(),
      later = vi.fn(async () => {
        if (fault === "expiry") h.state.at = time(1000);
        else h.tx.query = vi.fn();
      });
    await expect(
      h.store.withCurrentSnapshot(h.request, async (_snapshot, tx) => {
        await h.options.registerBeforeCommit(tx, later, () => undefined);
        return "tentative";
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(later).toHaveBeenCalledOnce();
    expect(h.state.holders).toHaveLength(4);
    expect(h.state.committed).toBe(false);
  },
);
it("allows the legitimate consumer write to advance the Product root without rechecking the prior root at commit", async () => {
  const h = harness();
  await expect(
    h.store.withCurrentSnapshot(h.request, async () => {
      h.state.current = { ...h.state.current, aggregate: { ...h.aggregate, aggregateVersion: 2 } };
      return "owning writer advanced";
    }),
  ).resolves.toBe("owning writer advanced");
  expect(
    h.state.statements.filter((s) => s.startsWith("SELECT s.snapshot_json aggregate")),
  ).toHaveLength(1);
  expect(h.state.committed).toBe(true);
});
it.each(["skip", "double", "substitute", "earlyDenied", "earlyMissing"])(
  "refuses runner bypass or swallowed source failure: %s",
  async (fault) => {
    const h = harness();
    if (fault === "skip") h.state.skip = true;
    if (fault === "double") h.state.double = true;
    if (fault === "substitute") h.state.substitute = true;
    if (fault === "earlyDenied" || fault === "earlyMissing") {
      h.state.swallow = true;
      h.state.denied = fault === "earlyDenied";
      h.state.currentMissing = fault === "earlyMissing";
    }
    await expect(h.store.withCurrentSnapshot(h.request, async () => true)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    if (fault.startsWith("early")) {
      expect(h.state.swallowed).toBe(true);
      expect(h.state.guards).toHaveLength(1);
      expect(h.state.committed).toBe(false);
    }
  },
);
it("captures configured receivers and preserves a failed transaction's poison", async () => {
  const h = harness();
  h.options.clock.now = () => {
    throw new Error("replaced");
  };
  h.options.authority.holdUntilTransactionCompletes = vi
    .fn()
    .mockRejectedValue(new Error("replaced"));
  await expect(h.store.withCurrentSnapshot(h.request, async () => true)).resolves.toBe(true);
  h.state.denied = true;
  await expect(h.store.withCurrentSnapshot(h.request, async () => true)).rejects.toThrow();
  h.state.denied = false;
  await expect(h.store.withCurrentSnapshot(h.request, async () => true)).rejects.toThrow();
  expect(() =>
    createPostgresProductPublicationReferenceHistorySourceV2({
      ...h.options,
      registerBeforeCommit: undefined,
    } as unknown as Options),
  ).toThrow();
});
it("poisons the outer borrowed transaction when a nested same-factory refusal is caught", async () => {
  const h = harness(),
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  let outerConsumers = 0,
    innerConsumers = 0,
    commitAttempts = 0,
    commits = 0,
    innerError: unknown,
    outerError: unknown;
  const store = createPostgresProductPublicationReferenceHistorySourceV2({
    ...h.options,
    transactions: { run: async <T>(work: (tx: Transaction) => Promise<T>) => work(h.tx) },
    async registerBeforeCommit(tx, guard, finalAssert) {
      expect(tx).toBe(h.tx);
      guards.push(guard);
      finals.push(finalAssert);
    },
  });
  await expect(
    (async () => {
      try {
        await store.withCurrentSnapshot(h.request, async () => {
          outerConsumers++;
          try {
            await store.withCurrentSnapshot(h.request, async () => {
              innerConsumers++;
              return "inner";
            });
          } catch (error) {
            innerError = error;
          }
          return "outer tentative";
        });
      } catch (error) {
        outerError = error;
      }
      // Even a caller swallowing both refusals must fail the registered guard.
      commitAttempts++;
      for (const guard of guards) await guard();
      for (const finalAssert of finals) finalAssert();
      commits++;
    })(),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(innerError).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(outerError).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(outerConsumers).toBe(1);
  expect(innerConsumers).toBe(0);
  expect(guards).toHaveLength(1);
  expect(commitAttempts).toBe(1);
  expect(commits).toBe(0);
});
