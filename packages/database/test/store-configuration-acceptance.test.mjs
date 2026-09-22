import { createPersistentEntryOperatingReader } from "../../../apps/api/src/persistent-entry-operating.ts";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../rms/store/src/index.ts";
import { createMerchantOrdinaryRefundBusinessDate } from "../../../apps/api/src/merchant-ordinary-refund-business-date.ts";
import { verifyStoreAuthoringRepository } from "../test-support/store-authoring-repository.mjs";
import { verifyStoreAuthoringHistory } from "../test-support/store-authoring-history.mjs";
import { verifyStoreServiceControl } from "../test-support/store-service-control.mjs";
import { seedStorePublication } from "../test-support/store-publication-seed.mjs";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStorePublicationAuthorization,
} from "../../rms/store/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPostgresStorePublicationContentSource } from "../../rms/store/src/index.ts";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { createPostgresStoreOperatingStatusReader } from "../../rms/store/src/index.ts";
import { createPostgresStorePauseHistorySource } from "../../rms/store/src/index.ts";
import { createPostgresStoreWeeklyScheduleSource } from "../../rms/store/src/index.ts";
import { createPostgresStoreExceptionContentSource } from "../../rms/store/src/index.ts";
import {
  createPostgresStoreBusinessDateSource,
  createPostgresStoreBusinessDateConfigurationSource,
} from "../../rms/store/src/index.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f30-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z",
  digest = `sha256:${"a".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2192_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto','04:00:00',$5,$6,$7,$8,$9,NULL,ARRAY['DineIn','Pickup'],$10,NULL,NULL,'PILOT_CONFIGURATION',$11,$12,$13,$14,$15,$10,$10,'ConfigurationMetadata')`,
      [
        id(1),
        id(2),
        id(3),
        id(4),
        id(5),
        id(6),
        id(7),
        id(8),
        id(9),
        at,
        id(10),
        id(11),
        id(12),
        id(13),
        id(14),
      ],
    );
    await admin.query(
      `INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,1,1,'09:00:00','22:00:00',false,ARRAY['DineIn','Pickup'],900,1200,'ConfigurationMetadata')`,
      [id(20), id(2), id(3), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_store.store_service_exception VALUES($1,$2,$3,$4,'2026-12-25','Holiday',$5,'ConfigurationMetadata')`,
      [id(21), id(2), id(3), id(1), digest],
    );
    await admin.query(
      `INSERT INTO rms_store.store_configuration_operation VALUES($1,$2,$3,$4,'Publish',$5,0,1,$6,'STORE.CONFIGURATION',$7,$8,'ConfigurationMetadata')`,
      [id(22), id(2), id(3), id(1), digest, id(11), id(23), at],
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception_content VALUES ($1,$2,$3,1,'ConfigurationMetadata')",
      [id(2), id(3), id(21)],
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception_interval VALUES ($1,$2,$3,$4,1,'09:00:00','12:00:00',false,ARRAY['Pickup'],900,1200,'ConfigurationMetadata')",
      [id(25), id(2), id(3), id(21)],
    );
    await assert.rejects(
      admin.query(
        "UPDATE rms_store.store_service_exception_interval SET end_local_time='13:00:00'",
      ),
      /append-only/u,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_store.store_service_exception_content")).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_store.store_service_exception_content VALUES ($1,$2,$3,0,'ConfigurationMetadata')",
        [id(2), id(30), id(21)],
      ),
      { code: "23503" },
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception VALUES ($1,$2,$3,$4,'2026-12-26','TemporaryClosure',$5,'ConfigurationMetadata')",
      [id(26), id(2), id(3), id(1), digest],
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception_content VALUES ($1,$2,$3,0,'ConfigurationMetadata')",
      [id(2), id(3), id(26)],
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_store.store_configuration_version SET reason_code='CHANGED' WHERE configuration_id=$1`,
        [id(1)],
      ),
      /append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_store.store_service_exception VALUES($1,$2,$3,$4,'2026-12-25','Override',$5,'ConfigurationMetadata')`,
        [id(24), id(2), id(3), id(1), digest],
      ),
      /store_service_exception_date_unique/u,
    );
    for (const [reference, kind] of [
      [50, "PauseService"],
      [51, "ResumeService"],
    ]) {
      await admin.query(
        "INSERT INTO rms_store.store_configuration_operation VALUES ($1,$2,$3,$4,$5,$6,1,2,$7,'STORE.CONFIGURATION',$8,$9,'ConfigurationMetadata')",
        [id(reference), id(2), id(3), id(1), kind, digest, id(11), id(reference + 100), at],
      );
    }
    await admin.query(
      "INSERT INTO rms_store.store_service_pause_content VALUES ($1,$2,$3,'PauseService',$4,$5,ARRAY['Pickup'],'ConfigurationMetadata')",
      [id(2), id(3), id(50), at, "2026-08-15T16:00:00.000Z"],
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_resume_content VALUES ($1,$2,$3,'ResumeService',$4,$5,'ConfigurationMetadata')",
      [id(2), id(3), id(51), id(50), "2026-08-15T15:00:00.000Z"],
    );
    for (const [store, operation] of [
      [3, 22],
      [30, 50],
    ]) {
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_store.store_service_pause_content VALUES ($1,$2,$3,'PauseService',$4,$5,NULL,'ConfigurationMetadata')",
          [id(2), id(store), id(operation), at, "2026-08-15T16:00:00.000Z"],
        ),
        { code: "23503" },
      );
    }
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_store.store_service_resume_content VALUES ($1,$2,$3,'ResumeService',$4,$5,'ConfigurationMetadata')",
        [id(2), id(3), id(50), id(50), "2026-08-15T15:00:00.000Z"],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      admin.query("UPDATE rms_store.store_service_pause_content SET effective_until=$1", [
        "2026-08-15T18:00:00.000Z",
      ]),
      /append-only/u,
    );
    await assert.rejects(
      admin.query("UPDATE rms_store.store_service_resume_content SET effective_at=$1", [
        "2026-08-15T14:30:00.000Z",
      ]),
      /append-only/u,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_store.store_service_pause_content")).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_store.store_service_resume_content")).rowCount,
      0,
    );
    const publicationContent = createStoreConfigurationVersion({
      configurationReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      configurationVersion: 1,
      lifecycle: "Published",
      source: "StoreOverride",
      brandBaseVersionReference: id(4),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
      addressReference: id(5),
      contactReference: id(6),
      receiptReference: id(7),
      taxConfigurationReference: id(8),
      paymentConfigurationReference: id(9),
      capacityConfigurationReference: null,
      enabledServiceModes: ["DineIn", "Pickup"],
      weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals:
          index === 0
            ? [
                {
                  startLocalTime: "09:00:00",
                  endLocalTime: "22:00:00",
                  endsNextDay: false,
                  serviceModes: ["DineIn", "Pickup"],
                  orderCutoffSeconds: 900,
                  leadTimeSeconds: 1200,
                },
              ]
            : [],
      })),
      exceptions: [
        {
          localDate: "2026-12-25",
          kind: "Holiday",
          intervals: [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "12:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 900,
              leadTimeSeconds: 1200,
            },
          ],
        },
        { localDate: "2026-12-26", kind: "TemporaryClosure", intervals: [] },
      ],
      effectiveFrom: at,
      effectiveUntil: null,
      supersedesConfigurationReference: null,
      reasonCode: "PILOT_CONFIGURATION",
      authoredByReference: id(10),
      approvedByReference: id(11),
      approvalEvidenceReference: id(12),
      publicationReference: id(13),
      liveGateEvidenceReference: id(14),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    });
    const publicationDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(publicationContent));
    await admin.query(
      "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
      [id(2), id(3), id(1), id(70), publicationDigest, publicationContent, at],
    );
    await assert.rejects(
      admin.query(
        "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
        [id(2), id(30), id(1), id(70), publicationDigest, publicationContent, at],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      admin.query(
        "UPDATE rms_store.store_configuration_publication_content SET purpose_code='CHANGED'",
      ),
      /append-only/u,
    );
    assert.equal(
      (await admin.query("DELETE FROM rms_store.store_configuration_publication_content")).rowCount,
      0,
    );
    await seedStorePublication(admin, id, publicationContent, publicationDigest);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_store,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_store TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(2), id(3)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_weekly_service_period`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_service_exception_interval")).rowCount,
      1,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT interval_count FROM rms_store.store_service_exception_content ORDER BY exception_id",
        )
      ).rows.map((row) => row.interval_count),
      [1, 0],
    );
    const pauseRow = (
      await admin.query(
        "SELECT effective_from,effective_until,service_modes FROM rms_store.store_service_pause_content",
      )
    ).rows[0];
    assert.equal(pauseRow.effective_from.toISOString(), at);
    assert.equal(pauseRow.effective_until.toISOString(), "2026-08-15T16:00:00.000Z");
    assert.deepEqual(pauseRow.service_modes, ["Pickup"]);
    const resumeRow = (
      await admin.query(
        "SELECT pause_operation_id,effective_at FROM rms_store.store_service_resume_content",
      )
    ).rows[0];
    assert.equal(resumeRow.pause_operation_id, id(50));
    assert.equal(resumeRow.effective_at.toISOString(), "2026-08-15T15:00:00.000Z");
    const publishedContentRow = (
      await admin.query(
        "SELECT configuration_json,publishing_family_reference,business_day_start_source FROM rms_store.store_configuration_publication_content",
      )
    ).rows[0];
    assert.deepEqual(publishedContentRow.configuration_json, publicationContent);
    assert.equal(publishedContentRow.publishing_family_reference, id(70));
    assert.equal(publishedContentRow.business_day_start_source, "StoreOverride");
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(30)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_configuration_publication_content"))
        .rowCount,
      0,
    );

    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_service_pause_content")).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_service_resume_content")).rowCount,
      0,
    );

    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_service_exception_interval")).rowCount,
      0,
    );
    assert.equal(
      (await admin.query("SELECT * FROM rms_store.store_service_exception_content")).rowCount,
      0,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_operation`)).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
    await admin.query(
      "GRANT UPDATE ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version TO " +
        role,
    );
    let allowed = true,
      hasProof = true;
    const sourceOptions = {
      brandReference: id(2),
      storeReference: id(3),
      timeZone: "America/Toronto",
      authorize: async () => allowed,
      publicationProof: async (_tx, candidate) => {
        assert.equal(candidate.configurationReference, id(1));
        assert.equal(candidate.publicationReference, id(13));
        return hasProof ? { contentDigest: digest, businessDayStartSource: "StoreOverride" } : null;
      },
    };
    const readDate = createPostgresStoreBusinessDateSource(sourceOptions);
    const readConfiguration = createPostgresStoreBusinessDateConfigurationSource(sourceOptions);
    async function readAt(instant, read = readDate) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        return await read({ query: (sql, values) => admin.query(sql, [...values]) }, instant);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await admin.query(
      "GRANT UPDATE ON rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE ON rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE ON rms_store.store_configuration_publication_content TO " + role,
    );
    let contentReadAllowed = true,
      contentHashValid = true;
    const publicationOptions = {
      brandReference: id(2),
      storeReference: id(3),
      configurationReference: id(1),
      authorize: async () => contentReadAllowed,
      hashContent: (value) =>
        contentHashValid ? "sha256:" + sha256Hex(canonicalizeRfc8785(value)) : digest,
    };
    await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
    await admin.query(
      "GRANT SELECT,UPDATE ON bop_publishing.publishing_mutation_record,bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO " +
        role,
    );
    const currentPublicationOptions = {
      ...publicationOptions,
      tenantReference: id(90),
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    };
    const authorizeCandidate = createPostgresStorePublicationAuthorization({
      ...currentPublicationOptions,
      publishingFamilyReference: id(70),
    });
    const candidateAuthority = await readAt("2026-08-16T08:00:00.000Z", (tx, now) =>
      authorizeCandidate(
        {
          query: (sql, values) => {
            assert.equal(
              sql.includes("rms_store."),
              false,
              "Pre-insert authorization must not read Store snapshots",
            );
            return tx.query(sql, values);
          },
        },
        publicationContent,
        now,
      ),
    );
    assert.equal(candidateAuthority.release.releaseId, id(13));
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", (tx, now) =>
        authorizeCandidate(
          tx,
          createStoreConfigurationVersion({
            ...publicationContent,
            businessDayStartLocalTime: "05:00:00",
          }),
          now,
        ),
      ),
      /STORE_CURRENT_PUBLICATION_UNAVAILABLE/u,
    );
    const readCurrentPublication =
      createPostgresCurrentStorePublicationProof(currentPublicationOptions);
    const currentPublication = await readAt("2026-08-16T08:00:00.000Z", readCurrentPublication);
    assert.equal(currentPublication.release.releaseId, id(13));
    assert.equal(currentPublication.contentDigest, publicationDigest);
    const publishedOperatingOptions = {
      ...currentPublicationOptions,
      timeZone: "America/Toronto",
      hashContent: (value) =>
        Array.isArray(value) ? digest : "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
      verifyPauseOperation: async (_tx, operation) => operation.intentDigest === digest, // Existing synthetic pause/resume history.
    };
    const publishedOperating =
      createPostgresPublishedStoreOperatingStatusReader(publishedOperatingOptions);
    await admin.query(
      "INSERT INTO bop_tenant.brand VALUES($1,'ENTRY_OPERATING','Demonstration','en-CA','CAD','Active',1,$2,$2)",
      [id(2), at],
    );
    await admin.query(
      "INSERT INTO bop_tenant.store VALUES($1,$2,'ENTRY_OPERATING','Demonstration','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
      [id(3), id(2), at],
    );
    await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
    await admin.query("GRANT SELECT ON bop_tenant.brand,bop_tenant.store TO " + role);
    await admin.query("GRANT UPDATE(lifecycle) ON bop_tenant.brand,bop_tenant.store TO " + role);
    await readAt("2026-08-16T08:00:00.000Z", async (tx, now) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(2), id(3)],
      );
      const result = await publishedOperating(tx, now);
      assert.equal(result.state, "Closed");
      assert.equal(result.businessDate.contentDigest, publicationDigest);
      const entryOperating = createPersistentEntryOperatingReader({
        transaction: tx,
        publicStore: {
          binding: {
            tenantReference: id(90),
            brandReference: id(2),
            storeReference: id(3),
            publicStoreReference: id(91),
            lookupEvidenceReference: id(92),
            validFrom: at,
            validUntil: "2026-09-01T00:00:00.000Z",
          },
          authorize: async () => true, // Synthetic public binding authorization only.
        },
        operating: publishedOperatingOptions,
      });
      const query = {
        brandReference: id(2),
        storeReference: id(3),
        publicStoreReference: id(91),
        evaluatedAt: now,
      };
      const entryStatus = await entryOperating.readCurrent(query);
      assert.equal(entryStatus.state, "Closed");
      assert.equal(entryStatus.evaluatedAt, now);
      assert.equal(Object.hasOwn(entryStatus, "releaseReference"), false);
      assert.equal(
        await entryOperating.readCurrent({ ...query, publicStoreReference: id(93) }),
        null,
      );
      assert.equal(await entryOperating.readCurrent({ ...query, storeReference: id(94) }), null);
      contentReadAllowed = false;
      assert.equal(await entryOperating.readCurrent(query), null);
      await assert.rejects(publishedOperating(tx, now), /STORE_OPERATING_STATUS_UNAVAILABLE/);
      contentReadAllowed = true;
    });

    const refundDateOptions = { ...currentPublicationOptions, timeZone: "America/Toronto" };
    const refundDateQuery = {
      tenantReference: id(90),
      brandReference: id(2),
      storeReference: id(3),
      occurredAt: "2026-08-16T08:00:00.000Z",
    };
    const refundDate = (extra = {}) =>
      createMerchantOrdinaryRefundBusinessDate({ ...refundDateOptions, ...extra });
    assert.equal(
      await readAt(refundDateQuery.occurredAt, (tx) => refundDate()(tx, refundDateQuery)),
      "2026-08-16",
    );
    for (const patch of [
      { tenantReference: id(99) },
      { brandReference: id(99) },
      { storeReference: id(99) },
      { timeZone: "UTC" },
      { occurredAt: "invalid" },
    ])
      await assert.rejects(
        readAt(refundDateQuery.occurredAt, (tx) =>
          refundDate()(tx, { ...refundDateQuery, ...patch }),
        ),
      );
    await assert.rejects(
      readAt(refundDateQuery.occurredAt, (tx) =>
        refundDate({ authorize: async () => false })(tx, refundDateQuery),
      ),
    );
    await assert.rejects(
      readAt(refundDateQuery.occurredAt, (tx) =>
        refundDate({
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY", "MISSING_REQUIREMENT"],
        })(tx, refundDateQuery),
      ),
    );

    await assert.rejects(
      readAt(
        "2026-08-16T08:00:00.000Z",
        createPostgresCurrentStorePublicationProof({
          ...currentPublicationOptions,
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY", "MISSING_REQUIREMENT"],
        }),
      ),
      /STORE_CURRENT_PUBLICATION_UNAVAILABLE/u,
    );

    await assert.rejects(
      readAt(
        "2026-08-16T08:00:00.000Z",
        createPostgresCurrentStorePublicationProof({
          ...currentPublicationOptions,
          purposeCode: "OTHER",
        }),
      ),
      /STORE_CURRENT_PUBLICATION_UNAVAILABLE/u,
    );
    const readPublication = createPostgresStorePublicationContentSource(publicationOptions);
    const contentBinding = await readAt("2026-08-16T08:00:00.000Z", readPublication);
    assert.deepEqual(contentBinding.configuration, publicationContent);
    assert.equal(contentBinding.contentDigest, publicationDigest);
    assert.equal(contentBinding.familyReference, id(70));
    contentHashValid = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readPublication),
      /STORE_PUBLICATION_CONTENT_UNAVAILABLE/u,
    );
    contentHashValid = true;
    contentReadAllowed = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readPublication),
      /STORE_PUBLICATION_CONTENT_UNAVAILABLE/u,
    );
    contentReadAllowed = true;
    await assert.rejects(
      readAt("2026-08-14T08:00:00.000Z", readPublication),
      /STORE_PUBLICATION_CONTENT_UNAVAILABLE/u,
    );
    await assert.rejects(
      readAt(
        "2026-08-16T08:00:00.000Z",
        createPostgresStorePublicationContentSource({
          ...publicationOptions,
          storeReference: id(30),
        }),
      ),
      /STORE_PUBLICATION_CONTENT_UNAVAILABLE/u,
    );
    await verifyStoreAuthoringHistory({ admin, role, id, configuration: publicationContent });
    await verifyStoreServiceControl({
      admin,
      role,
      id,
      currentConfiguration: async (tx, _reference, at) =>
        (await readCurrentPublication(tx, at)).configuration,
    });
    await verifyStoreAuthoringRepository({ admin, role, id, configuration: publicationContent });
    let fullOperatingProof = true;
    const readOperating = createPostgresStoreOperatingStatusReader({
      ...sourceOptions,
      verifyWeeklyContent: async () => true,
      verifyExceptionContent: async (_tx, input) => input.summaryDigest === digest,
      verifyPauseOperation: async (_tx, input) => input.intentDigest === digest,
      verifyOperatingContent: async (_tx, input) => {
        assert.equal(input.businessDate.configurationReference, id(1));
        assert.equal(input.weeklySchedule.length, 7);
        return fullOperatingProof;
      },
    });
    await admin.query("BEGIN");
    try {
      await admin.query(
        "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,6,1,'09:00:00','17:00:00',false,ARRAY['Pickup'],900,1200,'ConfigurationMetadata')",
        [id(60), id(2), id(3), id(1)],
      );
      await admin.query("SET LOCAL ROLE " + role);
      const tx = { query: (sql, values) => admin.query(sql, [...values]) };
      await assert.rejects(
        publishedOperating(tx, "2026-08-16T08:00:00.000Z"),
        /STORE_OPERATING_STATUS_UNAVAILABLE/,
      );
      const paused = await readOperating(tx, "2026-08-15T14:30:00.000Z");
      assert.equal(paused.state, "TemporarilyClosed");
      assert.equal(paused.businessDate.businessDate, "2026-08-15");
      assert.equal(paused.localTime, "10:30:00");
      assert.deepEqual(paused.availableServiceModes, []);
      const resumed = await readOperating(tx, "2026-08-15T15:00:00.000Z");
      assert.equal(resumed.state, "Open");
      assert.deepEqual(resumed.availableServiceModes, ["Pickup"]);
      assert.equal((await readOperating(tx, "2026-08-15T21:00:00.000Z")).state, "Closed");
      fullOperatingProof = false;
      await assert.rejects(
        readOperating(tx, "2026-08-15T15:00:00.000Z"),
        /STORE_OPERATING_STATUS_UNAVAILABLE/u,
      );
    } finally {
      await admin.query("ROLLBACK");
    }
    let pauseProof = true,
      revokePause = false,
      pauseAuthorizationCalls = 0;
    const readPauses = createPostgresStorePauseHistorySource({
      brandReference: id(2),
      storeReference: id(3),
      authorize: async () => !revokePause || ++pauseAuthorizationCalls === 1,
      verifyOperation: async (_tx, operation) => {
        assert.equal(operation.brandReference, id(2));
        assert.equal(operation.storeReference, id(3));
        assert.equal(operation.intentDigest, digest);
        return pauseProof;
      },
    });
    const activePauses = await readAt("2026-08-15T14:30:00.000Z", readPauses);
    assert.deepEqual(activePauses, [
      {
        closureReference: id(50),
        effectiveFrom: at,
        effectiveUntil: "2026-08-15T15:00:00.000Z",
        serviceModes: ["Pickup"],
      },
    ]);
    assert.equal((await readAt(at, readPauses)).length, 1);
    assert.deepEqual(await readAt("2026-08-15T15:00:00.000Z", readPauses), []);
    pauseProof = false;
    await assert.rejects(
      readAt("2026-08-15T14:30:00.000Z", readPauses),
      /STORE_PAUSE_HISTORY_UNAVAILABLE/u,
    );
    pauseProof = true;
    revokePause = true;
    await assert.rejects(
      readAt("2026-08-15T14:30:00.000Z", readPauses),
      /STORE_PAUSE_HISTORY_UNAVAILABLE/u,
    );
    revokePause = false;
    await admin.query(
      "INSERT INTO rms_store.store_configuration_operation VALUES ($1,$2,$3,$4,'PauseService',$5,2,3,$6,'STORE.CONFIGURATION',$7,$8,'ConfigurationMetadata')",
      [id(52), id(2), id(3), id(1), digest, id(11), id(152), "2026-08-15T17:00:00.000Z"],
    );
    // Later operations do not corrupt an earlier observation.
    assert.equal((await readAt("2026-08-15T14:30:00.000Z", readPauses)).length, 1);
    // Once observed, missing content cannot be interpreted as resumed or empty.
    await assert.rejects(
      readAt("2026-08-15T17:00:00.000Z", readPauses),
      /STORE_PAUSE_HISTORY_UNAVAILABLE/u,
    );
    assert.equal((await readAt("2026-08-16T07:59:59.000Z")).businessDate, "2026-08-15");
    assert.equal((await readAt("2026-08-16T08:00:00.000Z")).businessDate, "2026-08-16");
    const resolvedConfiguration = await readAt("2026-08-16T08:00:00.000Z", readConfiguration);
    assert.equal(resolvedConfiguration.configurationReference, id(1));
    assert.equal(resolvedConfiguration.contentDigest, digest);
    assert.equal(resolvedConfiguration.timeZone, "America/Toronto");
    assert.ok(resolvedConfiguration.effectiveFrom <= "2026-08-16T08:00:00.000Z");
    assert.ok(Object.hasOwn(resolvedConfiguration, "effectiveUntil"));
    allowed = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readConfiguration),
      /STORE_BUSINESS_DATE_UNAVAILABLE/u,
    );
    await assert.rejects(readAt("2026-08-16T08:00:00.000Z"), /STORE_BUSINESS_DATE_UNAVAILABLE/u);
    allowed = true;
    hasProof = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readConfiguration),
      /STORE_BUSINESS_DATE_UNAVAILABLE/u,
    );
    await assert.rejects(readAt("2026-08-16T08:00:00.000Z"), /STORE_BUSINESS_DATE_UNAVAILABLE/u);
    hasProof = true;
    await assert.rejects(readAt("2026-08-14T08:00:00.000Z"), /STORE_BUSINESS_DATE_UNAVAILABLE/u);
    await assert.rejects(
      readAt(
        "2026-08-16T08:00:00.000Z",
        createPostgresStoreBusinessDateSource({ ...sourceOptions, storeReference: id(30) }),
      ),
      /STORE_BUSINESS_DATE_UNAVAILABLE/u,
    );
    await admin.query(
      "GRANT UPDATE ON rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval TO " +
        role,
    );
    await admin.query("GRANT UPDATE ON rms_store.store_weekly_service_period TO " + role);
    let weeklyProof = true;
    let weeklyAuthorizationCalls = 0;
    let revokeWeekly = false;
    const expectedWeek = Array.from({ length: 7 }, (_, index) => ({
      isoWeekday: index + 1,
      intervals:
        index === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "22:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 900,
                leadTimeSeconds: 1200,
              },
            ]
          : [],
    }));
    const weeklyOptions = {
      brandReference: id(2),
      storeReference: id(3),
      configurationReference: id(1),
      authorize: async () => !revokeWeekly || ++weeklyAuthorizationCalls === 1,
      verifyContent: async (_tx, input) => {
        assert.equal(input.configurationReference, id(1));
        assert.equal(input.brandReference, id(2));
        assert.equal(input.storeReference, id(3));
        assert.deepEqual(input.weeklySchedule, expectedWeek);
        return weeklyProof;
      },
    };
    const readWeek = createPostgresStoreWeeklyScheduleSource(weeklyOptions);
    assert.deepEqual(await readAt("2026-08-16T08:00:00.000Z", readWeek), expectedWeek);
    weeklyProof = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readWeek),
      /STORE_WEEKLY_SCHEDULE_UNAVAILABLE/u,
    );
    weeklyProof = true;
    revokeWeekly = true;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readWeek),
      /STORE_WEEKLY_SCHEDULE_UNAVAILABLE/u,
    );
    revokeWeekly = false;
    await assert.rejects(
      readAt(
        "2026-08-16T08:00:00.000Z",
        createPostgresStoreWeeklyScheduleSource({ ...weeklyOptions, storeReference: id(30) }),
      ),
      /STORE_WEEKLY_SCHEDULE_UNAVAILABLE/u,
    );
    await admin.query(
      "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,2,2,'09:00:00','12:00:00',false,ARRAY['Pickup'],900,1200,'ConfigurationMetadata')",
      [id(40), id(2), id(3), id(1)],
    );
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readWeek),
      /STORE_WEEKLY_SCHEDULE_UNAVAILABLE/u,
    );
    let contentProof = true,
      authorizationCalls = 0,
      revokeDuringRead = false;
    const exceptionOptions = {
      brandReference: id(2),
      storeReference: id(3),
      configurationReference: id(1),
      authorize: async () => {
        authorizationCalls++;
        return !revokeDuringRead || authorizationCalls === 1;
      },
      verifyContent: async (_tx, input) => contentProof && input.summaryDigest === digest,
    };
    const readExceptions = createPostgresStoreExceptionContentSource(exceptionOptions);
    const content = await readAt("2026-08-16T08:00:00.000Z", readExceptions);
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], {
      localDate: "2026-12-25",
      kind: "Holiday",
      intervals: [
        {
          startLocalTime: "09:00:00",
          endLocalTime: "12:00:00",
          endsNextDay: false,
          serviceModes: ["Pickup"],
          orderCutoffSeconds: 900,
          leadTimeSeconds: 1200,
        },
      ],
    });
    assert.equal(content[1].intervals.length, 0);
    contentProof = false;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readExceptions),
      /STORE_EXCEPTION_CONTENT_UNAVAILABLE/u,
    );
    contentProof = true;
    revokeDuringRead = true;
    authorizationCalls = 0;
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readExceptions),
      /STORE_EXCEPTION_CONTENT_UNAVAILABLE/u,
    );
    revokeDuringRead = false;
    await admin.query(
      "INSERT INTO rms_store.store_service_exception VALUES ($1,$2,$3,$4,'2026-12-27','Override',$5,'ConfigurationMetadata')",
      [id(31), id(2), id(3), id(1), digest],
    );
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readExceptions),
      /STORE_EXCEPTION_CONTENT_UNAVAILABLE/u,
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception_content VALUES ($1,$2,$3,1,'ConfigurationMetadata')",
      [id(2), id(3), id(31)],
    );
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readExceptions),
      /STORE_EXCEPTION_CONTENT_UNAVAILABLE/u,
    );
    await admin.query(
      "INSERT INTO rms_store.store_service_exception_interval VALUES ($1,$2,$3,$4,2,'09:00:00','12:00:00',false,ARRAY['Pickup'],900,1200,'ConfigurationMetadata')",
      [id(32), id(2), id(3), id(31)],
    );
    await assert.rejects(
      readAt("2026-08-16T08:00:00.000Z", readExceptions),
      /STORE_EXCEPTION_CONTENT_UNAVAILABLE/u,
    );
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces append-only Store configuration, unique exceptions and forced Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "store_configuration", root }, prove);
}, 120_000);
