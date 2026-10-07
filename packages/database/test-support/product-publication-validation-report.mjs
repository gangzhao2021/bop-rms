import assert from "node:assert/strict";
import { createPostgresProductPublicationWarningAcknowledgementStore } from "../../rms/catalog/src/infrastructure/persistence/product-publication-warning-acknowledgement-store.ts";
import { readLatestProductPublicationWarningAcknowledgement } from "../../rms/catalog/src/infrastructure/persistence/product-publication-warning-acknowledgement-record.ts";
import {
  buildCatalogProductPublicationWarningAcknowledgementObservation,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
} from "../../rms/catalog/src/contracts/product-publication-warning-acknowledgement.ts";
import { TextEncoder } from "node:util";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { CatalogError, parseProductAggregate } from "../../rms/catalog/src/contracts/product.ts";
import { deriveCatalogProductPublicationContentIdentity } from "../../rms/catalog/src/contracts/product-publication-content.ts";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
} from "../../rms/catalog/src/contracts/product-publication-v2.ts";
import {
  productPublicationCheckCodes,
  productPublicationScopeLevels,
} from "../../rms/catalog/src/contracts/product-publication.ts";
import { catalogProductPublicationAuditAction } from "../../rms/catalog/src/contracts/product-publication-event.ts";
import {
  calculateCatalogProductPublicationWarningBindingDigest,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationValidationReport,
} from "../../rms/catalog/src/contracts/product-publication-validation-report.ts";
import { createPostgresProductCreationStore } from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import { createPostgresProductPublicationStoreV2 } from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import { createPostgresProductPublicationValidationReportSourceV2 } from "../../rms/catalog/src/infrastructure/persistence/product-publication-validation-report-source-store.ts";
import { recoverProductPublicationValidationReport } from "../../rms/catalog/src/infrastructure/persistence/product-publication-validation-report-store.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => "01902463-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const countsSql = `SELECT
 (SELECT count(*)::int FROM rms_catalog.product) products,
 (SELECT count(*)::int FROM rms_catalog.product_version) versions,
 (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
 (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
 (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
 (SELECT count(*)::int FROM rms_catalog.product_publication_revision) revisions,
 (SELECT count(*)::int FROM rms_catalog.product_publication_validation_report) reports,
 (SELECT count(*)::int FROM rms_catalog.product_publication_warning_acknowledgement) acknowledgements,
 (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header) headers,
 (SELECT count(*)::int FROM rms_catalog.product_approval_receipt) approvals,
 (SELECT count(*)::int FROM platform_audit.audit_record) audit,
 (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('product',p.product_id,'version',p.aggregate_version,'updated',p.updated_at) ORDER BY p.product_id),'[]'::jsonb) FROM rms_catalog.product p) roots,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Pure synthetic warning-report values only: this verifies PostgreSQL's JSON
 * serialization budget, not an owning publication or current validation source.
 * No candidate produced here is inserted into any business table. */
export async function exerciseProductPublicationValidationReportBudget(client) {
  const limit = 1048576,
    at = "2026-10-03T12:00:00.000Z",
    until = "2026-10-03T12:00:05.000Z",
    binding = {
      tenantReference: id(9001),
      brandReference: id(9002),
      productReference: id(9005),
      versionReference: id(9006),
      contentDigest: hash("synthetic budget content"),
      configurationDigest: hash("synthetic budget configuration"),
      scopeDigest: hash("synthetic budget scope"),
      periodDigest: hash("synthetic budget period"),
      replacementIntentDigest: hash("synthetic budget replacement"),
      policyReference: id(9008),
      policyVersion: 1,
    },
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: binding.replacementIntentDigest,
      evidenceReference: id(9007),
      productAggregateVersion: 1,
      contentDigest: binding.contentDigest,
      configurationDigest: binding.configurationDigest,
      scopeDigest: binding.scopeDigest,
      periodDigest: binding.periodDigest,
      policyReference: binding.policyReference,
      policyVersion: binding.policyVersion,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    }),
    findings = Array.from({ length: 1000 }, (_, i) => ({
      checkCode: "ChangeImpact",
      ruleCode: "R".repeat(64),
      outcome: "Warning",
      subjectReference: id(10000 + i),
      reasonCode: "W".repeat(64),
      references: Array.from({ length: 4 }, (_, j) => ({
        sourceCode: "PRICING",
        resourceReference: id(20000 + i * 4 + j),
        versionReference: id(30000 + i * 4 + j),
        referenceDigest: hash([i, j]),
      })),
    }));
  const candidate = (count) => {
    // Normalize finding/reference order before hashing, so a rejection cannot
    // accidentally be caused by a digest over a noncanonical array order.
    const details = parseCatalogProductPublicationValidationDetails({
        coverage: "Complete",
        impact: "Recorded",
        findings: findings.slice(0, count),
        sources: [
          {
            sourceCode: "PRICING",
            sourceDigest: hash("synthetic budget source"),
            generation: "4",
            relevantReferenceDigest: hash("synthetic budget references"),
            observedAt: at,
            validUntil: until,
          },
        ],
      }),
      body = {
        profile: "CatalogProductPublicationValidationReportV1",
        operationReference: id(9004),
        publicationAction: "Validate",
        originalIntentDigest: hash("synthetic budget command; not a stored operation"),
        publicationSnapshotDigest: hash("synthetic budget publication; not a stored head"),
        sourceAggregateVersion: 1,
        resultAggregateVersion: 2,
        publicationVersion: 1,
        validationEvidenceReference: validation.evidenceReference,
        recordedAt: at,
        binding,
        validation,
        details,
        warningBindingDigest: calculateCatalogProductPublicationWarningBindingDigest(
          binding,
          validation,
          details,
        ),
      };
    return { ...body, digest: hash(body) };
  };
  const measure = async (count) => {
    const value = candidate(count),
      compact = canonicalizeRfc8785(value),
      result = await client.query("SELECT octet_length($1::jsonb::text) AS bytes", [compact]);
    assert.equal(result.rows.length, 1);
    assert(Number.isInteger(result.rows[0].bytes));
    return {
      value,
      compactBytes: new TextEncoder().encode(compact).length,
      storedBytes: result.rows[0].bytes,
    };
  };
  assert((await measure(1)).storedBytes < limit);
  assert((await measure(1000)).storedBytes > limit);
  let lower = 1,
    upper = 1000;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if ((await measure(middle)).storedBytes <= limit) lower = middle;
    else upper = middle - 1;
  }
  const accepted = await measure(lower),
    rejected = await measure(lower + 1);
  assert(accepted.storedBytes <= limit);
  assert(accepted.storedBytes > 1040000);
  assert(rejected.storedBytes > limit);
  assert(rejected.compactBytes <= limit);
  assert.deepEqual(parseCatalogProductPublicationValidationReport(accepted.value), accepted.value);
  assert.throws(() => parseCatalogProductPublicationValidationReport(rejected.value), {
    code: "CATALOG_INPUT_INVALID",
  });
}

/** The identities, authority, policy and complete validation details are named
 * synthetic doubles. Product creation, publication transitions, independent
 * approval receipt generation, reports, RLS, constraints and rollback use actual
 * owning PostgreSQL stores. These facts do not constitute a complete producer. */
export async function exerciseProductPublicationValidationReport() {
  await withIsolatedDatabase({ caseId: "wp2421_pub_report" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      role = "wp2421_pubreport_" + context.runId,
      tenant = id(1),
      brand = id(2),
      submitter = id(3),
      approver = id(4),
      past = new Date(Date.now() - 3600000).toISOString(),
      guards = new WeakMap();
    assert.match(role, /^wp2421_pubreport_[a-f0-9]+$/u);
    await admin.connect();
    let createdRole = false,
      mode = "normal",
      completeDetails = false,
      warningMode = false,
      referenceRevision = 1,
      acknowledgementReads = 0,
      sequence = 1000,
      sourceCalls = 0,
      policyCalls = 0,
      lastTransaction = null,
      originalDenial = null,
      outboxError,
      tentative,
      forcedClock = null,
      originalDeadline = null;
    const now = () => forcedClock ?? new Date().toISOString(),
      counts = async (tx = admin) => (await tx.query(countsSql, [])).rows[0];
    const registerBeforeCommit = async (tx, guard, finalAssert) => {
      const state = guards.get(tx);
      assert(state);
      assert.equal(state.phase, "work");
      assert.equal(typeof guard, "function");
      assert.equal(typeof finalAssert, "function");
      const evidence = {
        asyncEntered: 0,
        asyncReturned: 0,
        finalEntered: 0,
        finalReturned: 0,
        finalError: null,
      };
      state.guards.push({
        evidence,
        async guard() {
          evidence.asyncEntered++;
          await guard();
          evidence.asyncReturned++;
        },
        finalAssert() {
          evidence.finalEntered++;
          try {
            const result = finalAssert();
            evidence.finalReturned++;
            return result;
          } catch (error) {
            evidence.finalError = error;
            throw error;
          }
        },
      });
    };
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        const state = {
          phase: "work",
          guards: [],
          sqlError: null,
          reportInserted: false,
          suppressedReports: 0,
          corruptedReports: 0,
          workReturned: false,
          constraintsCompleted: false,
          constraintsError: null,
        };
        lastTransaction = state;
        const tx = {
          async query(sql, values = []) {
            if (
              sql.startsWith("SELECT") &&
              sql.includes("FROM rms_catalog.product_publication_warning_acknowledgement")
            )
              acknowledgementReads++;
            if (
              mode === "missing-report" &&
              sql.startsWith("INSERT INTO rms_catalog.product_publication_validation_report")
            ) {
              state.suppressedReports++;
              return { rows: [], rowCount: 1 };
            }
            if (
              mode === "outbox-denied" &&
              sql.startsWith("INSERT INTO platform_eventing.outbox_event")
            )
              tentative = await counts({
                query: (text, binds = []) => client.query(text, [...binds]),
              });
            const binds = [...values];
            if (
              mode === "corrupt-report-checks" &&
              sql.startsWith("INSERT INTO rms_catalog.product_publication_validation_report")
            ) {
              const report = JSON.parse(binds[14]);
              assert.equal(report.validation.checks.length, 12);
              const repeated = report.validation.checks.find(
                (item) => item.code === "ChangeImpact",
              );
              assert(repeated);
              report.validation.checks = report.validation.checks.map((item) =>
                item.code === "DefaultLocaleName" ? { ...repeated } : item,
              );
              delete report.digest;
              report.digest = hash(report);
              binds[12] = report.digest;
              binds[14] = canonicalizeRfc8785(report);
              state.corruptedReports++;
            }
            try {
              const result = await client.query(sql, binds);
              if (sql.startsWith("INSERT INTO rms_catalog.product_publication_validation_report"))
                state.reportInserted = true;
              return result;
            } catch (error) {
              state.sqlError = { code: error.code, constraint: error.constraint ?? null };
              if (
                mode === "outbox-denied" &&
                sql.startsWith("INSERT INTO platform_eventing.outbox_event")
              )
                outboxError = error;
              throw error;
            }
          },
        };
        guards.set(tx, state);
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const result = await work(tx);
          state.workReturned = true;
          if (["missing-report", "corrupt-report-checks", "later-guard-expiry"].includes(mode))
            tentative = await counts(tx);
          state.phase = "async";
          for (const entry of state.guards) assert.equal(await entry.guard(), undefined);
          // A later host guard consumes the original lease after the writer's
          // own async reauthorization succeeded. Never renew that lease.
          if (mode === "later-guard-expiry") {
            assert(originalDeadline);
            forcedClock = originalDeadline;
          }
          try {
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            state.constraintsCompleted = true;
          } catch (error) {
            state.constraintsError = error;
            throw error;
          }
          state.phase = "final";
          for (const entry of state.guards) assert.equal(entry.finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          guards.delete(tx);
          await client.end();
        }
      },
    };
    const audit = (operation, actor, actionCode, targetType, targetId, occurredAt, reasonCode) => ({
      auditId: id(Number.parseInt(operation.slice(-12), 16) + 500000),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode,
      targetType,
      targetId,
      reasonCode,
      correlationId: operation,
      occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "CATALOG_CONFIGURATION",
      retentionPolicyVersion: 1,
    });
    const editorContentAuthority = {
      async holdUntilTransactionCompletes(_tx, input) {
        assert.equal(input.aggregate.brandReference, brand);
      },
    };
    const aggregate = (base) =>
      parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTH_REPORT_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: past,
        createdByActorReference: submitter,
        updatedAt: past,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic report source" },
          taxClassificationReference: null,
          createdAt: past,
          updatedAt: past,
          skus: [],
          optionBindings: [],
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
    const createProduct = async (value, existingTx = null) => {
      const operation = id(++sequence);
      return createPostgresProductCreationStore({
        brandReference: brand,
        transactions: existingTx === null ? transactions : { run: (work) => work(existingTx) },
        authorize: async () => true,
        editorContentAuthority,
      }).create({
        record: {
          action: "Create",
          operationReference: operation,
          operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
          aggregate: value,
        },
        audit: audit(
          operation,
          submitter,
          "CATALOG_PRODUCT_CREATE",
          "CatalogProduct",
          value.productReference,
          past,
          "SYNTHETIC_REPORT_SOURCE",
        ),
      });
    };
    const command = (value, current = null, action = "Validate", actor = submitter) => {
      const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        replacementIntent = { ...intent, digest: hash(intent) },
        identity = deriveCatalogProductPublicationContentIdentity(value);
      return parseProductPublicationCommandV2({
        profile: "CatalogProductPublicationCommandV2",
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        operationReference: id(++sequence),
        productReference: value.productReference,
        versionReference: value.draft.versionReference,
        expectedProductAggregateVersion: value.aggregateVersion,
        expectedPublicationVersion: current?.publicationVersion ?? 0,
        action,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [
          { level: "Store", reference: id(40), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
        ],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: past, localDateTime: past.slice(0, -1), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: action === "Publish" ? id(450) : null,
        occurredAt: now(),
        reasonCode: "SYNTHETIC_REPORT_SOURCE",
        replacementIntent,
        replacementIntentDigest: replacementIntent.digest,
      });
    };
    const writer = (actor = submitter) =>
      createPostgresProductPublicationStoreV2({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        transactions,
        registerBeforeCommit,
        clock: { now },
        maximumApprovalValiditySeconds: 3600,
        editorContentAuthority,
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.requiredScope, "FullBrandScope");
            assert(input.requiredPermissions.includes("catalog.product.history.read"));
            assert(input.requiredFields.includes("validationReport"));
            if (mode === "deny-current") throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (mode === "late-denial" && guards.get(tx)?.reportInserted) {
              tentative = await counts(tx);
              originalDenial = new CatalogError("CATALOG_PERMISSION_DENIED");
              throw originalDenial;
            }
          },
        },
        audit: {
          create(publication, action) {
            return audit(
              publication.operationReference,
              publication.actorReference,
              catalogProductPublicationAuditAction(action),
              "Product",
              publication.productReference,
              publication.occurredAt,
              publication.reasonCode,
            );
          },
        },
        sources: {
          async withCurrentPolicy(_tx, input, work) {
            policyCalls++;
            if (mode === "replay-no-sources") throw new Error("REPLAY_MUST_NOT_REFRESH_POLICY");
            return work({
              content: {
                profile: "PublishingProductPublicationPolicyV1",
                tenantReference: tenant,
                brandReference: brand,
                familyReference: id(50),
                policyReference: id(51),
                policyVersion: 1,
                scopeOrder: productPublicationScopeLevels,
                approvalPolicy: "Required",
                warningOverrideAllowed: warningMode,
                requiredLocales: ["en-CA"],
                mediaRequirement: "Optional",
                effectiveFrom: past,
                effectiveUntil: null,
              },
              currentPublicationReference: id(52),
              observedAt: input.observedAt,
              validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
            });
          },
          async withHeldCurrentFacts(_tx, input, work) {
            sourceCalls++;
            if (mode === "replay-no-sources") throw new Error("REPLAY_MUST_NOT_REFRESH_FACTS");
            const c = input.command,
              validUntil = new Date(Date.parse(input.observedAt) + 5000).toISOString(),
              binding = {
                productAggregateVersion: c.expectedProductAggregateVersion,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
              };
            originalDeadline = validUntil;
            const facts = {
              now: input.observedAt,
              ...binding,
              validation: {
                profile: "CatalogProductPublicationValidationV2",
                replacementIntentDigest: c.replacementIntentDigest,
                evidenceReference: id(200000 + c.expectedProductAggregateVersion),
                ...binding,
                policyReference: id(51),
                policyVersion: 1,
                approvalPolicy: "Required",
                checks: productPublicationCheckCodes.map((code) => ({
                  code,
                  outcome:
                    code === "ApprovalPolicy"
                      ? "Pending"
                      : warningMode && code === "ChangeImpact"
                        ? "Warning"
                        : "Pass",
                })),
                warningAcknowledgement: null,
                checkedAt: input.observedAt,
                validUntil,
              },
              approval: null,
              reviewReference: c.action === "SubmitReview" ? id(60) : null,
              replacement: null,
            };
            if (!completeDetails) return work(facts);
            const sourceObservedAt = now();
            return work(facts, {
              coverage: "Complete",
              impact: "Recorded",
              findings: warningMode
                ? [
                    {
                      checkCode: "ChangeImpact",
                      ruleCode: "SYNTHETIC_REFERENCE_GAP",
                      outcome: "Warning",
                      subjectReference: c.productReference,
                      reasonCode: "SYNTHETIC_REFERENCE_GAP",
                      references: [],
                    },
                  ]
                : [],
              sources: [
                {
                  sourceCode: "SYNTHETIC_VALIDATION",
                  sourceDigest: hash({ command: c, observedAt: sourceObservedAt }),
                  generation: String(c.expectedProductAggregateVersion),
                  relevantReferenceDigest: hash({ syntheticReference: id(61), referenceRevision }),
                  observedAt: sourceObservedAt,
                  validUntil,
                },
              ],
            });
          },
        },
      });
    let denyReportRead = false;
    const readReport = (input, work = async (view) => view) =>
      createPostgresProductPublicationValidationReportSourceV2({
        tenantReference: tenant,
        brandReference: brand,
        storeReference: id(40),
        actorReference: submitter,
        clock: { now },
        transactions,
        registerBeforeCommit,
        contentAuthority: {
          async holdUntilTransactionCompletes(tx, request) {
            assert(guards.has(tx));
            assert.equal(request.tenantReference, tenant);
            assert.equal(request.brandReference, brand);
            assert.equal(request.actorReference, submitter);
            assert.equal(request.purposeCode, "CATALOG_PRODUCT_EDITOR_READ");
          },
        },
        historyAuthority: {
          async holdUntilTransactionCompletes(tx, request) {
            assert(guards.has(tx));
            assert.equal(request.tenantReference, tenant);
            assert.equal(request.brandReference, brand);
            assert.equal(request.actorReference, submitter);
            assert.equal(request.purposeCode, "CATALOG_PRODUCT_PUBLICATION_SOURCE");
            assert.deepEqual(request.owningActions, ["catalog.product.history.read"]);
          },
        },
        reportAuthority: {
          async holdUntilTransactionCompletes(tx, request) {
            assert(guards.has(tx));
            assert.equal(request.tenantReference, tenant);
            assert.equal(request.brandReference, brand);
            assert.equal(request.actorReference, submitter);
            assert.equal(request.actorKind, "User");
            assert.equal(request.productReference, input.productReference);
            assert.equal(request.versionReference, input.versionReference);
            assert.equal(request.expectedAggregateVersion, input.expectedAggregateVersion);
            assert.equal(request.expectedPublicationVersion, input.expectedPublicationVersion);
            assert.equal(request.purposeCode, "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ");
            assert.equal(request.requiredScope, "FullBrandScope");
            assert.deepEqual(request.owningActions, [
              "catalog.product.read",
              "catalog.product.history.read",
            ]);
            if (denyReportRead) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      }).withCurrentReport(input, work);
    const reportOf = (result) => {
      assert.equal(result.validationReport.status, "Recorded");
      const report = parseCatalogProductPublicationValidationReport(result.validationReport.report);
      assert.equal(report.operationReference, result.publication.operationReference);
      assert.equal(report.publicationSnapshotDigest, hash(result.publication));
      assert.equal(report.resultAggregateVersion, result.aggregate.aggregateVersion);
      return report;
    };
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      createdRole = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product,rms_catalog.product_source_head,rms_catalog.product_version,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_publication_revision,rms_catalog.product_publication_validation_report,rms_catalog.product_publication_warning_acknowledgement,rms_catalog.product_scope_retirement_header,rms_catalog.product_approval_receipt,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT UPDATE(aggregate_version,updated_at) ON rms_catalog.product TO " + role,
      );
      await admin.query(
        "GRANT UPDATE(source_revision) ON rms_catalog.product_source_head TO " + role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment,rms_catalog.product_scope_retirement,rms_catalog.product_scope_journal,rms_catalog.product_publication_content TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT ON rms_catalog.product_publication_content,rms_catalog.product_scope_journal,rms_catalog.product_scope_retirement TO " +
          role,
      );
      await admin.query("GRANT UPDATE(status) ON rms_catalog.product_version TO " + role);
      // These privileges let the actual immutable trigger, rather than an ACL
      // denial, prove that stored reports cannot be amended or deleted.
      await admin.query(
        "GRANT UPDATE,DELETE,TRUNCATE ON rms_catalog.product_publication_validation_report,rms_catalog.product_publication_warning_acknowledgement TO " +
          role,
      );
      const first = aggregate(100),
        negativeProduct = aggregate(200);
      await createProduct(first);
      await createProduct(negativeProduct);
      const beforeUnvalidatedRead = await counts();
      const unvalidated = await readReport({
        productReference: first.productReference,
        versionReference: first.draft.versionReference,
        expectedAggregateVersion: 1,
        expectedPublicationVersion: 0,
      });
      assert.equal(unvalidated.status, "NotValidated");
      assert.equal(unvalidated.applicability, "NotValidated");
      assert.equal(unvalidated.report, null);
      assert.equal(unvalidated.selectedPublicationOperationReference, null);
      assert.equal(unvalidated.eligibility, "NotEvaluated");
      assert.deepEqual(await counts(), beforeUnvalidatedRead);
      const firstCommand = parseProductPublicationCommandV2({
          ...command(first),
          occurredAt: new Date(Date.now() - 1500).toISOString(),
        }),
        checksOnly = await writer().execute(firstCommand),
        firstReport = reportOf(checksOnly);
      assert(checksOnly.publication.occurredAt > firstCommand.occurredAt);
      assert(firstReport.recordedAt >= checksOnly.publication.occurredAt);
      assert.equal(firstReport.originalIntentDigest, hash(firstCommand));
      assert(firstReport.validation.checkedAt <= firstReport.recordedAt);
      assert.deepEqual(firstReport.details, { coverage: "ChecksOnly", impact: "NotRecorded" });
      assert.equal(firstReport.warningBindingDigest, null);
      assert.equal(checksOnly.publication.validationDecision, "ApprovalPending");
      assert.equal(
        firstReport.validation.checks.find((item) => item.code === "ApprovalPolicy").outcome,
        "Pending",
      );
      completeDetails = true;
      // Fresh complete checks cannot silently replace the missing immutable
      // impact baseline. Only another Validate establishes that baseline.
      const beforeIncompleteBaseline = await counts();
      await assert.rejects(
        writer().execute(command(checksOnly.aggregate, checksOnly.publication, "SubmitReview")),
        (error) => error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), beforeIncompleteBaseline);
      const secondCommand = command(checksOnly.aggregate, checksOnly.publication),
        complete = await writer().execute(secondCommand),
        completeReport = reportOf(complete);
      assert.equal(completeReport.details.coverage, "Complete");
      assert.equal(completeReport.details.impact, "Recorded");
      assert.deepEqual(completeReport.details.findings, []);
      assert.equal(completeReport.details.sources[0].sourceCode, "SYNTHETIC_VALIDATION");
      assert(completeReport.details.sources[0].observedAt >= completeReport.validation.checkedAt);
      assert(completeReport.details.sources[0].observedAt <= completeReport.recordedAt);
      assert.equal(
        completeReport.details.sources[0].validUntil,
        completeReport.validation.validUntil,
      );
      assert(completeReport.warningBindingDigest);
      referenceRevision = 2;
      const beforeChangedReview = await counts();
      await assert.rejects(
        writer().execute(command(complete.aggregate, complete.publication, "SubmitReview")),
        (error) => error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), beforeChangedReview);
      referenceRevision = 1;
      const review = await writer().execute(
          command(complete.aggregate, complete.publication, "SubmitReview"),
        ),
        approved = await writer(approver).execute(
          command(review.aggregate, review.publication, "Approve", approver),
        ),
        reviewReport = reportOf(review),
        approvalReport = reportOf(approved);
      assert.equal(approved.publication.state, "Approved");
      assert.equal(
        approvalReport.validation.checks.find((item) => item.code === "ApprovalPolicy").outcome,
        "Pass",
      );
      assert.equal(
        reviewReport.validation.checks.find((item) => item.code === "ApprovalPolicy").outcome,
        "Pending",
      );
      assert.equal(approvalReport.warningBindingDigest, reviewReport.warningBindingDigest);
      assert.equal(approvalReport.warningBindingDigest, completeReport.warningBindingDigest);
      assert.notEqual(approvalReport.digest, reviewReport.digest);
      assert.equal((await counts()).approvals, 1);
      const stored = await admin.query(
        "SELECT validation_report_required FROM rms_catalog.product_publication_revision ORDER BY publication_version",
        [],
      );
      assert.equal(stored.rows.length, 4);
      assert(stored.rows.every((row) => row.validation_report_required === true));
      const beforeReplay = await counts(),
        beforeSource = sourceCalls,
        beforePolicy = policyCalls;
      mode = "replay-no-sources";
      forcedClock = new Date(Date.parse(approvalReport.validation.validUntil) + 1000).toISOString();
      const replay = await writer().execute(firstCommand);
      assert.equal(replay.status, "Replayed");
      assert.deepEqual(replay.aggregate, checksOnly.aggregate);
      assert.deepEqual(reportOf(replay), firstReport);
      assert.equal(sourceCalls, beforeSource);
      assert.equal(policyCalls, beforePolicy);
      assert.deepEqual(await counts(), beforeReplay);
      mode = "deny-current";
      await assert.rejects(writer().execute(secondCommand), { code: "CATALOG_PERMISSION_DENIED" });
      assert.deepEqual(await counts(), beforeReplay);
      forcedClock = null;
      mode = "normal";
      await transactions.run(async (tx) => {
        assert.deepEqual(
          await recoverProductPublicationValidationReport(tx, complete.publication),
          complete.validationReport,
        );
      });
      // The ordinary owning source reads the latest exact stored report, even
      // after its original validation lease expires. Only current read authority
      // and the newly held read lease govern this display; no validation reruns.
      const readInput = {
        productReference: approved.publication.productReference,
        versionReference: approved.publication.versionReference,
        expectedAggregateVersion: approved.aggregate.aggregateVersion,
        expectedPublicationVersion: approved.publication.publicationVersion,
      };
      const beforeOrdinaryRead = await counts(),
        beforeReadSources = sourceCalls,
        beforeReadPolicy = policyCalls;
      forcedClock = new Date(Date.parse(approvalReport.validation.validUntil) + 1000).toISOString();
      const displayed = await readReport(readInput, async (view, tx) => {
        assert(guards.has(tx));
        return view;
      });
      assert.equal(displayed.status, "Recorded");
      assert.equal(displayed.applicability, "CurrentDraftContent");
      assert.equal(
        displayed.selectedPublicationOperationReference,
        approved.publication.operationReference,
      );
      assert.equal(displayed.selectedPublicationDigest, hash(approved.publication));
      assert.deepEqual(displayed.report, approvalReport);
      assert(displayed.observedAt > displayed.report.validation.validUntil);
      assert.equal(displayed.eligibility, "NotEvaluated");
      assert.equal(sourceCalls, beforeReadSources);
      assert.equal(policyCalls, beforeReadPolicy);
      assert.deepEqual(await counts(), beforeOrdinaryRead);
      forcedClock = null;
      for (const changed of [
        { expectedAggregateVersion: readInput.expectedAggregateVersion - 1 },
        { expectedPublicationVersion: readInput.expectedPublicationVersion - 1 },
        { versionReference: negativeProduct.draft.versionReference },
      ]) {
        let consumers = 0;
        await assert.rejects(
          readReport({ ...readInput, ...changed }, async () => {
            consumers++;
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(consumers, 0);
      }
      denyReportRead = true;
      await assert.rejects(readReport(readInput), { code: "CATALOG_PERMISSION_DENIED" });
      denyReportRead = false;
      // Late read denial and a later host guard's expiry roll back real Product
      // creation/Audit/Outbox performed by the enclosing consumer transaction.
      for (const failure of ["read-late-denial", "later-guard-expiry"]) {
        mode = failure;
        let consumerReturned = false;
        const before = await counts();
        let thrown;
        await assert.rejects(
          readReport(readInput, async (view, tx) => {
            originalDeadline = view.validUntil;
            await createProduct(aggregate(300), tx);
            tentative = await counts(tx);
            if (failure === "read-late-denial") denyReportRead = true;
            consumerReturned = true;
            return view;
          }),
          (error) => {
            thrown = error;
            return (
              error instanceof CatalogError &&
              error.code ===
                (failure === "read-late-denial"
                  ? "CATALOG_PERMISSION_DENIED"
                  : "CATALOG_DEPENDENCY_UNAVAILABLE")
            );
          },
        );
        assert.equal(consumerReturned, true);
        assert.equal(tentative.products, before.products + 1);
        assert.equal(tentative.operations, before.operations + 1);
        assert.equal(tentative.audit, before.audit + 1);
        assert.equal(tentative.outbox, before.outbox + 1);
        assert.notDeepEqual(tentative.heads, before.heads);
        assert.notDeepEqual(tentative.chains, before.chains);
        if (failure === "later-guard-expiry") {
          const finalFailure = lastTransaction.guards.find(
            (entry) => entry.evidence.finalError !== null,
          );
          assert(finalFailure);
          assert.equal(finalFailure.evidence.asyncReturned, 1);
          assert.equal(finalFailure.evidence.finalReturned, 0);
          assert.equal(thrown, finalFailure.evidence.finalError);
          assert.equal(lastTransaction.constraintsCompleted, true);
        }
        assert.deepEqual(await counts(), before);
        mode = "normal";
        forcedClock = null;
        denyReportRead = false;
      }
      assert.deepEqual(await counts(), beforeOrdinaryRead);
      // All failure cases start from the same actual, untouched Product.
      // Assertions outside assert.rejects establish the actual failure origin
      // and real tentative writes, so a failed test assertion cannot self-prove.
      for (const failure of [
        "late-denial",
        "outbox-denied",
        "missing-report",
        "corrupt-report-checks",
        "later-guard-expiry",
      ]) {
        const before = await counts();
        mode = failure;
        tentative = originalDenial = outboxError = null;
        if (failure === "outbox-denied")
          await admin.query("REVOKE INSERT ON platform_eventing.outbox_event FROM " + role);
        let thrown;
        await assert.rejects(writer().execute(command(negativeProduct)), (error) => {
          thrown = error;
          return error instanceof CatalogError;
        });
        if (failure === "outbox-denied") {
          await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
          assert.equal(outboxError?.code, "42501");
        } else if (failure === "late-denial") {
          assert(originalDenial instanceof CatalogError);
          assert.equal(thrown, originalDenial);
          assert.equal(originalDenial.code, "CATALOG_PERMISSION_DENIED");
        } else if (failure === "missing-report" || failure === "corrupt-report-checks") {
          assert.equal(lastTransaction.suppressedReports, failure === "missing-report" ? 1 : 0);
          assert.equal(
            lastTransaction.corruptedReports,
            failure === "corrupt-report-checks" ? 1 : 0,
          );
          assert.equal(lastTransaction.reportInserted, failure === "corrupt-report-checks");
          assert.equal(lastTransaction.workReturned, true);
          assert.equal(lastTransaction.constraintsCompleted, false);
          assert.equal(lastTransaction.constraintsError?.code, "23514");
          assert.equal(
            lastTransaction.constraintsError?.message,
            failure === "missing-report"
              ? "PRODUCT_PUBLICATION_REPORT_MISSING"
              : "PRODUCT_PUBLICATION_REPORT_VALIDATION_CONFLICT",
          );
        } else {
          assert.equal(lastTransaction.workReturned, true);
          assert.equal(lastTransaction.constraintsCompleted, true);
          assert.equal(lastTransaction.guards.length, 1);
          const evidence = lastTransaction.guards[0].evidence;
          assert.equal(evidence.asyncEntered, 1);
          assert.equal(evidence.asyncReturned, 1);
          assert.equal(evidence.finalEntered, 1);
          assert.equal(evidence.finalReturned, 0);
          assert(evidence.finalError instanceof CatalogError);
          assert.equal(evidence.finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
          assert.equal(thrown, evidence.finalError);
        }
        assert(tentative);
        assert.equal(tentative.revisions, before.revisions + 1);
        assert.equal(tentative.reports, before.reports + (failure === "missing-report" ? 0 : 1));
        assert.equal(tentative.operations, before.operations + 1);
        assert.equal(tentative.snapshots, before.snapshots + 1);
        assert.equal(tentative.commits, before.commits + 1);
        assert.equal(tentative.headers, before.headers + 1);
        assert.equal(tentative.audit, before.audit + 1);
        assert.equal(tentative.outbox, before.outbox + (failure === "outbox-denied" ? 0 : 1));
        assert.notDeepEqual(tentative.roots, before.roots);
        assert.notDeepEqual(tentative.heads, before.heads);
        assert.notDeepEqual(tentative.chains, before.chains);
        assert.deepEqual(await counts(), before);
        forcedClock = null;
        mode = "normal";
      }
      for (const [scopeTenant, scopeBrand, scopeStore] of [
        ["", brand, ""],
        [id(900), brand, ""],
        [tenant, id(901), ""],
        [tenant, brand, id(40)],
      ]) {
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scopeTenant, scopeBrand, scopeStore],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int count FROM rms_catalog.product_publication_validation_report",
                [],
              )
            ).rows[0].count,
            0,
          );
        });
      }
      for (const sql of [
        "UPDATE rms_catalog.product_publication_validation_report SET report_digest=report_digest WHERE operation_id=$1",
        "DELETE FROM rms_catalog.product_publication_validation_report WHERE operation_id=$1",
      ]) {
        await assert.rejects(
          transactions.run((tx) => tx.query(sql, [firstCommand.operationReference])),
          { code: "55000" },
        );
      }
      assert.equal((await counts()).reports, 4);
      const beforeBudget = await counts();
      await exerciseProductPublicationValidationReportBudget(admin);
      assert.deepEqual(await counts(), beforeBudget);
      // Independent acknowledgement persistence uses actual Product/report stores.
      // Only this focused fixture's current policy/findings/authority are synthetic.
      warningMode = true;
      const warningProduct = aggregate(400);
      await createProduct(warningProduct);
      const warningResult = await writer().execute(command(warningProduct));
      const warningReport = reportOf(warningResult);
      assert.equal(warningResult.publication.validationDecision, "WarningAcknowledgementRequired");
      assert.equal(warningReport.details.coverage, "Complete");
      let ackMode = "normal",
        ackSourceCalls = 0,
        ackReportReads = 0,
        ackTentative = null;
      const ackCommand = (patch = {}) =>
        parseCatalogProductPublicationWarningAcknowledgementCommand({
          profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
          action: "AcknowledgeProductPublicationWarnings",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: submitter,
          actorKind: "User",
          operationReference: id(++sequence),
          productReference: warningProduct.productReference,
          versionReference: warningProduct.draft.versionReference,
          expectedProductAggregateVersion: warningResult.aggregate.aggregateVersion,
          reportOperationReference: warningReport.operationReference,
          reportDigest: warningReport.digest,
          warningBindingDigest: warningReport.warningBindingDigest,
          warningCodes: ["ChangeImpact"],
          reasonCode: "CONFIRMED_SYNTHETIC_WARNING",
          occurredAt: now(),
          ...patch,
        });
      const ackWriter = (actor = submitter) =>
        createPostgresProductPublicationWarningAcknowledgementStore({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now },
          transactions,
          registerBeforeCommit,
          contentAuthority: {
            async holdUntilTransactionCompletes() {
              if (ackMode === "replay") throw new Error("NO_FRESH_CONTENT_ON_REPLAY");
            },
          },
          historyAuthority: {
            async holdUntilTransactionCompletes() {
              if (ackMode === "replay") throw new Error("NO_FRESH_HISTORY_ON_REPLAY");
            },
          },
          reportAuthority: {
            async holdUntilTransactionCompletes() {
              ackReportReads++;
              if (ackMode === "replay") throw new Error("NO_FRESH_REPORT_ON_REPLAY");
            },
          },
          authority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(input.requiredScope, "FullBrandScope");
              assert(input.requiredPermissions.includes("catalog.product.acknowledge-warnings"));
              if (ackMode === "deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (ackMode === "late-denial") {
                const currentCounts = await counts(tx);
                if (currentCounts.acknowledgements > ackTentative.acknowledgements) {
                  ackTentative = currentCounts;
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                }
              }
            },
          },
          audit: {
            create(receipt) {
              return audit(
                receipt.command.operationReference,
                receipt.command.actorReference,
                "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
                "Product",
                receipt.command.productReference,
                receipt.recordedAt,
                receipt.command.reasonCode,
              );
            },
          },
          sources: {
            async withHeldCurrentObservation(tx, input, work) {
              ackSourceCalls++;
              if (ackMode === "replay") throw new Error("NO_NEW_OBSERVATION_ON_REPLAY");
              const at = input.observedAt,
                until = input.validUntil;
              originalDeadline = until;
              const validation = {
                ...input.report.validation,
                productAggregateVersion: input.command.expectedProductAggregateVersion,
                evidenceReference: id(++sequence),
                checkedAt: at,
                validUntil: until,
              };
              const details = {
                ...input.report.details,
                sources: input.report.details.sources.map((source) => ({
                  ...source,
                  observedAt: at,
                  validUntil: until,
                })),
              };
              const policy = {
                profile: "PublishingProductPublicationPolicyV1",
                tenantReference: tenant,
                brandReference: brand,
                familyReference: id(50),
                policyReference: id(51),
                policyVersion: 1,
                scopeOrder: productPublicationScopeLevels,
                approvalPolicy: "Required",
                warningOverrideAllowed: ackMode !== "policy-denied",
                requiredLocales: ["en-CA"],
                mediaRequirement: "Optional",
                effectiveFrom: past,
                effectiveUntil: null,
              };
              const binding =
                ackMode === "changed-content"
                  ? { ...input.report.binding, contentDigest: hash("changed") }
                  : input.report.binding;
              return work(
                buildCatalogProductPublicationWarningAcknowledgementObservation({
                  command: input.command,
                  binding,
                  validation,
                  details,
                  policy,
                  observedAt: at,
                  validUntil: until,
                }),
              );
            },
          },
        });
      // An expired displayed report is history; only the new observation is fresh.
      forcedClock = new Date(Date.parse(warningReport.validation.validUntil) + 1000).toISOString();
      const originalAck = ackCommand(),
        beforeAck = await counts();
      let appliedAck;
      try {
        appliedAck = await ackWriter().execute(originalAck);
      } catch (error) {
        assert.deepEqual(lastTransaction.sqlError, null);
        throw error;
      }
      assert.equal(appliedAck.status, "Applied");
      assert.equal(
        appliedAck.receipt.command.expectedProductAggregateVersion,
        warningResult.aggregate.aggregateVersion,
      );
      const afterAck = await counts();
      assert.equal(afterAck.acknowledgements, beforeAck.acknowledgements + 1);
      assert.equal(afterAck.audit, beforeAck.audit + 1);
      assert.equal(afterAck.outbox, beforeAck.outbox + 1);
      for (const key of [
        "products",
        "versions",
        "operations",
        "snapshots",
        "commits",
        "revisions",
        "reports",
        "headers",
        "approvals",
        "roots",
        "heads",
      ])
        assert.deepEqual(afterAck[key], beforeAck[key]);
      const event = (
        await admin.query(
          "SELECT aggregate_type,aggregate_id,aggregate_version,payload_json payload FROM platform_eventing.outbox_event WHERE event_type='ProductPublicationWarningsAcknowledged'",
          [],
        )
      ).rows[0];
      assert.equal(event.aggregate_type, "ProductPublicationWarningAcknowledgement");
      assert.equal(event.aggregate_id, originalAck.operationReference);
      assert.equal(String(event.aggregate_version), "1");
      assert.equal(event.payload.receiptDigest, appliedAck.receipt.digest);
      const sourceBefore = ackSourceCalls,
        reportReadsBefore = ackReportReads;
      ackMode = "replay";
      forcedClock = new Date(
        Date.parse(appliedAck.receipt.observation.validUntil) + 1000,
      ).toISOString();
      const replayAck = await ackWriter().execute(originalAck);
      assert.equal(replayAck.status, "Replayed");
      assert.deepEqual(replayAck.receipt, appliedAck.receipt);
      assert.equal(ackSourceCalls, sourceBefore);
      assert.equal(ackReportReads, reportReadsBefore);
      assert.deepEqual(await counts(), afterAck);
      await assert.rejects(ackWriter().execute({ ...originalAck, reasonCode: "DIFFERENT" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      ackMode = "deny";
      await assert.rejects(ackWriter().execute(originalAck), { code: "CATALOG_PERMISSION_DENIED" });
      ackMode = "normal";
      for (const patch of [
        { expectedProductAggregateVersion: 99 },
        { reportDigest: hash("wrong") },
        { warningBindingDigest: hash("wrong") },
        { versionReference: id(999) },
      ]) {
        await assert.rejects(ackWriter().execute(ackCommand(patch)));
        assert.deepEqual(await counts(), afterAck);
      }
      for (const failure of [
        "policy-denied",
        "changed-content",
        "late-denial",
        "later-guard-expiry",
      ]) {
        ackMode = failure;
        mode = failure === "later-guard-expiry" ? failure : "normal";
        ackTentative = await counts();
        const beforeFailure = await counts();
        await assert.rejects(ackWriter().execute(ackCommand()));
        if (failure === "late-denial")
          assert.equal(ackTentative.acknowledgements, beforeFailure.acknowledgements + 1);
        if (failure === "later-guard-expiry") {
          assert.equal(tentative.acknowledgements, beforeFailure.acknowledgements + 1);
          assert(lastTransaction.workReturned);
        }
        assert.deepEqual(await counts(), beforeFailure);
        mode = "normal";
        ackMode = "normal";
        forcedClock = new Date(Date.parse(now()) + 10).toISOString();
      }
      // New confirmations remain distinct even at the same timestamp; latest is
      // selected by the owning sequence before any downstream semantic match.
      const nextAck = ackCommand();
      const secondAck = await ackWriter().execute(nextAck);
      assert.equal(secondAck.status, "Applied");
      const ackRows = (
        await admin.query(
          "SELECT acknowledgement_sequence FROM rms_catalog.product_publication_warning_acknowledgement ORDER BY acknowledgement_sequence",
          [],
        )
      ).rows;
      assert.deepEqual(ackRows, [{ acknowledgement_sequence: 1 }, { acknowledgement_sequence: 2 }]);
      const latest = await transactions.run((tx) =>
        readLatestProductPublicationWarningAcknowledgement(tx, {
          tenantReference: tenant,
          brandReference: brand,
          productReference: warningProduct.productReference,
          versionReference: warningProduct.draft.versionReference,
          actorReference: submitter,
        }),
      );
      assert.deepEqual(latest, secondAck.receipt);
      for (const sql of [
        "UPDATE rms_catalog.product_publication_warning_acknowledgement SET receipt_digest=receipt_digest WHERE operation_id=$1",
        "DELETE FROM rms_catalog.product_publication_warning_acknowledgement WHERE operation_id=$1",
      ])
        await assert.rejects(
          transactions.run((tx) => tx.query(sql, [originalAck.operationReference])),
          { code: "55000" },
        );
      await assert.rejects(
        transactions.run((tx) =>
          tx.query("TRUNCATE rms_catalog.product_publication_warning_acknowledgement", []),
        ),
        { code: "55000" },
      );
      for (const scopes of [
        ["", brand, ""],
        [id(900), brand, ""],
        [tenant, id(901), ""],
        [tenant, brand, id(40)],
      ]) {
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            scopes,
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int count FROM rms_catalog.product_publication_warning_acknowledgement",
                [],
              )
            ).rows[0].count,
            0,
          );
        });
      }
      // Actual persisted confirmation is consumed by later owning writes.
      // A workflow root advance and ApprovalPolicy Pending→Pass do not change
      // semantic warnings; a changed relevant reference does.
      const confirmedCommand = command(warningResult.aggregate, warningResult.publication);
      const confirmed = await writer().execute(confirmedCommand);
      assert.equal(confirmed.publication.validationDecision, "ApprovalPending");
      assert.equal(reportOf(confirmed).validation.warningAcknowledgement.actorReference, submitter);
      assert.equal(
        reportOf(confirmed).validation.warningAcknowledgement.reasonCode,
        nextAck.reasonCode,
      );
      assert.equal(
        reportOf(confirmed).validation.checks.find((c) => c.code === "ChangeImpact").outcome,
        "Warning",
      );
      assert.equal(
        reportOf(confirmed).validation.checks.find((c) => c.code === "ApprovalPolicy").outcome,
        "Pending",
      );
      const beforeKnownReplay = await counts(),
        beforeKnownReplayReads = acknowledgementReads;
      mode = "replay-no-sources";
      const knownReplay = await writer().execute(confirmedCommand);
      assert.equal(knownReplay.status, "Replayed");
      assert.deepEqual(knownReplay, { ...confirmed, status: "Replayed" });
      assert.equal(acknowledgementReads, beforeKnownReplayReads);
      assert.deepEqual(await counts(), beforeKnownReplay);
      mode = "normal";
      referenceRevision = 2;
      const beforeRevalidation = await counts();
      await assert.rejects(
        writer().execute(command(confirmed.aggregate, confirmed.publication, "SubmitReview")),
        (error) => error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), beforeRevalidation);
      const changed = await writer().execute(command(confirmed.aggregate, confirmed.publication));
      assert.equal(changed.publication.validationDecision, "WarningAcknowledgementRequired");
      assert.equal(reportOf(changed).validation.warningAcknowledgement, null);
      assert.notEqual(reportOf(changed).warningBindingDigest, warningReport.warningBindingDigest);
      const confirmResult = async (result, actor = submitter) => {
        const report = reportOf(result);
        return ackWriter(actor).execute(
          ackCommand({
            actorReference: actor,
            expectedProductAggregateVersion: result.aggregate.aggregateVersion,
            reportOperationReference: report.operationReference,
            reportDigest: report.digest,
            warningBindingDigest: report.warningBindingDigest,
          }),
        );
      };
      await confirmResult(changed);
      referenceRevision = 1;
      const returned = await writer().execute(command(changed.aggregate, changed.publication));
      assert.equal(reportOf(returned).warningBindingDigest, warningReport.warningBindingDigest);
      // The latest receipt belongs to reference revision2. Never fall back to
      // the earlier receipt that happens to match this returned revision1.
      assert.equal(returned.publication.validationDecision, "WarningAcknowledgementRequired");
      assert.equal(reportOf(returned).validation.warningAcknowledgement, null);
      await confirmResult(returned);
      const ready = await writer().execute(command(returned.aggregate, returned.publication));
      assert.equal(ready.publication.validationDecision, "ApprovalPending");
      const beforeLateConsumption = await counts();
      mode = "later-guard-expiry";
      await assert.rejects(writer().execute(command(ready.aggregate, ready.publication)));
      assert(tentative.reports > beforeLateConsumption.reports);
      assert.deepEqual(await counts(), beforeLateConsumption);
      mode = "normal";
      forcedClock = new Date(Date.parse(now()) + 1).toISOString();
      const reviewed = await writer().execute(
        command(ready.aggregate, ready.publication, "SubmitReview"),
      );
      assert.equal(reviewed.publication.state, "InReview");
      assert.equal(reviewed.publication.validationDecision, "ApprovalPending");
      // Independent reviewer cannot borrow the submitter's consent.
      const beforeReviewer = await counts();
      await assert.rejects(
        writer(approver).execute(
          command(reviewed.aggregate, reviewed.publication, "Approve", approver),
        ),
      );
      assert.deepEqual(await counts(), beforeReviewer);
      await confirmResult(reviewed, approver);
      const approvedWarning = await writer(approver).execute(
        command(reviewed.aggregate, reviewed.publication, "Approve", approver),
      );
      assert.equal(approvedWarning.publication.state, "Approved");
      assert.equal(approvedWarning.publication.validationDecision, "Pass");
      assert.equal(
        reportOf(approvedWarning).validation.warningAcknowledgement.actorReference,
        approver,
      );
      assert.equal(
        reportOf(approvedWarning).validation.checks.find((c) => c.code === "ChangeImpact").outcome,
        "Warning",
      );
      const publishCommand = command(
        approvedWarning.aggregate,
        approvedWarning.publication,
        "Publish",
      );
      referenceRevision = 2;
      const beforeChangedPublish = await counts(),
        readsBeforeChangedPublish = acknowledgementReads;
      await assert.rejects(
        writer().execute(publishCommand),
        (error) => error instanceof CatalogError && error.code === "CATALOG_LIFECYCLE_CONFLICT",
      );
      assert.deepEqual(await counts(), beforeChangedPublish);
      assert.equal(acknowledgementReads, readsBeforeChangedPublish);
      referenceRevision = 1;
      const publishedWarning = await writer().execute(publishCommand);
      assert.equal(publishedWarning.publication.state, "Published");
      assert.equal(publishedWarning.publication.validationDecision, "Pass");
      assert.equal(
        reportOf(publishedWarning).validation.warningAcknowledgement.actorReference,
        submitter,
      );
      assert.equal(publishedWarning.aggregate.draft.versionReference, id(450));
      // A committed original remains recoverable without reacquiring changed
      // qualification or comparing a new impact baseline.
      referenceRevision = 2;
      const beforePublishedReplay = await counts();
      assert.equal((await writer().execute(publishCommand)).status, "Replayed");
      assert.deepEqual(await counts(), beforePublishedReplay);
      forcedClock = null;
      warningMode = false;
    } finally {
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
