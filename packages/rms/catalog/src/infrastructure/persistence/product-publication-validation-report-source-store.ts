import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  buildCatalogProductPublicationValidationReportView,
  parseCatalogProductPublicationValidationReportReadRequest,
  productPublicationValidationReportReadFields,
  type CatalogProductPublicationValidationReportViewV1,
} from "../../contracts/product-publication-validation-report-query-v2.js";
import { createPostgresProductEditorSourceStore } from "./product-editor-source-store.js";
import { createPostgresProductPublicationSourceStoreV2 } from "./product-publication-source-store.js";
import { recoverProductPublicationValidationReport } from "./product-publication-validation-report-store.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

type EditorOptions = Parameters<typeof createPostgresProductEditorSourceStore>[0];
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
export interface ProductPublicationValidationReportSourceOptionsV2 {
  readonly tenantReference: string;
  readonly brandReference: string;
  /** Selected UI context only. Owning report authority and RLS remain FullBrandScope. */
  readonly storeReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly contentAuthority: EditorOptions["authority"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly categoryAssignments?: EditorOptions["categoryAssignments"];
  readonly reportAuthority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User";
        readonly productReference: string;
        readonly versionReference: string;
        readonly expectedAggregateVersion: number;
        readonly expectedPublicationVersion: number;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ";
        readonly permission: "catalog.manage";
        readonly owningActions: readonly ["catalog.product.read", "catalog.product.history.read"];
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productPublicationValidationReportReadFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** One actual editor/history/report acquisition. No duplicate root/history SQL,
 * copied authority evidence, new qualification, or renewed historical report lease. */
export function createPostgresProductPublicationValidationReportSourceV2(
  options: ProductPublicationValidationReportSourceOptionsV2,
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    storeReference = parseCatalogReference(options.storeReference),
    actorReference = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.contentAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.reportAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    holdContent = options.contentAuthority.holdUntilTransactionCompletes.bind(
      options.contentAuthority,
    ),
    holdHistory = options.historyAuthority.holdUntilTransactionCompletes.bind(
      options.historyAuthority,
    ),
    holdReport = options.reportAuthority.holdUntilTransactionCompletes.bind(
      options.reportAuthority,
    ),
    beforeCommit = options.registerBeforeCommit.bind(options),
    categories =
      options.categoryAssignments === undefined
        ? undefined
        : Object.freeze({
            holdUntilTransactionCompletes:
              options.categoryAssignments.holdUntilTransactionCompletes.bind(
                options.categoryAssignments,
              ),
          }),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    context: Object.freeze({
      tenantReference,
      brandReference,
      storeReference,
      actorReference,
      actorKind: "User" as const,
    }),
    async withCurrentReport<T>(
      value: unknown,
      work: (
        view: CatalogProductPublicationValidationReportViewV1,
        tx: ProductLifecycleTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      // Capture caller primitives before a transaction runner can yield. Parse
      // failures are rejected inside the registered transaction poison boundary.
      let request:
        ReturnType<typeof parseCatalogProductPublicationValidationReportReadRequest> | undefined;
      try {
        request = parseCatalogProductPublicationValidationReportReadRequest(value);
      } catch {
        /* Rejected after acquiring the actual transaction below. */
      }
      let transaction: ProductLifecycleTransaction | undefined,
        calls = 0,
        poisoned = false,
        completed: { value: T } | undefined,
        finalCheck: (() => string) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        const result = await run(async (tx) => {
          if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return poison();
          transaction = tx;
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          const query = tx.query;
          let latest = "",
            deadline = "",
            ready = false,
            guardCalls = 0,
            editorCalls = 0,
            historyCalls = 0;
          let contentInput:
              | Parameters<EditorOptions["authority"]["holdUntilTransactionCompletes"]>[1]
              | undefined,
            historyInput:
              | Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[1]
              | undefined,
            reportInput:
              | Parameters<
                  ProductPublicationValidationReportSourceOptionsV2["reportAuthority"]["holdUntilTransactionCompletes"]
                >[1]
              | undefined;
          const check = (): string => {
            let at: string;
            try {
              at = parseCatalogInstant(now());
            } catch {
              return poison();
            }
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== query ||
              !deadline ||
              at < latest ||
              at >= deadline
            )
              return poison();
            latest = at;
            return at;
          };
          finalCheck = check;
          const hold = async () => {
            if (!reportInput) return poison();
            check();
            if ((await holdReport(tx, reportInput)) !== undefined) return poison();
            check();
          };
          try {
            if (
              (await beforeCommit(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1 || !ready || !contentInput || !historyInput)
                      return poison();
                    check();
                    await holdContent(tx, contentInput);
                    check();
                    await holdHistory(tx, historyInput);
                    check();
                    await hold();
                  } catch (error) {
                    poisoned = true;
                    failed.add(tx);
                    throw error;
                  }
                },
                () => {
                  if (!ready) return poison();
                  check();
                },
              )) !== undefined
            )
              return poison();
            latest = parseCatalogInstant(now());
            deadline = new Date(Date.parse(latest) + 5000).toISOString();
            check();
            if (!request || typeof work !== "function") return poison();
            const parsedRequest = request;
            reportInput = Object.freeze({
              tenantReference,
              brandReference,
              actorReference,
              actorKind: "User" as const,
              ...parsedRequest,
              purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ" as const,
              permission: "catalog.manage" as const,
              owningActions: Object.freeze([
                "catalog.product.read",
                "catalog.product.history.read",
              ] as const),
              requiredScope: "FullBrandScope" as const,
              requiredFields: productPublicationValidationReportReadFields,
              observedAt: latest,
            });
            await hold();
            const sourceRequest = Object.freeze({
              productReference: parsedRequest.productReference,
              expectedAggregateVersion: parsedRequest.expectedAggregateVersion,
            });
            const editorSource = createPostgresProductEditorSourceStore({
              tenantReference,
              brandReference,
              actorReference,
              clock: { now: check },
              transactions: { run: (callback) => callback(tx) },
              ...(categories === undefined ? {} : { categoryAssignments: categories }),
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  check();
                  if (
                    actual !== tx ||
                    input.tenantReference !== tenantReference ||
                    input.brandReference !== brandReference ||
                    input.actorReference !== actorReference ||
                    input.actorKind !== "User" ||
                    input.productReference !== parsedRequest.productReference
                  )
                    return poison();
                  contentInput = input;
                  await holdContent(tx, input);
                  check();
                },
              },
            });
            const historySource = createPostgresProductPublicationSourceStoreV2({
              tenantReference,
              brandReference,
              actorReference,
              actorKind: "User",
              clock: { now: check },
              transactions: { run: (callback) => callback(tx) },
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  check();
                  if (
                    actual !== tx ||
                    input.tenantReference !== tenantReference ||
                    input.brandReference !== brandReference ||
                    input.actorReference !== actorReference ||
                    input.actorKind !== "User" ||
                    input.productReference !== parsedRequest.productReference
                  )
                    return poison();
                  historyInput = input;
                  await holdHistory(tx, input);
                  check();
                },
              },
            });
            let answer: { value: T } | undefined;
            const acquired = await editorSource.withCurrentSnapshot(
              sourceRequest,
              async (editor, actual) => {
                check();
                if (++editorCalls !== 1 || actual !== tx) return poison();
                if (editor.validUntil < deadline) deadline = editor.validUntil;
                check();
                return historySource.withCurrentCoverage(
                  sourceRequest,
                  async (coverage, historyTx) => {
                    check();
                    if (++historyCalls !== 1 || historyTx !== tx) return poison();
                    const sourceDeadline = new Date(
                      Date.parse(coverage.observedAt) + 5000,
                    ).toISOString();
                    if (sourceDeadline < deadline) deadline = sourceDeadline;
                    check();
                    const selected = coverage.latest.find(
                      (p) => p.versionReference === parsedRequest.versionReference,
                    );
                    // Validate the locator before report SQL. The pure builder also
                    // verifies complete owner/root/current-draft/head consistency.
                    if (
                      selected
                        ? selected.publicationVersion !== parsedRequest.expectedPublicationVersion
                        : parsedRequest.expectedPublicationVersion !== 0 ||
                          parsedRequest.versionReference !== editor.aggregate.draft.versionReference
                    )
                      return poison();
                    const reportCoverage = selected
                      ? await recoverProductPublicationValidationReport(tx, selected)
                      : null;
                    check();
                    await hold();
                    const view = buildCatalogProductPublicationValidationReportView({
                      request: parsedRequest,
                      editor,
                      coverage,
                      reportCoverage,
                      context: { tenantReference, brandReference, storeReference },
                      observedAt: check(),
                      validUntil: deadline,
                    });
                    const delivered = await work(view, tx);
                    check();
                    await hold();
                    answer = { value: delivered };
                    return answer;
                  },
                );
              },
            );
            if (
              editorCalls !== 1 ||
              historyCalls !== 1 ||
              !answer ||
              acquired !== answer ||
              !contentInput ||
              !historyInput
            )
              return poison();
            check();
            ready = true;
            completed = answer;
            return completed;
          } catch (error) {
            poisoned = true;
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (
          !transaction ||
          poisoned ||
          calls !== 1 ||
          !completed ||
          result !== completed ||
          failed.has(transaction) ||
          !finalCheck
        )
          return poison();
        finalCheck();
        return completed.value;
      } catch (error) {
        if (transaction) failed.add(transaction);
        if (
          error instanceof CatalogError &&
          (error.code === "CATALOG_PERMISSION_DENIED" ||
            error.code === "CATALOG_DEPENDENCY_UNAVAILABLE")
        )
          throw error;
        return fail();
      }
    },
  });
}
