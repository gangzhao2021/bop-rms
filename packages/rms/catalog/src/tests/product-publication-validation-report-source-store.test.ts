import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import {
  buildCatalogProductEditorSnapshot,
  productEditorSnapshotFields,
} from "../contracts/product-editor-snapshot.js";
import { buildCatalogProductRetirementCoverage } from "../contracts/product-publication-source-v2.js";
import { productPublicationValidationReportReadFields } from "../contracts/product-publication-validation-report-query-v2.js";
import { createPostgresProductEditorSourceStore } from "../infrastructure/persistence/product-editor-source-store.js";
import {
  createPostgresProductPublicationSourceStoreV2,
  productPublicationSourceFieldsV2,
} from "../infrastructure/persistence/product-publication-source-store.js";
import { recoverProductPublicationValidationReport } from "../infrastructure/persistence/product-publication-validation-report-store.js";
import {
  createPostgresProductPublicationValidationReportSourceV2 as create,
  type ProductPublicationValidationReportSourceOptionsV2,
} from "../infrastructure/persistence/product-publication-validation-report-source-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";

vi.mock("../infrastructure/persistence/product-editor-source-store.js", () => ({
  createPostgresProductEditorSourceStore: vi.fn(),
}));
vi.mock(
  "../infrastructure/persistence/product-publication-source-store.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../infrastructure/persistence/product-publication-source-store.js")
    >()),
    createPostgresProductPublicationSourceStoreV2: vi.fn(),
  }),
);
vi.mock("../infrastructure/persistence/product-publication-validation-report-store.js", () => ({
  recoverProductPublicationValidationReport: vi.fn(),
}));
const id = (n: number) => `01902421-0133-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-03T12:00:00.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
type Mode =
  | "normal"
  | "missingEditor"
  | "doubleEditor"
  | "foreignEditor"
  | "missingHistory"
  | "doubleHistory"
  | "foreignHistory"
  | "wrongReturn";
beforeEach(() => vi.clearAllMocks());
function fixture(mode: Mode = "normal") {
  const scope = { tenantReference: id(1), brandReference: id(2) },
    request = {
      productReference: id(5),
      versionReference: id(6),
      expectedAggregateVersion: 1,
      expectedPublicationVersion: 0,
    };
  const aggregate = {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_READ",
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
      localizedNames: { "en-CA": "Synthetic read" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
    },
  };
  const editor = buildCatalogProductEditorSnapshot(
    aggregate,
    scope,
    { productReference: id(5), expectedAggregateVersion: 1 },
    at,
  );
  const coverage = buildCatalogProductRetirementCoverage({
    ...scope,
    productReference: id(5),
    aggregateVersion: 1,
    sourceRevision: "1",
    observedAt: at,
    history: [],
    headers: [],
  });
  let ms = 0,
    depth = 0,
    tentative = 0,
    committed = 0,
    afterWork: (() => void) | undefined,
    afterAsync: (() => void) | undefined,
    finalFailure: unknown;
  const guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>() {
      return { rows: [] as readonly Row[], rowCount: 0 };
    },
  };
  const foreignTx: ProductLifecycleTransaction = {
    async query<Row>() {
      return { rows: [] as readonly Row[], rowCount: 0 };
    },
  };
  const holdContent = vi.fn<
      ProductPublicationValidationReportSourceOptionsV2["contentAuthority"]["holdUntilTransactionCompletes"]
    >(async () => undefined),
    holdHistory = vi.fn<
      ProductPublicationValidationReportSourceOptionsV2["historyAuthority"]["holdUntilTransactionCompletes"]
    >(async () => undefined),
    holdReport = vi.fn<
      ProductPublicationValidationReportSourceOptionsV2["reportAuthority"]["holdUntilTransactionCompletes"]
    >(async () => undefined);
  const options: ProductPublicationValidationReportSourceOptionsV2 = {
    ...scope,
    storeReference: id(20),
    actorReference: id(3),
    clock: {
      now() {
        return time(ms);
      },
    },
    contentAuthority: { holdUntilTransactionCompletes: holdContent },
    historyAuthority: { holdUntilTransactionCompletes: holdHistory },
    reportAuthority: { holdUntilTransactionCompletes: holdReport },
    async registerBeforeCommit(actual, asyncGuard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ asyncGuard, finalAssert });
    },
    transactions: {
      async run<T>(work: (actual: ProductLifecycleTransaction) => Promise<T>) {
        if (depth > 0) return work(tx);
        depth++;
        try {
          const result = await work(tx);
          afterWork?.();
          for (const guard of guards) await guard.asyncGuard();
          afterAsync?.();
          for (const guard of guards) {
            try {
              expect(guard.finalAssert()).toBeUndefined();
            } catch (error) {
              finalFailure = error;
              throw error;
            }
          }
          committed += tentative;
          tentative = 0;
          return result;
        } catch (error) {
          tentative = 0;
          throw error;
        } finally {
          depth--;
        }
      },
    },
  };
  vi.mocked(createPostgresProductEditorSourceStore).mockImplementation((o) => ({
    context: {
      tenantReference: parseCatalogReference(scope.tenantReference),
      brandReference: parseCatalogReference(scope.brandReference),
      actorReference: parseCatalogReference(id(3)),
      actorKind: "User",
    },
    async withCurrentSnapshot<T>(
      _request: unknown,
      work: (value: typeof editor, actual: ProductLifecycleTransaction) => Promise<T>,
    ) {
      return o.transactions.run(async (actual) => {
        await o.authority.holdUntilTransactionCompletes(actual, {
          ...scope,
          actorReference: id(3),
          actorKind: "User",
          productReference: id(5),
          purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
          permission: "catalog.manage",
          owningAction: "catalog.product.manage",
          requiredFields: productEditorSnapshotFields,
          observedAt: at,
        });
        if (mode === "missingEditor") return undefined as T;
        const result = await work(editor, mode === "foreignEditor" ? foreignTx : actual);
        if (mode === "doubleEditor") await work(editor, actual);
        return mode === "wrongReturn" ? (undefined as T) : result;
      });
    },
  }));
  vi.mocked(createPostgresProductPublicationSourceStoreV2).mockImplementation(
    (o) =>
      ({
        async withCurrentCoverage<T>(
          _request: unknown,
          work: (value: typeof coverage, actual: ProductLifecycleTransaction) => Promise<T>,
        ) {
          return o.transactions.run(async (actual) => {
            await o.authority.holdUntilTransactionCompletes(actual, {
              ...scope,
              actorReference: id(3),
              actorKind: "User",
              productReference: id(5),
              purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
              permission: "catalog.manage",
              owningActions: ["catalog.product.history.read"],
              requiredFields: productPublicationSourceFieldsV2,
              observedAt: at,
            });
            if (mode === "missingHistory") return undefined as T;
            const result = await work(coverage, mode === "foreignHistory" ? foreignTx : actual);
            if (mode === "doubleHistory") await work(coverage, actual);
            return result;
          });
        },
      }) as ReturnType<typeof createPostgresProductPublicationSourceStoreV2>,
  );
  const source = create(options);
  return {
    source,
    options,
    request,
    tx,
    holdContent,
    holdHistory,
    holdReport,
    guards,
    setTime(value: number) {
      ms = value;
    },
    advanceAfterWork(work: () => void) {
      afterWork = work;
    },
    advanceAfterAsync(work: () => void) {
      afterAsync = work;
    },
    write() {
      tentative++;
    },
    counts() {
      return { tentative, committed };
    },
    finalFailure() {
      return finalFailure;
    },
  };
}

describe("ordinary immutable report held read", () => {
  it("composes one actual tx and complete editor/history authority with explicit report fields", async () => {
    const h = fixture();
    const result = await h.source.withCurrentReport(h.request, async (view, tx) => {
      expect(tx).toBe(h.tx);
      expect(view.status).toBe("NotValidated");
      expect(view.validUntil).toBe(time(5000));
      h.write();
      return view;
    });
    expect(result.eligibility).toBe("NotEvaluated");
    expect(h.counts()).toEqual({ tentative: 0, committed: 1 });
    expect(createPostgresProductEditorSourceStore).toHaveBeenCalledTimes(1);
    expect(createPostgresProductPublicationSourceStoreV2).toHaveBeenCalledTimes(1);
    expect(recoverProductPublicationValidationReport).not.toHaveBeenCalled();
    expect(h.holdReport).toHaveBeenCalledWith(h.tx, {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      ...h.request,
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
      permission: "catalog.manage",
      owningActions: ["catalog.product.read", "catalog.product.history.read"],
      requiredScope: "FullBrandScope",
      requiredFields: productPublicationValidationReportReadFields,
      observedAt: at,
    });
    expect(h.holdContent).toHaveBeenCalledTimes(2);
    expect(h.holdHistory).toHaveBeenCalledTimes(2);
  });
  it.each([
    "missingEditor",
    "doubleEditor",
    "foreignEditor",
    "missingHistory",
    "doubleHistory",
    "foreignHistory",
    "wrongReturn",
  ] as const)("rejects %s callback pollution and never commits", async (mode) => {
    const h = fixture(mode);
    await expect(
      h.source.withCurrentReport(h.request, async () => {
        h.write();
        return "observed";
      }),
    ).rejects.toEqual(unavailable);
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("rejects wrong root/version locators before consumer and report recovery", async () => {
    const h = fixture(),
      consumer = vi.fn();
    await expect(
      h.source.withCurrentReport({ ...h.request, versionReference: id(99) }, consumer),
    ).rejects.toEqual(unavailable);
    expect(consumer).not.toHaveBeenCalled();
    expect(recoverProductPublicationValidationReport).not.toHaveBeenCalled();
  });
  it("holds the original observation and captures receiver-bound authority/clock ports", async () => {
    const h = fixture(),
      original = h.options.reportAuthority.holdUntilTransactionCompletes;
    h.options.reportAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
      throw Error("replacement must not run");
    });
    h.options.clock.now = () => {
      throw Error("replacement must not run");
    };
    const value = await h.source.withCurrentReport(h.request, async () => {
      h.setTime(1000);
      return "ok";
    });
    expect(value).toBe("ok");
    expect(original).toHaveBeenCalledTimes(4);
    for (const call of h.holdReport.mock.calls)
      expect(call[1]).toEqual(expect.objectContaining({ observedAt: at }));
  });
  it("rolls back tentative consumer work when late report authority is withdrawn", async () => {
    const h = fixture(),
      denied = new CatalogError("CATALOG_PERMISSION_DENIED");
    h.advanceAfterWork(() => h.holdReport.mockRejectedValue(denied));
    await expect(
      h.source.withCurrentReport(h.request, async () => {
        h.write();
        return "tentative";
      }),
    ).rejects.toBe(denied);
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("final synchronous guard rejects a later async guard exhausting the original deadline and preserves its error identity", async () => {
    const h = fixture();
    let observed = 0,
      received: unknown;
    h.advanceAfterAsync(() => h.setTime(5000));
    try {
      await h.source.withCurrentReport(h.request, async () => {
        observed++;
        h.write();
        return "tentative";
      });
    } catch (error) {
      received = error;
    }
    expect(observed).toBe(1);
    expect(received).toEqual(unavailable);
    expect(received).toBe(h.finalFailure());
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("rejects partial rollback after a larger clock observation", async () => {
    const h = fixture();
    h.holdReport.mockImplementation(async () => {
      h.setTime(2);
      return undefined;
    });
    await expect(
      h.source.withCurrentReport(h.request, async () => {
        h.write();
        h.setTime(1);
      }),
    ).rejects.toEqual(unavailable);
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("poisons the actual shared transaction after a caught nested same-factory call", async () => {
    const h = fixture();
    let consumers = 0;
    await expect(
      h.source.withCurrentReport(h.request, async () => {
        consumers++;
        h.write();
        await expect(
          h.source.withCurrentReport(h.request, async () => "forbidden"),
        ).rejects.toEqual(unavailable);
        return "caught";
      }),
    ).rejects.toEqual(unavailable);
    expect(consumers).toBe(1);
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("registers poison before malformed query or initial denial even when a borrowed caller catches it", async () => {
    for (const mode of ["malformed", "denied"] as const) {
      const h = fixture();
      if (mode === "denied")
        h.holdReport.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      await expect(
        h.options.transactions.run(async () => {
          try {
            await h.source.withCurrentReport(
              mode === "malformed" ? { ...h.request, extra: true } : h.request,
              async () => "forbidden",
            );
          } catch {
            h.write();
          }
        }),
      ).rejects.toEqual(unavailable);
      expect(h.guards).toHaveLength(1);
      expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
    }
  });
  it("detects query-port replacement after the consumer", async () => {
    const h = fixture();
    await expect(
      h.source.withCurrentReport(h.request, async () => {
        h.write();
        h.tx.query = async <Row>() => ({ rows: [] as readonly Row[], rowCount: 0 });
      }),
    ).rejects.toEqual(unavailable);
    expect(h.counts()).toEqual({ tentative: 0, committed: 0 });
  });
  it("requires the enclosing transaction's three-phase guard port", () => {
    const h = fixture();
    expect(() =>
      create({
        ...h.options,
        registerBeforeCommit: undefined,
      } as unknown as ProductPublicationValidationReportSourceOptionsV2),
    ).toThrow();
  });
});
