import {
  buildCatalogProductScopeJournal,
  parseCatalogProductScopeJournal,
  type CatalogProductScopeJournal,
} from "../../contracts/product-scope-journal.js";
import {
  holdProductEditorContent,
  type ProductEditorContentAuthority,
} from "../../application/product-editor-content-authority.js";
import { canonicalizeRfc8785, type AppendAuditRecordInput } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
  type ProductAggregate,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { buildCatalogProductApprovalReceipt } from "../../contracts/product-approval-receipt.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  planCatalogProductPublication,
  recoverCatalogProductPublication,
  type ProductPublicationCommand,
  type ProductPublicationVersion,
  type ProductPublicationFacts,
} from "../../contracts/product-publication.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterialization,
  parseCatalogProductPublicationContent,
  type CatalogProductPublicationContent,
} from "../../contracts/product-publication-content.js";
import { productDraftBaselineReferencedFields } from "../../contracts/product-draft-baseline.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import {
  holdProductSourceBarrier,
  appendProductPublicationCommitArtifacts,
} from "./product-source-producer.js";
export const productPublicationWriteFields = Object.freeze([
  ...productDraftBaselineReferencedFields,
  "publicationVersion",
  "publicationState",
  "scopeSet",
  "effectivePeriod",
  "validation",
  "policy",
  "review",
  "approval",
  "schedule",
  "publicationContent",
  "operationHistory",
  "scopeJournal",
] as const);
export interface ProductPublicationWriteResult {
  readonly status: "Applied" | "Replayed";
  readonly publication: ProductPublicationVersion;
  readonly aggregate: ProductAggregate;
  readonly content: CatalogProductPublicationContent | null;
  readonly scopeJournal: CatalogProductScopeJournal | null;
  readonly scopeJournalStatus: "Recorded" | "NotRecorded" | "NotApplicable";
}
export interface ProductPublicationStoreOptions {
  readonly editorContentAuthority?: ProductEditorContentAuthority;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommand;
        readonly requiredPermissions: readonly string[];
        readonly requiredFields: typeof productPublicationWriteFields;
        readonly requiredScope: "FullBrandScope";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly sources: {
    /** Must hold actual current Publishing policy evidence and its permissions
     * through outer COMMIT. Missing source refuses Publish/ActivateScheduled.
     * This port is not itself a policy producer. */
    withHeldScopePolicy?<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly publication: ProductPublicationVersion;
        readonly observedAt: string;
      },
      work: (policy: unknown) => Promise<T>,
    ): Promise<T>;

    withHeldCurrentFacts<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommand;
        readonly aggregate: ProductAggregate;
        readonly current: ProductPublicationVersion | null;
        readonly content: CatalogProductPublicationContent | null;
        readonly observedAt: string;
      },
      work: (facts: ProductPublicationFacts) => Promise<T>,
    ): Promise<T>;
  };
  readonly audit: {
    create(
      publication: ProductPublicationVersion,
      action: ProductPublicationCommand["action"],
    ): AppendAuditRecordInput;
  };
}
function fail(
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never {
  throw new CatalogError(code);
}
function permission(c: ProductPublicationCommand): readonly string[] {
  return Object.freeze([
    "catalog.product.read",
    c.action === "Validate"
      ? "catalog.product.validate"
      : c.action === "SubmitReview"
        ? "catalog.product.submit"
        : c.action === "Approve" || c.action === "Reject"
          ? "catalog.product.approve"
          : "catalog.product.publish",
  ]);
}
function count(result: { rowCount?: number | null }, expected = 1) {
  if (result.rowCount !== expected) return fail();
}
/** Configured server ports own current authority/policy/topology/approval facts.
 * Unconfigured normal runtime refuses; this factory does not create permissions. */
export function createPostgresProductPublicationStore(options: ProductPublicationStoreOptions) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.audit?.create !== "function"
  )
    return fail();
  const run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    sources = options.sources.withHeldCurrentFacts.bind(options.sources),
    audit = options.audit.create.bind(options.audit),
    now = options.clock.now.bind(options.clock);
  return Object.freeze({
    async execute(value: unknown): Promise<ProductPublicationWriteResult> {
      const c = parseProductPublicationCommand(value);
      if (
        c.tenantReference !== tenant ||
        c.brandReference !== brand ||
        c.actorReference !== actor ||
        c.actorKind !== kind
      )
        return fail("CATALOG_PERMISSION_DENIED");
      let invocations = 0,
        completed: ProductPublicationWriteResult | undefined;
      try {
        const result = await run(async (tx) => {
          if (++invocations !== 1) return fail();
          const authorize = () =>
            hold(
              tx,
              Object.freeze({
                command: c,
                requiredPermissions: permission(c),
                requiredFields: productPublicationWriteFields,
                requiredScope: "FullBrandScope",
                observedAt: parseCatalogInstant(now()),
              }),
            );
          await authorize();
          const isolation = await tx.query<{ isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation",
            [],
          );
          if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== "read committed")
            return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          await holdProductSourceBarrier(tx, brand);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogProductOperation:" + brand + ":" + c.operationReference,
          ]);
          // Any existing operation must be this exact publication intent; never infer a
          // historical result from today's Draft or treat a legacy operation as absent.
          const old = await tx.query<{
            action_code: string;
            publication: unknown;
            aggregate: unknown;
            content: unknown;
            journal: unknown;
          }>(
            "SELECT o.action_code,r.snapshot_json publication,s.snapshot_json aggregate,CASE WHEN r.state IN ('Published','Superseded') THEN f.snapshot_json ELSE NULL END content,j.snapshot_json journal FROM rms_catalog.product_operation_record o LEFT JOIN rms_catalog.product_scope_journal j ON j.operation_id=o.operation_id AND j.tenant_id=$1 LEFT JOIN rms_catalog.product_publication_revision r ON r.operation_id=o.operation_id AND r.tenant_id=$1 LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=o.operation_id LEFT JOIN rms_catalog.product_publication_content f ON f.product_version_id=r.product_version_id AND f.tenant_id=$1 WHERE o.brand_id=$2 AND o.operation_id=$3",
            [tenant, brand, c.operationReference],
          );
          if (old.rows.length > 0) {
            const row = old.rows[0];
            if (
              old.rows.length !== 1 ||
              !row ||
              row.action_code !== "ProductPublication" ||
              row.publication === null
            )
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            const p = recoverCatalogProductPublication(c, row.publication),
              root = parseProductAggregate(copyCategoryPersistenceValue(row.aggregate)),
              content =
                row.content === null ? null : parseCatalogProductPublicationContent(row.content);
            if (
              root.brandReference !== brand ||
              root.productReference !== c.productReference ||
              root.aggregateVersion !== p.productAggregateVersion + 1 ||
              root.updatedAt !== p.occurredAt ||
              ((p.state === "Published" || p.state === "Superseded") &&
                (!content ||
                  content.versionReference !== p.versionReference ||
                  content.contentDigest !== p.contentDigest ||
                  content.configurationDigest !== p.configurationDigest))
            )
              return fail();
            const scopeJournal =
              row.journal === null ? null : parseCatalogProductScopeJournal(row.journal);
            if (
              scopeJournal &&
              canonicalizeRfc8785(scopeJournal.incoming) !== canonicalizeRfc8785(p)
            )
              return fail();
            await holdProductEditorContent(tx, options.editorContentAuthority, root, "Read");
            await authorize();
            completed = Object.freeze({
              status: "Replayed",
              publication: p,
              aggregate: root,
              content,
              scopeJournal,
              scopeJournalStatus: scopeJournal
                ? "Recorded"
                : c.action === "Publish" || c.action === "ActivateScheduled"
                  ? "NotRecorded"
                  : "NotApplicable",
            });
            return completed;
          }
          const locked = await tx.query(
            "SELECT product_id FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2 FOR UPDATE",
            [brand, c.productReference],
          );
          if (locked.rows.length !== 1) return fail("CATALOG_UNAVAILABLE");
          const loaded = await tx.query<{ snapshot: unknown; precise: boolean }>(
            productSnapshotSelectSql,
            [brand, c.productReference],
          );
          if (loaded.rows.length !== 1 || loaded.rows[0]?.precise !== true) return fail();
          const root = parseProductAggregate(copyCategoryPersistenceValue(loaded.rows[0].snapshot));
          await holdProductEditorContent(tx, options.editorContentAuthority, root, "Read");
          if (root.aggregateVersion !== c.expectedProductAggregateVersion)
            return fail("CATALOG_VERSION_CONFLICT");
          if (c.occurredAt < root.updatedAt) return fail("CATALOG_LIFECYCLE_CONFLICT");
          const rows = await tx.query<{ snapshot_json: unknown }>(
            "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 ORDER BY publication_version DESC LIMIT 1",
            [tenant, brand, c.productReference, c.versionReference],
          );
          if (rows.rows.length > 1) return fail();
          const current = rows.rows[0]
            ? parseProductPublicationVersion(rows.rows[0].snapshot_json)
            : null;
          let content: CatalogProductPublicationContent | null = null;
          if (c.action === "Supersede") {
            const frozen = await tx.query<{ snapshot_json: unknown }>(
              "SELECT snapshot_json FROM rms_catalog.product_publication_content WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4",
              [tenant, brand, c.productReference, c.versionReference],
            );
            if (frozen.rows.length !== 1) return fail();
            content = parseCatalogProductPublicationContent(frozen.rows[0]?.snapshot_json);
            if (
              c.contentDigest !== content.contentDigest ||
              c.configurationDigest !== content.configurationDigest
            )
              return fail("CATALOG_LIFECYCLE_CONFLICT");
          } else {
            const identity = deriveCatalogProductPublicationContentIdentity(root);
            if (
              root.draft.versionReference !== c.versionReference ||
              identity.contentDigest !== c.contentDigest ||
              identity.configurationDigest !== c.configurationDigest
            )
              return fail("CATALOG_LIFECYCLE_CONFLICT");
          }
          let sourceCalls = 0,
            sourceResult: ProductPublicationWriteResult | undefined;
          await tx.query("SAVEPOINT catalog_product_publication", []);
          try {
            await holdProductEditorContent(
              tx,
              options.editorContentAuthority,
              root,
              c.action === "Supersede" ? "Read" : "Publish",
            );
            const observedAt = parseCatalogInstant(now());
            const held = await sources(
              tx,
              Object.freeze({ command: c, aggregate: root, current, content, observedAt }),
              async (factsValue) => {
                if (++sourceCalls !== 1) return fail();
                const f = copyCategoryPersistenceValue(factsValue) as ProductPublicationFacts;
                if (f.now !== observedAt) return fail();
                const p = planCatalogProductPublication(c, current, f);
                const apply = async (scopeJournal: CatalogProductScopeJournal | null) => {
                  let next: ProductAggregate;
                  if (p.state === "Published") {
                    const materialized = createCatalogProductPublicationMaterialization(root, p);
                    next = materialized.successor;
                    content = materialized.content;
                  } else
                    next = parseProductAggregate({
                      ...root,
                      aggregateVersion: root.aggregateVersion + 1,
                      updatedAt: p.occurredAt,
                    });
                  const changed = await tx.query(
                    "UPDATE rms_catalog.product SET aggregate_version=$4,updated_at=$5 WHERE brand_id=$1 AND product_id=$2 AND aggregate_version=$3",
                    [
                      brand,
                      c.productReference,
                      c.expectedProductAggregateVersion,
                      next.aggregateVersion,
                      next.updatedAt,
                    ],
                  );
                  count(changed);
                  count(
                    await tx.query(
                      "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'ProductPublication',$4,$5,$6)",
                      [
                        c.operationReference,
                        brand,
                        c.productReference,
                        p.intentDigest,
                        next.aggregateVersion,
                        p.occurredAt,
                      ],
                    ),
                  );
                  if (p.state === "Published") {
                    count(
                      await tx.query(
                        "UPDATE rms_catalog.product_version SET status='Frozen' WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3 AND status='Draft'",
                        [brand, c.productReference, c.versionReference],
                      ),
                    );
                    const d = next.draft;
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,base_product_version_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at,category_classification_known,primary_category_id,editor_content_json) VALUES($1,$2,$3,$4,'Draft',$5,$6,$7,$8,$8,$9,$10,$11)",
                        [
                          d.versionReference,
                          c.productReference,
                          brand,
                          c.versionReference,
                          d.defaultLocale,
                          d.localizedNames,
                          d.taxClassificationReference,
                          p.occurredAt,
                          d.categoryClassification !== undefined,
                          d.categoryClassification?.primaryCategoryReference ?? null,
                          d.editorContent === undefined ? null : JSON.stringify(d.editorContent),
                        ],
                      ),
                    );
                    for (const category of d.categoryClassification?.categoryReferences ?? [])
                      count(
                        await tx.query(
                          "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
                          [d.versionReference, c.productReference, brand, category],
                        ),
                      );
                  }
                  count(
                    await tx.query(
                      "INSERT INTO rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,action_code,state,intent_digest,content_digest,configuration_digest,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
                      [
                        c.operationReference,
                        tenant,
                        brand,
                        c.productReference,
                        c.versionReference,
                        p.publicationVersion,
                        p.productAggregateVersion,
                        next.aggregateVersion,
                        c.action,
                        p.state,
                        p.intentDigest,
                        p.contentDigest,
                        p.configurationDigest,
                        p.occurredAt,
                        p,
                      ],
                    ),
                  );
                  if (c.action === "Approve") {
                    const receipt = buildCatalogProductApprovalReceipt(p, f.approval);
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_approval_receipt(operation_id,approval_id,tenant_id,brand_id,product_id,product_version_id,publication_version,result_aggregate_version,receipt_digest,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)",
                        [
                          c.operationReference,
                          receipt.approval.evidenceReference,
                          tenant,
                          brand,
                          c.productReference,
                          c.versionReference,
                          p.publicationVersion,
                          next.aggregateVersion,
                          receipt.digest,
                          JSON.stringify(receipt),
                          p.occurredAt,
                        ],
                      ),
                    );
                  }
                  if (scopeJournal)
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_scope_journal(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,source_revision,intent_digest,journal_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                        [
                          c.operationReference,
                          tenant,
                          brand,
                          c.productReference,
                          p.productAggregateVersion,
                          scopeJournal.sourceRevision,
                          p.intentDigest,
                          scopeJournal.digest,
                          scopeJournal,
                        ],
                      ),
                    );
                  if (p.state === "Published") {
                    if (!content) return fail();
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_publication_content(product_version_id,tenant_id,brand_id,product_id,publication_operation_id,source_aggregate_version,content_digest,configuration_digest,sealed_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                        [
                          c.versionReference,
                          tenant,
                          brand,
                          c.productReference,
                          c.operationReference,
                          p.productAggregateVersion,
                          p.contentDigest,
                          p.configurationDigest,
                          p.occurredAt,
                          content,
                        ],
                      ),
                    );
                    for (const sku of root.draft.skus)
                      count(
                        await tx.query(
                          "UPDATE rms_catalog.sku SET product_version_id=$4 WHERE brand_id=$1 AND product_id=$2 AND sku_id=$3 AND product_version_id=$5",
                          [
                            brand,
                            c.productReference,
                            sku.skuReference,
                            next.draft.versionReference,
                            c.versionReference,
                          ],
                        ),
                      );
                    for (const binding of root.draft.optionBindings)
                      count(
                        await tx.query(
                          "UPDATE rms_catalog.product_option_binding SET product_version_id=$4 WHERE brand_id=$1 AND product_id=$2 AND binding_id=$3 AND product_version_id=$5",
                          [
                            brand,
                            c.productReference,
                            binding.bindingReference,
                            next.draft.versionReference,
                            c.versionReference,
                          ],
                        ),
                      );
                  }
                  count(
                    await tx.query(
                      "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
                      [
                        c.operationReference,
                        brand,
                        c.productReference,
                        next.aggregateVersion,
                        p.occurredAt,
                        next,
                      ],
                    ),
                  );
                  await appendProductPublicationCommitArtifacts(
                    tx,
                    p,
                    next,
                    c.action,
                    audit(p, c.action),
                  );
                  await holdProductEditorContent(tx, options.editorContentAuthority, next, "Read");
                  await authorize();
                  const readback = await tx.query<{ snapshot: unknown; precise: boolean }>(
                    productSnapshotSelectSql,
                    [brand, c.productReference],
                  );
                  if (
                    readback.rows.length !== 1 ||
                    readback.rows[0]?.precise !== true ||
                    canonicalizeRfc8785(
                      parseProductAggregate(
                        copyCategoryPersistenceValue(readback.rows[0].snapshot),
                      ),
                    ) !== canonicalizeRfc8785(next)
                  )
                    return fail();
                  sourceResult = Object.freeze({
                    status: "Applied",
                    publication: p,
                    aggregate: next,
                    content,
                    scopeJournal,
                    scopeJournalStatus: scopeJournal ? "Recorded" : "NotApplicable",
                  });
                  return sourceResult;
                };
                if (p.state !== "Published") return apply(null);
                const policySource = options.sources.withHeldScopePolicy;
                if (typeof policySource !== "function") return fail();
                let calls = 0,
                  outcome: ProductPublicationWriteResult | undefined;
                const policyResult = await policySource.call(
                  options.sources,
                  tx,
                  { publication: p, observedAt },
                  async (policyValue) => {
                    if (++calls !== 1) return fail();
                    const policy = copyCategoryPersistenceValue(policyValue);
                    if (!policy || typeof policy !== "object" || Array.isArray(policy))
                      return fail();
                    const q = policy as Record<string, unknown>;
                    const keys = [
                      "policyReference",
                      "policyVersion",
                      "policyEvidenceReference",
                      "scopeOrder",
                      "observedAt",
                      "validUntil",
                    ];
                    if (
                      Object.keys(q).length !== keys.length ||
                      keys.some((k) => !Object.hasOwn(q, k)) ||
                      q.policyReference !== p.policyReference ||
                      q.policyVersion !== p.policyVersion ||
                      q.observedAt !== observedAt
                    )
                      return fail();
                    const head = await tx.query<{ source_revision: string }>(
                      "SELECT source_revision::text FROM rms_catalog.product_source_head WHERE brand_id=$1",
                      [brand],
                    );
                    if (head.rows.length !== 1) return fail();
                    const budget = await tx.query<{ count: number; bytes: string }>(
                      "SELECT count(*)::int count,coalesce(sum(octet_length(snapshot_json::text)),0)::text bytes FROM (SELECT DISTINCT ON (product_version_id) snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY product_version_id,publication_version DESC) h",
                      [tenant, brand, c.productReference],
                    );
                    const limits = budget.rows[0];
                    if (
                      budget.rows.length !== 1 ||
                      !limits ||
                      limits.count > 1000 ||
                      BigInt(limits.bytes) > 1_048_576n
                    )
                      return fail();
                    const heads = await tx.query<{ snapshot_json: unknown; coherent: boolean }>(
                      "SELECT h.snapshot_json,(o.intent_digest=h.intent_digest AND o.result_aggregate_version=h.result_aggregate_version AND o.product_id=h.product_id AND o.action_code='ProductPublication' AND sc.operation_id IS NOT NULL AND sc.result_aggregate_version=h.result_aggregate_version AND sc.product_id=h.product_id AND sc.occurred_at=h.occurred_at AND sc.source_revision <= $4::bigint) coherent FROM (SELECT DISTINCT ON (product_version_id) * FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY product_version_id,publication_version DESC) h LEFT JOIN rms_catalog.product_operation_record o ON o.operation_id=h.operation_id AND o.brand_id=h.brand_id LEFT JOIN rms_catalog.product_source_commit sc ON sc.operation_id=h.operation_id AND sc.brand_id=h.brand_id ORDER BY h.product_version_id LIMIT 1001",
                      [tenant, brand, c.productReference, head.rows[0]?.source_revision],
                    );
                    if (
                      heads.rows.length !== limits.count ||
                      heads.rows.some((h) => h.coherent !== true)
                    )
                      return fail();
                    const journal = buildCatalogProductScopeJournal({
                      incoming: p,
                      latest: heads.rows.map((h) => h.snapshot_json),
                      sourceAggregateVersion: p.productAggregateVersion,
                      sourceRevision: head.rows[0]?.source_revision,
                      scopeOrder: q.scopeOrder,
                      policyEvidenceReference: q.policyEvidenceReference,
                      observedAt,
                      validUntil: q.validUntil,
                    });
                    outcome = await apply(journal);
                    if (parseCatalogInstant(now()) >= journal.validUntil) return fail();
                    return outcome;
                  },
                );
                if (calls !== 1 || !outcome || policyResult !== outcome) return fail();
                return outcome;
              },
            );
            if (sourceCalls !== 1 || !sourceResult || held !== sourceResult) return fail();
            await authorize();
            await tx.query("RELEASE SAVEPOINT catalog_product_publication", []);
            completed = sourceResult;
            return completed;
          } catch (error) {
            await tx.query("ROLLBACK TO SAVEPOINT catalog_product_publication", []);
            await tx.query("RELEASE SAVEPOINT catalog_product_publication", []);
            throw error;
          }
        });
        if (invocations !== 1 || !completed || result !== completed) return fail();
        return completed;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
