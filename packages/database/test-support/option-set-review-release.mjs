import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPostgresPublishingMutationStore,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import {
  createPostgresFullOptionSetDraftStore,
  createPostgresCurrentFullOptionSetDraftStore,
  createPostgresFullOptionSetContentSealStore,
  createCatalogFullOptionSetContentSealIntent,
} from "../../rms/catalog/src/infrastructure/persistence/option-set-full-draft-store.ts";
import { createCatalogOptionSetContentReviewBinding } from "../../rms/catalog/src/contracts/option-set-review-binding.ts";
import {
  createCatalogOptionSetReviewRecord,
  createCatalogOptionSetReleaseRecord,
} from "../../rms/catalog/src/contracts/option-set-review-record.ts";
import { createPostgresOptionSetReviewContentStore } from "../../rms/catalog/src/infrastructure/persistence/option-set-review-content-store.ts";
import { tenantBrandConfigurationContentDigest } from "../../bop/tenant/src/index.ts";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
} from "../../bop/permission/src/index.ts";
import { createCurrentOptionSetPublicationValidationSource } from "../../../apps/api/dist/current-option-set-publication-validation.js";
import { CatalogError } from "../../rms/catalog/src/contracts/product.ts";
import { createCurrentPublishedOptionSetGraphSource } from "../../../apps/api/dist/current-published-option-set-graph.js";
import { createCurrentOptionSetPublicationDraftGraphSource } from "../../../apps/api/dist/current-option-set-publication-draft-graph.js";
const id = (n) => "01902421-7000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
/** Controlled Actor/permission, validation and independent approval inputs.
 * Actual owner SQL, Publishing immutable consumed evidence/current public reads,
 * deferred constraints, Audit/Outbox, RLS and outer rollback execute here.
 * This is not persisted IAM or live reference/publication eligibility evidence. */
export async function exerciseOptionSetReviewRelease(context, { nearLimit = false } = {}) {
  const admin = new pg.Client(context.clientConfig);
  await admin.connect();
  const role = "wp2421_opt_review_" + context.runId;
  assert.match(role, /^wp2421_opt_review_[a-f0-9]+$/u);
  const tenant = id(1),
    brand = id(2),
    actor = id(3),
    reviewer = id(4),
    at = new Date(Date.now() - 1000).toISOString(),
    scope = { kind: "Brand", brandReference: brand, storeReference: null },
    guards = new WeakMap();
  let syntheticClock = at,
    sequence = 100,
    allowed = true,
    afterWork = null,
    createdRole = false,
    phase = "Setup",
    committedTransactions = 0;
  const reference = () => id(++sequence),
    now = () => syntheticClock,
    lease = (observedAt) => ({
      observedAt,
      validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
    });
  const audit = (
    operationReference,
    actionCode,
    targetType,
    targetId,
    occurredAt = at,
    who = actor,
  ) => ({
    auditId: reference(),
    brandId: brand,
    actor: { type: "User", reference: who },
    actionCode,
    targetType,
    targetId,
    reasonCode: "SYNTHETIC_OPTION_NATIVE",
    correlationId: operationReference,
    occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  });
  const transactions = {
    async run(work) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      let tx,
        sqlState = null,
        failedPhase = null;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        tx = {
          async query(sql, values = []) {
            try {
              return await client.query(sql, [...values]);
            } catch (error) {
              // Keep only bounded PostgreSQL status and fixture phase. Never
              // expose SQL, parameters or the unrestricted database message.
              if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)) {
                sqlState = error.code;
                failedPhase = phase;
              }
              throw error;
            }
          },
        };
        const checks = [];
        guards.set(tx, checks);
        const result = await work(tx);
        if (afterWork) {
          const hook = afterWork;
          afterWork = null;
          await hook();
        }
        for (const entry of checks) await entry.guard();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const entry of checks) entry.finalAssert();
        await client.query("COMMIT");
        committedTransactions++;
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        if (sqlState !== null && !/^[0-9A-Z]{5}$/u.test(error?.code ?? "")) {
          throw new Error(
            "OPTION_NATIVE_SQL_FAILURE phase=" + failedPhase + " sqlstate=" + sqlState,
            { cause: error },
          );
        }
        throw error;
      } finally {
        if (tx) guards.delete(tx);
        await client.end();
      }
    },
  };
  const register = async (tx, guard, finalAssert) => {
    const entries = guards.get(tx);
    assert(entries);
    entries.push({ guard, finalAssert });
  };
  const permit = async (_tx, input) => {
    assert.equal(input.tenantReference, tenant);
    assert.equal(input.brandReference, brand);
    assert.equal(input.actorReference, actor);
    assert.equal(input.actorKind, "User");
    assert.equal(input.permission, "catalog.manage");
    assert(input.requiredFields.length > 0);
    if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return lease(input.observedAt);
  };
  const borrowed = (tx) => ({ run: (work) => work(tx) }),
    publisher = (tx) => createPostgresPublishingMutationStore(borrowed(tx), tenant, scope);
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_catalog.option_set_review_content WHERE brand_id=$1) reviews,(SELECT count(*)::int FROM rms_catalog.option_set_publication_release WHERE brand_id=$1) releases,(SELECT count(*)::int FROM rms_catalog.option_set_publication_content WHERE brand_id=$1) seals,(SELECT count(*)::int FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1) mutations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE brand_id=$1) outbox",
        [brand],
      )
    ).rows[0];
  async function publishingStep(tx, operation, current, next, extra = {}) {
    const operationReference = reference();
    phase =
      (next.configurationType === "OPTION_SET_PUBLICATION_POLICY" ? "Policy" : "Option") +
      operation;
    await publisher(tx).commit({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: operationReference,
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        ...audit(
          operationReference,
          {
            CreateDraft: "PUBLISHING_DRAFT_CREATED",
            SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
            Approve: "PUBLISHING_REVIEW_APPROVED",
            Publish: "PUBLISHING_RELEASE_PUBLISHED",
          }[operation],
          "PublishingLifecycle",
          next.lifecycleId,
          next.changedAt,
          operation === "Approve" ? reviewer : actor,
        ),
        dataClassification: "Confidential",
      },
      ...extra,
    });
    return operationReference;
  }
  function lifecycle(family, snapshot, digest, configurationType, purposeCode) {
    return {
      lifecycleId: reference(),
      familyReference: family,
      configurationType,
      purposeCode,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
  }
  function validation(draft) {
    return {
      evidenceReference: reference(),
      snapshotReference: draft.snapshotReference,
      snapshotDigest: draft.snapshotDigest,
      scope,
      result: "Pass",
      checkedAt: at,
      validUntil: new Date(Date.parse(at) + 60000).toISOString(),
      checkCodes: ["SYNTHETIC_CONTROLLED_VALIDATION"],
    };
  }
  async function submit(tx, draft) {
    const evidence = validation(draft),
      review = {
        ...draft,
        version: 2,
        state: "InReview",
        validationEvidenceReference: evidence.evidenceReference,
      };
    await publishingStep(tx, "CreateDraft", null, draft);
    await publishingStep(tx, "SubmitReview", draft, review, { validationEvidence: evidence });
    return { review, evidence };
  }
  async function approvePublish(tx, review, evidence, occurredAt = at) {
    const approval = {
        evidenceReference: reference(),
        reviewLifecycleId: review.lifecycleId,
        reviewVersion: review.version,
        snapshotReference: review.snapshotReference,
        snapshotDigest: review.snapshotDigest,
        scope,
        decision: "Accepted",
        approvedActorReference: reviewer,
        approvedAt: occurredAt,
        validUntil: evidence.validUntil,
      },
      approved = {
        ...review,
        version: 3,
        state: "Approved",
        changedAt: occurredAt,
        approvalEvidenceReference: approval.evidenceReference,
      };
    await publishingStep(tx, "Approve", review, approved, { approvalEvidence: approval });
    const release = {
        releaseId: reference(),
        familyReference: review.familyReference,
        configurationType: review.configurationType,
        purposeCode: review.purposeCode,
        snapshotReference: review.snapshotReference,
        snapshotDigest: review.snapshotDigest,
        scope,
        sequence: 1,
        sourceLifecycleId: review.lifecycleId,
        kind: "Publish",
        previousReleaseId: null,
        createdAt: occurredAt,
      },
      published = { ...approved, version: 4, state: "Published" };
    const operation = await publishingStep(tx, "Publish", approved, published, {
      release,
      validationEvidence: evidence,
      approvalEvidence: approval,
    });
    const packet = await publisher(tx).resolveCurrentReleaseForReference({
      publicationReference: release.releaseId,
      configurationType: release.configurationType,
      purposeCode: release.purposeCode,
      observedAt: now(),
    });
    assert.deepEqual(packet.recorded.release, release);
    return { packet, operation };
  }
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_catalog,bop_publishing,platform_audit,platform_eventing,platform_helpers TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.option_set_authoring_identity TO " + role,
    );
    await admin.query("GRANT SELECT ON rms_catalog.option_set_authoring_abandonment TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION rms_catalog.option_set_authoring_operation_available(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,rms_catalog.option_set_publication_content,rms_catalog.option_set_review_content,rms_catalog.option_set_publication_release,platform_audit.audit_record,platform_eventing.outbox_event,bop_publishing.publishing_mutation_record TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,bop_publishing.publishing_mutation_record TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_catalog.option_set_review_content,rms_catalog.option_set_publication_release TO " +
        role,
    );
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
      effectiveFrom: at,
      effectiveUntil: null,
    };
    const policyPacket = await transactions.run(async (tx) => {
      const draft = lifecycle(
          policy.familyReference,
          policy.policyReference,
          publishingOptionSetPublicationPolicyDigest(policy),
          "OPTION_SET_PUBLICATION_POLICY",
          "OPTION_SET_PUBLICATION_POLICY",
        ),
        evidence = validation(draft),
        review = {
          ...draft,
          version: 2,
          state: "InReview",
          validationEvidenceReference: evidence.evidenceReference,
        };
      await publishingStep(tx, "CreateDraft", null, draft, { optionSetPolicyContent: policy });
      await publishingStep(tx, "SubmitReview", draft, review, { validationEvidence: evidence });
      return (await approvePublish(tx, review, evidence)).packet;
    });
    const createOperation = reference(),
      command = {
        internalCode: "SYNTHETIC_NATIVE_OPTIONS",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic choices" },
          localizedDescriptions: {},
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
            effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
        operationReference: createOperation,
        occurredAt: at,
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
      };
    if (nearLimit) {
      const locales = ["en-CA", "fr-CA", "en-US", "fr-FR", "es-ES", "de-DE", "it-IT"];
      command.draft.options = Array.from({ length: 100 }, (_, index) => ({
        ...command.draft.options[0],
        stableCode: "CHOICE_" + index,
        sortOrder: index,
        localizedDescriptions: Object.fromEntries(
          locales.map((locale) => [locale, "界".repeat(440)]),
        ),
      }));
      command.additionalContent.optionDetails = command.draft.options.map((option) => ({
        ...command.additionalContent.optionDetails[0],
        stableCode: option.stableCode,
      }));
    }
    phase = "CatalogCreate";
    const draftResult = await transactions.run((tx) =>
      createPostgresFullOptionSetDraftStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions: borrowed(tx),
        authority: { holdUntilTransactionCompletes: permit },
        creation: {
          authority: { holdUntilTransactionCompletes: permit },
          references: { generate: reference },
        },
        audit: {
          create: (input) =>
            audit(
              input.operationReference,
              "CATALOG_OPTION_SET_CREATE",
              "CatalogOptionSet",
              input.result.sourceAggregate.optionSetReference,
              input.occurredAt,
            ),
        },
        events: { generateReference: reference },
      }).create(command),
    );
    const source = draftResult.content.sourceAggregate,
      set = source.optionSetReference,
      version = source.draft.versionReference;
    phase = "CatalogCurrentRead";
    const current = await transactions.run((tx) =>
      createPostgresCurrentFullOptionSetDraftStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions: borrowed(tx),
        authority: { holdUntilTransactionCompletes: permit },
      }).readCurrentForReview({ optionSetReference: set, expectedAggregateVersion: 1 }),
    );
    assert.deepEqual(current.content, draftResult.content);
    assert.equal(current.sourceOperationReference, createOperation);
    assert.deepEqual(current.sourceSnapshotTuple, {
      tenantReference: tenant,
      brandReference: brand,
      optionSetReference: set,
      versionReference: version,
      aggregateVersion: 1,
      sourceDigest: current.sourceDigest,
      contentDigest: current.contentDigest,
      configurationDigest: current.configurationDigest,
    });
    if (nearLimit) {
      const original = (
        await admin.query(
          "SELECT octet_length(snapshot_json::text)::int bytes FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=$1",
          [createOperation],
        )
      ).rows[0];
      assert(original.bytes > 950_000 && original.bytes <= 1_048_576);
    }
    const binding = createCatalogOptionSetContentReviewBinding({
      tenantReference: tenant,
      brandReference: brand,
      optionSetReference: set,
      versionReference: version,
      expectedAggregateVersion: 1,
      sourceDigest: current.sourceDigest,
      contentDigest: current.contentDigest,
      configurationDigest: current.configurationDigest,
      graphDigest: hash({ root: set, content: current.content }),
      policyReference: policy.policyReference,
      policyVersion: 1,
      policyContentDigest: publishingOptionSetPublicationPolicyDigest(policy),
      currentPolicyPublicationReference: policyPacket.recorded.release.releaseId,
      originalIntentDigest: hash(command),
      activationAt: at,
    });
    let reviewRecord, releaseRecord, reviewed;
    const recordAudit = (record) => ({
      ...audit(
        record.operationReference,
        record.profile === "CatalogOptionSetReviewRecordV1"
          ? "CATALOG_OPTION_SET_REVIEW_RECORDED"
          : "CATALOG_OPTION_SET_RELEASE_RECORDED",
        "CatalogOptionSet",
        set,
        record.recordedAt,
      ),
      auditId: record.auditReference,
    });
    const owner = () =>
      createPostgresOptionSetReviewContentStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        currentDraftAuthority: { holdUntilTransactionCompletes: permit },
        registerBeforeCommit: register,
        events: { generateReference: reference },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            const result = await permit(tx, input);
            if (input.phase === "Apply" && input.record) {
              if (input.record.profile === "CatalogOptionSetReviewRecordV1") {
                const actual = await publisher(tx).resolveCurrentLifecycleMutation({
                  familyReference: set,
                  lifecycleReference: input.record.lifecycleReference,
                  configurationType: "CATALOG_OPTION_SET",
                  purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                  observedAt: now(),
                });
                assert.equal(actual.next.snapshotDigest, binding.digest);
              } else {
                const actual = await publisher(tx).resolveCurrentReleaseForReference({
                  publicationReference: input.record.release.releaseId,
                  configurationType: "CATALOG_OPTION_SET",
                  purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                  observedAt: now(),
                });
                assert.deepEqual(actual.recorded.release, input.record.release);
              }
            }
            return result;
          },
        },
      });
    await transactions.run(async (tx) => {
      const reviewOwner = owner();
      assert.equal(
        await reviewOwner.readCurrentReviewForDraft(tx, {
          optionSetReference: set,
          expectedAggregateVersion: 1,
        }),
        null,
      );
      const draft = lifecycle(
        set,
        version,
        binding.digest,
        "CATALOG_OPTION_SET",
        "CATALOG_OPTION_SET_PUBLICATION",
      );
      reviewed = await submit(tx, draft);
      reviewRecord = createCatalogOptionSetReviewRecord({
        operationReference: reference(),
        sourceOperationReference: current.sourceOperationReference,
        lifecycleReference: draft.lifecycleId,
        actorReference: actor,
        auditReference: reference(),
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
        recordedAt: at,
        binding,
        content: current.content,
      });
      phase = "CatalogSaveReview";
      assert.equal(
        (await reviewOwner.saveReview(tx, reviewRecord, recordAudit(reviewRecord))).status,
        "Recorded",
      );
    });
    phase = "CurrentDraftReviewDiscovery";
    const beforeDiscovery = await counts();
    await transactions.run(async (tx) => {
      assert.deepEqual(
        await owner().readCurrentReviewForDraft(tx, {
          optionSetReference: set,
          expectedAggregateVersion: 1,
        }),
        reviewRecord,
      );
    });
    assert.deepEqual(await counts(), beforeDiscovery);
    // Monotonic synthetic observations have an actual current-time origin.
    // Distinct immutable Review, Seal and Publishing release times exercise the
    // real SQL contract instead of a shared-clock equality fixture.
    const sealAt = new Date(Date.parse(at) + 1).toISOString(),
      publishingAt = new Date(Date.parse(at) + 2).toISOString(),
      sealOperation = reference(),
      sealCommand = {
        optionSetReference: set,
        versionReference: version,
        expectedAggregateVersion: 1,
        sourceDigest: current.sourceDigest,
        contentDigest: current.contentDigest,
        configurationDigest: current.configurationDigest,
        operationReference: sealOperation,
        occurredAt: sealAt,
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
      };
    const publish = async (tx) => {
      syntheticClock = syntheticClock < sealAt ? sealAt : syntheticClock;
      const sealed = await createPostgresFullOptionSetContentSealStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions: borrowed(tx),
        authority: { holdUntilTransactionCompletes: permit },
        readAuthority: { holdUntilTransactionCompletes: permit },
        references: { generateSuccessorVersion: reference },
        audit: {
          create: (input) =>
            audit(
              input.operationReference,
              "CATALOG_OPTION_SET_CONTENT_SEALED",
              "CatalogOptionSet",
              set,
              input.occurredAt,
            ),
        },
        events: { generateReference: reference },
      }).seal(sealCommand);
      syntheticClock = publishingAt;
      const actual = await approvePublish(tx, reviewed.review, reviewed.evidence, publishingAt);
      releaseRecord = createCatalogOptionSetReleaseRecord({
        tenantReference: tenant,
        brandReference: brand,
        optionSetReference: set,
        versionReference: version,
        operationReference: reference(),
        reviewOperationReference: reviewRecord.operationReference,
        reviewRecordDigest: reviewRecord.digest,
        reviewBindingDigest: binding.digest,
        sealOperationReference: sealOperation,
        sealRecordDigest: sealed.content.digest,
        publishingOperationReference: actual.operation,
        actorReference: actor,
        auditReference: reference(),
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
        recordedAt: actual.packet.recorded.release.createdAt,
        release: actual.packet.recorded.release,
      });
      phase = "CatalogSaveRelease";
      return owner().saveRelease(tx, releaseRecord, recordAudit(releaseRecord));
    };
    const beforePublish = await counts();
    afterWork = () => {
      allowed = false;
    };
    await assert.rejects(
      transactions.run(publish),
      (error) => error.code === "CATALOG_PERMISSION_DENIED",
    );
    allowed = true;
    assert.deepEqual(await counts(), beforePublish);
    assert.equal((await transactions.run(publish)).status, "Recorded");
    const persistedChronology = (
      await admin.query(
        "SELECT to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') review_at,to_char(s.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') seal_at,to_char(p.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') release_at FROM rms_catalog.option_set_publication_release p JOIN rms_catalog.option_set_review_content r ON r.operation_id=p.review_operation_id JOIN rms_catalog.option_set_publication_content s ON s.operation_id=p.seal_operation_id WHERE p.operation_id=$1",
        [releaseRecord.operationReference],
      )
    ).rows;
    assert.deepEqual(persistedChronology, [
      { review_at: reviewRecord.recordedAt, seal_at: sealAt, release_at: releaseRecord.recordedAt },
    ]);
    assert(reviewRecord.recordedAt < sealAt);
    assert(sealAt < releaseRecord.recordedAt);
    assert.equal(releaseRecord.recordedAt, publishingAt);
    assert.equal(releaseRecord.recordedAt, releaseRecord.release.createdAt);
    if (nearLimit) {
      const frozen = (
        await admin.query(
          "SELECT octet_length(snapshot_json::text)::int bytes,snapshot_json FROM rms_catalog.option_set_publication_content WHERE operation_id=$1",
          [sealOperation],
        )
      ).rows[0];
      assert(frozen.bytes > 1_048_576 && frozen.bytes <= 3_145_728);
      assert.equal(frozen.snapshot_json.eligibility, "NotEvaluated");
      assert.deepEqual(frozen.snapshot_json.editorContent, current.content);
      assert.deepEqual(
        frozen.snapshot_json.supportedContent.sourceAggregate,
        current.content.sourceAggregate,
      );
      assert.equal(frozen.snapshot_json.digest, releaseRecord.sealRecordDigest);
    }
    const after = await counts();
    assert.equal(after.reviews, 1);
    assert.equal(after.releases, 1);
    assert.equal(after.seals, 1);
    assert.equal(after.mutations, beforePublish.mutations + 2);
    assert.equal(after.audit, beforePublish.audit + 4);
    assert.equal(after.outbox, beforePublish.outbox + 2);
    const sealedRows = (
      await admin.query(
        "SELECT aggregate_version FROM rms_catalog.option_set WHERE brand_id=$1 AND option_set_id=$2",
        [brand, set],
      )
    ).rows;
    assert.equal(sealedRows[0].aggregate_version, 2);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM rms_catalog.option_set_version WHERE brand_id=$1 AND option_set_id=$2 AND status='Frozen'",
          [brand, set],
        )
      ).rows[0].n,
      1,
    );
    await transactions.run(async (tx) => {
      const store = owner();
      assert.equal(
        (await store.saveRelease(tx, releaseRecord, recordAudit(releaseRecord))).status,
        "Replayed",
      );
      assert.deepEqual(
        await store.readReview(tx, reviewRecord.operationReference, set),
        reviewRecord,
      );
      assert.deepEqual(
        await store.readRelease(tx, releaseRecord.operationReference, set),
        releaseRecord,
      );
      assert.deepEqual(
        await store.readReleaseForPublication(tx, releaseRecord.release.releaseId, set),
        releaseRecord,
      );
    });
    assert.deepEqual(await counts(), after);
    await assert.rejects(
      transactions.run((tx) =>
        owner().saveRelease(
          tx,
          { ...releaseRecord, digest: hash("tampered") },
          recordAudit(releaseRecord),
        ),
      ),
    );
    assert.deepEqual(await counts(), after);
    // Raw attacks deliberately bypass application currentness admission. Every
    // row is still created by the owning closed parser with a correct digest and
    // exact column/JSON mirrors. These are refusals, not successful approvals.
    const { profile: releaseProfile, digest: releaseDigest, ...releasePreimage } = releaseRecord,
      { profile: reviewProfile, digest: reviewDigest, ...reviewPreimage } = reviewRecord;
    void releaseProfile;
    void releaseDigest;
    void reviewProfile;
    void reviewDigest;
    for (const boundary of ["ReleaseBeforeSeal", "SealBeforeReview"]) {
      phase = boundary;
      let refusal = null;
      try {
        await transactions.run(async (tx) => {
          let attackedReview = reviewRecord;
          if (boundary === "SealBeforeReview") {
            attackedReview = createCatalogOptionSetReviewRecord({
              ...reviewPreimage,
              operationReference: reference(),
              // Raw attack identity avoids the unrelated lifecycle unique key;
              // this does not assert a successful Publishing lifecycle fact.
              lifecycleReference: reference(),
              auditReference: reference(),
              recordedAt: publishingAt,
            });
            assert(sealAt < attackedReview.recordedAt);
            await tx.query(
              "INSERT INTO rms_catalog.option_set_review_content(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,source_operation_id,lifecycle_id,binding_digest,record_digest,recorded_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
              [
                attackedReview.operationReference,
                tenant,
                brand,
                set,
                version,
                attackedReview.sourceOperationReference,
                attackedReview.lifecycleReference,
                attackedReview.binding.digest,
                attackedReview.digest,
                attackedReview.recordedAt,
                canonicalizeRfc8785(attackedReview),
              ],
            );
          }
          const recordedAt =
              boundary === "ReleaseBeforeSeal"
                ? new Date(Date.parse(sealAt) - 1).toISOString()
                : publishingAt,
            attackedRelease = createCatalogOptionSetReleaseRecord({
              ...releasePreimage,
              operationReference: reference(),
              auditReference: reference(),
              reviewOperationReference: attackedReview.operationReference,
              reviewRecordDigest: attackedReview.digest,
              recordedAt,
              release: {
                ...releaseRecord.release,
                releaseId: reference(),
                sourceLifecycleId: attackedReview.lifecycleReference,
                createdAt: recordedAt,
              },
            });
          assert(attackedReview.recordedAt <= recordedAt);
          if (boundary === "ReleaseBeforeSeal") assert(recordedAt < sealAt);
          await tx.query(
            "INSERT INTO rms_catalog.option_set_publication_release(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,review_operation_id,seal_operation_id,release_id,binding_digest,seal_record_digest,record_digest,recorded_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
            [
              attackedRelease.operationReference,
              tenant,
              brand,
              set,
              version,
              attackedRelease.reviewOperationReference,
              attackedRelease.sealOperationReference,
              attackedRelease.release.releaseId,
              attackedRelease.reviewBindingDigest,
              attackedRelease.sealRecordDigest,
              attackedRelease.digest,
              recordedAt,
              canonicalizeRfc8785(attackedRelease),
            ],
          );
          // Ordinary outer runner executes real SET CONSTRAINTS ALL IMMEDIATE.
        });
      } catch (error) {
        refusal = {
          sqlState:
            typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
              ? error.code
              : null,
          invariant:
            error?.message === "OPTION_SET_RELEASE_SOURCE_INCOHERENT"
              ? "ReleaseSourceIncoherent"
              : "Other",
        };
      }
      assert.deepEqual(refusal, { sqlState: "23514", invariant: "ReleaseSourceIncoherent" });
      assert.deepEqual(await counts(), after);
    }
    // Source joins execute actual owning SQL; current Actor/Permission/Feature
    // ports remain the explicitly controlled admission fixtures above.
    const graphOptions = (tx) => ({
      transaction: tx,
      tenantReference: tenant,
      brandReference: brand,
      storeReference: id(6),
      actorReference: actor,
      sessionReference: id(7),
      clock: { now },
      originalValidUntil: lease(at).validUntil,
      currentAuthorization: {
        async authorizeActions(actions) {
          assert.deepEqual(actions, ["catalog.manage", "catalog.option_set.read"]);
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
        assertCurrent() {
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          return at;
        },
        leaseDeadline: () => lease(at).validUntil,
      },
      capability: {
        async holdUntilCommit() {
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
        leaseDeadline: () => lease(at).validUntil,
      },
      registerBeforeCommit: register,
      events: { generateReference: reference },
    });
    const currentGraph = (tx) => createCurrentPublishedOptionSetGraphSource(graphOptions(tx));
    phase = "CurrentPublishedGraph";
    await transactions.run((tx) =>
      currentGraph(tx).withCurrentGraph(
        {
          optionSetReference: set,
          versionReference: version,
        },
        async (observed) => {
          assert.equal(observed.sourceAuthority, "CurrentPublishingReleaseAndFrozenContent");
          assert.equal(observed.referenceEligibility, "NotEvaluated");
          assert.equal(observed.publishValidation, "Incomplete");
          assert.equal(observed.graph.rootOptionSetReference, set);
          assert.equal(observed.graph.rootVersionReference, version);
          assert.deepEqual(observed.graph.contents, [current.content]);
          assert.deepEqual(observed.sourceRecords, [
            {
              optionSetReference: set,
              versionReference: version,
              publicationReference: releaseRecord.release.releaseId,
              releaseRecordDigest: releaseRecord.digest,
              sealRecordDigest: releaseRecord.sealRecordDigest,
              approvalDisposition: "Approved",
            },
          ]);
        },
      ),
    );
    assert.deepEqual(await counts(), after);
    phase = "CurrentPublishedGraphLatePermission";
    await assert.rejects(
      transactions.run((tx) =>
        currentGraph(tx).withCurrentGraph(
          {
            optionSetReference: set,
            versionReference: null,
          },
          async () => {
            allowed = false;
          },
        ),
      ),
      { code: "CATALOG_PERMISSION_DENIED" },
    );
    allowed = true;
    assert.deepEqual(await counts(), after);
    // Direct persisted-source mismatch must fail the deferred owner constraint,
    // independently of the public parser's digest refusal above.
    await assert.rejects(
      transactions.run(async (tx) => {
        const operation = reference(),
          lifecycleReference = reference(),
          snapshot = globalThis.structuredClone(reviewRecord);
        snapshot.operationReference = operation;
        snapshot.lifecycleReference = lifecycleReference;
        snapshot.content.sourceAggregate.internalCode = "SYNTHETIC_TAMPERED_SOURCE";
        await tx.query(
          "INSERT INTO rms_catalog.option_set_review_content(operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,source_operation_id,lifecycle_id,binding_digest,record_digest,recorded_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
          [
            operation,
            tenant,
            brand,
            set,
            version,
            createOperation,
            lifecycleReference,
            binding.digest,
            snapshot.digest,
            at,
            canonicalizeRfc8785(snapshot),
          ],
        );
      }),
      (error) => error.code === "23514",
    );
    assert.deepEqual(await counts(), after);

    for (const table of ["option_set_review_content", "option_set_publication_release"]) {
      for (const sql of [
        "UPDATE rms_catalog." + table + " SET recorded_at=recorded_at",
        "DELETE FROM rms_catalog." + table,
      ])
        await assert.rejects(
          transactions.run(async (tx) => {
            assert.equal(
              (await tx.query("SELECT count(*)::int n FROM rms_catalog." + table)).rows[0].n,
              1,
            );
            return tx.query(sql);
          }),
          (error) => error.code === "55000",
        );
    }
    // PostgreSQL checks incoming FKs before statement triggers for an isolated
    // parent TRUNCATE. Include both tables to exercise the actual no-truncate
    // triggers, and prove CASCADE cannot bypass their immutable history guard.
    await assert.rejects(
      transactions.run((tx) => tx.query("TRUNCATE rms_catalog.option_set_review_content")),
      (error) => error.code === "0A000",
    );
    for (const sql of [
      "TRUNCATE rms_catalog.option_set_publication_release",
      "TRUNCATE rms_catalog.option_set_review_content,rms_catalog.option_set_publication_release",
      "TRUNCATE rms_catalog.option_set_review_content CASCADE",
    ])
      await assert.rejects(
        transactions.run((tx) => tx.query(sql)),
        (error) => error.code === "55000",
      );
    assert.deepEqual(await counts(), after);
    await transactions.run(async (tx) => {
      for (const setting of ["bop.tenant_id", "bop.brand_id"]) {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
          [tenant, brand],
        );
        await tx.query("SELECT set_config($1,$2,true)", [setting, id(9999)]);
        for (const table of ["option_set_review_content", "option_set_publication_release"])
          assert.equal(
            (await tx.query("SELECT count(*)::int n FROM rms_catalog." + table)).rows[0].n,
            0,
          );
      }
    });
    assert.deepEqual(await counts(), after);
    // New actual Draft root and actual committed Published child. No source
    // snapshot or release eligibility is supplied by a caller fixture.
    phase = "DraftPublicationGraphCreate";
    const parentOperation = reference();
    const parentCommand = globalThis.structuredClone(command);
    parentCommand.internalCode = "SYNTHETIC_PARENT_OPTIONS";
    parentCommand.operationReference = parentOperation;
    parentCommand.draft.options = [
      { ...parentCommand.draft.options[0], triggeredOptionSetReference: set },
    ];
    parentCommand.additionalContent.optionDetails = [
      {
        ...parentCommand.additionalContent.optionDetails[0],
        triggeredOptionSetVersionReference: version,
      },
    ];
    const parent = await transactions.run((tx) =>
      createPostgresFullOptionSetDraftStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions: borrowed(tx),
        authority: { holdUntilTransactionCompletes: permit },
        creation: {
          authority: { holdUntilTransactionCompletes: permit },
          references: { generate: reference },
        },
        audit: {
          create: (input) =>
            audit(
              input.operationReference,
              "CATALOG_OPTION_SET_CREATE",
              "CatalogOptionSet",
              input.result.sourceAggregate.optionSetReference,
              input.occurredAt,
            ),
        },
        events: { generateReference: reference },
      }).create(parentCommand),
    );
    const parentSet = parent.content.sourceAggregate.optionSetReference;
    const parentVersion = parent.content.sourceAggregate.draft.versionReference;
    const parentCurrent = await transactions.run((tx) =>
      createPostgresCurrentFullOptionSetDraftStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now },
        transactions: borrowed(tx),
        authority: { holdUntilTransactionCompletes: permit },
      }).readCurrentForReview({ optionSetReference: parentSet, expectedAggregateVersion: 1 }),
    );
    const parentRequest = {
      optionSetReference: parentSet,
      versionReference: parentVersion,
      expectedAggregateVersion: 1,
      sourceDigest: parentCurrent.sourceDigest,
      contentDigest: parentCurrent.contentDigest,
      configurationDigest: parentCurrent.configurationDigest,
    };
    const afterParent = await counts();
    phase = "CurrentDraftReviewDiscoveryAbsent";
    await transactions.run(async (tx) => {
      assert.equal(
        await owner().readCurrentReviewForDraft(tx, {
          optionSetReference: parentSet,
          expectedAggregateVersion: 1,
        }),
        null,
      );
    });
    assert.deepEqual(await counts(), afterParent);
    phase = "DraftPublicationGraph";
    await transactions.run((tx) =>
      createCurrentOptionSetPublicationDraftGraphSource(graphOptions(tx)).withCurrentGraph(
        parentRequest,
        async (packet) => {
          assert.equal(packet.sourceAuthority, "CurrentDraftRootAndCurrentPublishedChildren");
          assert.equal(packet.sourceOperationReference, parentOperation);
          assert.deepEqual(packet.sourceSnapshotTuple, parentCurrent.sourceSnapshotTuple);
          assert.equal(packet.graph.rootOptionSetReference, parentSet);
          assert.equal(packet.graph.rootVersionReference, parentVersion);
          assert.equal(packet.graph.contents.length, 2);
          assert.deepEqual(
            packet.graph.contents.find(
              (content) => content.sourceAggregate.optionSetReference === parentSet,
            ),
            parent.content,
          );
          assert.deepEqual(
            packet.graph.contents.find(
              (content) => content.sourceAggregate.optionSetReference === set,
            ),
            current.content,
          );
          assert.equal(packet.sourceRecords.length, 1);
          assert.equal(
            packet.sourceRecords[0].publicationReference,
            releaseRecord.release.releaseId,
          );
          assert.equal(packet.sourceRecords[0].releaseRecordDigest, releaseRecord.digest);
          assert.equal(packet.referenceEligibility, "NotEvaluated");
          assert.equal(packet.publishValidation, "Incomplete");
        },
      ),
    );
    assert.deepEqual(await counts(), afterParent);
    phase = "DraftPublicationGraphLatePermission";
    await assert.rejects(
      transactions.run((tx) =>
        createCurrentOptionSetPublicationDraftGraphSource(graphOptions(tx)).withCurrentGraph(
          parentRequest,
          async () => {
            allowed = false;
          },
        ),
      ),
      { code: "CATALOG_PERMISSION_DENIED" },
    );
    allowed = true;
    assert.deepEqual(await counts(), afterParent);
    if (!nearLimit) {
      phase = "QualifiedValidationBrandSeed";
      await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
      await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO " + role);
      await admin.query(
        "GRANT SELECT ON bop_tenant.brand_configuration_version,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO " +
          role,
      );
      // Synthetic immutable organization/configuration metadata. Publishing
      // governance and its independent approval below are actual owning writes.
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES($1,'SYNTH_NATIVE','Synthetic native Option Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, at],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES($1,$2,'SYNTH_STORE','Synthetic native Option Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [id(6), brand, at],
      );
      const brandConfiguration = {
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
        effectiveFrom: at,
        effectiveUntil: null,
        supersedesVersionReference: null,
        reasonCode: "SYNTHETIC_OPTION_NATIVE",
        authoredByReference: actor,
        approvedByReference: null,
        approvalEvidenceReference: null,
        publicationReference: null,
        createdAt: at,
        updatedAt: at,
        dataClassification: "ConfigurationMetadata",
      };
      const brandPublication = await transactions.run(async (tx) => {
        const draft = lifecycle(
          reference(),
          brandConfiguration.configurationVersionReference,
          tenantBrandConfigurationContentDigest(brandConfiguration),
          "BRAND_CONFIGURATION",
          "BRAND_CONFIGURATION",
        );
        const { review, evidence } = await submit(tx, draft);
        return (await approvePublish(tx, review, evidence)).packet;
      });
      const configuration = {
        ...brandConfiguration,
        lifecycle: "Published",
        approvedByReference: brandPublication.recorded.approvalEvidence.approvedActorReference,
        approvalEvidenceReference: brandPublication.recorded.approvalEvidence.evidenceReference,
        publicationReference: brandPublication.recorded.release.releaseId,
      };
      assert.equal(
        tenantBrandConfigurationContentDigest(configuration),
        brandPublication.recorded.release.snapshotDigest,
      );
      await admin.query(
        `INSERT INTO bop_tenant.brand_configuration_version(configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          configuration.configurationVersionReference,
          configuration.brandReference,
          configuration.configurationVersion,
          configuration.lifecycle,
          configuration.defaultLocale,
          configuration.supportedLocales,
          configuration.mediaThemeReference,
          configuration.catalogSourceReference,
          configuration.platformTemplateReference,
          configuration.overrideAllowedFieldCodes,
          configuration.hardRequirementFieldCodes,
          configuration.effectiveFrom,
          configuration.effectiveUntil,
          configuration.supersedesVersionReference,
          configuration.reasonCode,
          configuration.authoredByReference,
          configuration.approvedByReference,
          configuration.approvalEvidenceReference,
          configuration.publicationReference,
          configuration.createdAt,
          configuration.updatedAt,
          configuration.dataClassification,
        ],
      );
      const afterAssemblySeed = await counts(),
        permissionSnapshot = reference();
      const actualNow = () => new Date().toISOString();
      const assertAllowed = () => {
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      const qualificationOptions = (
        tx,
        originalObservedAt,
        originalValidUntil,
        operationReference,
      ) => ({
        ...graphOptions(tx),
        clock: { now: actualNow },
        originalObservedAt,
        originalValidUntil,
        operationReference,
        policyReference: policy.policyReference,
        policyVersion: policy.policyVersion,
        brandConfigurationVersionReference: configuration.configurationVersionReference,
        expectedBrandVersion: 1,
        mediaScope: scope,
        currentAuthorization: {
          async authorizeActions(actions) {
            assertAllowed();
            assert(
              actions.every((action) =>
                ["catalog.manage", "catalog.option_set.read"].includes(action),
              ),
            );
          },
          async authorizeActionsWithDecisions(actions) {
            assertAllowed();
            return Object.freeze(
              actions.map((action) => {
                assert(
                  [
                    "catalog.manage",
                    "catalog.option_set.read",
                    "catalog.option_set.publish",
                    "media.asset.access",
                  ].includes(action),
                );
                return Object.freeze({
                  effect: "Allow",
                  reason: "ROLE_PERMISSION",
                  source: "RolePermission",
                  action: parseBusinessAction(action),
                  scopeKind: "Brand",
                  policySnapshotReference: parsePolicyReference(permissionSnapshot),
                  policyVersion: parsePolicyVersion(1),
                  audit: Object.freeze({
                    effect: "Allow",
                    reason: "ROLE_PERMISSION",
                    source: "RolePermission",
                  }),
                });
              }),
            );
          },
          assertCurrent() {
            assertAllowed();
            return actualNow();
          },
          leaseDeadline: () => originalValidUntil,
        },
        capability: {
          async holdUntilCommit() {
            assertAllowed();
          },
          leaseDeadline: () => originalValidUntil,
        },
      });
      const validate = async (mode = "Success") =>
        transactions.run(async (tx) => {
          const { rows } = await tx.query(
            `SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') observed_at`,
          );
          assert.equal(rows.length, 1);
          const originalObservedAt = rows[0].observed_at;
          assert.equal(new Date(originalObservedAt).toISOString(), originalObservedAt);
          const originalValidUntil = new Date(Date.parse(originalObservedAt) + 5000).toISOString();
          const options = qualificationOptions(
            tx,
            originalObservedAt,
            originalValidUntil,
            reference(),
          );
          const packet = await createCurrentOptionSetPublicationValidationSource(
            options,
          ).withCurrentValidation(
            {
              graphRequest: parentRequest,
              originalIntentDigest: hash({
                profile: "SYNTHETIC_NATIVE_OPTION_VALIDATION",
                operationReference: options.operationReference,
                graphRequest: parentRequest,
                originalObservedAt,
                activationAt: originalObservedAt,
              }),
              activationAt: originalObservedAt,
            },
            async (value) => {
              assert.equal(value.profile, "CurrentOptionSetPublicationValidationV1");
              assert.equal(value.decision, "Pass");
              assert.equal(value.operationReference, options.operationReference);
              assert.equal(value.sourceOperationReference, parentOperation);
              assert.equal(value.originalObservedAt, originalObservedAt);
              assert.equal(value.reviewBinding.activationAt, originalObservedAt);
              assert.equal(value.reviewBinding.sourceDigest, parentCurrent.sourceDigest);
              assert.equal(value.reviewBinding.contentDigest, parentCurrent.contentDigest);
              assert.equal(
                value.reviewBinding.configurationDigest,
                parentCurrent.configurationDigest,
              );
              assert(
                value.observedAt > originalObservedAt && value.observedAt < originalValidUntil,
                "actual source reads advance beyond the original activation clock",
              );
              assert(value.validUntil <= originalValidUntil);
              assert.deepEqual(value.content, parent.content);
              assert.equal(value.independentApproval, "NotEvaluated");
              assert.equal(value.saleEligibility, "NotEvaluated");
              // Root and genuine Published child have no recorded Price/Inventory/
              // Recipe/Media references. This proves true absence, not nonempty SQL.
              assert(value.checks.every((check) => check.outcome === "Pass"));
              const entries = guards.get(tx);
              assert(entries && entries.length > 0 && entries.length <= 128);
              if (mode === "Permission")
                afterWork = async () => {
                  allowed = false;
                };
              if (mode === "Expiry")
                afterWork = async () => {
                  const remaining = Date.parse(originalValidUntil) - Date.now();
                  if (remaining > 0)
                    await new Promise((resolve) => globalThis.setTimeout(resolve, remaining + 2));
                  assert(actualNow() >= originalValidUntil);
                };
              return value;
            },
          );
          return packet;
        });
      phase = "QualifiedValidationSuccess";
      const beforeValidationCommits = committedTransactions;
      await validate();
      assert.equal(
        committedTransactions,
        beforeValidationCommits + 1,
        "qualified read assembly keeps one actual outer COMMIT",
      );
      assert.deepEqual(
        await counts(),
        afterAssemblySeed,
        "read validation adds no Review/Seal/Publishing mutation/Audit/Outbox",
      );
      phase = "QualifiedValidationLatePermission";
      const beforeRefusalCommits = committedTransactions;
      await assert.rejects(validate("Permission"), { code: "CATALOG_PERMISSION_DENIED" });
      allowed = true;
      assert.equal(committedTransactions, beforeRefusalCommits);
      assert.deepEqual(await counts(), afterAssemblySeed);
      phase = "QualifiedValidationRealClockExpiry";
      await assert.rejects(validate("Expiry"), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(committedTransactions, beforeRefusalCommits);
      assert.deepEqual(await counts(), afterAssemblySeed);

      // Actual Catalog original → qualified Seal → exact handoff in one outer
      // COMMIT. Review absence is genuine; no Approval/new Published claim.
      const readFreshParent = (expectedAggregateVersion) =>
        transactions.run((tx) =>
          createPostgresCurrentFullOptionSetDraftStore({
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            clock: { now: actualNow },
            transactions: borrowed(tx),
            authority: { holdUntilTransactionCompletes: permit },
          }).readCurrentForReview({ optionSetReference: parentSet, expectedAggregateVersion }),
        );
      const ownSeal = (original, secondCas = false) =>
        transactions.run(async (tx) => {
          const rows = (
            await tx.query(
              `SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') observed_at`,
            )
          ).rows;
          assert.equal(rows.length, 1);
          const originalObservedAt = rows[0].observed_at,
            originalValidUntil = new Date(Date.parse(originalObservedAt) + 5000).toISOString(),
            operationReference = reference(),
            sealCommand = {
              optionSetReference: parentSet,
              versionReference: original.content.sourceAggregate.draft.versionReference,
              expectedAggregateVersion: original.content.sourceAggregate.aggregateVersion,
              sourceDigest: original.sourceDigest,
              contentDigest: original.contentDigest,
              configurationDigest: original.configurationDigest,
              operationReference,
              occurredAt: originalObservedAt,
              reasonCode: "SYNTHETIC_OPTION_NATIVE",
            },
            publicationIntentDigest = createCatalogFullOptionSetContentSealIntent({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              command: sealCommand,
            }),
            identity = {
              operationReference,
              publicationIntentDigest,
              occurredAt: originalObservedAt,
            },
            options = {
              ...qualificationOptions(
                tx,
                originalObservedAt,
                originalValidUntil,
                operationReference,
              ),
              publicationSeal: identity,
            },
            validation = createCurrentOptionSetPublicationValidationSource(options),
            boundedPermit = async (actual, input) => {
              assert.equal(actual, tx);
              assertAllowed();
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, brand);
              assert.equal(input.actorReference, actor);
              assert.equal(input.actorKind, "User");
              assert.equal(input.permission, "catalog.manage");
              assert(input.requiredFields.length > 0);
              assert(actualNow() < originalValidUntil);
              return { observedAt: input.observedAt, validUntil: originalValidUntil };
            },
            review = createPostgresOptionSetReviewContentStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: actualNow },
              authority: { holdUntilTransactionCompletes: boundedPermit },
              currentDraftAuthority: { holdUntilTransactionCompletes: boundedPermit },
              registerBeforeCommit: register,
              events: { generateReference: reference },
              publicationSeal: {
                identity,
                originalObservedAt,
                originalValidUntil,
                currentDraftAuthority: { holdUntilTransactionCompletes: boundedPermit },
                frozenAuthority: { holdUntilTransactionCompletes: boundedPermit },
              },
            });
          let qualified = null,
            applyCalls = 0;
          const sealer = (authority) =>
            createPostgresFullOptionSetContentSealStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: actualNow },
              transactions: borrowed(tx),
              authority,
              readAuthority: { holdUntilTransactionCompletes: boundedPermit },
              references: { generateSuccessorVersion: reference },
              audit: {
                create: (input) =>
                  audit(
                    input.operationReference,
                    "CATALOG_OPTION_SET_CONTENT_SEALED",
                    "CatalogOptionSet",
                    parentSet,
                    input.occurredAt,
                  ),
              },
              events: { generateReference: reference },
            });
          const receipt = await sealer({
            async holdUntilTransactionCompletes(actual, input) {
              await boundedPermit(actual, input);
              assert.equal(input.action, "catalog.option_set.publish");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION");
              assert.deepEqual(input.command, sealCommand);
              if (input.phase === "Apply") {
                applyCalls++;
                if (applyCalls === 1) {
                  // This callback starts only after the owning exclusive source lock.
                  qualified = await validation.withCurrentValidation(
                    {
                      graphRequest: {
                        optionSetReference: parentSet,
                        versionReference: sealCommand.versionReference,
                        expectedAggregateVersion: sealCommand.expectedAggregateVersion,
                        sourceDigest: original.sourceDigest,
                        contentDigest: original.contentDigest,
                        configurationDigest: original.configurationDigest,
                      },
                      originalIntentDigest: publicationIntentDigest,
                      activationAt: originalObservedAt,
                    },
                    async (packet) => {
                      assert.equal(packet.decision, "Pass");
                      assert(packet.checks.every((check) => check.outcome === "Pass"));
                      assert.equal(
                        packet.sourceOperationReference,
                        original.sourceOperationReference,
                      );
                      assert.deepEqual(packet.content, original.content);
                      return packet;
                    },
                  );
                  assert.equal(
                    await review.readCurrentReviewForDraft(tx, {
                      optionSetReference: parentSet,
                      expectedAggregateVersion: sealCommand.expectedAggregateVersion,
                    }),
                    null,
                  );
                } else {
                  assert.equal(applyCalls, 2);
                  assert(qualified);
                  assert.deepEqual(input.content, qualified.content);
                }
              }
              return boundedPermit(actual, input);
            },
          }).seal(sealCommand);
          assert.equal(applyCalls, 2);
          assert(qualified);
          assert.equal(
            receipt.content.supportedContent.publicationIntentDigest,
            publicationIntentDigest,
          );
          const graphProof = await validation.admitOwnSeal(receipt),
            reviewProof = await review.admitOwnSeal(tx, receipt);
          assert.deepEqual(graphProof.original.content, original.content);
          assert.equal(
            graphProof.original.sourceOperationReference,
            original.sourceOperationReference,
          );
          assert.equal(graphProof.successor.sourceOperationReference, operationReference);
          assert.equal(
            graphProof.successor.content.sourceAggregate.aggregateVersion,
            sealCommand.expectedAggregateVersion + 1,
          );
          assert.deepEqual(reviewProof.successor.content, graphProof.successor.content);
          assert(
            graphProof.validUntil <= originalValidUntil &&
              reviewProof.validUntil <= originalValidUntil,
          );
          if (secondCas) {
            // A second real owning mutation, not fixture SQL corruption. The
            // original operation's guards must refuse this additional successor.
            const next = await createPostgresCurrentFullOptionSetDraftStore({
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              clock: { now: actualNow },
              transactions: borrowed(tx),
              authority: { holdUntilTransactionCompletes: boundedPermit },
            }).readCurrentForReview({
              optionSetReference: parentSet,
              expectedAggregateVersion: sealCommand.expectedAggregateVersion + 1,
            });
            const other = await sealer({ holdUntilTransactionCompletes: boundedPermit }).seal({
              optionSetReference: parentSet,
              versionReference: next.content.sourceAggregate.draft.versionReference,
              expectedAggregateVersion: next.content.sourceAggregate.aggregateVersion,
              sourceDigest: next.sourceDigest,
              contentDigest: next.contentDigest,
              configurationDigest: next.configurationDigest,
              operationReference: reference(),
              occurredAt: actualNow(),
              reasonCode: "SYNTHETIC_OPTION_NATIVE",
            });
            assert.equal(other.status, "Applied");
            assert.equal(
              other.content.supportedContent.sourceAggregateVersion,
              sealCommand.expectedAggregateVersion + 1,
            );
          }
          return receipt;
        });
      phase = "QualifiedOwnSealHandoff";
      const beforeOwn = await counts(),
        beforeOwnCommits = committedTransactions;
      const actualOriginal = await readFreshParent(1),
        beforeWriteCommits = committedTransactions;
      const actualReceipt = await ownSeal(actualOriginal);
      assert.equal(committedTransactions, beforeWriteCommits + 1);
      assert.equal(beforeWriteCommits, beforeOwnCommits + 1);
      const afterOwn = await counts();
      assert.deepEqual(afterOwn, {
        ...beforeOwn,
        seals: beforeOwn.seals + 1,
        audit: beforeOwn.audit + 1,
        outbox: beforeOwn.outbox + 1,
      });
      const successor = await readFreshParent(2);
      assert.equal(successor.sourceOperationReference, actualReceipt.operationReference);
      assert.equal(
        successor.content.sourceAggregate.draft.versionReference,
        actualReceipt.successorDraftVersionReference,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT status FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
            [parentVersion],
          )
        ).rows,
        [{ status: "Frozen" }],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.option_set_version WHERE option_set_id=$1 AND status='Draft'",
            [parentSet],
          )
        ).rows[0].n,
        1,
      );
      phase = "QualifiedOwnSealExtraCASRollback";
      const beforeSecondCommits = committedTransactions;
      await assert.rejects(ownSeal(successor, true), { code: "CATALOG_VERSION_CONFLICT" });
      assert.equal(committedTransactions, beforeSecondCommits);
      assert.deepEqual(await counts(), afterOwn);
      const afterRefusal = await readFreshParent(2);
      assert.deepEqual(afterRefusal.content, successor.content);
      assert.equal(afterRefusal.sourceOperationReference, successor.sourceOperationReference);
    }
  } finally {
    if (createdRole) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
