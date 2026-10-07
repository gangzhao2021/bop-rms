import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, URLSearchParams } from "node:url";
import pg from "pg";
import { vi } from "vitest";
import { createRequire } from "node:module";
import * as identity from "../../bop/identity/src/index.ts";
import { parseWorkforceSessionSecrets } from "../../bop/identity/src/contracts/workforce-browser-session.ts";
import * as membership from "../../bop/membership/src/index.ts";
import * as permission from "../../bop/permission/src/index.ts";
import * as tenant from "../../bop/tenant/src/index.ts";
import {
  appendAuditRecordInTransaction,
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
import { createCognitoWorkforceOnboardingBrowser } from "../../../apps/api/src/workforce-onboarding-browser.ts";
import { createMerchantCategoryTransactions } from "../../../apps/api/src/merchant-category-transactions.ts";

const requireIdentity = createRequire(new URL("../../bop/identity/package.json", import.meta.url));
const { CognitoIdentityProviderClient, AdminGetUserCommand } = requireIdentity(
  "@aws-sdk/client-cognito-identity-provider",
);
const id = (n) => `0190ed60-0401-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value) => `sha256:${sha256Hex(canonicalizeRfc8785(value))}`;
const offset = (at, n) => new Date(Date.parse(at) + n).toISOString();

/** Real owner writes, signed file sources, installed RSA token verifiers and
 * strong OIDC/Session protocol. Only remote HTTP/SDK and the initial approved
 * preparation authority are controlled InternalTest boundaries. No delivery,
 * actual Cognito account or deployed signer acceptance is asserted. */
export async function verifyWorkforceOnboardingBrowser(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `onboard_callback_${context.runId}`,
    password = randomBytes(32).toString("hex"),
    preparationRole = `onboard_prepare_${context.runId}`,
    preparationPassword = randomBytes(32).toString("hex"),
    key = randomBytes(32),
    clients = new Set();
  let directory,
    roleCreated = false,
    preparationRoleCreated = false,
    primary,
    cleanupFailed = false,
    stage = "Setup",
    sqlState = "none",
    publicCode = "none",
    publicOrigin = "none",
    inspectionStep = "none",
    serial = 10000,
    lateDisable = false,
    disabled = false,
    sessionInserts = 0,
    sdkCalls = 0,
    disabledCalls = 0,
    subject = "11111111-2222-4333-8444-555555555555";
  const now = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000).toISOString();
  // Controlled observation clock; original deadlines are never renewed. Real
  // transaction/Audit time and signed JWT verifier wall-clock remain genuine.
  const clock = { now: () => now },
    next = () => id(serial++),
    scope = {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_OnboardNative",
      clientId: "onboardnativeclient",
    },
    configuration = {
      ...scope,
      clientSecret: "synthetic-confidential-secret",
      managedLoginOrigin: "https://onboard-native.auth.ca-central-1.amazoncognito.com",
      redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
      logoutReturnUri: "https://merchant.invalid/app/organization/brands",
    },
    rootPath = "/app/organization/brands",
    corporateEmail = "synthetic-invited@example.test";
  const query = async (client, sql, values = []) => {
    try {
      if (stage.endsWith("Observed")) {
        if (sql.startsWith("INSERT INTO bop_identity.workforce_onboarding_operation"))
          inspectionStep = "JournalInsert";
        else if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record"))
          inspectionStep = "AuditInsert";
        else if (sql.startsWith("SELECT snapshot_text,source_digest"))
          inspectionStep = "JournalRead";
      }
      const result = await client.query(sql, [...values]);
      if (client !== admin && /^INSERT INTO bop_identity.authentication_session/u.test(sql)) {
        sessionInserts++;
        if (lateDisable) disabled = true;
      }
      return result;
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error?.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const hasher = {
    hash: (value) => {
      if (stage.endsWith("Observed")) inspectionStep = "SubjectHash";
      return identity.parseSelectorHash(createHmac("sha256", key).update(value).digest("hex"));
    },
    equals: (a, b) => a === b,
  };
  const envelopes = {
    async encrypt(text, encryptionContext) {
      if (stage.endsWith("Observed")) inspectionStep = "SubjectEncrypt";
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(encryptionContext));
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-native-key",
        encryptionContext,
        ciphertext: Buffer.concat([
          iv,
          cipher.update(text),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64url"),
      };
    },
    async decrypt(envelope, encryptionContext) {
      const raw = Buffer.from(envelope.ciphertext, "base64url"),
        cipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      cipher.setAAD(Buffer.from(encryptionContext));
      cipher.setAuthTag(raw.subarray(-16));
      return Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString();
    },
  };
  // This resource has no scope or verdict logic. The production API host owns
  // all borrowed guards and seals; the resource supplies real COMMIT/ROLLBACK.
  const runResource = async (work, principal, credential) => {
    const client = new pg.Client({
      ...context.clientConfig,
      user: principal,
      password: credential,
    });
    clients.add(client);
    await client.connect();
    let open = true;
    const tx = Object.freeze({
      query: (sql, values) => {
        assert(open, "EXACT_LIVE_TX_REQUIRED");
        return query(client, sql, values);
      },
    });
    try {
      await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      await query(client, "SET LOCAL statement_timeout='5s'");
      await query(client, "SET LOCAL lock_timeout='2s'");
      const result = await work(tx);
      await query(client, "COMMIT");
      open = false;
      return result;
    } catch (error) {
      await query(client, "ROLLBACK").catch(() => {
        cleanupFailed = true;
      });
      throw error;
    } finally {
      open = false;
      await client.end().catch(() => {
        cleanupFailed = true;
      });
      clients.delete(client);
    }
  };
  const resource = { run: (work) => runResource(work, role, password) },
    preparationResource = {
      run: (work) => runResource(work, preparationRole, preparationPassword),
    };
  const host = createMerchantCategoryTransactions(preparationResource);
  const controlledActor = (reference, kind = "Platform") =>
    identity.createIdentityActor({
      actorType: "User",
      actorReference: reference,
      accountKind: kind,
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: now,
      recentMfaAt: now,
    });
  const brandAudit = async (tx, descriptor) => {
    await appendAuditRecordInTransaction(tx, {
      auditId: descriptor.auditReference,
      brandId: descriptor.brandReference,
      actor: { type: "User", reference: descriptor.actorReference },
      actionCode: descriptor.actionCode,
      targetType: "Membership",
      targetId: descriptor.membershipReference,
      afterSummary: {
        operationReference: descriptor.operationReference,
        originalOperationReference: descriptor.originalOperationReference,
        planDigest: descriptor.planDigest,
        requestDigest: descriptor.requestDigest,
        approvalEvidenceReference: descriptor.approvalEvidenceReference,
        membershipVersion: descriptor.afterVersion,
      },
      reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
      correlationId: descriptor.operationReference,
      occurredAt: descriptor.occurredAt,
      sourceChannel: "DEPLOYMENT",
      dataClassification: "Restricted",
      retentionPolicyCode: "MEMBERSHIP_AUDIT",
      retentionPolicyVersion: 1,
    });
  };
  const signedFiles = async (derived) => {
    const paths = Object.fromEntries(
      [
        "planPath",
        "approvalPath",
        "approvalTrustPath",
        "relationshipPath",
        "relationshipTrustPath",
      ].map((name) => [name, join(directory, `${derived.plan.actorReference}-${name}.json`)]),
    );
    const approvalKey = generateKeyPairSync("ed25519"),
      relationshipKey = generateKeyPairSync("ed25519"),
      approvalKeyId = next(),
      relationKeyId = next(),
      issuerId = next();
    const approval = {
      profile: "WorkforceOnboardingApprovalV1",
      purposeCode: "WORKFORCE_ONBOARDING",
      ...derived.approvalExpected,
      approvedByReference: derived.plan.approvedByReference,
      approvalEvidenceReference: derived.plan.approvalEvidenceReference,
      keyReference: approvalKeyId,
      notBefore: offset(now, -3600000),
      validUntil: offset(now, 3600000),
    };
    const relationship = {
      profile: "WorkforceRelationshipQualificationV1",
      purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
      environmentReference: derived.plan.environmentReference,
      actorReference: derived.plan.actorReference,
      brandReference: derived.plan.brandReference,
      workforceRelationshipReference: derived.plan.workforceRelationshipReference,
      relationshipEvidenceReference: derived.plan.relationshipEvidenceReference,
      issuerReference: issuerId,
      keyReference: relationKeyId,
      revision: derived.plan.relationshipRevision,
      status: "Current",
      effectiveFrom: derived.plan.effectiveFrom,
      effectiveUntil: derived.plan.effectiveUntil,
      verifiedAt: offset(now, -1000),
      validUntil: offset(now, 3600000),
      signature: "A".repeat(86),
    };
    relationship.signature = sign(
      null,
      Buffer.from(membership.workforceRelationshipQualificationSigningBytes(relationship)),
      relationshipKey.privateKey,
    ).toString("base64url");
    const contents = {
      planPath: derived.plan,
      approvalPath: {
        ...approval,
        signature: sign(
          null,
          Buffer.from(`BOP-RMS:WorkforceOnboardingApprovalV1\n${canonicalizeRfc8785(approval)}`),
          approvalKey.privateKey,
        ).toString("base64url"),
      },
      approvalTrustPath: {
        profile: "WorkforceOnboardingTrustV1",
        keys: [
          {
            keyReference: approvalKeyId,
            approvedByReference: derived.plan.approvedByReference,
            environmentReference: derived.plan.environmentReference,
            purposeCode: "WORKFORCE_ONBOARDING",
            notBefore: offset(now, -7200000),
            validUntil: offset(now, 7200000),
            publicKeySpki: approvalKey.publicKey
              .export({ type: "spki", format: "der" })
              .toString("base64url"),
          },
        ],
        revokedApprovalEvidenceReferences: [],
      },
      relationshipPath: relationship,
      relationshipTrustPath: {
        profile: "WorkforceRelationshipQualificationTrustV1",
        keys: [
          {
            keyReference: relationKeyId,
            issuerReference: issuerId,
            environmentReference: derived.plan.environmentReference,
            purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
            brandReferences: [derived.plan.brandReference],
            notBefore: offset(now, -7200000),
            validUntil: offset(now, 7200000),
            publicKeySpki: relationshipKey.publicKey
              .export({ type: "spki", format: "der" })
              .toString("base64url"),
          },
        ],
        withdrawnEvidenceReferences: [],
      },
    };
    for (const [name, value] of Object.entries(contents))
      await writeFile(paths[name], JSON.stringify(value), { mode: 0o600 });
    return {
      paths,
      relationship: {
        profile: "CurrentWorkforceRelationshipQualificationV1",
        environmentReference: derived.plan.environmentReference,
        actorReference: derived.plan.actorReference,
        brandReference: derived.plan.brandReference,
        workforceRelationshipReference: derived.plan.workforceRelationshipReference,
        relationshipEvidenceReference: derived.plan.relationshipEvidenceReference,
        issuerReference: issuerId,
        revision: derived.plan.relationshipRevision,
        relationshipEffectiveFrom: derived.plan.effectiveFrom,
        relationshipEffectiveUntil: derived.plan.effectiveUntil,
        verifiedAt: relationship.verifiedAt,
        observedAt: now,
        validUntil: offset(now, 5000),
      },
    };
  };
  const prepare = async (base) => {
    mark(`Prepare${base}Files`);
    subject = id(base + 80);
    const emailSource = identity.createCognitoWorkforceInvitation({
      configuration: scope,
      clock,
      hasher,
    });
    const derived = permission.deriveWorkforceOnboardingPlan({
      profile: "WorkforceOnboardingPlanV1",
      purposeCode: "WORKFORCE_ONBOARDING",
      configuration: scope,
      environmentReference: id(1),
      operationReference: id(base),
      operatorReference: id(2),
      approvedByReference: id(3),
      approvalEvidenceReference: id(base + 1),
      brandReference: id(base + 2),
      actorReference: id(base + 3),
      membershipReference: id(base + 4),
      workforceRelationshipReference: id(base + 5),
      relationshipEvidenceReference: id(base + 6),
      relationshipRevision: 1,
      effectiveFrom: offset(now, -1000),
      effectiveUntil: offset(now, 86400000),
      emailDigest: emailSource.digestCorporateEmail(corporateEmail),
      policy: {
        profile: "ApprovedWorkforcePolicyV1",
        brandReference: id(base + 2),
        actorReference: id(base + 3),
        membershipReference: id(base + 4),
        effectiveFrom: offset(now, -1000),
        effectiveUntil: offset(now, 86400000),
        roles: [
          {
            roleReference: id(base + 7),
            roleCode: `invited_owner_${base}`,
            effectiveFrom: offset(now, -1000),
            effectiveUntil: offset(now, 86400000),
            assignment: {
              assignmentReference: id(base + 8),
              effectiveFrom: offset(now, -1000),
              effectiveUntil: offset(now, 86400000),
            },
            grants: [
              {
                grantReference: id(base + 9),
                permissionReference: id(20),
                action: "organization.manage",
                effectiveFrom: offset(now, -1000),
                effectiveUntil: offset(now, 86400000),
              },
            ],
          },
        ],
      },
      expectedPolicy: null,
      policySnapshotReference: id(base + 10),
      reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
    });
    const files = await signedFiles(derived),
      operator = controlledActor(derived.plan.operatorReference),
      createdAt = now,
      deadline = offset(now, 5000);
    const brand = tenant.createBrand({
      brandReference: derived.plan.brandReference,
      code: `ONBOARD_${base}`,
      displayName: "Synthetic Invited Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    // Public Tenant initial producer, under controlled independent preparation
    // authority; no successful Brand/Membership/policy is copied into tables.
    mark(`Prepare${base}Brand`);
    await query(admin, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const tx = { query: (sql, values) => query(admin, sql, values) },
        auditReference = next(),
        operationReference = next(),
        intentDigest = hash(brand);
      const owner = tenant.createPostgresBrandInitialCreationStore({
        brandReference: brand.brandReference,
        binding: {
          operationReference,
          intentDigest,
          actorReference: operator.actorReference,
          auditReference,
        },
        transactions: { run: (work) => work(tx) },
        authorize: async (actual) => {
          assert.equal(actual, tx);
          return true;
        },
        appendAudit: async (actual, input) => {
          assert.equal(actual, tx);
          await appendAuditRecordInTransaction(tx, {
            auditId: auditReference,
            brandId: brand.brandReference,
            actor: { type: "User", reference: operator.actorReference },
            actionCode: "BRAND_CREATED",
            targetType: "Brand",
            targetId: brand.brandReference,
            afterSummary: { operationReference, intentDigest },
            reasonCode: "CONTROLLED_APPROVED_ONBOARDING",
            correlationId: operationReference,
            occurredAt: input.audit.occurredAt,
            sourceChannel: "DEPLOYMENT",
            dataClassification: "Restricted",
            retentionPolicyCode: "BRAND_ADMINISTRATION_AUDIT",
            retentionPolicyVersion: 1,
          });
        },
      });
      await owner.commit({
        operation: {
          command: "CreateBrand",
          operationReference,
          brandReference: brand.brandReference,
          intentDigest,
          brandVersion: 1,
          artifact: brand,
        },
        expectedBrandVersion: 0,
        audit: {
          actorReference: operator.actorReference,
          purposeCode: "BRAND_INITIAL_PROVISIONING",
          auditReference,
          occurredAt: now,
        },
      });
      await query(admin, "COMMIT");
    } catch (error) {
      await query(admin, "ROLLBACK");
      throw error;
    }
    let pending, secret, record;
    // Preparation uses a separate controlled minimum owner role, actual host and public
    // writers. The preparation facts are deliberately controlled, unlike the
    // actual file verification and signed Provider proof in the callback.
    await host.transactions.run(async (tx) => {
      const children = [],
        registerOwner = (owner) => (actual, guard, final) =>
          host.registerBeforeCommit(
            actual,
            async () => {
              stage = `Prepare${base}${owner}Guard`;
              await guard();
              stage = `Prepare${base}${owner}GuardComplete`;
            },
            () => {
              stage = `Prepare${base}${owner}Final`;
              const result = final();
              stage = `Prepare${base}${owner}FinalComplete`;
              return result;
            },
          ),
        member = membership.createPostgresApprovedWorkforceMembershipStore({
          transaction: tx,
          clock,
          originalObservedAt: now,
          originalValidUntil: deadline,
          auditReference: next(),
          authority: {
            async hold(actual, input) {
              assert.equal(actual, tx);
              return {
                requestDigest: input.requestDigest,
                approval: derived.approvedMembership,
                brand,
                operator,
                relationship: files.relationship,
                activation: null,
                observedAt: now,
                validUntil: deadline,
              };
            },
          },
          appendAudit: brandAudit,
          registerBeforeCommit: registerOwner("Membership"),
        });
      mark(`Prepare${base}Pending`);
      pending = (
        await member.createPending({
          profile: "CreateApprovedPendingMembershipV1",
          approval: derived.approvedMembership,
        })
      ).membership;
      assert.equal(pending.lifecycle, "PendingActivation");
      assert.equal(pending.version, 1);
      children.push({ owner: "Membership", source: member });
      const policy = permission.createPostgresApprovedWorkforcePolicyStore({
        transaction: tx,
        clock,
        originalObservedAt: now,
        originalValidUntil: deadline,
        auditReference: next(),
        authority: {
          async hold(actual, input) {
            assert.equal(actual, tx);
            return {
              requestDigest: input.requestDigest,
              approval: derived.approvedMembership,
              brand,
              pendingMembership: pending,
              operator,
              relationship: files.relationship,
              observedAt: now,
              validUntil: deadline,
            };
          },
        },
        appendAudit: appendAuditRecordInTransaction,
        registerBeforeCommit: registerOwner("Policy"),
      });
      mark(`Prepare${base}Policy`);
      await policy.prepareApproved(derived.preparePolicy);
      children.push({ owner: "Policy", source: policy });
      const o = derived.original,
        binding = {
          operatorReference: o.operatorReference,
          actorReference: o.actorReference,
          brandReference: o.brandReference,
          membershipReference: o.membershipReference,
          purposeCode: "WORKFORCE_ONBOARDING",
        };
      const journal = identity.createPostgresWorkforceOnboardingOperationStore({
        transaction: tx,
        configuration: scope,
        binding,
        clock,
        originalObservedAt: now,
        originalValidUntil: deadline,
        authority: {
          async hold(actual, input) {
            assert.equal(actual, tx);
            return {
              binding,
              action: input.action,
              requestDigest: input.requestDigest,
              operator,
              validUntil: input.validUntil,
            };
          },
        },
        hasher,
        envelopes,
        credentials: {
          generate: () => identity.parseRawBrowserCredential(randomBytes(32).toString("base64url")),
        },
        nextReference: next,
        async createInvitation(actual, command) {
          assert.equal(actual, tx);
          const leafBinding = {
            operatorReference: o.operatorReference,
            actorReference: o.actorReference,
            membershipReference: o.membershipReference,
            purposeCode: "WORKFORCE_ONBOARDING",
            action: "IssueInvitation",
            operationReference: next(),
            correlationReference: next(),
          };
          const leaf = identity.createPostgresWorkforceInvitationStore({
            transaction: tx,
            binding: leafBinding,
            clock,
            originalObservedAt: now,
            originalValidUntil: deadline,
            authority: {
              async hold(held, input) {
                assert.equal(held, tx);
                return {
                  binding: leafBinding,
                  requestDigest: input.requestDigest,
                  operator,
                  validUntil: input.validUntil,
                };
              },
            },
            async appendAudit(held, descriptor) {
              assert.equal(held, tx);
              await tx.query(
                "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
                [o.operatorReference, "WORKFORCE_ONBOARDING"],
              );
              await appendPlatformAuditRecordInTransaction(tx, {
                auditReference: next(),
                actorReference: o.operatorReference,
                purposeCode: "WORKFORCE_ONBOARDING",
                actionCode: "WORKFORCE_INVITATION_ISSUED",
                targetType: "WorkforceInvitation",
                targetReference: command.invitationReference,
                operationReference: leafBinding.operationReference,
                intentDigest: hash(command),
                occurredAt: descriptor.occurredAt,
                reasonCode: o.reasonCode,
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              });
            },
            registerBeforeCommit: registerOwner("Invitation"),
          });
          children.push({ owner: "Invitation", source: leaf });
          return leaf.createInvitation(command);
        },
        registerBeforeCommit: registerOwner("Journal"),
      });
      mark(`Prepare${base}Invitation`);
      const prepared = await journal.prepare(o);
      secret = prepared.deliverySecret;
      assert(secret, "FIRST_TRANSIENT_SECRET_REQUIRED");
      const intentDigest = identity.workforceOnboardingIntent(o, identity.workforceOnboardingCodec);
      mark(`Prepare${base}Claim`);
      const claimed = await journal.claimDispatch({
        operationReference: o.operationReference,
        intentDigest,
        expectedVersion: 1,
      });
      mark(`Prepare${base}Observed`);
      const found = await journal.recordInspection({
        operationReference: o.operationReference,
        intentDigest,
        expectedVersion: 2,
        observation: {
          profile: "CognitoWorkforceInvitationObservationV1",
          actorReference: o.actorReference,
          creationIntentDigest: intentDigest,
          emailDigest: o.emailDigest,
          observedAt: now,
          validUntil: deadline,
          status: "Found",
          dispatchAccepted: null,
          provider: {
            username: `bop_${o.actorReference}`,
            subject,
            status: "CONFIRMED",
            enabled: true,
            createdAt: claimed.record.dispatchStartedAt,
          },
        },
      });
      stage = `Prepare${base}ObservedReturned`;
      record = found;
      children.push({ owner: "Journal", source: journal });
      // Assertions are pure post-COMMIT, performed by the caller below.
      txChildren = children;
      stage = `Prepare${base}WorkReturned`;
    });
    stage = `Prepare${base}HostReturned`;
    for (const child of txChildren) {
      stage = `Prepare${base}${child.owner}PostCommit`;
      child.source.assertFinalized();
    }
    stage = `Prepare${base}PostCommitComplete`;
    return { derived, files, secret, record };
  };
  let txChildren = [];
  const idKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    codes = new Map();
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url"),
    jwt = (claims, use) => {
      const bytes = `${encode({ alg: "RS256", kid: `native-${use}` })}.${encode(claims)}`;
      return `${bytes}.${sign("RSA-SHA256", Buffer.from(bytes), use === "id" ? idKey.privateKey : accessKey.privateKey).toString("base64url")}`;
    };
  let fetchSpy, sdkSpy;
  try {
    await admin.connect();
    directory = await mkdtemp(join(tmpdir(), "bop-onboard-browser-"));
    await query(
      admin,
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    roleCreated = true;
    await query(
      admin,
      `CREATE ROLE ${preparationRole} LOGIN PASSWORD '${preparationPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    preparationRoleCreated = true;
    for (const sql of [
      `GRANT USAGE ON SCHEMA bop_identity,bop_membership,bop_tenant,bop_permission,platform_audit,platform_helpers TO ${role}`,
      `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      `GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`,
      `GRANT SELECT,INSERT,MAINTAIN,UPDATE(lifecycle,version,updated_at) ON bop_membership.membership TO ${role}`,
      `GRANT SELECT,MAINTAIN ON bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO ${role}`,
      `GRANT INSERT ON bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant TO ${role}`,
      `GRANT UPDATE(snapshot_id,version,updated_at) ON bop_permission.policy_state TO ${role}`,
      `GRANT SELECT,INSERT ON platform_audit.audit_record,platform_audit.platform_actor_audit_record TO ${role}`,
      `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,platform_audit.platform_actor_audit_chain_head TO ${role}`,
      `GRANT SELECT,INSERT,UPDATE(status,consumed_at,provider_evidence_id,version) ON bop_identity.workforce_invitation TO ${role}`,
      `GRANT SELECT,INSERT ON bop_identity.workforce_onboarding_operation TO ${role}`,
      `GRANT SELECT,INSERT,UPDATE(version,consumed_at) ON bop_identity.oidc_authorization_transaction TO ${role}`,
      `GRANT SELECT,INSERT,MAINTAIN,UPDATE(session_id) ON bop_identity.authentication_session TO ${role}`,
      `GRANT INSERT,SELECT(snapshot_text,source_digest,recorded_by,operation_id) ON bop_identity.workforce_account_binding TO ${role}`,
      `GRANT EXECUTE ON FUNCTION bop_identity.workforce_onboarding_scope(uuid,uuid,uuid,uuid,text,text,text),bop_identity.workforce_onboarding_operation_admit(uuid,uuid,uuid,uuid),bop_identity.workforce_onboarding_instant(text),bop_identity.workforce_onboarding_invitation_read(text,text,text,text),bop_identity.workforce_account_binding_import_capable(),bop_identity.workforce_account_binding_acceptance_admit(uuid,uuid,uuid,text),bop_identity.workforce_account_binding_read(uuid,text,text,text),bop_identity.workforce_account_invitation_read(uuid,uuid) TO ${role}`,
      `GRANT EXECUTE ON FUNCTION platform_audit.matches_workforce_onboarding_operation_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text),platform_audit.matches_workforce_account_binding_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${role}`,
    ]) {
      await query(admin, sql);
      await query(admin, sql.replace(`TO ${role}`, `TO ${preparationRole}`));
    }
    for (const sql of [
      `REVOKE INSERT ON bop_membership.membership FROM ${role}`,
      `REVOKE INSERT ON bop_permission.policy_state,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant FROM ${role}`,
      `REVOKE UPDATE(snapshot_id,version,updated_at) ON bop_permission.policy_state FROM ${role}`,
      `REVOKE SELECT,INSERT ON bop_identity.workforce_onboarding_operation FROM ${role}`,
      `REVOKE INSERT ON bop_identity.workforce_invitation FROM ${role}`,
      `REVOKE EXECUTE ON FUNCTION bop_identity.workforce_onboarding_scope(uuid,uuid,uuid,uuid,text,text,text),bop_identity.workforce_onboarding_operation_admit(uuid,uuid,uuid,uuid),bop_identity.workforce_onboarding_instant(text),platform_audit.matches_workforce_onboarding_operation_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) FROM ${role}`,
    ])
      await query(admin, sql);
    // One pre-existing permission definition is configuration, not an assignment
    // or successful authorization. All roles/grants/assignments are owner writes.
    const definition = permission.createPermissionDefinition({
      permissionReference: id(20),
      action: "organization.manage",
      lifecycle: "Active",
      version: 1,
      createdAt: offset(now, -1000),
      updatedAt: offset(now, -1000),
    });
    await query(
      admin,
      "INSERT INTO bop_permission.permission_definition(permission_id,action_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        definition.permissionReference,
        definition.action,
        definition.lifecycle,
        definition.version,
        definition.createdAt,
        definition.updatedAt,
      ],
    );
    sdkSpy = vi
      .spyOn(CognitoIdentityProviderClient.prototype, "send")
      .mockImplementation(async (command) => {
        assert(command instanceof AdminGetUserCommand);
        assert.equal(command.input.UserPoolId, "ca-central-1_OnboardNative");
        assert.equal(command.input.Username, subject);
        sdkCalls++;
        if (disabled) disabledCalls++;
        return {
          Enabled: !disabled,
          UserStatus: "CONFIRMED",
          UserAttributes: [{ Name: "sub", Value: subject }],
        };
      });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      if (String(url) === `${scope.issuer}/.well-known/jwks.json`)
        return globalThis.Response.json({
          keys: [
            {
              ...idKey.publicKey.export({ format: "jwk" }),
              kid: "native-id",
              use: "sig",
              alg: "RS256",
            },
            {
              ...accessKey.publicKey.export({ format: "jwk" }),
              kid: "native-access",
              use: "sig",
              alg: "RS256",
            },
          ],
        });
      assert.equal(String(url), `${configuration.managedLoginOrigin}/oauth2/token`);
      assert.equal(init.method, "POST");
      const body = new URLSearchParams(String(init.body)),
        code = codes.get(body.get("code"));
      assert(code && !code.used, "ONE_TIME_CODE_REQUIRED");
      code.used = true;
      assert.equal(body.get("redirect_uri"), configuration.redirectUri);
      assert.equal(
        createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
        code.challenge,
      );
      const second = Math.floor(Date.parse(now) / 1000),
        common = {
          iss: scope.issuer,
          sub: subject,
          auth_time: second,
          iat: second,
          exp: second + 3600,
          acr: "urn:cognito:loa:4",
          amr: ["pwd", "otp", "mfa"],
        };
      return globalThis.Response.json({
        id_token: jwt(
          {
            ...common,
            token_use: "id",
            aud: scope.clientId,
            nonce: code.badNonce ? "wrong-nonce" : code.nonce,
            email: corporateEmail,
            email_verified: true,
          },
          "id",
        ),
        access_token: jwt(
          { ...common, token_use: "access", client_id: scope.clientId, scope: "openid" },
          "access",
        ),
        refresh_token: `synthetic-refresh-${serial}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      });
    });
    const makeService = (f) => {
      mark("ConstructService");
      const onboarding = createCognitoWorkforceOnboardingBrowser({
        transactions: resource,
        configuration,
        clock,
        hasher,
        envelopes,
        nextReference: next,
        environmentReference: f.derived.plan.environmentReference,
        files: f.files.paths,
        acceptanceRoleName: role,
        allowedPostLoginPaths: [rootPath],
      });
      const store = identity.createPostgresWorkforceBrowserSessionStore({
        transactions: resource,
        ...scope,
        redirectUri: configuration.redirectUri,
        allowedPostLoginPaths: [rootPath],
        now: () => now,
        hasher,
        envelopes,
        currentActor: async () => {
          throw new Error("ORDINARY_SESSION_CREATION_MUST_NOT_RUN");
        },
      });
      const provider = identity.createCognitoWorkforceProvider({
        configuration: {
          issuer: configuration.issuer,
          clientId: configuration.clientId,
          clientSecret: configuration.clientSecret,
          managedLoginOrigin: configuration.managedLoginOrigin,
          redirectUri: configuration.redirectUri,
          logoutReturnUri: configuration.logoutReturnUri,
        },
        clock,
        nextEvidenceReference: next,
        resolveVerifiedSubject: async () => {
          throw new Error("ORDINARY_PROVIDER_RESOLUTION_MUST_NOT_RUN");
        },
      });
      return new identity.WorkforceBrowserSessionService({
        configuration: {
          ...scope,
          redirectUri: configuration.redirectUri,
          allowedPostLoginPaths: [rootPath],
        },
        now: () => now,
        store,
        provider,
        workforceOnboarding: onboarding,
        hasher,
        envelopes,
        credentials: {
          generate: () => identity.parseRawBrowserCredential(randomBytes(32).toString("base64url")),
          generateUuidV7: next,
        },
        pkce: {
          challenge: (verifier) => createHash("sha256").update(verifier).digest("base64url"),
        },
      });
    };
    const challenge = async (service, f, badNonce = false) => {
      const started = await service.startInvitation({ secret: f.secret, postLoginPath: rootPath }),
        params = new URL(started.authorizationUrl).searchParams,
        code = `controlled-code-${next()}`;
      assert.equal(params.get("prompt"), "login");
      assert(params.get("nonce") && params.get("code_challenge"));
      codes.set(code, {
        nonce: params.get("nonce"),
        challenge: params.get("code_challenge"),
        used: false,
        badNonce,
      });
      return { authCookie: started.cookie.value, code, state: params.get("state") };
    };
    const counts = async (f) =>
      (
        await query(
          admin,
          `SELECT
      (SELECT status FROM bop_identity.workforce_invitation WHERE invitation_id=$1) invitation,
      (SELECT version FROM bop_identity.workforce_invitation WHERE invitation_id=$1) invitation_version,
      (SELECT lifecycle FROM bop_membership.membership WHERE membership_id=$2) membership,
      (SELECT version FROM bop_membership.membership WHERE membership_id=$2) membership_version,
      (SELECT count(*)::int FROM bop_identity.workforce_account_binding WHERE actor_id=$3) bindings,
      (SELECT count(*)::int FROM bop_identity.authentication_session WHERE actor_id=$3) sessions,
      (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$4) audits,
      (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record WHERE actor_id=$3) platform_audits,
      (SELECT coalesce(jsonb_agg(jsonb_build_array(next_sequence,encode(last_record_hash,'hex'))),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$3) platform_heads,
      (SELECT coalesce(jsonb_agg(jsonb_build_array(next_sequence,encode(last_record_hash,'hex'))),'[]'::jsonb) FROM platform_audit.audit_chain_head WHERE brand_id=$4) brand_heads`,
          [
            f.record.invitationReference,
            f.derived.plan.membershipReference,
            f.derived.plan.actorReference,
            f.derived.plan.brandReference,
          ],
        )
      ).rows[0];
    mark("PreparePositive");
    const good = await prepare(100),
      service = makeService(good),
      before = await counts(good);
    assert.equal(before.audits, 3, "ACTUAL_BRAND_PENDING_AND_POLICY_AUDITS_REQUIRED");
    assert.deepEqual(
      { ...before, audits: 0, brand_heads: [], platform_heads: [] },
      {
        invitation: "Pending",
        invitation_version: 1,
        membership: "PendingActivation",
        membership_version: 1,
        bindings: 0,
        sessions: 0,
        audits: 0,
        platform_audits: 0,
        brand_heads: [],
        platform_heads: [],
      },
    );
    mark("WrongNonce");
    const wrong = await challenge(service, good, true);
    await assert.rejects(service.callback(wrong));
    assert.deepEqual(await counts(good), before);
    mark("WrongApprovedOriginal");
    const wrongOriginal = await challenge(service, good);
    await writeFile(
      good.files.paths.planPath,
      JSON.stringify({ ...good.derived.plan, reasonCode: "CHANGED_SIGNED_ORIGINAL" }),
    );
    await assert.rejects(service.callback(wrongOriginal));
    assert.deepEqual(await counts(good), before);
    await writeFile(good.files.paths.planPath, JSON.stringify(good.derived.plan));
    mark("ActualCallback");
    const request = await challenge(service, good);
    mark("ActualCallbackInvoke");
    const result = await service.callback(request);
    mark("ActualCallbackReturnedActor");
    assert.equal(result.session.actor.actorReference, good.derived.plan.actorReference);
    assert.equal(result.session.actor.accountKind, "Workforce");
    mark("ActualCallbackReturnedPolicy");
    assert.equal(result.session.policy.code, "Privileged");
    mark("ActualCallbackReturnedPath");
    assert.equal(result.postLoginPath, rootPath);
    mark("ActualCallbackReturnedCookie");
    assert(
      result.cookies.some(
        (cookie) => cookie.descriptor.name === "__Host-bop-merchant" && !cookie.clear,
      ),
    );
    mark("ActualCallbackReadCommitted");
    const committed = await counts(good);
    mark("ActualCallbackCommittedInvitation");
    assert.equal(committed.invitation, "Accepted");
    assert.equal(committed.invitation_version, 2);
    mark("ActualCallbackCommittedMembership");
    assert.equal(committed.membership, "Active");
    assert.equal(committed.membership_version, 2);
    mark("ActualCallbackCommittedBindingSession");
    assert.equal(committed.bindings, 1);
    assert.equal(committed.sessions, 1);
    mark("ActualCallbackCommittedAudit");
    assert(committed.audits > before.audits);
    assert(committed.platform_audits > 0);
    mark("ActualCallbackReadSessionProof");
    const sessionRow = (
      await query(
        admin,
        "SELECT cipher_algorithm,key_reference,encode(encrypted_secret,'base64') ciphertext,encryption_context FROM bop_identity.authentication_session WHERE actor_id=$1",
        [good.derived.plan.actorReference],
      )
    ).rows[0];
    const secretEnvelope = {
      algorithm: sessionRow.cipher_algorithm,
      keyReference: sessionRow.key_reference,
      ciphertext: Buffer.from(sessionRow.ciphertext, "base64").toString("base64url"),
      encryptionContext: sessionRow.encryption_context,
    };
    mark("ActualCallbackParseSessionProof");
    const sessionProof = parseWorkforceSessionSecrets(
      JSON.parse(await envelopes.decrypt(secretEnvelope, secretEnvelope.encryptionContext)),
      scope,
      result.session,
    );
    mark("ActualCallbackAssertSessionProof");
    assert.equal(sessionProof.mfa.actorReference, good.derived.plan.actorReference);
    assert.equal(sessionProof.mfa.method, "Totp");
    assert.equal(sessionProof.mfa.sessionReference, result.session.sessionReference);
    mark("ActualCallbackReadAcceptanceBinding");
    const stored = await query(
      admin,
      "SELECT snapshot_text FROM bop_identity.workforce_account_binding WHERE actor_id=$1",
      [good.derived.plan.actorReference],
    );
    mark("ActualCallbackAssertAcceptanceBinding");
    assert.equal(
      JSON.parse(stored.rows[0].snapshot_text).originalCommand.profile,
      "WorkforceAccountBindingAcceptanceV1",
    );
    mark("RepeatedCallback");
    const calls = sdkCalls;
    await assert.rejects(service.callback(request));
    assert.equal(sdkCalls, calls);
    assert.deepEqual(await counts(good), committed);
    mark("PrepareRollback");
    const late = await prepare(200),
      lateService = makeService(late),
      stable = await counts(late),
      lateRequest = await challenge(lateService, late),
      inserts = sessionInserts,
      previousDisabled = disabledCalls;
    lateDisable = true;
    mark("LateProviderWithdrawal");
    await assert.rejects(lateService.callback(lateRequest));
    assert(sessionInserts > inserts, "ACTUAL_SESSION_INSERT_REQUIRED_BEFORE_WITHDRAWAL");
    assert(disabledCalls > previousDisabled, "ACTUAL_DISABLED_PROVIDER_REREAD_REQUIRED");
    assert.deepEqual(await counts(late), stable);
    disabled = false;
    lateDisable = false;
    mark("ConsumedRetry");
    await assert.rejects(lateService.callback(lateRequest));
    assert.deepEqual(await counts(late), stable);
    const acl = (
      await query(
        admin,
        "SELECT has_function_privilege($1,'bop_identity.workforce_account_binding_import_admit(uuid,uuid,uuid,text)','EXECUTE') importer,has_table_privilege($1,'bop_tenant.store','SELECT') store,has_table_privilege($1,'bop_membership.store_assignment','SELECT') assignment,has_table_privilege($1,'bop_membership.membership','INSERT') member_create,has_table_privilege($1,'bop_permission.permission_grant','INSERT') grant_create,has_table_privilege($1,'bop_identity.workforce_onboarding_operation','SELECT') journal_read",
        [role],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      importer: false,
      store: false,
      assignment: false,
      member_create: false,
      grant_create: false,
      journal_read: false,
    });
  } catch (error) {
    primary = error;
    if (
      typeof error?.code === "string" &&
      /^(?:WORKFORCE_ONBOARDING|MEMBERSHIP|APPROVED_WORKFORCE_POLICY|BROWSER_SESSION|AUDIT|CATALOG)_[A-Z_]{1,64}$/u.test(
        error.code,
      )
    )
      publicCode = error.code;
    const origin =
      typeof error?.stack === "string"
        ? error.stack.match(
            /(workforce-onboarding-operation-store|workforce-onboarding-operation|workforce-invitation-store|approved-workforce-membership-store|approved-workforce-policy-store)\.ts:(\d{1,5})/u,
          )
        : null;
    if (origin) publicOrigin = `${origin[1]}:${origin[2]}`;
    if (error?.code === "ERR_ASSERTION") publicCode = "ERR_ASSERTION";
    else if (error instanceof TypeError) publicCode = "TYPE_ERROR";
  } finally {
    fetchSpy?.mockRestore();
    sdkSpy?.mockRestore();
    for (const client of clients)
      await client.end().catch(() => {
        cleanupFailed = true;
      });
    await admin.query("ROLLBACK").catch(() => {
      cleanupFailed = true;
    });
    for (const [principal, created] of [
      [role, roleCreated],
      [preparationRole, preparationRoleCreated],
    ])
      if (created) {
        await admin.query(`DROP OWNED BY ${principal}`).catch(() => {
          cleanupFailed = true;
        });
        await admin.query(`DROP ROLE ${principal}`).catch(() => {
          cleanupFailed = true;
        });
      }
    await admin.end().catch(() => {
      cleanupFailed = true;
    });
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
  }
  if (primary || cleanupFailed)
    throw new Error(
      `WORKFORCE_ONBOARDING_BROWSER_NATIVE_FAILED:${stage}:SQLSTATE=${sqlState}:CODE=${publicCode}:ORIGIN=${publicOrigin}:INSPECTION=${inspectionStep}:CLEANUP=${cleanupFailed ? "failed" : "ok"}`,
    );
}
