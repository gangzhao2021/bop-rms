import { assertProductPublicationOperationNotAbandoned } from "./product-publication-resolution-store.js";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  type ProductAggregate,
} from "../../contracts/product.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationVersionV2,
} from "../../contracts/product-publication-v2.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationWarningAcknowledgementObservation,
  buildCatalogProductPublicationWarningAcknowledgementReceipt,
  type CatalogProductPublicationWarningAcknowledgementCommand,
  type CatalogProductPublicationWarningAcknowledgementReceipt,
} from "../../contracts/product-publication-warning-acknowledgement.js";
import { buildCatalogProductPublicationWarningAcknowledgementEvent } from "../../contracts/product-publication-warning-acknowledgement-event.js";
import type { CatalogProductPublicationValidationReport } from "../../contracts/product-publication-validation-report.js";
import { productPublicationValidationReportReadFields } from "../../contracts/product-publication-validation-report-query-v2.js";
import { createPostgresProductEditorSourceStore } from "./product-editor-source-store.js";
import { createPostgresProductPublicationSourceStoreV2 } from "./product-publication-source-store.js";
import { recoverProductPublicationValidationReport } from "./product-publication-validation-report-store.js";
import {
  recoverProductPublicationWarningAcknowledgement,
  appendProductPublicationWarningAcknowledgement,
} from "./product-publication-warning-acknowledgement-record.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import type { ProductPublicationValidationReportSourceOptionsV2 } from "./product-publication-validation-report-source-store.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

type EditorOptions = Parameters<typeof createPostgresProductEditorSourceStore>[0];
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
export const productPublicationWarningAcknowledgementFields = Object.freeze([
  "productReference",
  "versionReference",
  "aggregateVersion",
  "publicationHistory",
  "validationReport",
  "validationReportDetails",
  "warningAcknowledgement",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "replacementIntentDigest",
  "policyReference",
  "policyVersion",
  "referenceFindings",
  "actorReference",
  "reasonCode",
] as const);
const permissions = Object.freeze([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.acknowledge-warnings",
  "catalog.product.read",
  "catalog.product.history.read",
] as const);
export interface ProductPublicationWarningAcknowledgementStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    asyncGuard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly contentAuthority: EditorOptions["authority"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly categoryAssignments?: EditorOptions["categoryAssignments"];
  readonly reportAuthority: ProductPublicationValidationReportSourceOptionsV2["reportAuthority"];
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: CatalogProductPublicationWarningAcknowledgementCommand;
        readonly mode: "Acknowledge" | "Replay";
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT";
        readonly permission: "catalog.manage";
        readonly requiredPermissions: typeof permissions;
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productPublicationWarningAcknowledgementFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly sources: {
    withHeldCurrentObservation<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: CatalogProductPublicationWarningAcknowledgementCommand;
        readonly aggregate: ProductAggregate;
        readonly current: ProductPublicationVersionV2;
        readonly report: CatalogProductPublicationValidationReport;
        readonly observedAt: string;
        readonly validUntil: string;
      },
      work: (observation: unknown) => Promise<T>,
    ): Promise<T>;
  };
  readonly audit: {
    create(receipt: CatalogProductPublicationWarningAcknowledgementReceipt): AppendAuditRecordInput;
  };
}
export interface ProductPublicationWarningAcknowledgementWriteResult {
  readonly status: "Applied" | "Replayed";
  readonly receipt: CatalogProductPublicationWarningAcknowledgementReceipt;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** An acknowledgement owns an immutable receipt, not a Product publication
 * transition. Product root/content/history bytes never change in this writer. */
export function createPostgresProductPublicationWarningAcknowledgementStore(
  options: ProductPublicationWarningAcknowledgementStoreOptions,
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.contentAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.historyAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.reportAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.sources?.withHeldCurrentObservation !== "function" ||
    typeof options.audit?.create !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    register = options.registerBeforeCommit.bind(options),
    authorize = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    holdContent = options.contentAuthority.holdUntilTransactionCompletes.bind(
      options.contentAuthority,
    ),
    holdHistory = options.historyAuthority.holdUntilTransactionCompletes.bind(
      options.historyAuthority,
    ),
    holdReport = options.reportAuthority.holdUntilTransactionCompletes.bind(
      options.reportAuthority,
    ),
    observe = options.sources.withHeldCurrentObservation.bind(options.sources),
    audit = options.audit.create.bind(options.audit),
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
      actorReference,
      actorKind: "User" as const,
    }),
    async execute(value: unknown): Promise<ProductPublicationWarningAcknowledgementWriteResult> {
      let command: CatalogProductPublicationWarningAcknowledgementCommand | undefined;
      try {
        command = parseCatalogProductPublicationWarningAcknowledgementCommand(value);
      } catch {
        /* Poison the actual borrowed transaction before rejecting. */
      }
      let transaction: ProductLifecycleTransaction | undefined,
        calls = 0,
        poisoned = false,
        completed: ProductPublicationWarningAcknowledgementWriteResult | undefined,
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
          const originalQuery = tx.query,
            capturedQuery = originalQuery.bind(tx);
          let observedAt = "",
            latest = "",
            deadline = "",
            ready = false,
            guardCalls = 0,
            mode: "Acknowledge" | "Replay" = "Acknowledge";
          let contentInput:
              | Parameters<EditorOptions["authority"]["holdUntilTransactionCompletes"]>[1]
              | undefined,
            historyInput:
              | Parameters<HistoryOptions["authority"]["holdUntilTransactionCompletes"]>[1]
              | undefined,
            reportInput:
              | Parameters<
                  ProductPublicationWarningAcknowledgementStoreOptions["reportAuthority"]["holdUntilTransactionCompletes"]
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
              tx.query !== originalQuery ||
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
            if (!command) return poison();
            check();
            if (
              (await authorize(
                tx,
                Object.freeze({
                  command,
                  mode,
                  purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT" as const,
                  permission: "catalog.manage" as const,
                  requiredPermissions: permissions,
                  requiredScope: "FullBrandScope" as const,
                  requiredFields: productPublicationWarningAcknowledgementFields,
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          const query: ProductLifecycleTransaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            const r = await capturedQuery<Row>(sql, values);
            check();
            return r;
          };
          try {
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1 || !ready) return poison();
                    await hold();
                    if (mode === "Acknowledge") {
                      if (!contentInput || !historyInput || !reportInput) return poison();
                      check();
                      if ((await holdContent(tx, contentInput)) !== undefined) return poison();
                      check();
                      if ((await holdHistory(tx, historyInput)) !== undefined) return poison();
                      check();
                      if ((await holdReport(tx, reportInput)) !== undefined) return poison();
                      check();
                    }
                    await hold();
                  } catch (error) {
                    poisoned = true;
                    failed.add(tx);
                    throw error;
                  }
                },
                () => {
                  if (!ready || guardCalls !== 1) return poison();
                  check();
                },
              )) !== undefined
            )
              return poison();
            observedAt = latest = parseCatalogInstant(now());
            deadline = new Date(Date.parse(observedAt) + 5000).toISOString();
            check();
            if (!command) return poison();
            const c = command;
            if (
              c.tenantReference !== tenantReference ||
              c.brandReference !== brandReference ||
              c.actorReference !== actorReference
            )
              return fail("CATALOG_PERMISSION_DENIED");
            await hold();
            await requireCategoryCurrentReads(tx);
            check();
            await query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
              [tenantReference, brandReference],
            );
            await holdProductSourceBarrier({ query }, brandReference);
            check();
            await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "CatalogProductWarningAcknowledgement:" + brandReference + ":" + c.operationReference,
            ]);
            const original = await recoverProductPublicationWarningAcknowledgement(tx, c);
            check();
            if (original !== null) {
              mode = "Replay";
              await hold();
              ready = true;
              completed = Object.freeze({ status: "Replayed" as const, receipt: original });
              return completed;
            }
            await assertProductPublicationOperationNotAbandoned(
              { query },
              "CatalogProductWarningAcknowledgement",
              brandReference,
              c.operationReference,
            );
            check();
            if (c.occurredAt > check()) return fail("CATALOG_INPUT_INVALID");
            const sourceRequest = Object.freeze({
              productReference: c.productReference,
              expectedAggregateVersion: c.expectedProductAggregateVersion,
            });
            const editor = createPostgresProductEditorSourceStore({
              tenantReference,
              brandReference,
              actorReference,
              clock: { now: check },
              transactions: { run: (work) => work(tx) },
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
                    input.productReference !== c.productReference
                  )
                    return poison();
                  contentInput = input;
                  if ((await holdContent(tx, input)) !== undefined) return poison();
                  check();
                },
              },
            });
            const history = createPostgresProductPublicationSourceStoreV2({
              tenantReference,
              brandReference,
              actorReference,
              actorKind: "User",
              clock: { now: check },
              transactions: { run: (work) => work(tx) },
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  check();
                  if (
                    actual !== tx ||
                    input.tenantReference !== tenantReference ||
                    input.brandReference !== brandReference ||
                    input.actorReference !== actorReference ||
                    input.actorKind !== "User" ||
                    input.productReference !== c.productReference
                  )
                    return poison();
                  historyInput = input;
                  if ((await holdHistory(tx, input)) !== undefined) return poison();
                  check();
                },
              },
            });
            let editorCalls = 0,
              historyCalls = 0,
              sourceCalls = 0,
              written: ProductPublicationWarningAcknowledgementWriteResult | undefined;
            const delivered = await editor.withCurrentSnapshot(
              sourceRequest,
              async (snapshot, editorTx) => {
                check();
                if (
                  ++editorCalls !== 1 ||
                  editorTx !== tx ||
                  snapshot.tenantReference !== tenantReference ||
                  snapshot.brandReference !== brandReference ||
                  snapshot.productReference !== c.productReference ||
                  snapshot.aggregateVersion !== c.expectedProductAggregateVersion ||
                  snapshot.aggregate.draft.versionReference !== c.versionReference ||
                  snapshot.contentStatus !== "Present"
                )
                  return poison();
                deadline = [deadline, snapshot.validUntil].sort()[0] ?? poison();
                check();
                return history.withCurrentCoverage(sourceRequest, async (coverage, historyTx) => {
                  check();
                  if (
                    ++historyCalls !== 1 ||
                    historyTx !== tx ||
                    coverage.tenantReference !== tenantReference ||
                    coverage.brandReference !== brandReference ||
                    coverage.productReference !== c.productReference ||
                    coverage.aggregateVersion !== c.expectedProductAggregateVersion
                  )
                    return poison();
                  deadline =
                    [
                      deadline,
                      new Date(Date.parse(coverage.observedAt) + 5000).toISOString(),
                    ].sort()[0] ?? poison();
                  check();
                  const currentValue = coverage.latest.find(
                      (p) => p.versionReference === c.versionReference,
                    ),
                    reportVersion = coverage.history.find(
                      (e) => e.publication.operationReference === c.reportOperationReference,
                    )?.publication;
                  if (!currentValue || !reportVersion) return poison();
                  const current = parseProductPublicationVersionV2(currentValue);
                  if (
                    current.contentDigest !== snapshot.contentDigest ||
                    current.configurationDigest !== snapshot.configurationDigest ||
                    current.occurredAt > check()
                  )
                    return poison();
                  reportInput = Object.freeze({
                    tenantReference,
                    brandReference,
                    actorReference,
                    actorKind: "User" as const,
                    productReference: c.productReference,
                    versionReference: c.versionReference,
                    expectedAggregateVersion: c.expectedProductAggregateVersion,
                    expectedPublicationVersion: reportVersion.publicationVersion,
                    purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ" as const,
                    permission: "catalog.manage" as const,
                    owningActions: Object.freeze([
                      "catalog.product.read",
                      "catalog.product.history.read",
                    ] as const),
                    requiredScope: "FullBrandScope" as const,
                    requiredFields: productPublicationValidationReportReadFields,
                    observedAt,
                  });
                  if ((await holdReport(tx, reportInput)) !== undefined) return poison();
                  check();
                  const recovered = await recoverProductPublicationValidationReport(
                    tx,
                    reportVersion,
                  );
                  check();
                  if (recovered.status !== "Recorded" || recovered.report.digest !== c.reportDigest)
                    return poison();
                  const report = recovered.report,
                    sourceObservedAt = check();
                  const sourceResult = await observe(
                    tx,
                    Object.freeze({
                      command: c,
                      aggregate: snapshot.aggregate,
                      current,
                      report,
                      observedAt: sourceObservedAt,
                      validUntil: deadline,
                    }),
                    async (value) => {
                      check();
                      if (++sourceCalls !== 1) return poison();
                      const observation =
                          parseCatalogProductPublicationWarningAcknowledgementObservation(value),
                        b = observation.binding;
                      // Fresh policy must agree with the actual latest workflow head
                      // and the displayed report; changing policy requires validation
                      // under that policy before a new human confirmation can bind it.
                      if (
                        observation.observedAt < sourceObservedAt ||
                        observation.observedAt > check() ||
                        observation.validUntil > deadline ||
                        b.tenantReference !== tenantReference ||
                        b.brandReference !== brandReference ||
                        b.productReference !== c.productReference ||
                        b.versionReference !== c.versionReference ||
                        b.contentDigest !== snapshot.contentDigest ||
                        b.configurationDigest !== snapshot.configurationDigest ||
                        b.scopeDigest !== current.scopeDigest ||
                        b.periodDigest !== current.periodDigest ||
                        b.replacementIntentDigest !== current.replacementIntentDigest ||
                        b.policyReference !== current.policyReference ||
                        b.policyVersion !== current.policyVersion ||
                        observation.acknowledgementIntentDigest !== hash(c)
                      )
                        return poison();
                      deadline = [deadline, observation.validUntil].sort()[0] ?? poison();
                      check();
                      const receipt = buildCatalogProductPublicationWarningAcknowledgementReceipt({
                        command: c,
                        report,
                        observation,
                        recordedAt: check(),
                      });
                      const artifacts = buildCatalogProductPublicationWarningAcknowledgementEvent(
                        receipt,
                        audit(receipt),
                      );
                      check();
                      await hold();
                      // Current authority may hold a Store capability on this same
                      // transaction. Restore the owning Brand scope after that hold,
                      // before the acknowledgement's operation-fence/write boundary.
                      await query(
                        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
                        [tenantReference, brandReference],
                      );
                      await query("SAVEPOINT catalog_product_warning_acknowledgement", []);
                      try {
                        await appendProductPublicationWarningAcknowledgement(tx, {
                          receipt,
                          eventId: artifacts.envelope.eventId,
                          auditId: artifacts.audit.auditId,
                        });
                        check();
                        await appendAuditRecordInTransaction({ query }, artifacts.audit);
                        check();
                        await appendEventInTransaction(
                          {
                            query: async (sql, values) => {
                              const r = await query(sql, values);
                              if (r.rowCount !== 1) return poison();
                              return { rowCount: 1 };
                            },
                          },
                          artifacts.envelope,
                        );
                        check();
                        await hold();
                        if ((await holdReport(tx, reportInput ?? poison())) !== undefined)
                          return poison();
                        check();
                      } catch (error) {
                        // Lease failure must still permit only savepoint cleanup;
                        // captured raw query cannot be used for another business read.
                        await capturedQuery(
                          "ROLLBACK TO SAVEPOINT catalog_product_warning_acknowledgement",
                          [],
                        );
                        await capturedQuery(
                          "RELEASE SAVEPOINT catalog_product_warning_acknowledgement",
                          [],
                        );
                        throw error;
                      }
                      await query("RELEASE SAVEPOINT catalog_product_warning_acknowledgement", []);
                      written = Object.freeze({ status: "Applied" as const, receipt });
                      return written;
                    },
                  );
                  check();
                  if (sourceCalls !== 1 || !written || sourceResult !== written) return poison();
                  return written;
                });
              },
            );
            check();
            if (
              editorCalls !== 1 ||
              historyCalls !== 1 ||
              sourceCalls !== 1 ||
              !written ||
              delivered !== written ||
              !contentInput ||
              !historyInput ||
              !reportInput
            )
              return poison();
            await hold();
            ready = true;
            completed = written;
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
        return completed;
      } catch (error) {
        if (transaction) failed.add(transaction);
        if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID") throw error;
        return fail();
      }
    },
  });
}
