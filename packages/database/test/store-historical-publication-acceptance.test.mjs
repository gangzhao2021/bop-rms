import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresCurrentStorePublicationProof,
  createPostgresPublishedStoreOperatingStatusReader,
  createPostgresStoreBusinessDateConfigurationSource,
  createStoreConfigurationVersion,
} from "../../rms/store/src/index.ts";
import { createMerchantOrdinaryRefundBusinessDate } from "../../../apps/api/src/merchant-ordinary-refund-business-date.ts";
import { createInternalClosedSettlementWindow } from "../../../tooling/environment/pilot-settlement-window.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// Synthetic Store/Live Gate facts written as owner; actual Publishing writer and the
// actual Store/Publishing/settlement readers executed under a NOBYPASSRLS role.
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  hashContent = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  brand = id(2),
  store = id(3),
  tenant = id(90),
  family = id(70),
  // v1 (seed) governs from a business-day boundary (04:00 America/Toronto).
  v1At = "2026-09-20T08:00:00.000Z",
  // v2 (hours edit): effectiveFrom is the draft save time, earlier than publication.
  v2SavedAt = "2026-10-09T14:00:00.000Z",
  v2ApprovedAt = "2026-10-09T14:02:00.000Z",
  v2PublishedAt = "2026-10-09T14:05:00.000Z",
  // v3 moves the business-day start to 05:00 mid-day (not possible via hours editing;
  // modelled to show a day with differing boundaries is refused).
  v3SavedAt = "2026-10-10T14:00:00.000Z",
  v3PublishedAt = "2026-10-10T14:05:00.000Z",
  now = "2026-10-11T15:00:00.000Z",
  validUntil = "2026-12-31T00:00:00.000Z";

function configuration(version) {
  const v1 = version === 1;
  const v3 = version === 3;
  const [savedAt, publishedAt] =
    version === 1
      ? [v1At, v1At]
      : version === 2
        ? [v2SavedAt, v2PublishedAt]
        : [v3SavedAt, v3PublishedAt];
  return createStoreConfigurationVersion({
    configurationReference: v1 ? id(1) : id(500 * (version - 1) + 1),
    brandReference: brand,
    storeReference: store,
    configurationVersion: version,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: v3 ? "05:00:00" : "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals: [
        {
          startLocalTime: v1 ? "09:00:00" : "08:00:00",
          endLocalTime: "22:00:00",
          endsNextDay: false,
          serviceModes: ["DineIn", "Pickup"],
          orderCutoffSeconds: 900,
          leadTimeSeconds: 1200,
        },
      ],
    })),
    exceptions: [],
    effectiveFrom: savedAt,
    effectiveUntil: null,
    supersedesConfigurationReference: v1 ? null : version === 2 ? id(1) : id(501),
    reasonCode: "PILOT_CONFIGURATION",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: v1 ? id(12) : id(500 * (version - 1) + 12),
    publicationReference: v1 ? id(13) : id(500 * (version - 1) + 13),
    liveGateEvidenceReference: id(14),
    createdAt: savedAt,
    updatedAt: publishedAt,
    dataClassification: "ConfigurationMetadata",
  });
}

async function insertStoreVersion(admin, c) {
  await admin.query(
    `INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,'Published','StoreOverride',$5,'en-CA','CAD','America/Toronto',$20,$6,$7,$8,$9,$10,NULL,ARRAY['DineIn','Pickup'],$11,NULL,$12,'PILOT_CONFIGURATION',$13,$14,$15,$16,$17,$18,$19,'ConfigurationMetadata')`,
    [
      c.configurationReference,
      brand,
      store,
      c.configurationVersion,
      c.brandBaseVersionReference,
      c.addressReference,
      c.contactReference,
      c.receiptReference,
      c.taxConfigurationReference,
      c.paymentConfigurationReference,
      c.effectiveFrom,
      c.supersedesConfigurationReference,
      c.authoredByReference,
      c.approvedByReference,
      c.approvalEvidenceReference,
      c.publicationReference,
      c.liveGateEvidenceReference,
      c.createdAt,
      c.updatedAt,
      c.businessDayStartLocalTime,
    ],
  );
  for (const day of c.weeklySchedule)
    for (const [index, interval] of day.intervals.entries())
      await admin.query(
        "INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ConfigurationMetadata')",
        [
          id(c.configurationVersion * 1000 + day.isoWeekday * 10 + index),
          brand,
          store,
          c.configurationReference,
          day.isoWeekday,
          index + 1,
          interval.startLocalTime,
          interval.endLocalTime,
          interval.endsNextDay,
          interval.serviceModes,
          interval.orderCutoffSeconds,
          interval.leadTimeSeconds,
        ],
      );
  await admin.query(
    "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,$7,$8,'ConfigurationMetadata')",
    [
      brand,
      store,
      c.configurationReference,
      family,
      hashContent(c),
      c,
      c.businessDayStartLocalTime === "04:00:00" ? "PlatformDefault" : "StoreOverride",
      // As the materializer: recorded at the publication instant, not the draft save.
      c.updatedAt,
    ],
  );
}

/** Actual Publishing writer: Create/Submit/Approve/Publish per version in one family. */
async function publish(admin, c, { sequence, previous, savedAt, approvedAt, publishedAt }) {
  const scope = { kind: "Store", brandReference: brand, storeReference: store };
  const n = c.configurationVersion * 100;
  const digest = hashContent(c);
  const owner = createPostgresPublishingMutationStore(
    {
      async run(work) {
        await admin.query("BEGIN");
        try {
          const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      },
    },
    tenant,
    scope,
  );
  const draft = {
    lifecycleId: id(n + 71),
    familyReference: family,
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: c.configurationReference,
    snapshotDigest: digest,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: savedAt,
    changedAt: savedAt,
  };
  const mutation = (operation, current, next, k, occurredAt, extra = {}) => ({
    operation,
    expectedVersion: current?.version ?? 1,
    idempotencyKey: id(n + k),
    current,
    next,
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: null,
    audit: {
      auditId: id(n + k + 1),
      brandId: brand,
      storeId: store,
      actor: { type: "User", reference: k === 20 ? id(11) : id(10) },
      actionCode: {
        CreateDraft: "PUBLISHING_DRAFT_CREATED",
        SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
        Approve: "PUBLISHING_REVIEW_APPROVED",
        Publish: "PUBLISHING_RELEASE_PUBLISHED",
      }[operation],
      targetType: "PublishingLifecycle",
      targetId: next.lifecycleId,
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(n + k),
      occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
    ...extra,
  });
  const validation = {
    evidenceReference: id(n + 72),
    snapshotReference: c.configurationReference,
    snapshotDigest: digest,
    scope,
    result: "Pass",
    checkedAt: savedAt,
    validUntil,
    checkCodes: ["SCHEMA_VALID"],
  };
  const approval = {
    evidenceReference: c.approvalEvidenceReference,
    reviewLifecycleId: draft.lifecycleId,
    reviewVersion: 2,
    snapshotReference: c.configurationReference,
    snapshotDigest: digest,
    scope,
    decision: "Accepted",
    approvedActorReference: id(11),
    approvedAt,
    validUntil,
  };
  const review = {
    ...draft,
    version: 2,
    state: "InReview",
    validationEvidenceReference: id(n + 72),
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: approval.evidenceReference,
    changedAt: approvedAt,
  };
  const published = { ...approved, version: 4, state: "Published", changedAt: publishedAt };
  await owner.commit(mutation("CreateDraft", null, draft, 0, savedAt));
  await owner.commit(
    mutation("SubmitReview", draft, review, 10, savedAt, { validationEvidence: validation }),
  );
  await owner.commit(
    mutation("Approve", review, approved, 20, approvedAt, { approvalEvidence: approval }),
  );
  await owner.commit(
    mutation("Publish", approved, published, 30, publishedAt, {
      validationEvidence: validation,
      approvalEvidence: approval,
      supersededReleaseId: previous,
      release: {
        releaseId: c.publicationReference,
        familyReference: family,
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        snapshotReference: c.configurationReference,
        snapshotDigest: digest,
        scope,
        sequence,
        sourceLifecycleId: draft.lifecycleId,
        kind: "Publish",
        previousReleaseId: previous,
        createdAt: publishedAt,
      },
    }),
  );
}

async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2423h_${context.runId}`;
  await admin.connect();
  try {
    const v1 = configuration(1),
      v2 = configuration(2);
    await insertStoreVersion(admin, v1);
    await publish(admin, v1, {
      sequence: 1,
      previous: null,
      savedAt: v1At,
      approvedAt: v1At,
      publishedAt: v1At,
    });
    await admin.query(
      "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-STORE-LIVE-GATE',$2,$3,$4,1,'Production','Approved',$5,$6,$5,$7,$8,$8,'ConfigurationMetadata')",
      [id(80), tenant, brand, store, id(11), id(10), id(14), v1At],
    );
    await admin.query(
      "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,1,'SYNTHETIC_TEST','SYNTHETIC_STORE_READY',$5,true,'Accepted',$6,1,$7,NULL,'ConfigurationMetadata')",
      [id(82), brand, store, id(80), id(11), id(83), validUntil],
    );
    await insertStoreVersion(admin, v2);
    await publish(admin, v2, {
      sequence: 2,
      previous: v1.publicationReference,
      savedAt: v2SavedAt,
      approvedAt: v2ApprovedAt,
      publishedAt: v2PublishedAt,
    });

    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_store,bop_publishing,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_store TO ${role}`);
    // SHARE locks need a write-capable privilege; nothing here writes.
    await admin.query(
      `GRANT UPDATE ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content,rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content,rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT,UPDATE ON bop_publishing.publishing_mutation_record,bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO ${role}`,
    );
    const transactions = {
      async run(work) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          return await work({ query: (sql, values) => admin.query(sql, [...values]) });
        } finally {
          await admin.query("ROLLBACK");
        }
      },
    };
    const operating = {
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
      timeZone: "America/Toronto",
      hashContent,
      authorize: async () => true, // Synthetic current permission; Store/Publishing facts are actual.
    };
    const proof = (create, configurationReference, at) =>
      transactions.run((tx) => create({ ...operating, configurationReference })(tx, at));
    const v1Day = "2026-09-20T16:00:00.000Z";

    // Current proof: only the newest release is current, so v1 is refused at any time.
    await assert.rejects(
      proof(createPostgresCurrentStorePublicationProof, v1.configurationReference, v1Day),
      /STORE_CURRENT_PUBLICATION_UNAVAILABLE/u,
    );
    await assert.rejects(
      proof(createPostgresCurrentStorePublicationProof, v1.configurationReference, now),
      /STORE_CURRENT_PUBLICATION_UNAVAILABLE/u,
    );
    const current = await proof(
      createPostgresCurrentStorePublicationProof,
      v2.configurationReference,
      now,
    );
    assert.equal(current.release.releaseId, v2.publicationReference);

    // As-published proof: v1 against the release that actually published it.
    const historical = await proof(
      createPostgresAsPublishedStorePublicationProof,
      v1.configurationReference,
      v1Day,
    );
    assert.equal(historical.release.releaseId, v1.publicationReference);
    assert.equal(historical.release.sequence, 1);
    assert.equal(historical.contentDigest, hashContent(v1));
    // v2 is not readable as published before its release existed (save→publish gap).
    await assert.rejects(
      proof(
        createPostgresAsPublishedStorePublicationProof,
        v2.configurationReference,
        v2ApprovedAt,
      ),
      /STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE/u,
    );
    assert.equal(
      (await proof(createPostgresAsPublishedStorePublicationProof, v2.configurationReference, now))
        .release.releaseId,
      v2.publicationReference,
    );

    // The pre-fix composition: business-date reads for a v1 instant fail on the current proof.
    const businessDateSource = (create) =>
      createPostgresStoreBusinessDateConfigurationSource({
        brandReference: brand,
        storeReference: store,
        timeZone: operating.timeZone,
        authorize: operating.authorize,
        publicationProof: async (tx, candidate, at) => {
          const value = await create({
            ...operating,
            configurationReference: candidate.configurationReference,
          })(tx, at);
          return {
            contentDigest: value.contentDigest,
            businessDayStartSource: value.businessDayStartSource,
          };
        },
      });
    await assert.rejects(
      transactions.run((tx) =>
        businessDateSource(createPostgresCurrentStorePublicationProof)(tx, v1Day),
      ),
      /STORE_BUSINESS_DATE_UNAVAILABLE/u,
    );

    // Save→publish gap: v2 governs only once it is effective AND published.
    const asPublishedDate = businessDateSource(createPostgresAsPublishedStorePublicationProof);
    const inGap = "2026-10-09T14:03:00.000Z",
      afterPublication = "2026-10-09T14:06:00.000Z";
    assert.equal(
      (await transactions.run((tx) => asPublishedDate(tx, inGap))).configurationReference,
      v1.configurationReference,
    );
    assert.equal(
      (await transactions.run((tx) => asPublishedDate(tx, afterPublication)))
        .configurationReference,
      v2.configurationReference,
    );
    const refundDate = createMerchantOrdinaryRefundBusinessDate(operating);
    const refundAt = (occurredAt) =>
      transactions.run((tx) =>
        refundDate(tx, {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
          occurredAt,
        }),
      );
    // Historical capture times for ordinary refunds: under v1, in the gap, after publication.
    assert.equal(await refundAt(v1Day), "2026-09-20");
    assert.equal(await refundAt(inGap), "2026-10-09");
    assert.equal(await refundAt(afterPublication), "2026-10-09");

    // Settlement window (actual pilot composition).
    let active = true;
    const window = createInternalClosedSettlementWindow({
      resources: {
        scope: { brandReference: brand, storeReference: store },
        operating,
        transactions,
        now: () => now,
      },
      active: async () => active,
    });
    // A day wholly under v1.
    const day = await window({ endingAt: "2026-09-21T08:00:00.000Z" });
    assert.equal(day.businessDate, "2026-09-20");
    assert.equal(day.startsAt, "2026-09-20T08:00:00.000Z");
    assert.equal(day.endsAt, "2026-09-21T08:00:00.000Z");
    assert.equal(day.configurationReference, v1.configurationReference);
    assert.equal(day.contentDigest, hashContent(v1));
    // 2026-10-09 began under v1; v2 (same time zone and day start) took effect mid-day,
    // through the save→publish gap. It settles with the closing version's identity.
    const switched = await window({ endingAt: "2026-10-10T08:00:00.000Z" });
    assert.equal(switched.businessDate, "2026-10-09");
    assert.equal(switched.startsAt, "2026-10-09T08:00:00.000Z");
    assert.equal(switched.endsAt, "2026-10-10T08:00:00.000Z");
    assert.equal(switched.configurationReference, v2.configurationReference);
    // The latest closed day (2026-10-10 local) is wholly under v2.
    const latest = await window();
    assert.equal(latest.businessDate, "2026-10-10");
    assert.equal(latest.configurationReference, v2.configurationReference);

    // Current operating status (customer entry/checkout gate) keeps the current release.
    const status = () =>
      transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        return createPostgresPublishedStoreOperatingStatusReader({
          ...operating,
          verifyPauseOperation: async () => false, // No pause history exists in this fixture.
        })(tx, now);
      });
    const currentStatus = await status();
    assert.equal(currentStatus.businessDate.configurationReference, v2.configurationReference);
    assert.equal(currentStatus.businessDate.contentDigest, hashContent(v2));

    // v3 moves the day start to 05:00 mid-day 2026-10-10: that day is refused, never merged.
    const v3 = configuration(3);
    await insertStoreVersion(admin, v3);
    await publish(admin, v3, {
      sequence: 3,
      previous: v2.publicationReference,
      savedAt: v3SavedAt,
      approvedAt: v3SavedAt,
      publishedAt: v3PublishedAt,
    });
    await assert.rejects(window(), {
      code: "STORE_BUSINESS_DATE_CONFIGURATION_NOT_EFFECTIVE",
    });
    // Earlier days keep resolving identically.
    assert.deepEqual(await window({ endingAt: "2026-10-10T08:00:00.000Z" }), switched);
    assert.deepEqual(await window({ endingAt: "2026-09-21T08:00:00.000Z" }), day);
    assert.equal((await status()).businessDate.configurationReference, v3.configurationReference);
    active = false;
    await assert.rejects(
      window({ endingAt: "2026-09-21T08:00:00.000Z" }),
      /SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE/u,
    );
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("verifies a superseded Store configuration as published for historical settlement while current reads use the newest release", async () => {
  await withIsolatedDatabase({ caseId: "store_historical_pub", root }, prove);
}, 120_000);
