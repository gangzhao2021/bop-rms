import { prepareCurrentEntryProfile } from "../test-support/current-entry-profile.mjs";
import { exercisePersistentProfileEntry } from "../test-support/persistent-profile-entry.mjs";
import { createPersistentPublicStoreProfileReader } from "../../../apps/api/src/persistent-public-store-profile.ts";
import { createPostgresPublicStoreProfileTimingStore } from "../../rms/store/src/index.ts";
import { preparePublicStoreProfilePublication } from "../test-support/public-store-profile-publication.mjs";
import {
  createPostgresPublicStoreProfileAuthority,
  publicStoreProfileContent,
} from "../../rms/store/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPostgresPublicStoreProfileStore } from "../../rms/store/src/index.ts";
import { candidate, ids } from "../../rms/store/src/tests/public-store-profile.fixture.ts";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { verifyMerchantAuthorizationRead } from "../test-support/merchant-authorization-read.mjs";
import * as permissionFixture from "../../bop/permission/src/tests/current-policy.fixture.ts";
it("persists immutable scoped public profiles without treating saved evidence as current authority", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_profile" }, async (env) => {
    const client = new pg.Client(env.clientConfig);
    await client.connect();
    const role = "profile_" + env.runId;
    try {
      await client.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await client.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await client.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);

      await client.query(
        "GRANT USAGE ON SCHEMA rms_store,platform_helpers,platform_audit TO " + role,
      );
      await client.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_store.public_store_profile_version TO " + role,
      );
      await client.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_record,platform_audit.audit_chain_head TO " +
          role,
      );
      // Independent reads may run concurrently; never share transaction context.
      const run = async (work) => {
        const connection = new pg.Client({
          ...env.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await connection.connect();
        try {
          await connection.query("BEGIN");
          await connection.query("SET LOCAL ROLE " + role);
          await connection.query("SET LOCAL statement_timeout='5s'");
          await connection.query("SET LOCAL lock_timeout='5s'");
          const result = await work({ query: (sql, values) => connection.query(sql, [...values]) });
          await connection.query("COMMIT");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          await connection.end();
        }
      };
      let allowed = true,
        current = true,
        failAudit = false;
      const profile = candidate();
      profile.logo = null;
      profile.timeZone = "America/Toronto";
      profile.effectiveVersion.period.timeZone = "America/Toronto";
      profile.effectiveVersion.period.effectiveFrom.localDateTime = "2025-12-31T19:00:00.000";
      profile.effectiveVersion.period.effectiveFrom.utcOffsetMinutes = -300;
      profile.effectiveVersion.period.effectiveUntil.localDateTime = "2026-01-31T19:00:00.000";
      profile.effectiveVersion.period.effectiveUntil.utcOffsetMinutes = -300;
      const at = "2026-01-15T12:00:00.000Z";
      const audit = "01909980-0000-7000-8000-000000000001";
      const options = {
        brandReference: ids.brand,
        storeReference: ids.store,
        authorize: async () => allowed,
        verifyCurrent: async () => current, // Explicit synthetic publication authority; not a real release acceptance.
        hashSnapshot: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
        appendAudit: async (tx, input) => {
          if (failAudit) throw new Error("synthetic audit failure");
          await appendAuditRecordInTransaction(tx, {
            auditId: input.auditReference,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "System" },
            actionCode: "STORE_PUBLIC_PROFILE_RECORDED",
            targetType: "StoreProfile",
            targetId: input.profile.profileReference,
            reasonCode: "SYNTHETIC_PROFILE_TEST",
            correlationId: input.auditReference,
            occurredAt: input.recordedAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
        },
      };
      const store = createPostgresPublicStoreProfileStore(options);
      const input = {
        profile,
        actorReference: ids.approval,
        auditReference: audit,
        recordedAt: at,
      };
      assert.equal(await run((tx) => store.append(tx, input)), "Created");
      assert.equal(await run((tx) => store.append(tx, input)), "Existing");
      assert.deepEqual(await run((tx) => store.loadExact(tx, ids.profile, 1, at)), profile);
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows[0]
          .n,
        1,
      );
      await assert.rejects(
        run((tx) =>
          store.append(tx, {
            ...input,
            profile: { ...profile, website: "https://changed.example" },
          }),
        ),
      );
      current = false;
      await assert.rejects(run((tx) => store.loadExact(tx, ids.profile, 1, at)));
      await assert.rejects(run((tx) => store.append(tx, input)));
      current = true;
      allowed = false;
      await assert.rejects(run((tx) => store.loadExact(tx, ids.profile, 1, at)));
      allowed = true;
      failAudit = true;
      await assert.rejects(
        run((tx) =>
          store.append(tx, {
            ...input,
            profile: { ...profile, profileVersion: 2 },
            auditReference: ids.lookup,
          }),
        ),
        /synthetic audit failure/,
      );
      failAudit = false;
      assert.equal(await run((tx) => store.loadExact(tx, ids.profile, 2, at)), null);
      const other = createPostgresPublicStoreProfileStore({
        ...options,
        storeReference: ids.lookup,
      });
      assert.equal(await run((tx) => other.loadExact(tx, ids.profile, 1, at)), null);
      await assert.rejects(
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [ids.brand, ids.store],
          );
          await tx.query("UPDATE rms_store.public_store_profile_version SET profile_version=2", []);
        }),
        /append-only/,
      );
      await run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [ids.brand, ids.store],
        );
        assert.equal(
          (await tx.query("DELETE FROM rms_store.public_store_profile_version", [])).rowCount,
          0,
        );
      });

      const publishedProfile = { ...profile, profileVersion: 2 };
      const hashContent = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
      publishedProfile.contentDigest = hashContent(publicStoreProfileContent(publishedProfile));
      const publication = await preparePublicStoreProfilePublication({
        admin: client,
        role,
        scope: { brandReference: ids.brand, storeReference: ids.store },
        version: {
          publishedAt: at,
          versionReference: ids.profile,
          publicationReference: ids.release,
        },
        digest: publishedProfile.contentDigest,
      });
      publishedProfile.publishingLifecycle = publication.lifecycle;
      publishedProfile.publishingRelease = publication.release;
      publishedProfile.effectiveVersion = {
        ...publishedProfile.effectiveVersion,
        snapshotDigest: publishedProfile.contentDigest,
        releaseReference: publication.release.releaseId,
      };
      publishedProfile.effectiveVersion.periodDigest = hashContent(
        publishedProfile.effectiveVersion.period,
      );
      await client.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_store.public_store_profile_timing TO " + role,
      );
      let timingApprovalAllowed = true,
        timingAuditFailure = false;
      const timingStore = createPostgresPublicStoreProfileTimingStore({
        brandReference: ids.brand,
        storeReference: ids.store,
        authorize: async () => allowed,
        authorizeApproval: async () => timingApprovalAllowed, // Explicit synthetic approver permission.
        hashPeriod: hashContent,
        appendAudit: async (tx, record) => {
          if (timingAuditFailure) throw new Error("synthetic timing audit failure");
          await appendAuditRecordInTransaction(tx, {
            auditId: record.auditReference,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "System" },
            actionCode: "STORE_PROFILE_TIMING_RECORDED",
            targetType: "StoreProfileTiming",
            targetId: record.timing.timingVersionReference,
            reasonCode: "SYNTHETIC_PROFILE_TEST",
            correlationId: record.auditReference,
            occurredAt: record.recordedAt,
            sourceChannel: "SYSTEM",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          });
        },
      });
      const timing = publishedProfile.effectiveVersion;
      const timingApproval = {
        evidenceReference: timing.approvalEvidenceReference,
        familyReference: timing.familyReference,
        timingVersionReference: timing.timingVersionReference,
        version: timing.version,
        scope: timing.scope,
        periodDigest: timing.periodDigest,
        decision: "Accepted",
        approvedActorReference: ids.approval,
        approvedAt: timing.createdAt,
        validUntil: "2026-02-01T00:00:00.000Z",
      };
      const timingInput = {
        timing,
        approval: timingApproval,
        auditReference: "01909980-0000-7000-8000-000000000003",
        recordedAt: at,
      };
      assert.equal(await run((tx) => timingStore.verify(tx, timing, at)), false);
      timingApprovalAllowed = false;
      await assert.rejects(run((tx) => timingStore.append(tx, timingInput)));
      timingApprovalAllowed = true;
      timingAuditFailure = true;
      await assert.rejects(run((tx) => timingStore.append(tx, timingInput)));
      assert.equal(await run((tx) => timingStore.verify(tx, timing, at)), false);
      timingAuditFailure = false;
      assert.equal(await run((tx) => timingStore.append(tx, timingInput)), "Created");
      assert.equal(await run((tx) => timingStore.append(tx, timingInput)), "Existing");
      assert.equal(await run((tx) => timingStore.verify(tx, timing, at)), true);
      assert.equal(
        await run((tx) => timingStore.verify(tx, timing, "2026-02-01T00:00:00.000Z")),
        false,
      );
      const overlapTiming = {
        ...timing,
        version: 2,
        timingVersionReference: "01909980-0000-7000-8000-000000000004",
      };
      const overlapInput = {
        timing: overlapTiming,
        approval: {
          ...timingApproval,
          version: 2,
          timingVersionReference: overlapTiming.timingVersionReference,
        },
        auditReference: "01909980-0000-7000-8000-000000000005",
        recordedAt: at,
      };
      await assert.rejects(run((tx) => timingStore.append(tx, overlapInput)));
      await assert.rejects(
        run((tx) =>
          timingStore.append(tx, {
            ...timingInput,
            approval: { ...timingApproval, periodDigest: "sha256:" + "0".repeat(64) },
          }),
        ),
      );
      await assert.rejects(
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [ids.brand, ids.store],
          );
          return tx.query("UPDATE rms_store.public_store_profile_timing SET timing_version=2", []);
        }),
      );
      await run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [ids.brand, ids.store],
        );
        assert.equal(
          (await tx.query("DELETE FROM rms_store.public_store_profile_timing", [])).rowCount,
          0,
        );
      });
      const renewalPeriod = {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: "2026-02-01T00:00:00.000Z",
          localDateTime: "2026-01-31T19:00:00.000",
          utcOffsetMinutes: -300,
        },
        effectiveUntil: {
          instant: "2026-03-01T00:00:00.000Z",
          localDateTime: "2026-02-28T19:00:00.000",
          utcOffsetMinutes: -300,
        },
      };
      const renewal = {
        ...timing,
        version: 2,
        timingVersionReference: "01909980-0000-7000-8000-000000000006",
        approvalEvidenceReference: "01909980-0000-7000-8000-000000000007",
        period: renewalPeriod,
        periodDigest: hashContent(renewalPeriod),
        createdAt: at,
      };
      const renewalInput = {
        timing: renewal,
        approval: {
          ...timingApproval,
          evidenceReference: renewal.approvalEvidenceReference,
          version: 2,
          timingVersionReference: renewal.timingVersionReference,
          periodDigest: renewal.periodDigest,
        },
        auditReference: "01909980-0000-7000-8000-000000000008",
        recordedAt: at,
      };
      await assert.rejects(
        run((tx) =>
          timingStore.append(tx, {
            ...renewalInput,
            timing: { ...renewal, releaseReference: ids.lookup },
          }),
        ),
      );
      const appendOnSeparateConnection = async () => {
        const other = new pg.Client(env.clientConfig);
        await other.connect();
        try {
          await other.query("BEGIN");
          await other.query("SET LOCAL ROLE " + role);
          const result = await timingStore.append(
            {
              query: (sql, values) => other.query(sql, [...values]),
            },
            renewalInput,
          );
          await other.query("COMMIT");
          return result;
        } catch (error) {
          await other.query("ROLLBACK");
          throw error;
        } finally {
          await other.end();
        }
      };
      assert.deepEqual(
        (await Promise.all([appendOnSeparateConnection(), appendOnSeparateConnection()])).sort(),
        ["Created", "Existing"],
      );
      assert.equal(
        await run((tx) => timingStore.verify(tx, renewal, "2026-02-15T00:00:00.000Z")),
        true,
      );
      allowed = false;
      assert.equal(await run((tx) => timingStore.verify(tx, timing, at)), false);
      allowed = true;
      const authority = createPostgresPublicStoreProfileAuthority({
        tenantReference: publication.tenantReference,
        brandReference: ids.brand,
        storeReference: ids.store,
        authorize: async () => allowed,
        hashContent,
        verifyEffective: (tx, value, now) => timingStore.verify(tx, value.effectiveVersion, now),
        verifyMedia: async () => {
          throw new Error("null logo must not request media authority");
        },
      });
      assert.equal(await run((tx) => authority(tx, publishedProfile, at)), false);
      await publication.publish();
      assert.equal(await run((tx) => authority(tx, publishedProfile, at)), true);
      const publishedStore = createPostgresPublicStoreProfileStore({
        ...options,
        verifyCurrent: authority,
      });
      const publishedInput = {
        profile: publishedProfile,
        actorReference: ids.approval,
        auditReference: "01909980-0000-7000-8000-000000000002",
        recordedAt: at,
      };
      await assert.rejects(
        run((tx) =>
          publishedStore.append(tx, {
            ...publishedInput,
            profile: {
              ...publishedProfile,
              effectiveVersion: {
                ...publishedProfile.effectiveVersion,
                releaseReference: ids.lookup,
              },
            },
          }),
        ),
      );
      assert.equal(await run((tx) => publishedStore.loadExact(tx, ids.profile, 2, at)), null);
      assert.equal(await run((tx) => publishedStore.append(tx, publishedInput)), "Created");
      assert.deepEqual(
        await run((tx) => publishedStore.loadExact(tx, ids.profile, 2, at)),
        publishedProfile,
      );
      assert.equal(
        await run((tx) =>
          authority(tx, { ...publishedProfile, website: "https://changed.example" }, at),
        ),
        false,
      );
      // Explicit synthetic organization bootstrap; subsequent reads use the real Tenant owner.
      await client.query(
        "INSERT INTO bop_tenant.brand VALUES($1,'PROFILE_DEMO','Profile demonstration','en-CA','CAD','Active',1,$2,$2)",
        [ids.brand, timing.createdAt],
      );
      await client.query(
        "INSERT INTO bop_tenant.store VALUES($1,$2,'PROFILE_DEMO','Profile demonstration','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [ids.store, ids.brand, timing.createdAt],
      );
      await client.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
      await client.query("GRANT SELECT ON bop_tenant.brand,bop_tenant.store TO " + role);
      // PostgreSQL FOR SHARE needs UPDATE privilege on at least one column.
      await client.query("GRANT UPDATE(lifecycle) ON bop_tenant.brand,bop_tenant.store TO " + role);
      let publicAllowed = true;
      const publicTelemetry = [];
      const publicOptions = {
        transactions: { run },
        binding: {
          tenantReference: publication.tenantReference,
          publicStoreReference: ids.publicStore,
          brandReference: ids.brand,
          storeReference: ids.store,
          lookupEvidenceReference: ids.lookup,
          validFrom: timing.createdAt,
          validUntil: "2026-04-01T00:00:00.000Z",
        },
        selection: { profileReference: ids.profile, profileVersion: 2 },
        authorize: async () => publicAllowed, // Synthetic binding/purpose permission; not real Tenant approval.
        hashContent,
        hashSnapshot: hashContent,
        hashPeriod: hashContent,
        verifyMedia: async () => {
          throw new Error("null logo must not query Media");
        },
        telemetry: { record: (labels) => publicTelemetry.push(labels) },
      };
      const reader = createPersistentPublicStoreProfileReader(publicOptions);
      const publicRequest = {
        publicStoreReference: ids.publicStore,
        requestedLocale: "fr-CA",
        evaluatedAt: at,
        purpose: "CustomerEntry",
      };
      const readPublic = await reader.getPublicStore(publicRequest);
      assert.equal(readPublic.status, "Available", JSON.stringify(publicTelemetry));
      assert.equal(readPublic.profile.selectedLocale, "fr-CA");
      assert.equal(
        readPublic.profile.storeDisplayName,
        publishedProfile.localizedFields["fr-CA"].storeDisplayName,
      );
      assert.equal(Object.hasOwn(readPublic.profile, "storeReference"), false);
      assert.equal(Object.hasOwn(readPublic.profile, "effectiveVersion"), false);
      assert.equal(
        (await reader.getPublicStore({ ...publicRequest, purpose: "CustomerCart" })).status,
        "Available",
      );
      assert.equal(
        (await reader.getPublicStore({ ...publicRequest, storeReference: ids.store })).status,
        "InvalidRequest",
      );
      assert.equal(
        (await reader.getPublicStore({ ...publicRequest, publicStoreReference: ids.lookup }))
          .status,
        "StoreUnavailable",
      );
      publicAllowed = false;
      assert.equal((await reader.getPublicStore(publicRequest)).status, "StoreUnavailable");
      publicAllowed = true;
      assert.equal(
        (await reader.getPublicStore({ ...publicRequest, evaluatedAt: "2026-02-01T00:00:00.000Z" }))
          .status,
        "StoreUnavailable",
      );
      const missingReader = createPersistentPublicStoreProfileReader({
        ...publicOptions,
        selection: { profileReference: ids.profile, profileVersion: 99 },
      });
      assert.equal((await missingReader.getPublicStore(publicRequest)).status, "StoreUnavailable");
      const entryJourney = await exercisePersistentProfileEntry({
        admin: client,
        role,
        run,
        publicOptions,
        at,
      });
      try {
        await run((tx) => publication.archive(tx));
        await entryJourney.assertUnavailable();
      } finally {
        await entryJourney.close();
      }
      assert.equal((await reader.getPublicStore(publicRequest)).status, "StoreUnavailable");
      await assert.rejects(run((tx) => publishedStore.loadExact(tx, ids.profile, 2, at)));
      await assert.rejects(run((tx) => publishedStore.append(tx, publishedInput)));
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM rms_store.public_store_profile_version WHERE profile_version=2",
          )
        ).rows[0].n,
        1,
        "archive denies current access without deleting the historical profile",
      );
    } finally {
      await client.end();
    }
  });
});

it.each(["Dining", "Pickup"])(
  "continues current-clock %s Entry through its owner workflow",
  async (channel) => {
    await withIsolatedDatabase({ caseId: "wp2402_current_entry" }, async (env) => {
      const client = new pg.Client(env.clientConfig);
      await client.connect();
      const role = "current_profile_" + env.runId;
      try {
        await client.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
        await client.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
            role,
        );
        await client.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);

        await client.query(
          "GRANT USAGE ON SCHEMA rms_store,platform_helpers,platform_audit TO " + role,
        );
        await client.query(
          "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_store.public_store_profile_version TO " + role,
        );
        await client.query(
          "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_record,platform_audit.audit_chain_head TO " +
            role,
        );
        // Independent reads may run concurrently; never share transaction context.
        const run = async (work) => {
          const connection = new pg.Client({
            ...env.clientConfig,
            connectionTimeoutMillis: 2000,
            query_timeout: 5000,
          });
          await connection.connect();
          try {
            await connection.query("BEGIN");
            await connection.query("SET LOCAL ROLE " + role);
            await connection.query("SET LOCAL statement_timeout='5s'");
            await connection.query("SET LOCAL lock_timeout='5s'");
            const result = await work({
              query: (sql, values) => connection.query(sql, [...values]),
            });
            await connection.query("COMMIT");
            return result;
          } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
          } finally {
            await connection.end();
          }
        };

        await client.query(
          "GRANT SELECT,INSERT,UPDATE ON rms_store.public_store_profile_timing TO " + role,
        );
        let activeWorkerConnections = 0;
        const acquire = async () => {
          const connection = new pg.Client({
            ...env.clientConfig,
            connectionTimeoutMillis: 2000,
            query_timeout: 5000,
          });
          await connection.connect();
          try {
            await connection.query("SET ROLE " + role);
            await connection.query("SET statement_timeout='5s'");
            await connection.query("SET lock_timeout='5s'");
          } catch (error) {
            await connection.end();
            throw error;
          }
          activeWorkerConnections++;
          let released = false;
          return {
            query: (sql, values) => connection.query(sql, [...values]),
            release: async () => {
              if (released) return;
              released = true;
              try {
                await connection.end();
              } finally {
                activeWorkerConnections--;
              }
            },
          };
        };
        const at = new Date(Date.now() - 1000).toISOString();
        const pickupAuthorization = channel === "Pickup";
        const clockFrom = new Date(Date.parse(at) - 60000).toISOString();
        const clockUntil = new Date(Date.parse(at) + 86400000).toISOString();
        const toronto = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
          weekday: "short",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(at));
        const part = (type) => toronto.find((value) => value.type === type).value;
        const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
          part("weekday"),
        );
        const businessDate = `${part("year")}-${part("month")}-${part("day")}`;
        const fixtureClock = {
          from: clockFrom,
          at,
          until: clockUntil,
          businessWeekday: weekdayIndex === 0 ? 7 : weekdayIndex,
          businessDate,
          targetBusinessDate: businessDate,
          initialServiceWindow: { start: "00:00:00", end: "23:59:59" },
          targetServiceWindow: { start: "00:00:00", end: "00:01:00" },
        };
        if (pickupAuthorization) {
          await client.query("INSERT INTO bop_permission.policy_state VALUES ($1,$2,1,$3)", [
            permissionFixture.BRAND,
            permissionFixture.SNAPSHOT,
            clockFrom,
          ]);
          await client.query(
            "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
            [permissionFixture.PERMISSION, permissionFixture.ACTION, clockFrom],
          );
          await client.query(
            "INSERT INTO bop_permission.role VALUES ($1,$2,$3,'synthetic_operator','Active',$4,$5,1,$4,$4)",
            [
              permissionFixture.STORE_ROLE,
              permissionFixture.BRAND,
              permissionFixture.STORE,
              clockFrom,
              clockUntil,
            ],
          );
          await client.query(
            "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
            [
              permissionFixture.STORE_ROLE_ASSIGNMENT,
              permissionFixture.STORE_ROLE,
              permissionFixture.MEMBERSHIP,
              permissionFixture.STORE_ASSIGNMENT,
              permissionFixture.ACTOR,
              permissionFixture.BRAND,
              permissionFixture.STORE,
              clockFrom,
              clockUntil,
            ],
          );
          await client.query(
            "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
            [
              permissionFixture.STORE_GRANT,
              permissionFixture.STORE_ROLE,
              permissionFixture.PERMISSION,
              permissionFixture.BRAND,
              permissionFixture.STORE,
              clockFrom,
              clockUntil,
            ],
          );
          await client.query("GRANT USAGE ON SCHEMA bop_permission,platform_helpers TO " + role);
          await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA bop_permission TO " + role);
          await client.query(
            "GRANT UPDATE ON bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO " +
              role,
          );
          await client.query(
            "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
              role,
          );
          await client.query(
            "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC','Synthetic Brand','en-CA','CAD','Active',1,$2,$2)",
            [permissionFixture.BRAND, clockFrom],
          );
          await client.query(
            "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_1','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
            [permissionFixture.STORE, permissionFixture.BRAND, clockFrom],
          );
        }
        const publicOptions = await prepareCurrentEntryProfile({
          admin: client,
          role,
          run,
          at,
          ...(pickupAuthorization
            ? {
                tenantReference: permissionFixture.uuid("90"),
                brandReference: permissionFixture.BRAND,
                storeReference: permissionFixture.STORE,
                existingOrganizationFacts: true,
              }
            : {}),
        });
        const journey = await exercisePersistentProfileEntry({
          admin: client,
          role,
          run,
          publicOptions,
          at,
          currentClock: true,
          pickupOnly: channel === "Pickup",
          ...(pickupAuthorization
            ? {
                onPickupReady: (pickupReady) =>
                  verifyMerchantAuthorizationRead({
                    admin: client,
                    client,
                    role,
                    fixtureClock: { ...fixtureClock, at: new Date().toISOString() },
                    pickupReady,
                    existingOrganizationFacts: true,
                  }),
              }
            : {}),
          acquire,
        });
        await journey.close();
        assert.equal(activeWorkerConnections, 0);
      } finally {
        await client.end();
      }
    });
  },
);
