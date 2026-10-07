import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createInternalCredentialLoaders } from "../../../tooling/environment/pilot-credentials.mjs";
import { runInternalBrandInitialProvisioning } from "../../../tooling/environment/brand-initial-provisioning.mjs";
import { createAuthenticatedBrandInitialProvisioning } from "../../../apps/api/src/brand-initial-provisioning.ts";
import { createAuthenticatedWorkforceAccountBindingImport } from "../../../apps/api/src/workforce-account-binding.ts";
import { verifyWorkforceAccountBindingAcceptance } from "./workforce-account-binding-acceptance.mjs";
import { exerciseInitialBrandWorkforceLogin } from "./brand-initial-workforce-login.mjs";
import { verifyPlatformTemplatePublishingPersistence } from "./platform-template-publishing-persistence.mjs";
import {
  createCognitoPlatformSubjectStatus,
  parseWorkforceAccountBindingCommand,
  parseWorkforceAccountBinding,
  buildWorkforceAccountBinding,
  workforceAccountBindingOriginal,
  workforceAccountBindingIntent,
  workforceAccountBindingSubjectHash,
  workforceAccountBindingCodec,
  workforceAccountBindingApprovalSigningBytes,
  createPostgresPlatformActorDirectoryProvisioner,
  createPostgresPlatformActorDirectorySource,
  createPostgresPlatformBrowserSessionStore,
  createWorkforceInvitation,
} from "../../bop/identity/src/index.ts";
import { workforceRelationshipQualificationSigningBytes } from "../../bop/membership/src/index.ts";
import {
  createFileBrandProvisioningApprovalSource,
  hashBrandInitialProvisioningPlan,
  parseBrandInitialProvisioningPlan,
} from "../../bop/permission/src/index.ts";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
} from "../../bop/audit/src/index.ts";

const identityRequire = createRequire(new URL("../../bop/identity/package.json", import.meta.url));
const { CognitoIdentityProviderClient, AdminGetUserCommand } = identityRequire(
  "@aws-sdk/client-cognito-identity-provider",
);
const id = (n) => `0190ed60-0040-7000-8000-${n.toString(16).padStart(12, "0")}`;
const actions = [
  "organization.manage",
  "publishing.draft.create",
  "publishing.review.submit",
  "publishing.review.approve",
  "publishing.release.publish",
  "publishing.release.archive",
];
const purposeCode = "BRAND_INITIAL_PROVISIONING";

/** Actual isolated nonowner PostgreSQL and actual signature/file verifier.
 * Ephemeral signing keys and externally asserted Workforce/relationship/Provider facts
 * are synthetic InternalTest inputs, never real deployment approval. */
async function prepare(context) {
  const admin = new pg.Client(context.clientConfig);
  const role = `brand_initial_${context.runId}`;
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  const password = randomBytes(32).toString("hex");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "bop-brand-initial-native-")));
  const clients = new Set(),
    extraRoles = [],
    cleanup = [];
  let roleCreated = false,
    adminConnected = false,
    stage = "Setup";
  const state = {
    now: new Date().toISOString(),
    beforeCommit: null,
    onQuery: null,
    afterQuery: null,
    lastSqlState: null,
    lastStatement: "None",
    statementCount: 0,
    invitationReads: 0,
    committed: 0,
    rolledBack: 0,
  };
  const close = async () => {
    try {
      for (const client of clients) await client.end();
      clients.clear();
      for (const extra of extraRoles.reverse()) {
        await admin.query(`DROP OWNED BY ${extra}`);
        await admin.query(`DROP ROLE ${extra}`);
      }
      if (roleCreated) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
    } finally {
      for (const release of cleanup) release();
      try {
        if (adminConnected) await admin.end();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    await admin.connect();
    adminConnected = true;
    await admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await admin.query(
      `GRANT USAGE ON SCHEMA bop_tenant,bop_membership,bop_permission,platform_audit,platform_helpers TO ${role}`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
    );
    await admin.query(`GRANT SELECT,INSERT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT ON bop_tenant.brand_admin_operation TO ${role}`);
    // MAINTAIN permits the owning predicate lock without lifecycle UPDATE.
    // UPDATE(version) supplies SELECT FOR UPDATE's separate row-lock privilege.
    await admin.query(
      `GRANT SELECT,INSERT,MAINTAIN,UPDATE(version) ON bop_membership.membership TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT,INSERT ON bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON bop_permission.permission_override TO ${role}`);
    await admin.query(
      `GRANT SELECT,UPDATE(version) ON bop_permission.permission_definition TO ${role}`,
    );
    await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
    for (const [index, action] of actions.entries()) {
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [id(100 + index), action, state.now],
      );
    }
    const transactions = Object.freeze({
      async run(work) {
        const client = new pg.Client({ ...context.clientConfig, user: role, password });
        await client.connect();
        clients.add(client);
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          const tx = Object.freeze({
            async query(sql, values) {
              state.statementCount++;
              if (
                sql.includes("FROM bop_identity.workforce_invitation") ||
                sql.includes("workforce_account_invitation_read")
              )
                state.invitationReads++;
              state.lastStatement =
                [
                  ["brand_admin_operation", "TenantReceipt"],
                  ["bop_tenant.brand", "TenantBrand"],
                  ["platform_audit", "Audit"],
                  ["bop_membership", "Membership"],
                  ["bop_permission", "Permission"],
                  ["pg_advisory", "AdvisoryLock"],
                  ["set_config", "Context"],
                ].find(([pattern]) => sql.includes(pattern))?.[1] ?? "TransactionIdentity";
              try {
                if (state.onQuery) await state.onQuery({ client, sql, values });
                const result = await client.query(sql, [...values]);
                if (state.afterQuery) await state.afterQuery({ client, sql, values });
                return result;
              } catch (error) {
                if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) state.lastSqlState = error.code;
                throw error;
              }
            },
          });
          const result = await work(tx);
          if (state.beforeCommit) await state.beforeCommit({ client, tx });
          await client.query("COMMIT");
          state.committed++;
          return result;
        } catch (error) {
          if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) state.lastSqlState = error.code;
          await client.query("ROLLBACK");
          state.rolledBack++;
          throw error;
        } finally {
          clients.delete(client);
          await client.end();
        }
      },
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const approvalPath = path.join(directory, "approval.json"),
      trustPath = path.join(directory, "trust.json");
    const writeApproval = async (expected, approvedByReference, approvalEvidenceReference) => {
      const payload = {
        profile: "BrandInitialProvisioningApprovalV1",
        purposeCode,
        ...expected,
        approvedByReference,
        approvalEvidenceReference,
        keyReference: id(900),
        notBefore: new Date(Date.parse(state.now) - 60000).toISOString(),
        validUntil: new Date(Date.parse(state.now) + 3600000).toISOString(),
      };
      const signature = sign(
        null,
        Buffer.from("BOP-RMS:BrandInitialProvisioningApprovalV1\n" + canonicalizeRfc8785(payload)),
        privateKey,
      ).toString("base64url");
      const trust = {
        profile: "BrandInitialProvisioningTrustV1",
        keys: [
          {
            keyReference: id(900),
            approvedByReference,
            environmentReference: expected.environmentReference,
            purposeCode,
            notBefore: payload.notBefore,
            validUntil: payload.validUntil,
            publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
          },
        ],
        revokedApprovalEvidenceReferences: [],
      };
      await writeFile(approvalPath, JSON.stringify({ ...payload, signature }), { mode: 0o600 });
      await writeFile(trustPath, JSON.stringify(trust), { mode: 0o600 });
      return {
        trust,
        async withdraw() {
          await writeFile(
            trustPath,
            JSON.stringify({
              ...trust,
              revokedApprovalEvidenceReferences: [approvalEvidenceReference],
            }),
            { mode: 0o600 },
          );
        },
      };
    };
    const counts = async (brandReference) =>
      (
        await admin.query(
          `SELECT
      (SELECT count(*)::int FROM bop_tenant.brand WHERE brand_id=$1) brands,
      (SELECT count(*)::int FROM bop_tenant.brand_admin_operation WHERE brand_id=$1) operations,
      (SELECT count(*)::int FROM bop_membership.membership WHERE brand_id=$1) memberships,
      (SELECT count(*)::int FROM bop_permission.policy_state WHERE brand_id=$1) policies,
      (SELECT count(*)::int FROM bop_permission.role WHERE brand_id=$1) roles,
      (SELECT count(*)::int FROM bop_permission.role_assignment WHERE brand_id=$1) assignments,
      (SELECT count(*)::int FROM bop_permission.permission_grant WHERE brand_id=$1) grants,
      (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audits`,
          [brandReference],
        )
      ).rows[0];
    return {
      admin,
      role,
      password,
      directory,
      state,
      extraRoles,
      cleanup,
      clients,
      transactions,
      writeApproval,
      counts,
      close,
      clock: Object.freeze({ now: () => state.now }),
      approvalFiles: Object.freeze({ approvalPath, trustPath }),
      mark(name) {
        stage = name;
      },
      failure(error) {
        return new Error(
          `Brand initial native failed at ${stage}; statement=${state.lastStatement}; count=${state.statementCount}; SQLSTATE=${state.lastSqlState ?? "None"}`,
          { cause: error },
        );
      },
    };
  } catch (error) {
    await close();
    throw new Error(`Brand initial native setup failed at ${stage}`, { cause: error });
  }
}

/** Real Directory/Audit and encrypted Session producers. Only the SDK network,
 * initial directory approval and TOTP-origin boundary are synthetic. */
async function createNativeOperator(f, context, external) {
  f.mark("Actual operator Directory and encrypted Session");
  const pool = "ca-central-1_Native1",
    subject = "opaque-native-initial-operator";
  const configuration = Object.freeze({
    environment: "synthetic",
    issuer: `https://cognito-idp.ca-central-1.amazonaws.com/${pool}`,
    clientId: "syntheticplatform",
    redirectUri: "https://platform.invalid/platform/auth/callback",
    allowedPostLoginPaths: ["/platform/tenants"],
  });
  let sdkCalls = 0,
    sequence = 7000;
  const send = vi
    .spyOn(CognitoIdentityProviderClient.prototype, "send")
    .mockImplementation(async (command) => {
      assert(command instanceof AdminGetUserCommand);
      sdkCalls++;
      assert.equal(command.input.UserPoolId, pool);
      const wanted = command.input.Username;
      assert(
        [subject, "opaque-native-workforce-target", "opaque-native-workforce-other"].includes(
          wanted,
        ) || /^opaque-native-workforce-acceptance-(100|200)$/u.test(wanted),
      );
      if (wanted !== subject) {
        external.memberCalls++;
        if (external.onWorkforceRead) await external.onWorkforceRead();
        if (!external.membersEnabled) external.disabledMemberCalls++;
      }
      return {
        Username: wanted,
        Enabled: wanted === subject ? external.operatorEnabled : external.membersEnabled,
        UserStatus: "CONFIRMED",
        UserAttributes: [{ Name: "sub", Value: wanted }],
      };
    });
  f.cleanup.push(() => send.mockRestore());
  const writeCredentials = async (name) => {
    const file = path.join(f.directory, name);
    const names = [
      "guestSession",
      "guestBinding",
      "pickupDerivation",
      "pickupSelector",
      "merchantEncryption",
      "merchantSelector",
    ];
    await writeFile(
      file,
      JSON.stringify({
        environment: "InternalTest",
        version: 1,
        keys: Object.fromEntries(names.map((name) => [name, randomBytes(32).toString("hex")])),
      }),
      { mode: 0o600 },
    );
    return createInternalCredentialLoaders({
      file,
      expectedDatabaseName: context.clientConfig.database,
      loadProfile: async () => ({
        environment: "InternalTest",
        database: context.clientConfig.database,
      }),
    }).createInternalMerchantCredentials();
  };
  // Separate stable, private InternalTest key files are consumed by both the
  // native producers and the actual executable entry. No keys are auto-created
  // by the entry. The real encrypt result intentionally retains its different
  // envelope field order from SQL decoding, covering semantic equality.
  const { hasher, envelopes } = await writeCredentials("operator-credentials.json");
  const workforceCrypto = await writeCredentials("workforce-credentials.json");
  const directoryConfiguration = Object.freeze({
    environment: configuration.environment,
    issuer: configuration.issuer,
    clientIds: [configuration.clientId],
  });
  const remote = createCognitoPlatformSubjectStatus({ userPoolId: pool, clock: f.clock });
  const accounts = [];
  for (const suffix of ["directory", "session"]) {
    const role = `brand_initial_${suffix}_${context.runId}`,
      password = randomBytes(32).toString("hex");
    assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
    await f.admin.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    f.extraRoles.push(role);
    accounts.push({ role, password });
    await f.admin.query(
      `GRANT USAGE ON SCHEMA bop_identity,platform_audit,platform_helpers TO ${role}`,
    );
    await f.admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),bop_identity.platform_actor_directory_import_capable() TO ${role}`,
    );
  }
  const [importer, sessionWriter] = accounts;
  await f.admin.query(
    `GRANT SELECT,INSERT ON bop_identity.platform_actor_directory_revision,platform_audit.platform_actor_audit_record TO ${importer.role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE ON bop_identity.platform_actor_directory_head,platform_audit.platform_actor_audit_chain_head TO ${importer.role}`,
  );
  await f.admin.query(
    `GRANT SELECT,UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.authentication_session TO ${importer.role}`,
  );
  await f.admin.query(
    `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_import_admit(uuid,uuid,uuid),platform_audit.matches_platform_actor_directory_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${importer.role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session TO ${sessionWriter.role}`,
  );
  for (const role of [sessionWriter.role, f.role]) {
    await f.admin.query(`GRANT USAGE ON SCHEMA bop_identity TO ${role}`);
    await f.admin.query(
      `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_read(uuid,text,text,text),bop_identity.platform_actor_directory_import_capable() TO ${role}`,
    );
  }
  await f.admin.query(
    `GRANT SELECT,UPDATE(session_id) ON bop_identity.authentication_session TO ${f.role}`,
  );
  await f.admin.query(
    `GRANT SELECT(invitation_id,actor_id,membership_id,status,provider_evidence_id,created_at,expires_at,consumed_at,version),UPDATE(version) ON bop_identity.workforce_invitation TO ${f.role}`,
  );
  const run = async (account, work) => {
    const client = new pg.Client({
      ...context.clientConfig,
      user: account.role,
      password: account.password,
    });
    await client.connect();
    f.clients.add(client);
    const guards = [],
      finals = [],
      owners = [],
      observedAt = f.state.now;
    const tx = Object.freeze({ query: (sql, values) => client.query(sql, [...values]) });
    const registerBeforeCommit = async (actual, guard, final) => {
      assert.equal(actual, tx);
      guards.push(guard);
      finals.push(final);
    };
    const ownerOptions = {
      transaction: tx,
      configuration: directoryConfiguration,
      clock: f.clock,
      originalObservedAt: observedAt,
      originalValidUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
      hasher,
      envelopes,
      readCurrentProviderSubject: remote.readCurrentProviderSubject,
      registerBeforeCommit,
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await work({
        tx,
        ownerOptions,
        retain(owner) {
          owners.push(owner);
          return owner;
        },
      });
      for (const guard of guards) await guard();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const final of finals) final();
      await client.query("COMMIT");
      for (const owner of owners) owner.assertFinalized();
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      f.clients.delete(client);
      await client.end();
    }
  };
  const command = {
    profile: "PlatformActorDirectoryCommandV1",
    operation: "ImportActive",
    operationReference: id(6900),
    actorReference: id(1),
    expectedHead: null,
    subject,
    recordedByReference: id(6901),
    approvedByReference: id(6902),
    approvalReference: id(6903),
    reasonCode: "CONTROLLED_APPROVED_DIRECTORY",
  };
  await run(importer, async (h) => {
    const owner = h.retain(
      createPostgresPlatformActorDirectoryProvisioner({
        ...h.ownerOptions,
        operatorReference: command.recordedByReference,
        provisioningRoleName: importer.role,
        authority: {
          async hold(actual, input) {
            assert.equal(actual, h.tx);
            return {
              operatorReference: command.recordedByReference,
              approvedByReference: command.approvedByReference,
              approvalReference: command.approvalReference,
              validUntil: input.validUntil,
            };
          },
        },
        nextReference: () => id(++sequence),
        appendAudit: appendPlatformAuditRecordInTransaction,
      }),
    );
    return owner.provision(command);
  });
  const directories = new WeakMap();
  const sessions = createPostgresPlatformBrowserSessionStore({
    ...configuration,
    hasher,
    envelopes,
    now: () => f.state.now,
    transactions: {
      run: (work) =>
        run(sessionWriter, async (h) => {
          directories.set(
            h.tx,
            h.retain(createPostgresPlatformActorDirectorySource(h.ownerOptions)),
          );
          return work(h.tx);
        }),
    },
    currentActor: (tx, ref, authenticatedAt, observedAt) => {
      const directory = directories.get(tx);
      assert(directory);
      return directory.currentActor(tx, ref, authenticatedAt, observedAt);
    },
  });
  const createSession = async () => {
    const authenticatedAt = f.state.now,
      sessionReference = id(++sequence),
      credential = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    const actor = await run(sessionWriter, async (h) => {
      const directory = h.retain(createPostgresPlatformActorDirectorySource(h.ownerOptions));
      return directory.currentActor(h.tx, id(1), authenticatedAt, authenticatedAt);
    });
    // Controlled TOTP origin, then actual Session owner/encrypted persisted proof.
    const encryptedSecrets = await envelopes.encrypt(
      JSON.stringify({
        profile: "PlatformBrowserSessionV1",
        issuer: configuration.issuer,
        clientId: configuration.clientId,
        tokenBundle: "synthetic-native-refresh-bundle",
        csrf,
        mfa: {
          sessionReference,
          actorReference: id(1),
          method: "Totp",
          evidenceReference: id(++sequence),
          authorizationTransactionReference: id(++sequence),
          authenticatedAt,
          verifiedAt: authenticatedAt,
          validUntil: new Date(Date.parse(authenticatedAt) + 900000).toISOString(),
        },
      }),
      `${configuration.environment}:platform-session:${sessionReference}:${id(1)}`,
    );
    const record = await sessions.createSession({
      sessionReference,
      actor,
      policyCode: "Privileged",
      sessionSelectorHash: hasher.hash(credential),
      csrfSelectorHash: hasher.hash(csrf),
      encryptedSecrets,
      observedAt: authenticatedAt,
    });
    const saved = (
      await f.admin.query(
        "SELECT encrypted_secret,session_selector_hash FROM bop_identity.authentication_session WHERE session_id=$1",
        [sessionReference],
      )
    ).rows[0];
    assert(Buffer.isBuffer(saved.encrypted_secret));
    assert.equal(
      saved.encrypted_secret.toString("utf8").includes("synthetic-native-refresh-bundle"),
      false,
    );
    assert.equal(saved.encrypted_secret.toString("utf8").includes(csrf), false);
    assert.equal(saved.session_selector_hash.equals(Buffer.from(credential)), false);
    return { record, credential };
  };
  let selected = await createSession();
  return {
    configuration,
    hasher,
    envelopes,
    workforceCrypto,
    sessionWriterRole: sessionWriter.role,
    createSession,
    get credential() {
      return selected.credential;
    },
    get record() {
      return selected.record;
    },
    async rotate() {
      selected = await createSession();
    },
    get sdkCalls() {
      return sdkCalls;
    },
  };
}

/** Genuine binding import and immutable SQL, with controlled independent approval issuer. */
async function createNativeWorkforceBinding(f, context, operatorRuntime, workforce, plan) {
  f.mark("Actual independently approved Workforce binding import");
  const role = `brand_initial_binding_${context.runId}`,
    password = randomBytes(32).toString("hex");
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  await f.admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  f.extraRoles.push(role);
  await f.admin.query(
    `GRANT USAGE ON SCHEMA bop_identity,platform_audit,platform_helpers TO ${role}`,
  );
  await f.admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),bop_identity.platform_actor_directory_read(uuid,text,text,text),bop_identity.platform_actor_directory_import_capable(),bop_identity.workforce_account_binding_import_capable(),bop_identity.workforce_account_binding_read(uuid,text,text,text),bop_identity.workforce_account_invitation_read(uuid,uuid),bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text),platform_audit.matches_workforce_account_binding_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${role}`,
  );
  await f.admin.query(
    `GRANT INSERT,SELECT(snapshot_text,source_digest,recorded_by,operation_id) ON bop_identity.workforce_account_binding TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,UPDATE(session_id) ON bop_identity.authentication_session TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT(invitation_id,actor_id,membership_id,status,provider_evidence_id,version,created_at,expires_at,consumed_at),UPDATE(version) ON bop_identity.workforce_invitation TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
  );
  await f.admin.query(
    `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
  );
  await f.admin.query(
    `GRANT EXECUTE ON FUNCTION bop_identity.workforce_account_binding_import_capable(),bop_identity.workforce_account_binding_read(uuid,text,text,text),bop_identity.workforce_account_invitation_read(uuid,uuid) TO ${f.role}`,
  );
  const control = { onQuery: null },
    bindingKeys = generateKeyPairSync("ed25519"),
    approvalPath = path.join(path.dirname(f.approvalFiles.approvalPath), "binding-approval.json"),
    trustPath = path.join(path.dirname(f.approvalFiles.approvalPath), "binding-trust.json");
  let allocation = 12000,
    allocationCalls = 0,
    encryptionCalls = 0;
  const transactions = Object.freeze({
    async run(work) {
      const client = new pg.Client({ ...context.clientConfig, user: role, password });
      await client.connect();
      f.clients.add(client);
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const tx = Object.freeze({
          async query(sql, values = []) {
            if (control.onQuery) await control.onQuery({ client, sql, values });
            return client.query(sql, [...values]);
          },
        });
        const answer = await work(tx);
        await client.query("COMMIT");
        return answer;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        f.clients.delete(client);
        await client.end();
      }
    },
  });
  const envelopes = Object.freeze({
    async encrypt(...args) {
      encryptionCalls++;
      return workforce.envelopes.encrypt(...args);
    },
    decrypt: workforce.envelopes.decrypt,
  });
  const originalInvitation = (
    await f.admin.query(
      "SELECT membership_id,provider_evidence_id FROM bop_identity.workforce_invitation WHERE invitation_id=$1",
      [plan.recipients[0].invitationEvidenceReference],
    )
  ).rows[0];
  const command = parseWorkforceAccountBindingCommand({
    profile: "WorkforceAccountBindingImportV1",
    operationReference: id(12100),
    actorReference: id(6902),
    subject: "opaque-native-workforce-target",
    invitationReference: plan.recipients[0].invitationEvidenceReference,
    originalMembershipReference: originalInvitation.membership_id,
    providerEvidenceReference: originalInvitation.provider_evidence_id,
    recordedByReference: plan.operatorReference,
    approvedByReference: id(12101),
    approvalEvidenceReference: id(12102),
    reasonCode: "APPROVED_WORKFORCE_ACCOUNT_BINDING",
  });
  const signApproval = async (wanted = command, overrides = {}) => {
    const subjectHash = workforceAccountBindingSubjectHash(
        workforce.hasher,
        workforce.configuration,
        wanted.subject,
      ),
      original = workforceAccountBindingOriginal(wanted, subjectHash),
      intentDigest = workforceAccountBindingIntent(
        workforce.configuration,
        original,
        workforceAccountBindingCodec,
      );
    const payload = {
      profile: "WorkforceAccountBindingApprovalV1",
      purposeCode: "WORKFORCE_ACCOUNT_BINDING",
      configuration: workforce.configuration,
      operationReference: wanted.operationReference,
      actorReference: wanted.actorReference,
      intentDigest,
      operatorReference: wanted.recordedByReference,
      approvedByReference: wanted.approvedByReference,
      approvalEvidenceReference: wanted.approvalEvidenceReference,
      keyReference: id(12103),
      notBefore: f.state.now,
      validUntil: new Date(Date.parse(f.state.now) + 60000).toISOString(),
      signature: "A".repeat(86),
      ...overrides,
    };
    payload.signature = sign(
      null,
      Buffer.from(workforceAccountBindingApprovalSigningBytes(payload)),
      bindingKeys.privateKey,
    ).toString("base64url");
    const trust = {
      profile: "WorkforceAccountBindingTrustV1",
      keys: [
        {
          keyReference: payload.keyReference,
          approvedByReference: payload.approvedByReference,
          configuration: payload.configuration,
          purposeCode: payload.purposeCode,
          notBefore: payload.notBefore,
          validUntil: payload.validUntil,
          publicKeySpki: bindingKeys.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64url"),
        },
      ],
      withdrawnApprovalEvidenceReferences: [],
    };
    await writeFile(approvalPath, JSON.stringify(payload), { mode: 0o600 });
    await writeFile(trustPath, JSON.stringify(trust), { mode: 0o600 });
    return {
      async withdraw() {
        await writeFile(
          trustPath,
          JSON.stringify({
            ...trust,
            withdrawnApprovalEvidenceReferences: [payload.approvalEvidenceReference],
          }),
          { mode: 0o600 },
        );
      },
    };
  };
  const importerFor = () =>
    createAuthenticatedWorkforceAccountBindingImport({
      transactions,
      clock: f.clock,
      configuration: workforce.configuration,
      hasher: workforce.hasher,
      envelopes,
      provisioningRoleName: role,
      nextReference(kind) {
        assert.equal(kind, "Audit");
        allocationCalls++;
        return id(++allocation);
      },
      approvalFiles: { approvalPath, trustPath },
      operator: {
        configuration: operatorRuntime.configuration,
        hasher: operatorRuntime.hasher,
        envelopes: operatorRuntime.envelopes,
        cookie: operatorRuntime.credential,
      },
    });
  const importer = importerFor();
  const counts = async () =>
    (
      await f.admin.query(`SELECT
    (SELECT count(*)::int FROM bop_identity.workforce_account_binding) bindings,
    (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record WHERE purpose_code='WORKFORCE_ACCOUNT_BINDING') audits`)
    ).rows[0];
  for (const wrongField of ["actorReference", "approvedByReference", "approvalEvidenceReference"]) {
    f.mark(`Signed binding approval mismatched ${wrongField}`);
    await signApproval(command, { [wrongField]: id(12190) });
    await assert.rejects(importer.execute(command));
    assert.deepEqual(await counts(), { bindings: 0, audits: 0 });
  }
  for (const field of [
    "originalMembershipReference",
    "providerEvidenceReference",
    "invitationReference",
  ]) {
    f.mark(`Actual invitation refuses independently signed wrong binding ${field}`);
    const invalid = parseWorkforceAccountBindingCommand({ ...command, [field]: id(12199) });
    await signApproval(invalid);
    await assert.rejects(importer.execute(invalid));
    assert.deepEqual(await counts(), { bindings: 0, audits: 0 });
  }
  f.mark("Late independent binding approval withdrawal rolls back actual binding");
  const approval = await signApproval();
  let injected = false;
  control.onQuery = async ({ sql }) => {
    if (!injected && sql.startsWith("INSERT INTO bop_identity.workforce_account_binding")) {
      injected = true;
      await approval.withdraw();
    }
  };
  await assert.rejects(importer.execute(command));
  assert(injected);
  assert.deepEqual(await counts(), { bindings: 0, audits: 0 });
  control.onQuery = null;
  await signApproval();
  f.mark("Concurrent approved binding imports share one immutable original");
  let holderPid, waiterPid, releaseHolder, sawHold, sawAttempt;
  const held = new Promise((resolve) => {
    sawHold = resolve;
  });
  const attempted = new Promise((resolve) => {
    sawAttempt = resolve;
  });
  const release = new Promise((resolve) => {
    releaseHolder = resolve;
  });
  control.onQuery = async ({ client, sql }) => {
    if (
      holderPid === undefined &&
      sql.startsWith("INSERT INTO bop_identity.workforce_account_binding")
    ) {
      holderPid = client.processID;
      sawHold();
      await release;
    } else if (
      holderPid !== undefined &&
      client.processID !== holderPid &&
      sql.startsWith("SELECT bop_identity.workforce_account_binding_import_admit")
    ) {
      waiterPid = client.processID;
      sawAttempt();
    }
  };
  const allocatedBefore = allocationCalls,
    encryptedBefore = encryptionCalls;
  const firstRace = importer.execute(command);
  await Promise.race([
    held,
    firstRace.then(() => {
      throw Error("binding import was not held");
    }),
  ]);
  const secondRace = importerFor().execute(command);
  const both = Promise.all([firstRace, secondRace]);
  void both.catch(() => undefined);
  try {
    await Promise.race([
      attempted,
      secondRace.then(() => {
        throw Error("binding lock was not attempted");
      }),
    ]);
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      const blockers = (await f.admin.query("SELECT pg_blocking_pids($1) blockers", [waiterPid]))
        .rows[0].blockers;
      blocked = blockers.includes(holderPid);
    }
    assert.equal(blocked, true);
  } finally {
    releaseHolder();
    control.onQuery = null;
  }
  const [applied, racedReplay] = await both;
  assert.deepEqual(racedReplay, applied);
  assert.equal(allocationCalls - allocatedBefore, 1);
  assert.equal(encryptionCalls - encryptedBefore, 1);
  assert.deepEqual(await counts(), { bindings: 1, audits: 1 });
  const stored = (
    await f.admin.query(
      "SELECT snapshot_text,subject_hash,source_digest FROM bop_identity.workforce_account_binding WHERE actor_id=$1",
      [command.actorReference],
    )
  ).rows[0];
  const binding = parseWorkforceAccountBinding(
    JSON.parse(stored.snapshot_text),
    workforceAccountBindingCodec,
  );
  assert.equal(binding.sourceDigest, stored.source_digest);
  assert.equal(binding.actorReference, applied.actorReference);
  assert.equal(binding.operationReference, applied.operationReference);
  assert.equal(binding.intentDigest, applied.intentDigest);
  assert.equal(binding.auditReference, applied.auditReference);
  assert.equal(binding.recordedAt, applied.recordedAt);
  assert(!stored.snapshot_text.includes(command.subject));
  assert.notEqual(stored.subject_hash, command.subject);
  assert.equal(
    stored.subject_hash,
    workforceAccountBindingSubjectHash(workforce.hasher, workforce.configuration, command.subject),
  );
  const audited = (
    await f.admin.query(
      "SELECT actor_id,purpose_code,action_code,target_type,target_id,operation_id FROM platform_audit.platform_actor_audit_record WHERE audit_id=$1",
      [binding.auditReference],
    )
  ).rows[0];
  assert.deepEqual(audited, {
    actor_id: command.recordedByReference,
    purpose_code: "WORKFORCE_ACCOUNT_BINDING",
    action_code: "WORKFORCE_ACCOUNT_BOUND",
    target_type: "WorkforceAccountBinding",
    target_id: command.actorReference,
    operation_id: command.operationReference,
  });
  const before = [allocationCalls, encryptionCalls];
  const replay = await importer.execute(command);
  assert.deepEqual(replay, applied);
  assert.deepEqual([allocationCalls, encryptionCalls], before);
  assert.deepEqual(await counts(), { bindings: 1, audits: 1 });
  const changed = parseWorkforceAccountBindingCommand({
    ...command,
    subject: "opaque-native-workforce-other",
  });
  await signApproval(changed);
  await assert.rejects(importer.execute(changed));
  assert.deepEqual([allocationCalls, encryptionCalls], before);
  assert.deepEqual(await counts(), { bindings: 1, audits: 1 });
  await signApproval();
  for (const sql of [
    "UPDATE bop_identity.workforce_account_binding SET reason_code=reason_code",
    "DELETE FROM bop_identity.workforce_account_binding",
    "TRUNCATE bop_identity.workforce_account_binding",
  ])
    await assert.rejects(f.admin.query(sql), (error) => error.code === "23514");
  // Coherent new raw tuple is offered through the actual authorized role. Its
  // missing/wrong/old Audit must fail the real deferred completion, not a parser stub.
  const invitation = createWorkforceInvitation({
    invitationReference: id(12200),
    actorReference: id(12201),
    inviterActorReference: command.recordedByReference,
    membershipReference: id(12202),
    storeAssignmentReferences: [],
    emailDigest: randomBytes(32).toString("hex"),
    selectorHash: randomBytes(32).toString("hex"),
    status: "Accepted",
    providerEvidenceReference: id(12203),
    createdAt: new Date(Date.parse(f.state.now) - 3600000).toISOString(),
    expiresAt: new Date(Date.parse(f.state.now) + 23 * 3600000).toISOString(),
    consumedAt: f.state.now,
    version: 2,
  });
  await f.admin.query(
    `INSERT INTO bop_identity.workforce_invitation(invitation_id,actor_id,inviter_actor_id,membership_id,email_digest,selector_hash,status,provider_evidence_id,created_at,expires_at,consumed_at,version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      invitation.invitationReference,
      invitation.actorReference,
      invitation.inviterActorReference,
      invitation.membershipReference,
      Buffer.from(invitation.emailDigest, "hex"),
      Buffer.from(invitation.selectorHash, "hex"),
      invitation.status,
      invitation.providerEvidenceReference,
      invitation.createdAt,
      invitation.expiresAt,
      invitation.consumedAt,
      invitation.version,
    ],
  );
  const rawCommand = parseWorkforceAccountBindingCommand({
    ...command,
    operationReference: id(12204),
    actorReference: invitation.actorReference,
    subject: "opaque-native-workforce-other",
    invitationReference: invitation.invitationReference,
    originalMembershipReference: invitation.membershipReference,
    providerEvidenceReference: invitation.providerEvidenceReference,
  });
  const rawHash = workforceAccountBindingSubjectHash(
      workforce.hasher,
      workforce.configuration,
      rawCommand.subject,
    ),
    rawOriginal = workforceAccountBindingOriginal(rawCommand, rawHash);
  const { sourceDigest: initialSourceDigest, ...bindingBody } = binding;
  void initialSourceDigest;
  for (const mode of ["missing", "wrongTarget", "oldTransaction"]) {
    const raw = buildWorkforceAccountBinding(
      {
        ...bindingBody,
        actorReference: rawCommand.actorReference,
        subjectHash: rawHash,
        encryptedSubject: await workforce.envelopes.encrypt(
          JSON.stringify({ subject: rawCommand.subject }),
          `${workforce.configuration.environment}:workforce-account-subject:${rawCommand.actorReference}:${workforce.configuration.issuer}`,
        ),
        invitationReference: rawCommand.invitationReference,
        originalMembershipReference: rawCommand.originalMembershipReference,
        providerEvidenceReference: rawCommand.providerEvidenceReference,
        operationReference: rawCommand.operationReference,
        intentDigest: workforceAccountBindingIntent(
          workforce.configuration,
          rawOriginal,
          workforceAccountBindingCodec,
        ),
        originalCommand: rawOriginal,
        auditReference: mode === "oldTransaction" ? id(12211) : id(12210),
        recordedAt: f.state.now,
      },
      workforceAccountBindingCodec,
    );
    const auditInput = {
      auditReference: raw.auditReference,
      actorReference: raw.recordedByReference,
      purposeCode: "WORKFORCE_ACCOUNT_BINDING",
      actionCode: "WORKFORCE_ACCOUNT_BOUND",
      targetType: "WorkforceAccountBinding",
      targetReference: raw.actorReference,
      operationReference: raw.operationReference,
      intentDigest: raw.intentDigest,
      occurredAt: raw.recordedAt,
      reasonCode: raw.reasonCode,
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    };
    if (mode === "oldTransaction")
      await transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose','WORKFORCE_ACCOUNT_BINDING',true)",
          [raw.recordedByReference],
        );
        await appendPlatformAuditRecordInTransaction(tx, auditInput);
      });
    await assert.rejects(
      transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose','WORKFORCE_ACCOUNT_BINDING',true),set_config('bop.workforce_account_purpose','WORKFORCE_ACCOUNT_BINDING',true),set_config('bop.workforce_account_environment',$2,true),set_config('bop.workforce_account_issuer',$3,true),set_config('bop.workforce_account_actor_id',$4,true),set_config('bop.workforce_account_subject_hash',$5,true)",
          [
            raw.recordedByReference,
            workforce.configuration.environment,
            workforce.configuration.issuer,
            raw.actorReference,
            raw.subjectHash,
          ],
        );
        await tx.query("SELECT bop_identity.workforce_account_binding_import_admit($1,$2,$3,$4)", [
          raw.recordedByReference,
          raw.actorReference,
          raw.operationReference,
          raw.subjectHash,
        ]);
        await tx.query(
          `INSERT INTO bop_identity.workforce_account_binding(actor_id,environment,issuer,subject_hash,invitation_id,original_membership_id,provider_evidence_id,operation_id,recorded_by,approved_by,approval_id,reason_code,intent_digest,audit_id,recorded_at,source_digest,snapshot_text)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            raw.actorReference,
            workforce.configuration.environment,
            workforce.configuration.issuer,
            raw.subjectHash,
            raw.invitationReference,
            raw.originalMembershipReference,
            raw.providerEvidenceReference,
            raw.operationReference,
            raw.recordedByReference,
            raw.approvedByReference,
            raw.approvalEvidenceReference,
            raw.reasonCode,
            raw.intentDigest,
            raw.auditReference,
            raw.recordedAt,
            raw.sourceDigest,
            canonicalizeRfc8785(raw),
          ],
        );
        if (mode === "wrongTarget")
          await appendPlatformAuditRecordInTransaction(tx, {
            ...auditInput,
            targetReference: binding.actorReference,
          });
      }),
      (error) => error.code === "23514",
    );
    assert.deepEqual(await counts(), { bindings: 1, audits: mode === "oldTransaction" ? 2 : 1 });
  }
  // The second tuple above has only exercised refused raw writes. Establish
  // its actual account through the same independently signed public importer.
  f.mark("Actual independently approved second Workforce binding");
  await signApproval(rawCommand);
  const reviewerResult = await importer.execute(rawCommand);
  const reviewerStored = (
    await f.admin.query(
      "SELECT snapshot_text FROM bop_identity.workforce_account_binding WHERE actor_id=$1",
      [rawCommand.actorReference],
    )
  ).rows[0];
  const reviewerBinding = parseWorkforceAccountBinding(
    JSON.parse(reviewerStored.snapshot_text),
    workforceAccountBindingCodec,
  );
  assert.equal(reviewerBinding.actorReference, reviewerResult.actorReference);
  assert.equal(reviewerBinding.auditReference, reviewerResult.auditReference);
  assert.equal(reviewerBinding.originalMembershipReference, invitation.membershipReference);
  assert.deepEqual(await counts(), { bindings: 2, audits: 3 });
  await verifyWorkforceAccountBindingAcceptance(context, {
    fixture: f,
    workforce,
    importerTransactions: transactions,
  });
  return { binding, command, reviewer: { binding: reviewerBinding, command: rawCommand } };
}

/** Production authenticated initializer with actual Directory/encrypted Session,
 * Cognito-status adapter, historical invitation reader and signed relationship
 * files and approved immutable Workforce binding. External mapping/relationship issuer facts, Provider/TOTP origin and earlier
 * invitation acceptance remain controlled inputs. No new Brand/Member/policy success rows seeded. */
export async function exerciseBrandInitialProvisioning(context) {
  const f = await prepare(context);
  const participantState = {
    operatorEnabled: true,
    membersEnabled: true,
    memberCalls: 0,
    disabledMemberCalls: 0,
    reenter: false,
    caughtReentry: false,
  };
  const operatorAt = f.state.now;
  const operatorRuntime = await createNativeOperator(f, context, participantState).catch(
    async (error) => {
      await f.close();
      throw f.failure(error);
    },
  );
  const relationshipKeys = generateKeyPairSync("ed25519"),
    relationshipPath = path.join(path.dirname(f.approvalFiles.approvalPath), "relationship.json"),
    reviewerRelationshipPath = path.join(
      path.dirname(f.approvalFiles.approvalPath),
      "reviewer-relationship.json",
    ),
    relationshipTrustPath = path.join(
      path.dirname(f.approvalFiles.approvalPath),
      "relationship-trust.json",
    );
  const writeRelationship = async (plan, overrides = {}) => {
    assert(plan.recipients.length >= 1 && plan.recipients.length <= 2);
    const statements = plan.recipients.map((recipient) => {
      const statement = {
        profile: "WorkforceRelationshipQualificationV1",
        purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
        environmentReference: plan.environmentReference,
        issuerReference: id(6950),
        keyReference: id(6951),
        actorReference: recipient.actorReference,
        brandReference: plan.brand.brandReference,
        workforceRelationshipReference: recipient.workforceRelationshipReference,
        relationshipEvidenceReference: recipient.relationshipEvidenceReference,
        revision: 1,
        status: "Current",
        effectiveFrom: operatorAt,
        effectiveUntil: recipient.membershipEffectiveUntil,
        verifiedAt: f.state.now,
        validUntil: recipient.membershipEffectiveUntil,
        signature: "A".repeat(86),
        ...overrides,
      };
      statement.signature = sign(
        null,
        Buffer.from(workforceRelationshipQualificationSigningBytes(statement)),
        relationshipKeys.privateKey,
      ).toString("base64url");
      return statement;
    });
    const statement = statements[0];
    const trust = {
      profile: "WorkforceRelationshipQualificationTrustV1",
      keys: [
        {
          keyReference: statement.keyReference,
          issuerReference: statement.issuerReference,
          environmentReference: statement.environmentReference,
          purposeCode: statement.purposeCode,
          brandReferences: [statement.brandReference],
          notBefore: operatorAt,
          validUntil: statement.validUntil,
          publicKeySpki: relationshipKeys.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64url"),
        },
      ],
      withdrawnEvidenceReferences: [],
    };
    for (const [index, value] of statements.entries()) {
      const recipient = plan.recipients[index];
      assert([id(6902), id(12201)].includes(recipient.actorReference));
      await writeFile(
        recipient.actorReference === id(6902) ? relationshipPath : reviewerRelationshipPath,
        JSON.stringify(value),
        { mode: 0o600 },
      );
    }
    await writeFile(relationshipTrustPath, JSON.stringify(trust), { mode: 0o600 });
    return {
      statement,
      async withdraw() {
        await writeFile(
          relationshipTrustPath,
          JSON.stringify({
            ...trust,
            withdrawnEvidenceReferences: [statement.relationshipEvidenceReference],
          }),
          { mode: 0o600 },
        );
      },
    };
  };
  let currentRelationship;
  const workforce = Object.freeze({
    relationships: Object.freeze({
      trustPath: relationshipTrustPath,
      qualifications: Object.freeze([
        Object.freeze({
          actorReference: id(6902),
          qualificationPath: relationshipPath,
        }),
        Object.freeze({ actorReference: id(12201), qualificationPath: reviewerRelationshipPath }),
      ]),
    }),
    configuration: Object.freeze({
      environment: "synthetic",
      issuer: operatorRuntime.configuration.issuer,
      clientIds: Object.freeze(["syntheticworkforce"]),
    }),
    hasher: operatorRuntime.workforceCrypto.hasher,
    envelopes: operatorRuntime.workforceCrypto.envelopes,
  });
  const serviceFor = () =>
    createAuthenticatedBrandInitialProvisioning({
      transactions: f.transactions,
      clock: f.clock,
      approvalFiles: f.approvalFiles,
      operator: {
        configuration: operatorRuntime.configuration,
        hasher: operatorRuntime.hasher,
        envelopes: operatorRuntime.envelopes,
        cookie: operatorRuntime.credential,
      },
      workforce,
    });
  let service = serviceFor();
  participantState.onWorkforceRead = async () => {
    if (participantState.reenter) {
      participantState.reenter = false;
      assert(participantState.reentryPlan);
      await service.execute(participantState.reentryPlan).catch(() => {
        participantState.caughtReentry = true;
      });
    }
  };
  const build = (n) =>
    parseBrandInitialProvisioningPlan({
      profile: "BrandInitialProvisioningPlanV1",
      purposeCode,
      environmentReference: id(2),
      operationReference: id(n + 1),
      operatorReference: id(1),
      approvedByReference: id(3),
      approvalEvidenceReference: id(n + 2),
      brand: {
        brandReference: id(n),
        code: `NATIVE_${n}`,
        displayName: "Synthetic initial Brand",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
      },
      brandAuditReference: id(n + 3),
      membershipAuditReference: id(n + 4),
      policyAuditReference: id(n + 5),
      policySnapshotReference: id(n + 6),
      recipients: [
        {
          actorReference: id(6902),
          membershipReference: id(n + 8),
          workforceRelationshipReference: id(n + 9),
          relationshipEvidenceReference: id(n + 10),
          invitationEvidenceReference: id(n + 11),
          membershipEffectiveUntil: new Date(Date.parse(operatorAt) + 3600000).toISOString(),
          roleEffectiveUntil: new Date(Date.parse(operatorAt) + 3600000).toISOString(),
          roleReference: id(n + 12),
          roleCode: "owner",
          assignmentReference: id(n + 13),
          grants: actions.map((action, index) => ({
            grantReference: id(n + 20 + index),
            permissionReference: id(100 + index),
            action,
          })),
        },
      ],
    });
  const seedInvitations = async (plan) => {
    for (const recipient of plan.recipients) {
      if (recipient.actorReference === id(12201)) {
        const original = (
          await f.admin.query(
            "SELECT actor_id,membership_id,provider_evidence_id,status FROM bop_identity.workforce_invitation WHERE invitation_id=$1",
            [recipient.invitationEvidenceReference],
          )
        ).rows[0];
        assert.deepEqual(original, {
          actor_id: id(12201),
          membership_id: id(12202),
          provider_evidence_id: id(12203),
          status: "Accepted",
        });
        assert.notEqual(original.membership_id, recipient.membershipReference);
        continue;
      }
      const originalMembershipReference = id(
        Number.parseInt(recipient.membershipReference.slice(-12), 16) + 40,
      );
      assert.notEqual(originalMembershipReference, recipient.membershipReference);
      const createdAt = new Date(Date.parse(operatorAt) - 172800000).toISOString();
      const invitation = createWorkforceInvitation({
        invitationReference: recipient.invitationEvidenceReference,
        actorReference: recipient.actorReference,
        inviterActorReference: id(6901),
        membershipReference: originalMembershipReference,
        storeAssignmentReferences: [],
        emailDigest: randomBytes(32).toString("hex"),
        selectorHash: randomBytes(32).toString("hex"),
        status: "Accepted",
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 86400000).toISOString(),
        consumedAt: new Date(Date.parse(createdAt) + 3600000).toISOString(),
        providerEvidenceReference: id(
          Number.parseInt(recipient.membershipReference.slice(-12), 16) + 41,
        ),
        version: 2,
      });
      // Explicit historical accepted onboarding fixture only. Its original
      // Membership pointer is never used as the new Brand Membership.
      await f.admin.query(
        `INSERT INTO bop_identity.workforce_invitation(invitation_id,actor_id,inviter_actor_id,membership_id,email_digest,selector_hash,status,provider_evidence_id,created_at,expires_at,consumed_at,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(invitation_id) DO NOTHING`,
        [
          invitation.invitationReference,
          invitation.actorReference,
          invitation.inviterActorReference,
          invitation.membershipReference,
          Buffer.from(invitation.emailDigest, "hex"),
          Buffer.from(invitation.selectorHash, "hex"),
          invitation.status,
          invitation.providerEvidenceReference,
          invitation.createdAt,
          invitation.expiresAt,
          invitation.consumedAt,
          invitation.version,
        ],
      );
    }
  };
  const approve = async (plan) => {
    await seedInvitations(plan);
    currentRelationship = await writeRelationship(plan);
    return await f.writeApproval(
      {
        environmentReference: plan.environmentReference,
        operationReference: plan.operationReference,
        brandReference: plan.brand.brandReference,
        planDigest: hashBrandInitialProvisioningPlan(plan),
        operatorReference: plan.operatorReference,
      },
      plan.approvedByReference,
      plan.approvalEvidenceReference,
    );
  };
  const absent = {
    brands: 0,
    operations: 0,
    memberships: 0,
    policies: 0,
    roles: 0,
    assignments: 0,
    grants: 0,
    audits: 0,
  };
  try {
    f.mark("Minimum privileges");
    const own = (
      await f.admin.query(
        "SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1",
        [f.role],
      )
    ).rows[0];
    assert.equal(own.rolsuper, false);
    assert.equal(own.rolbypassrls, false);
    assert.equal(own.rolcreatedb, false);
    assert.equal(own.rolcreaterole, false);
    const identityAcl = (
      await f.admin.query(
        `SELECT
      has_column_privilege($1,'bop_identity.workforce_invitation','email_digest','SELECT') email,
      has_column_privilege($1,'bop_identity.workforce_invitation','selector_hash','SELECT') selector,
      has_table_privilege($1,'bop_identity.platform_actor_directory_revision','SELECT') directory_private,
      has_column_privilege($1,'bop_identity.authentication_session','status','UPDATE') session_writer,
      has_table_privilege($1,'bop_identity.workforce_account_binding','SELECT') account_private,
      has_table_privilege($1,'bop_identity.workforce_account_binding','INSERT') account_writer`,
        [f.role],
      )
    ).rows[0];
    assert.deepEqual(identityAcl, {
      email: false,
      selector: false,
      directory_private: false,
      session_writer: false,
      account_private: false,
      account_writer: false,
    });
    const privilege = (
      await f.admin.query(
        "SELECT has_table_privilege($1,'bop_membership.store_assignment','INSERT') store_write,has_column_privilege($1,'bop_membership.membership','lifecycle','UPDATE') member_regrant,has_table_privilege($1,'bop_permission.permission_definition','INSERT') definition_write",
        [f.role],
      )
    ).rows[0];
    assert.deepEqual(privilege, {
      store_write: false,
      member_regrant: false,
      definition_write: false,
    });
    let plan = build(1000);
    await approve(plan);
    const boundAccount = await createNativeWorkforceBinding(
      f,
      context,
      operatorRuntime,
      workforce,
      plan,
    );
    plan = parseBrandInitialProvisioningPlan({
      ...plan,
      recipients: [
        ...plan.recipients,
        {
          ...plan.recipients[0],
          actorReference: boundAccount.reviewer.binding.actorReference,
          invitationEvidenceReference: boundAccount.reviewer.binding.invitationReference,
          membershipReference: id(13001),
          workforceRelationshipReference: id(13002),
          relationshipEvidenceReference: id(13003),
          roleReference: id(13004),
          roleCode: "brand_admin",
          assignmentReference: id(13005),
          grants: actions.map((action, index) => ({
            action,
            permissionReference: id(100 + index),
            grantReference: id(13010 + index),
          })),
        },
      ],
    });
    f.mark("Executable first-creation private installation");
    const writePrivateJson = (name, value) =>
      writeFile(path.join(f.directory, name), JSON.stringify(value), { mode: 0o600 });
    await writePrivateJson("installation.json", {
      schemaVersion: 1,
      environment: "InternalTest",
      database: context.clientConfig.database,
      port: Number(context.clientConfig.port),
      roles: { api: f.role, worker: operatorRuntime.sessionWriterRole },
    });
    await writeFile(path.join(f.directory, "api-password"), f.password, { mode: 0o600 });
    await writeFile(path.join(f.directory, "operator-cookie"), operatorRuntime.credential, {
      mode: 0o600,
    });
    await writePrivateJson("brand-initial-provisioning.json", {
      schemaVersion: 1,
      environment: "InternalTest",
      database: context.clientConfig.database,
      operator: {
        configuration: operatorRuntime.configuration,
        credentialsFile: "operator-credentials.json",
        cookieFile: "operator-cookie",
      },
      workforce: {
        configuration: workforce.configuration,
        credentialsFile: "workforce-credentials.json",
        relationships: {
          trustPath: "relationship-trust.json",
          qualifications: [
            {
              actorReference: plan.recipients[0].actorReference,
              qualificationPath: "relationship.json",
            },
          ],
        },
      },
      approvalFiles: { approvalPath: "approval.json", trustPath: "trust.json" },
      planFile: "cli-plan.json",
    });
    // Binding has one immutable historic invitation. This independently signed
    // new Brand plan uses that same evidence, never a newly invented binding.
    const cliCandidate = build(12000);
    const cliPlan = parseBrandInitialProvisioningPlan({
      ...cliCandidate,
      recipients: [
        {
          ...cliCandidate.recipients[0],
          invitationEvidenceReference: plan.recipients[0].invitationEvidenceReference,
        },
      ],
    });
    await approve(cliPlan);
    await writePrivateJson("cli-plan.json", cliPlan);
    assert.deepEqual(await f.counts(cliPlan.brand.brandReference), absent);
    assert.deepEqual(await runInternalBrandInitialProvisioning({ directory: f.directory }), {
      environment: "InternalTest",
      status: "Applied",
    });
    const cliCounts = {
      brands: 1,
      operations: 1,
      memberships: 1,
      policies: 1,
      roles: 1,
      assignments: 1,
      grants: 6,
      audits: 3,
    };
    assert.deepEqual(await f.counts(cliPlan.brand.brandReference), cliCounts);
    const cliOriginal = (
      await f.admin.query(
        "SELECT operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification,artifact_snapshot_json FROM bop_tenant.brand_admin_operation WHERE brand_id=$1",
        [cliPlan.brand.brandReference],
      )
    ).rows;
    const cliLater = new Date().toISOString();
    await f.admin.query(
      "UPDATE bop_membership.membership SET lifecycle='Ended',version=2,updated_at=$2 WHERE brand_id=$1",
      [cliPlan.brand.brandReference, cliLater],
    );
    await f.admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2,updated_at=$2 WHERE brand_id=$1",
      [cliPlan.brand.brandReference, cliLater],
    );
    participantState.membersEnabled = false;
    await rm(relationshipPath);
    const cliMemberCalls = participantState.memberCalls;
    assert.deepEqual(await runInternalBrandInitialProvisioning({ directory: f.directory }), {
      environment: "InternalTest",
      status: "AlreadyApplied",
    });
    assert.equal(participantState.memberCalls, cliMemberCalls);
    assert.deepEqual(await f.counts(cliPlan.brand.brandReference), cliCounts);
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification,artifact_snapshot_json FROM bop_tenant.brand_admin_operation WHERE brand_id=$1",
          [cliPlan.brand.brandReference],
        )
      ).rows,
      cliOriginal,
    );
    assert.equal(
      (
        await f.admin.query("SELECT lifecycle FROM bop_membership.membership WHERE brand_id=$1", [
          cliPlan.brand.brandReference,
        ])
      ).rows[0].lifecycle,
      "Ended",
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int n FROM bop_permission.permission_grant WHERE brand_id=$1 AND lifecycle='Active'",
          [cliPlan.brand.brandReference],
        )
      ).rows[0].n,
      0,
    );
    const refusedCandidate = build(14000);
    const refusedCliPlan = parseBrandInitialProvisioningPlan({
      ...refusedCandidate,
      recipients: [
        {
          ...refusedCandidate.recipients[0],
          invitationEvidenceReference: plan.recipients[0].invitationEvidenceReference,
        },
      ],
    });
    await approve(refusedCliPlan);
    await writePrivateJson("cli-plan.json", refusedCliPlan);
    f.mark("Executable current account refusal rolls back and closes Pool");
    const beforeRefusedMemberCalls = participantState.memberCalls;
    await assert.rejects(runInternalBrandInitialProvisioning({ directory: f.directory }), {
      message: "INTERNAL_BRAND_INITIAL_PROVISIONING_UNAVAILABLE",
    });
    assert(participantState.memberCalls > beforeRefusedMemberCalls);
    assert.deepEqual(await f.counts(refusedCliPlan.brand.brandReference), absent);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename=$2",
          [context.clientConfig.database, f.role],
        )
      ).rows[0].n,
      0,
    );
    participantState.membersEnabled = true;
    await approve(plan);
    for (const wrongField of ["approvedByReference", "approvalEvidenceReference"]) {
      f.mark(`Valid signed envelope wrong plan ${wrongField}`);
      const expected = {
        environmentReference: plan.environmentReference,
        operationReference: plan.operationReference,
        brandReference: plan.brand.brandReference,
        planDigest: hashBrandInitialProvisioningPlan(plan),
        operatorReference: plan.operatorReference,
      };
      const approvedBy = wrongField === "approvedByReference" ? id(850) : plan.approvedByReference;
      const evidence =
        wrongField === "approvalEvidenceReference" ? id(851) : plan.approvalEvidenceReference;
      // Configure the real trusted key for the envelope's actual signer. Its
      // complete plan digest is unchanged and its Ed25519 signature is genuine.
      await f.writeApproval(expected, approvedBy, evidence);
      const verifier = createFileBrandProvisioningApprovalSource({
        ...f.approvalFiles,
        clock: () => f.state.now,
      });
      const verified = await verifier.withApproval(expected, async (lease) => {
        assert.equal(lease.approval.approvedByReference, approvedBy);
        assert.equal(lease.approval.approvalEvidenceReference, evidence);
        assert.equal(lease.approval.planDigest, expected.planDigest);
        await lease.assertCurrent();
        lease.assertFinalized();
        return true;
      });
      assert.equal(verified, true);
      const committed = f.state.committed,
        rolledBack = f.state.rolledBack,
        operatorCalls = operatorRuntime.sdkCalls,
        memberCalls = participantState.memberCalls;
      await assert.rejects(service.execute(plan));
      assert.deepEqual(await f.counts(plan.brand.brandReference), absent);
      assert.equal(f.state.committed, committed);
      assert.equal(f.state.rolledBack, rolledBack);
      assert.equal(operatorRuntime.sdkCalls, operatorCalls);
      assert.equal(participantState.memberCalls, memberCalls);
    }
    f.mark("Actual initial CreateBrand/Membership/policy/Audit");
    await approve(plan);
    assert.deepEqual(await f.counts(plan.brand.brandReference), absent);
    const first = await service.execute(plan);
    assert.equal(first.profile, "BrandInitialProvisioningResultV1");
    assert.equal(first.status, "Applied");
    assert.equal(first.operation.artifact.lifecycle, "Draft");
    assert.equal(first.operation.artifact.version, 1);
    assert.equal(first.operation.intentDigest, hashBrandInitialProvisioningPlan(plan));
    assert.deepEqual(await f.counts(plan.brand.brandReference), {
      brands: 1,
      operations: 1,
      memberships: 2,
      policies: 1,
      roles: 2,
      assignments: 2,
      grants: 12,
      audits: 3,
    });
    const facts = (
      await f.admin.query(
        "SELECT m.lifecycle,m.version,m.effective_from,m.created_at,m.updated_at,m.workforce_relationship_reference FROM bop_membership.membership m WHERE brand_id=$1 AND actor_id=$2",
        [plan.brand.brandReference, plan.recipients[0].actorReference],
      )
    ).rows[0];
    assert.equal(facts.lifecycle, "Active");
    assert.equal(facts.version, 1);
    assert.equal(facts.effective_from.toISOString(), operatorAt);
    assert.equal(facts.created_at.toISOString(), operatorAt);
    assert.equal(facts.updated_at.toISOString(), operatorAt);
    assert.equal(
      facts.workforce_relationship_reference,
      plan.recipients[0].workforceRelationshipReference,
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int n FROM bop_permission.role_assignment WHERE brand_id=$1 AND store_id IS NOT NULL",
          [plan.brand.brandReference],
        )
      ).rows[0].n,
      0,
    );
    const auditRows = (
      await f.admin.query(
        "SELECT actor_reference,store_id,correlation_id FROM platform_audit.audit_record WHERE brand_id=$1 ORDER BY chain_sequence",
        [plan.brand.brandReference],
      )
    ).rows;
    assert.equal(auditRows.length, 3);
    for (const row of auditRows) {
      assert.equal(row.actor_reference, plan.operatorReference);
      assert.equal(row.store_id, null);
      assert.equal(row.correlation_id, plan.operationReference);
    }
    const historical = (
      await f.admin.query(
        "SELECT membership_id,expires_at,status FROM bop_identity.workforce_invitation WHERE invitation_id=$1",
        [plan.recipients[0].invitationEvidenceReference],
      )
    ).rows[0];
    assert.equal(historical.status, "Accepted");
    assert(historical.expires_at.toISOString() < operatorAt);
    assert.notEqual(historical.membership_id, plan.recipients[0].membershipReference);
    assert(f.state.invitationReads > 0);
    assert(operatorRuntime.sdkCalls > 0);
    await verifyPlatformTemplatePublishingPersistence(context, {
      now: f.clock.now,
      hasher: operatorRuntime.hasher,
      envelopes: operatorRuntime.envelopes,
      onPublished: (publishedTemplate) =>
        exerciseInitialBrandWorkforceLogin(f, {
          context,
          plan,
          workforce,
          boundAccount,
          participantState,
          publishedTemplate,
        }),
    });
    f.mark("Immutable original retry cannot recreate revoked Membership/grants");
    const later = new Date(Date.parse(f.state.now) + 1000).toISOString();
    f.state.now = later;
    await f.admin.query(
      "UPDATE bop_membership.membership SET lifecycle='Ended',version=2,updated_at=$2 WHERE brand_id=$1",
      [plan.brand.brandReference, later],
    );
    await f.admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2,updated_at=$2 WHERE brand_id=$1",
      [plan.brand.brandReference, later],
    );
    participantState.membersEnabled = false;
    // Original resolution must not require current relationship files or regrant.
    await rm(relationshipPath);
    const previousMemberCalls = participantState.memberCalls,
      previousInvitationReads = f.state.invitationReads;
    const beforeReplay = await f.counts(plan.brand.brandReference),
      replay = await service.execute(plan);
    assert.equal(replay.status, "AlreadyApplied");
    assert.deepEqual(replay.operation, first.operation);
    assert.equal(participantState.memberCalls, previousMemberCalls);
    assert.equal(f.state.invitationReads, previousInvitationReads);
    assert.deepEqual(await f.counts(plan.brand.brandReference), beforeReplay);
    assert.equal(
      (
        await f.admin.query("SELECT lifecycle FROM bop_membership.membership WHERE brand_id=$1", [
          plan.brand.brandReference,
        ])
      ).rows[0].lifecycle,
      "Ended",
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int n FROM bop_permission.permission_grant WHERE brand_id=$1 AND lifecycle='Active'",
          [plan.brand.brandReference],
        )
      ).rows[0].n,
      0,
    );
    f.mark("Changed complete plan conflicts with original");
    const changed = parseBrandInitialProvisioningPlan({
      ...plan,
      brand: { ...plan.brand, displayName: "Different approved plan" },
    });
    await approve(changed);
    await assert.rejects(service.execute(changed));
    assert.deepEqual(await f.counts(plan.brand.brandReference), beforeReplay);
    participantState.membersEnabled = true;
    for (const [index, mode] of [
      "Audit",
      "relationship",
      "account",
      "operator",
      "approval",
      "deadline",
      "COMMIT",
      "caughtReentry",
    ].entries()) {
      f.mark(`All-owner rollback ${mode}`);
      f.state.now = new Date(Date.parse(f.state.now) + 1000).toISOString();
      const candidate = build(2000 + index * 100),
        approval = await approve(candidate);
      f.state.lastSqlState = null;
      let auditWrites = 0,
        injected = false;
      f.state.onQuery = async ({ client, sql, values }) => {
        if (sql.startsWith("INSERT INTO platform_audit.audit_record")) {
          auditWrites++;
          if (mode === "Audit" && auditWrites === 3) {
            injected = true;
            // Real Audit INSERT fails its existing PK after earlier owner writes.
            await client.query(sql, [candidate.brandAuditReference, ...values.slice(1)]);
          }
        }
        if (
          sql.startsWith("INSERT INTO bop_permission.permission_grant") &&
          !injected &&
          mode !== "Audit" &&
          mode !== "COMMIT"
        ) {
          injected = true;
          if (mode === "relationship") await currentRelationship.withdraw();
          if (mode === "account") participantState.membersEnabled = false;
          if (mode === "operator") participantState.operatorEnabled = false;
          if (mode === "approval") await approval.withdraw();
          if (mode === "caughtReentry") {
            participantState.reenter = true;
            participantState.reentryPlan = candidate;
          }
          if (mode === "deadline")
            f.state.now = new Date(Date.parse(f.state.now) + 5000).toISOString();
        }
      };
      if (mode === "COMMIT")
        f.state.beforeCommit = async ({ client }) => {
          injected = true;
          // Real deferred owning FK rejects at COMMIT, after API guard/final seals.
          await client.query(
            "INSERT INTO bop_permission.permission_grant(grant_id,role_id,permission_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
            [
              id(9000),
              id(9001),
              id(100),
              candidate.brand.brandReference,
              f.state.now,
              candidate.recipients[0].roleEffectiveUntil,
            ],
          );
        };
      await assert.rejects(service.execute(candidate));
      assert.equal(injected, true);
      if (mode === "Audit") assert.equal(f.state.lastSqlState, "23505");
      if (mode === "COMMIT") assert.equal(f.state.lastSqlState, "23503");
      if (mode === "caughtReentry") assert.equal(participantState.caughtReentry, true);
      assert.deepEqual(await f.counts(candidate.brand.brandReference), absent);
      f.state.onQuery = null;
      f.state.beforeCommit = null;
      participantState.membersEnabled = true;
      participantState.operatorEnabled = true;
    }
    for (const [index, mismatch] of [
      "brandReference",
      "actorReference",
      "relationshipEvidenceReference",
    ].entries()) {
      f.mark(`Actual signed relationship ${mismatch} mismatch refuses creation`);
      f.state.now = new Date(Date.parse(f.state.now) + 1000).toISOString();
      const invalid = build(4300 + index * 100);
      await approve(invalid);
      await writeRelationship(invalid, { [mismatch]: id(6980) });
      await assert.rejects(service.execute(invalid));
      assert.deepEqual(await f.counts(invalid.brand.brandReference), absent);
    }
    for (const [index, mode] of ["revoked", "wrongActor"].entries()) {
      f.mark(`Actual invitation ${mode} refuses all owner writes`);
      f.state.now = new Date(Date.parse(f.state.now) + 1000).toISOString();
      const invalid = build(3000 + index * 100);
      await approve(invalid);
      if (mode === "revoked")
        await f.admin.query(
          "UPDATE bop_identity.workforce_invitation SET status='Revoked',consumed_at=NULL,version=version+1 WHERE invitation_id=$1",
          [invalid.recipients[0].invitationEvidenceReference],
        );
      else
        await f.admin.query(
          "UPDATE bop_identity.workforce_invitation SET actor_id=$2,version=version+1 WHERE invitation_id=$1",
          [invalid.recipients[0].invitationEvidenceReference, id(6800)],
        );
      await assert.rejects(service.execute(invalid));
      assert.deepEqual(await f.counts(invalid.brand.brandReference), absent);
    }
    f.mark("Persistent account original invitation withdrawal denies a different Brand plan");
    const withdrawn = build(3200);
    await approve(withdrawn);
    const originalInvitationReference = boundAccount.binding.invitationReference;
    await f.admin.query(
      "UPDATE bop_identity.workforce_invitation SET status='Revoked',consumed_at=NULL,version=version+1 WHERE invitation_id=$1",
      [originalInvitationReference],
    );
    await assert.rejects(service.execute(withdrawn));
    assert.deepEqual(await f.counts(withdrawn.brand.brandReference), absent);
    // Restore the controlled historical fixture using its genuine original time;
    // this is fixture cleanup, never a binding reassignment or production command.
    const originalConsumedAt = new Date(
      Date.parse(operatorAt) - 2 * 86400000 + 3600000,
    ).toISOString();
    await f.admin.query(
      "UPDATE bop_identity.workforce_invitation SET status='Accepted',consumed_at=$2,version=version+1 WHERE invitation_id=$1",
      [originalInvitationReference, originalConsumedAt],
    );
    f.mark("Actual Session/invitation SHARE locks hold through initialization");
    f.state.now = new Date(Date.parse(f.state.now) + 1000).toISOString();
    const locked = build(3300);
    await approve(locked);
    const oldSessionReference = operatorRuntime.record.session.sessionReference;
    let protectedRows = false;
    f.state.onQuery = async ({ sql }) => {
      if (!protectedRows && sql.startsWith("INSERT INTO bop_permission.permission_grant")) {
        protectedRows = true;
        for (const [statement, values] of [
          [
            "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
            [oldSessionReference, f.state.now],
          ],
          [
            "UPDATE bop_identity.workforce_invitation SET status='Revoked',consumed_at=NULL,version=version+1 WHERE invitation_id=$1",
            [locked.recipients[0].invitationEvidenceReference],
          ],
        ]) {
          await f.admin.query("BEGIN");
          try {
            await f.admin.query("SET LOCAL lock_timeout='100ms'");
            await assert.rejects(
              f.admin.query(statement, values),
              (error) => error.code === "55P03",
            );
          } finally {
            await f.admin.query("ROLLBACK");
          }
        }
      }
    };
    const lockResult = await service.execute(locked);
    f.state.onQuery = null;
    assert.equal(lockResult.status, "Applied");
    assert.equal(protectedRows, true);
    f.mark("Revoked actual Session denies next initialization; new actual Session restores access");
    await f.admin.query(
      "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
      [oldSessionReference, f.state.now],
    );
    const revokedSessionPlan = build(3500);
    await approve(revokedSessionPlan);
    await assert.rejects(service.execute(revokedSessionPlan));
    assert.deepEqual(await f.counts(revokedSessionPlan.brand.brandReference), absent);
    await operatorRuntime.rotate();
    service = serviceFor();
    assert.notEqual(operatorRuntime.record.session.sessionReference, oldSessionReference);
    assert.equal((await service.execute(revokedSessionPlan)).status, "Applied");
    f.mark("Actual concurrent original operation arbitration");
    f.state.now = new Date(Date.parse(f.state.now) + 1000).toISOString();
    const racedPlan = build(4000);
    await approve(racedPlan);
    let holderPid, waiterPid, releaseHolder, sawHold, sawAttempt;
    const held = new Promise((resolve) => {
      sawHold = resolve;
    });
    const attempted = new Promise((resolve) => {
      sawAttempt = resolve;
    });
    const release = new Promise((resolve) => {
      releaseHolder = resolve;
    });
    const isOriginalLock = (sql, values) =>
      sql.includes("pg_advisory_xact_lock") && String(values[0]).startsWith("BrandOperation:");
    f.state.afterQuery = async ({ client, sql, values }) => {
      if (holderPid === undefined && isOriginalLock(sql, values)) {
        holderPid = client.processID;
        sawHold();
        await release;
      }
    };
    f.state.onQuery = ({ client, sql, values }) => {
      if (
        holderPid !== undefined &&
        client.processID !== holderPid &&
        isOriginalLock(sql, values)
      ) {
        waiterPid = client.processID;
        sawAttempt();
      }
    };
    const firstRace = service.execute(racedPlan);
    await Promise.race([
      held,
      firstRace.then(() => {
        throw Error("original lock was not held");
      }),
    ]);
    // A second genuine facade instance represents another process/request.
    const secondService = serviceFor();
    const secondRace = secondService.execute(racedPlan);
    const both = Promise.all([firstRace, secondRace]);
    // Observe rejection immediately while checking locks; the same promise is
    // still awaited below, so a failed native operation cannot become success.
    void both.catch(() => undefined);
    try {
      await Promise.race([
        attempted,
        secondRace.then(() => {
          throw Error("original lock was not attempted");
        }),
      ]);
      let blocked = false;
      // Observe real lock dependency, not a sleep-based assumption of overlap.
      for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
        const blockers = (await f.admin.query("SELECT pg_blocking_pids($1) blockers", [waiterPid]))
          .rows[0].blockers;
        blocked = blockers.includes(holderPid);
      }
      assert.equal(blocked, true);
    } finally {
      releaseHolder();
      f.state.onQuery = null;
      f.state.afterQuery = null;
    }
    const settled = await both;
    assert.deepEqual(settled.map((r) => r.status).sort(), ["AlreadyApplied", "Applied"]);
    assert.deepEqual(settled[0].operation, settled[1].operation);
    assert.deepEqual(await f.counts(racedPlan.brand.brandReference), {
      brands: 1,
      operations: 1,
      memberships: 1,
      policies: 1,
      roles: 1,
      assignments: 1,
      grants: 6,
      audits: 3,
    });
    assert(f.state.committed >= 4);
    assert(f.state.rolledBack >= 8);
  } catch (error) {
    throw f.failure(error);
  } finally {
    await f.close();
  }
}
