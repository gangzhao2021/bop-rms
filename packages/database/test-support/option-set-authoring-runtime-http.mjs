import assert from "node:assert/strict";
import { exerciseProductPublicationActions } from "./product-full-publication-runtime-http.mjs";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  parseProductAggregate,
  parseProductPublicationVersionV2,
  parseProductPublicationCommandV2,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationValidationReportView,
  parseCatalogProductPublicationManagementV2,
} from "../../rms/catalog/src/index.ts";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotInstallation } from "../../../tooling/environment/pilot-installation.mjs";
import { createInternalCredentialLoaders } from "../../../tooling/environment/pilot-credentials.mjs";
import { composeMerchantDependencies } from "../../../tooling/environment/pilot-merchant-composition.mjs";
import { createInternalMerchantProduct } from "../../../tooling/environment/pilot-merchant-product.mjs";
import {
  createProductCommandClient,
  ProductCommandClientError,
} from "../../../apps/merchant-web/src/catalog-product-command-client.ts";
import {
  createProductAuthoringRecoveryClient,
  parseProductAuthoringCursor,
} from "../../../apps/merchant-web/src/product-authoring-recovery-client.ts";
import {
  createPostgresProductContentRegistryStore,
  createPostgresProductTaxClassificationRegistryStore,
  catalogProductTaxClassificationRegistryDigest,
  taxClassificationRegistryFields,
} from "../../rms/catalog/src/index.ts";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout as startTimer, clearTimeout as stopTimer } from "node:timers";
import { request as httpRequest } from "node:http";
import { createApp } from "../../../apps/api/dist/app.js";
import { createPersistentMerchantBffService } from "../../../apps/api/dist/persistent-merchant-bff.js";
import { createMerchantOptionSetAuthoringCommand } from "../../../apps/api/dist/merchant-option-set-authoring-command.js";
import { createMerchantOptionSetPublicationContextQuery } from "../../../apps/api/dist/merchant-option-set-publication-context-query.js";
import { createMerchantOptionSetHistoryQuery } from "../../../apps/api/dist/merchant-option-set-history-query.js";
import { createMerchantOptionSetCurrentPublicationQuery } from "../../../apps/api/dist/merchant-option-set-current-publication-query.js";
import { createMerchantOptionSetEditorQuery } from "../../../apps/api/dist/merchant-option-set-editor-query.js";
import { createMerchantOptionSetAuthoringResolutionCommand } from "../../../apps/api/dist/merchant-option-set-authoring-resolution-command.js";
import { createMerchantOptionSetAuthoringContextQuery } from "../../../apps/api/dist/merchant-option-set-authoring-context-query.js";
import { createMerchantStoreCapability } from "../../../apps/api/dist/merchant-store-capability.js";
import { createMerchantOptionSetListQuery } from "../../../apps/api/dist/merchant-option-set-list-query.js";
import { createMerchantOptionSetPublicationCommand } from "../../../apps/api/dist/merchant-option-set-publication-command.js";
import { createMerchantOptionSetPublicationResolutionCommand } from "../../../apps/api/dist/merchant-option-set-publication-resolution-command.js";
import {
  createCurrencyMetadataSnapshot,
  createPostgresCurrentOptionPriceStore,
  resolveOptionPrice,
} from "../../rms/pricing/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
  publishingOptionPricePublicationPolicyDigest,
} from "../../bop/publishing/src/index.ts";
import { tenantBrandConfigurationContentDigest } from "../../bop/tenant/src/index.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
const id = (n) => "01902421-7800-7000-8000-" + n.toString(16).padStart(12, "0");
/** Actual application HTTP, encrypted persisted Session, selected Store,
 * current Membership/Permission/Feature and owning SQL/guards. Initial User/OIDC
 * origin and governance configuration are explicitly synthetic; no positive
 * authorization callback replaces IAM. Includes live partial authoring List and actual two-User independent approval and delayed qualified publication. Governance
 * seed decisions are synthetic; ordinary commands use actual IAM/source acquisition.
 * This helper is not rendered UI or external OIDC/production evidence. */
export async function exerciseOptionSetAuthoringRuntimeHttp(context, selection = {}) {
  assert.deepEqual(Object.keys(selection), selection.workflow === undefined ? [] : ["workflow"]);
  const workflow = selection.workflow ?? "AuthoringAndBindings";
  assert(
    [
      "AuthoringAndBindings",
      "ProductCurrentPublishedPublication",
      "OptionPricePublication",
    ].includes(workflow),
  );
  const publicationOnly = workflow === "ProductCurrentPublishedPublication";
  const optionPriceOnly = workflow === "OptionPricePublication";
  let optionPriceConfiguration = null;
  let enableOptionPrice = null;
  const admin = new pg.Client(context.clientConfig);
  await admin.connect();
  const role = "wp2421_opt_http_" + context.runId;
  assert.match(role, /^wp2421_opt_http_[a-f0-9]+$/u);
  const tenant = id(1),
    brand = id(2),
    storeReference = id(3),
    actor = id(4),
    reviewer = id(5),
    at = new Date().toISOString(),
    from = new Date(Date.parse(at) - 60000).toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString();
  let sequence = 100,
    createdRole = false,
    server = null,
    reviewerServer = null,
    priceInstallationDirectory = null,
    phase = "Setup",
    sqlState = null,
    transactionFailureClass = "UNOBSERVED",
    transactionFailureCode = "UNOBSERVED",
    transactionFailureSites = "UNOBSERVED",
    transactionGuardPhase = "UNOBSERVED",
    lastPublicationCommandClock = null,
    transactionElapsedMs = null,
    transactionSqlFamily = "UNOBSERVED",
    transactionConstraintReason = "UNOBSERVED",
    transactionQueryStats = "UNOBSERVED",
    contextPause = null,
    publicationContextHttpStatus = null,
    publicationContextHttpCode = "UNOBSERVED",
    publicationHttpStatus = null,
    publicationHttpCode = "UNOBSERVED",
    productHttpStatus = "UNOBSERVED",
    productHttpCode = "UNOBSERVED",
    productStage = "NotStarted",
    productPortFailureClass = "UNOBSERVED",
    productPortFailureCode = "UNOBSERVED",
    productPortFailureSites = "UNOBSERVED",
    productPortFailurePhase = "UNOBSERVED",
    productTransactionFailed = false,
    failAfterPublicationTerminal = false,
    revocationRows = null,
    revokedSessionState = "UNOBSERVED",
    revocationHttpStatus = null,
    revocationHttpCode = "UNOBSERVED";
  const reference = () => id(++sequence),
    now = () => new Date().toISOString();
  const boundedPause = async (promise, milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = startTimer(
            () => reject(new Error("SYNTHETIC_CONTEXT_PAUSE_TIMEOUT")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      stopTimer(timer);
    }
  };
  const taxSetupGuards = new WeakMap();
  const transactions = {
    async run(work) {
      const client = new pg.Client({
        ...context.clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
      });
      await client.connect();
      const transactionStarted = Date.now();
      let transactionIdentity;
      let sqlFamily = "Setup";
      const queryStats = Object.fromEntries(
        ["IAM", "Scope", "Feature", "Catalog", "Publishing", "Other"].map((family) => [
          family,
          { count: 0, elapsedMs: 0 },
        ]),
      );
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        const tx = {
          query: async (sql, values = []) => {
            try {
              sqlFamily = sql.includes("CatalogOptionCurrentReview")
                ? "ReviewLiteral"
                : String(values[0] ?? "").startsWith("CatalogOptionCurrentReview:")
                  ? sql.includes("lock_shared")
                    ? "CurrentReviewShared"
                    : "CurrentReviewExclusive"
                  : sql.includes("publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE")
                    ? "PublishingWriteAdmission"
                    : sql.startsWith("INSERT INTO bop_publishing.option_set_publication_operation")
                      ? "TerminalAppend"
                      : sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")
                        ? "PublishingMutationAppend"
                        : sql.startsWith("INSERT INTO platform_audit.audit_record")
                          ? "AuditAppend"
                          : sql.includes("FROM bop_publishing.publishing_mutation_record")
                            ? "PublishingHistoryRead"
                            : sql.includes("option_set_review_content")
                              ? "CatalogReview"
                              : "OtherOwnerSql";
              const pause = contextPause;
              if (
                pause &&
                sql === "SELECT pg_advisory_xact_lock(hashtextextended($1,0))" &&
                values[0] === pause.key
              )
                pause.writerPid = client.processID;
              if (
                pause &&
                client.processID === pause.writerPid &&
                sql.includes("publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE")
              )
                pause.publishingSreAttempted = true;
              const measuredFamily = /bop_(?:identity|membership|permission)\./u.test(sql)
                ? "IAM"
                : sql.includes("set_config(") || /(?:bop_tenant|bop_store|rms_store)\./u.test(sql)
                  ? "Scope"
                  : sql.includes("bop_feature_control.")
                    ? "Feature"
                    : sql.includes("rms_catalog.")
                      ? "Catalog"
                      : sql.includes("bop_publishing.")
                        ? "Publishing"
                        : "Other";
              const observation = queryStats[measuredFamily],
                queryStarted = Date.now();
              let result;
              try {
                result = await client.query(sql, [...values]);
              } finally {
                observation.count++;
                observation.elapsedMs += Date.now() - queryStarted;
              }
              // Pause only after the real current Review shared lock succeeds.
              // The captured query port and all source clocks/guards stay intact.
              if (
                pause &&
                !pause.used &&
                sql === "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))" &&
                values[0] === pause.key
              ) {
                pause.used = true;
                pause.contextPid = client.processID;
                pause.entered();
                await boundedPause(pause.resume, 3000);
              }
              if (
                failAfterPublicationTerminal &&
                sql.startsWith("INSERT INTO bop_publishing.option_set_publication_operation")
              ) {
                failAfterPublicationTerminal = false;
                throw new Error("SYNTHETIC_AFTER_TERMINAL_IO_FAILURE");
              }
              return result;
            } catch (error) {
              if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code))
                sqlState = error.code;
              throw error;
            }
          },
        };
        transactionIdentity = tx;
        const result = await work(tx);
        sqlFamily = "DeferredConstraints";
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        // Only the explicit synthetic Tax registry setup registers these hooks.
        // All other transactions retain their original host finalization path.
        const taxSetup = taxSetupGuards.get(tx);
        if (taxSetup) {
          assert.equal(taxSetup.entries.length, 1);
          taxSetup.phase = "guards";
          for (const entry of taxSetup.entries) assert.equal(await entry.guard(), undefined);
          taxSetup.phase = "final";
          for (const entry of taxSetup.entries) assert.equal(entry.finalAssert(), undefined);
          taxSetupGuards.delete(tx);
        }
        sqlFamily = "Commit";
        await client.query("COMMIT");
        return result;
      } catch (error) {
        // Finalization uses the real client outside the guarded query port.
        // Retain only the fixed SQLSTATE code, never raw database diagnostics.
        if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code))
          sqlState = error.code;
        const productFailurePhase = [
          "ProductPublishedOptionBinding",
          "ProductPinnedOptionBinding",
          "ProductOptionPublishedHeadAdvance",
        ].includes(phase);
        if (
          phase.startsWith("Publication") ||
          phase.startsWith("ProductCurrentPublishedPublication:") ||
          phase.startsWith("OptionPricePublication:") ||
          productFailurePhase
        ) {
          if (productFailurePhase) productTransactionFailed = true;
          const constraintReasons = new Map([
            ["Option price version has no original terminal", "PriceVersionTerminalMissing"],
            ["incoherent Option price original identity", "PriceOriginalIdentityIncoherent"],
            ["incoherent Option price abandoned original", "PriceAbandonedIncoherent"],
            ["incoherent Option price committed original", "PriceCommittedIncoherent"],
            ["OPTION_SET_REVIEW_SOURCE_INCOHERENT", "ReviewSourceIncoherent"],
            ["OPTION_SET_RELEASE_SOURCE_INCOHERENT", "ReleaseSourceIncoherent"],
            ["OPTION_SET_CONTENT_COMMIT_CONFLICT", "ContentCommitConflict"],
            ["OPTION_SET_VERSION_CONTENT_CONFLICT", "VersionContentConflict"],
            ["OPTION_SET_OPTION_CONTENT_CONFLICT", "OptionContentConflict"],
            ["OPTION_SET_SOURCE_UNAVAILABLE", "SealSourceUnavailable"],
            ["OPTION_SET_SUCCESSOR_CONFLICT", "SuccessorConflict"],
            ["OPTION_SET_FROZEN_CONTENT_MISSING", "FrozenContentMissing"],
            ["OPTION_SET_SUCCESSOR_PARENT_CONFLICT", "SuccessorParentConflict"],
            [
              "Qualified Option Publish requires its original terminal identity",
              "QualifiedTerminalLinkage",
            ],
          ]);
          transactionConstraintReason = constraintReasons.get(error?.message) ?? "OtherConstraint";
          transactionFailureClass = [
            "CatalogError",
            "PublishingContractError",
            "PublishingDomainError",
            "PublishingStoreError",
            "BrowserSessionError",
            "OptionPriceAuthoringError",
            "OptionPriceError",
            "PermissionContractError",
            "TypeError",
            "ReferenceError",
            "RangeError",
            "SyntaxError",
            "Error",
          ].includes(error?.name)
            ? error.name
            : "OTHER";
          transactionFailureCode =
            typeof error?.code === "string" &&
            /^(?:CATALOG|PUBLISHING|BROWSER_SESSION|OPTION_PRICE|PRICING|PERMISSION)_[A-Z_]{1,80}$/u.test(
              error.code,
            )
              ? error.code
              : "NONE";
          const frames =
            typeof error?.stack === "string" ? error.stack.split("\n").slice(1, 33) : [];
          transactionGuardPhase = frames.some((frame) =>
            /merchant-category-transactions\.(?:js|ts):\d+:/u.test(frame),
          )
            ? "HostFramePresent"
            : "OtherFailurePhase";
          const sites = frames
            .flatMap((frame) => {
              const match = frame.match(
                /(?:\/|\\)((?:merchant-option-price-(?:context|authoring-command|review-command|publication-authority)|option-price-(?:authoring|review-operation)-store|merchant-option-set-publication-[a-z-]+|current-option-set-publication-[a-z-]+|option-set-publication-operation-store|option-set-full-draft-store|option-set-review-content-store|publishing-mutation-store|merchant-category-transactions|merchant-product-draft-command|merchant-product-editor-runtime-brand-sources|frozen-full-option-binding-rule-source|merchant-product-editor-(?:content|selling-unit|registered-content|pinned-option|policy-content|variant-history)-authority|current-published-(?:product-option-binding-source|option-set-graph)|product-(?:lifecycle|draft-baseline|editor-source|reference-history-source|content-registry|authoring-resolution)-store|merchant-product-publication-(?:command-v2|sources|runtime-sources|runtime-authority|content-authority-v2|warning-acknowledgement-command)|current-product-publication-(?:option-selection|tax-resolution|content-policy|scope|registered-content|media|variant-mapping|policy)|product-publication-(?:store|source-store|warning-acknowledgement-store|validation-report-store))\.(?:ts|js)):(\d+):\d+/u,
              );
              return match ? [match[1] + ":" + match[2]] : [];
            })
            .slice(0, 5);
          transactionFailureSites = sites.length ? sites.join(",") : "UNLOCATED";
          transactionElapsedMs = Date.now() - transactionStarted;
          transactionSqlFamily = sqlFamily;
          transactionQueryStats = JSON.stringify(queryStats);
        }
        await client.query("ROLLBACK");
        throw error;
      } finally {
        if (transactionIdentity) taxSetupGuards.delete(transactionIdentity);
        await client.end();
      }
    },
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_catalog.option_set WHERE brand_id=$1) sets,(SELECT count(*)::int FROM rms_catalog.option_set_operation_record WHERE brand_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.option_set_draft_content_snapshot WHERE brand_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.option_set_authoring_identity WHERE brand_id=$1) identities,(SELECT count(*)::int FROM rms_catalog.option_set_authoring_abandonment WHERE brand_id=$1) fences,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id IN(SELECT option_set_id FROM rms_catalog.option_set WHERE brand_id=$1)) outbox",
        [brand],
      )
    ).rows[0];
  const grants = new Map();
  const grantedActionsByRole = new Map();
  let brandRole;
  async function grant(action, targetRole = brandRole) {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = reference();
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    const grantId = reference();
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
      [grantId, targetRole, permission, brand, from, until],
    );
    if (targetRole === brandRole) grants.set(action, grantId);
    const grantedActions = grantedActionsByRole.get(targetRole) ?? new Set();
    grantedActions.add(action);
    grantedActionsByRole.set(targetRole, grantedActions);
  }
  async function feature(key, value) {
    const latest = (
      await admin.query(
        "SELECT control_id,control_version FROM bop_feature_control.control_version WHERE brand_id=$1 AND store_id IS NULL AND control_key=$2 ORDER BY control_version DESC LIMIT 1",
        [brand, key],
      )
    ).rows[0];
    const recordedAt = now();
    await admin.query(
      "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,$3,$4,'Synthetic Option HTTP capability',$5,'PRODUCT_CAPABILITY','BrandOverride','Disabled',$6,'Published',false,$7,NULL,$8,NULL,$5,$9,$10,$11,$7,'ConfigurationMetadata')",
      [
        latest?.control_id ?? reference(),
        brand,
        key,
        Number(latest?.control_version ?? 0) + 1,
        actor,
        value,
        recordedAt,
        until,
        reviewer,
        reference(),
        reference(),
      ],
    );
  }
  async function seedPublicationGovernance() {
    // Synthetic governance setup uses real public owning commit histories, not
    // ordinary-flow permission callbacks or fabricated Published source packets.
    phase = "PublicationGovernanceSeed";
    const seedAt = now(),
      scope = { kind: "Brand", brandReference: brand, storeReference: null };
    const policy = {
      profile: "PublishingOptionSetPublicationPolicyV1",
      tenantReference: tenant,
      brandReference: brand,
      familyReference: reference(),
      policyReference: reference(),
      policyVersion: 1,
      scopeOrder: optionSetPolicyScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: from,
      effectiveUntil: null,
    };
    async function publishConfiguration(family, snapshot, digest, type, extra = {}) {
      return transactions.run(async (tx) => {
        const publisher = createPostgresPublishingMutationStore(
          { run: (work) => work(tx) },
          tenant,
          scope,
        );
        const draft = {
          lifecycleId: reference(),
          familyReference: family,
          configurationType: type,
          purposeCode: type,
          snapshotReference: snapshot,
          snapshotDigest: digest,
          scope,
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: seedAt,
          changedAt: seedAt,
        };
        const validation = {
          evidenceReference: reference(),
          snapshotReference: snapshot,
          snapshotDigest: digest,
          scope,
          result: "Pass",
          checkedAt: seedAt,
          validUntil: new Date(Date.parse(seedAt) + 60000).toISOString(),
          checkCodes: ["SYNTHETIC_GOVERNANCE_VALIDATION"],
        };
        const review = {
          ...draft,
          version: 2,
          state: "InReview",
          validationEvidenceReference: validation.evidenceReference,
        };
        const approval = {
          evidenceReference: reference(),
          reviewLifecycleId: draft.lifecycleId,
          reviewVersion: 2,
          snapshotReference: snapshot,
          snapshotDigest: digest,
          scope,
          decision: "Accepted",
          approvedActorReference: reviewer,
          approvedAt: seedAt,
          validUntil: validation.validUntil,
        };
        const approved = {
          ...review,
          version: 3,
          state: "Approved",
          approvalEvidenceReference: approval.evidenceReference,
        };
        const release = {
          releaseId: reference(),
          familyReference: family,
          configurationType: type,
          purposeCode: type,
          snapshotReference: snapshot,
          snapshotDigest: digest,
          scope,
          sequence: 1,
          sourceLifecycleId: draft.lifecycleId,
          kind: "Publish",
          previousReleaseId: null,
          createdAt: seedAt,
        };
        async function step(operation, current, next, evidence = {}) {
          const op = reference();
          await publisher.commit({
            operation,
            expectedVersion: current?.version ?? 1,
            idempotencyKey: op,
            current,
            next,
            release: null,
            supersededReleaseId: null,
            rollbackTargetReleaseId: null,
            validationEvidence: null,
            approvalEvidence: null,
            audit: {
              auditId: reference(),
              brandId: brand,
              actor: { type: "User", reference: operation === "Approve" ? reviewer : actor },
              actionCode: {
                CreateDraft: "PUBLISHING_DRAFT_CREATED",
                SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
                Approve: "PUBLISHING_REVIEW_APPROVED",
                Publish: "PUBLISHING_RELEASE_PUBLISHED",
              }[operation],
              targetType: "PublishingLifecycle",
              targetId: draft.lifecycleId,
              reasonCode: "SYNTHETIC_GOVERNANCE_SEED",
              correlationId: op,
              occurredAt: seedAt,
              sourceChannel: "API",
              dataClassification: "Confidential",
              retentionPolicyCode: "AUDIT_SECURITY",
              retentionPolicyVersion: 1,
            },
            ...evidence,
          });
        }
        await step("CreateDraft", null, draft, extra);
        await step("SubmitReview", draft, review, { validationEvidence: validation });
        await step("Approve", review, approved, { approvalEvidence: approval });
        await step(
          "Publish",
          approved,
          { ...approved, version: 4, state: "Published" },
          { release, validationEvidence: validation, approvalEvidence: approval },
        );
        return { release, approval };
      });
    }
    await publishConfiguration(
      policy.familyReference,
      policy.policyReference,
      publishingOptionSetPublicationPolicyDigest(policy),
      "OPTION_SET_PUBLICATION_POLICY",
      { optionSetPolicyContent: policy },
    );
    if (optionPriceOnly) {
      const pricePolicy = {
        profile: "PublishingOptionPricePublicationPolicyV1",
        tenantReference: tenant,
        brandReference: brand,
        familyReference: reference(),
        policyReference: reference(),
        policyVersion: 1,
        approvalPolicy: "Required",
        effectiveFrom: from,
        effectiveUntil: until,
      };
      await publishConfiguration(
        pricePolicy.familyReference,
        pricePolicy.policyReference,
        publishingOptionPricePublicationPolicyDigest(pricePolicy),
        "OPTION_PRICE_PUBLICATION_POLICY",
        { optionPricePolicyContent: pricePolicy },
      );
      const currencyMetadata = createCurrencyMetadataSnapshot({
        currencyCode: "CAD",
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: reference(),
        metadataDigest:
          "sha256:" + sha256Hex(canonicalizeRfc8785({ currencyCode: "CAD", minorUnitExponent: 2 })),
      });
      // Explicit synthetic server currency configuration; no FX/tax/legal fact.
      optionPriceConfiguration = {
        currencyMetadata,
        publicationPolicyFamilyReference: pricePolicy.familyReference,
        references: { generate: () => reference() },
      };
    }
    const productPolicy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: tenant,
      brandReference: brand,
      familyReference: reference(),
      policyReference: reference(),
      policyVersion: 1,
      scopeOrder: productPolicyScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: from,
      effectiveUntil: null,
    };
    await publishConfiguration(
      productPolicy.familyReference,
      productPolicy.policyReference,
      publishingProductPublicationPolicyDigest(productPolicy),
      "PRODUCT_PUBLICATION_POLICY",
      { productPolicyContent: productPolicy },
    );
    const configuration = {
      configurationVersionReference: reference(),
      brandReference: brand,
      configurationVersion: 1,
      lifecycle: "Draft",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA"],
      mediaThemeReference: null,
      catalogSourceReference: reference(),
      platformTemplateReference: reference(),
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: [],
      effectiveFrom: from,
      effectiveUntil: null,
      supersedesVersionReference: null,
      reasonCode: "SYNTHETIC_OPTION_NATIVE",
      authoredByReference: actor,
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
      createdAt: seedAt,
      updatedAt: seedAt,
      dataClassification: "ConfigurationMetadata",
    };
    const published = await publishConfiguration(
      reference(),
      configuration.configurationVersionReference,
      tenantBrandConfigurationContentDigest(configuration),
      "BRAND_CONFIGURATION",
    );
    const final = {
      ...configuration,
      lifecycle: "Published",
      approvedByReference: reviewer,
      approvalEvidenceReference: published.approval.evidenceReference,
      publicationReference: published.release.releaseId,
    };
    assert.equal(tenantBrandConfigurationContentDigest(final), published.release.snapshotDigest);
    await admin.query(
      "INSERT INTO bop_tenant.brand_configuration_version(configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)",
      [
        final.configurationVersionReference,
        brand,
        1,
        final.lifecycle,
        final.defaultLocale,
        final.supportedLocales,
        final.mediaThemeReference,
        final.catalogSourceReference,
        final.platformTemplateReference,
        final.overrideAllowedFieldCodes,
        final.hardRequirementFieldCodes,
        final.effectiveFrom,
        final.effectiveUntil,
        final.supersedesVersionReference,
        final.reasonCode,
        actor,
        reviewer,
        final.approvalEvidenceReference,
        final.publicationReference,
        seedAt,
        seedAt,
        final.dataClassification,
      ],
    );
    return {
      policyReference: policy.policyReference,
      policyVersion: 1,
      optionSetPolicyFamilyReference: policy.familyReference,
      brandConfigurationVersionReference: final.configurationVersionReference,
      expectedBrandVersion: 1,
      mediaScope: scope,
      productContentPolicy: {
        configurationVersionReference: final.configurationVersionReference,
        expectedBrandVersion: 1,
        policyReference: productPolicy.policyReference,
        policyVersion: 1,
      },
    };
  }
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_catalog,bop_publishing,platform_audit,platform_eventing,platform_helpers,bop_feature_control TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_catalog.option_set_authoring_operation_available(uuid),bop_publishing.option_set_publication_operation_available(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query("GRANT DELETE ON rms_catalog.option_conflict TO " + role);
    // Current Review absence discovery reads only this owning table; it writes no Review.
    await admin.query("GRANT SELECT ON rms_catalog.option_set_review_content TO " + role);
    // SHARE table locks require UPDATE ACL; the other four Catalog tables already
    // have it for actual writes. This fifth ACL is isolated to the acceptance role.
    await admin.query("GRANT SELECT,UPDATE ON rms_catalog.product_option_binding TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event,rms_catalog.option_set_authoring_identity,rms_catalog.option_set_authoring_abandonment TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT ON bop_feature_control.control_version,bop_feature_control.control_dependency TO " +
        role,
    );
    const session = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions,
      role,
      scope: { tenantReference: tenant, brandReference: brand, storeReference },
      actor,
      at,
      referencePrefix: "01902481",
      sessionReferencePrefix: "01902482",
    });
    const membership = (
      await admin.query(
        "SELECT membership_id FROM bop_membership.membership WHERE brand_id=$1 AND actor_id=$2",
        [brand, actor],
      )
    ).rows[0].membership_id;
    brandRole = reference();
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
      [brandRole, brand, "synthetic_option_http", from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
      [reference(), brandRole, membership, actor, brand, from, until],
    );
    for (const action of [
      "catalog.manage",
      "catalog.option_set.create",
      "catalog.option_set.update",
      "catalog.option_set.read",
    ])
      await grant(action);
    for (const key of [
      "catalog.optionset.create",
      "catalog.optionset.edit",
      "catalog.optionset.detail",
      "catalog.optionset.list",
    ])
      await feature(key, "Enabled");
    // A separate encrypted session/provider serves the genuinely independent User.
    const reviewerSession = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions,
      role,
      scope: { tenantReference: tenant, brandReference: brand, storeReference },
      actor: reviewer,
      at,
      referencePrefix: "01902483",
      sessionReferencePrefix: "01902484",
    });
    const reviewerMembership = (
      await admin.query(
        "SELECT membership_id FROM bop_membership.membership WHERE brand_id=$1 AND actor_id=$2",
        [brand, reviewer],
      )
    ).rows[0].membership_id;
    const reviewerRole = reference();
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
      [reviewerRole, brand, "synthetic_option_reviewer", from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
      [reference(), reviewerRole, reviewerMembership, reviewer, brand, from, until],
    );
    for (const action of [
      "catalog.manage",
      "catalog.option_set.read",
      "media.asset.access",
      "publishing.review.approve",
    ])
      await grant(action, reviewerRole);
    for (const action of [
      "catalog.option_set.submit",
      "catalog.option_set.publish",
      "media.asset.access",
      "publishing.draft.create",
      "publishing.review.submit",
      "publishing.review.approve",
      "publishing.release.publish",
    ])
      await grant(action);
    // Narrow isolated owner ACLs; no production grants or bypass of forced RLS.
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON bop_publishing.option_set_publication_operation,rms_catalog.option_set_review_content,rms_catalog.option_set_publication_release,rms_catalog.option_set_publication_content TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT ON bop_tenant.brand_configuration_version,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO " +
        role,
    );
    // These ACLs exist only on the isolated acceptance role. The Product
    // journey below uses the real currentRuntime; no admission result is seeded.
    await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_source_head,rms_catalog.product_content_registry_record,rms_catalog.product_authoring_operation_abandonment TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE(aggregate_version,updated_at) ON rms_catalog.product TO " + role,
    );
    await admin.query(
      "GRANT UPDATE(status,base_product_version_id,default_locale,localized_names_json,tax_classification_id,updated_at,category_classification_known,primary_category_id,editor_content_json) ON rms_catalog.product_version TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE(source_revision) ON rms_catalog.product_source_head TO " + role,
    );
    await admin.query(
      "GRANT SELECT ON rms_catalog.sku,rms_catalog.product_version_category_assignment,rms_catalog.product_publication_operation_abandonment,rms_catalog.product_publication_revision,rms_catalog.selling_unit_registry_record,rms_catalog.selling_unit_registration_abandonment,rms_catalog.product_tax_classification_registry_record TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,DELETE ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_channel,rms_catalog.product_option_binding_sku_scope TO " +
        role,
    );
    await admin.query(
      "GRANT INSERT,DELETE ON rms_catalog.product_version_category_assignment TO " + role,
    );
    await admin.query("GRANT DELETE ON rms_catalog.sku TO " + role);
    await admin.query(
      "GRANT UPDATE(product_version_id) ON rms_catalog.sku,rms_catalog.product_option_binding TO " +
        role,
    );
    for (const action of [
      "catalog.product.manage",
      "catalog.product.create",
      "catalog.product.update",
      "catalog.product.read",
      "catalog.product.history.read",
      "catalog.sku.read",
      "catalog.content-registry.read",
      "catalog.tax-classification.read",
    ])
      await grant(action);
    await feature("catalog.product.create", "Enabled");
    await feature("catalog.product.edit", "Enabled");
    if (optionPriceOnly) {
      // Activate only when this workflow reaches the owning Pricing stage.
      // Earlier Option commands still read their complete actual IAM packet.
      enableOptionPrice = async () => {
        await feature("pricing.pricebook.editor", "Enabled");
        for (const [targetRole, actions] of [
          [brandRole, ["pricing.price-book.manage", "catalog.sku.create"]],
          // Independent Pricing review reads the saved Binding source; it
          // must not require Product authoring privileges.
          [reviewerRole, ["pricing.price-book.manage", "catalog.product.read", "catalog.sku.read"]],
        ])
          for (const action of actions)
            if (!grantedActionsByRole.get(targetRole)?.has(action)) await grant(action, targetRole);
        assert.equal(grantedActionsByRole.get(reviewerRole)?.has("catalog.product.manage"), false);
        const forbidden = await admin.query(
          "SELECT count(*)::int count FROM bop_permission.permission_grant g JOIN bop_permission.permission_definition p USING(permission_id) WHERE g.role_id=$1 AND g.lifecycle='Active' AND p.action_code='catalog.product.manage'",
          [reviewerRole],
        );
        assert.equal(forbidden.rows[0].count, 0);
      };
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_pricing.option_price_authoring_operation,bop_publishing.option_price_review_operation,rms_catalog.selling_unit_registry_record,rms_catalog.selling_unit_registration_abandonment,rms_catalog.sku TO " +
          role,
      );
      // Genuine ReplaceDraft retains the owning SKU and writes these columns,
      // including its unchanged lifecycle. Match the existing full profile ACL.
      await admin.query(
        "GRANT UPDATE(lifecycle,variant_digest,localized_names_json,variant_selections_json) ON rms_catalog.sku TO " +
          role,
      );
      // The owning known-empty classification still performs SELECT FOR SHARE.
      // UPDATE is a row-lock ACL only; no Category command or fact is seeded.
      await admin.query(
        "GRANT SELECT(category_id,brand_id,lifecycle),UPDATE(lifecycle) ON rms_catalog.category TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION rms_pricing.option_price_authoring_operation_available(platform_helpers.uuid_v7,platform_helpers.uuid_v7),bop_publishing.option_price_review_operation_available(uuid) TO " +
          role,
      );
    }
    if (publicationOnly) {
      await feature("catalog.sku.detail", "Enabled");
      const publicationActions = [
        "catalog.manage",
        "catalog.product.manage",
        "catalog.product.read",
        "catalog.product.validate",
        "catalog.product.submit",
        "catalog.product.approve",
        "catalog.product.publish",
        "catalog.product.history.read",
        "catalog.product.approval.read",
        "catalog.product.acknowledge-warnings",
        "catalog.sku.read",
        "catalog.sku.create",
        "catalog.sku.activate",
        "catalog.tax-classification.read",
        "catalog.content-registry.read",
        "catalog.option_set.read",
        "media.asset.access",
        "recipe.manage",
        "inventory.item.read",
        "inventory.item.history.read",
        "pricing.price-book.manage",
        "pricing.promotion.manage",
      ];
      for (const action of publicationActions) {
        if (!grantedActionsByRole.get(brandRole)?.has(action)) await grant(action);
        if (!grantedActionsByRole.get(reviewerRole)?.has(action)) await grant(action, reviewerRole);
      }
      await admin.query("GRANT USAGE ON SCHEMA rms_recipe,rms_inventory,rms_pricing TO " + role);
      const recipeColumns = {
        recipe: "recipe_id,brand_id,aggregate_version,current_version_id,updated_at",
        recipe_version:
          "recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,effective_from,effective_until,effective_time_zone,created_at",
        recipe_reference_generation: "brand_id,generation,binding_count",
        recipe_reference_binding:
          "recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until",
        recipe_ingredient_requirement:
          "requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id",
        recipe_modifier_version:
          "rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,effective_until,occurred_at",
      };
      for (const [table, columns] of Object.entries(recipeColumns)) {
        assert.match(table, /^[a-z_]+$/u);
        assert.match(columns, /^[a-z_,]+$/u);
        await admin.query(`GRANT SELECT(${columns}) ON rms_recipe.${table} TO ${role}`);
      }
      const readTables = [
        "rms_inventory.configuration_reference_generation",
        "rms_inventory.inventory_item",
        "rms_inventory.inventory_item_version",
        "rms_inventory.inventory_item_operation",
        "rms_inventory.item_sku_mapping_version",
        ...[
          "configuration_reference_generation",
          "price_book",
          "price_book_version",
          "price_entry",
          "option_price_rule",
          "option_price_rule_version",
          "promotion",
          "promotion_version",
          "promotion_eligibility_reference",
        ].map((table) => "rms_pricing." + table),
        ...[
          "menu_reference_generation",
          "menu_review_content",
          "menu_publication_revision",
          "menu_publication_release",
          "menu_release_effective_period",
          "menu_release_effective_end",
          "bundle_reference_generation",
          "bundle",
          "bundle_version",
          "bundle_component_group",
          "bundle_component_sellable",
          "availability_rule",
          "availability_reference_generation",
        ].map((table) => "rms_catalog." + table),
      ];
      await admin.query("GRANT SELECT ON " + readTables.join(",") + " TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_publication_revision,rms_catalog.product_publication_validation_report,rms_catalog.product_publication_warning_acknowledgement,rms_catalog.product_approval_receipt,rms_catalog.product_scope_journal,rms_catalog.product_publication_content,rms_catalog.product_scope_retirement,rms_catalog.product_scope_retirement_header,rms_catalog.selling_unit_registration_abandonment,rms_catalog.selling_unit_registry_record,rms_catalog.sku TO " +
          role,
      );
      await admin.query(
        "GRANT UPDATE(lifecycle) ON rms_catalog.product,rms_catalog.sku TO " + role,
      );
      // Actual ReplaceDraft retains existing SKU rows and updates their owning
      // variant/name fields; selected full publication profile exercises that path.
      await admin.query(
        "GRANT UPDATE(variant_digest,localized_names_json,variant_selections_json) ON rms_catalog.sku TO " +
          role,
      );
    }
    const publicationOptions = await seedPublicationGovernance();
    const registeredAt = now();
    const registry = {
      profile: "CatalogProductContentRegistryV1",
      tenantReference: tenant,
      brandReference: brand,
      registryReference: reference(),
      versionReference: reference(),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null,
      registeredAt,
      tags: [],
      attributes: [],
    };
    // Controlled governance seed through the real Catalog producer. Ordinary
    // Product operations below authorize against the persisted native IAM.
    await createPostgresProductContentRegistryStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      clock: { now },
      transactions,
      authority: {
        async holdUntilTransactionCompletes(tx, packet) {
          assert.equal(typeof tx.query, "function");
          assert.equal(packet.tenantReference, tenant);
          assert.equal(packet.brandReference, brand);
          assert.equal(packet.actorReference, actor);
        },
      },
      audit: {
        create(command) {
          return {
            auditId: reference(),
            brandId: brand,
            actor: { type: "User", reference: actor },
            actionCode: "CATALOG_CONTENT_REGISTRY_RECORDED",
            targetType: "CatalogContentRegistry",
            targetId: registry.registryReference,
            reasonCode: command.reasonCode,
            correlationId: command.operationReference,
            occurredAt: command.occurredAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          };
        },
      },
    }).execute({
      purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind: "User",
      operationReference: reference(),
      expectedRegistryVersion: 0,
      occurredAt: registeredAt,
      reasonCode: "SYNTHETIC_PRODUCT_BINDING_REGISTRY",
      registry,
    });
    if (publicationOnly) {
      phase = "ProductCurrentPublishedPublication:TaxRegistrySeed";
      // Synthetic configuration setup only, through the real owning producer.
      // This classification has no tax rate, legal meaning or real Store evidence.
      // Every ordinary Product action still reads it through current native IAM.
      await admin.query(
        "GRANT INSERT ON rms_catalog.product_tax_classification_registry_record TO " + role,
      );
      const taxAt = now(),
        classification = reference();
      const taxRegistry = {
        profile: "CatalogProductTaxClassificationRegistryV1",
        tenantReference: tenant,
        brandReference: brand,
        registryReference: reference(),
        versionReference: reference(),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt: taxAt,
        definitions: [
          {
            classificationReference: classification,
            code: "SYNTHETIC_DEFAULT_CLASS",
            localizedNames: { "en-CA": "Synthetic classification for owner acceptance" },
            lifecycle: "Active",
          },
        ],
        defaultClassificationReference: classification,
      };
      const expectedDigest = catalogProductTaxClassificationRegistryDigest(taxRegistry);
      const seedTransactions = {
        run: (work) =>
          transactions.run(async (tx) => {
            taxSetupGuards.set(tx, { phase: "work", entries: [] });
            // The actual outer runner executes registered async/sync checks after
            // deferred constraints and immediately before submitting real COMMIT.
            return work(tx);
          }),
      };
      const seedCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product_tax_classification_registry_record WHERE brand_id=$1) registry,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) outbox",
            [brand],
          )
        ).rows[0];
      const beforeTax = await seedCounts();
      const recordedTax = await createPostgresProductTaxClassificationRegistryStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        clock: { now },
        transactions: seedTransactions,
        registerBeforeCommit: async (tx, guard, finalAssert) => {
          const pending = taxSetupGuards.get(tx);
          assert(pending && pending.phase === "work");
          assert.equal(pending.entries.length, 0);
          assert.equal(typeof guard, "function");
          assert.equal(typeof finalAssert, "function");
          pending.entries.push({ guard, finalAssert });
        },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            const pending = taxSetupGuards.get(tx);
            assert(pending && ["work", "guards"].includes(pending.phase));
            assert.deepEqual(
              [input.tenantReference, input.brandReference, input.actorReference, input.actorKind],
              [tenant, brand, actor, "User"],
            );
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.action, "catalog.tax-classification.manage");
            assert.equal(input.purposeCode, "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY");
            assert.deepEqual(input.requiredFields, taxClassificationRegistryFields);
            assert(input.observedAt >= taxAt);
            if (input.mode === "Intent") assert.equal(input.registry, null);
            else {
              assert.equal(input.mode, "Register");
              assert.equal(
                catalogProductTaxClassificationRegistryDigest(input.registry),
                expectedDigest,
              );
            }
          },
        },
        audit: {
          create(command) {
            return {
              auditId: reference(),
              brandId: brand,
              actor: { type: "User", reference: actor },
              actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
              targetType: "CatalogTaxClassificationRegistry",
              targetId: taxRegistry.registryReference,
              reasonCode: command.reasonCode,
              correlationId: command.operationReference,
              occurredAt: command.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "CONFIGURATION_AUDIT",
              retentionPolicyVersion: 1,
            };
          },
        },
      }).execute({
        purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        operationReference: reference(),
        expectedRegistryVersion: 0,
        occurredAt: taxAt,
        reasonCode: "SYNTHETIC_PRODUCT_PUBLICATION_TAX_REGISTRY",
        registry: taxRegistry,
      });
      assert.equal(recordedTax.status, "Applied");
      assert.equal(recordedTax.snapshotDigest, expectedDigest);
      assert.deepEqual(recordedTax.registry, taxRegistry);
      assert.deepEqual(await seedCounts(), {
        registry: beforeTax.registry + 1,
        audit: beforeTax.audit + 1,
        outbox: beforeTax.outbox + 1,
      });
    }
    const persistence = { ...session.persistence, now, transactions },
      authentication = createPersistentMerchantBffService(persistence);
    const selected = { brandReference: brand, storeReference };
    let configuredPriceProduct;
    if (optionPriceOnly) {
      phase = "OptionPricePilotComposition";
      assert(optionPriceConfiguration);
      priceInstallationDirectory = await realpath(
        await mkdtemp(join(tmpdir(), "wp2421-price-pilot-")),
      );
      await chmod(priceInstallationDirectory, 0o700);
      const database = context.clientConfig.database;
      const saveInstallation = (name, value) =>
        writeFile(join(priceInstallationDirectory, name), JSON.stringify(value), { mode: 0o600 });
      await saveInstallation("installation.json", {
        schemaVersion: 1,
        environment: "InternalTest",
        database,
        port: Number(context.clientConfig.port),
        roles: { api: role, worker: context.clientConfig.user },
      });
      await saveInstallation("internal-test-profile.json", {
        environment: "InternalTest",
        database,
        binding: { tenantReference: tenant, ...selected },
      });
      await saveInstallation("merchant-runtime.json", {
        schemaVersion: 2,
        environment: "InternalTest",
        database,
        scope: { tenantReference: tenant, ...selected },
        roleMapping: { Manager: [], Owner: [], Finance: [] },
        // Explicit synthetic startup metadata; this selected Product branch
        // never treats workstation references as registered device authority.
        workstation: { deviceReference: reference(), pickupLocationReference: reference() },
        product: {
          contentPolicy: publicationOptions.productContentPolicy,
          maximumApprovalValiditySeconds: 3600,
          authoringSources: {
            ...publicationOptions.productContentPolicy,
            allergenRegistryVersionReference: null,
          },
          optionPriceSources: {
            currencyMetadata: optionPriceConfiguration.currencyMetadata,
            publicationPolicyFamilyReference:
              optionPriceConfiguration.publicationPolicyFamilyReference,
          },
        },
      });
      const installation = await loadPilotInstallation(priceInstallationDirectory),
        configuration = await installation.loadMerchantRuntime(),
        credentialsLoader = createInternalCredentialLoaders({
          file: join(priceInstallationDirectory, "internal-test-keys.json"),
          loadProfile: installation.loadProfile,
          expectedDatabaseName: installation.database,
        });
      assert.equal(await credentialsLoader.provisionInternalTestCredentials(), "Created");
      const credentials = await credentialsLoader.createInternalTestCredentials(),
        dependencies = composeMerchantDependencies(
          priceInstallationDirectory,
          installation,
          configuration,
          {},
          {},
        );
      assert.equal(typeof dependencies.createInternalMerchantProduct, "function");
      assert.deepEqual(
        configuration.product.optionPriceSources.currencyMetadata,
        optionPriceConfiguration.currencyMetadata,
      );
      assert.equal(
        configuration.product.optionPriceSources.publicationPolicyFamilyReference,
        optionPriceConfiguration.publicationPolicyFamilyReference,
      );
      configuredPriceProduct = (merchant, auth) =>
        dependencies.createInternalMerchantProduct(
          {
            publicProfile: { binding: { tenantReference: tenant } },
            scope: selected,
            credentials,
          },
          merchant,
          auth,
        );
    }
    const productPorts = configuredPriceProduct
      ? await configuredPriceProduct(persistence, authentication)
      : await createInternalMerchantProduct(
          { publicProfile: { binding: { tenantReference: tenant } }, scope: selected },
          {
            persistence,
            authentication,
            configuration: {
              scope: { tenantReference: tenant, ...selected },
              product: {
                contentPolicy: publicationOptions.productContentPolicy,
                maximumApprovalValiditySeconds: 3600,
                authoringSources: {
                  ...publicationOptions.productContentPolicy,
                  allergenRegistryVersionReference: null,
                },
              },
            },
            createCursorKey: async () => randomBytes(32),
          },
        );
    if (optionPriceOnly) {
      assert.equal(typeof productPorts.optionPriceAuthoring.scope, "function");
      assert.equal(typeof productPorts.optionPriceAuthoring.query, "function");
      assert.equal(typeof productPorts.optionPriceReview.query, "function");
    }
    // Observe only the actual fixed port's bounded failure. It is still the
    // emitted pilot handler, with unchanged auth, clock, transaction and return.
    const capturedProductDraft = productPorts.productDraft;
    const observedProductDraft = async (input) => {
      productTransactionFailed = false;
      transactionFailureClass = "UNOBSERVED";
      transactionFailureCode = "UNOBSERVED";
      transactionFailureSites = "UNOBSERVED";
      transactionGuardPhase = "UNOBSERVED";
      transactionElapsedMs = null;
      transactionSqlFamily = "UNOBSERVED";
      transactionConstraintReason = "UNOBSERVED";
      transactionQueryStats = "UNOBSERVED";
      productPortFailureClass = "UNOBSERVED";
      productPortFailureCode = "UNOBSERVED";
      productPortFailureSites = "UNOBSERVED";
      productPortFailurePhase = "UNOBSERVED";
      try {
        return await capturedProductDraft(input);
      } catch (error) {
        productPortFailureClass = [
          "CatalogError",
          "MerchantProductWriteFeatureDisabled",
          "Error",
          "TypeError",
        ].includes(error?.name)
          ? error.name
          : "OTHER";
        productPortFailureCode = [
          "CATALOG_INPUT_INVALID",
          "CATALOG_PERMISSION_DENIED",
          "CATALOG_UNAVAILABLE",
          "CATALOG_DEPENDENCY_UNAVAILABLE",
          "CATALOG_VERSION_CONFLICT",
          "CATALOG_IDEMPOTENCY_CONFLICT",
          "CATALOG_CODE_CONFLICT",
          "CATALOG_LIFECYCLE_CONFLICT",
        ].includes(error?.code)
          ? error.code
          : "NONE";
        const frames = typeof error?.stack === "string" ? error.stack.split("\n").slice(1, 33) : [];
        const sites = frames
          .flatMap((frame) => {
            const match = frame.match(
              /(?:\/|\\)((?:merchant-product-draft-command|merchant-product-editor-runtime-brand-sources|frozen-full-option-binding-rule-source|merchant-product-editor-(?:content|selling-unit|registered-content|pinned-option|policy-content|variant-history)-authority|current-published-(?:product-option-binding-source|option-set-graph)|product-(?:lifecycle|draft-baseline|editor-source|reference-history-source|content-registry|authoring-resolution)-store|merchant-category-transactions)\.(?:ts|js)):(\d+):\d+/u,
            );
            return match ? [match[1] + ":" + match[2]] : [];
          })
          .slice(0, 5);
        productPortFailureSites = sites.length ? sites.join(",") : "UNLOCATED";
        productPortFailurePhase = productTransactionFailed ? "Transactional" : "OutsideTransaction";
        throw error;
      }
    };
    const authoring = createMerchantOptionSetAuthoringCommand({
      merchant: persistence,
      authentication,
      references: { generate: () => reference() },
    });
    const editor = createMerchantOptionSetEditorQuery({ merchant: persistence, authentication });
    const historyQuery = createMerchantOptionSetHistoryQuery({
      merchant: persistence,
      authentication,
    });
    const currentPublicationQuery = createMerchantOptionSetCurrentPublicationQuery({
      merchant: persistence,
      authentication,
    });
    const resolution = createMerchantOptionSetAuthoringResolutionCommand({
      merchant: persistence,
      authentication,
      auditReference: () => reference(),
    });
    const contextQuery = createMerchantOptionSetAuthoringContextQuery({
      merchant: persistence,
      authentication,
    });
    const publicationContext = createMerchantOptionSetPublicationContextQuery({
      merchant: persistence,
      authentication,
    });
    const listQuery = createMerchantOptionSetListQuery({
      merchant: persistence,
      authentication,
      cursorKey: Buffer.alloc(32, 78), // Explicit synthetic secret, never returned in HTTP.
    });
    const observedPublicationCommand = (merchant, auth) => {
      let observation = null;
      // Fixed captured port: each read returns the exact actual Date instant.
      // Only command clock reads are observed; concurrent Context uses its own
      // unchanged merchant clock. No lease or business fact is synthesized.
      const observedNow = () => {
        const value = merchant.now();
        if (observation) {
          if (observation.first === null) observation.first = value;
          observation.last = value;
        }
        return value;
      };
      const actualCommand = createMerchantOptionSetPublicationCommand({
        merchant: { ...merchant, now: observedNow },
        authentication: auth,
        generateReference: reference,
        ...publicationOptions,
      });
      return async (request) => {
        assert.equal(observation, null); // fixture never overlaps two commands
        const current = { first: null, last: null };
        observation = current;
        try {
          return await actualCommand(request);
        } finally {
          lastPublicationCommandClock = Object.freeze({ ...current });
          observation = null;
        }
      };
    };
    const publicationCommand = observedPublicationCommand(persistence, authentication);
    const publicationResolution = createMerchantOptionSetPublicationResolutionCommand({
      merchant: persistence,
      authentication,
      auditReference: reference,
      optionSetPolicyFamilyReference: publicationOptions.optionSetPolicyFamilyReference,
    });
    const app = createApp({
      merchantBff: {
        ...productPorts,
        productDraft: observedProductDraft,
        service: authentication,
        optionSetAuthoring: authoring,
        optionSetEditor: editor,
        optionSetHistory: historyQuery,
        optionSetCurrentPublication: currentPublicationQuery,
        optionSetAuthoringResolution: resolution,
        optionSetAuthoringContext: contextQuery,
        optionSetList: listQuery,
        optionSetPublicationContext: publicationContext,
        optionSetPublicationCommand: publicationCommand,
        optionSetPublicationResolution: publicationResolution,
        storeCapability: createMerchantStoreCapability({
          persistence,
          authentication,
          currentProductRuntime: true,
        }).observe,
        acceptedHost: "merchant.invalid",
        exactOrigin: "https://merchant.invalid",
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const reviewerPersistence = { ...reviewerSession.persistence, now, transactions },
      reviewerAuthentication = createPersistentMerchantBffService(reviewerPersistence);
    const reviewerProductPorts = configuredPriceProduct
      ? await configuredPriceProduct(reviewerPersistence, reviewerAuthentication)
      : publicationOnly
        ? await createInternalMerchantProduct(
            { publicProfile: { binding: { tenantReference: tenant } }, scope: selected },
            {
              persistence: reviewerPersistence,
              authentication: reviewerAuthentication,
              configuration: {
                scope: { tenantReference: tenant, ...selected },
                product: {
                  contentPolicy: publicationOptions.productContentPolicy,
                  maximumApprovalValiditySeconds: 3600,
                  authoringSources: {
                    ...publicationOptions.productContentPolicy,
                    allergenRegistryVersionReference: null,
                  },
                },
              },
              createCursorKey: async () => randomBytes(32),
            },
          )
        : null;
    if (optionPriceOnly) {
      assert.equal(typeof reviewerProductPorts.optionPriceAuthoring.resolve, "function");
      assert.equal(typeof reviewerProductPorts.optionPriceReview.execute, "function");
    }
    const reviewerApp = createApp({
      merchantBff: {
        ...(reviewerProductPorts ?? {}),
        service: reviewerAuthentication,
        optionSetPublicationContext: createMerchantOptionSetPublicationContextQuery({
          merchant: reviewerPersistence,
          authentication: reviewerAuthentication,
        }),
        optionSetPublicationCommand: observedPublicationCommand(
          reviewerPersistence,
          reviewerAuthentication,
        ),
        optionSetPublicationResolution: createMerchantOptionSetPublicationResolutionCommand({
          merchant: reviewerPersistence,
          authentication: reviewerAuthentication,
          auditReference: reference,
          optionSetPolicyFamilyReference: publicationOptions.optionSetPolicyFamilyReference,
        }),
        acceptedHost: "merchant.invalid",
        exactOrigin: "https://merchant.invalid",
      },
    });
    reviewerServer = reviewerApp.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      reviewerServer.once("listening", resolve);
      reviewerServer.once("error", reject);
    });
    const reviewerAddress = reviewerServer.address();
    assert(reviewerAddress && typeof reviewerAddress !== "string");
    async function post(
      path,
      body,
      {
        discard = false,
        headers = {},
        capability = false,
        independent = false,
        product = false,
        pricing = false,
      } = {},
    ) {
      return new Promise((resolve, reject) => {
        const serialized = JSON.stringify(body),
          request = httpRequest(
            {
              host: "127.0.0.1",
              port: independent ? reviewerAddress.port : address.port,
              path: pricing
                ? "/merchant/pricing/option-prices/" + path
                : capability
                  ? "/merchant/store-capability"
                  : product
                    ? "/merchant/catalog/products" + path
                    : "/merchant/catalog/option-sets/" + path,
              method: "POST",
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie:
                  "__Host-bop-merchant=" + (independent ? reviewerSession : session).sessionCookie,
                "x-bop-csrf": (independent ? reviewerSession : session).csrf,
                "x-bop-catalog-scope": Buffer.from(
                  JSON.stringify({ brandReference: brand, storeReference }),
                ).toString("base64url"),
                "content-type": "application/json",
                "content-length": Buffer.byteLength(serialized),
                ...headers,
              },
            },
            (response) => {
              const chunks = [];
              let bytes = 0;
              response.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > 2 * 1024 * 1024) {
                  request.destroy(Error("Bounded Option HTTP response exceeded"));
                  return;
                }
                if (!discard) chunks.push(Buffer.from(chunk));
              });
              response.once("error", reject);
              response.once("end", () => {
                try {
                  const decoded = discard
                    ? null
                    : JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  if (pricing || path.startsWith("publication/")) {
                    publicationHttpStatus = response.statusCode;
                    const code = decoded?.error;
                    publicationHttpCode =
                      typeof code === "string" &&
                      /^(?:option_set_publication_[a-z_]{1,60}|option_price_[a-z_]{1,60}|request_denied)$/u.test(
                        code,
                      )
                        ? code
                        : response.statusCode === 200
                          ? "SUCCESS"
                          : "UNKNOWN";
                  }
                  if (path === "publication/context") {
                    publicationContextHttpStatus = response.statusCode;
                    const code = decoded?.error;
                    publicationContextHttpCode =
                      typeof code === "string" &&
                      /^(?:option_set_publication_[a-z_]{1,60}|request_denied)$/u.test(code)
                        ? code
                        : response.statusCode === 200
                          ? "SUCCESS"
                          : "UNKNOWN";
                  }
                  resolve({
                    status: response.statusCode,
                    body: decoded,
                    cacheControl: response.headers["cache-control"],
                  });
                } catch {
                  reject(Error("Bounded Option HTTP response invalid"));
                }
              });
            },
          );
        request.setTimeout(15000, () => request.destroy(Error("Bounded Option HTTP timeout")));
        request.once("error", reject);
        request.end(serialized);
      });
    }
    const listFilters = {
      locale: "en-CA",
      search: null,
      lifecycle: null,
      selectionType: null,
      includeArchived: false,
      hasProductBinding: null,
      hasPricingReference: null,
      hasConsumptionReference: null,
      hasConflict: null,
      missingTranslationLocale: null,
      publishingStatus: null,
      sort: "internalCode",
      direction: "ASC",
      limit: 100,
      cursor: null,
    };
    const list = (overrides = {}, transport = {}) =>
      post("list", { ...listFilters, ...overrides }, transport);
    const capability = (action) =>
      post("", { capabilityKey: "catalog.cat_optionset_" + action }, { capability: true });
    const create = {
      internalCode: "SYNTHETIC_HTTP_OPTION",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic HTTP choices" },
        localizedDescriptions: { "en-CA": "Actual normal HTTP authoring" },
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "ONE",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic one" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: false,
            triggeredOptionSetReference: null,
            conflictOptionCodes: [],
          },
        ],
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: [
          {
            stableCode: "ONE",
            quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
            media: null,
            pricingRule: null,
            consumption: null,
            triggeredOptionSetVersionReference: null,
          },
        ],
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: from, localDateTime: from.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: reference(),
    };
    if (publicationOnly) {
      phase = "ProductCurrentPublishedPublication";
      await exerciseSelectedProductPublication({
        admin,
        tenant,
        brand,
        storeReference,
        actor,
        reviewer,
        now,
        reference,
        post,
        create,
        setStage: (stage) => {
          phase = "ProductCurrentPublishedPublication:" + stage;
        },
      });
      return;
    }
    if (optionPriceOnly) {
      assert(optionPriceConfiguration && enableOptionPrice);
      await exerciseSelectedOptionPricePublication({
        admin,
        tenant,
        brand,
        storeReference,
        actor,
        reviewer,
        now,
        reference,
        post,
        create,
        transactions,
        role,
        currencyMetadata: optionPriceConfiguration.currencyMetadata,
        enablePricing: enableOptionPrice,
        restoreProductRead: () => grant("catalog.product.read"),
        grants,
        setStage: (stage) => {
          phase = "OptionPricePublication:" + stage;
        },
      });
      return;
    }
    phase = "BrowserInitialScope";
    for (const action of ["list", "create", "detail", "edit"]) {
      const observation = await capability(action);
      assert.equal(observation.status, 200);
      assert.equal(observation.body.brandReference, brand);
      assert.equal(observation.body.storeReference, storeReference);
      assert.equal(observation.body.capabilityKey, "catalog.cat_optionset_" + action);
      assert.equal(observation.body.controlKey, "catalog.optionset." + action);
      assert.equal(observation.body.backendExecution, "Allow");
      assert.equal(observation.body.frontendVisibility, "Show");
    }
    phase = "ListEmpty";
    const empty = await list();
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.items, []);
    assert.equal(empty.body.hasMore, false);
    assert.equal(empty.body.nextCursor, null);
    assert.equal(empty.body.projection.partial, true);
    assert.equal(empty.body.projection.stale, false);
    phase = "Context";
    const admission = await post("authoring/context", { action: "Create" });
    assert.equal(admission.status, 200);
    assert.deepEqual(
      [
        admission.body.tenantReference,
        admission.body.brandReference,
        admission.body.storeReference,
        admission.body.actorReference,
      ],
      [tenant, brand, storeReference, actor],
    );
    assert(Date.parse(admission.body.validUntil) - Date.parse(admission.body.observedAt) <= 5000);
    phase = "Create";
    const before = await counts(),
      created = await post("create", create);
    assert.equal(created.status, 200);
    assert.match(created.cacheControl, /no-store/u);
    assert.equal(created.body.status, "Applied");
    const content = created.body.content,
      set = content.sourceAggregate.optionSetReference,
      old = content.sourceAggregate.draft.options[0];
    assert(old);
    assert.equal(content.sourceAggregate.aggregateVersion, 1);
    assert.equal(content.sourceAggregate.createdByActorReference, actor);
    const read = async (root) =>
      post("current-editor", { optionSetReference: set, expectedAggregateVersion: root });
    const readCreated = await read(1);
    assert.deepEqual(readCreated.body.content, content);
    const history = (revision, before = null, limit = 20, targetSet = set) =>
      post("history", {
        action: "List",
        command: {
          optionSetReference: targetSet,
          expectedAggregateVersion: revision,
          before,
          limit,
        },
      });
    const currentPublication = (targetSet, root = null) =>
      post("current-published", { optionSetReference: targetSet, expectedAggregateVersion: root });
    phase = "HistoryPermission";
    assert.equal((await history(1)).status, 403);
    const unpublished = await currentPublication(set, 1);
    assert.equal(unpublished.status, 200);
    assert.equal(unpublished.body.publicationState, "Absent");
    assert.equal(unpublished.body.published, null);
    await grant("catalog.option_set.history.read");
    const createdHistory = await history(1);
    assert.equal(createdHistory.status, 200);
    assert.equal(createdHistory.body.action, "List");
    assert.equal(createdHistory.body.actorReference, actor);
    assert.equal(createdHistory.body.storeReference, storeReference);
    assert.deepEqual(
      createdHistory.body.view.entries.map((entry) => [entry.operationReference, entry.kind]),
      [[create.operationReference, "DraftSnapshot"]],
    );
    const originalHistoryEntry = createdHistory.body.view.entries[0];
    const historicalDraft = (entry, targetSet = set) =>
      post("history", {
        action: "Draft",
        command: {
          optionSetReference: targetSet,
          operationReference: entry.operationReference,
          versionReference: entry.versionReference,
          resultAggregateVersion: entry.resultAggregateVersion,
          expectedSourceDigest: entry.sourceDigest,
          expectedContentDigest: entry.contentDigest,
          expectedConfigurationDigest: entry.configurationDigest,
        },
      });
    assert.deepEqual((await historicalDraft(originalHistoryEntry)).body.view.content, content);
    phase = "PublicationContextCreated";
    const inspect = (expectedAggregateVersion) =>
      post("publication/context", {
        optionSetReference: set,
        expectedAggregateVersion,
        action: "Inspect",
      });
    const beforeContext = await counts(),
      contextStartedAt = now(),
      inspected = await inspect(1);
    assert.equal(inspected.status, 200);
    assert.match(inspected.cacheControl, /no-store/u);
    assert.equal(inspected.body.profile, "CatalogOptionSetPublicationContextV1");
    assert.equal(inspected.body.action, "Inspect");
    assert.deepEqual(
      [
        inspected.body.tenantReference,
        inspected.body.brandReference,
        inspected.body.storeReference,
        inspected.body.actorReference,
      ],
      [tenant, brand, storeReference, actor],
    );
    assert.deepEqual(inspected.body.draft, {
      optionSetReference: set,
      versionReference: content.sourceAggregate.draft.versionReference,
      aggregateVersion: 1,
      sourceOperationReference: create.operationReference,
      sourceDigest: readCreated.body.sourceDigest,
      contentDigest: readCreated.body.contentDigest,
      configurationDigest: readCreated.body.configurationDigest,
      sourceSnapshotTuple: {
        tenantReference: tenant,
        brandReference: brand,
        optionSetReference: set,
        versionReference: content.sourceAggregate.draft.versionReference,
        aggregateVersion: 1,
        sourceDigest: readCreated.body.sourceDigest,
        contentDigest: readCreated.body.contentDigest,
        configurationDigest: readCreated.body.configurationDigest,
      },
    });
    assert.deepEqual(inspected.body.review, { kind: "AbsentForCurrentDraft" });
    assert(inspected.body.observedAt >= contextStartedAt && inspected.body.observedAt <= now());
    assert(inspected.body.validUntil > inspected.body.observedAt);
    assert(Date.parse(inspected.body.validUntil) - Date.parse(inspected.body.observedAt) <= 5000);
    assert.deepEqual(await counts(), beforeContext);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int count FROM rms_catalog.option_set_review_content WHERE tenant_id=$1 AND brand_id=$2",
          [tenant, brand],
        )
      ).rows[0].count,
      0,
    );
    phase = "ListCreated";
    const listedCreated = await list();
    assert.equal(listedCreated.status, 200);
    assert.equal(listedCreated.body.items.length, 1);
    assert.deepEqual(listedCreated.body.scope, {
      tenantReference: tenant,
      brandReference: brand,
      storeReference,
      actorReference: actor,
    });
    const listItem = listedCreated.body.items[0];
    assert.equal(listItem.optionSetReference, set);
    assert.equal(listItem.aggregateVersion, 1);
    assert.equal(listItem.name, create.draft.localizedNames["en-CA"]);
    assert.equal(listItem.nameLocale, "en-CA");
    assert.equal(listItem.localeFallback, false);
    assert.equal(listItem.optionCount, 1);
    assert.equal(listItem.activeOptionCount, 0);
    assert.deepEqual(listItem.publishingStatus, { status: "Unavailable" });
    assert.equal(listItem.referenceEligibility, "NotEvaluated");
    const edit = {
      optionSetReference: set,
      expectedAggregateVersion: 1,
      draft: {
        ...create.draft,
        options: [
          {
            ...create.draft.options[0],
            stableCode: "TWO",
            localizedNames: { "en-CA": "Synthetic two" },
            identity: { kind: "New" },
          },
        ],
      },
      additionalContent: {
        ...create.additionalContent,
        optionDetails: [{ ...create.additionalContent.optionDetails[0], stableCode: "TWO" }],
      },
      archiveOptionReferences: [old.optionReference],
      operationReference: reference(),
    };
    phase = "Edit";
    const changed = await post("draft", edit);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.content.sourceAggregate.aggregateVersion, 2);
    const next = changed.body.content.sourceAggregate.draft.options.find(
      (o) => o.stableCode === "TWO",
    );
    assert(next);
    assert.notEqual(next.optionReference, old.optionReference);
    assert.equal(
      changed.body.content.sourceAggregate.draft.options.find(
        (o) => o.optionReference === old.optionReference,
      ).lifecycle,
      "Archived",
    );
    assert.deepEqual((await read(2)).body.content, changed.body.content);
    phase = "ListEdited";
    const listedEdited = await list({
      search: "Synthetic two",
      lifecycle: "Draft",
      selectionType: "MultiChoice",
      hasProductBinding: false,
      hasPricingReference: false,
      hasConsumptionReference: false,
      hasConflict: false,
    });
    assert.equal(listedEdited.status, 200);
    assert.equal(listedEdited.body.items.length, 1);
    assert.equal(listedEdited.body.items[0].aggregateVersion, 2);
    assert.equal(listedEdited.body.items[0].optionCount, 2); // Includes preserved Archived identity.
    assert.equal(listedEdited.body.items[0].activeOptionCount, 0);
    assert.equal((await list({ search: "no-such-synthetic-option" })).body.items.length, 0);
    const fallback = await list({ locale: "fr-CA", missingTranslationLocale: "fr-CA" });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.items[0].localeFallback, true);
    assert.equal(fallback.body.items[0].nameLocale, "en-CA");
    const publishingUnavailable = await list({ publishingStatus: "Published" });
    assert.equal(publishingUnavailable.status, 503);
    assert.equal(publishingUnavailable.body.error, "option_set_list_unavailable");
    const committed = await counts();
    assert.deepEqual(committed, {
      sets: before.sets + 1,
      operations: before.operations + 2,
      snapshots: before.snapshots + 2,
      identities: before.identities + 2,
      fences: before.fences,
      audit: before.audit + 2,
      outbox: before.outbox + 2,
    });
    phase = "EditedHistory";
    const firstHistoryPage = await history(2, null, 1);
    assert.equal(firstHistoryPage.status, 200);
    assert.equal(firstHistoryPage.body.view.entries.length, 1);
    assert.equal(firstHistoryPage.body.view.entries[0].operationReference, edit.operationReference);
    assert(firstHistoryPage.body.view.nextBefore);
    const secondHistoryPage = await history(2, firstHistoryPage.body.view.nextBefore, 1);
    assert.equal(secondHistoryPage.status, 200);
    assert.equal(
      secondHistoryPage.body.view.entries[0].operationReference,
      create.operationReference,
    );
    assert.equal(secondHistoryPage.body.view.nextBefore, null);
    // A cursor beyond the caller's revision is invalid, independently of current root.
    assert.equal((await history(1, firstHistoryPage.body.view.nextBefore, 1)).status, 400);
    const originalCursor = {
      resultAggregateVersion: originalHistoryEntry.resultAggregateVersion,
      operationReference: originalHistoryEntry.operationReference,
      kind: originalHistoryEntry.kind,
    };
    assert.equal((await history(1, originalCursor, 1)).status, 409);
    const oldHistoryRead = await historicalDraft(originalHistoryEntry);
    assert.equal(oldHistoryRead.status, 200);
    assert.deepEqual(oldHistoryRead.body.view.content, content);
    const wrongHistoryRead = await historicalDraft({
      ...originalHistoryEntry,
      resultAggregateVersion: 2,
    });
    assert.notEqual(wrongHistoryRead.status, 200);
    const draftSelector = (entry, targetSet = set) => ({
      optionSetReference: targetSet,
      operationReference: entry.operationReference,
      versionReference: entry.versionReference,
      resultAggregateVersion: entry.resultAggregateVersion,
      expectedSourceDigest: entry.sourceDigest,
      expectedContentDigest: entry.contentDigest,
      expectedConfigurationDigest: entry.configurationDigest,
    });
    const editedComparison = await post("history", {
      action: "Compare",
      command: {
        left: { kind: "Draft", command: draftSelector(originalHistoryEntry) },
        right: { kind: "Draft", command: draftSelector(firstHistoryPage.body.view.entries[0]) },
      },
    });
    assert.equal(editedComparison.status, 200);
    assert.equal(editedComparison.body.view.comparison.businessContentChanged, true);
    assert.equal(
      editedComparison.body.view.left.view.originalTuple.operationReference,
      create.operationReference,
    );
    assert.equal(
      editedComparison.body.view.right.view.originalTuple.operationReference,
      edit.operationReference,
    );
    assert.deepEqual(await counts(), committed);
    phase = "Replay";
    const retry = await post("draft", edit);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "Replayed");
    assert.deepEqual(retry.body.content, changed.body.content);
    assert.deepEqual(await counts(), committed);
    const originalRequest = (action, operationReference, expectedAggregateVersion = null) => ({
      profile: "CatalogOptionSetAuthoringResolutionRequestV1",
      tenantReference: tenant,
      action,
      operationReference,
      optionSetReference: action === "Create" ? null : set,
      expectedAggregateVersion,
    });
    phase = "ResolveOriginal";
    const oldReceipt = await post(
      "authoring/resolve",
      originalRequest("Create", create.operationReference),
    );
    assert.equal(oldReceipt.status, 200);
    assert.equal(oldReceipt.body.resolution.outcome, "Committed");
    assert.deepEqual(oldReceipt.body.content, content);
    // Deliberately discard the actual successful response contents before decode;
    // subsequent recovery reconstructs the owning original receipt, never current data.
    phase = "DiscardedReply";
    const lost = {
      ...create,
      internalCode: "SYNTHETIC_LOST_REPLY",
      operationReference: reference(),
    };
    assert.equal((await post("create", lost, { discard: true })).status, 200);
    const recovered = await post(
      "authoring/resolve",
      originalRequest("Create", lost.operationReference),
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.resolution.outcome, "Committed");
    assert.equal(recovered.body.content.sourceAggregate.internalCode, lost.internalCode);
    phase = "ListPagination";
    const beforeList = await counts();
    const firstPage = await list({ limit: 1 });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.items.length, 1);
    assert.equal(firstPage.body.hasMore, true);
    const cursor = firstPage.body.nextCursor;
    assert.match(cursor, /^os1\.[A-Za-z0-9_-]+$/u);
    assert(!cursor.includes(set) && !cursor.includes(brand) && !cursor.includes(actor));
    const secondPage = await list({ limit: 1, cursor });
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.items.length, 1);
    assert.notEqual(
      secondPage.body.items[0].optionSetReference,
      firstPage.body.items[0].optionSetReference,
    );
    assert.equal(secondPage.body.hasMore, false);
    assert.equal(secondPage.body.nextCursor, null);
    // Alter authenticated ciphertext, preserving canonical base64url syntax.
    const tamperedBytes = Buffer.from(cursor.slice(4), "base64url");
    tamperedBytes[0] ^= 1;
    const tampered = await list({ limit: 1, cursor: "os1." + tamperedBytes.toString("base64url") });
    assert.equal(tampered.status, 400);
    assert.equal(tampered.body.error, "option_set_list_invalid");
    const substitutedFilter = await list({ limit: 1, cursor, locale: "fr-CA" });
    assert.equal(substitutedFilter.status, 400);
    assert.equal(substitutedFilter.body.error, "option_set_list_invalid");
    const substitutedScope = await list(
      { limit: 1, cursor },
      {
        headers: {
          "x-bop-catalog-scope": Buffer.from(
            JSON.stringify({ brandReference: brand, storeReference: reference() }),
          ).toString("base64url"),
        },
      },
    );
    assert.equal(substitutedScope.status, 403);
    assert.deepEqual(await counts(), beforeList);
    phase = "ListSourceChanged";
    const sourceChanged = await post("create", {
      ...create,
      internalCode: "SYNTHETIC_LIST_CHANGE",
      operationReference: reference(),
    });
    assert.equal(sourceChanged.status, 200);
    const afterSourceChange = await counts();
    const stalePage = await list({ limit: 1, cursor });
    assert.equal(stalePage.status, 409);
    assert.equal(stalePage.body.error, "option_set_list_stale");
    assert.deepEqual(await counts(), afterSourceChange);
    // Separate ordinary publication set preserves all existing authoring/List fixtures.
    phase = "PublicationCreate";
    const publicationCreated = await post("create", {
      ...create,
      internalCode: "SYNTHETIC_QUALIFIED_PUBLICATION",
      operationReference: reference(),
      draft: {
        ...create.draft,
        options: create.draft.options.map((option) => ({ ...option, lifecycle: "Active" })),
      },
    });
    assert.equal(publicationCreated.status, 200);
    const publicationSet = publicationCreated.body.content.sourceAggregate.optionSetReference;
    const publicationOriginalHistory = await history(1, null, 20, publicationSet);
    assert.equal(publicationOriginalHistory.status, 200);
    const publicationOriginalEntry = publicationOriginalHistory.body.view.entries[0];
    assert.deepEqual(
      (await historicalDraft(publicationOriginalEntry, publicationSet)).body.view.content,
      publicationCreated.body.content,
    );
    const publicationCounts = async () => ({
      ...(await counts()),
      ...(
        await admin.query(
          "SELECT (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1) mutations,(SELECT count(*)::int FROM bop_publishing.option_set_publication_operation WHERE brand_id=$1) publication_terminals,(SELECT count(*)::int FROM rms_catalog.option_set_review_content WHERE brand_id=$1) reviews,(SELECT count(*)::int FROM rms_catalog.option_set_publication_content WHERE brand_id=$1) seals,(SELECT count(*)::int FROM rms_catalog.option_set_publication_release WHERE brand_id=$1) releases",
          [brand],
        )
      ).rows[0],
    });
    const publicationContextFor = async (action, independent = false) => {
      const result = await post(
        "publication/context",
        { optionSetReference: publicationSet, expectedAggregateVersion: null, action },
        { independent },
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.actorReference, independent ? reviewer : actor);
      return result.body;
    };
    const publicationRequest = (action, current, operationReference = reference()) => {
      const root = current.draft,
        recorded = current.review;
      return {
        profile: "CatalogOptionSetPublicationCommandRequestV1",
        action,
        operationReference,
        optionSetReference: root.optionSetReference,
        versionReference: root.versionReference,
        expectedAggregateVersion: root.aggregateVersion,
        sourceDigest: root.sourceDigest,
        contentDigest: root.contentDigest,
        configurationDigest: root.configurationDigest,
        expectedReview:
          recorded.kind === "Recorded"
            ? {
                reviewOperationReference: recorded.operationReference,
                publishingReviewOperationReference: recorded.publishingReviewOperationReference,
                recordDigest: recorded.recordDigest,
                bindingDigest: recorded.binding.digest,
              }
            : null,
        expectedLifecycle:
          recorded.kind === "Recorded"
            ? {
                lifecycleReference: recorded.lifecycleReference,
                version: recorded.lifecycle.version,
                state: recorded.lifecycle.state,
                latestMutationOperationReference: recorded.latestMutationOperationReference,
              }
            : null,
      };
    };
    const receipt = (response, request, outcome = "Committed") => {
      assert.equal(response.status, 200);
      assert.deepEqual(
        Object.keys(response.body).sort(),
        [
          "profile",
          "storeReference",
          "operationReference",
          "action",
          "outcome",
          "recordedAt",
        ].sort(),
      );
      assert.equal(response.body.profile, "CatalogOptionSetPublicationReceiptV1");
      assert.equal(response.body.storeReference, storeReference);
      assert.equal(response.body.operationReference, request.operationReference);
      assert.equal(response.body.action, request.action);
      assert.equal(response.body.outcome, outcome);
      assert.match(response.body.recordedAt, /^\d{4}-\d{2}-\d{2}T/u);
      return response.body;
    };
    phase = "PublicationValidate";
    const initialPublicationContext = await publicationContextFor("Validate"),
      submit = publicationRequest("SubmitReview", initialPublicationContext);
    const {
      operationReference: unusedValidationOperation,
      expectedReview: unusedValidationReview,
      expectedLifecycle: unusedValidationLifecycle,
      ...validateBody
    } = submit;
    void unusedValidationOperation;
    void unusedValidationReview;
    void unusedValidationLifecycle;
    const beforeValidate = await publicationCounts(),
      validated = await post("publication/command", { ...validateBody, action: "Validate" });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.outcome, "Validated");
    assert.equal(validated.body.validation.decision, "Pass");
    assert.deepEqual(await publicationCounts(), beforeValidate);
    phase = "PublicationSubmitRollback";
    failAfterPublicationTerminal = true;
    const failedSubmit = await post("publication/command", submit);
    assert.equal(failedSubmit.status, 503);
    assert.equal(failAfterPublicationTerminal, false); // failure reached the actual SQL append
    assert.deepEqual(await publicationCounts(), beforeValidate);
    phase = "PublicationSubmit";
    let markEntered, releaseContext;
    const entered = new Promise((resolve) => {
        markEntered = resolve;
      }),
      resume = new Promise((resolve) => {
        releaseContext = resolve;
      });
    contextPause = {
      key: "CatalogOptionCurrentReview:" + tenant + ":" + brand + ":" + publicationSet,
      entered: markEntered,
      resume,
      release: releaseContext,
      used: false,
      contextPid: null,
      writerPid: null,
      publishingSreAttempted: false,
    };
    const settled = (promise) =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const overlappingContext = settled(
      post("publication/context", {
        optionSetReference: publicationSet,
        expectedAggregateVersion: null,
        action: "Inspect",
      }),
    );
    let overlappingSubmit, submitResponse, submitDispatchAt, submitResponseAt;
    try {
      await boundedPause(entered, 3000);
      // Reset diagnostics so only this genuine overlapping request can authorize
      // the narrowly allowed original-deadline failure path.
      transactionFailureClass = "UNOBSERVED";
      transactionFailureCode = "UNOBSERVED";
      transactionFailureSites = "UNOBSERVED";
      transactionGuardPhase = "UNOBSERVED";
      transactionElapsedMs = null;
      sqlState = null;
      submitDispatchAt = Date.now();
      overlappingSubmit = settled(
        post("publication/command", submit).then((response) => {
          submitResponseAt = Date.now();
          return response;
        }),
      );
      const limit = Date.now() + 2000;
      let observedReviewExclusiveWait = false;
      while (Date.now() < limit) {
        if (contextPause.writerPid !== null) {
          const waiting = await admin.query(
            "SELECT wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1",
            [contextPause.writerPid, contextPause.contextPid],
          );
          if (waiting.rows[0]?.blocked === true) {
            observedReviewExclusiveWait = true;
            break;
          }
        }
        await delay(10);
      }
      assert.equal(observedReviewExclusiveWait, true);
      assert.equal(contextPause.publishingSreAttempted, false); // Review EX precedes SRE
      releaseContext();
      const contextResult = await boundedPause(overlappingContext, 10000),
        submitResult = await boundedPause(overlappingSubmit, 10000);
      if (contextResult.error) throw contextResult.error;
      if (submitResult.error) throw submitResult.error;
      assert.equal(contextResult.value.status, 200);
      assert.notEqual(sqlState, "40P01");
      submitResponse = submitResult.value;
    } finally {
      releaseContext();
      await boundedPause(
        Promise.allSettled([overlappingContext, ...(overlappingSubmit ? [overlappingSubmit] : [])]),
        10000,
      );
      contextPause = null;
    }
    if (submitResponse.status !== 200) {
      // Contention may consume this request's unchanged original five-second
      // authority. All other unavailability remains a failing acceptance result.
      assert.equal(submitResponse.status, 503);
      assert.equal(submitResponse.body.error, "option_set_publication_unavailable");
      assert.equal(transactionFailureClass, "CatalogError");
      assert.equal(transactionFailureCode, "CATALOG_DEPENDENCY_UNAVAILABLE");
      assert.equal(sqlState, null);
      assert.equal(failAfterPublicationTerminal, false);
      assert(Number.isSafeInteger(submitResponseAt) && Number.isSafeInteger(submitDispatchAt));
      assert(submitResponseAt - submitDispatchAt >= 5000);
      assert(Number.isSafeInteger(transactionElapsedMs) && transactionElapsedMs >= 4900);
      assert(lastPublicationCommandClock);
      const commandStarted = Date.parse(lastPublicationCommandClock.first),
        commandLast = Date.parse(lastPublicationCommandClock.last);
      assert(Number.isFinite(commandStarted) && Number.isFinite(commandLast));
      assert(commandLast >= commandStarted + 5000);
      // Factory's first clock read creates its original startedAt/deadline. The
      // exact unchanged clock subsequently reached that original deadline;
      // stage/owner names do not authorize another kind of unavailable result.
      assert.deepEqual(await publicationCounts(), beforeValidate);
      phase = "PublicationSubmitOriginalDeadlineRetry";
      // Exact original body/op, genuinely fresh HTTP admission; never extend the
      // expired transaction or alter its original clock/lease.
      submitResponse = await post("publication/command", submit);
    }
    phase = "PublicationSubmitReceipt";
    const submitted = receipt(submitResponse, submit);
    phase = "PublicationSubmitCounts";
    const afterSubmit = await publicationCounts();
    assert.equal(afterSubmit.mutations, beforeValidate.mutations + 2);
    assert.equal(afterSubmit.publication_terminals, beforeValidate.publication_terminals + 1);
    assert.equal(afterSubmit.reviews, beforeValidate.reviews + 1);
    phase = "PublicationSubmitRecordedContext";
    const reviewContext = await publicationContextFor("Approve");
    phase = "PublicationSubmitReviewTuple";
    assert.equal(reviewContext.review.kind, "Recorded");
    assert.notEqual(
      reviewContext.review.operationReference,
      reviewContext.review.publishingReviewOperationReference,
    );
    assert.equal(
      reviewContext.review.publishingReviewOperationReference,
      submit.operationReference,
    );
    assert.equal(reviewContext.review.submittedActorReference, actor);
    assert.equal(reviewContext.review.lifecycle.state, "InReview");
    phase = "PublicationSelfApproval";
    const selfApprove = publicationRequest("Approve", reviewContext);
    const deniedSelf = await post("publication/command", selfApprove);
    assert.equal(deniedSelf.status, 403); // actual independent approval permission refusal
    assert.deepEqual(await publicationCounts(), afterSubmit);
    // Real elapsed time expires the original historical Review lease. New requests
    // get their own actual five-second authority; no old evidence lease is renewed.
    await delay(5100);
    phase = "PublicationIndependentApproval";
    const independentContext = await publicationContextFor("Approve", true),
      approve = publicationRequest("Approve", independentContext);
    assert(Date.parse(now()) - Date.parse(submitted.recordedAt) > 5000);
    const approved = receipt(
        await post("publication/command", approve, { independent: true }),
        approve,
      ),
      afterApprove = await publicationCounts();
    assert.equal(afterApprove.mutations, afterSubmit.mutations + 1);
    assert.equal(afterApprove.publication_terminals, afterSubmit.publication_terminals + 1);
    await delay(5100);
    phase = "PublicationDelayedPublish";
    const publishContext = await publicationContextFor("Publish"),
      publish = publicationRequest("Publish", publishContext);
    assert.equal(publishContext.review.lifecycle.state, "Approved");
    assert.equal(
      publish.expectedReview.publishingReviewOperationReference,
      submit.operationReference,
    );
    assert.equal(
      publish.expectedLifecycle.latestMutationOperationReference,
      approve.operationReference,
    );
    assert(Date.parse(now()) - Date.parse(approved.recordedAt) > 5000);
    // Simulated lost reply keeps the actual HTTP exchange/COMMIT but discards bytes.
    assert.equal((await post("publication/command", publish, { discard: true })).status, 200);
    const published = receipt(
        await post("publication/resolve", {
          ...publish,
          profile: "CatalogOptionSetPublicationResolutionRequestV1",
        }),
        publish,
      ),
      afterPublish = await publicationCounts();
    assert.equal(afterPublish.mutations, afterApprove.mutations + 1);
    assert.equal(afterPublish.publication_terminals, afterApprove.publication_terminals + 1);
    assert.equal(afterPublish.seals, afterApprove.seals + 1);
    assert.equal(afterPublish.releases, afterApprove.releases + 1);
    const sealedState = (
      await admin.query(
        "SELECT s.aggregate_version,v.status FROM rms_catalog.option_set s JOIN rms_catalog.option_set_version v ON v.option_set_id=s.option_set_id WHERE s.brand_id=$1 AND s.option_set_id=$2 AND v.option_set_version_id=$3",
        [brand, publicationSet, publish.versionReference],
      )
    ).rows[0];
    assert.equal(sealedState.aggregate_version, publish.expectedAggregateVersion + 1);
    assert.equal(sealedState.status, "Frozen");
    phase = "PublicationOriginalRecovery";
    for (const [original, expected, independent] of [
      [submit, submitted, false],
      [approve, approved, true],
      [publish, published, false],
    ]) {
      const allocated = sequence;
      assert.deepEqual(
        receipt(await post("publication/command", original, { independent }), original),
        expected,
      );
      assert.deepEqual(
        receipt(
          await post(
            "publication/resolve",
            { ...original, profile: "CatalogOptionSetPublicationResolutionRequestV1" },
            { independent },
          ),
          original,
        ),
        expected,
      );
      assert.equal(sequence, allocated);
      assert.deepEqual(await publicationCounts(), afterPublish);
    }
    phase = "PublicationCurrentHead";
    const terminalMutation = (
      await admin.query(
        "SELECT mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3",
        [tenant, brand, publish.operationReference],
      )
    ).rows[0].mutation_json;
    assert.equal(terminalMutation.operation, "Publish");
    assert.equal(terminalMutation.approvalEvidence.approvedActorReference, reviewer);
    assert.equal(
      terminalMutation.optionSetCurrentQualification.reviewOperationReference,
      submit.operationReference,
    );
    assert.equal(
      terminalMutation.optionSetCurrentQualification.approvalOperationReference,
      approve.operationReference,
    );
    assert(terminalMutation.optionSetCurrentQualification.checkedAt >= approved.recordedAt);
    const historic = (
      await admin.query(
        "SELECT operation_id,mutation_json FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=ANY($3::uuid[])",
        [tenant, brand, [submit.operationReference, approve.operationReference]],
      )
    ).rows;
    const originalSubmit = historic.find(
        (row) => row.operation_id === submit.operationReference,
      )?.mutation_json,
      originalApprove = historic.find(
        (row) => row.operation_id === approve.operationReference,
      )?.mutation_json;
    assert(originalSubmit && originalApprove);
    assert.deepEqual(terminalMutation.validationEvidence, originalSubmit.validationEvidence);
    assert.deepEqual(terminalMutation.approvalEvidence, originalApprove.approvalEvidence);
    assert(
      terminalMutation.validationEvidence.validUntil <
        terminalMutation.optionSetCurrentQualification.checkedAt,
    );
    assert(
      terminalMutation.approvalEvidence.validUntil <
        terminalMutation.optionSetCurrentQualification.checkedAt,
    );
    assert.equal(terminalMutation.optionSetCurrentQualification.result, "Pass");
    assert(
      Date.parse(terminalMutation.optionSetCurrentQualification.validUntil) -
        Date.parse(terminalMutation.optionSetCurrentQualification.originalObservedAt) <=
        5000,
    );
    await transactions.run(async (tx) => {
      const owner = createPostgresPublishingMutationStore({ run: (work) => work(tx) }, tenant, {
        kind: "Brand",
        brandReference: brand,
        storeReference: null,
      });
      const current = await owner.resolveCurrentOptionSetReleaseForReference({
        publicationReference: terminalMutation.release.releaseId,
        observedAt: now(),
      });
      assert.equal(current.current.release.releaseId, terminalMutation.release.releaseId);
      assert.equal(current.recorded.release.snapshotReference, publish.versionReference);
    });
    assert.deepEqual(await publicationCounts(), afterPublish);
    phase = "PublishedHistory";
    const publishedRoot = publish.expectedAggregateVersion + 1;
    const completeHistory = await history(publishedRoot, null, 20, publicationSet);
    assert.equal(completeHistory.status, 200);
    const entries = completeHistory.body.view.entries;
    assert.equal(entries.length, 3);
    assert.equal(completeHistory.body.view.publicationStatus, "NotEvaluated");
    const sealedEntries = entries.filter((entry) => entry.resultAggregateVersion === publishedRoot);
    assert.deepEqual(sealedEntries.map((entry) => entry.kind).sort(), [
      "DraftSnapshot",
      "FrozenSeal",
    ]);
    const frozenEntry = sealedEntries.find((entry) => entry.kind === "FrozenSeal");
    const successorEntry = sealedEntries.find((entry) => entry.kind === "DraftSnapshot");
    assert.equal(frozenEntry.versionReference, publish.versionReference);
    assert.notEqual(successorEntry.versionReference, frozenEntry.versionReference);
    assert.equal(frozenEntry.operationReference, successorEntry.operationReference);
    assert.equal(frozenEntry.sourceAggregateVersion, publish.expectedAggregateVersion);
    assert.deepEqual(
      (await historicalDraft(publicationOriginalEntry, publicationSet)).body.view.content,
      publicationCreated.body.content,
    );
    const frozenSelector = {
      ...draftSelector(frozenEntry, publicationSet),
      expectedRecordDigest: frozenEntry.recordDigest,
    };
    const historicalFrozen = await post("history", { action: "Frozen", command: frozenSelector });
    assert.equal(historicalFrozen.status, 200);
    assert.equal(historicalFrozen.body.view.recordingStatus, "RecordedFrozen");
    assert.equal(historicalFrozen.body.view.recordDigest, frozenEntry.recordDigest);
    assert.deepEqual(
      historicalFrozen.body.view.content.editorContent,
      publicationCreated.body.content,
    );
    const originalVersusFrozen = await post("history", {
      action: "Compare",
      command: {
        left: { kind: "Draft", command: draftSelector(publicationOriginalEntry, publicationSet) },
        right: { kind: "Frozen", command: frozenSelector },
      },
    });
    assert.equal(originalVersusFrozen.status, 200);
    assert.equal(originalVersusFrozen.body.view.comparison.businessContentChanged, false);
    const publishingTimeline = await post("history", {
      action: "Publishing",
      command: { optionSetReference: publicationSet, before: null, limit: 20 },
    });
    assert.equal(publishingTimeline.status, 200);
    assert.equal(publishingTimeline.body.view.familyReference, publicationSet);
    assert.deepEqual(publishingTimeline.body.view.entries.map((e) => e.operation).sort(), [
      "Approve",
      "CreateDraft",
      "Publish",
      "SubmitReview",
    ]);
    assert.equal(
      publishingTimeline.body.view.entries.find((e) => e.operation === "Approve").actorReference,
      reviewer,
    );
    assert.equal(publishingTimeline.body.view.scope.actorReference, actor);
    const currentPublished = await currentPublication(publicationSet, publishedRoot);
    assert.equal(currentPublished.status, 200);
    assert.equal(currentPublished.body.publicationState, "Published");
    assert.equal(
      currentPublished.body.release.publicationReference,
      terminalMutation.release.releaseId,
    );
    assert.equal(currentPublished.body.release.snapshotReference, publish.versionReference);
    assert.equal(currentPublished.body.release.approvalDisposition, "Approved");
    assert.deepEqual(currentPublished.body.published.content, publicationCreated.body.content);
    assert.equal(currentPublished.body.published.referenceEligibility, "NotEvaluated");
    assert.equal(currentPublished.body.published.eligibility, "NotEvaluated");
    assert.equal(currentPublished.body.published.publishValidation, "Incomplete");
    assert.notEqual(
      (
        await post("current-editor", {
          optionSetReference: publicationSet,
          expectedAggregateVersion: publishedRoot,
        })
      ).body.content.sourceAggregate.draft.versionReference,
      currentPublished.body.published.content.sourceAggregate.draft.versionReference,
    );
    const beforeHistoryDenial = await counts();
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get("catalog.option_set.history.read")],
    );
    assert.equal((await history(publishedRoot, null, 20, publicationSet)).status, 403);
    assert.equal(
      (
        await post("current-editor", {
          optionSetReference: publicationSet,
          expectedAggregateVersion: publishedRoot,
        })
      ).status,
      200,
    );
    assert.equal((await currentPublication(publicationSet, publishedRoot)).status, 200);
    await grant("catalog.option_set.history.read");
    assert.equal((await history(publishedRoot, null, 20, publicationSet)).status, 200);
    assert.deepEqual(await counts(), beforeHistoryDenial);
    assert.deepEqual(await publicationCounts(), afterPublish);
    phase = "Abandonment";
    const unknown = {
        ...create,
        internalCode: "SYNTHETIC_ABANDONED",
        operationReference: reference(),
      },
      preFence = await counts();
    const abandoned = await post(
      "authoring/resolve",
      originalRequest("Create", unknown.operationReference),
    );
    assert.equal(abandoned.status, 200);
    assert.equal(abandoned.body.resolution.outcome, "Abandoned");
    const fenced = await counts();
    assert.deepEqual(fenced, {
      ...preFence,
      fences: preFence.fences + 1,
      audit: preFence.audit + 1,
    });
    assert.equal((await post("create", unknown)).status, 409);
    assert.deepEqual(await counts(), fenced);
    phase = "FinePermission";
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get("catalog.option_set.create")],
    );
    assert.equal(
      (
        await post("create", {
          ...create,
          internalCode: "SYNTHETIC_FINE_DENIED",
          operationReference: reference(),
        })
      ).status,
      403,
    );
    assert.deepEqual(await counts(), fenced);
    await grant("catalog.option_set.create");
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get("catalog.option_set.update")],
    );
    assert.equal(
      (
        await post("draft", {
          ...edit,
          expectedAggregateVersion: 2,
          operationReference: reference(),
        })
      ).status,
      403,
    );
    assert.deepEqual(await counts(), fenced);
    await grant("catalog.option_set.update");
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get("catalog.option_set.read")],
    );
    assert.equal((await read(2)).status, 403);
    const deniedContext = await inspect(2);
    assert.equal(deniedContext.status, 403);
    assert.equal(deniedContext.body.error, "request_denied");
    const deniedList = await list();
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error, "request_denied");
    assert.deepEqual(await counts(), fenced);
    await grant("catalog.option_set.read");
    phase = "FeatureDisabled";
    await feature("catalog.optionset.create", "Disabled");
    const disabled = await post("create", {
      ...create,
      internalCode: "SYNTHETIC_FEATURE_DENIED",
      operationReference: reference(),
    });
    assert.equal(disabled.status, 409);
    // Inspect depends on Detail, not the unrelated Create capability.
    assert.equal((await inspect(2)).status, 200);
    assert.deepEqual(await counts(), fenced);
    await feature("catalog.optionset.create", "Enabled");
    assert.equal((await post("authoring/context", { action: "Create" })).status, 200);
    assert.deepEqual(await counts(), fenced);
    phase = "PublicationContextFeatureDisabled";
    await feature("catalog.optionset.detail", "Disabled");
    const disabledContext = await inspect(2);
    assert.equal(disabledContext.status, 409);
    assert.equal(disabledContext.body.error, "option_set_publication_feature_disabled");
    assert.deepEqual(await counts(), fenced);
    await feature("catalog.optionset.detail", "Enabled");
    assert.equal((await inspect(2)).status, 200);
    phase = "ListFeatureDisabled";
    await feature("catalog.optionset.list", "Disabled");
    const disabledList = await list();
    assert.equal(disabledList.status, 409);
    assert.equal(disabledList.body.error, "option_set_list_feature_disabled");
    assert.equal((await inspect(2)).status, 200);
    const hiddenCapability = await capability("list");
    assert.equal(hiddenCapability.status, 200);
    assert.equal(hiddenCapability.body.backendExecution, "Deny");
    assert.equal(hiddenCapability.body.frontendVisibility, "Hide");
    assert.equal(hiddenCapability.body.reason, "Disabled");
    assert.deepEqual(await counts(), fenced);
    await feature("catalog.optionset.list", "Enabled");
    assert.equal((await list()).status, 200);
    assert.deepEqual(await counts(), fenced);
    phase = "ProductPublishedOptionBinding";
    // Reuse the same real encrypted Session and server/pilot ports. A zero-SKU
    // Product needs no invented unit, Variant or sale applicability source.
    const productPost = (path, body, options = {}) =>
      post(path, body, { ...options, product: true });
    let discardDraftReply = false;
    const dispatchedProduct = [];
    const productFetcher = async (path, init) => {
      assert.equal(init.method, "POST");
      const headers = new globalThis.Headers(init.headers);
      assert.equal(headers.get("x-bop-csrf"), session.csrf);
      assert.deepEqual(
        JSON.parse(Buffer.from(headers.get("x-bop-catalog-scope"), "base64url").toString("utf8")),
        selected,
      );
      assert.equal(typeof init.body, "string");
      assert(path.startsWith("/merchant/catalog/products"));
      const response = await productPost(
        path.slice("/merchant/catalog/products".length),
        JSON.parse(init.body),
      );
      productHttpStatus = [200, 400, 401, 403, 409, 413, 503].includes(response.status)
        ? response.status
        : "UNKNOWN";
      productHttpCode =
        response.status === 200
          ? "SUCCESS"
          : [
                "request_denied",
                "product_creation_invalid",
                "product_creation_conflict",
                "product_creation_unavailable",
                "product_creation_feature_disabled",
                "product_draft_invalid",
                "product_draft_conflict",
                "product_draft_unavailable",
                "product_draft_feature_disabled",
                "product_option_picker_invalid",
                "product_option_picker_conflict",
                "product_option_picker_unavailable",
                "product_option_picker_feature_disabled",
              ].includes(response.body?.error)
            ? response.body.error
            : "UNKNOWN";
      dispatchedProduct.push({ path, status: response.status });
      if (
        discardDraftReply &&
        path === "/merchant/catalog/products/draft" &&
        response.status === 200
      ) {
        discardDraftReply = false;
        throw new Error("SYNTHETIC_PRODUCT_REPLY_LOSS_AFTER_HTTP_200");
      }
      return new globalThis.Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json", "cache-control": response.cacheControl },
      });
    };
    const commands = createProductCommandClient(productFetcher);
    const productRecovery = createProductAuthoringRecoveryClient(productFetcher, () =>
      Date.parse(now()),
    );
    const productSignal = new globalThis.AbortController().signal;
    const productCreation = {
      operationReference: reference(),
      internalCode: "SYNTHETIC_PUBLISHED_OPTION_PRODUCT",
      productType: "PreparedFood",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic Product with actual published choices" },
      taxClassificationReference: null,
      skus: [],
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: { "en-CA": "Actual published choices" },
        localizedDescriptions: { "en-CA": "Real current-runtime binding persistence" },
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
    };
    productStage = "Create";
    const productCreated = await commands
      .prepareCreate(productCreation, selected)
      .execute(session.csrf);
    const productReference = productCreated.productReference;
    const productCounts = async () =>
      (
        await admin.query(
          "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
          [productReference],
        )
      ).rows[0];
    const productRead = async (revision) => {
      const result = await productPost("/editor", {
        productReference,
        expectedAggregateVersion: revision,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.aggregateVersion, revision);
      return result.body.aggregate;
    };
    const originalProduct = await productRead(1);
    assert.deepEqual(originalProduct.draft.editorContent, productCreation.editorContent);
    const selectedPublished = await productPost("/option-binding-picker", {
      optionSetReference: publicationSet,
      versionReference: null,
    });
    assert.equal(selectedPublished.status, 200);
    const picked = selectedPublished.body;
    assert.equal(picked.profile, "CatalogProductOptionBindingPickerV1");
    assert.equal(picked.sourceAuthority, "CurrentPublishingReleaseAndFrozenContent");
    assert.equal(picked.versionReference, publish.versionReference);
    assert.equal(picked.publicationReference, terminalMutation.release.releaseId);
    for (const field of ["sourceDigest", "contentDigest", "configurationDigest"])
      assert.equal(picked[field], currentPublished.body.published[field]);
    assert.deepEqual(picked.rootSelectionRule, {
      minimumSelection: create.draft.minimumSelection,
      maximumSelection: create.draft.maximumSelection,
      allowRepeatedOption: create.draft.allowRepeatedOption,
      perOptionMaximumQuantity: create.draft.perOptionMaximumQuantity,
      maximumTotalQuantity: create.draft.maximumTotalQuantity,
      displayStyle: create.draft.displayStyle,
    });
    assert.deepEqual(
      [picked.tenantReference, picked.brandReference, picked.storeReference, picked.actorReference],
      [tenant, brand, storeReference, actor],
    );
    assert.equal(picked.referenceEligibility, "NotEvaluated");
    assert.equal(picked.publishValidation, "Incomplete");
    const activeOptions = picked.options.filter((option) => !option.selectionDisabled);
    assert.equal(activeOptions.length, 1);
    const binding = {
      bindingReference: picked.bindingReference,
      optionSetReference: picked.optionSetReference,
      optionSetVersionReference: picked.versionReference,
      purpose: "CUSTOMIZATION",
      sortOrder: 0,
      enabledOptionReferences: activeOptions.map((option) => option.optionReference),
      defaultSelections: [],
      minimumSelectionOverride: 0,
      maximumSelectionOverride: 1,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    };
    const rule = {
      bindingReference: binding.bindingReference,
      versionResolution: "CurrentPublished",
      pricingRule: null,
      conditionalRule: null,
      conflictRule: null,
      variantCondition: [],
    };
    const addBinding = {
      productReference,
      expectedAggregateVersion: 1,
      operationReference: reference(),
      draft: {
        ...originalProduct.draft,
        optionBindings: [binding],
        editorContent: { ...originalProduct.draft.editorContent, optionRules: [rule] },
      },
    };
    const preparedBinding = commands.prepareDraft(addBinding, selected);
    const beforeBinding = await productCounts();
    productStage = "LostReplyWrite";
    discardDraftReply = true;
    await assert.rejects(
      preparedBinding.execute(session.csrf),
      (error) => error.code === "OutcomeUnknown",
    );
    assert.equal(discardDraftReply, false);
    assert.equal(dispatchedProduct.at(-1).status, 200);
    const originalBindingScope = {
      tenantReference: tenant,
      brandReference: brand,
      storeReference,
      actorReference: actor,
      action: "ReplaceDraft",
      productReference,
    };
    const bindingCursor = parseProductAuthoringCursor(
      {
        profile: "CatalogProductAuthoringCursorV1",
        scope: originalBindingScope,
        operationReference: addBinding.operationReference,
        expectedAggregateVersion: 1,
      },
      originalBindingScope,
    );
    productStage = "ResolveCommitted";
    const resolvedBinding = await productRecovery.resolve(
      bindingCursor,
      session.csrf,
      productSignal,
    );
    assert.equal(resolvedBinding.outcome, "Committed");
    assert.equal(resolvedBinding.aggregateVersion, 2);
    assert.equal(resolvedBinding.productReference, productReference);
    productStage = "ExactOriginalRetry";
    const committedBinding = await preparedBinding.execute(session.csrf);
    assert.equal(committedBinding.aggregateVersion, 2);
    productStage = "ReadOriginalResult";
    const boundProduct = await productRead(2);
    assert.deepEqual(boundProduct.draft.optionBindings, [binding]);
    assert.deepEqual(boundProduct.draft.editorContent, addBinding.draft.editorContent);
    const writtenBinding = await admin.query(
      "SELECT s.occurred_at,s.result_aggregate_version,s.snapshot_json,c.actor_id FROM rms_catalog.product_operation_snapshot s JOIN rms_catalog.product_source_commit c USING(operation_id,brand_id,product_id) WHERE s.operation_id=$1 AND s.brand_id=$2 AND s.product_id=$3",
      [addBinding.operationReference, brand, productReference],
    );
    assert.equal(writtenBinding.rows.length, 1);
    assert.equal(writtenBinding.rows[0].actor_id, actor);
    assert.equal(writtenBinding.rows[0].result_aggregate_version, 2);
    assert.equal(writtenBinding.rows[0].occurred_at.toISOString(), boundProduct.updatedAt);
    assert.equal(
      writtenBinding.rows[0].occurred_at.toISOString(),
      committedBinding.draft.updatedAt,
    );
    assert.deepEqual(writtenBinding.rows[0].snapshot_json, boundProduct);
    const afterBinding = await productCounts();
    assert.equal(afterBinding.root, 2);
    for (const key of ["operations", "snapshots", "commits", "audit", "outbox"])
      assert.equal(afterBinding[key], beforeBinding[key] + 1);
    assert.deepEqual(await preparedBinding.execute(session.csrf), committedBinding);
    assert.deepEqual(await productCounts(), afterBinding);

    phase = "ProductOptionFineReadDenied";
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grants.get("catalog.option_set.read")],
    );
    assert.equal(
      (
        await productPost("/option-binding-picker", {
          optionSetReference: publicationSet,
          versionReference: null,
        })
      ).status,
      403,
    );
    await assert.rejects(
      commands
        .prepareDraft(
          {
            productReference,
            expectedAggregateVersion: 2,
            operationReference: reference(),
            draft: boundProduct.draft,
          },
          selected,
        )
        .execute(session.csrf),
      (error) => error.code === "Denied",
    );
    assert.deepEqual(await productCounts(), afterBinding);
    await grant("catalog.option_set.read");

    // Move the Option Published head through actual ordinary authoring and
    // independently approved publishing. No private head/release SQL mutation.
    phase = "ProductOptionPublishedHeadAdvance";
    const nextOptionDraft = await post("draft", {
      optionSetReference: publicationSet,
      expectedAggregateVersion: publishedRoot,
      operationReference: reference(),
      archiveOptionReferences: [],
      draft: {
        ...create.draft,
        localizedNames: { "en-CA": "Synthetic new published choices" },
        options: create.draft.options.map((option, index) => ({
          ...option,
          lifecycle: "Active",
          identity: { kind: "Existing", optionReference: activeOptions[index].optionReference },
        })),
      },
      additionalContent: create.additionalContent,
    });
    assert.equal(nextOptionDraft.status, 200);
    const nextSubmit = publicationRequest(
      "SubmitReview",
      await publicationContextFor("SubmitReview"),
    );
    assert.equal((await post("publication/command", nextSubmit)).status, 200);
    const nextApprove = publicationRequest("Approve", await publicationContextFor("Approve", true));
    assert.equal(
      (await post("publication/command", nextApprove, { independent: true })).status,
      200,
    );
    const nextPublish = publicationRequest("Publish", await publicationContextFor("Publish"));
    assert.equal((await post("publication/command", nextPublish)).status, 200);
    const newHead = await productPost("/option-binding-picker", {
      optionSetReference: publicationSet,
      versionReference: null,
    });
    assert.equal(newHead.status, 200);
    assert.notEqual(newHead.body.versionReference, binding.optionSetVersionReference);
    // Historical original replay stays the original receipt despite today's head.
    assert.deepEqual(
      await productRecovery.resolve(bindingCursor, session.csrf, productSignal),
      resolvedBinding,
    );
    assert.deepEqual(await preparedBinding.execute(session.csrf), committedBinding);
    assert.deepEqual(await productCounts(), afterBinding);
    const staleBinding = {
      ...addBinding,
      expectedAggregateVersion: 2,
      operationReference: reference(),
      draft: boundProduct.draft,
    };
    await assert.rejects(
      commands.prepareDraft(staleBinding, selected).execute(session.csrf),
      (error) => error.code === "Conflict",
    );
    assert.deepEqual(await productCounts(), afterBinding);
    assert.deepEqual((await productRead(2)).draft.optionBindings, [binding]);

    // Explicit Frozen pins remain exact and never silently select the new head.
    phase = "ProductPinnedOptionBinding";
    const pinned = await productPost("/option-binding-picker", {
      optionSetReference: publicationSet,
      versionReference: binding.optionSetVersionReference,
    });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.sourceAuthority, "RecordedFrozen");
    assert.equal(pinned.body.versionReference, binding.optionSetVersionReference);
    assert.equal(pinned.body.publicationReference, null);
    for (const field of [
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "originalRecordDigest",
    ])
      assert.equal(pinned.body[field], picked[field]);
    assert.deepEqual(pinned.body.options, picked.options);
    const configuredBinding = {
      ...binding,
      purpose: "EXPLICIT_PIN",
      sortOrder: 1,
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
    };
    const configure = {
      productReference,
      expectedAggregateVersion: 2,
      operationReference: reference(),
      draft: {
        ...boundProduct.draft,
        optionBindings: [configuredBinding],
        editorContent: {
          ...boundProduct.draft.editorContent,
          optionRules: [{ ...rule, versionResolution: "Pinned" }],
        },
      },
    };
    productStage = "ConfigurePinned";
    const configured = await commands.prepareDraft(configure, selected).execute(session.csrf);
    assert.equal(configured.aggregateVersion, 3);
    productStage = "ReadPinnedResult";
    const pinnedProduct = await productRead(3);
    assert.deepEqual(pinnedProduct.draft.optionBindings, [configuredBinding]);
    assert.deepEqual(pinnedProduct.draft.editorContent, configure.draft.editorContent);
    const remove = {
      productReference,
      expectedAggregateVersion: 3,
      operationReference: reference(),
      draft: {
        ...pinnedProduct.draft,
        optionBindings: [],
        editorContent: { ...pinnedProduct.draft.editorContent, optionRules: [] },
      },
    };
    const preparedRemoval = commands.prepareDraft(remove, selected);
    productStage = "RemoveBinding";
    const removed = await preparedRemoval.execute(session.csrf);
    assert.equal(removed.aggregateVersion, 4);
    productStage = "ReadRemovedResult";
    const clearedProduct = await productRead(4);
    assert.deepEqual(clearedProduct.draft.optionBindings, []);
    assert.deepEqual(clearedProduct.draft.editorContent, remove.draft.editorContent);
    const afterRemoval = await productCounts();
    productStage = "RetryRemoval";
    assert.deepEqual(await preparedRemoval.execute(session.csrf), {
      ...removed,
      status: "AlreadyApplied",
    });
    assert.deepEqual(await productCounts(), afterRemoval);
    // New Product Audit and second Option publication are legitimate writes;
    // retain the following Session denial no-write assertion against this state.
    const sessionDenialBaseline = await counts();
    phase = "SessionRevoked";
    const revoked = await admin.query(
      "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='Administrative',revoked_at=$2,version=version+1 WHERE actor_id=$1",
      [actor, now()],
    );
    revocationRows = revoked.rowCount;
    assert.equal(revocationRows, 1);
    const persisted = await admin.query(
      "SELECT status,revocation_reason,revoked_at IS NOT NULL has_revoked_at FROM bop_identity.authentication_session WHERE actor_id=$1",
      [actor],
    );
    assert.equal(persisted.rows.length, 1);
    revokedSessionState = ["Active", "Revoked", "Expired"].includes(persisted.rows[0].status)
      ? persisted.rows[0].status
      : "UNKNOWN";
    assert.equal(revokedSessionState, "Revoked");
    assert.equal(persisted.rows[0].revocation_reason, "Administrative");
    assert.equal(persisted.rows[0].has_revoked_at, true);
    const deniedSession = await post("create", {
      ...create,
      internalCode: "SYNTHETIC_SESSION_DENIED",
      operationReference: reference(),
    });
    revocationHttpStatus = deniedSession.status;
    revocationHttpCode = [
      "request_denied",
      "option_set_authoring_invalid",
      "option_set_authoring_conflict",
      "option_set_authoring_unavailable",
    ].includes(deniedSession.body?.error)
      ? deniedSession.body.error
      : "UNKNOWN";
    assert.equal(revocationHttpStatus, 403);
    const revokedContext = await inspect(2);
    assert.equal(revokedContext.status, 403);
    assert.equal(revokedContext.body.error, "request_denied");
    assert.deepEqual(await counts(), sessionDenialBaseline);
  } catch (error) {
    const productClientCode =
      error instanceof ProductCommandClientError &&
      [
        "Invalid",
        "Denied",
        "FeatureDisabled",
        "Conflict",
        "Unavailable",
        "OutcomeUnknown",
      ].includes(error.code)
        ? error.code
        : "NONE";
    const assertionClass =
      error instanceof ProductCommandClientError
        ? "ProductCommandClientError"
        : ["AssertionError", "Error", "TypeError"].includes(error?.name)
          ? error.name
          : "OTHER";
    const assertionCode = error?.code === "ERR_ASSERTION" ? "ERR_ASSERTION" : "NONE";
    const helperFrame =
      typeof error?.stack === "string"
        ? error.stack
            .split("\n")
            .slice(1, 16)
            .map((frame) =>
              frame.match(/(?:\/|\\)(option-set-authoring-runtime-http\.mjs):(\d+):\d+/u),
            )
            .find(Boolean)
        : null;
    const assertionSite = helperFrame ? helperFrame[1] + ":" + helperFrame[2] : "UNLOCATED";
    const boundedCause =
      "BOUNDED_NATIVE_CAUSE class=" +
      assertionClass +
      " code=" +
      assertionCode +
      " site=" +
      assertionSite;
    // Retain the actual Error identity as cause, while removing unrestricted
    // assertion values, SQL fields and nested payloads before any test reporter.
    assert(error instanceof Error, "NATIVE_FAILURE_CAUSE_TYPE_UNAVAILABLE");
    {
      for (const key of Reflect.ownKeys(error)) {
        if (["message", "stack", "name", "code"].includes(String(key))) continue;
        const descriptor = Object.getOwnPropertyDescriptor(error, key);
        if (descriptor?.configurable) Reflect.deleteProperty(error, key);
        else if (descriptor?.writable) error[key] = "WITHHELD";
      }
      error.message = boundedCause;
      error.stack = "Error: " + boundedCause;
      error.name = assertionClass === "OTHER" ? "Error" : assertionClass;
      if (Object.hasOwn(error, "code")) error.code = assertionCode;
    }
    // Deliberately omit payloads, credentials, SQL and unrestricted DB messages.
    throw new Error(
      "OPTION_RUNTIME_HTTP_FAILURE phase=" +
        phase +
        " assertionClass=" +
        assertionClass +
        " assertionCode=" +
        assertionCode +
        " assertionSite=" +
        assertionSite +
        " productPortFailureClass=" +
        productPortFailureClass +
        " productPortFailureCode=" +
        productPortFailureCode +
        " productPortFailureSites=" +
        productPortFailureSites +
        " productPortFailurePhase=" +
        productPortFailurePhase +
        " productStage=" +
        productStage +
        " productClientCode=" +
        productClientCode +
        " productHttpStatus=" +
        productHttpStatus +
        " productHttpCode=" +
        productHttpCode +
        " contextHttpStatus=" +
        (publicationContextHttpStatus ?? "UNOBSERVED") +
        " contextHttpCode=" +
        publicationContextHttpCode +
        " sqlstate=" +
        (sqlState ?? "NONE") +
        " terminalFailureArmed=" +
        failAfterPublicationTerminal +
        " txFailureClass=" +
        transactionFailureClass +
        " txFailureCode=" +
        transactionFailureCode +
        " txFailureSites=" +
        transactionFailureSites +
        " commandClockElapsedMs=" +
        (lastPublicationCommandClock?.first && lastPublicationCommandClock?.last
          ? Date.parse(lastPublicationCommandClock.last) -
            Date.parse(lastPublicationCommandClock.first)
          : "UNOBSERVED") +
        " txGuardPhase=" +
        transactionGuardPhase +
        " txElapsedMs=" +
        (transactionElapsedMs ?? "UNOBSERVED") +
        " txSqlFamily=" +
        transactionSqlFamily +
        " txConstraintReason=" +
        transactionConstraintReason +
        " txQueryStats=" +
        transactionQueryStats +
        " publicationHttpStatus=" +
        (publicationHttpStatus ?? "UNOBSERVED") +
        " publicationHttpCode=" +
        publicationHttpCode +
        " revocationRows=" +
        (revocationRows ?? "UNOBSERVED") +
        " sessionState=" +
        revokedSessionState +
        " httpStatus=" +
        (revocationHttpStatus ?? "UNOBSERVED") +
        " httpCode=" +
        revocationHttpCode,
      { cause: error },
    );
  } finally {
    contextPause?.release();
    try {
      if (reviewerServer) {
        reviewerServer.closeAllConnections();
        await new Promise((resolve) => reviewerServer.close(resolve));
      }
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      try {
        if (createdRole) {
          await admin.query("DROP OWNED BY " + role);
          await admin.query("DROP ROLE " + role);
        }
      } finally {
        try {
          await admin.end();
        } finally {
          if (priceInstallationDirectory !== null)
            await rm(priceInstallationDirectory, { recursive: true, force: true });
        }
      }
    }
  }
}

/** Real HTTP and owning PG price contribution; synthetic governance/currency
 * configuration is setup only. This is not a checkout or rendered UI proof. */
async function exerciseSelectedOptionPricePublication({
  admin,
  tenant,
  brand,
  storeReference,
  actor,
  reviewer,
  now,
  reference,
  post,
  create,
  transactions,
  role,
  currencyMetadata,
  enablePricing,
  restoreProductRead,
  grants,
  setStage,
}) {
  const checked = async (path, body, options = {}) => {
    const response = await post(path, body, options);
    assert.equal(response.status, 200, "Actual ordinary HTTP stage: " + path);
    assert.equal(response.cacheControl, "no-store");
    return response.body;
  };
  setStage("OptionCreate");
  const option = await checked("create", {
    ...create,
    internalCode: "SYNTHETIC_PRICE_CHOICES",
    operationReference: reference(),
    draft: {
      ...create.draft,
      options: create.draft.options.map((value) => ({ ...value, lifecycle: "Active" })),
    },
  });
  const set = option.content.sourceAggregate.optionSetReference;
  let publishedOptionVersion;
  for (const action of ["Validate", "SubmitReview", "Approve", "Publish"]) {
    setStage("Option" + action);
    const independent = action === "Approve";
    const context = await checked(
      "publication/context",
      {
        optionSetReference: set,
        expectedAggregateVersion: null,
        action,
      },
      { independent },
    );
    const command = {
      profile: "CatalogOptionSetPublicationCommandRequestV1",
      action,
      optionSetReference: set,
      versionReference: context.draft.versionReference,
      expectedAggregateVersion: context.draft.aggregateVersion,
      sourceDigest: context.draft.sourceDigest,
      contentDigest: context.draft.contentDigest,
      configurationDigest: context.draft.configurationDigest,
    };
    if (action !== "Validate")
      Object.assign(command, {
        operationReference: reference(),
        expectedReview:
          context.review.kind === "Recorded"
            ? {
                reviewOperationReference: context.review.operationReference,
                publishingReviewOperationReference:
                  context.review.publishingReviewOperationReference,
                recordDigest: context.review.recordDigest,
                bindingDigest: context.review.binding.digest,
              }
            : null,
        expectedLifecycle:
          context.review.kind === "Recorded"
            ? {
                lifecycleReference: context.review.lifecycleReference,
                version: context.review.lifecycle.version,
                state: context.review.lifecycle.state,
                latestMutationOperationReference: context.review.latestMutationOperationReference,
              }
            : null,
      });
    const receipt = await checked("publication/command", command, { independent });
    assert.equal(receipt.outcome, action === "Validate" ? "Validated" : "Committed");
    if (action === "Publish") publishedOptionVersion = command.versionReference;
  }
  setStage("PricingIAMSetup");
  await enablePricing();
  setStage("UnitRegister");
  const units = await checked("/selling-units/inspect", { action: "Create" }, { product: true });
  assert.equal(units.presence, "Absent");
  await checked(
    "/selling-units/register",
    {
      action: "Create",
      operationReference: reference(),
      expectedRegistryVersion: 0,
      defaultLocale: "en-CA",
      units: [
        {
          unitReference: null,
          code: "EA",
          semanticDefinition: "count of one individual item",
          quantityDecimalPlaces: 0,
          localizedNames: { "en-CA": "Synthetic individual item" },
          lifecycle: "Active",
        },
      ],
    },
    { product: true },
  );
  setStage("ProductCreate");
  const created = await checked(
    "",
    {
      operationReference: reference(),
      internalCode: "SYNTHETIC_PRICE_PRODUCT",
      productType: "PreparedFood",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic price Product" },
      taxClassificationReference: null,
      // Explicit ordinary intent: this synthetic Product has known no categories.
      categoryClassification: { primaryCategoryReference: null, categoryReferences: [] },
      skus: [
        {
          skuCode: "SYNTHETIC_PRICE_SKU",
          localizedNames: { "en-CA": "Synthetic item" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
        },
      ],
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
    { product: true },
  );
  const original = (
    await checked(
      "/editor",
      { productReference: created.productReference, expectedAggregateVersion: 1 },
      { product: true },
    )
  ).aggregate;
  assert.equal(original.draft.skus.length, 1);
  setStage("ProductBinding");
  const picker = await checked(
    "/option-binding-picker",
    { optionSetReference: set, versionReference: null },
    { product: true },
  );
  assert.equal(picker.versionReference, publishedOptionVersion);
  const choice = picker.options.find((value) => !value.selectionDisabled);
  assert(choice);
  const binding = {
    bindingReference: picker.bindingReference,
    optionSetReference: set,
    optionSetVersionReference: picker.versionReference,
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: [choice.optionReference],
    defaultSelections: [],
    minimumSelectionOverride: 0,
    maximumSelectionOverride: 1,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  };
  const rule = {
    bindingReference: binding.bindingReference,
    versionResolution: "CurrentPublished",
    pricingRule: null,
    conditionalRule: null,
    conflictRule: null,
    variantCondition: [],
  };
  await checked(
    "/draft",
    {
      productReference: original.productReference,
      expectedAggregateVersion: 1,
      operationReference: reference(),
      draft: {
        ...original.draft,
        optionBindings: [binding],
        editorContent: { ...original.draft.editorContent, optionRules: [rule] },
      },
    },
    { product: true },
  );
  const anchor = {
    productReference: original.productReference,
    expectedProductAggregateVersion: 2,
  };
  const context = {
    ...anchor,
    bindingReference: binding.bindingReference,
    optionReference: choice.optionReference,
  };
  const price = (path, body, options = {}) => checked(path, body, { pricing: true, ...options });
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_pricing.option_price_authoring_operation) pricing_originals,(SELECT count(*)::int FROM rms_pricing.option_price_rule_version) pricing_versions,(SELECT count(*)::int FROM bop_publishing.option_price_review_operation) review_originals,(SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) publishing,(SELECT count(*)::int FROM platform_audit.audit_record) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
      )
    ).rows[0];
  const assertNoChange = async (before) => assert.deepEqual(await counts(), before);
  setStage("PriceScopeRead");
  const beforeScope = await counts();
  const priceScope = await price("scope", {});
  assert.deepEqual(Object.keys(priceScope).sort(), [
    "actorReference",
    "brandReference",
    "observedAt",
    "profile",
    "storeReference",
    "tenantReference",
    "validUntil",
  ]);
  assert.equal(priceScope.profile, "MerchantOptionPriceScopeV1");
  assert.deepEqual(
    [
      priceScope.tenantReference,
      priceScope.brandReference,
      priceScope.storeReference,
      priceScope.actorReference,
    ],
    [tenant, brand, storeReference, actor],
  );
  assert.ok(Date.parse(priceScope.validUntil) > Date.parse(priceScope.observedAt));
  assert.ok(Date.parse(priceScope.validUntil) - Date.parse(priceScope.observedAt) <= 5000);
  await assertNoChange(beforeScope);
  setStage("PriceFirstRead");
  const first = await price("current", { context });
  assert.deepEqual(first.states, []);
  assert.deepEqual(
    [first.tenantReference, first.brandReference, first.storeReference, first.actorReference],
    [tenant, brand, storeReference, actor],
  );
  assert.equal(first.context.optionSourceAuthority, "CurrentPublishingReleaseAndFrozenContent");
  const effectiveFrom = new Date(Date.parse(now()) - 1000).toISOString();
  const command = {
    action: "CreateDraft",
    operationReference: reference(),
    ruleReference: reference(),
    expectedAggregateVersion: null,
    bindingReference: binding.bindingReference,
    optionReference: choice.optionReference,
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: effectiveFrom,
          localDateTime: effectiveFrom.slice(0, 23),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    },
  };
  setStage("PriceDraftLostReply");
  const beforeDraft = await counts();
  const lost = await post(
    "command",
    { command, context: anchor },
    { pricing: true, discard: true },
  );
  assert.equal(lost.status, 200);
  assert.equal(lost.body, null);
  const afterDraft = await counts();
  for (const field of ["pricing_originals", "pricing_versions", "audit", "events"])
    assert.equal(afterDraft[field], beforeDraft[field] + 1);
  assert.equal(afterDraft.review_originals, beforeDraft.review_originals);
  assert.equal(afterDraft.publishing, beforeDraft.publishing);
  const recovered = await price("resolve", { command });
  assert.equal(recovered.outcome, "Committed");
  const replay = await price("command", { command, context: anchor });
  assert.deepEqual(replay.state, recovered.state);
  assert.equal(replay.occurredAt, recovered.occurredAt);
  await assertNoChange(afterDraft);
  const draft = replay.state.draft;
  assert(draft);
  setStage("PriceRequiredReview");
  const reviewQuery = { ruleReference: command.ruleReference, context };
  const beforeReview = await price("review/current", reviewQuery);
  assert.equal(beforeReview.policy.approvalPolicy, "Required");
  assert.deepEqual(beforeReview.review, { outcome: "Absent" });
  const publish = {
    action: "Publish",
    operationReference: reference(),
    ruleReference: command.ruleReference,
    expectedAggregateVersion: 1,
    bindingReference: null,
    optionReference: null,
    content: null,
  };
  const beforeMissingApproval = await counts();
  assert.equal(
    (await post("command", { command: publish, context: anchor }, { pricing: true })).status,
    409,
  );
  await assertNoChange(beforeMissingApproval);
  const validationValidUntil = new Date(Date.parse(now()) + 60000).toISOString();
  const submit = {
    action: "SubmitReview",
    operationReference: reference(),
    ruleReference: command.ruleReference,
    draftVersionReference: beforeReview.draftVersionReference,
    draftSnapshotDigest: beforeReview.draftSnapshotDigest,
    expectedAggregateVersion: beforeReview.aggregateVersion,
    validationValidUntil,
    approvalValidUntil: null,
    expectedLifecycle: null,
  };
  setStage("PriceSubmitLostReply");
  assert.equal(
    (await post("review/command", { command: submit, context }, { pricing: true, discard: true }))
      .status,
    200,
  );
  const afterSubmit = await counts();
  assert.equal(afterSubmit.review_originals, afterDraft.review_originals + 1);
  assert.equal(afterSubmit.publishing, afterDraft.publishing + 2);
  assert.equal(afterSubmit.audit, afterDraft.audit + 2);
  assert.equal(afterSubmit.events, afterDraft.events);
  setStage("PriceSubmitResolveOriginal");
  const submitted = await price("review/resolve", { command: submit });
  assert.equal(submitted.outcome, "Committed");
  setStage("PriceSubmitReplayOriginal");
  const replaySubmit = await price("review/command", { command: submit, context });
  assert.equal(replaySubmit.occurredAt, submitted.occurredAt);
  await assertNoChange(afterSubmit);
  setStage("PriceIndependentReviewCurrent");
  const currentReview = await price("review/current", reviewQuery, { independent: true });
  assert.equal(currentReview.review.lifecycle.state, "InReview");
  assert.equal(currentReview.draftAuthorActorReference, actor);
  assert.equal(currentReview.review.submittedActorReference, actor);
  const approve = {
    ...submit,
    action: "Approve",
    operationReference: reference(),
    approvalValidUntil: new Date(Date.parse(validationValidUntil) - 1000).toISOString(),
    expectedLifecycle: currentReview.review.lifecycle,
  };
  setStage("PriceSelfApprovalDenied");
  const beforeSelf = await counts();
  const selfApproval = await post(
    "review/command",
    { command: approve, context },
    { pricing: true },
  );
  assert.equal(selfApproval.status, 409);
  assert.equal(selfApproval.body.error, "option_price_conflict");
  await assertNoChange(beforeSelf);
  setStage("PriceIndependentApprove");
  const approved = await price(
    "review/command",
    { command: approve, context },
    { independent: true },
  );
  assert.equal(approved.outcome, "Committed");
  assert.equal(approved.actorReference, reviewer);
  const afterApprove = await counts();
  assert.equal(afterApprove.review_originals, afterSubmit.review_originals + 1);
  assert.equal(afterApprove.publishing, afterSubmit.publishing + 1);
  assert.equal(afterApprove.audit, afterSubmit.audit + 1);
  assert.equal(afterApprove.events, afterSubmit.events);
  assert.equal((await post("review/resolve", { command: approve }, { pricing: true })).status, 403);
  await assertNoChange(afterApprove);
  const approvedView = await price("review/current", reviewQuery);
  assert.equal(approvedView.review.lifecycle.state, "Approved");
  assert.equal(approvedView.review.approvedActorReference, reviewer);
  setStage("PricePublishLostReply");
  assert.equal(
    (await post("command", { command: publish, context: anchor }, { pricing: true, discard: true }))
      .status,
    200,
  );
  const afterPublish = await counts();
  for (const field of ["pricing_originals", "pricing_versions", "audit", "events"])
    assert.equal(afterPublish[field], afterApprove[field] + 1);
  assert.equal(afterPublish.review_originals, afterApprove.review_originals);
  assert.equal(afterPublish.publishing, afterApprove.publishing);
  const published = await price("resolve", { command: publish });
  assert.equal(published.outcome, "Committed");
  assert.equal(published.state.currentPublished.lifecycle, "Published");
  assert.equal(published.state.currentPublished.unitAmount.amountMinor, "125");
  assert.equal(published.state.draft, null);
  const publishedReplay = await price("command", { command: publish, context: anchor });
  assert.deepEqual(publishedReplay.state, published.state);
  await assertNoChange(afterPublish);
  setStage("PriceCurrentAndQuote");
  const read = await price("current", { context });
  assert.deepEqual(read.states, [published.state]);
  const currentPrices = createPostgresCurrentOptionPriceStore(
    transactions,
    { brandReference: brand, storeReference },
    currencyMetadata,
  );
  const quoteRequest = {
    bindingReference: binding.bindingReference,
    optionReference: choice.optionReference,
    skuReference: original.draft.skus[0].skuReference,
    storeGroupReference: null,
    regionReference: null,
    channelCode: "APP",
    orderType: "Pickup",
  };
  const quotes = await currentPrices.load({ ...quoteRequest, observedAt: now() });
  assert.equal(quotes.length, 1);
  assert.equal(
    String(quotes[0].versionReference),
    published.state.currentPublished.versionReference,
  );
  assert.equal(quotes[0].unitAmount.amountMinor, 125n);
  const quoteContext = {
    brandReference: brand,
    storeReference,
    bindingReference: binding.bindingReference,
    optionReference: choice.optionReference,
    skuReference: original.draft.skus[0].skuReference,
    storeGroupReference: null,
    regionReference: null,
    channelCode: "APP",
    orderType: "Pickup",
    currencyMetadata,
    selectedQuantity: 2,
    itemQuantity: 1,
  };
  const contribution = resolveOptionPrice(quotes, { ...quoteContext, evaluatedAt: now() });
  assert.equal(contribution.amount.amountMinor, 125n);
  setStage("PriceSuccessorDraftRetainsPublished");
  const successor = {
    ...command,
    operationReference: reference(),
    expectedAggregateVersion: 2,
    content: { ...command.content, unitAmountMinor: "200" },
  };
  const nextDraft = await price("command", { command: successor, context: anchor });
  assert.equal(nextDraft.state.aggregateVersion, 3);
  assert.equal(nextDraft.state.ruleReference, command.ruleReference);
  assert.equal(nextDraft.state.draft.unitAmount.amountMinor, "200");
  assert.notEqual(
    nextDraft.state.draft.versionReference,
    published.state.currentPublished.versionReference,
  );
  assert.deepEqual(nextDraft.state.currentPublished, published.state.currentPublished);
  const afterSuccessor = await counts();
  for (const field of ["pricing_originals", "pricing_versions", "audit", "events"])
    assert.equal(afterSuccessor[field], afterPublish[field] + 1);
  assert.equal(afterSuccessor.review_originals, afterPublish.review_originals);
  assert.equal(afterSuccessor.publishing, afterPublish.publishing);
  const successorRead = await price("current", { context });
  assert.deepEqual(successorRead.states, [nextDraft.state]);
  const retainedQuotes = await currentPrices.load({ ...quoteRequest, observedAt: now() });
  assert.equal(retainedQuotes.length, 1);
  assert.equal(
    String(retainedQuotes[0].versionReference),
    published.state.currentPublished.versionReference,
  );
  assert.equal(retainedQuotes[0].unitAmount.amountMinor, 125n);
  assert.equal(
    resolveOptionPrice(retainedQuotes, { ...quoteContext, evaluatedAt: now() }).amount.amountMinor,
    125n,
  );
  await assertNoChange(afterSuccessor);
  setStage("PriceArchiveWithdrawsPublishedPreservesDraft");
  const archive = {
    action: "Archive",
    operationReference: reference(),
    ruleReference: command.ruleReference,
    expectedAggregateVersion: 3,
    bindingReference: null,
    optionReference: null,
    content: null,
  };
  const archived = await price("command", { command: archive, context: anchor });
  assert.equal(archived.state.aggregateVersion, 4);
  assert.equal(archived.state.currentPublished, null);
  assert.deepEqual(archived.state.draft, nextDraft.state.draft);
  assert.equal(archived.state.draftAuthorActorReference, nextDraft.state.draftAuthorActorReference);
  assert.equal(archived.state.latestVersion.lifecycle, "Archived");
  const afterArchive = await counts();
  for (const field of ["pricing_originals", "pricing_versions", "audit", "events"])
    assert.equal(afterArchive[field], afterSuccessor[field] + 1);
  assert.equal(afterArchive.review_originals, afterSuccessor.review_originals);
  assert.equal(afterArchive.publishing, afterSuccessor.publishing);
  const archiveRead = await price("current", { context });
  assert.deepEqual(archiveRead.states, [archived.state]);
  const withdrawnQuotes = await currentPrices.load({ ...quoteRequest, observedAt: now() });
  assert.deepEqual(withdrawnQuotes, []);
  assert.throws(
    () => resolveOptionPrice(withdrawnQuotes, { ...quoteContext, evaluatedAt: now() }),
    { code: "OPTION_PRICE_MISSING" },
  );
  assert.equal(contribution.amount.amountMinor, 125n);
  assert.equal(
    String(contribution.rule.versionReference),
    published.state.currentPublished.versionReference,
  );
  const historicVersion = await admin.query(
    "SELECT unit_amount_minor::text amount,lifecycle FROM rms_pricing.option_price_rule_version WHERE brand_id=$1 AND option_price_rule_id=$2 AND option_price_rule_version_id=$3",
    [brand, command.ruleReference, published.state.currentPublished.versionReference],
  );
  assert.equal(historicVersion.rows.length, 1);
  assert.deepEqual(historicVersion.rows[0], { amount: "125", lifecycle: "Published" });
  setStage("PriceOriginalPublishedReceiptAfterWithdrawal");
  const historicalResolve = await price("resolve", { command: publish });
  const historicalReplay = await price("command", { command: publish, context: anchor });
  for (const historical of [historicalResolve, historicalReplay]) {
    assert.equal(historical.outcome, "Committed");
    assert.equal(historical.operationReference, publish.operationReference);
    assert.equal(historical.actorReference, published.actorReference);
    assert.equal(historical.occurredAt, published.occurredAt);
    assert.equal(historical.state.aggregateVersion, 2);
    assert.deepEqual(historical.state, published.state);
  }
  await assertNoChange(afterArchive);
  setStage("PriceStaleCASRollback");
  const stale = {
    ...command,
    action: "ReplaceDraft",
    operationReference: reference(),
    expectedAggregateVersion: 1,
    bindingReference: null,
    optionReference: null,
  };
  assert.equal(
    (await post("command", { command: stale, context: anchor }, { pricing: true })).status,
    409,
  );
  await assertNoChange(afterArchive);
  setStage("PriceWrongScopeDenied");
  const headers = {
    "x-bop-catalog-scope": Buffer.from(
      JSON.stringify({ brandReference: brand, storeReference: reference() }),
    ).toString("base64url"),
  };
  assert.equal((await post("current", { context }, { pricing: true, headers })).status, 403);
  await assertNoChange(afterArchive);
  setStage("PriceProductReadRevoked");
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
    [grants.get("catalog.product.read")],
  );
  assert.equal((await post("current", { context }, { pricing: true })).status, 403);
  assert.equal((await post("review/current", reviewQuery, { pricing: true })).status, 403);
  assert.equal((await post("scope", {}, { pricing: true })).status, 200);
  await assertNoChange(afterArchive);
  await restoreProductRead();
  assert.equal((await post("current", { context }, { pricing: true })).status, 200);
  await assertNoChange(afterArchive);
  setStage("PriceCurrentGrantRevoked");
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
    [grants.get("pricing.price-book.manage")],
  );
  assert.equal((await post("scope", {}, { pricing: true })).status, 403);
  assert.equal((await post("current", { context }, { pricing: true })).status, 403);
  assert.equal((await post("resolve", { command: publish }, { pricing: true })).status, 403);
  await assertNoChange(afterArchive);
  // Actual missing/foreign terminal attacks and both contender orderings are
  // covered by the separate real 014/017 owner cases; this case proves genuine
  // current IAM composition and refusal rollback, not fake positive evidence.
  assert.match(role, /^wp2421_opt_http_[a-f0-9]+$/u);
}

/** A separate actual-HTTP journey. Synthetic identities/configuration are seeded
 * above; Session, IAM, FeatureControl, source acquisition, warnings, approval,
 * owning persistence and current-head checks are the production implementations. */
async function exerciseSelectedProductPublication({
  admin,
  tenant,
  brand,
  storeReference,
  actor,
  reviewer,
  now,
  reference,
  post,
  create,
  setStage,
}) {
  setStage("OptionCreate");
  const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const created = await post("create", {
    ...create,
    internalCode: "SYNTHETIC_PRODUCT_PUBLICATION_CHOICES",
    operationReference: reference(),
    draft: {
      ...create.draft,
      options: create.draft.options.map((option) => ({ ...option, lifecycle: "Active" })),
    },
  });
  assert.equal(created.status, 200, "Actual Option Create must commit");
  const set = created.body.content.sourceAggregate.optionSetReference;
  const optionContext = async (action) => {
    const response = await post(
      "publication/context",
      {
        optionSetReference: set,
        expectedAggregateVersion: null,
        action,
      },
      { independent: action === "Approve" },
    );
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, "no-store");
    assert.equal(response.body.actorReference, action === "Approve" ? reviewer : actor);
    return response.body;
  };
  const optionCommand = (action, context) => {
    const draft = context.draft,
      review = context.review;
    const command = {
      profile: "CatalogOptionSetPublicationCommandRequestV1",
      action,
      optionSetReference: draft.optionSetReference,
      versionReference: draft.versionReference,
      expectedAggregateVersion: draft.aggregateVersion,
      sourceDigest: draft.sourceDigest,
      contentDigest: draft.contentDigest,
      configurationDigest: draft.configurationDigest,
    };
    if (action === "Validate") return command;
    return {
      ...command,
      operationReference: reference(),
      expectedReview:
        review.kind === "Recorded"
          ? {
              reviewOperationReference: review.operationReference,
              publishingReviewOperationReference: review.publishingReviewOperationReference,
              recordDigest: review.recordDigest,
              bindingDigest: review.binding.digest,
            }
          : null,
      expectedLifecycle:
        review.kind === "Recorded"
          ? {
              lifecycleReference: review.lifecycleReference,
              version: review.lifecycle.version,
              state: review.lifecycle.state,
              latestMutationOperationReference: review.latestMutationOperationReference,
            }
          : null,
    };
  };
  async function publishOption() {
    let publish;
    for (const action of ["Validate", "SubmitReview", "Approve", "Publish"]) {
      setStage("Option" + action);
      const context = await optionContext(action),
        command = optionCommand(action, context);
      if (action === "Approve") {
        assert.equal(context.review.kind, "Recorded");
        assert.equal(context.review.submittedActorReference, actor);
        assert.notEqual(
          context.review.operationReference,
          context.review.publishingReviewOperationReference,
        );
      }
      const response = await post("publication/command", command, {
        independent: action === "Approve",
      });
      assert.equal(response.status, 200, "Actual Option publication action: " + action);
      assert.equal(response.cacheControl, "no-store");
      if (action === "Validate") {
        assert.equal(response.body.outcome, "Validated");
        assert.equal(response.body.validation.decision, "Pass");
      } else {
        assert.equal(response.body.profile, "CatalogOptionSetPublicationReceiptV1");
        assert.equal(response.body.outcome, "Committed");
        assert.equal(response.body.operationReference, command.operationReference);
      }
      if (action === "Publish") publish = command;
    }
    const current = await post("current-published", {
      optionSetReference: set,
      expectedAggregateVersion: null,
    });
    assert.equal(current.status, 200);
    assert.equal(current.body.publicationState, "Published");
    assert.equal(current.body.release.snapshotReference, publish.versionReference);
    assert.equal(current.body.release.approvalDisposition, "Approved");
    return { command: publish, view: current.body };
  }
  const firstOption = await publishOption();
  // A real empty registry is a checked precondition, not a fallback for source failure.
  setStage("UnitInspect");
  const inspect = await post("/selling-units/inspect", { action: "Create" }, { product: true });
  assert.equal(inspect.status, 200);
  assert.equal(inspect.body.presence, "Absent");
  assert.equal(inspect.body.registryVersion, 0);
  assert.deepEqual(inspect.body.assignedHistory, []);
  setStage("UnitRegister");
  const register = await post(
    "/selling-units/register",
    {
      action: "Create",
      operationReference: reference(),
      expectedRegistryVersion: 0,
      defaultLocale: "en-CA",
      units: [
        {
          unitReference: null,
          code: "EA",
          semanticDefinition: "count of one individual item",
          quantityDecimalPlaces: 0,
          localizedNames: { "en-CA": "Synthetic individual item" },
          lifecycle: "Active",
        },
      ],
    },
    { product: true },
  );
  assert.equal(
    register.status,
    200,
    "Actual unit definition must be registered before creating SKU",
  );

  const productPost = (path, body, actorReference = actor) =>
    post(path, body, {
      product: true,
      independent: actorReference === reviewer,
    });
  const readProduct = async (productReference, expectedAggregateVersion) => {
    const response = await productPost("/editor", { productReference, expectedAggregateVersion });
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, "no-store");
    const aggregate = parseProductAggregate(response.body.aggregate);
    assert.equal(aggregate.productReference, productReference);
    assert.equal(aggregate.aggregateVersion, expectedAggregateVersion);
    return aggregate;
  };
  async function createBoundProduct(code, versionReference, resolution) {
    setStage(resolution + "ProductCreate");
    const response = await productPost("", {
      operationReference: reference(),
      internalCode: code,
      productType: "PreparedFood",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic actual-source publication Product" },
      taxClassificationReference: null,
      skus: [
        {
          skuCode: code + "_SKU",
          localizedNames: { "en-CA": "Synthetic individual item" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
        },
      ],
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
    });
    assert.equal(
      response.status,
      200,
      "Actual complete Product Create with real registered base SKU",
    );
    let aggregate = await readProduct(response.body.productReference, 1);
    assert.equal(aggregate.draft.skus.length, 1);
    setStage(resolution + "SkuActivate");
    const activate = await productPost("/lifecycle", {
      productReference: aggregate.productReference,
      skuReference: aggregate.draft.skus[0].skuReference,
      targetLifecycle: "Active",
      expectedAggregateVersion: aggregate.aggregateVersion,
      operationReference: reference(),
    });
    assert.equal(activate.status, 200);
    assert.equal(activate.body.skuLifecycle, "Active");
    aggregate = await readProduct(aggregate.productReference, activate.body.aggregateVersion);
    assert.equal(aggregate.draft.skus[0].lifecycle, "Active");
    setStage(resolution + "BindingPicker");
    const pickedResponse = await productPost("/option-binding-picker", {
      optionSetReference: set,
      versionReference,
    });
    assert.equal(pickedResponse.status, 200);
    const picked = pickedResponse.body;
    assert.equal(picked.profile, "CatalogProductOptionBindingPickerV1");
    assert.deepEqual(
      [picked.tenantReference, picked.brandReference, picked.storeReference, picked.actorReference],
      [tenant, brand, storeReference, actor],
    );
    assert.equal(
      picked.sourceAuthority,
      resolution === "CurrentPublished"
        ? "CurrentPublishingReleaseAndFrozenContent"
        : "RecordedFrozen",
    );
    assert.equal(picked.referenceEligibility, "NotEvaluated");
    assert.equal(picked.publishValidation, "Incomplete");
    const options = picked.options.filter((option) => !option.selectionDisabled);
    assert.equal(options.length, 1);
    const binding = {
      bindingReference: picked.bindingReference,
      optionSetReference: picked.optionSetReference,
      optionSetVersionReference: picked.versionReference,
      purpose: "CUSTOMIZATION",
      sortOrder: 0,
      enabledOptionReferences: options.map((option) => option.optionReference),
      defaultSelections: [],
      minimumSelectionOverride: 0,
      maximumSelectionOverride: 1,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    };
    setStage(resolution + "BindingDraft");
    const saved = await productPost("/draft", {
      operationReference: reference(),
      productReference: aggregate.productReference,
      expectedAggregateVersion: aggregate.aggregateVersion,
      draft: {
        ...aggregate.draft,
        optionBindings: [binding],
        editorContent: {
          ...aggregate.draft.editorContent,
          optionRules: [
            {
              bindingReference: picked.bindingReference,
              versionResolution: resolution,
              pricingRule: null,
              conditionalRule: null,
              conflictRule: null,
              variantCondition: [],
            },
          ],
        },
      },
    });
    assert.equal(saved.status, 200, "Actual Product binding draft must persist");
    aggregate = await readProduct(aggregate.productReference, saved.body.aggregateVersion);
    assert.deepEqual(aggregate.draft.optionBindings, [binding]);
    return { aggregate, picked };
  }
  const counts = async (productReference) =>
    (
      await admin.query(
        `SELECT p.aggregate_version root,
    (SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=p.product_id) operations,
    (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=p.product_id) snapshots,
    (SELECT count(*)::int FROM rms_catalog.product_publication_revision WHERE product_id=p.product_id) revisions,
    (SELECT count(*)::int FROM rms_catalog.product_publication_validation_report WHERE product_id=p.product_id) reports,
    (SELECT count(*)::int FROM rms_catalog.product_publication_warning_acknowledgement WHERE product_id=p.product_id) acknowledgements,
    (SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=p.product_id) approvals,
    (SELECT count(*)::int FROM platform_audit.audit_record) audit,
    (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox
    FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2`,
        [brand, productReference],
      )
    ).rows[0];
  const transport = (command) =>
    Object.fromEntries(
      Object.entries(command).filter(
        ([key]) =>
          ![
            "tenantReference",
            "brandReference",
            "actorReference",
            "actorKind",
            "purposeCode",
          ].includes(key),
      ),
    );
  const send = (command) =>
    productPost(
      command.action === "AcknowledgeProductPublicationWarnings"
        ? "/publication/warning-acknowledgements/v1"
        : "/publication/v2",
      transport(command),
      command.actorReference,
    );
  function command(aggregate, current, action, actorReference) {
    const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
      occurredAt = now();
    return parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: tenant,
      brandReference: brand,
      actorReference,
      actorKind: "User",
      operationReference: reference(),
      productReference: aggregate.productReference,
      versionReference: aggregate.draft.versionReference,
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: current?.publicationVersion ?? 0,
      action,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: current?.scopeSet ?? [
        { level: "Store", reference: storeReference, channelCodes: [], orderTypeCodes: [] },
      ],
      effectivePeriod: current?.effectivePeriod ?? {
        timeZone: "UTC",
        effectiveFrom: {
          instant: occurredAt,
          localDateTime: occurredAt.slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      replacementIntent: current?.replacementIntent ?? { ...none, digest: hash(none) },
      replacementIntentDigest: current?.replacementIntentDigest ?? hash(none),
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: action === "Publish" ? reference() : null,
      occurredAt,
      reasonCode: "ISOLATED_ASSEMBLED_" + action.toUpperCase(),
    });
  }
  function acknowledgement(result, actorReference) {
    const report = result.validationReport.report;
    assert.equal(result.validationReport.status, "Recorded");
    assert.equal(report.details.coverage, "Complete");
    return parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: tenant,
      brandReference: brand,
      actorReference,
      actorKind: "User",
      operationReference: reference(),
      productReference: result.aggregate.productReference,
      versionReference: result.publication.versionReference,
      expectedProductAggregateVersion: result.aggregate.aggregateVersion,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: report.validation.checks
        .filter((check) => check.outcome === "Warning")
        .map((check) => check.code)
        .sort(),
      reasonCode: "CONFIRMED_FOUR_MISSING_CONFIGURATIONS",
      occurredAt: now(),
    });
  }
  const bound = await createBoundProduct("SYNTHETIC_CURRENT_PUBLICATION", null, "CurrentPublished");
  assert.equal(bound.picked.versionReference, firstOption.command.versionReference);
  assert.equal(bound.picked.publicationReference, firstOption.view.release.publicationReference);
  let aggregate = bound.aggregate,
    current = null;
  const product = aggregate.productReference,
    originalDraftVersion = aggregate.draft.versionReference;
  async function view(actorReference = actor) {
    const before = await counts(product);
    const managementReply = await productPost(
      "/publication/management/v2",
      {
        productReference: product,
        expectedAggregateVersion: aggregate.aggregateVersion,
      },
      actorReference,
    );
    assert.equal(managementReply.status, 200);
    assert.equal(managementReply.cacheControl, "no-store");
    const management = parseCatalogProductPublicationManagementV2(managementReply.body);
    assert.equal(management.eligibility, "NotEvaluated");
    assert.deepEqual(
      [
        management.tenantReference,
        management.brandReference,
        management.storeReference,
        management.productReference,
        management.aggregateVersion,
      ],
      [tenant, brand, storeReference, product, aggregate.aggregateVersion],
    );
    assert.equal(management.draft.versionReference, aggregate.draft.versionReference);
    if (current !== null)
      assert.deepEqual(
        management.versions.find(
          (version) => version.versionReference === current.versionReference,
        ),
        current,
      );
    const reportReply = await productPost(
      "/publication/validation-report/v2",
      {
        productReference: product,
        versionReference: current?.versionReference ?? aggregate.draft.versionReference,
        expectedAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: current?.publicationVersion ?? 0,
      },
      actorReference,
    );
    assert.equal(reportReply.status, 200);
    assert.equal(reportReply.cacheControl, "no-store");
    assert.deepEqual(await counts(product), before);
    return parseCatalogProductPublicationValidationReportView(reportReply.body);
  }
  const committedRequests = [],
    expectedReasons = [
      "REQUIRED_PRICING_REFERENCE_MISSING",
      "REQUIRED_RECIPE_REFERENCE_MISSING",
      "REQUIRED_INVENTORY_REFERENCE_MISSING",
      "REQUIRED_MENU_REFERENCE_MISSING",
    ].sort();
  await exerciseProductPublicationActions({
    admin,
    tenant,
    brand,
    product,
    author: actor,
    reviewer,
    aggregate,
    current,
    command,
    send,
    view,
    counts,
    acknowledgement,
    expectedReasons,
    committedRequests,
    onStage: setStage,
    onCurrent(nextAggregate, nextPublication) {
      aggregate = nextAggregate;
      current = nextPublication;
    },
  });
  assert.equal(current.state, "Published");
  assert.notEqual(aggregate.draft.versionReference, originalDraftVersion);
  const freshProduct = await readProduct(product, aggregate.aggregateVersion);
  assert.deepEqual(freshProduct, aggregate);
  assert.equal(
    freshProduct.draft.optionBindings[0].optionSetVersionReference,
    firstOption.command.versionReference,
  );
  const originalReport = (await view()).report;
  const originalOptionSource = originalReport.details.sources.find(
    (source) => source.sourceCode === "CURRENT_PUBLISHED_OPTION_RULES",
  );
  assert(
    originalOptionSource,
    "Complete actual report must identify the acquired CurrentPublished source",
  );
  assert(
    !originalReport.details.sources.some((source) => source.sourceCode === "PINNED_OPTION_RULES"),
  );
  const publishedCounts = await counts(product);
  assert.equal(publishedCounts.reports, 4);
  assert.equal(publishedCounts.approvals, 1);
  assert.equal(publishedCounts.acknowledgements, 2);
  setStage("OriginalRetry");
  for (const original of committedRequests) {
    const reply = await send(original.command);
    assert.equal(reply.status, 200, "Actual original receipt retry after successor Draft");
    assert.deepEqual(reply.body, { ...original.reply, status: "Replayed" });
  }
  assert.deepEqual(await counts(product), publishedCounts);

  // Advance the Option head through a second real Draft/Review/independent
  // approval/Publish. A Product's exact selected old version must not upgrade.
  setStage("OptionHeadAdvanceDraft");
  const optionEdited = await post("draft", {
    optionSetReference: set,
    expectedAggregateVersion: firstOption.command.expectedAggregateVersion + 1,
    operationReference: reference(),
    archiveOptionReferences: [],
    draft: {
      ...create.draft,
      localizedNames: { "en-CA": "Synthetic new actual Published choices" },
      options: create.draft.options.map((option, index) => ({
        ...option,
        lifecycle: "Active",
        identity: {
          kind: "Existing",
          optionReference:
            created.body.content.sourceAggregate.draft.options[index].optionReference,
        },
      })),
    },
    additionalContent: create.additionalContent,
  });
  assert.equal(optionEdited.status, 200);
  const secondOption = await publishOption();
  assert.notEqual(secondOption.command.versionReference, firstOption.command.versionReference);
  assert.notEqual(
    secondOption.view.release.publicationReference,
    firstOption.view.release.publicationReference,
  );
  setStage("ProductCurrentHeadDrift");
  const beforeStale = await counts(product),
    freshStaleCommand = command(aggregate, null, "Validate", actor);
  const stale = await send(freshStaleCommand);
  assert.equal(
    stale.status,
    409,
    "Fresh validation must reject a changed actual CurrentPublished head",
  );
  assert.deepEqual(await counts(product), beforeStale);
  assert.deepEqual(await readProduct(product, aggregate.aggregateVersion), aggregate);
  for (const original of committedRequests) {
    const reply = await send(original.command);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { ...original.reply, status: "Replayed" });
  }
  assert.deepEqual(await counts(product), beforeStale);

  // Explicit human replacement chooses the actual new head. Historical Ack
  // receipts remain immutable, but cannot consent to this new release provenance.
  setStage("ExplicitCurrentHeadReplacement");
  const replacementPicker = await productPost("/option-binding-picker", {
    optionSetReference: set,
    versionReference: null,
  });
  assert.equal(replacementPicker.status, 200);
  assert.equal(replacementPicker.body.versionReference, secondOption.command.versionReference);
  assert.equal(
    replacementPicker.body.publicationReference,
    secondOption.view.release.publicationReference,
  );
  const replacement = await productPost("/draft", {
    productReference: product,
    expectedAggregateVersion: aggregate.aggregateVersion,
    operationReference: reference(),
    draft: {
      ...aggregate.draft,
      optionBindings: aggregate.draft.optionBindings.map((binding) => ({
        ...binding,
        optionSetVersionReference: replacementPicker.body.versionReference,
        enabledOptionReferences: replacementPicker.body.options
          .filter((option) => !option.selectionDisabled)
          .map((option) => option.optionReference),
      })),
    },
  });
  assert.equal(replacement.status, 200);
  aggregate = await readProduct(product, replacement.body.aggregateVersion);
  current = null;
  setStage("ReplacementValidate");
  const replacementCommand = command(aggregate, current, "Validate", actor);
  const replacementValidated = await send(replacementCommand);
  assert.equal(replacementValidated.status, 200);
  aggregate = await readProduct(product, replacementValidated.body.aggregateVersion);
  const storedReplacement = await admin.query(
    "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE brand_id=$1 AND product_id=$2 AND operation_id=$3",
    [brand, product, replacementCommand.operationReference],
  );
  assert.equal(storedReplacement.rows.length, 1);
  current = parseProductPublicationVersionV2(storedReplacement.rows[0].snapshot_json);
  const replacementReport = (await view()).report;
  const replacementOptionSource = replacementReport.details.sources.find(
    (source) => source.sourceCode === "CURRENT_PUBLISHED_OPTION_RULES",
  );
  assert(replacementOptionSource);
  assert.notEqual(
    replacementOptionSource.relevantReferenceDigest,
    originalOptionSource.relevantReferenceDigest,
  );
  assert.notEqual(replacementReport.warningBindingDigest, originalReport.warningBindingDigest);
  assert.equal(replacementReport.validation.warningAcknowledgement, null);
  setStage("WarningContinuity");
  const beforeNewConsent = await counts(product);
  const oldAuthorAck = committedRequests.find(
    (original) =>
      original.command.action === "AcknowledgeProductPublicationWarnings" &&
      original.command.actorReference === actor,
  );
  assert(oldAuthorAck);
  const oldAckReplay = await send(oldAuthorAck.command);
  assert.equal(oldAckReplay.status, 200);
  assert.deepEqual(oldAckReplay.body, { ...oldAuthorAck.reply, status: "Replayed" });
  assert.equal(
    (await send(command(aggregate, current, "SubmitReview", actor))).status,
    409,
    "Original consent cannot acknowledge a new actual Option release",
  );
  assert.deepEqual(await counts(product), beforeNewConsent);

  // The same historical Frozen is still a legitimate explicit Pinned source.
  // A separate Product avoids old Published scope/CAS masking the mode check.
  const pinned = await createBoundProduct(
    "SYNTHETIC_PINNED_PUBLICATION",
    firstOption.command.versionReference,
    "Pinned",
  );
  assert.equal(pinned.picked.versionReference, firstOption.command.versionReference);
  assert.equal(pinned.picked.publicationReference, null);
  setStage("PinnedValidate");
  const pinnedCommand = command(pinned.aggregate, null, "Validate", actor),
    pinnedReply = await send(pinnedCommand);
  assert.equal(
    pinnedReply.status,
    200,
    "Explicit original Frozen Pinned validation remains supported",
  );
  const pinnedReportReply = await productPost("/publication/validation-report/v2", {
    productReference: pinned.aggregate.productReference,
    versionReference: pinned.aggregate.draft.versionReference,
    expectedAggregateVersion: pinned.aggregate.aggregateVersion + 1,
    expectedPublicationVersion: 1,
  });
  assert.equal(pinnedReportReply.status, 200);
  const pinnedReport = parseCatalogProductPublicationValidationReportView(pinnedReportReply.body);
  assert.equal(pinnedReport.status, "Recorded");
  assert.equal(pinnedReport.report.details.coverage, "Complete");
  assert.equal(
    pinnedReport.report.validation.checks.find((check) => check.code === "OptionSelection").outcome,
    "Pass",
  );
  assert(
    pinnedReport.report.details.sources.some(
      (source) => source.sourceCode === "PINNED_OPTION_RULES",
    ),
  );
  assert(
    !pinnedReport.report.details.sources.some(
      (source) => source.sourceCode === "CURRENT_PUBLISHED_OPTION_RULES",
    ),
  );
}
