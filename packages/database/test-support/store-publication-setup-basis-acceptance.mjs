import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createStoreConfigurationVersion,
  parseStoreSetupDraft,
  parseStoreSetupSaveCommand,
  storeSetupDraftContentFields,
  createPostgresStorePublicationMaterializer,
  createPostgresStorePublicationContentSource,
} from "../../rms/store/src/index.ts";
const id = (n) => "01902421-1012-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T14:00:00.000Z";
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const references = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text) => "sha256:" + sha256Hex(text),
};
const scope = { tenant: id(1), brand: id(2), store: id(3) };
/** Actual owning SQL, parsers and hashes. Authorize callbacks and metadata are
 * controlled test inputs: no current IAM, Publishing, Audit or Live Gate claim. */
export async function verifyStorePublicationSetupBasis(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_pub_basis_" + context.runId;
  let created = false,
    next = 1000;
  await admin.connect();
  const setScope = () =>
    admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenant, scope.brand, scope.store],
    );
  const tx = async (work, commit = false) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query("SET LOCAL statement_timeout='5s'");
      await setScope();
      const result = await work();
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const plain = {
    configurationReference: id(20),
    brandReference: scope.brand,
    storeReference: scope.store,
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(21),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(22),
    contactReference: id(23),
    receiptReference: id(24),
    taxConfigurationReference: id(25),
    paymentConfigurationReference: id(26),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "17:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(4),
    approvedByReference: id(5),
    approvalEvidenceReference: id(27),
    publicationReference: id(28),
    liveGateEvidenceReference: id(29),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const legacy = createStoreConfigurationVersion(plain);
  const fees = [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(30),
      orderTypes: ["DineIn", "Pickup"],
    },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ];
  const snapshot = parseStoreSetupDraft({
    profile: "StoreSetupDraftV2",
    setupDraftReference: id(31),
    tenantReference: scope.tenant,
    brandReference: scope.brand,
    storeReference: scope.store,
    revision: 1,
    authoredByReference: id(6),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: {
      ...Object.fromEntries(
        storeSetupDraftContentFields.map((key) => [
          key,
          { state: "Configured", value: legacy[key] },
        ]),
      ),
      feeContexts: { state: "Configured", value: fees },
    },
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  });
  const command = parseStoreSetupSaveCommand({
    profile: "StoreSetupSaveV2",
    tenantReference: scope.tenant,
    brandReference: scope.brand,
    storeReference: scope.store,
    actorReference: id(6),
    operationReference: id(32),
    expectedSetupReference: null,
    expectedRevision: 0,
    purposeCode: "STORE_SETUP_DRAFT",
    content: snapshot.content,
  });
  const configuration = createStoreConfigurationVersion({
    ...plain,
    setupBasis: {
      profile: "StoreSetupConfigurationBasisV2",
      tenantReference: scope.tenant,
      setupDraftReference: id(31),
      sourceRevision: 1,
      sourceSnapshotDigest: hash(snapshot),
      feeContexts: fees,
    },
  });
  const materializer = createPostgresStorePublicationMaterializer({
    tenantReference: scope.tenant,
    setupSnapshotReferences: references,
    brandReference: scope.brand,
    storeReference: scope.store,
    publishingFamilyReference: id(33),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    businessDayStartSource: "PlatformDefault",
    nextReference: () => id(++next),
    hashContent: hash,
    authorize: async () => true,
  });
  const commitInput = (value) => ({
    operation: {
      command: "Publish",
      operationReference: id(++next),
      brandReference: scope.brand,
      storeReference: scope.store,
      intentDigest: hash(value),
      resultingVersion: value.configurationVersion,
      configuration: value,
    },
    expectedVersion: value.configurationVersion - 1,
    audit: {
      actorReference: id(5),
      auditReference: id(++next),
      purposeCode: "STORE_CONFIGURATION",
      occurredAt: at,
    },
  });
  const read = (value, options = {}) =>
    createPostgresStorePublicationContentSource({
      tenantReference: scope.tenant,
      setupSnapshotReferences: references,
      brandReference: scope.brand,
      storeReference: scope.store,
      configurationReference: value.configurationReference,
      hashContent: hash,
      authorize: async () => true,
      ...options,
    })(admin, at);
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_store.store_configuration_version) versions,(SELECT count(*)::text FROM rms_store.store_configuration_publication_content) contents,(SELECT count(*)::text FROM rms_store.store_setup_draft_revision) drafts,(SELECT count(*)::text FROM rms_store.store_setup_draft_operation) originals",
      )
    ).rows[0];
  const rawBase = async (value) => {
    const pairs = Object.entries(value)
      .filter(([key]) => !["setupBasis", "weeklySchedule", "exceptions"].includes(key))
      .map(([key, v]) => [
        {
          configurationReference: "configuration_id",
          brandReference: "brand_id",
          storeReference: "store_id",
          source: "configuration_source",
        }[key] ?? key.replace(/[A-Z]/gu, (c) => "_" + c.toLowerCase()),
        v,
      ]);
    await admin.query(
      "INSERT INTO rms_store.store_configuration_version (" +
        pairs.map(([key]) => key).join(",") +
        ") VALUES(" +
        pairs.map((_, i) => "$" + (i + 1)).join(",") +
        ")",
      pairs.map(([, value]) => value),
    );
  };
  const rawContent = async (value) =>
    admin.query(
      "INSERT INTO rms_store.store_configuration_publication_content(brand_id,store_id,configuration_id,publishing_family_reference,configuration_type,purpose_code,content_digest,configuration_json,business_day_start_source,recorded_at,data_classification) VALUES($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6::jsonb,'PlatformDefault',$7,'ConfigurationMetadata')",
      [
        scope.brand,
        scope.store,
        value.configurationReference,
        id(33),
        hash(value),
        JSON.stringify(value),
        at,
      ],
    );
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    created = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_store,platform_helpers TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_store.store_setup_draft_revision,rms_store.store_setup_draft_operation,rms_store.store_configuration_version,rms_store.store_configuration_publication_content,rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval TO " +
        role,
    );
    // Existing content reader uses true table SHARE locks, requiring UPDATE ACL.
    // This isolated attack role also proves the immutable history rejection.
    await admin.query(
      "GRANT UPDATE,DELETE ON rms_store.store_configuration_version,rms_store.store_configuration_publication_content TO " +
        role,
    );
    await tx(async () => {
      await admin.query(
        "INSERT INTO rms_store.store_setup_draft_revision(tenant_id,brand_id,store_id,setup_draft_id,revision,operation_id,actor_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8,$9,$9,'ConfigurationMetadata')",
        [
          scope.tenant,
          scope.brand,
          scope.store,
          id(31),
          id(32),
          id(6),
          JSON.stringify(snapshot),
          hash(snapshot),
          at,
        ],
      );
      await admin.query(
        "INSERT INTO rms_store.store_setup_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_setup_id,expected_revision,outcome,result_setup_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,NULL,0,'Committed',$7,1,$8,$9,$10,'ConfigurationMetadata')",
        [
          id(32),
          scope.tenant,
          scope.brand,
          scope.store,
          id(6),
          hash(command),
          id(31),
          hash(snapshot),
          id(34),
          at,
        ],
      );
      await admin.query(
        "SET CONSTRAINTS rms_store.store_setup_revision_coherence,rms_store.store_setup_operation_coherence IMMEDIATE",
      );
    }, true);
    // The original terminal tuple is itself enforced: a different writer cannot
    // manufacture the matching committed receipt for an immutable new revision.
    const originalBaseline = await counts();
    await assert.rejects(
      tx(async () => {
        const changed = parseStoreSetupDraft({
          ...snapshot,
          revision: 2,
          updatedAt: "2026-10-05T14:00:01.000Z",
        });
        await admin.query(
          "INSERT INTO rms_store.store_setup_draft_revision(tenant_id,brand_id,store_id,setup_draft_id,revision,operation_id,actor_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,2,$5,$6,$7::jsonb,$8,$9,$10,'ConfigurationMetadata')",
          [
            scope.tenant,
            scope.brand,
            scope.store,
            id(31),
            id(35),
            id(6),
            JSON.stringify(changed),
            hash(changed),
            at,
            changed.updatedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_store.store_setup_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_setup_id,expected_revision,outcome,result_setup_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,1,'Committed',$7,2,$8,$9,$10,'ConfigurationMetadata')",
          [
            id(35),
            scope.tenant,
            scope.brand,
            scope.store,
            id(99),
            hash(command),
            id(31),
            hash(changed),
            id(36),
            changed.updatedAt,
          ],
        );
        await admin.query(
          "SET CONSTRAINTS rms_store.store_setup_revision_coherence,rms_store.store_setup_operation_coherence IMMEDIATE",
        );
      }),
      (error) => ["55000", "23503", "23514"].includes(error?.code),
    );
    assert.deepEqual(await counts(), originalBaseline);
    const baseline = await counts();
    const reject = async (value) => {
      await assert.rejects(
        tx(async () => {
          await rawBase(configuration);
          await rawContent(value);
        }),
        (error) => error?.code === "55000",
      );
      assert.deepEqual(await counts(), baseline);
    };
    for (const mutate of [
      (v) => ({ ...v, setupBasis: { ...v.setupBasis, tenantReference: id(99) } }),
      (v) => ({ ...v, setupBasis: { ...v.setupBasis, unknownAuthority: true } }),
      (v) => ({ ...v, setupBasis: { ...v.setupBasis, sourceRevision: 2 } }),
      (v) => ({
        ...v,
        setupBasis: { ...v.setupBasis, sourceSnapshotDigest: "sha256:" + "0".repeat(64) },
      }),
      (v) => ({ ...v, setupBasis: { ...v.setupBasis, setupDraftReference: id(98) } }),
      (v) => ({
        ...v,
        setupBasis: {
          ...v.setupBasis,
          feeContexts: fees.map((f) =>
            f.chargeType === "ServiceCharge" ? { chargeType: f.chargeType, state: "Disabled" } : f,
          ),
        },
      }),
      (v) => ({ ...v, supersedesConfigurationReference: id(97) }),
      (v) => ({ ...v, createdAt: "2026-10-05T13:59:59.999Z" }),
      (v) => ({ ...v, defaultLocale: "fr-CA" }),
      (v) => ({ ...v, currencyCode: "EUR" }),
    ])
      await reject(mutate(configuration));
    const alternatives = {
      source: "BrandInherited",
      brandBaseVersionReference: id(90),
      timeZone: "America/New_York",
      businessDayStartLocalTime: "05:00:00",
      addressReference: id(91),
      contactReference: id(92),
      receiptReference: id(93),
      taxConfigurationReference: id(94),
      paymentConfigurationReference: id(95),
      capacityConfigurationReference: id(96),
      enabledServiceModes: ["Pickup"],
      weeklySchedule: configuration.weeklySchedule.map((day) => ({ ...day, intervals: [] })),
      exceptions: [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }],
      effectiveFrom: "2026-10-05T14:00:01.000Z",
      effectiveUntil: "2026-10-06T14:00:00.000Z",
    };
    assert.equal(Object.keys(alternatives).length, 15);
    for (const [field, value] of Object.entries(alternatives))
      await reject({ ...configuration, [field]: value });
    await tx(async () => {
      await materializer(admin, commitInput(configuration));
      assert.deepEqual((await read(configuration)).configuration, configuration);
      await assert.rejects(read(configuration, { tenantReference: id(99) }));
    });
    assert.deepEqual(await counts(), baseline);
    await tx(() => materializer(admin, commitInput(configuration)), true);
    assert.equal((await counts()).contents, "1");
    const old = createStoreConfigurationVersion({
      ...plain,
      configurationReference: id(40),
      configurationVersion: 2,
      supersedesConfigurationReference: id(20),
    });
    await tx(async () => {
      await materializer(admin, commitInput(old));
      assert.deepEqual(
        (await read(old, { tenantReference: undefined, setupSnapshotReferences: undefined }))
          .configuration,
        old,
      );
    }, true);
    const preserved = await counts();
    await assert.rejects(
      tx(() =>
        admin.query(
          "UPDATE rms_store.store_configuration_publication_content SET content_digest=$1 WHERE configuration_id=$2",
          ["sha256:" + "0".repeat(64), id(20)],
        ),
      ),
      (error) => error?.code === "55000",
    );
    await tx(async () => {
      const deleted = await admin.query(
        "DELETE FROM rms_store.store_configuration_publication_content WHERE configuration_id=$1",
        [id(20)],
      );
      assert.equal(deleted.rowCount, 0);
    }, true);
    assert.deepEqual(await counts(), preserved);
    assert.equal(preserved.versions, "2");
    assert.equal(preserved.contents, "2");
    assert.equal(preserved.drafts, "1");
    assert.equal(preserved.originals, "1");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    if (created) {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE " + role).catch(() => undefined);
    }
    await admin.end();
  }
}
