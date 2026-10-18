import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { createCurrentProductPublicationPolicySource } from "../../../apps/api/src/current-product-publication-policy.ts";
import { CatalogError, parseProductAggregate } from "../../rms/catalog/src/contracts/product.ts";
import { deriveCatalogProductPublicationContentIdentity } from "../../rms/catalog/src/contracts/product-publication-content.ts";
import { catalogProductPublicationAuditAction } from "../../rms/catalog/src/contracts/product-publication-event.ts";
import {
  parseProductPublicationCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
} from "../../rms/catalog/src/contracts/product-publication.ts";
import { parseProductPublicationCommandV2 } from "../../rms/catalog/src/contracts/product-publication-v2.ts";
import {
  parseCatalogProductPublicationReplacementIntent,
  parseCatalogProductScopeReplacementIntent,
} from "../../rms/catalog/src/contracts/product-scope-replacement-intent.ts";
import { createPostgresProductTaxCoverageSourceStore } from "../../rms/catalog/src/infrastructure/persistence/product-tax-coverage-source-store.ts";
import { productTaxCoverageSourceFields } from "../../rms/catalog/src/contracts/product-tax-coverage-source.ts";
import { createPostgresProductCreationStore } from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import { resolveCatalogProductPublicationWithRetirements } from "../../rms/catalog/src/contracts/product-publication-source-v2.ts";
import {
  createPostgresProductPublicationStore,
  createPostgresProductPublicationStoreV2,
} from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import {
  createPostgresProductPublicationSourceStore,
  createPostgresProductPublicationSourceStoreV2,
} from "../../rms/catalog/src/infrastructure/persistence/product-publication-source-store.ts";
import { createProductPublicationScheduledActivatorV2 } from "../../rms/catalog/src/application/product-publication-scheduler.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";
import { exerciseProductValidationCandidateV2 } from "./product-validation-candidate-v2.mjs";

const id = (n) => `01902451-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const period = (from, until = null) => ({
  timeZone: "UTC",
  effectiveFrom: boundary(from),
  effectiveUntil: until === null ? null : boundary(until),
});

/** Controlled synthetic initial Drafts, validation and Actor/field holders.
 * Product transitions/receipts/retirement and Published policy acquisition use
 * actual owning writers, SQL, forced RLS, Audit and Outbox in this isolated DB. */
export async function exerciseProductScopeRetirement() {
  await withIsolatedDatabase({ caseId: "wp2421_scope_retire" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_retire_" + context.runId;
    assert.match(role, /^wp2421_retire_[a-f0-9]+$/);
    const start = Date.now() - 3600000,
      time = (offset) => new Date(start + offset).toISOString(),
      tenant = id(1),
      brand = id(2),
      storeA = id(20),
      storeB = id(21),
      policyReference = id(31);
    let roleCreated = false,
      clock = time(0),
      auditSequence = 500000,
      mode = "normal",
      targetOperation = null,
      tentative = false,
      tentativeCounts = null,
      partialClockStartedAt = null,
      partialClockObservedByWriter = null,
      headerSuppressed = false,
      deferredFailureCode = null,
      sourceCalls = 0,
      policyCalls = 0,
      currentDenied = false,
      readMode = "normal",
      readAuthorityCalls = 0,
      expiredPeriodInjected = false,
      emptyHeaderInjected = false,
      retirementSuppressed = false,
      noneIntentInjected = false,
      noneIntentSqlFailure = null,
      retirementSqlFailure = null,
      outerReceipt = null,
      outerGuardEvidence = null,
      outerConstraintsCompleted = false,
      replayPolicyQueries = 0,
      replaySourceHeadQueries = 0;
    const sourcesSeen = [],
      outerCommitGuards = new WeakMap();
    const countsSql = `SELECT p.aggregate_version root,
      (SELECT count(*)::int FROM rms_catalog.product_publication_revision WHERE product_id=p.product_id) revisions,
      (SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=p.product_id) operations,
      (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=p.product_id) snapshots,
      (SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=p.product_id) commits,
      (SELECT source_revision::text FROM rms_catalog.product_source_head WHERE brand_id=p.brand_id) source_revision,
      (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header WHERE product_id=p.product_id) headers,
      (SELECT count(*)::int FROM rms_catalog.product_scope_retirement WHERE product_id=p.product_id) retirements,
      (SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=p.product_id) approvals,
      (SELECT count(*)::int FROM rms_catalog.product_publication_content WHERE product_id=p.product_id) contents,
      (SELECT count(*)::int FROM rms_catalog.product_scope_journal WHERE product_id=p.product_id) journals,
      (SELECT count(*)::int FROM rms_catalog.product_version WHERE product_id=p.product_id AND status='Frozen') frozen,
      (SELECT count(*)::int FROM rms_catalog.product_version WHERE product_id=p.product_id AND status='Draft') drafts,
      (SELECT count(*)::int FROM platform_audit.audit_record) audit,
      (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox
      FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2`;
    const counts = async (product) => (await admin.query(countsSql, [brand, product])).rows[0];
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const tx = {
            query: async (sql, values = []) => {
              if (mode === "replay-no-sources") {
                if (sql.includes("bop_publishing.")) replayPolicyQueries++;
                if (sql.includes("rms_catalog.product_source_head")) replaySourceHeadQueries++;
              }
              if (
                mode === "missing-header" &&
                sql.includes("INSERT INTO rms_catalog.product_scope_retirement_header")
              ) {
                headerSuppressed = true;
                // Negative-only transport fault. The real deferred DB guard,
                // rather than this injected response, must reject COMMIT.
                return { rows: [], rowCount: 1 };
              }
              if (
                mode === "outbox-failure" &&
                sql.includes("INSERT INTO platform_eventing.outbox_event")
              )
                throw new Error("SYNTHETIC_OUTBOX_FAILURE");
              const actualValues = [...values];
              if (
                mode === "missing-retirement" &&
                sql.includes("INSERT INTO rms_catalog.product_scope_retirement_header(")
              ) {
                const columns = sql
                    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
                    .split(",")
                    .map((column) => column.trim()),
                  snapshotIndex = columns.indexOf("snapshot_json"),
                  countIndex = columns.indexOf("retirement_count"),
                  digestIndex = columns.indexOf("header_digest"),
                  stored = actualValues[snapshotIndex],
                  original = typeof stored === "string" ? JSON.parse(stored) : stored,
                  { digest: _digest, ...body } = original,
                  emptyBody = { ...body, retirements: [] },
                  corrupted = { ...emptyBody, digest: hash(emptyBody) };
                assert(snapshotIndex >= 0 && countIndex >= 0 && digestIndex >= 0);
                assert.match(_digest, /^sha256:[0-9a-f]{64}$/);
                assert.equal(original.retirements.length, 1);
                actualValues[snapshotIndex] =
                  typeof stored === "string" ? JSON.stringify(corrupted) : corrupted;
                actualValues[countIndex] = 0;
                actualValues[digestIndex] = corrupted.digest;
                emptyHeaderInjected = true;
              }
              if (
                mode === "missing-retirement" &&
                sql.includes("INSERT INTO rms_catalog.product_scope_retirement(")
              ) {
                // Negative-only SQL transport fault: both stored row count and
                // stored header claim zero. The owning Exact revision must still
                // make the actual deferred guard reject this empty coverage.
                retirementSuppressed = true;
                return { rows: [], rowCount: 1 };
              }
              if (
                mode === "none-retirement" &&
                sql.includes("INSERT INTO rms_catalog.product_publication_revision(")
              ) {
                const columns = sql
                    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
                    .split(",")
                    .map((column) => column.trim()),
                  snapshotIndex = columns.indexOf("snapshot_json"),
                  operationIndex = columns.indexOf("operation_id"),
                  actionIndex = columns.indexOf("action_code"),
                  stored = actualValues[snapshotIndex],
                  original = typeof stored === "string" ? JSON.parse(stored) : stored,
                  body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
                  replacementIntent = { ...body, digest: hash(body) },
                  corrupted = {
                    ...original,
                    replacementIntent,
                    replacementIntentDigest: replacementIntent.digest,
                  };
                assert(snapshotIndex >= 0 && operationIndex >= 0 && actionIndex >= 0);
                assert.equal(actualValues[operationIndex], targetOperation);
                assert.equal(actualValues[actionIndex], "Publish");
                assert.equal(original.state, "Published");
                // Only the persisted incoming intent is corrupted. The DB's
                // immutable review/approval intent guard must reject this before
                // the writer can append its actual Exact header and retirement.
                actualValues[snapshotIndex] =
                  typeof stored === "string" ? JSON.stringify(corrupted) : corrupted;
                noneIntentInjected = true;
              }
              if (
                mode === "expired-retirement-period" &&
                sql.includes("INSERT INTO rms_catalog.product_publication_revision(")
              ) {
                const columns = sql
                    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
                    .split(",")
                    .map((column) => column.trim()),
                  snapshotIndex = columns.indexOf("snapshot_json"),
                  operationIndex = columns.indexOf("operation_id"),
                  actionIndex = columns.indexOf("action_code");
                assert(snapshotIndex >= 0 && operationIndex >= 0 && actionIndex >= 0);
                assert.equal(actualValues[operationIndex], targetOperation);
                assert.equal(actualValues[actionIndex], "Publish");
                assert.equal(expiredPeriodInjected, false);
                const stored = actualValues[snapshotIndex],
                  original = typeof stored === "string" ? JSON.parse(stored) : stored;
                assert.equal(original.profile, "CatalogProductPublicationVersionV2");
                assert.equal(original.effectivePeriod.timeZone, "UTC");
                // Negative-only SQL transport fault: application-owned objects,
                // positive writes and subsequent header/retirement stay intact.
                const effectivePeriod = {
                    ...original.effectivePeriod,
                    effectiveUntil: boundary(original.occurredAt),
                  },
                  corrupted = { ...original, effectivePeriod, periodDigest: hash(effectivePeriod) };
                actualValues[snapshotIndex] =
                  typeof stored === "string" ? JSON.stringify(corrupted) : corrupted;
                expiredPeriodInjected = true;
              }
              let answer;
              try {
                answer = await client.query(sql, actualValues);
              } catch (error) {
                if (
                  mode === "expired-retirement-period" &&
                  sql.includes("INSERT INTO rms_catalog.product_scope_retirement(")
                )
                  retirementSqlFailure = { code: error.code, reason: error.message };
                if (
                  mode === "none-retirement" &&
                  sql.includes("INSERT INTO rms_catalog.product_publication_revision(")
                )
                  noneIntentSqlFailure = { code: error.code, reason: error.message };
                throw error;
              }
              if (
                targetOperation &&
                sql.includes("INSERT INTO rms_catalog.product_operation_record") &&
                values.includes(targetOperation)
              )
                tentative = true;
              return answer;
            },
          };
          const guards = [];
          outerCommitGuards.set(tx, guards);
          const result = await work(tx);
          if (["outer-receipt-expiry", "later-guard-receipt-expiry"].includes(mode)) {
            assert.equal(guards.length, 1);
            assert.equal(result.publication.operationReference, targetOperation);
            assert.equal(result.publication.state, "Approved");
            outerReceipt = (
              await client.query(
                "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
                [targetOperation],
              )
            ).rows[0].snapshot_json;
            tentativeCounts = (
              await client.query(
                "SELECT p.aggregate_version root,(SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header WHERE product_id=p.product_id) headers,(SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=p.product_id) approvals FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2",
                [brand, result.publication.productReference],
              )
            ).rows[0];
            // Actual owning receipt exists in the transaction. Expire its one-
            // second lease after execute returns, before the real outer COMMIT.
            if (mode === "outer-receipt-expiry") clock = outerReceipt.approval.validUntil;
            else
              guards.push({
                guard: async () => {
                  clock = outerReceipt.approval.validUntil;
                },
                finalAssert: () => undefined,
              });
          }
          for (const { guard } of guards) await guard();
          try {
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            if (mode === "later-guard-receipt-expiry") outerConstraintsCompleted = true;
          } catch (error) {
            deferredFailureCode = error.code;
            throw error;
          }
          for (const { finalAssert } of guards) assert.equal(finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    const audit = {
      create(p, action) {
        return {
          auditId: id(auditSequence++),
          brandId: brand,
          actor:
            p.actorKind === "System"
              ? { type: "System" }
              : { type: "User", reference: p.actorReference },
          actionCode: catalogProductPublicationAuditAction(action),
          targetType: "Product",
          targetId: p.productReference,
          reasonCode: p.reasonCode,
          correlationId: p.operationReference,
          occurredAt: p.occurredAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "OPERATIONAL",
          retentionPolicyVersion: 1,
        };
      },
    };
    function policySource(actor, actorKind = "User") {
      return createCurrentProductPublicationPolicySource({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind,
        clock: { now: () => clock },
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.actorReference, actor);
            assert.equal(input.actorKind, actorKind);
            assert.equal(input.policyReference, policyReference);
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_VERSION_PUBLICATION");
          },
        },
      });
    }
    const v1Approvals = new Map();
    function options(actor, actorKind = "User", v2 = false) {
      const actualPolicy = policySource(actor, actorKind);
      return {
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind,
        clock: { now: () => clock },
        transactions,
        audit,
        editorContentAuthority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.aggregate.brandReference, brand);
          },
        },
        ...(v2
          ? {
              maximumApprovalValiditySeconds: [
                "outer-receipt-expiry",
                "later-guard-receipt-expiry",
              ].includes(mode)
                ? 1
                : 3600,
              async registerBeforeCommit(tx, guard, finalAssert) {
                const guards = outerCommitGuards.get(tx);
                assert(guards);
                assert.equal(guards.length, 0);
                assert.equal(typeof finalAssert, "function");
                const evidence = {
                  asyncEntered: 0,
                  asyncReturned: 0,
                  finalEntered: 0,
                  finalReturned: 0,
                  finalError: null,
                };
                if (mode === "later-guard-receipt-expiry") outerGuardEvidence = evidence;
                guards.push({
                  async guard() {
                    evidence.asyncEntered++;
                    const result = await guard();
                    evidence.asyncReturned++;
                    return result;
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
              },
            }
          : {}),
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.command.actorReference, actor);
            assert.equal(input.command.actorKind, actorKind);
            assert.equal(input.requiredScope, "FullBrandScope");
            assert(input.requiredPermissions.includes("catalog.product.read"));
            if (v2) {
              assert(input.requiredPermissions.includes("catalog.product.history.read"));
              assert(input.requiredPermissions.includes("catalog.product.approval.read"));
              for (const field of [
                "replacementIntent",
                "replacementIntentDigest",
                "publicationHistory",
                "scopeRetirementHeader",
                "scopeRetirements",
              ])
                assert(input.requiredFields.includes(field));
            }
            if (currentDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (
              input.command.operationReference === targetOperation &&
              tentative &&
              [
                "late-denial",
                "late-expiry",
                "late-clock-rollback",
                "late-partial-clock-rollback",
              ].includes(mode)
            ) {
              const row = (
                await tx.query(
                  "SELECT p.aggregate_version root,(SELECT count(*)::int FROM rms_catalog.product_scope_retirement WHERE product_id=p.product_id) retirements,(SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header WHERE product_id=p.product_id) headers FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2",
                  [brand, input.command.productReference],
                )
              ).rows[0];
              tentativeCounts = row;
              if (mode === "late-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (mode === "late-partial-clock-rollback")
                partialClockObservedByWriter = input.observedAt;
              clock = new Date(
                Date.parse(clock) +
                  (["late-clock-rollback", "late-partial-clock-rollback"].includes(mode)
                    ? -1
                    : 30000),
              ).toISOString();
            }
          },
        },
        sources: {
          async withHeldCurrentFacts(_tx, input, work) {
            sourceCalls++;
            if (mode === "replay-no-sources") throw new Error("REPLAY_MUST_NOT_REFRESH_SOURCE");
            const c = input.command;
            assert.equal(input.observedAt, clock);
            sourcesSeen.push({
              action: c.action,
              actorKind: c.actorKind,
              observedAt: input.observedAt,
            });
            if (
              v2 &&
              mode === "late-partial-clock-rollback" &&
              c.operationReference === targetOperation
            ) {
              // The writer observes this later time before real SQL writes; its
              // final authority then rolls back only partway, still after start.
              partialClockStartedAt = input.observedAt;
              clock = new Date(Date.parse(input.observedAt) + 2).toISOString();
            }
            if (!v2 && c.action === "Approve")
              v1Approvals.set(c.productReference, {
                evidenceReference: c.operationReference,
                reviewReference: id(900000 + Number.parseInt(c.productReference.slice(-6), 16)),
                reviewVersion: c.expectedPublicationVersion,
                requestedByActorReference: id(3),
                approvedByActorReference: actor,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
                policyReference,
                policyVersion: 1,
                approvedAt: input.observedAt,
                validUntil: time(86400000),
              });
            const facts = {
              now: input.observedAt,
              productAggregateVersion: c.expectedProductAggregateVersion,
              contentDigest: c.contentDigest,
              configurationDigest: c.configurationDigest,
              scopeDigest: hash(c.scopeSet),
              periodDigest: hash(c.effectivePeriod),
              validation: {
                evidenceReference: id(910000),
                productAggregateVersion: c.expectedProductAggregateVersion,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
                policyReference,
                policyVersion: 1,
                approvalPolicy: "Required",
                checks: productPublicationCheckCodes.map((code) => ({
                  code,
                  // V2 input never grants approval. Only the actual writer's
                  // independent decision or original receipt may promote it.
                  // These named negative modes exercise controlled producer errors.
                  outcome:
                    v2 && code === "ApprovalPolicy"
                      ? ["approval-fake-pass", "discard-approval-pass"].includes(mode)
                        ? "Pass"
                        : mode === "approval-hard-error"
                          ? "HardError"
                          : mode === "approval-warning"
                            ? "Warning"
                            : "Pending"
                      : v2 &&
                          ((mode === "technical-hard-error" &&
                            ["TaxResolution", "HardErrorsCleared"].includes(code)) ||
                            (mode === "approval-hard-error" && code === "HardErrorsCleared"))
                        ? "HardError"
                        : v2 &&
                            ["technical-warning", "technical-warning-ack"].includes(mode) &&
                            code === "ChangeImpact"
                          ? "Warning"
                          : "Pass",
                })),
                warningAcknowledgement:
                  v2 && mode === "technical-warning-ack"
                    ? {
                        actorReference: c.actorReference,
                        reasonCode: "SYNTHETIC_WARNING_ACK",
                        warningCodes: ["ChangeImpact"],
                      }
                    : null,
                checkedAt: input.observedAt,
                validUntil: new Date(
                  Date.parse(input.observedAt) + (v2 ? 5000 : 30000),
                ).toISOString(),
                ...(v2
                  ? {
                      profile: "CatalogProductPublicationValidationV2",
                      replacementIntentDigest: c.replacementIntentDigest,
                    }
                  : {}),
              },
              approval: v2
                ? null
                : ["Approve", "Publish"].includes(c.action)
                  ? v1Approvals.get(c.productReference)
                  : null,
              reviewReference: id(900000 + Number.parseInt(c.productReference.slice(-6), 16)),
              replacement: null,
            };
            if (!v2) return work(facts);
            // Controlled qualification evidence only. The real owning writer,
            // policy, approval receipts and retirement SQL are tested below;
            // these details do not claim an assembled production producer.
            // Failure modes change their actual checks/findings, not the
            // synthetic reference dataset, so they reach the intended guard.
            return work(facts, {
              coverage: "Complete",
              impact: "Recorded",
              findings: facts.validation.checks
                .filter(
                  (check) =>
                    check.code !== "HardErrorsCleared" &&
                    ["Warning", "HardError"].includes(check.outcome),
                )
                .map((check) => ({
                  checkCode: check.code,
                  ruleCode: "SYNTHETIC_" + check.code.toUpperCase(),
                  outcome: check.outcome,
                  subjectReference: c.productReference,
                  reasonCode: "SYNTHETIC_" + check.code.toUpperCase(),
                  references: [],
                })),
              sources: [
                {
                  sourceCode: "SYNTHETIC_RETIREMENT_VALIDATION",
                  sourceDigest: hash({ command: c, validation: facts.validation }),
                  generation: null,
                  relevantReferenceDigest: hash({
                    fixture: "PERMANENT_SCOPE_RETIREMENT_NATIVE",
                    productReference: c.productReference,
                  }),
                  observedAt: input.observedAt,
                  validUntil: facts.validation.validUntil,
                },
              ],
            });
          },
          ...(v2
            ? {
                async withCurrentPolicy(tx, input, work) {
                  policyCalls++;
                  if (mode === "replay-no-sources")
                    throw new Error("REPLAY_MUST_NOT_REFRESH_POLICY");
                  return actualPolicy.withCurrentPolicy(tx, input, work);
                },
              }
            : {
                async withHeldScopePolicy(tx, input, work) {
                  policyCalls++;
                  if (mode === "replay-no-sources")
                    throw new Error("REPLAY_MUST_NOT_REFRESH_POLICY");
                  return actualPolicy.withHeldScopePolicy(tx, input, work);
                },
              }),
        },
      };
    }
    const v1 = (actor = id(3)) => createPostgresProductPublicationStore(options(actor));
    const v2 = (actor = id(3), kind = "User") =>
      createPostgresProductPublicationStoreV2(options(actor, kind, true));
    async function publishPolicy() {
      const scope = { kind: "Brand", brandReference: brand, storeReference: null },
        publisher = createPostgresPublishingMutationStore(transactions, tenant, scope),
        content = {
          profile: "PublishingProductPublicationPolicyV1",
          tenantReference: tenant,
          brandReference: brand,
          familyReference: id(5000),
          policyReference,
          policyVersion: 1,
          scopeOrder: productPolicyScopeLevels,
          approvalPolicy: "Required",
          warningOverrideAllowed: false,
          requiredLocales: ["en-CA"],
          mediaRequirement: "Optional",
          effectiveFrom: time(0),
          effectiveUntil: time(86400000),
        },
        draft = {
          lifecycleId: id(5001),
          familyReference: id(5000),
          configurationType: "PRODUCT_PUBLICATION_POLICY",
          purposeCode: "PRODUCT_PUBLICATION_POLICY",
          snapshotReference: policyReference,
          snapshotDigest: publishingProductPublicationPolicyDigest(content),
          scope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: time(0),
          changedAt: time(0),
        },
        validation = {
          evidenceReference: id(5020),
          snapshotReference: policyReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          result: "Pass",
          checkedAt: time(0),
          validUntil: time(86400000),
          checkCodes: ["PRODUCT_POLICY_STRUCTURE"],
        },
        review = {
          ...draft,
          version: 2,
          state: "InReview",
          validationEvidenceReference: validation.evidenceReference,
        },
        approval = {
          evidenceReference: id(5021),
          reviewLifecycleId: draft.lifecycleId,
          reviewVersion: 2,
          snapshotReference: policyReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          decision: "Accepted",
          approvedActorReference: id(4),
          approvedAt: time(0),
          validUntil: time(86400000),
        },
        approved = {
          ...review,
          version: 3,
          state: "Approved",
          approvalEvidenceReference: approval.evidenceReference,
        },
        published = { ...approved, version: 4, state: "Published" },
        release = {
          releaseId: id(5022),
          familyReference: draft.familyReference,
          configurationType: draft.configurationType,
          purposeCode: draft.purposeCode,
          snapshotReference: policyReference,
          snapshotDigest: draft.snapshotDigest,
          scope,
          sequence: 1,
          sourceLifecycleId: draft.lifecycleId,
          kind: "Publish",
          previousReleaseId: null,
          createdAt: time(0),
        };
      const mutation = (operation, current, next, n, extra = {}) => ({
        operation,
        expectedVersion: current?.version ?? 1,
        idempotencyKey: id(n),
        current,
        next,
        release: null,
        supersededReleaseId: null,
        rollbackTargetReleaseId: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          auditId: id(n + 1),
          brandId: brand,
          actor: {
            type: "User",
            reference: ["CreateDraft", "SubmitReview"].includes(operation) ? id(3) : id(4),
          },
          actionCode: {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
          }[operation],
          targetType: "PublishingLifecycle",
          targetId: draft.lifecycleId,
          reasonCode: "SYNTHETIC_POLICY",
          correlationId: id(n),
          occurredAt: time(0),
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        ...extra,
      });
      await publisher.commit(
        mutation("CreateDraft", null, draft, 5100, { productPolicyContent: content }),
      );
      await publisher.commit(
        mutation("SubmitReview", draft, review, 5102, { validationEvidence: validation }),
      );
      await publisher.commit(
        mutation("Approve", review, approved, 5104, { approvalEvidence: approval }),
      );
      await publisher.commit(
        mutation("Publish", approved, published, 5106, {
          validationEvidence: validation,
          approvalEvidence: approval,
          release,
        }),
      );
    }
    async function seedPublished(base, initialize) {
      clock = time(0);
      let aggregate = parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTHETIC_RETIRE_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: clock,
        createdByActorReference: id(3),
        updatedAt: clock,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic retirement fixture" },
          taxClassificationReference: null,
          skus: [],
          optionBindings: [],
          createdAt: clock,
          updatedAt: clock,
        },
      });
      if (initialize) aggregate = await initialize(aggregate);
      else {
        // This fixture needs an actual complete owning history before Brand-wide
        // sources inspect it. No Create receipt is synthesized by direct SQL.
        const operationReference = id(base + 500);
        await createPostgresProductCreationStore({
          brandReference: brand,
          transactions,
          authorize: async () => true,
        }).create({
          record: {
            action: "Create",
            operationReference,
            operationIntentHash: sha256Hex("synthetic retirement owning create " + base),
            aggregate,
          },
          audit: {
            auditId: id(base + 500000),
            brandId: brand,
            actor: { type: "User", reference: id(3) },
            actionCode: "CATALOG_PRODUCT_CREATE",
            targetType: "CatalogProduct",
            targetId: aggregate.productReference,
            correlationId: operationReference,
            occurredAt: clock,
            reasonCode: "SYNTHETIC_RETIREMENT_CREATE",
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
        const original = await counts(aggregate.productReference);
        assert.equal(original.root, 1);
        assert.equal(original.operations, 1);
        assert.equal(original.commits, 1);
        const snapshot = (
          await admin.query(
            "SELECT result_aggregate_version,snapshot_json FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 AND operation_id=$3",
            [brand, aggregate.productReference, operationReference],
          )
        ).rows;
        assert.equal(snapshot.length, 1);
        assert.equal(snapshot[0].result_aggregate_version, 1);
        assert.deepEqual(parseProductAggregate(snapshot[0].snapshot_json), aggregate);
      }
      const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
        selectors = [storeA, storeB].map((reference) => ({
          level: "Store",
          reference,
          channelCodes: ["WEB"],
          orderTypeCodes: ["PICKUP"],
        }));
      const commands = ["Validate", "SubmitReview", "Approve", "Publish"].map((action, index) =>
        parseProductPublicationCommand({
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: action === "Approve" ? id(4) : id(3),
          actorKind: "User",
          operationReference: id(base + 100 + index),
          productReference: aggregate.productReference,
          versionReference: aggregate.draft.versionReference,
          expectedProductAggregateVersion: aggregate.aggregateVersion + index,
          expectedPublicationVersion: index,
          action,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeSet: selectors,
          effectivePeriod: period(time(0)),
          scheduleReference: null,
          replacementVersionReference: null,
          successorDraftVersionReference: action === "Publish" ? id(base + 2) : null,
          occurredAt: clock,
          reasonCode: "SYNTHETIC_RETIREMENT",
        }),
      );
      let result;
      for (const c of commands) result = await v1(c.actorReference).execute(c);
      assert.equal(result.status, "Applied");
      assert.equal(result.publication.state, "Published");
      assert.equal(result.aggregate.aggregateVersion, aggregate.aggregateVersion + 4);
      return { base, original: result, originalPublish: commands[3] };
    }
    function replacementCommand(f, aggregate, publicationVersion, action, n, config = {}) {
      const old = f.original.publication,
        selectorIndex = config.selectorIndex ?? 0,
        selector = old.scopeSet[selectorIndex],
        body = {
          profile: "CatalogProductExactStoreSelectorReplacementV1",
          mode: "PermanentSelectorRetirement",
          previousVersionReference: old.versionReference,
          previousPublicationOperationReference: old.operationReference,
          expectedPreviousPublicationVersion: old.publicationVersion,
          previousIntentDigest: old.intentDigest,
          previousScopeDigest: old.scopeDigest,
          previousPeriodDigest: old.periodDigest,
          previousSelectorIndex: selectorIndex,
          previousSelectorDigest: hash(selector),
        },
        replacementIntent = parseCatalogProductScopeReplacementIntent({
          ...body,
          digest: hash(body),
        }),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate),
        system = action === "ActivateScheduled",
        scheduled = [
          "SchedulePublish",
          "ReschedulePublish",
          "CancelScheduledPublish",
          "ActivateScheduled",
        ].includes(action);
      return parseProductPublicationCommandV2({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: system ? id(9) : action === "Approve" ? id(4) : id(3),
        actorKind: system ? "System" : "User",
        operationReference: id(n),
        productReference: aggregate.productReference,
        versionReference: aggregate.draft.versionReference,
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: publicationVersion,
        action,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [selector],
        effectivePeriod: config.effectivePeriod ?? period(time(10000), time(60000)),
        scheduleReference: scheduled ? id(f.base + 50) : null,
        replacementVersionReference: null,
        successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(action)
          ? id(f.base + 3)
          : null,
        occurredAt: config.requestedAt ?? clock,
        reasonCode: "SYNTHETIC_RETIREMENT",
        profile: "CatalogProductPublicationCommandV2",
        replacementIntent,
        replacementIntentDigest: replacementIntent.digest,
      });
    }
    async function createOrdinaryDraft(base) {
      clock = time(0);
      const aggregate = parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTHETIC_ORDINARY_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: clock,
        createdByActorReference: id(3),
        updatedAt: clock,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic ordinary V2 Product" },
          // Controlled recorded input only: no registry/Active/tax eligibility claim.
          taxClassificationReference: base === 60000 ? id(60090) : null,
          skus: [],
          optionBindings: [],
          createdAt: clock,
          updatedAt: clock,
        },
      });
      await createPostgresProductCreationStore({
        brandReference: brand,
        transactions,
        authorize: async () => true,
      }).create({
        record: {
          action: "Create",
          operationReference: id(base + 500),
          operationIntentHash: sha256Hex("synthetic ordinary V2 create " + base),
          aggregate,
        },
        audit: {
          auditId: id(base + 500000),
          brandId: brand,
          actor: { type: "User", reference: id(3) },
          actionCode: "CATALOG_PRODUCT_CREATE",
          targetType: "CatalogProduct",
          targetId: aggregate.productReference,
          correlationId: id(base + 500),
          occurredAt: clock,
          reasonCode: "SYNTHETIC_ORDINARY_V2",
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        },
      });
      const stored = await counts(aggregate.productReference);
      assert.equal(stored.root, 1);
      assert.equal(stored.revisions, 0);
      assert.equal(stored.commits, 1);
      return aggregate;
    }
    function noReplacementCommand(base, aggregate, publicationVersion, action, n, config = {}) {
      const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        replacementIntent = parseCatalogProductPublicationReplacementIntent({
          ...body,
          digest: hash(body),
        }),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate);
      return parseProductPublicationCommandV2({
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: action === "Approve" ? id(4) : id(3),
        actorKind: "User",
        operationReference: id(n),
        productReference: aggregate.productReference,
        versionReference: aggregate.draft.versionReference,
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: publicationVersion,
        action,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [
          { level: "Store", reference: storeA, channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
        ],
        effectivePeriod: config.effectivePeriod ?? period(time(10000)),
        scheduleReference: action === "SchedulePublish" ? id(base + 50) : null,
        replacementVersionReference: null,
        successorDraftVersionReference:
          action === "Publish" ? (config.successorDraftVersionReference ?? id(base + 2)) : null,
        occurredAt: clock,
        reasonCode: "SYNTHETIC_ORDINARY_V2",
        profile: "CatalogProductPublicationCommandV2",
        replacementIntent,
        replacementIntentDigest: replacementIntent.digest,
      });
    }
    const execute = (c) => v2(c.actorReference, c.actorKind).execute(c);
    function currentSource(actorKind = "User") {
      return createPostgresProductPublicationSourceStoreV2({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actorKind === "System" ? id(9) : id(3),
        actorKind,
        clock: { now: () => clock },
        transactions,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            readAuthorityCalls++;
            assert.equal(input.tenantReference, tenant);
            assert.equal(input.brandReference, brand);
            assert.equal(input.actorKind, actorKind);
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_PUBLICATION_SOURCE");
            assert(input.owningActions.includes("catalog.product.history.read"));
            if (input.productReference === null)
              assert(input.owningActions.includes("catalog.product.publish"));
            for (const field of [
              "replacementIntent",
              "scopeRetirementHeaders",
              "scopeRetirements",
              "completePublicationHistory",
            ])
              assert(input.requiredFields.includes(field));
            if (readMode === "deny" || (readMode === "late-denial" && readAuthorityCalls === 2))
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (readMode === "late-expiry" && readAuthorityCalls === 2)
              clock = new Date(Date.parse(clock) + 5000).toISOString();
          },
        },
      });
    }
    async function coverage(product, root, observedAt) {
      const originalClock = clock;
      clock = observedAt;
      try {
        return await currentSource().withCurrentCoverage(
          { productReference: product, expectedAggregateVersion: root },
          async (snapshot) => snapshot,
        );
      } finally {
        clock = originalClock;
      }
    }
    function resolve(snapshot, store, at) {
      return resolveCatalogProductPublicationWithRetirements(
        snapshot,
        {
          storeReference: store,
          storeGroupReferences: [],
          regionReferences: [],
          channelCode: "WEB",
          orderTypeCode: "PICKUP",
          at,
        },
        productPublicationScopeLevels,
      );
    }
    async function rollbackAttempt(c, failureMode) {
      const before = await counts(c.productReference),
        originalClock = clock;
      mode = failureMode;
      targetOperation = c.operationReference;
      tentative = false;
      tentativeCounts = null;
      partialClockStartedAt = null;
      partialClockObservedByWriter = null;
      headerSuppressed = false;
      deferredFailureCode = null;
      expiredPeriodInjected = false;
      emptyHeaderInjected = false;
      retirementSuppressed = false;
      noneIntentInjected = false;
      noneIntentSqlFailure = null;
      retirementSqlFailure = null;
      outerReceipt = null;
      outerGuardEvidence = null;
      outerConstraintsCompleted = false;
      try {
        if (failureMode === "late-partial-clock-rollback")
          await assert.rejects(execute(c), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
        else await assert.rejects(execute(c));
        assert.deepEqual(await counts(c.productReference), before);
        if (failureMode === "missing-header") {
          assert.equal(headerSuppressed, true);
          assert.equal(deferredFailureCode, "23514");
        }
        if (failureMode === "expired-retirement-period") {
          assert.equal(expiredPeriodInjected, true);
          assert.deepEqual(retirementSqlFailure, {
            code: "23514",
            reason: "PRODUCT_SCOPE_RETIREMENT_PERIOD_CONFLICT",
          });
        }
        if (failureMode === "missing-retirement") {
          assert.equal(emptyHeaderInjected, true);
          assert.equal(retirementSuppressed, true);
          assert.equal(deferredFailureCode, "23514");
        }
        if (failureMode === "none-retirement") {
          assert.equal(noneIntentInjected, true);
          assert.deepEqual(noneIntentSqlFailure, {
            code: "23514",
            reason: "PRODUCT_SCOPE_RETIREMENT_INTENT_CONFLICT",
          });
        }
        if (["outer-receipt-expiry", "later-guard-receipt-expiry"].includes(failureMode)) {
          assert.equal(tentative, true);
          assert.equal(outerReceipt.profile, "CatalogProductApprovalReceiptV2");
          assert.equal(outerReceipt.approval.approvedAt, originalClock);
          assert.equal(clock, new Date(Date.parse(originalClock) + 1000).toISOString());
          assert.equal(tentativeCounts.root, before.root + 1);
          assert.equal(tentativeCounts.headers, before.headers + 1);
          assert.equal(tentativeCounts.approvals, before.approvals + 1);
        }
        if (failureMode === "later-guard-receipt-expiry") {
          assert.equal(outerConstraintsCompleted, true);
          assert.equal(deferredFailureCode, null);
          assert(outerGuardEvidence, "Capture the actual publication guard at registration");
          assert.equal(outerGuardEvidence.asyncEntered, 1);
          assert.equal(outerGuardEvidence.asyncReturned, 1);
          assert.equal(outerGuardEvidence.finalEntered, 1);
          assert.equal(outerGuardEvidence.finalReturned, 0);
          assert(outerGuardEvidence.finalError instanceof CatalogError);
          assert.equal(outerGuardEvidence.finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
        }
        if (
          [
            "late-denial",
            "late-expiry",
            "late-clock-rollback",
            "late-partial-clock-rollback",
          ].includes(failureMode)
        ) {
          assert.equal(tentative, true);
          assert.equal(tentativeCounts.root, before.root + 1);
          assert.equal(tentativeCounts.retirements, before.retirements + 1);
          assert.equal(tentativeCounts.headers, before.headers + 1);
        }
        if (failureMode === "late-partial-clock-rollback") {
          assert.equal(partialClockStartedAt, originalClock);
          assert.equal(
            partialClockObservedByWriter,
            new Date(Date.parse(originalClock) + 2).toISOString(),
          );
          assert.equal(clock, new Date(Date.parse(originalClock) + 1).toISOString());
        }
      } finally {
        mode = "normal";
        targetOperation = null;
        tentative = false;
        clock = originalClock;
      }
    }
    async function refuseApprovalTransition(c, failureMode, code) {
      const before = await counts(c.productReference),
        beforeSources = sourceCalls;
      mode = failureMode;
      try {
        await assert.rejects(execute(c), { code });
        assert(
          sourceCalls > beforeSources,
          failureMode + " must reach the controlled facts source",
        );
        assert.deepEqual(await counts(c.productReference), before);
      } finally {
        mode = "normal";
      }
    }
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,bop_publishing,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_publication_validation_report,rms_catalog.product_publication_revision,rms_catalog.product_publication_content,rms_catalog.product_scope_journal,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_source_head,rms_catalog.product_version,rms_catalog.product_approval_receipt,rms_catalog.product_scope_retirement_header,rms_catalog.product_scope_retirement TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_channel,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_version_category_assignment TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT ON rms_catalog.product_version_category_assignment TO " + role,
      );
      await admin.query("GRANT INSERT ON rms_catalog.product TO " + role);
      await admin.query(
        "GRANT UPDATE(aggregate_version,updated_at) ON rms_catalog.product TO " + role,
      );
      await admin.query("GRANT UPDATE(status) ON rms_catalog.product_version TO " + role);
      await admin.query(
        "GRANT UPDATE(source_revision) ON rms_catalog.product_source_head TO " + role,
      );
      await admin.query(
        "GRANT UPDATE(product_version_id) ON rms_catalog.sku,rms_catalog.product_option_binding TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,bop_publishing.publishing_mutation_record TO " +
          role,
      );
      // Deliberate extra rights only on these two immutable tables for negative tests.
      await admin.query(
        "GRANT UPDATE,DELETE ON rms_catalog.product_scope_retirement_header,rms_catalog.product_scope_retirement TO " +
          role,
      );
      await publishPolicy();
      const first = await seedPublished(10000),
        product = first.original.aggregate.productReference,
        originalBytes = canonicalizeRfc8785(
          (
            await admin.query(
              "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE operation_id=$1",
              [first.originalPublish.operationReference],
            )
          ).rows[0].snapshot_json,
        );
      clock = time(10000);
      let aggregate = first.original.aggregate,
        publicationVersion = 0,
        originalApproveCommand,
        originalApprovalResult;
      const originalPending = [];
      const validate = replacementCommand(first, aggregate, publicationVersion, "Validate", 11000);
      await rollbackAttempt(validate, "missing-header");
      await refuseApprovalTransition(
        replacementCommand(first, aggregate, publicationVersion, "Validate", 11070),
        "approval-fake-pass",
        "CATALOG_LIFECYCLE_CONFLICT",
      );
      for (const [index, action] of ["Validate", "SubmitReview", "Approve"].entries()) {
        const c = replacementCommand(first, aggregate, publicationVersion, action, 11000 + index);
        if (action === "SubmitReview") {
          for (const [offset, failure] of ["technical-hard-error", "technical-warning"].entries())
            await refuseApprovalTransition(
              { ...c, operationReference: id(11071 + offset) },
              failure,
              "CATALOG_LIFECYCLE_CONFLICT",
            );
          // An exact Actor/Reason acknowledgement cannot override the actual
          // Published policy's warningOverrideAllowed=false rule.
          await refuseApprovalTransition(
            { ...c, operationReference: id(11077) },
            "technical-warning-ack",
            "CATALOG_DEPENDENCY_UNAVAILABLE",
          );
        }
        if (action === "Approve") {
          await rollbackAttempt(c, "outer-receipt-expiry");
          await rollbackAttempt(c, "later-guard-receipt-expiry");
          await refuseApprovalTransition(
            { ...c, operationReference: id(11073), actorReference: id(3) },
            "normal",
            "CATALOG_DEPENDENCY_UNAVAILABLE",
          );
          for (const [offset, failure] of ["approval-hard-error", "approval-warning"].entries())
            await refuseApprovalTransition(
              { ...c, operationReference: id(11074 + offset) },
              failure,
              "CATALOG_DEPENDENCY_UNAVAILABLE",
            );
          await refuseApprovalTransition(
            replacementCommand(first, aggregate, publicationVersion, "Publish", 11076),
            "normal",
            "CATALOG_DEPENDENCY_UNAVAILABLE",
          );
        }
        const result = await execute(c);
        assert.equal(result.status, "Applied");
        assert.equal(result.scopeRetirementHeader.retirements.length, 0);
        if (action === "Approve") {
          assert.equal(result.publication.validationDecision, "Pass");
          assert.equal(result.publication.state, "Approved");
          assert.equal(result.publication.approvalEvidenceReference, c.operationReference);
          originalApproveCommand = c;
          originalApprovalResult = result;
        } else {
          assert.equal(result.publication.validationDecision, "ApprovalPending");
          assert.equal(result.publication.approvalEvidenceReference, null);
          assert.equal(result.publication.state, action === "Validate" ? "Draft" : "InReview");
          originalPending.push({ command: c, result });
        }
        aggregate = result.aggregate;
        publicationVersion = result.publication.publicationVersion;
      }
      const approvalRow = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
          [id(11002)],
        )
      ).rows[0].snapshot_json;
      assert.equal(approvalRow.profile, "CatalogProductApprovalReceiptV2");
      assert.equal(approvalRow.approval.evidenceReference, id(11002));
      assert.equal(approvalRow.approval.requestedByActorReference, id(3));
      assert.equal(approvalRow.approval.approvedByActorReference, id(4));
      assert.equal(approvalRow.replacementIntentDigest, validate.replacementIntentDigest);
      const publish = replacementCommand(first, aggregate, publicationVersion, "Publish", 11003);
      clock = time(12000);
      await rollbackAttempt(publish, "late-denial");
      await rollbackAttempt(publish, "late-expiry");
      await rollbackAttempt(publish, "late-clock-rollback");
      await rollbackAttempt(publish, "late-partial-clock-rollback");
      await rollbackAttempt(publish, "outbox-failure");
      await rollbackAttempt(publish, "expired-retirement-period");
      await rollbackAttempt(publish, "missing-retirement");
      await rollbackAttempt(publish, "none-retirement");
      const beforePublish = await counts(product),
        applied = await execute(publish),
        afterPublish = await counts(product);
      assert.equal(applied.status, "Applied");
      assert.equal(applied.publication.validationDecision, "Pass");
      assert.equal(applied.publication.approvalEvidenceReference, id(11002));
      assert.equal(applied.publication.occurredAt, clock);
      assert.equal(applied.publication.publishedAt, clock);
      assert.equal(applied.publication.intentDigest, hash(publish));
      assert.equal(applied.content.sealedAt, clock);
      assert.equal(applied.aggregate.updatedAt, clock);
      assert.equal(applied.scopeRetirementHeader.retirements.length, 1);
      assert.equal(applied.scopeRetirementHeader.retirements[0].retiredAt, clock);
      for (const key of [
        "root",
        "revisions",
        "operations",
        "snapshots",
        "commits",
        "headers",
        "retirements",
        "contents",
        "frozen",
        "audit",
        "outbox",
      ])
        assert.equal(afterPublish[key], beforePublish[key] + 1, key);
      assert.equal(afterPublish.drafts, 1);
      assert.equal(afterPublish.approvals, beforePublish.approvals);
      assert.equal(
        canonicalizeRfc8785(
          (
            await admin.query(
              "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE operation_id=$1",
              [first.originalPublish.operationReference],
            )
          ).rows[0].snapshot_json,
        ),
        originalBytes,
      );
      const current = await coverage(product, applied.aggregate.aggregateVersion, time(120000));
      assert.equal(
        resolve(current, storeA, time(5000)).versionReference,
        first.original.publication.versionReference,
      );
      assert.equal(
        resolve(current, storeA, time(12000)).versionReference,
        applied.publication.versionReference,
      );
      assert.equal(
        resolve(current, storeB, time(12000)).versionReference,
        first.original.publication.versionReference,
      );
      assert.equal(resolve(current, storeA, time(60000)).outcome, "Unavailable");
      assert.equal(
        resolve(current, storeB, time(120000)).versionReference,
        first.original.publication.versionReference,
      );
      for (const failure of ["deny", "late-denial", "late-expiry"]) {
        readMode = failure;
        readAuthorityCalls = 0;
        let callback = false;
        const originalClock = clock;
        await assert.rejects(
          currentSource().withCurrentCoverage(
            {
              productReference: product,
              expectedAggregateVersion: applied.aggregate.aggregateVersion,
            },
            async () => {
              callback = true;
            },
          ),
        );
        assert.equal(callback, failure !== "deny");
        clock = originalClock;
        readMode = "normal";
        assert.deepEqual(await counts(product), afterPublish);
      }

      // Old V1 original recovery remains valid after V2 participation. Current V1 reads/writes refuse.
      mode = "replay-no-sources";
      sourceCalls = 0;
      policyCalls = 0;
      replayPolicyQueries = 0;
      replaySourceHeadQueries = 0;
      clock = time(7200000);
      assert(originalApproveCommand && originalApprovalResult);
      for (const original of originalPending) {
        const replay = await execute(original.command);
        assert.deepEqual(replay, { ...original.result, status: "Replayed" });
        assert.equal(replay.publication.validationDecision, "ApprovalPending");
      }
      const approvalReplay = await execute(originalApproveCommand),
        v2Replay = await execute(publish),
        v1Replay = await v1().execute(first.originalPublish);
      assert.deepEqual(approvalReplay, { ...originalApprovalResult, status: "Replayed" });
      assert.equal(
        canonicalizeRfc8785(
          (
            await admin.query(
              "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
              [originalApproveCommand.operationReference],
            )
          ).rows[0].snapshot_json,
        ),
        canonicalizeRfc8785(approvalRow),
      );
      assert.deepEqual(v2Replay, { ...applied, status: "Replayed" });
      assert.deepEqual(v1Replay, { ...first.original, status: "Replayed" });
      assert.equal(sourceCalls, 0);
      assert.equal(policyCalls, 0);
      assert.equal(replayPolicyQueries, 0);
      assert.equal(replaySourceHeadQueries, 0);
      assert.deepEqual(await counts(product), afterPublish);
      currentDenied = true;
      await assert.rejects(execute(publish), (error) => error.code === "CATALOG_PERMISSION_DENIED");
      currentDenied = false;
      mode = "normal";
      clock = time(12000);
      const next = replacementCommand(first, applied.aggregate, 0, "Validate", 11100);
      await assert.rejects(execute(next));
      const legacy = Object.fromEntries(
        Object.entries(next).filter(
          ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
        ),
      );
      await assert.rejects(v1().execute(legacy));
      const history = createPostgresProductPublicationSourceStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: id(3),
        clock: { now: () => clock },
        transactions,
        authority: {
          async holdUntilTransactionCompletes() {
            /* Synthetic current history holder; V1 source must refuse the V2 participant. */
          },
        },
      });
      let legacyReadCallback = false;
      await assert.rejects(
        history.withCurrentSnapshot(
          {
            productReference: product,
            expectedAggregateVersion: applied.aggregate.aggregateVersion,
          },
          async () => {
            legacyReadCallback = true;
          },
        ),
      );
      assert.equal(legacyReadCallback, false);
      assert.deepEqual(await counts(product), afterPublish);

      for (const [scopeTenant, scopeBrand, selectedStore] of [
        [id(99), brand, ""],
        [tenant, id(99), ""],
        [tenant, brand, storeA],
      ]) {
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scopeTenant, scopeBrand, selectedStore],
          );
          for (const table of ["product_scope_retirement_header", "product_scope_retirement"])
            assert.equal(
              (await tx.query("SELECT count(*)::int n FROM rms_catalog." + table, [])).rows[0].n,
              0,
            );
        });
      }
      for (const table of ["product_scope_retirement_header", "product_scope_retirement"])
        for (const sql of [
          "UPDATE rms_catalog." + table + " SET snapshot_json=snapshot_json WHERE operation_id=$1",
          "DELETE FROM rms_catalog." + table + " WHERE operation_id=$1",
        ])
          await assert.rejects(
            transactions.run((tx) => tx.query(sql, [publish.operationReference])),
            (error) => error.code === "55000",
          );
      const beforeConcurrent = await counts(product),
        remaining = { selectorIndex: 1 },
        competing = [11200, 11201].map((n) =>
          replacementCommand(first, applied.aggregate, 0, "Validate", n, remaining),
        ),
        raced = await Promise.allSettled(competing.map(execute));
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
      const afterConcurrent = await counts(product);
      assert.equal(afterConcurrent.root, beforeConcurrent.root + 1);
      assert.equal(afterConcurrent.headers, beforeConcurrent.headers + 1);
      assert.equal(afterConcurrent.retirements, beforeConcurrent.retirements);

      // Independent Product: Required schedule, genuine cancel/reapproval and
      // late System activation all use the same native V2 writer.
      const second = await seedPublished(20000),
        future = period(time(30000), time(120000));
      clock = time(10000);
      aggregate = second.original.aggregate;
      publicationVersion = 0;
      let scheduled;
      for (const [index, action] of [
        "Validate",
        "SubmitReview",
        "Approve",
        "SchedulePublish",
      ].entries()) {
        const c = replacementCommand(second, aggregate, publicationVersion, action, 21000 + index, {
            effectivePeriod: future,
          }),
          result = await execute(c);
        aggregate = result.aggregate;
        publicationVersion = result.publication.publicationVersion;
        scheduled = result;
        assert.equal(result.scopeRetirementHeader.retirements.length, 0);
        assert.equal(
          result.publication.validationDecision,
          action === "Validate" || action === "SubmitReview" ? "ApprovalPending" : "Pass",
        );
      }
      const reschedule = replacementCommand(
          second,
          aggregate,
          publicationVersion,
          "ReschedulePublish",
          21100,
          { effectivePeriod: period(time(31000), time(120000)) },
        ),
        beforeReschedule = await counts(aggregate.productReference);
      await assert.rejects(execute(reschedule));
      assert.deepEqual(await counts(aggregate.productReference), beforeReschedule);
      for (const [index, action] of [
        "CancelScheduledPublish",
        "Validate",
        "SubmitReview",
        "Approve",
        "SchedulePublish",
      ].entries()) {
        const c = replacementCommand(second, aggregate, publicationVersion, action, 21200 + index, {
          effectivePeriod: future,
        });
        // Cancellation must discard an obsolete producer Pass without inheriting
        // its former receipt. Other V2 producer calls remain Pending by default.
        if (action === "CancelScheduledPublish") mode = "discard-approval-pass";
        const result = await execute(c);
        mode = "normal";
        aggregate = result.aggregate;
        publicationVersion = result.publication.publicationVersion;
        scheduled = result;
        assert.equal(result.scopeRetirementHeader.retirements.length, 0);
        assert.equal(
          result.publication.validationDecision,
          ["CancelScheduledPublish", "Validate", "SubmitReview"].includes(action)
            ? "ApprovalPending"
            : "Pass",
        );
        if (action === "CancelScheduledPublish") {
          assert.equal(result.publication.state, "Draft");
          assert.equal(result.publication.approvalEvidenceReference, null);
          assert.equal(result.publication.reviewReference, null);
        }
      }
      assert.equal(scheduled.publication.state, "Scheduled");
      clock = time(40000);
      const discovered = await currentSource("System").discoverDueSchedules({
        afterVersionReference: null,
        limit: 10,
      });
      assert.equal(discovered.candidates.length, 1);
      const candidate = discovered.candidates[0];
      assert.deepEqual(candidate, {
        publication: scheduled.publication,
        expectedAggregateVersion: aggregate.aggregateVersion,
      });
      let activate, activated;
      const activator = createProductPublicationScheduledActivatorV2({
        tenantReference: tenant,
        brandReference: brand,
        systemActorReference: id(9),
        references: { operation: () => id(21300), successorDraft: () => id(second.base + 3) },
        writer: {
          async execute(command) {
            activate = command;
            activated = await execute(command);
            return activated;
          },
        },
      });
      assert.equal(await activator.activate(candidate), "Applied");
      assert.equal(activate.occurredAt, time(30000));
      assert.equal(activated.publication.actorKind, "System");
      assert.equal(activated.publication.validationDecision, "Pass");
      assert.equal(
        activated.publication.approvalEvidenceReference,
        scheduled.publication.approvalEvidenceReference,
      );
      assert.equal(activated.publication.intentDigest, hash(activate));
      assert.equal(activated.publication.publishedAt, time(40000));
      assert.equal(activated.scopeRetirementHeader.retirements[0].retiredAt, time(40000));
      assert.notEqual(activated.publication.publishedAt, activate.occurredAt);
      const activatedCoverage = await coverage(
        aggregate.productReference,
        activated.aggregate.aggregateVersion,
        time(120000),
      );
      assert.equal(
        resolve(activatedCoverage, storeA, time(35000)).versionReference,
        second.original.publication.versionReference,
      );
      assert.equal(
        resolve(activatedCoverage, storeA, time(40000)).versionReference,
        activated.publication.versionReference,
      );
      assert.equal(
        resolve(activatedCoverage, storeB, time(40000)).versionReference,
        second.original.publication.versionReference,
      );
      assert.equal(resolve(activatedCoverage, storeA, time(120000)).outcome, "Unavailable");
      const originalActivation = activated,
        originalActivateCommand = activate;
      mode = "replay-no-sources";
      sourceCalls = 0;
      policyCalls = 0;
      clock = time(7200000);
      assert.equal(await activator.activate(candidate), "Replayed");
      assert.deepEqual(activate, originalActivateCommand);
      assert.deepEqual(activated, { ...originalActivation, status: "Replayed" });
      assert.equal(sourceCalls, 0);
      assert.equal(policyCalls, 0);
      assert(
        sourcesSeen.some(
          (seen) =>
            seen.action === "ActivateScheduled" &&
            seen.actorKind === "System" &&
            seen.observedAt === time(40000),
        ),
      );
      mode = "normal";
      // A rejected independent review clears approval and does not create a new
      // receipt or retirement. Published V1 fixture inputs remain unchanged.
      const rejectedFixture = await seedPublished(25000);
      clock = time(10000);
      let rejectedAggregate = rejectedFixture.original.aggregate,
        rejectedVersion = 0;
      for (const [index, action] of ["Validate", "SubmitReview", "Reject"].entries()) {
        const c = {
          ...replacementCommand(
            rejectedFixture,
            rejectedAggregate,
            rejectedVersion,
            action,
            25200 + index,
          ),
          ...(action === "Reject" ? { actorReference: id(4) } : {}),
        };
        const before = await counts(c.productReference);
        if (action === "Reject") mode = "discard-approval-pass";
        const result = await execute(c);
        mode = "normal";
        assert.equal(result.publication.validationDecision, "ApprovalPending");
        assert.equal(result.publication.approvalEvidenceReference, null);
        assert.equal(result.scopeRetirementHeader.retirements.length, 0);
        assert.equal((await counts(c.productReference)).approvals, before.approvals);
        if (action === "Reject") {
          assert.equal(result.publication.state, "Draft");
          assert.equal(result.publication.reviewReference, null);
        }
        rejectedAggregate = result.aggregate;
        rejectedVersion = result.publication.publicationVersion;
      }
      // These independent Products begin with an actual Create command, with no
      // legacy publication to replace. Validation/Actor holders remain the
      // declared controlled inputs; real policy, Pending review, independent
      // approval receipt, publication and retirement all use owning SQL writers.
      let ordinaryAggregate = await createOrdinaryDraft(60000),
        ordinaryVersion = 0;
      const firstOrdinaryRecords = [];
      clock = time(10000);
      for (const [index, action] of ["Validate", "SubmitReview", "Approve", "Publish"].entries()) {
        const command = noReplacementCommand(
          60000,
          ordinaryAggregate,
          ordinaryVersion,
          action,
          61000 + index,
        );
        if (action === "Publish") await rollbackAttempt(command, "missing-header");
        const result = await execute(command);
        assert.equal(result.status, "Applied");
        assert.equal(result.publication.replacementIntent.mode, "None");
        assert.deepEqual(result.scopeRetirementHeader.retirements, []);
        assert.equal(
          result.publication.validationDecision,
          ["Validate", "SubmitReview"].includes(action) ? "ApprovalPending" : "Pass",
        );
        assert.equal(
          result.publication.approvalEvidenceReference,
          ["Validate", "SubmitReview"].includes(action) ? null : id(61002),
        );
        assert.equal((await counts(result.aggregate.productReference)).retirements, 0);
        firstOrdinaryRecords.push({ command, result });
        ordinaryAggregate = result.aggregate;
        ordinaryVersion = result.publication.publicationVersion;
      }
      const firstOrdinary = firstOrdinaryRecords[3].result,
        ordinaryProduct = firstOrdinary.aggregate.productReference,
        firstOrdinaryFixture = { base: 60000, original: firstOrdinary },
        readFirstOrdinaryBytes = async () =>
          canonicalizeRfc8785(
            (
              await admin.query(
                "SELECT p.snapshot_json publication,h.snapshot_json header,c.snapshot_json content,o.snapshot_json operation FROM rms_catalog.product_publication_revision p JOIN rms_catalog.product_scope_retirement_header h USING(operation_id) JOIN rms_catalog.product_publication_content c ON c.publication_operation_id=p.operation_id JOIN rms_catalog.product_operation_snapshot o USING(operation_id) WHERE p.operation_id=$1",
                [firstOrdinary.publication.operationReference],
              )
            ).rows[0],
          ),
        originalOrdinaryBytes = await readFirstOrdinaryBytes();
      assert.equal(firstOrdinary.publication.state, "Published");
      assert.equal(firstOrdinary.publication.scopeSet.length, 1);
      assert.equal(firstOrdinary.aggregate.draft.versionReference, id(60002));
      assert.equal((await counts(ordinaryProduct)).approvals, 1);
      assert.equal((await counts(ordinaryProduct)).headers, 4);
      const firstOrdinaryReceipt = (
        await admin.query(
          "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
          [id(61002)],
        )
      ).rows[0].snapshot_json;
      assert.equal(firstOrdinaryReceipt.profile, "CatalogProductApprovalReceiptV2");
      assert.equal(
        firstOrdinaryReceipt.replacementIntentDigest,
        firstOrdinary.publication.replacementIntentDigest,
      );
      assert.equal(firstOrdinaryReceipt.approval.requestedByActorReference, id(3));
      assert.equal(firstOrdinaryReceipt.approval.approvedByActorReference, id(4));

      clock = time(20000);
      ordinaryVersion = 0;
      const repeatedPeriod = period(time(20000), time(30000));
      // The new successor Draft binds an explicit Exact intent to the original
      // immutable single-Store V2 head and obtains its own independent approval.
      const repeatedRecords = [];
      for (const [index, action] of ["Validate", "SubmitReview", "Approve", "Publish"].entries()) {
        const command = replacementCommand(
            firstOrdinaryFixture,
            ordinaryAggregate,
            ordinaryVersion,
            action,
            61200 + index,
            { effectivePeriod: repeatedPeriod },
          ),
          result = await execute(command);
        assert.equal(
          result.publication.validationDecision,
          ["Validate", "SubmitReview"].includes(action) ? "ApprovalPending" : "Pass",
        );
        assert.equal(result.scopeRetirementHeader.retirements.length, action === "Publish" ? 1 : 0);
        assert.equal(
          result.publication.approvalEvidenceReference,
          ["Validate", "SubmitReview"].includes(action) ? null : id(61202),
        );
        repeatedRecords.push({ command, result });
        ordinaryAggregate = result.aggregate;
        ordinaryVersion = result.publication.publicationVersion;
      }
      const repeated = repeatedRecords[3].result,
        retiredOriginal = repeated.scopeRetirementHeader.retirements[0];
      assert.equal(
        retiredOriginal.replacementIntent.previousPublicationOperationReference,
        firstOrdinary.publication.operationReference,
      );
      assert.equal(
        retiredOriginal.replacementIntent.previousVersionReference,
        firstOrdinary.publication.versionReference,
      );
      assert.equal(retiredOriginal.replacementIntent.previousSelectorIndex, 0);
      assert.equal(
        retiredOriginal.replacementIntent.previousSelectorDigest,
        hash(firstOrdinary.publication.scopeSet[0]),
      );
      assert.equal(retiredOriginal.previousPublicationDigest, hash(firstOrdinary.publication));
      assert.equal(retiredOriginal.retiredAt, time(20000));
      assert.equal(await readFirstOrdinaryBytes(), originalOrdinaryBytes);
      const ordinaryCoverage = await coverage(
        ordinaryProduct,
        ordinaryAggregate.aggregateVersion,
        time(40000),
      );
      assert.equal(
        resolve(ordinaryCoverage, storeA, time(15000)).versionReference,
        firstOrdinary.publication.versionReference,
      );
      assert.equal(
        resolve(ordinaryCoverage, storeA, time(20000)).versionReference,
        repeated.publication.versionReference,
      );
      assert.equal(resolve(ordinaryCoverage, storeA, time(30000)).outcome, "Unavailable");
      assert.equal(resolve(ordinaryCoverage, storeB, time(20000)).outcome, "Unavailable");
      assert.equal((await counts(ordinaryProduct)).retirements, 1);
      // Actual owning Published bytes and successor Drafts are read under the
      // complete Brand barrier. The authority holder remains a declared unit
      // input; this proves SQL/materialization/guard integrity, not sellability.
      const beforeTaxCoverageRead = await counts(ordinaryProduct),
        beforeTaxCoverageClock = clock,
        coverageObservation = time(7200000),
        expectedProductRoots = (
          await admin.query(
            "SELECT product_id::text FROM rms_catalog.product WHERE brand_id=$1 ORDER BY product_id",
            [brand],
          )
        ).rows.map((row) => row.product_id),
        actualFirstSealed = (
          await admin.query(
            "SELECT snapshot_json FROM rms_catalog.product_publication_content WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4",
            [tenant, brand, ordinaryProduct, firstOrdinary.publication.versionReference],
          )
        ).rows[0].snapshot_json;
      assert.equal(actualFirstSealed.sourceDraft.taxClassificationReference, id(60090));
      const readTaxCoverage = async (observedAt) => {
        clock = observedAt;
        const validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
        let actualTx,
          owner,
          asyncCalls = 0,
          finalCalls = 0,
          authorityCalls = 0;
        const result = await transactions.run(async (tx) => {
          actualTx = tx;
          owner = createPostgresProductTaxCoverageSourceStore({
            tenantReference: tenant,
            brandReference: brand,
            storeReference: storeA,
            actorReference: id(3),
            transaction: tx,
            originalObservedAt: observedAt,
            originalValidUntil: validUntil,
            clock: { now: () => clock },
            async registerBeforeCommit(heldTx, guard, finalAssert) {
              assert.equal(heldTx, tx);
              const guards = outerCommitGuards.get(tx);
              assert(guards);
              guards.push({
                async guard() {
                  asyncCalls++;
                  await guard();
                },
                finalAssert() {
                  finalCalls++;
                  return finalAssert();
                },
              });
            },
            authority: {
              async holdUntilTransactionCompletes(heldTx, input) {
                authorityCalls++;
                assert.equal(heldTx, tx);
                assert.equal(input.tenantReference, tenant);
                assert.equal(input.brandReference, brand);
                assert.equal(input.storeReference, storeA);
                assert.equal(input.actorReference, id(3));
                assert.equal(input.actorKind, "User");
                assert.equal(input.permission, "catalog.manage");
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_TAX_COVERAGE_READ");
                assert.equal(input.requiredFields, productTaxCoverageSourceFields);
                assert.deepEqual(input.owningActions, [
                  "catalog.product.read",
                  "catalog.product.history.read",
                  "catalog.sku.read",
                ]);
                assert.equal(input.observedAt, clock);
                assert.equal(input.validUntil, validUntil);
                return { validUntil };
              },
            },
          });
          return owner.readCurrent();
        });
        assert.equal(asyncCalls, 1);
        assert.equal(finalCalls, 1);
        assert.equal(authorityCalls, 4);
        assert.equal(owner.assertFinalized(actualTx), validUntil);
        return result;
      };
      try {
        const input = await readTaxCoverage(coverageObservation),
          repeatedInput = await readTaxCoverage(
            new Date(Date.parse(coverageObservation) + 1).toISOString(),
          ),
          selected = input.entries.find((entry) => entry.productReference === ordinaryProduct);
        assert(selected);
        assert.deepEqual(
          input.entries.map((entry) => entry.productReference),
          expectedProductRoots,
        );
        assert.equal(input.completeness, "Incomplete"); // Other controlled Products have an explicit unknown classification.
        assert.equal(input.sourceQualification, "NotEvaluated");
        assert.equal(input.sellability, "NotEvaluated");
        assert.equal(selected.aggregateVersion, ordinaryAggregate.aggregateVersion);
        assert.equal(selected.draft.versionReference, ordinaryAggregate.draft.versionReference);
        assert.equal(
          selected.draft.taxClassificationReference,
          ordinaryAggregate.draft.taxClassificationReference,
        );
        assert.equal(selected.draft.sourceDigest, hash(ordinaryAggregate));
        assert.equal(selected.published.length, 2);
        const originalInput = selected.published.find(
            (entry) => entry.versionReference === firstOrdinary.publication.versionReference,
          ),
          replacementInput = selected.published.find(
            (entry) => entry.versionReference === repeated.publication.versionReference,
          );
        assert(originalInput);
        assert(replacementInput);
        assert.equal(originalInput.sourceDigest, actualFirstSealed.contentDigest);
        assert.equal(
          originalInput.taxClassificationReference,
          actualFirstSealed.sourceDraft.taxClassificationReference,
        );
        assert.equal(replacementInput.sourceDigest, repeated.content.contentDigest);
        assert.equal(
          replacementInput.taxClassificationReference,
          repeated.content.sourceDraft.taxClassificationReference,
        );
        assert.notEqual(selected.draft.versionReference, replacementInput.versionReference);
        assert.equal(selected.publicationCoverage.history.length, 8);
        assert.equal(
          selected.publicationCoverage.headers.flatMap((header) => header.retirements).length,
          1,
        );
        assert.deepEqual(
          selected.publicationCoverage.headers.flatMap((header) => header.retirements)[0],
          retiredOriginal,
        );
        assert.equal(selected.publicationCoverage.observedAt, input.observedAt);
        assert.equal(input.sourceDigest, repeatedInput.sourceDigest);
        assert.notEqual(input.observedAt, repeatedInput.observedAt);
        assert.deepEqual(await counts(ordinaryProduct), beforeTaxCoverageRead);
        assert.equal(await readFirstOrdinaryBytes(), originalOrdinaryBytes);
      } finally {
        clock = beforeTaxCoverageClock;
      }
      const beforeOrdinaryReplay = await counts(ordinaryProduct);
      clock = time(7200000);
      mode = "replay-no-sources";
      sourceCalls = policyCalls = replayPolicyQueries = replaySourceHeadQueries = 0;
      for (const original of [...firstOrdinaryRecords, ...repeatedRecords])
        assert.deepEqual(await execute(original.command), {
          ...original.result,
          status: "Replayed",
        });
      assert.equal(sourceCalls, 0);
      assert.equal(policyCalls, 0);
      assert.equal(replayPolicyQueries, 0);
      assert.equal(replaySourceHeadQueries, 0);
      assert.deepEqual(await counts(ordinaryProduct), beforeOrdinaryReplay);
      assert.equal(await readFirstOrdinaryBytes(), originalOrdinaryBytes);
      mode = "normal";

      // None cannot evade replacement while the second version remains active.
      // Use its fresh successor Draft and a complete legitimate review/approval
      // prefix. The rejected Publish leaves that Approved version untouched;
      // this test never tries an illegal Approved-to-Validate transition.
      clock = time(25000);
      ordinaryVersion = 0;
      const conflictingPeriod = period(time(25000), time(27000));
      assert.equal(ordinaryAggregate.draft.versionReference, id(60003));
      for (const [index, action] of ["Validate", "SubmitReview", "Approve"].entries()) {
        const result = await execute(
          noReplacementCommand(60000, ordinaryAggregate, ordinaryVersion, action, 61100 + index, {
            effectivePeriod: conflictingPeriod,
          }),
        );
        ordinaryAggregate = result.aggregate;
        ordinaryVersion = result.publication.publicationVersion;
      }
      const conflictingNone = noReplacementCommand(
          60000,
          ordinaryAggregate,
          ordinaryVersion,
          "Publish",
          61103,
          {
            effectivePeriod: conflictingPeriod,
            successorDraftVersionReference: id(60004),
          },
        ),
        beforeConflictingNone = await counts(ordinaryProduct);
      await assert.rejects(execute(conflictingNone), { code: "CATALOG_LIFECYCLE_CONFLICT" });
      assert.deepEqual(await counts(ordinaryProduct), beforeConflictingNone);

      // A separate None first publication can be Scheduled and activated late by
      // the real System activator. Its actual publication still retires nothing.
      let firstScheduledAggregate = await createOrdinaryDraft(70000),
        firstScheduledVersion = 0,
        firstScheduled;
      clock = time(40000);
      for (const [index, action] of [
        "Validate",
        "SubmitReview",
        "Approve",
        "SchedulePublish",
      ].entries()) {
        const result = await execute(
          noReplacementCommand(
            70000,
            firstScheduledAggregate,
            firstScheduledVersion,
            action,
            71000 + index,
            { effectivePeriod: period(time(50000), time(90000)) },
          ),
        );
        assert.equal(
          result.publication.validationDecision,
          ["Validate", "SubmitReview"].includes(action) ? "ApprovalPending" : "Pass",
        );
        assert.deepEqual(result.scopeRetirementHeader.retirements, []);
        firstScheduled = result;
        firstScheduledAggregate = result.aggregate;
        firstScheduledVersion = result.publication.publicationVersion;
      }
      assert.equal(firstScheduled.publication.state, "Scheduled");
      clock = time(60000);
      const firstScheduledDiscovery = await currentSource("System").discoverDueSchedules({
        afterVersionReference: null,
        limit: 10,
      });
      assert.equal(firstScheduledDiscovery.candidates.length, 1);
      const firstScheduledCandidate = firstScheduledDiscovery.candidates[0];
      assert.deepEqual(firstScheduledCandidate, {
        publication: firstScheduled.publication,
        expectedAggregateVersion: firstScheduledAggregate.aggregateVersion,
      });
      let noneActivateCommand, noneActivated;
      const noneActivator = createProductPublicationScheduledActivatorV2({
        tenantReference: tenant,
        brandReference: brand,
        systemActorReference: id(9),
        references: { operation: () => id(71300), successorDraft: () => id(70002) },
        writer: {
          async execute(command) {
            noneActivateCommand = command;
            noneActivated = await execute(command);
            return noneActivated;
          },
        },
      });
      assert.equal(await noneActivator.activate(firstScheduledCandidate), "Applied");
      assert.equal(noneActivateCommand.occurredAt, time(50000));
      assert.equal(noneActivateCommand.replacementIntent.mode, "None");
      assert.equal(noneActivated.publication.actorKind, "System");
      assert.equal(noneActivated.publication.validationDecision, "Pass");
      assert.equal(noneActivated.publication.approvalEvidenceReference, id(71002));
      assert.equal(noneActivated.publication.publishedAt, time(60000));
      assert.equal(noneActivated.publication.intentDigest, hash(noneActivateCommand));
      assert.deepEqual(noneActivated.scopeRetirementHeader.retirements, []);
      const noneActivatedCounts = await counts(noneActivated.aggregate.productReference);
      assert.equal(noneActivatedCounts.headers, 5);
      assert.equal(noneActivatedCounts.retirements, 0);
      assert.equal(noneActivatedCounts.approvals, 1);
      const noneActivatedCoverage = await coverage(
        noneActivated.aggregate.productReference,
        noneActivated.aggregate.aggregateVersion,
        time(90000),
      );
      assert.equal(resolve(noneActivatedCoverage, storeA, time(55000)).outcome, "Unavailable");
      assert.equal(
        resolve(noneActivatedCoverage, storeA, time(60000)).versionReference,
        noneActivated.publication.versionReference,
      );
      assert.equal(resolve(noneActivatedCoverage, storeA, time(90000)).outcome, "Unavailable");
      const originalNoneActivation = noneActivated,
        originalNoneActivateCommand = noneActivateCommand;
      clock = time(7200000);
      mode = "replay-no-sources";
      sourceCalls = policyCalls = replayPolicyQueries = replaySourceHeadQueries = 0;
      assert.equal(await noneActivator.activate(firstScheduledCandidate), "Replayed");
      assert.deepEqual(noneActivateCommand, originalNoneActivateCommand);
      assert.deepEqual(noneActivated, { ...originalNoneActivation, status: "Replayed" });
      assert.equal(sourceCalls, 0);
      assert.equal(policyCalls, 0);
      assert.equal(replayPolicyQueries, 0);
      assert.equal(replaySourceHeadQueries, 0);
      assert.deepEqual(await counts(noneActivated.aggregate.productReference), noneActivatedCounts);
      mode = "normal";
      await exerciseProductValidationCandidateV2({
        admin,
        role,
        tenant,
        brand,
        actor: id(3),
        storeA,
        storeB,
        policyReference,
        policySource: policySource(id(3)),
        transactions,
        async registerBeforeCommit(tx, guard, finalAssert) {
          const guards = outerCommitGuards.get(tx);
          assert(guards);
          assert.equal(typeof guard, "function");
          assert.equal(typeof finalAssert, "function");
          guards.push({ guard, finalAssert });
        },
        seedPublished,
        replacementCommand,
        execute,
        counts,
        id,
        time,
        clock: {
          now: () => clock,
          set: (value) => {
            clock = value;
          },
        },
      });
    } finally {
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
