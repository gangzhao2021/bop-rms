import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { evaluatePermission } from "../../bop/permission/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import { seedStorePublication } from "./store-publication-seed.mjs";
import assert from "node:assert/strict";
import {
  createPostgresStoreConfigurationAdministration,
  createPostgresStoreReviewSnapshotStore,
  createPersistentStoreConfigurationReview,
  createPersistentStoreApprovalPreparation,
  createPersistentStoreConfigurationAdministration,
  createPostgresCurrentStorePublicationProof,
  createStoreConfigurationVersion,
  createPostgresStorePublicationMaterializer,
  createPostgresStorePublicationContentSource,
  createPostgresStoreBusinessDateSource,
} from "../../rms/store/src/index.ts";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
export async function verifyStoreAuthoringRepository({ admin, role, id, configuration }) {
  const store = id(33);
  let auditFailure = true,
    authorized = true,
    publicationAuthorized = false;
  let generated = 1000;
  const hashContent = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const draft = createStoreConfigurationVersion({
    ...configuration,
    storeReference: store,
    configurationReference: id(800),
    configurationVersion: 1,
    supersedesConfigurationReference: null,
    lifecycle: "Draft",
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
  });
  const run = async (work) => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
      await admin.query("COMMIT");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const serviceOptions = {
    brandReference: id(2),
    storeReference: store,
    run,
    ports: () => ({
      authorization: { authorize: async () => authorized },
      references: {
        hashIntent: (text) => "sha256:" + sha256Hex(text),
        equals: (a, b) => a === b,
        validateControlledReferences: async () => true,
        validateBrandBaseCompatibility: async () => true,
      },
      approval: { validate: async () => true },
      publishing: { validate: async () => publicationAuthorized },
      liveGate: { validate: async () => publicationAuthorized },
    }),
    publishedBaseline: async () => null,
    materializePublication: createPostgresStorePublicationMaterializer({
      brandReference: id(2),
      storeReference: store,
      publishingFamilyReference: id(70),
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      businessDayStartSource: "StoreOverride",
      nextReference: () => id(generated++),
      hashContent,
      authorize: async () => authorized && publicationAuthorized,
    }),
    appendAudit: async (tx, input) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: input.audit.auditReference,
        brandId: id(2),
        storeId: store,
        actor: { type: "User", reference: input.audit.actorReference },
        actionCode: "STORE_CONFIGURATION_CHANGED",
        targetType: "StoreConfiguration",
        targetId: input.operation.configuration.configurationReference,
        correlationId: input.operation.operationReference,
        reasonCode: "SYNTHETIC_AUTHORING",
        occurredAt: input.audit.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "STORE_CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      if (auditFailure) throw new Error("synthetic post-Audit failure");
    },
  };
  const service = createPostgresStoreConfigurationAdministration(serviceOptions);
  const input = {
    operationReference: id(801),
    actorReference: id(10),
    purposeCode: "STORE_CONFIGURATION",
    auditReference: id(901),
    expectedVersion: 0,
    occurredAt: configuration.updatedAt,
    configuration: draft,
  };
  await assert.rejects(service.saveDraft(input), {
    code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2",
        [id(2), store],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [id(901)]))
      .rowCount,
    0,
  );
  auditFailure = false;
  assert.equal((await service.saveDraft(input)).status, "Applied");
  assert.equal((await service.saveDraft(input)).status, "AlreadyApplied");
  await assert.rejects(service.saveDraft({ ...input, purposeCode: "OTHER" }), {
    code: "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT",
  });
  const next = (op, config, actor = id(10)) => ({
    ...input,
    operationReference: id(op),
    auditReference: id(op + 100),
    actorReference: actor,
    expectedVersion: 1,
    configuration: config,
  });
  assert.equal((await service.validate(next(802, draft))).status, "Applied");
  const submitted = createStoreConfigurationVersion({ ...draft, lifecycle: "PendingApproval" });
  assert.equal((await service.submit(next(803, submitted))).status, "Applied");
  const approved = createStoreConfigurationVersion({
    ...submitted,
    lifecycle: "Approved",
    approvedByReference: id(11),
    approvalEvidenceReference: id(812),
  });
  authorized = false;
  await assert.rejects(service.approve(next(804, approved, id(11))), {
    code: "STORE_CONFIGURATION_PERMISSION_DENIED",
  });
  authorized = true;
  const published = createStoreConfigurationVersion({
    ...approved,
    lifecycle: "Published",
    publicationReference: id(813),
    liveGateEvidenceReference: id(814),
  });
  const tables = [
    "store_configuration_version",
    "store_weekly_service_period",
    "store_service_exception",
    "store_service_exception_content",
    "store_service_exception_interval",
    "store_configuration_publication_content",
  ];
  for (const table of tables)
    await admin.query("GRANT INSERT ON rms_store." + table + " TO " + role);
  const publicationIds = (n) => (n === 90 ? id(90) : id(n + 5000));
  const publication = {
    tenantReference: id(90),
    publishingFamilyReference: publicationIds(70),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    hashContent,
    authorize: async () => authorized,
  };
  const authorizationAt = new Date(Date.parse(configuration.updatedAt) + 60000).toISOString();
  let currentAuthorizationCalls = 0;
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_store.store_configuration_review_snapshot TO " + role,
  );
  let reviewAuditFailure = false;
  const reviewOptions = {
    ...publication,
    brandReference: id(2),
    storeReference: store,
    appendAudit: async (tx, input) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: input.auditReference,
        brandId: id(2),
        storeId: store,
        actor: { type: "User", reference: input.actorReference },
        actionCode: "STORE_CONFIGURATION_CHANGED",
        targetType: "StoreConfiguration",
        targetId: input.reviewedPublication.configurationReference,
        correlationId: input.lifecycleReference,
        reasonCode: "SYNTHETIC_REVIEW_SNAPSHOT",
        occurredAt: input.recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "STORE_CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      if (reviewAuditFailure) throw new Error("synthetic review Audit failure");
    },
  };
  const reviewInput = {
    reviewedPublication: published,
    lifecycleReference: publicationIds(71),
    actorReference: id(11),
    auditReference: id(9090),
  };
  const reviewStore = createPostgresStoreReviewSnapshotStore(reviewOptions);
  assert.equal(await run((tx) => reviewStore.read(tx, approved, authorizationAt)), null);
  reviewAuditFailure = true;
  await assert.rejects(
    run((tx) => reviewStore.save(tx, reviewInput, authorizationAt)),
    /STORE_REVIEW_SNAPSHOT_UNAVAILABLE/,
  );
  assert.equal(
    (await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [id(9090)]))
      .rowCount,
    0,
  );
  assert.equal(await run((tx) => reviewStore.read(tx, approved, authorizationAt)), null);
  reviewAuditFailure = false;
  assert.equal(await run((tx) => reviewStore.save(tx, reviewInput, authorizationAt)), "Applied");
  assert.equal(
    await run((tx) => reviewStore.save(tx, reviewInput, authorizationAt)),
    "AlreadyApplied",
  );
  await assert.rejects(
    run((tx) =>
      reviewStore.save(
        tx,
        {
          ...reviewInput,
          reviewedPublication: { ...published, reasonCode: "CHANGED" },
        },
        authorizationAt,
      ),
    ),
    /STORE_REVIEW_SNAPSHOT_UNAVAILABLE/,
  );
  await assert.rejects(
    run((tx) => reviewStore.read(tx, { ...approved, storeReference: id(3) }, authorizationAt)),
    /STORE_REVIEW_SNAPSHOT_UNAVAILABLE/,
  );
  await assert.rejects(
    run((tx) => reviewStore.read(tx, approved, configuration.updatedAt)),
    /STORE_REVIEW_SNAPSHOT_UNAVAILABLE/,
  );
  await assert.rejects(
    admin.query("UPDATE rms_store.store_configuration_review_snapshot SET purpose_code='OTHER'"),
    /append-only/,
  );
  assert.equal(
    (await admin.query("DELETE FROM rms_store.store_configuration_review_snapshot")).rowCount,
    0,
  );
  // A new adapter instance retrieves persisted review content, not a closure snapshot.
  const restoredReviewStore = createPostgresStoreReviewSnapshotStore(reviewOptions);
  assert.deepEqual(
    (await run((tx) => restoredReviewStore.read(tx, approved, authorizationAt)))
      .reviewedPublication,
    published,
  );
  const realService = createPersistentStoreConfigurationAdministration({
    ...serviceOptions,
    now: () => authorizationAt,
    approvalSnapshot: restoredReviewStore.read,
    ports: (tx) => ({
      ...serviceOptions.ports(tx),
      authorization: {
        authorize: async (input) => {
          assert.equal(input.observedAt, authorizationAt);
          currentAuthorizationCalls++;
          return authorized;
        },
      },
    }),
    publication,
    businessDayStartSource: "StoreOverride",
    nextReference: () => id(generated++),
  });
  // Real Store approval must reject before Publishing has accepted this snapshot.
  await assert.rejects(realService.approve(next(804, approved, id(11))), {
    code: "STORE_CONFIGURATION_APPROVAL_INVALID",
  });
  const tenantContext = createTenantContext(
    {
      actorType: "User",
      accountKind: "Workforce",
      actorReference: id(11),
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: configuration.updatedAt,
      recentMfaAt: null,
    },
    createBrand({
      brandReference: id(2),
      code: "SYNTHETIC_REVIEW",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: configuration.updatedAt,
      updatedAt: configuration.updatedAt,
    }),
    createStore({
      storeReference: store,
      brandReference: id(2),
      code: "SYNTHETIC_REVIEW",
      displayName: "Synthetic Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: configuration.updatedAt,
      updatedAt: configuration.updatedAt,
    }),
    authorizationAt,
  );
  await admin.query("GRANT INSERT ON bop_publishing.publishing_mutation_record TO " + role);
  const atomicApprove = createPersistentStoreConfigurationReview({
    administration: {
      ...serviceOptions,
      now: () => authorizationAt,
      publication,
      businessDayStartSource: "StoreOverride",
      nextReference: () => id(generated++),
    },
    snapshotAudit: reviewOptions.appendAudit,
    publishingAuthorization: () => ({
      authorize: async (request) =>
        evaluatePermission({
          tenantContext: request.tenantContext,
          action: request.action,
          resourceScope: request.resourceScope,
          policySnapshotReference: id(9091),
          policyVersion: 1,
          evidence: [
            {
              source: "ExplicitAllow",
              evidenceReference: id(9092),
              action: request.action,
              actorReference: id(11),
              roleReference: null,
              brandReference: id(2),
              storeReference: store,
              effectiveFrom: configuration.updatedAt,
              effectiveUntil: "2026-08-17T14:00:00.000Z",
            },
          ],
        }),
    }),
  });
  await seedStorePublication(
    admin,
    publicationIds,
    published,
    hashContent(published),
    undefined,
    async (mutation) => {
      const request = {
        storeCommand: next(804, approved, id(11)),
        snapshot: reviewInput,
        publishingApproval: {
          tenantContext,
          operation: "Approve",
          expectedVersion: mutation.expectedVersion,
          current: mutation.current,
          next: mutation.next,
          approvalEvidence: mutation.approvalEvidence,
          idempotencyKey: mutation.idempotencyKey,
          auditId: mutation.audit.auditId,
          correlationId: mutation.audit.correlationId,
          occurredAt: mutation.audit.occurredAt,
          sourceChannel: mutation.audit.sourceChannel,
        },
      };
      auditFailure = true;
      await assert.rejects(atomicApprove(request), {
        code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      });
      for (const auditId of [id(904), mutation.audit.auditId])
        assert.equal(
          (
            await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
              auditId,
            ])
          ).rowCount,
          0,
        );
      await assert.rejects(
        createPostgresPublishingMutationStore({ run }, id(90), {
          kind: "Store",
          brandReference: id(2),
          storeReference: store,
        }).resolveCurrentApproval({
          familyReference: publicationIds(70),
          lifecycleReference: publicationIds(71),
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          observedAt: authorizationAt,
        }),
      );
      auditFailure = false;
      assert.equal((await atomicApprove(request)).status, "Applied");
      assert.equal((await atomicApprove(request)).status, "AlreadyApplied");
    },
  );
  await assert.rejects(service.publish(next(805, published, id(11))), {
    code: "STORE_CONFIGURATION_PUBLISHING_INVALID",
  });
  const rows = await admin.query(
    "SELECT command_type,lifecycle FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 ORDER BY sequence_number",
    [id(2), store],
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.command_type, row.lifecycle]),
    [
      ["SaveDraft", "Draft"],
      ["Validate", "Draft"],
      ["Submit", "PendingApproval"],
      ["Approve", "Approved"],
    ],
  );
  publicationAuthorized = true; // Synthetic authority; this covers persistence, not real release approval.
  auditFailure = true;
  const publicationInput = next(805, published, id(11));
  await assert.rejects(realService.publish(publicationInput), {
    code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  for (const table of tables) {
    assert.equal(
      (
        await admin.query(
          "SELECT * FROM rms_store." + table + " WHERE brand_id=$1 AND store_id=$2",
          [id(2), store],
        )
      ).rowCount,
      0,
    );
  }
  assert.equal(
    (await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [id(905)]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2",
        [id(2), store],
      )
    ).rowCount,
    4,
  );
  auditFailure = false;
  assert.equal((await realService.publish(publicationInput)).status, "Applied");
  const generatedAfterPublish = generated;
  assert.equal((await realService.publish(publicationInput)).status, "AlreadyApplied");
  assert.equal(
    (
      await realService.publish({
        ...publicationInput,
        occurredAt: authorizationAt,
      })
    ).status,
    "AlreadyApplied",
  );
  assert.equal(
    (
      await admin.query("SELECT occurred_at FROM platform_audit.audit_record WHERE audit_id=$1", [
        publicationInput.auditReference,
      ])
    ).rows[0].occurred_at.toISOString(),
    publicationInput.occurredAt,
  );

  assert.equal(generated, generatedAfterPublish);
  assert.ok(currentAuthorizationCalls >= 3);
  authorized = false;
  await assert.rejects(realService.publish(publicationInput), {
    code: "STORE_CONFIGURATION_PERMISSION_DENIED",
  });
  authorized = true;

  const contentSource = createPostgresStorePublicationContentSource({
    brandReference: id(2),
    storeReference: store,
    configurationReference: id(800),
    authorize: async () => authorized,
    hashContent,
  });
  const readback = await run((tx) => contentSource(tx, configuration.updatedAt));
  assert.deepEqual(readback.configuration, published);
  assert.equal(readback.contentDigest, hashContent(published));
  assert.equal(readback.businessDayStartSource, "StoreOverride");
  const current = await run((tx) =>
    createPostgresCurrentStorePublicationProof({
      ...publication,
      brandReference: id(2),
      storeReference: store,
      configurationReference: id(800),
    })(tx, configuration.updatedAt),
  );
  assert.equal(current.release.releaseId, published.publicationReference);
  assert.equal(current.contentDigest, hashContent(published));

  const weekly = await admin.query(
    "SELECT iso_weekday,sequence_number,start_local_time,end_local_time,ends_next_day,service_modes,order_cutoff_seconds,lead_time_seconds FROM rms_store.store_weekly_service_period WHERE brand_id=$1 AND store_id=$2 ORDER BY iso_weekday,sequence_number",
    [id(2), store],
  );
  assert.deepEqual(
    weekly.rows,
    published.weeklySchedule.flatMap((day) =>
      day.intervals.map((interval, index) => ({
        iso_weekday: day.isoWeekday,
        sequence_number: index + 1,
        start_local_time: interval.startLocalTime,
        end_local_time: interval.endLocalTime,
        ends_next_day: interval.endsNextDay,
        service_modes: [...interval.serviceModes],
        order_cutoff_seconds: interval.orderCutoffSeconds,
        lead_time_seconds: interval.leadTimeSeconds,
      })),
    ),
  );
  const exceptions = await admin.query(
    "SELECT e.local_date::text,e.exception_kind,e.interval_summary_digest,c.interval_count FROM rms_store.store_service_exception e JOIN rms_store.store_service_exception_content c USING(brand_id,store_id,exception_id) WHERE e.brand_id=$1 AND e.store_id=$2 ORDER BY e.local_date",
    [id(2), store],
  );
  assert.deepEqual(
    exceptions.rows,
    published.exceptions.map((e) => ({
      local_date: e.localDate,
      exception_kind: e.kind,
      interval_summary_digest: hashContent(e.intervals),
      interval_count: e.intervals.length,
    })),
  );
  const exceptionIntervals = await admin.query(
    "SELECT e.local_date::text,i.sequence_number,i.start_local_time,i.end_local_time,i.ends_next_day,i.service_modes,i.order_cutoff_seconds,i.lead_time_seconds FROM rms_store.store_service_exception e JOIN rms_store.store_service_exception_interval i USING(brand_id,store_id,exception_id) WHERE e.brand_id=$1 AND e.store_id=$2 ORDER BY e.local_date,i.sequence_number",
    [id(2), store],
  );
  assert.deepEqual(
    exceptionIntervals.rows,
    published.exceptions.flatMap((e) =>
      e.intervals.map((i, index) => ({
        local_date: e.localDate,
        sequence_number: index + 1,
        start_local_time: i.startLocalTime,
        end_local_time: i.endLocalTime,
        ends_next_day: i.endsNextDay,
        service_modes: [...i.serviceModes],
        order_cutoff_seconds: i.orderCutoffSeconds,
        lead_time_seconds: i.leadTimeSeconds,
      })),
    ),
  );
  const materialize = createPostgresStorePublicationMaterializer({
    brandReference: id(2),
    storeReference: store,
    publishingFamilyReference: id(70),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    businessDayStartSource: "StoreOverride",
    nextReference: () => id(generated++),
    hashContent,
    authorize: async () => authorized,
  });
  const later = new Date(Date.parse(published.effectiveFrom) + 3600000).toISOString();
  const end = new Date(Date.parse(later) + 3600000).toISOString();
  const intermediate = createStoreConfigurationVersion({
    ...draft,
    configurationReference: id(809),
    configurationVersion: 2,
    supersedesConfigurationReference: published.configurationReference,
  });
  assert.equal((await service.saveDraft(next(806, intermediate))).status, "Applied");
  const successor = createStoreConfigurationVersion({
    ...published,
    configurationReference: id(810),
    configurationVersion: 3,
    supersedesConfigurationReference: intermediate.configurationReference,
    effectiveFrom: later,
    effectiveUntil: end,
    businessDayStartLocalTime: "05:00:00",
  });
  const writeSnapshot = (tx, c) =>
    materialize(tx, {
      operation: {
        command: "Publish",
        operationReference: id(820),
        brandReference: id(2),
        storeReference: store,
        intentDigest: hashContent(c),
        resultingVersion: c.configurationVersion,
        configuration: c,
      },
      expectedVersion: c.configurationVersion,
      audit: {
        actorReference: id(11),
        auditReference: id(920),
        purposeCode: "STORE_CONFIGURATION",
        occurredAt: configuration.updatedAt,
      },
    });
  // Synthetic authority isolates selection rules; actual current release proof is a separate gate.
  const source = createPostgresStoreBusinessDateSource({
    brandReference: id(2),
    storeReference: store,
    timeZone: published.timeZone,
    authorize: async () => authorized,
    publicationProof: async (tx, candidate, at) => {
      const content = await createPostgresStorePublicationContentSource({
        brandReference: id(2),
        storeReference: store,
        configurationReference: candidate.configurationReference,
        authorize: async () => authorized,
        hashContent,
      })(tx, at);
      return {
        contentDigest: content.contentDigest,
        businessDayStartSource: content.businessDayStartSource,
      };
    },
  });
  await run((tx) => writeSnapshot(tx, successor));
  assert.equal(
    (await run((tx) => source(tx, published.effectiveFrom))).configurationReference,
    published.configurationReference,
  );
  assert.equal(
    (await run((tx) => source(tx, later))).configurationReference,
    successor.configurationReference,
  );
  await assert.rejects(
    run((tx) => source(tx, end)),
    /STORE_BUSINESS_DATE_UNAVAILABLE/u,
  );
  // A competing fork is ambiguity, never a highest-version-wins shortcut.
  await run((tx) =>
    writeSnapshot(
      tx,
      createStoreConfigurationVersion({
        ...successor,
        configurationReference: id(811),
        configurationVersion: 4,
      }),
    ),
  );
  await assert.rejects(
    run((tx) => source(tx, later)),
    /STORE_BUSINESS_DATE_UNAVAILABLE/u,
  );
  const pendingIntermediate = createStoreConfigurationVersion({
    ...intermediate,
    lifecycle: "PendingApproval",
  });
  await service.submit({ ...next(8400, pendingIntermediate), expectedVersion: 2 });
  const approvalCandidate = createStoreConfigurationVersion({
    ...pendingIntermediate,
    lifecycle: "Approved",
    approvedByReference: id(11),
    approvalEvidenceReference: id(8401),
  });
  let runtimeNow = new Date(Date.parse(configuration.updatedAt) + 120000).toISOString();
  const publishingAuthorization = () => ({
    authorize: async (request) =>
      evaluatePermission({
        tenantContext: request.tenantContext,
        action: request.action,
        resourceScope: request.resourceScope,
        policySnapshotReference: id(9091),
        policyVersion: 1,
        evidence: [
          {
            source: "ExplicitAllow",
            evidenceReference: id(9092),
            action: request.action,
            actorReference: id(11),
            roleReference: null,
            brandReference: id(2),
            storeReference: store,
            effectiveFrom: configuration.updatedAt,
            effectiveUntil: "2026-08-17T14:00:00.000Z",
          },
        ],
      }),
  });
  const prepareApproval = createPersistentStoreApprovalPreparation({
    ...reviewOptions,
    tenantReference: id(90),
    nextReference: () => id(generated++),
    publishingAuthorization,
    validate: async () => ({
      validUntil: "2026-08-17T14:00:00.000Z",
      checkCodes: ["SYNTHETIC_CONTROLLED_REFERENCES_VALID"],
      liveGateEvidenceReference: id(814),
    }),
  });
  const approvePrepared = (body) =>
    run(async (tx) => {
      const context = createTenantContext(
        tenantContext.actor,
        tenantContext.brand,
        tenantContext.store,
        runtimeNow,
      );
      const prepared = await prepareApproval(tx, body.configuration, context, runtimeNow);
      const command = { ...body, configuration: prepared.configuration, occurredAt: runtimeNow };
      const administration = {
        ...serviceOptions,
        publication,
        now: () => runtimeNow,
        run: async (work) => work(tx),
        businessDayStartSource: "StoreOverride",
        nextReference: () => id(generated++),
      };
      if (prepared.kind === "Replay")
        return createPersistentStoreConfigurationAdministration({
          ...administration,
          approvalSnapshot: restoredReviewStore.read,
        }).approve(command);
      return createPersistentStoreConfigurationReview({
        administration,
        snapshotAudit: reviewOptions.appendAudit,
        publishingAuthorization,
      })({
        storeCommand: command,
        snapshot: prepared.snapshot,
        publishingApproval: { ...prepared.publishingApproval, tenantContext: context },
      });
    });
  const prepareCommand = { ...next(8402, approvalCandidate, id(11)), expectedVersion: 2 };
  auditFailure = true;
  await assert.rejects(approvePrepared(prepareCommand), {
    code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  });
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_review_snapshot WHERE brand_id=$1 AND store_id=$2 AND approval_evidence_reference=$3",
        [id(2), store, id(8401)],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT * FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1 AND store_id=$2 AND mutation_json->'next'->>'snapshotReference'=$3",
        [id(2), store, intermediate.configurationReference],
      )
    ).rowCount,
    0,
  );
  auditFailure = false;
  assert.equal((await approvePrepared(prepareCommand)).status, "Applied");
  const countAfterPreparation = generated;
  const originalApprovalTime = runtimeNow;
  runtimeNow = new Date(Date.parse(runtimeNow) + 60000).toISOString();
  assert.equal((await approvePrepared(prepareCommand)).status, "AlreadyApplied");
  assert.equal(generated, countAfterPreparation);
  const storedApproval = await admin.query(
    "SELECT configuration_json FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
    [id(2), store, id(8402)],
  );
  assert.equal(storedApproval.rows[0].configuration_json.updatedAt, originalApprovalTime);
  await assert.rejects(
    approvePrepared({
      ...prepareCommand,
      configuration: { ...approvalCandidate, reasonCode: "CHANGED" },
    }),
    /STORE_APPROVAL_PREPARATION_UNAVAILABLE/,
  );
  // Original configuration has already been published. Recover its Store operation.
  assert.equal((await approvePrepared(next(804, approved, id(11)))).status, "AlreadyApplied");
  assert.equal(generated, countAfterPreparation);
}
