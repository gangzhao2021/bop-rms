import assert from "node:assert/strict";
import { candidate, ids } from "../../rms/store/src/tests/public-store-profile.fixture.ts";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import {
  createPostgresPublicStoreProfileTimingStore,
  createPostgresPublicStoreProfileAuthority,
  createPostgresPublicStoreProfileStore,
  publicStoreProfileContent,
} from "../../rms/store/src/index.ts";
import { preparePublicStoreProfilePublication } from "./public-store-profile-publication.mjs";
import { entryTorontoBoundary } from "./entry-toronto-boundary.mjs";

/** Synthetic approval/organization configuration; actual Publishing, Store timing and profile owners. */
export async function prepareCurrentEntryProfile({ admin, role, run, at }) {
  const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  const until = new Date(Date.parse(at) + 86400000).toISOString();
  const profile = candidate();
  profile.logo = null;
  profile.timeZone = "America/Toronto";
  profile.effectiveVersion.createdAt = at;
  profile.effectiveVersion.period = {
    timeZone: "America/Toronto",
    effectiveFrom: entryTorontoBoundary(at),
    effectiveUntil: entryTorontoBoundary(until),
  };
  profile.contentDigest = hash(publicStoreProfileContent(profile));
  const publication = await preparePublicStoreProfilePublication({
    admin,
    role,
    scope: { brandReference: ids.brand, storeReference: ids.store },
    version: { publishedAt: at, versionReference: ids.profile, publicationReference: ids.release },
    digest: profile.contentDigest,
  });
  profile.publishingLifecycle = publication.lifecycle;
  profile.publishingRelease = publication.release;
  profile.effectiveVersion.snapshotDigest = profile.contentDigest;
  profile.effectiveVersion.releaseReference = publication.release.releaseId;
  profile.effectiveVersion.periodDigest = hash(profile.effectiveVersion.period);
  const appendAudit = (tx, auditReference, actionCode, targetType, targetId, occurredAt) =>
    appendAuditRecordInTransaction(tx, {
      auditId: auditReference,
      brandId: ids.brand,
      storeId: ids.store,
      actor: { type: "System" },
      actionCode,
      targetType,
      targetId,
      occurredAt,
      correlationId: auditReference,
      reasonCode: "SYNTHETIC_CURRENT_ENTRY",
      sourceChannel: "SYSTEM",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
  const timingStore = createPostgresPublicStoreProfileTimingStore({
    brandReference: ids.brand,
    storeReference: ids.store,
    authorize: async () => true,
    authorizeApproval: async () => true,
    hashPeriod: hash,
    appendAudit: (tx, record) =>
      appendAudit(
        tx,
        record.auditReference,
        "STORE_PROFILE_TIMING_RECORDED",
        "StoreProfileTiming",
        record.timing.timingVersionReference,
        record.recordedAt,
      ),
  });
  const timing = profile.effectiveVersion;
  await run((tx) =>
    timingStore.append(tx, {
      timing,
      recordedAt: at,
      auditReference: "01909980-0000-7000-8000-000000000003",
      approval: {
        evidenceReference: timing.approvalEvidenceReference,
        familyReference: timing.familyReference,
        timingVersionReference: timing.timingVersionReference,
        version: timing.version,
        scope: timing.scope,
        periodDigest: timing.periodDigest,
        decision: "Accepted",
        approvedActorReference: ids.approval,
        approvedAt: at,
        validUntil: until,
      },
    }),
  );
  await publication.publish();
  const authority = createPostgresPublicStoreProfileAuthority({
    tenantReference: publication.tenantReference,
    brandReference: ids.brand,
    storeReference: ids.store,
    authorize: async () => true,
    hashContent: hash,
    verifyEffective: (tx, value, observedAt) =>
      timingStore.verify(tx, value.effectiveVersion, observedAt),
    verifyMedia: async () => {
      throw new Error("no media in synthetic profile");
    },
  });
  const profiles = createPostgresPublicStoreProfileStore({
    brandReference: ids.brand,
    storeReference: ids.store,
    authorize: async () => true,
    verifyCurrent: authority,
    hashSnapshot: hash,
    appendAudit: (tx, input) =>
      appendAudit(
        tx,
        input.auditReference,
        "STORE_PUBLIC_PROFILE_RECORDED",
        "StoreProfile",
        input.profile.profileReference,
        input.recordedAt,
      ),
  });
  assert.equal(
    await run((tx) =>
      profiles.append(tx, {
        profile,
        actorReference: ids.approval,
        recordedAt: at,
        auditReference: "01909980-0000-7000-8000-000000000002",
      }),
    ),
    "Created",
  );
  await admin.query(
    "INSERT INTO bop_tenant.brand VALUES($1,'PROFILE_CURRENT','Current synthetic profile','en-CA','CAD','Active',1,$2,$2)",
    [ids.brand, at],
  );
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES($1,$2,'PROFILE_CURRENT','Current synthetic store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [ids.store, ids.brand, at],
  );
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  await admin.query("GRANT SELECT ON bop_tenant.brand,bop_tenant.store TO " + role);
  await admin.query("GRANT UPDATE(lifecycle) ON bop_tenant.brand,bop_tenant.store TO " + role);
  return {
    transactions: { run },
    binding: {
      tenantReference: publication.tenantReference,
      publicStoreReference: ids.publicStore,
      brandReference: ids.brand,
      storeReference: ids.store,
      lookupEvidenceReference: ids.lookup,
      validFrom: at,
      validUntil: until,
    },
    selection: { profileReference: ids.profile, profileVersion: profile.profileVersion },
    authorize: async () => true,
    hashContent: hash,
    hashSnapshot: hash,
    hashPeriod: hash,
    verifyMedia: async () => {
      throw new Error("no media in synthetic profile");
    },
    telemetry: { record: () => undefined },
  };
}
