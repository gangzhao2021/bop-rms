import { verifyMerchantConfigurationCommand } from "./merchant-configuration-command.mjs";
import process from "node:process";
import { createMerchantServiceControl } from "../../../apps/api/src/merchant-service-control.ts";
import { seedStorePublication } from "./store-publication-seed.mjs";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { verifyPersistentMerchantBffHttp } from "./persistent-merchant-bff-http.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

export async function verifyPersistentMerchantBff({ admin, client, role }) {
  await admin.query("GRANT USAGE ON SCHEMA rms_store TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version TO " +
      role,
  );
  for (const [configurationId, storeId, start] of [
    [f.uuid("910"), f.STORE, "04:00:00"],
    [f.uuid("920"), f.uuid("610"), "09:00:00"],
  ]) {
    await admin.query(
      "INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto',$5,$6,$7,$8,$9,$10,NULL,ARRAY['DineIn','Pickup'],$11,NULL,NULL,'PILOT_CONFIGURATION',$12,$13,$14,$15,$16,$11,$11,'ConfigurationMetadata')",
      [
        configurationId,
        f.BRAND,
        storeId,
        f.uuid("930"),
        start,
        f.uuid("931"),
        f.uuid("932"),
        f.uuid("933"),
        f.uuid("934"),
        f.uuid("935"),
        f.FROM,
        f.uuid("936"),
        f.uuid("937"),
        f.uuid(storeId === f.STORE ? "938" : "1938"),
        f.uuid(storeId === f.STORE ? "939" : "1939"),
        f.uuid("940"),
      ],
    );
    const content = createStoreConfigurationVersion({
      configurationReference: configurationId,
      brandReference: f.BRAND,
      storeReference: storeId,
      configurationVersion: 1,
      lifecycle: "Published",
      source: "StoreOverride",
      brandBaseVersionReference: f.uuid("930"),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      businessDayStartLocalTime: start,
      addressReference: f.uuid("931"),
      contactReference: f.uuid("932"),
      receiptReference: f.uuid("933"),
      taxConfigurationReference: f.uuid("934"),
      paymentConfigurationReference: f.uuid("935"),
      capacityConfigurationReference: null,
      enabledServiceModes: ["DineIn", "Pickup"],
      weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals:
          index === 1
            ? [
                {
                  startLocalTime: storeId === f.STORE ? "08:00:00" : "09:00:00",
                  endLocalTime: "17:00:00",
                  endsNextDay: false,
                  serviceModes: ["Pickup"],
                  orderCutoffSeconds: 0,
                  leadTimeSeconds: 600,
                },
              ]
            : [],
      })),
      exceptions: [],
      effectiveFrom: f.FROM,
      effectiveUntil: null,
      supersedesConfigurationReference: null,
      reasonCode: "PILOT_CONFIGURATION",
      authoredByReference: f.uuid("936"),
      approvedByReference: f.uuid("937"),
      approvalEvidenceReference: f.uuid(storeId === f.STORE ? "938" : "1938"),
      publicationReference: f.uuid(storeId === f.STORE ? "939" : "1939"),
      liveGateEvidenceReference: f.uuid("940"),
      createdAt: f.FROM,
      updatedAt: f.FROM,
      dataClassification: "ConfigurationMetadata",
    });
    const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(content));
    const publicationId = (n) =>
      f.uuid(String(n === 90 ? 90 : n + (storeId === f.STORE ? 1000 : 2000)));
    await admin.query(
      "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
      [f.BRAND, storeId, configurationId, publicationId(70), digest, content, f.FROM],
    );
    await seedStorePublication(admin, publicationId, content, digest);
  }
  await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON bop_publishing.publishing_mutation_record,bop_publishing.live_gate_version,bop_publishing.live_gate_requirement,rms_store.store_configuration_publication_content TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval,rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
      role,
  );
  await admin.query(
    "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,2,1,'08:00:00','17:00:00',false,ARRAY['Pickup'],0,600,'ConfigurationMetadata')",
    [f.uuid("941"), f.BRAND, f.STORE, f.uuid("910")],
  );
  await admin.query(
    "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,2,1,'09:00:00','17:00:00',false,ARRAY['Pickup'],0,600,'ConfigurationMetadata')",
    [f.uuid("942"), f.BRAND, f.uuid("610"), f.uuid("920")],
  );
  const accessPermission = f.uuid("870");
  await admin.query(
    "INSERT INTO bop_permission.permission_definition VALUES ($1,'merchant.access','Active',1,$2,$2)",
    [accessPermission, f.FROM],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("871"), f.STORE_ROLE, accessPermission, f.BRAND, f.STORE, f.FROM, f.UNTIL],
  );
  await admin.query(
    "INSERT INTO bop_permission.role VALUES ($1,$2,$3,'synthetic_second_operator','Active',$4,$5,1,$4,$4)",
    [f.uuid("872"), f.BRAND, f.uuid("610"), f.FROM, f.UNTIL],
  );
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
    [
      f.uuid("873"),
      f.uuid("872"),
      f.MEMBERSHIP,
      f.uuid("611"),
      f.ACTOR,
      f.BRAND,
      f.uuid("610"),
      f.FROM,
      f.UNTIL,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("874"), f.uuid("872"), accessPermission, f.BRAND, f.uuid("610"), f.FROM, f.UNTIL],
  );
  const key = randomBytes(32),
    pepper = randomBytes(32);
  let nextReference = 800,
    authorization;
  let denyWorkspace = false,
    wrongWorkspace = false,
    associationActive = true;
  const scope = { tenantReference: f.uuid("90"), brandReference: f.BRAND, storeReference: f.STORE };
  const targetReference = f.uuid("610");
  const credentials = {
    generate: () => randomBytes(32).toString("base64url"),
    generateUuidV7: () => f.uuid(String(nextReference++)),
  };
  const challenge = (value) => createHash("sha256").update(value).digest("base64url");
  let transactionTail = Promise.resolve();
  const options = {
    identity: {
      configuration: {
        issuer: "https://provider.example.test",
        clientId: "synthetic-client",
        redirectUri: "https://merchant.example.test/callback",
        environment: "synthetic",
        allowedPostLoginPaths: ["/operations/order-exceptions"],
      },
      credentials,
      hasher: {
        hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
        equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
      },
      pkce: { challenge },
      provider: {
        async createAuthorizationUrl(input) {
          authorization = input;
          return "https://provider.example.test/authorize";
        },
        async exchangeCode(input) {
          assert.equal(input.nonce, authorization.nonce);
          assert.equal(challenge(input.codeVerifier), authorization.codeChallenge);
          return { actor: f.actor, tokenBundle: "synthetic-provider-token-bundle" };
        },
        async revokeOrLogout() {
          return "unknown";
        },
      },
      envelopes: {
        async encrypt(plaintext, encryptionContext) {
          const nonce = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(encryptionContext));
          const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference: "ephemeral-test-key",
            encryptionContext,
            ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url"),
          };
        },
        async decrypt(envelope, encryptionContext) {
          assert.equal(envelope.encryptionContext, encryptionContext);
          const raw = Buffer.from(envelope.ciphertext, "base64url");
          const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
          decipher.setAAD(Buffer.from(encryptionContext));
          decipher.setAuthTag(raw.subarray(12, 28));
          return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
            "utf8",
          );
        },
      },
    },
    transactions: {
      async run(work) {
        const previous = transactionTail;
        let release;
        transactionTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        } finally {
          release();
        }
      },
    },
    publication: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    },
    currentActor: async () => f.actor,
    now: () => f.AT,
    validateAssociation: async (_tx, session, selected) =>
      associationActive &&
      session.actor.actorReference === f.ACTOR &&
      selected.tenantReference === scope.tenantReference &&
      selected.brandReference === scope.brandReference &&
      [f.STORE, targetReference].includes(selected.storeReference),
    initialScope: async () => scope,
    targetScope: async (_tx, _session, storeReference) => ({ ...scope, storeReference }),
    // Synthetic metadata/candidate navigation; actual Permission policy is enforced by service.
    workspace: async (_tx, { context }) => {
      if (denyWorkspace) throw new Error("synthetic current access denied");
      const selectedScope = {
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: wrongWorkspace ? f.STORE : context.store.storeReference,
      };
      return {
        screenId: "HOME-OVERVIEW",
        selectedScope,
        authorizedStores: [f.STORE, targetReference].map((storeReference) => ({
          brandLabel: "Untrusted candidate label",
          storeLabel: "Untrusted candidate label",
          storeReference,
        })),
        businessDate: "2099-01-01",
        storeStatus: "Unavailable",
        freshness: "Stale",
        dashboardAvailability: "UnavailableUntilWP1905",
        navigation: [
          {
            screenId: "HOME-OVERVIEW",
            label: "Overview",
            href: "/app",
            permission: "merchant.access",
          },
          {
            screenId: "OPS-ORDER-EXCEPTION",
            label: "Exceptions",
            href: "/operations/order-exceptions",
            permission: "operations.order-exception.manage",
          },
        ],
      };
    },
  };
  const service = () => createPersistentMerchantBffService(options);
  const start = await service().start("/operations/order-exceptions");
  const loginInput = {
    code: credentials.generate(),
    state: authorization.state,
    authCookie: start.cookie.value,
  };
  const login = await service().callback(loginInput);
  await assert.rejects(service().callback(loginInput));
  const cookie = login.cookies.find((value) => !value.clear);
  assert(cookie);
  const initial = await service().bootstrap(cookie.value);
  assert.equal(initial.workspace.selectedScope.storeReference, f.STORE);
  assert.equal(initial.workspace.navigation.length, 2);
  assert.equal(initial.workspace.businessDate, "2026-07-28");
  assert.equal(initial.workspace.storeStatus, "Open");
  assert.equal(initial.workspace.freshness, "Current");
  assert.deepEqual(
    initial.workspace.authorizedStores.map((entry) => entry.storeLabel),
    ["Synthetic Store", "Synthetic Second Store"],
  );
  assert.equal(initial.workspace.selectedScope.storeLabel, "Synthetic Store");
  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("877"),
      accessPermission,
      f.ACTOR,
      f.BRAND,
      targetReference,
      f.REASON,
      f.CORRELATION,
      f.FROM,
      f.UNTIL,
    ],
  );
  const restricted = await service().bootstrap(cookie.value);
  assert.deepEqual(
    restricted.workspace.authorizedStores.map((entry) => entry.storeReference),
    [f.STORE],
  );
  await assert.rejects(
    service().switchStore({
      sessionCookie: cookie.value,
      csrf: initial.csrf,
      targetStoreReference: targetReference,
    }),
  );
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("877")],
  );

  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("876"),
      accessPermission,
      f.ACTOR,
      f.BRAND,
      f.STORE,
      f.REASON,
      f.CORRELATION,
      f.FROM,
      f.UNTIL,
    ],
  );
  await assert.rejects(service().bootstrap(cookie.value));
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("876")],
  );

  const switchInput = {
    sessionCookie: cookie.value,
    csrf: initial.csrf,
    targetStoreReference: targetReference,
  };
  await assert.rejects(service().switchStore({ ...switchInput, csrf: credentials.generate() }));
  const nextRows = async () =>
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM bop_identity.authentication_session WHERE rotated_from_session_id=$1",
        [login.session.sessionReference],
      )
    ).rows[0].count;
  denyWorkspace = true;
  await assert.rejects(service().switchStore(switchInput));
  assert.equal(await nextRows(), 0);
  denyWorkspace = false;
  wrongWorkspace = true;
  await assert.rejects(service().switchStore(switchInput));
  assert.equal(await nextRows(), 0);
  wrongWorkspace = false;
  assert.equal(
    (await service().bootstrap(cookie.value)).workspace.selectedScope.storeReference,
    f.STORE,
  );
  const switched = await service().switchStore(switchInput);
  assert.equal(switched.workspace.selectedScope.storeReference, targetReference);
  assert.equal(switched.workspace.businessDate, "2026-07-27");
  assert.equal(switched.workspace.storeStatus, "Closed");
  assert.equal(switched.workspace.freshness, "Current");
  assert.deepEqual(
    switched.workspace.navigation.map((entry) => entry.screenId),
    ["HOME-OVERVIEW"],
  );
  assert.equal(await nextRows(), 1);
  await assert.rejects(service().bootstrap(cookie.value));
  const refreshed = await service().bootstrap(switched.cookie.value);
  assert.notEqual(refreshed.csrf, initial.csrf);
  assert.equal(refreshed.workspace.selectedScope.storeReference, targetReference);
  await assert.rejects(
    service().authorize({ sessionCookie: switched.cookie.value, csrf: initial.csrf }),
  );
  associationActive = false;
  await assert.rejects(service().bootstrap(switched.cookie.value));
  associationActive = true;
  assert.equal((await service().logout(switched.cookie.value)).clear, true);
  await assert.rejects(service().bootstrap(switched.cookie.value));
  await verifyPersistentMerchantBffHttp({
    service: service(),
    authorization: () => authorization,
    credentials,
    initialStore: f.STORE,
    targetStore: targetReference,
  });
  const gateLoginStart = await service().start("/operations/order-exceptions");
  const gateLogin = await service().callback({
    code: credentials.generate(),
    state: authorization.state,
    authCookie: gateLoginStart.cookie.value,
  });
  const gateCookie = gateLogin.cookies.find((value) => !value.clear);
  assert(gateCookie);
  const controlBootstrap = await service().bootstrap(gateCookie.value);
  let controlAt = f.AT;
  const control = createMerchantServiceControl({
    persistence: { ...options, now: () => controlAt },
    authentication: service(),
    audit: {
      reasonCode: "SYNTHETIC_SERVICE_CONTROL",
      retentionPolicyCode: "STORE_SERVICE_AUDIT",
      retentionPolicyVersion: 1,
    },
  });
  await admin.query(
    "GRANT INSERT ON rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  const controlRequest = {
    sessionCookie: gateCookie.value,
    csrf: controlBootstrap.csrf,
    command: {
      command: "PauseService",
      operationReference: f.uuid("3100"),
      configurationReference: f.uuid("910"),
      expectedVersion: 0,
      auditReference: f.uuid("3101"),
      content: { effectiveUntil: f.UNTIL, serviceModes: ["Pickup"] },
    },
  };
  await assert.rejects(control(controlRequest), /STORE_SERVICE_PERMISSION_DENIED/u);
  await assert.rejects(control.read(gateCookie.value));
  for (const [code, number] of [
    ["store.service.pause", 3110],
    ["store.service.read", 3140],
    ["store.service.resume", 3120],
  ]) {
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
      [f.uuid(String(number)), code, f.FROM],
    );
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [
        f.uuid(String(number + 1)),
        f.STORE_ROLE,
        f.uuid(String(number)),
        f.BRAND,
        f.STORE,
        f.FROM,
        f.UNTIL,
      ],
    );
  }
  const configurationService = await verifyMerchantConfigurationCommand({
    admin,
    role,
    options: { ...options, now: () => controlAt },
    service: service(),
    cookie: gateCookie.value,
    csrf: controlBootstrap.csrf,
  });
  await assert.rejects(control({ ...controlRequest, csrf: credentials.generate() }));
  await assert.rejects(
    control({ ...controlRequest, command: { ...controlRequest.command, actorReference: f.ACTOR } }),
    /STORE_SERVICE_COMMAND_INVALID/u,
  );
  const beforeControl = await control.read(gateCookie.value);
  assert.equal(beforeControl.configurationReference, f.uuid("910"));
  assert.equal(beforeControl.expectedVersion, 0);
  assert.deepEqual(beforeControl.activePauses, []);
  assert.deepEqual(await control(controlRequest), { status: "Applied", resultingVersion: 1 });
  const duringControl = await control.read(gateCookie.value);
  assert.equal(duringControl.expectedVersion, 1);
  assert.equal(duringControl.activePauses[0].closureReference, f.uuid("3100"));

  assert.deepEqual(await control(controlRequest), {
    status: "AlreadyApplied",
    resultingVersion: 1,
  });
  assert.equal((await service().bootstrap(gateCookie.value)).workspace.storeStatus, "Paused");
  controlAt = new Date(Date.parse(f.AT) + 60000).toISOString();
  assert.deepEqual(
    await control({
      ...controlRequest,
      command: {
        command: "ResumeService",
        operationReference: f.uuid("3130"),
        configurationReference: f.uuid("910"),
        expectedVersion: 1,
        auditReference: f.uuid("3131"),
        content: { pauseOperationReference: f.uuid("3100") },
      },
    }),
    { status: "Applied", resultingVersion: 2 },
  );
  const afterControl = await control.read(gateCookie.value);
  assert.equal(afterControl.expectedVersion, 2);
  assert.deepEqual(afterControl.activePauses, []);
  const laterService = createPersistentMerchantBffService({ ...options, now: () => controlAt });
  assert.equal((await laterService.bootstrap(gateCookie.value)).workspace.storeStatus, "Open");
  if (process.env.BOP_MERCHANT_SERVICE_BROWSER === "1") {
    const { verifyMerchantServiceBrowser } = await import("./merchant-service-browser.mjs");
    await verifyMerchantServiceBrowser({
      control,
      configuration: configurationService,
      assertConfigurationAudit: async (command) => {
        const persisted = await admin.query(
          "SELECT actor_reference,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
          [command.operationReference],
        );
        assert.equal(persisted.rowCount, 1);
        assert.equal(persisted.rows[0].actor_reference, f.ACTOR);
        if (command.command === "Approve") {
          assert.notEqual(persisted.rows[0].configuration_json.authoredByReference, f.ACTOR);
          assert.equal(persisted.rows[0].configuration_json.approvedByReference, f.ACTOR);
          assert.equal(
            persisted.rows[0].configuration_json.approvalEvidenceReference,
            command.operationReference,
          );
        } else assert.equal(persisted.rows[0].configuration_json.authoredByReference, f.ACTOR);
        assert.equal(persisted.rows[0].configuration_json.businessDayStartLocalTime, "05:00:00");
        assert.equal(
          (
            await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
              command.auditReference,
            ])
          ).rowCount,
          1,
        );
      },
      cookie: gateCookie.value,
      store: f.STORE,
      now: () => controlAt,
      advance: () => {
        controlAt = new Date(Date.parse(controlAt) + 60000).toISOString();
      },
    });
  }

  const auditGapState = await control.read(gateCookie.value);
  const auditGapVersion = auditGapState.expectedVersion;
  const auditGapCommand = {
    brandReference: f.BRAND,
    storeReference: f.STORE,
    command: "PauseService",
    operationReference: f.uuid("3350"),
    configurationReference: auditGapState.configurationReference,
    actorReference: f.ACTOR,
    purposeCode: "STORE_SERVICE",
    expectedVersion: auditGapVersion,
    auditReference: f.uuid("3351"),
    content: { effectiveUntil: f.UNTIL, serviceModes: ["Pickup"] },
  };
  const auditGapDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(auditGapCommand));
  await admin.query(
    "INSERT INTO rms_store.store_configuration_operation VALUES($1,$2,$3,$4,'PauseService',$5,$6,$7,$8,'STORE_SERVICE',$9,$10,'ConfigurationMetadata')",
    [
      auditGapCommand.operationReference,
      f.BRAND,
      f.STORE,
      auditGapState.configurationReference,
      auditGapDigest,
      auditGapVersion,
      auditGapVersion + 1,
      f.ACTOR,
      f.uuid("3351"),
      controlAt,
    ],
  );
  await admin.query(
    "INSERT INTO rms_store.store_service_pause_content VALUES($1,$2,$3,'PauseService',$4,$5,ARRAY['Pickup'],'ConfigurationMetadata')",
    [f.BRAND, f.STORE, auditGapCommand.operationReference, controlAt, f.UNTIL],
  );
  await assert.rejects(control.read(gateCookie.value), /STORE_PAUSE_HISTORY_UNAVAILABLE/u);
  await options.transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      f.BRAND,
      f.STORE,
    ]);
    await appendAuditRecordInTransaction(tx, {
      auditId: f.uuid("3351"),
      brandId: f.BRAND,
      storeId: f.STORE,
      actor: { type: "User", reference: f.ACTOR },
      actionCode: "STORE_SERVICE_PAUSED",
      targetType: "StoreServiceControl",
      targetId: f.uuid("3350"),
      correlationId: f.uuid("3350"),
      reasonCode: "SYNTHETIC_AUDIT_BINDING",
      occurredAt: controlAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "STORE_SERVICE_AUDIT",
      retentionPolicyVersion: 1,
      afterSummary: {
        intentDigest: auditGapDigest,
        expectedVersion: auditGapVersion,
        resultingVersion: auditGapVersion + 1,
      },
    });
  });
  assert.equal((await control.read(gateCookie.value)).expectedVersion, auditGapVersion + 1);
  if (process.env.BOP_MERCHANT_SERVICE_BROWSER !== "1")
    await configurationService.verifyPublication();
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-STORE-LIVE-GATE',$2,$3,$4,2,'Production','Reopened',$5,$6,NULL,NULL,NULL,$7,'ConfigurationMetadata')",
    [f.uuid("1080"), f.uuid("90"), f.BRAND, f.STORE, f.uuid("937"), f.uuid("936"), f.AT],
  );
  await assert.rejects(service().bootstrap(gateCookie.value));
  await service().logout(gateCookie.value);
}
