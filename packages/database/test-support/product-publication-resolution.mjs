import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPostgresProductTaxCoverageSourceStore } from "../../rms/catalog/src/index.ts";
import { CatalogError, parseProductAggregate } from "../../rms/catalog/src/contracts/product.ts";
import { deriveCatalogProductPublicationContentIdentity } from "../../rms/catalog/src/contracts/product-publication-content.ts";
import {
  parseProductPublicationCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
} from "../../rms/catalog/src/contracts/product-publication.ts";
import { parseProductPublicationCommandV2 } from "../../rms/catalog/src/contracts/product-publication-v2.ts";
import { catalogProductPublicationAuditAction } from "../../rms/catalog/src/contracts/product-publication-event.ts";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation,
} from "../../rms/catalog/src/contracts/product-publication-warning-acknowledgement.ts";
import {
  buildCatalogProductPublicationResolution,
  parseCatalogProductPublicationResolutionCommand,
  catalogProductPublicationResolutionNamespace,
} from "../../rms/catalog/src/contracts/product-publication-resolution.ts";
import { createPostgresProductCreationStore } from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import {
  createPostgresProductPublicationStore,
  createPostgresProductPublicationStoreV2,
} from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import { createPostgresProductPublicationWarningAcknowledgementStore } from "../../rms/catalog/src/infrastructure/persistence/product-publication-warning-acknowledgement-store.ts";
import { createPostgresProductPublicationResolutionStore } from "../../rms/catalog/src/infrastructure/persistence/product-publication-resolution-store.ts";
import { withIsolatedDatabase } from "./isolated-database.mjs";

const id = (n) => "01902475-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const countsSql = `SELECT
 (SELECT count(*)::int FROM rms_catalog.product_publication_operation_abandonment) fences,
 (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
 (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
 (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
 (SELECT count(*)::int FROM rms_catalog.product_publication_revision) revisions,
 (SELECT count(*)::int FROM rms_catalog.product_publication_validation_report) reports,
 (SELECT count(*)::int FROM rms_catalog.product_publication_warning_acknowledgement) acknowledgements,
 (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header) headers,
 (SELECT count(*)::int FROM platform_audit.audit_record) audit,
 (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
 (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.product_id),'[]'::jsonb) FROM rms_catalog.product p) roots,
 (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
 (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;
const fenceInsert = `INSERT INTO rms_catalog.product_publication_operation_abandonment
 (operation_namespace,operation_id,tenant_id,brand_id,product_id,product_version_id,actor_id,original_kind,intent_digest,resolution_digest,recorded_at,command_json,snapshot_json,audit_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`;
function latch() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Synthetic identities, authority, current policy and qualification details are
 * controlled acceptance inputs. Product/Publication/Ack/Resolution writers,
 * forced RLS, durable receipts, exclusion triggers, Audit and rollback are real. */
export async function exerciseProductPublicationResolution() {
  await withIsolatedDatabase({ caseId: "wp2421_pub_resolve" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      role = "wp2421_resolve_" + context.runId,
      tenant = id(1),
      brand = id(2),
      actor = id(3),
      past = new Date(Date.now() - 3600000).toISOString(),
      states = new WeakMap();
    assert.match(role, /^wp2421_resolve_[a-f0-9]+$/u);
    await admin.connect();
    let roleCreated = false,
      sequence = 1000,
      mode = "normal",
      forcedClock = null,
      sourceCalls = 0,
      policyCalls = 0,
      observationCalls = 0,
      lastTransaction = null,
      tentative,
      originalDenial = null,
      capturedAckInsert = null,
      race = null;
    const now = () => forcedClock ?? new Date().toISOString();
    const counts = async (tx = admin) => (await tx.query(countsSql, [])).rows[0];
    const registerBeforeCommit = async (tx, asyncGuard, finalAssert) => {
      const state = states.get(tx);
      assert(state);
      assert.equal(state.phase, "work");
      const evidence = {
        asyncReturned: false,
        finalEntered: false,
        finalReturned: false,
        finalError: null,
      };
      state.guards.push({
        evidence,
        async guard() {
          await asyncGuard();
          evidence.asyncReturned = true;
        },
        finalAssert() {
          evidence.finalEntered = true;
          try {
            const result = finalAssert();
            evidence.finalReturned = true;
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
          fenceInserted: false,
          workReturned: false,
          constraintsCompleted: false,
          deadline: null,
          sqlError: null,
          pid: null,
        };
        lastTransaction = state;
        const tx = {
          async query(sql, values = []) {
            const binds = [...values];
            try {
              if (
                race &&
                sql.includes("pg_advisory_xact_lock") &&
                binds[0] === "CatalogProductSource:" + brand &&
                state.pid !== race.holderPid
              )
                race.waiterPid = state.pid;
              const result = await client.query(sql, binds);
              if (
                sql.startsWith("INSERT INTO rms_catalog.product_publication_operation_abandonment")
              )
                state.fenceInserted = true;
              if (
                sql.startsWith(
                  "INSERT INTO rms_catalog.product_publication_warning_acknowledgement",
                )
              )
                capturedAckInsert = { sql, values: binds };
              if (race && binds.includes(race.operation) && sql.startsWith(race.holdSql)) {
                race.holderPid = state.pid;
                race.entered.release();
                await race.release.promise;
              }
              return result;
            } catch (error) {
              state.sqlError ??= error;
              throw error;
            }
          },
        };
        states.set(tx, state);
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          state.pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          const result = await work(tx);
          state.workReturned = true;
          if (mode === "later-guard-expiry") tentative = await counts(tx);
          state.phase = "async";
          for (const guard of state.guards) assert.equal(await guard.guard(), undefined);
          if (mode === "later-guard-expiry") {
            assert(state.deadline);
            forcedClock = state.deadline;
          }
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          state.constraintsCompleted = true;
          state.phase = "final";
          for (const guard of state.guards) assert.equal(guard.finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          states.delete(tx);
          await client.end();
        }
      },
    };
    const audit = (operation, who, actionCode, targetType, targetId, occurredAt, reasonCode) => ({
      auditId: id(Number.parseInt(operation.slice(-12), 16) + 500000),
      brandId: brand,
      actor: { type: "User", reference: who },
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
    const contentAuthority = {
      async holdUntilTransactionCompletes() {
        return undefined;
      },
    };
    const aggregate = (base) =>
      parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTH_RESOLVE_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: past,
        createdByActorReference: actor,
        updatedAt: past,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic recovery source" },
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
    async function create(value) {
      const operation = id(++sequence);
      await createPostgresProductCreationStore({
        brandReference: brand,
        transactions,
        authorize: async () => true,
        editorContentAuthority: contentAuthority,
      }).create({
        record: {
          action: "Create",
          operationReference: operation,
          operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
          aggregate: value,
        },
        audit: audit(
          operation,
          actor,
          "CATALOG_PRODUCT_CREATE",
          "CatalogProduct",
          value.productReference,
          past,
          "SYNTHETIC_RECOVERY",
        ),
      });
    }
    function publicationCommand(value, current = null, v2 = true) {
      const identity = deriveCatalogProductPublicationContentIdentity(value),
        intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        replacementIntent = { ...intent, digest: hash(intent) };
      const base = {
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
        action: "Validate",
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [{ level: "Store", reference: id(40), channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: past, localDateTime: past.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: now(),
        reasonCode: "SYNTHETIC_RECOVERY",
      };
      return v2
        ? parseProductPublicationCommandV2({
            ...base,
            profile: "CatalogProductPublicationCommandV2",
            replacementIntent,
            replacementIntentDigest: replacementIntent.digest,
          })
        : parseProductPublicationCommand(base);
    }
    const policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: tenant,
      brandReference: brand,
      familyReference: id(50),
      policyReference: id(51),
      policyVersion: 1,
      scopeOrder: productPublicationScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: past,
      effectiveUntil: null,
    };
    function writer(v2 = true, warning = false) {
      const options = {
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        transactions,
        registerBeforeCommit,
        clock: { now },
        maximumApprovalValiditySeconds: 3600,
        editorContentAuthority: contentAuthority,
        authority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
        audit: {
          create(p, action) {
            return audit(
              p.operationReference,
              p.actorReference,
              catalogProductPublicationAuditAction(action),
              "Product",
              p.productReference,
              p.occurredAt,
              p.reasonCode,
            );
          },
        },
        sources: {
          async withCurrentPolicy(_tx, input, work) {
            policyCalls++;
            if (mode === "no-sources") throw Error("Unexpected current policy");
            return work({
              content: policy,
              currentPublicationReference: id(52),
              observedAt: input.observedAt,
              validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
            });
          },
          async withHeldCurrentFacts(_tx, input, work) {
            sourceCalls++;
            if (mode === "no-sources") throw Error("Unexpected qualification");
            const c = input.command,
              until = new Date(Date.parse(input.observedAt) + 5000).toISOString(),
              binding = {
                productAggregateVersion: c.expectedProductAggregateVersion,
                contentDigest: c.contentDigest,
                configurationDigest: c.configurationDigest,
                scopeDigest: hash(c.scopeSet),
                periodDigest: hash(c.effectivePeriod),
              };
            const validation = {
              ...binding,
              evidenceReference: id(100000 + sequence),
              policyReference: id(51),
              policyVersion: 1,
              approvalPolicy: v2 ? "Required" : "NotRequired",
              checks: productPublicationCheckCodes.map((code) => ({
                code,
                outcome:
                  v2 && code === "ApprovalPolicy"
                    ? "Pending"
                    : warning && code === "ChangeImpact"
                      ? "Warning"
                      : "Pass",
              })),
              warningAcknowledgement: null,
              checkedAt: input.observedAt,
              validUntil: until,
              ...(v2
                ? {
                    profile: "CatalogProductPublicationValidationV2",
                    replacementIntentDigest: c.replacementIntentDigest,
                  }
                : {}),
            };
            const facts = {
              now: input.observedAt,
              ...binding,
              validation,
              approval: null,
              reviewReference: null,
              replacement: null,
            };
            if (!v2) return work(facts);
            return work(facts, {
              coverage: "Complete",
              impact: "Recorded",
              findings: warning
                ? [
                    {
                      checkCode: "ChangeImpact",
                      ruleCode: "SYNTHETIC_REFERENCE_WARNING",
                      outcome: "Warning",
                      subjectReference: c.productReference,
                      reasonCode: "SYNTHETIC_REFERENCE_WARNING",
                      references: [],
                    },
                  ]
                : [],
              sources: [
                {
                  sourceCode: "SYNTHETIC_VALIDATION",
                  sourceDigest: hash(c),
                  generation: "1",
                  relevantReferenceDigest: hash("synthetic stable reference"),
                  observedAt: input.observedAt,
                  validUntil: until,
                },
              ],
            });
          },
        },
      };
      return v2
        ? createPostgresProductPublicationStoreV2(options)
        : createPostgresProductPublicationStore(options);
    }
    const resolveEnvelope = (originalKind, originalCommand) =>
      parseCatalogProductPublicationResolutionCommand({
        profile: "CatalogProductPublicationResolutionCommandV1",
        originalKind,
        originalCommand,
      });
    function resolver(who = actor) {
      return createPostgresProductPublicationResolutionStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: who,
        clock: { now },
        transactions,
        registerBeforeCommit,
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            const state = states.get(tx);
            assert(state);
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION");
            assert.equal(input.actorReference, who);
            assert.deepEqual(input.requiredPermissions, [
              "catalog.manage",
              "catalog.product.manage",
              "catalog.product.read",
              "catalog.product.history.read",
            ]);
            state.deadline = new Date(Date.parse(input.observedAt) + 5000).toISOString();
            if (mode === "denied" || (mode === "late-authority" && state.fenceInserted)) {
              if (state.fenceInserted) tentative = await counts(tx);
              originalDenial = new CatalogError("CATALOG_PERMISSION_DENIED");
              throw originalDenial;
            }
          },
        },
        audit: {
          create({ command, resolution }) {
            return audit(
              command.originalCommand.operationReference,
              who,
              "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
              "ProductPublicationOperation",
              command.originalCommand.operationReference,
              resolution.recordedAt,
              "ORIGINAL_OPERATION_ABANDONED",
            );
          },
        },
      });
    }
    function ackWriter() {
      return createPostgresProductPublicationWarningAcknowledgementStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions,
        registerBeforeCommit,
        contentAuthority,
        historyAuthority: contentAuthority,
        reportAuthority: contentAuthority,
        authority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
        audit: {
          create(receipt) {
            const c = receipt.command;
            return audit(
              c.operationReference,
              actor,
              "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
              "Product",
              c.productReference,
              receipt.recordedAt,
              c.reasonCode,
            );
          },
        },
        sources: {
          async withHeldCurrentObservation(_tx, input, work) {
            observationCalls++;
            if (mode === "no-sources") throw Error("Unexpected acknowledgement observation");
            const validation = {
                ...input.report.validation,
                evidenceReference: id(++sequence),
                productAggregateVersion: input.command.expectedProductAggregateVersion,
                checkedAt: input.observedAt,
                validUntil: input.validUntil,
              },
              details = {
                ...input.report.details,
                sources: input.report.details.sources.map((source) => ({
                  ...source,
                  observedAt: input.observedAt,
                  validUntil: input.validUntil,
                })),
              };
            return work(
              buildCatalogProductPublicationWarningAcknowledgementObservation({
                command: input.command,
                binding: input.report.binding,
                validation,
                details,
                policy,
                observedAt: input.observedAt,
                validUntil: input.validUntil,
              }),
            );
          },
        },
      });
    }
    const unchangedBusiness = (before, after) => {
      for (const key of [
        "operations",
        "snapshots",
        "commits",
        "revisions",
        "reports",
        "acknowledgements",
        "headers",
        "outbox",
        "roots",
        "heads",
      ])
        assert.deepEqual(after[key], before[key], key);
    };
    async function pgFailure(work, message, code = "23514") {
      let actual = null;
      try {
        await transactions.run(work);
      } catch (error) {
        actual = error;
      }
      assert(actual, "the actual PostgreSQL action must fail");
      assert.equal(actual.code, code);
      assert.equal(actual.message, message);
      assert.equal(lastTransaction.sqlError, actual);
      return actual;
    }
    function fenceBinds(originalKind, originalCommand) {
      const envelope = resolveEnvelope(originalKind, originalCommand),
        result = buildCatalogProductPublicationResolution(envelope, "Abandoned", now());
      return [
        catalogProductPublicationResolutionNamespace(originalKind),
        originalCommand.operationReference,
        tenant,
        brand,
        originalCommand.productReference,
        originalCommand.versionReference,
        originalCommand.actorReference,
        originalKind,
        result.originalIntentDigest,
        result.digest,
        result.recordedAt,
        canonicalizeRfc8785(envelope),
        canonicalizeRfc8785(result),
        id(++sequence + 700000),
      ];
    }
    async function waitForBlockedQuery() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          race.waiterPid &&
          (
            await admin.query(
              "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) blocked",
              [race.waiterPid],
            )
          ).rows[0].blocked
        )
          return;
        await setTimeout(10);
      }
      throw Error("Expected the actual competing transaction to wait on its advisory lock");
    }
    async function releaseRaceAndSettle(promises) {
      let blockedError;
      try {
        await waitForBlockedQuery();
      } catch (error) {
        blockedError = error;
      } finally {
        race.release.release();
      }
      // Always drain both real transactions before cleanup, including a failed
      // lock assertion. This prevents a detached write surviving the test body.
      const outcomes = await Promise.allSettled(promises);
      race = null;
      if (blockedError) throw blockedError;
      return outcomes.map((outcome) => {
        if (outcome.status === "rejected") throw outcome.reason;
        return outcome.value;
      });
    }
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      roleCreated = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product,rms_catalog.product_source_head,rms_catalog.product_version,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_publication_revision,rms_catalog.product_publication_validation_report,rms_catalog.product_publication_warning_acknowledgement,rms_catalog.product_scope_retirement_header,rms_catalog.product_approval_receipt,rms_catalog.product_publication_operation_abandonment,platform_audit.audit_record,platform_eventing.outbox_event TO " +
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
      // Only these explicit grants bypass the ACL layer for immutable-trigger tests.
      await admin.query(
        "GRANT UPDATE,DELETE,TRUNCATE ON rms_catalog.product_publication_operation_abandonment TO " +
          role,
      );
      const legacyRoot = aggregate(100),
        modernRoot = aggregate(200),
        originalRaceRoot = aggregate(300),
        abandonmentRaceRoot = aggregate(400);
      for (const root of [legacyRoot, modernRoot, originalRaceRoot, abandonmentRaceRoot])
        await create(root);
      // Actual complete owning SQL inputs and final guards; authority remains
      // controlled here, and no Store applicability or professional result is asserted.
      const readTaxInputs = async ({ denyOnGuard = false, mutateRoot = false } = {}) => {
        const result = await transactions.run(async (tx) => {
          const origin = now();
          let authorityCalls = 0;
          const source = createPostgresProductTaxCoverageSourceStore({
            tenantReference: tenant,
            brandReference: brand,
            storeReference: id(40),
            actorReference: actor,
            transaction: tx,
            clock: { now },
            originalObservedAt: origin,
            originalValidUntil: new Date(Date.parse(origin) + 5000).toISOString(),
            registerBeforeCommit,
            authority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.equal(input.purposeCode, "CATALOG_PRODUCT_TAX_COVERAGE_READ");
                assert.equal(input.permission, "catalog.manage");
                if (denyOnGuard && ++authorityCalls >= 3)
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                return { validUntil: input.validUntil };
              },
            },
          });
          const packet = await source.readCurrent();
          if (mutateRoot)
            await tx.query(
              "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND product_id=$2",
              [brand, modernRoot.productReference],
            );
          return { source, tx, packet };
        });
        result.source.assertFinalized(result.tx);
        return result.packet;
      };
      const initialTaxCounts = await counts();
      const taxInputs = await readTaxInputs();
      assert.deepEqual(
        taxInputs.entries.map((entry) => entry.productReference),
        [legacyRoot, modernRoot, originalRaceRoot, abandonmentRaceRoot].map(
          (root) => root.productReference,
        ),
      );
      assert.equal(taxInputs.completeness, "Incomplete");
      assert.equal(taxInputs.missingClassifications.length, 4);
      assert.equal(taxInputs.sellability, "NotEvaluated");
      assert.equal(taxInputs.sourceQualification, "NotEvaluated");
      assert(taxInputs.entries.every((entry) => entry.publicationCoverage === null));
      assert.equal((await readTaxInputs()).sourceDigest, taxInputs.sourceDigest);
      assert.deepEqual(await counts(), initialTaxCounts);
      await assert.rejects(
        readTaxInputs({ denyOnGuard: true }),
        (error) => error?.code === "CATALOG_PERMISSION_DENIED",
      );
      await assert.rejects(
        readTaxInputs({ mutateRoot: true }),
        (error) => error?.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await counts(), initialTaxCounts);
      const originalV1 = publicationCommand(legacyRoot, null, false),
        legacy = await writer(false).execute(originalV1),
        originalV2 = publicationCommand(modernRoot),
        modern = await writer(true, true).execute(originalV2);
      assert.equal(modern.validationReport.status, "Recorded");
      const report = modern.validationReport.report;
      assert.equal(report.details.coverage, "Complete");
      assert(report.warningBindingDigest);
      const ack = parseCatalogProductPublicationWarningAcknowledgementCommand({
        profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
        action: "AcknowledgeProductPublicationWarnings",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        operationReference: id(++sequence),
        productReference: modernRoot.productReference,
        versionReference: modernRoot.draft.versionReference,
        expectedProductAggregateVersion: modern.aggregate.aggregateVersion,
        reportOperationReference: report.operationReference,
        reportDigest: report.digest,
        warningBindingDigest: report.warningBindingDigest,
        warningCodes: ["ChangeImpact"],
        reasonCode: "SYNTHETIC_EXPLICIT_CONSENT",
        occurredAt: now(),
      });
      await ackWriter().execute(ack);
      assert(capturedAckInsert);
      const advancedLegacy = await writer(false).execute(
        publicationCommand(legacy.aggregate, legacy.publication, false),
      );
      const recordedTaxCounts = await counts();
      const recordedTaxInputs = await readTaxInputs();
      assert.notEqual(recordedTaxInputs.sourceDigest, taxInputs.sourceDigest);
      assert.equal(
        recordedTaxInputs.entries.find(
          (entry) => entry.productReference === legacyRoot.productReference,
        )?.publicationCoverage?.history.length,
        2,
      );
      assert.equal(
        recordedTaxInputs.entries.find(
          (entry) => entry.productReference === modernRoot.productReference,
        )?.publicationCoverage?.history.length,
        1,
      );
      assert.equal((await readTaxInputs()).sourceDigest, recordedTaxInputs.sourceDigest);
      assert.deepEqual(await counts(), recordedTaxCounts);
      const qualificationBefore = { sourceCalls, policyCalls, observationCalls },
        beforeCommitted = await counts();
      mode = "no-sources";
      for (const [kind, original, version] of [
        ["PublicationV1", originalV1, advancedLegacy.aggregate.aggregateVersion],
        ["PublicationV2", originalV2, modern.aggregate.aggregateVersion],
        ["WarningAcknowledgementV1", ack, modern.aggregate.aggregateVersion],
      ]) {
        const command = resolveEnvelope(kind, original),
          first = await resolver().execute(command),
          replay = await resolver().execute(command);
        assert.equal(first.resolution.outcome, "Committed");
        assert.equal(first.resolution.originalIntentDigest, hash(original));
        assert.equal(first.currentAggregateVersion, version);
        assert.deepEqual(replay, first);
      }
      assert.deepEqual({ sourceCalls, policyCalls, observationCalls }, qualificationBefore);
      assert.deepEqual(await counts(), beforeCommitted);
      // Wrong original intent/Actor must remain a conflict, never an absence fence.
      for (const change of [{ reasonCode: "DIFFERENT" }, { actorReference: id(99) }]) {
        const altered = parseProductPublicationCommandV2({ ...originalV2, ...change });
        await assert.rejects(
          resolver(altered.actorReference).execute(resolveEnvelope("PublicationV2", altered)),
          { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
        );
      }
      assert.deepEqual(await counts(), beforeCommitted);
      // The old expected root is intentionally stale. Authoritative absence is
      // resolved under the original namespace locks, without running qualification.
      const absent = publicationCommand(modernRoot),
        absentEnvelope = resolveEnvelope("PublicationV2", absent),
        beforeAbsent = await counts(),
        abandoned = await resolver().execute(absentEnvelope);
      assert.equal(abandoned.resolution.outcome, "Abandoned");
      assert.equal(abandoned.currentAggregateVersion, modern.aggregate.aggregateVersion);
      const afterAbsent = await counts();
      unchangedBusiness(beforeAbsent, afterAbsent);
      assert.equal(afterAbsent.fences, beforeAbsent.fences + 1);
      assert.equal(afterAbsent.audit, beforeAbsent.audit + 1);
      // Simulate a lost response by resolving the unchanged original body again.
      assert.deepEqual(await resolver().execute(absentEnvelope), abandoned);
      assert.deepEqual(await counts(), afterAbsent);
      await assert.rejects(writer().execute(absent), { code: "CATALOG_IDEMPOTENCY_CONFLICT" });
      await assert.rejects(writer().execute({ ...absent, reasonCode: "LATE_DIFFERENT_INTENT" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      const unexecutedAck = parseCatalogProductPublicationWarningAcknowledgementCommand({
        ...ack,
        operationReference: id(++sequence),
      });
      await resolver().execute(resolveEnvelope("WarningAcknowledgementV1", unexecutedAck));
      await assert.rejects(ackWriter().execute(unexecutedAck), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual({ sourceCalls, policyCalls, observationCalls }, qualificationBefore);
      mode = "normal";
      // DB exclusion in both directions, independently of application prechecks.
      await pgFailure(
        (tx) => tx.query(fenceInsert, fenceBinds("PublicationV2", originalV2)),
        "PRODUCT_PUBLICATION_OPERATION_COMMITTED",
      );
      await pgFailure(
        (tx) => tx.query(fenceInsert, fenceBinds("WarningAcknowledgementV1", ack)),
        "PRODUCT_PUBLICATION_OPERATION_COMMITTED",
      );
      for (const tenantContext of ["", id(98)]) {
        await pgFailure(async (tx) => {
          await tx.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantContext]);
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int count FROM rms_catalog.product_publication_operation_abandonment",
                [],
              )
            ).rows[0].count,
            0,
          );
          // The Brand-only legacy operation table can be written under this
          // context, but its fixed trigger must still see the hidden Tenant fence.
          return tx.query(
            "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'ProductPublication',$4,$5,$6)",
            [
              absent.operationReference,
              brand,
              absent.productReference,
              hash("late other intent"),
              modern.aggregate.aggregateVersion + 1,
              now(),
            ],
          );
        }, "PRODUCT_PUBLICATION_OPERATION_ABANDONED");
      }
      // This is an exclusion probe with deliberately different stored intent,
      // not a new valid consent receipt: the fence must reject before coherence.
      const directAck = [...capturedAckInsert.values];
      directAck[0] = unexecutedAck.operationReference;
      await pgFailure(
        (tx) => tx.query(capturedAckInsert.sql, directAck),
        "PRODUCT_PUBLICATION_OPERATION_ABANDONED",
      );
      for (const sql of [
        "UPDATE rms_catalog.product_publication_operation_abandonment SET recorded_at=recorded_at",
        "DELETE FROM rms_catalog.product_publication_operation_abandonment",
        "TRUNCATE rms_catalog.product_publication_operation_abandonment",
      ])
        await pgFailure((tx) => tx.query(sql, []), "PRODUCT_PUBLICATION_IMMUTABLE", "55000");
      for (const [scopeTenant, scopeBrand, scopeStore] of [
        [id(98), brand, ""],
        [tenant, id(97), ""],
        [tenant, brand, id(40)],
      ])
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scopeTenant, scopeBrand, scopeStore],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int count FROM rms_catalog.product_publication_operation_abandonment",
                [],
              )
            ).rows[0].count,
            0,
          );
        });
      // First actual writer holds the Brand lock through COMMIT. The competing
      // resolver waits and then recovers its real original receipt.
      const racedOriginal = publicationCommand(originalRaceRoot);
      race = {
        operation: racedOriginal.operationReference,
        holdSql: "INSERT INTO rms_catalog.product_operation_record",
        entered: latch(),
        release: latch(),
        holderPid: null,
        waiterPid: null,
      };
      const originalPromise = writer().execute(racedOriginal);
      await race.entered.promise;
      const resolutionPromise = resolver().execute(resolveEnvelope("PublicationV2", racedOriginal));
      const [racedWrite, racedResolution] = await releaseRaceAndSettle([
        originalPromise,
        resolutionPromise,
      ]);
      assert.equal(racedWrite.status, "Applied");
      assert.equal(racedResolution.resolution.outcome, "Committed");
      // Reverse order: the permanent fence commits first. Late original fails
      // before its facts callback, with no Product business write.
      const racedAbandon = publicationCommand(abandonmentRaceRoot),
        beforeRace = await counts(),
        beforeRaceFacts = sourceCalls;
      race = {
        operation: racedAbandon.operationReference,
        holdSql: "INSERT INTO rms_catalog.product_publication_operation_abandonment",
        entered: latch(),
        release: latch(),
        holderPid: null,
        waiterPid: null,
      };
      const abandonPromise = resolver().execute(resolveEnvelope("PublicationV2", racedAbandon));
      await race.entered.promise;
      const latePromise = writer()
        .execute(racedAbandon)
        .then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error }),
        );
      const [won, lost] = await releaseRaceAndSettle([abandonPromise, latePromise]);
      assert.equal(won.resolution.outcome, "Abandoned");
      assert.equal(lost.error?.code, "CATALOG_IDEMPOTENCY_CONFLICT");
      assert.equal(lost.value, null);
      assert.equal(sourceCalls, beforeRaceFacts);
      const afterRace = await counts();
      unchangedBusiness(beforeRace, afterRace);
      assert.equal(afterRace.fences, beforeRace.fences + 1);
      assert.equal(afterRace.audit, beforeRace.audit + 1);
      for (const negative of ["denied", "late-authority", "later-guard-expiry"]) {
        const c = publicationCommand(modernRoot),
          before = await counts();
        mode = negative;
        tentative = null;
        originalDenial = null;
        let actual = null;
        try {
          await resolver().execute(resolveEnvelope("PublicationV2", c));
        } catch (error) {
          actual = error;
        }
        const state = lastTransaction;
        mode = "normal";
        forcedClock = null;
        assert(actual instanceof CatalogError);
        assert.equal(
          actual.code,
          negative === "later-guard-expiry"
            ? "CATALOG_DEPENDENCY_UNAVAILABLE"
            : "CATALOG_PERMISSION_DENIED",
        );
        if (negative === "denied") {
          assert.equal(state.fenceInserted, false);
          assert.equal(actual, originalDenial);
        } else {
          assert.equal(state.fenceInserted, true);
          assert(tentative);
          assert.equal(tentative.fences, before.fences + 1);
          assert.equal(tentative.audit, before.audit + 1);
          unchangedBusiness(before, tentative);
          if (negative === "late-authority") assert.equal(actual, originalDenial);
          else {
            assert.equal(state.workReturned, true);
            assert.equal(state.constraintsCompleted, true);
            assert.equal(state.guards.length, 1);
            const evidence = state.guards[0].evidence;
            assert.equal(evidence.asyncReturned, true);
            assert.equal(evidence.finalEntered, true);
            assert.equal(evidence.finalReturned, false);
            assert.equal(evidence.finalError, actual);
          }
        }
        assert.deepEqual(await counts(), before);
      }
      const auditRow = (
        await admin.query(
          "SELECT action_code,target_type,target_id,reason_code FROM platform_audit.audit_record WHERE audit_id=$1",
          [id(Number.parseInt(absent.operationReference.slice(-12), 16) + 500000)],
        )
      ).rows[0];
      assert.deepEqual(auditRow, {
        action_code: "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
        target_type: "ProductPublicationOperation",
        target_id: absent.operationReference,
        reason_code: "ORIGINAL_OPERATION_ABANDONED",
      });
    } finally {
      if (race) race.release.release();
      if (roleCreated) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}
