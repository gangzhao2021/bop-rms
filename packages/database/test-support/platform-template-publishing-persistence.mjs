import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Buffer } from "node:buffer";
import pg from "pg";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
import {
  createPostgresPlatformBrowserSessionStore,
  createPostgresCurrentPlatformBrowserSessionSource,
  PlatformBrowserSessionService,
  platformSessionCookie,
} from "../../bop/identity/src/index.ts";
import { createPostgresPlatformActorDirectorySource } from "../../bop/identity/src/infrastructure/persistence/platform-actor-directory-store.ts";
import { createPostgresPlatformActorDirectoryProvisioner } from "../../bop/identity/src/infrastructure/persistence/platform-actor-directory-provisioner.ts";
import {
  createPostgresPlatformPermissionSource,
  createPostgresPlatformPermissionProvisioner,
  platformPermissionActions,
} from "../../bop/permission/src/index.ts";
import {
  createPostgresPlatformBrandTemplateStore,
  parsePlatformBrandTemplateSave,
  platformBrandTemplateIntentDigest,
} from "../../bop/tenant/src/index.ts";
import { createPlatformTemplateAdministration } from "../../../apps/api/src/platform-template-administration.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { createPostgresPlatformPublishingStore } from "../../bop/publishing/src/infrastructure/persistence/platform-publishing-store.ts";
import {
  parsePlatformPublishingOriginal,
  platformPublishingIntentDigest,
} from "../../bop/publishing/src/contracts/platform-publishing-source.ts";
import { createBrandPlatformTemplateReferenceNative } from "./brand-platform-template-reference.mjs";

const id = (n) => `01902628-0040-7000-8000-${n.toString(16).padStart(12, "0")}`;
const purpose = "PLATFORM_BRAND_TEMPLATE";
const scope = (actorReference) => ({ kind: "Platform", actorReference, purposeCode: purpose });
const publishingHead = (source) => ({
  lifecycleReference: source.command.next.lifecycleId,
  version: source.command.next.version,
  sourceDigest: source.sourceDigest,
});
const policyHead = (policy) =>
  policy === null
    ? null
    : {
        policyReference: policy.policyReference,
        revision: policy.revision,
        sourceDigest: policy.sourceDigest,
      };
const templateHead = (snapshot) =>
  snapshot === null
    ? null
    : {
        revision: snapshot.revision,
        templateVersionReference: snapshot.templateVersionReference,
        sourceDigest: snapshot.sourceDigest,
      };

/** Genuine local Directory -> encrypted Session/MFA -> Permission -> Tenant ->
 * Publishing/Audit composition. Remote subject status, deployment approval and
 * synthetic TOTP origin are controlled InternalTest inputs, not live Cognito proof. */
export async function verifyPlatformTemplatePublishingPersistence(
  context,
  { now, hasher, envelopes, onPublished },
) {
  const admin = new pg.Client(context.clientConfig),
    clients = [],
    roles = [];
  const names = {
    directory: `template_directory_${context.runId}`,
    policy: `template_policy_${context.runId}`,
    session: `template_session_${context.runId}`,
    author: `template_author_${context.runId}`,
    reviewer: `template_reviewer_${context.runId}`,
  };
  const author = id(1),
    reviewer = id(2),
    operator = id(3),
    deploymentApprover = id(4),
    configuration = {
      environment: "synthetic",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_NativeTemplate",
      clientIds: ["nativetemplate"],
    };
  const subjects = new Map([
    [author, "opaque-native-template-author"],
    [reviewer, "opaque-native-template-reviewer"],
  ]);
  let allocated = 1000,
    stage = "Setup",
    sqlState = "none",
    remoteEnabled = true;
  let httpRuntime,
    brandReferences,
    referenceCleanupFailed = false;
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const query = async (client, sql, values = []) => {
    try {
      return await client.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const next = () => id(++allocated);
  const codec = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (text) => `sha256:${sha256Hex(text)}`,
  };
  const remote = async (input) => ({
    ...input,
    status: remoteEnabled ? "Enabled" : "Disabled",
    validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
  });
  await admin.connect();
  try {
    const connected = {};
    for (const [kind, role] of Object.entries(names)) {
      assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
      const password = randomBytes(32).toString("hex");
      await query(
        admin,
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      roles.push(role);
      await query(
        admin,
        `GRANT USAGE ON SCHEMA bop_identity,bop_permission,bop_tenant,bop_publishing,platform_audit,platform_helpers TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),bop_identity.platform_actor_directory_import_capable() TO ${role}`,
      );
      const client = new pg.Client({ ...context.clientConfig, user: role, password });
      await client.connect();
      clients.push(client);
      connected[kind] = client;
    }
    const {
      directory: directoryClient,
      policy: policyClient,
      session: sessionClient,
      author: authorClient,
      reviewer: reviewerClient,
    } = connected;
    for (const kind of ["directory", "policy", "author", "reviewer"]) {
      const role = names[kind];
      await query(
        admin,
        `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
      );
    }
    await query(
      admin,
      `GRANT SELECT,INSERT ON bop_identity.platform_actor_directory_revision TO ${names.directory}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON bop_identity.platform_actor_directory_head TO ${names.directory}`,
    );
    await query(
      admin,
      `GRANT SELECT,UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.authentication_session TO ${names.directory}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_import_admit(uuid,uuid,uuid),platform_audit.matches_platform_actor_directory_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${names.directory}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session TO ${names.session}`,
    );
    for (const kind of ["session", "author", "reviewer"]) {
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_read(uuid,text,text,text) TO ${names[kind]}`,
      );
    }
    for (const kind of ["policy", "author", "reviewer"]) {
      await query(
        admin,
        `GRANT SELECT ON bop_permission.platform_permission_policy_revision,bop_permission.platform_permission_policy_head TO ${names[kind]}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_import_capable() TO ${names[kind]}`,
      );
    }
    await query(
      admin,
      `GRANT INSERT ON bop_permission.platform_permission_policy_revision TO ${names.policy}`,
    );
    await query(
      admin,
      `GRANT INSERT,UPDATE ON bop_permission.platform_permission_policy_head TO ${names.policy}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_import_admit(uuid,uuid,uuid),platform_audit.matches_platform_permission_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${names.policy}`,
    );
    for (const kind of ["author", "reviewer"]) {
      const role = names[kind];
      await query(
        admin,
        `GRANT SELECT,UPDATE(session_id) ON bop_identity.authentication_session TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_policy_hold(uuid,text) TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT,INSERT ON bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_tenant.platform_brand_template_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT,INSERT ON bop_publishing.platform_template_publishing_operation TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT ON bop_publishing.platform_template_publishing_head TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_publishing.platform_template_publishing_operation_admit(uuid,uuid),bop_publishing.platform_template_publishing_family_admit(uuid,uuid,boolean),bop_publishing.platform_template_publishing_head_advance(uuid,uuid,uuid,integer,boolean,boolean,boolean),platform_audit.matches_platform_template_publishing_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_publishing.platform_template_publishing_canonical_instant(text) TO ${role}`,
      );
      const acl = (
        await query(
          admin,
          `SELECT rolsuper,rolbypassrls,
        has_table_privilege($1,'bop_identity.platform_actor_directory_revision','SELECT') directory_read,
        has_table_privilege($1,'bop_permission.platform_permission_policy_revision','INSERT') policy_insert,
        has_table_privilege($1,'bop_identity.authentication_session','UPDATE') session_update,
        has_table_privilege($1,'bop_publishing.platform_template_publishing_head','UPDATE') head_update,
        has_table_privilege($1,'bop_publishing.platform_template_publishing_operation','DELETE') history_delete
        FROM pg_roles WHERE rolname=$1`,
          [role],
        )
      ).rows[0];
      assert.deepEqual(acl, {
        rolsuper: false,
        rolbypassrls: false,
        directory_read: false,
        policy_insert: false,
        session_update: false,
        head_update: false,
        history_delete: false,
      });
    }
    async function transaction(client, work, controls = {}) {
      const observedAt = now(),
        validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
        guards = [],
        finals = [],
        owners = [];
      let active = true,
        clockAt = observedAt;
      const tx = {
        query: async (sql, values) => {
          assert(active);
          controls.capture?.push({ sql, values: [...values] });
          const result = await query(client, sql, values);
          await controls.afterQuery?.(sql, values, result);
          return result;
        },
      };
      const h = {
        tx,
        clock: { now: () => clockAt },
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        registerBeforeCommit: async (actual, guard, final) => {
          assert.equal(actual, tx);
          guards.push(guard);
          finals.push(final);
        },
        retain: (owner) => {
          owners.push(owner);
          return owner;
        },
      };
      await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        const result = await work(h);
        if (controls.failWork) throw new Error("CONTROLLED_PUBLISHING_CALLER_ROLLBACK");
        await controls.beforeGuards?.();
        if (controls.guardAt) clockAt = controls.guardAt;
        assert(guards.length > 0);
        for (const guard of guards) await guard();
        await query(client, "SET CONSTRAINTS ALL IMMEDIATE");
        if (controls.expireAtFinal) clockAt = validUntil;
        for (const final of finals) final();
        active = false;
        await query(client, "COMMIT");
        clockAt = validUntil;
        for (const owner of owners) owner.assertFinalized();
        return result;
      } catch (error) {
        active = false;
        await query(client, "ROLLBACK");
        throw error;
      }
    }
    const directoryOptions = (h) => ({
      transaction: h.tx,
      configuration,
      clock: h.clock,
      originalObservedAt: h.originalObservedAt,
      originalValidUntil: h.originalValidUntil,
      hasher,
      envelopes,
      readCurrentProviderSubject: remote,
      registerBeforeCommit: h.registerBeforeCommit,
    });
    const directorySource = (h) =>
      h.retain(createPostgresPlatformActorDirectorySource(directoryOptions(h)));
    mark("Genuine approved directory import for two opaque subjects");
    for (const actor of [author, reviewer]) {
      await transaction(directoryClient, async (h) => {
        const owner = h.retain(
          createPostgresPlatformActorDirectoryProvisioner({
            ...directoryOptions(h),
            operatorReference: operator,
            provisioningRoleName: names.directory,
            authority: {
              async hold(actual, request) {
                assert.equal(actual, h.tx);
                assert.equal(request.command.actorReference, actor);
                return {
                  operatorReference: operator,
                  approvedByReference: deploymentApprover,
                  approvalReference: id(5),
                  validUntil: h.originalValidUntil,
                };
              },
            },
            nextReference: next,
            appendAudit: appendPlatformAuditRecordInTransaction,
          }),
        );
        return owner.provision({
          profile: "PlatformActorDirectoryCommandV1",
          operation: "ImportActive",
          operationReference: next(),
          actorReference: actor,
          expectedHead: null,
          subject: subjects.get(actor),
          recordedByReference: operator,
          approvedByReference: deploymentApprover,
          approvalReference: id(5),
          reasonCode: "CONTROLLED_APPROVED_DIRECTORY",
        });
      });
    }
    const sessionConfiguration = {
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientIds[0],
      redirectUri: "https://platform.invalid/platform/auth/callback",
      allowedPostLoginPaths: ["/platform/tenants"],
    };
    const sessionStore = createPostgresPlatformBrowserSessionStore({
      ...sessionConfiguration,
      hasher,
      envelopes,
      now,
      transactions: {
        run: (work) =>
          transaction(sessionClient, async (h) => {
            h.tx.directory = directorySource(h);
            return work(h.tx);
          }),
      },
      currentActor: (tx, actor, authenticatedAt, observedAt) =>
        tx.directory.currentActor(tx, actor, authenticatedAt, observedAt),
    });
    const cookies = new Map();
    const csrfByActor = new Map();
    mark("Actual encrypted independently authenticated author and reviewer Sessions");
    for (const actor of [author, reviewer]) {
      const client = actor === author ? authorClient : reviewerClient;
      const actual = await transaction(client, (h) =>
        directorySource(h).resolveVerifiedSubject({
          issuer: configuration.issuer,
          clientId: configuration.clientIds[0],
          subject: subjects.get(actor),
          authenticatedAt: h.originalObservedAt,
          observedAt: h.originalObservedAt,
        }),
      );
      const sessionReference = next(),
        credential = randomBytes(32).toString("base64url"),
        csrf = randomBytes(32).toString("base64url"),
        authenticatedAt = actual.authenticatedAt;
      const encryptedSecrets = await envelopes.encrypt(
        JSON.stringify({
          profile: "PlatformBrowserSessionV1",
          issuer: configuration.issuer,
          clientId: configuration.clientIds[0],
          tokenBundle: "synthetic-native-template-refresh",
          csrf,
          mfa: {
            sessionReference,
            actorReference: actor,
            method: "Totp",
            evidenceReference: next(),
            authorizationTransactionReference: next(),
            authenticatedAt,
            verifiedAt: authenticatedAt,
            validUntil: new Date(Date.parse(authenticatedAt) + 900000).toISOString(),
          },
        }),
        `${configuration.environment}:platform-session:${sessionReference}:${actor}`,
      );
      const record = await sessionStore.createSession({
        sessionReference,
        actor: actual,
        policyCode: "Privileged",
        sessionSelectorHash: hasher.hash(credential),
        csrfSelectorHash: hasher.hash(csrf),
        encryptedSecrets,
        observedAt: now(),
      });
      assert.equal(record.session.actor.actorReference, actor);
      cookies.set(actor, credential);
      csrfByActor.set(actor, csrf);
    }
    function identity(h, actor) {
      const directory = directorySource(h),
        read = createPostgresCurrentPlatformBrowserSessionSource({
          ...sessionConfiguration,
          hasher,
          envelopes,
          now: h.clock.now,
          currentActor: (actual, ref, authenticatedAt, observedAt) =>
            directory.currentActor(actual, ref, authenticatedAt, observedAt),
        });
      return async (actual) => {
        assert.equal(actual, h.tx);
        const packet = await read(actual, cookies.get(actor));
        assert.equal(packet.session.actor.actorReference, actor);
        return packet;
      };
    }
    const from = new Date(Date.parse(now()) - 1000).toISOString(),
      until = new Date(Date.parse(now()) + 3600000).toISOString();
    function policyContent(expires = until, denyPublish = false, denyRead = false) {
      return {
        roleCode: "PlatformAdministrator",
        effectiveFrom: from,
        effectiveUntil: expires,
        entries: [
          ...platformPermissionActions.map((action, n) => ({
            evidenceReference: id(100 + n),
            action,
            effect: "Allow",
            effectiveFrom: from,
            effectiveUntil: expires,
          })),
          ...(denyRead
            ? [
                {
                  evidenceReference: id(201),
                  action: "platform.brand-template.read",
                  effect: "Deny",
                  effectiveFrom: from,
                  effectiveUntil: expires,
                },
              ]
            : []),
          ...(denyPublish
            ? [
                {
                  evidenceReference: id(200),
                  action: "platform.brand-template.publish",
                  effect: "Deny",
                  effectiveFrom: from,
                  effectiveUntil: expires,
                },
              ]
            : []),
        ],
      };
    }
    const policies = new Map();
    async function provisionPolicy(actor, contents = policyContent()) {
      const previous = policies.get(actor) ?? null;
      const result = await transaction(policyClient, async (h) => {
        const owner = h.retain(
          createPostgresPlatformPermissionProvisioner({
            transaction: h.tx,
            operatorScope: scope(operator),
            provisioningRoleName: names.policy,
            clock: h.clock,
            originalObservedAt: h.originalObservedAt,
            originalValidUntil: h.originalValidUntil,
            authority: {
              async hold(actual, request) {
                assert.equal(actual, h.tx);
                return {
                  operatorReference: operator,
                  approvedByReference: deploymentApprover,
                  approvalEvidenceReference: id(6),
                  validUntil: request.validUntil,
                };
              },
            },
            nextReference: next,
            appendAudit: appendPlatformAuditRecordInTransaction,
            registerBeforeCommit: h.registerBeforeCommit,
          }),
        );
        return owner.provision({
          profile: "PlatformPermissionProvisionV1",
          targetActorReference: actor,
          purposeCode: purpose,
          operationReference: next(),
          expectedHead: policyHead(previous),
          content: contents,
          recordedByReference: operator,
          approvedByReference: deploymentApprover,
          approvalEvidenceReference: id(6),
          reasonCode: "CONTROLLED_APPROVED_PROVISIONING",
        });
      });
      policies.set(actor, result);
      return result;
    }
    mark("Actual explicit persisted Platform Permission policies");
    await provisionPolicy(author);
    await provisionPolicy(reviewer);
    function permission(h, actor) {
      return h.retain(
        createPostgresPlatformPermissionSource({
          transaction: h.tx,
          scope: scope(actor),
          clock: h.clock,
          originalObservedAt: h.originalObservedAt,
          originalValidUntil: h.originalValidUntil,
          currentIdentity: identity(h, actor),
          registerBeforeCommit: h.registerBeforeCommit,
        }),
      );
    }
    const content = {
      code: "NATIVE_PLATFORM_PUBLISHING_TEMPLATE",
      name: "Native publication template",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA"],
      overrideAllowedFieldCodes: ["DEFAULT_LOCALE"],
      hardRequirementFieldCodes: ["SUPPORTED_LOCALES"],
      effectiveFrom: from,
      effectiveUntil: until,
      reasonCode: "ADMIN_CONFIGURATION",
    };
    function templateOwner(h, actor) {
      const p = permission(h, actor),
        owner = h.retain(
          createPostgresPlatformBrandTemplateStore({
            kind: "Platform",
            actorReference: actor,
            purposeCode: purpose,
            transaction: h.tx,
            clock: h.clock,
            originalObservedAt: h.originalObservedAt,
            originalValidUntil: h.originalValidUntil,
            references: { ...codec, nextReference: next },
            authority: {
              async holdUntilTransactionCompletes(actual, request) {
                assert.equal(actual, h.tx);
                assert.equal(request.actorReference, actor);
                assert.equal(request.purposeCode, purpose);
                const held = await p.authorize({ action: request.permission });
                return { validUntil: held.validUntil };
              },
            },
            appendAudit: async (actual, input) => {
              assert.equal(actual, h.tx);
              await appendPlatformAuditRecordInTransaction(actual, {
                auditReference: input.auditReference,
                actorReference: actor,
                purposeCode: purpose,
                actionCode: "PLATFORM_BRAND_TEMPLATE_SAVED",
                targetType: "PlatformBrandTemplate",
                targetReference: input.templateReference,
                operationReference: input.operationReference,
                intentDigest: input.intentDigest,
                occurredAt: input.occurredAt,
                reasonCode: "ADMIN_CONFIGURATION",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              });
            },
            registerBeforeCommit: h.registerBeforeCommit,
          }),
        );
      return owner;
    }
    async function saveTemplate(previous = null, controls = {}, templateContent = content) {
      return transaction(
        authorClient,
        async (h) => {
          return templateOwner(h, author).save({
            profile: "PlatformBrandTemplateSaveV1",
            kind: "Platform",
            actorReference: author,
            purposeCode: purpose,
            operationReference: next(),
            templateReference: previous?.templateReference ?? null,
            expectedHead: templateHead(previous),
            content: {
              ...templateContent,
              name:
                previous === null ? templateContent.name : "Native revised publication template",
            },
          });
        },
        controls,
      );
    }
    const readTemplateList = (actor, after = null, limit = 1) =>
      transaction(clientFor(actor), (h) => templateOwner(h, actor).list({ after, limit }));
    function publishing(h, actor) {
      return h.retain(
        createPostgresPlatformPublishingStore({
          transaction: h.tx,
          scope: scope(actor),
          clock: h.clock,
          originalObservedAt: h.originalObservedAt,
          originalValidUntil: h.originalValidUntil,
          currentIdentity: identity(h, actor),
          nextReference: next,
          registerBeforeCommit: h.registerBeforeCommit,
        }),
      );
    }
    const clientFor = (actor) => (actor === author ? authorClient : reviewerClient);
    const execute = (actor, request, controls = {}) =>
      transaction(clientFor(actor), (h) => publishing(h, actor).execute(request), controls);
    const resolve = (actor, request) =>
      transaction(clientFor(actor), (h) => publishing(h, actor).resolve(request));
    const readCurrent = (actor, template, lifecycleReference = null) =>
      transaction(clientFor(actor), (h) =>
        publishing(h, actor).current({ templateReference: template, lifecycleReference }),
      );
    const readHistory = (actor, template, beforeSequence = null) =>
      transaction(clientFor(actor), (h) =>
        publishing(h, actor).history({ templateReference: template, beforeSequence }),
      );
    const request = (operation, snapshot, previous = null, operationReference = next()) => ({
      profile: "PlatformPublishingRequestV1",
      operation,
      operationReference,
      templateReference: snapshot.templateReference,
      templateVersionReference: snapshot.templateVersionReference,
      contentDigest: snapshot.contentDigest,
      templateSourceDigest: snapshot.sourceDigest,
      expectedLifecycle: previous === null ? null : publishingHead(previous),
      reviewValidUntil:
        operation === "SubmitReview" ? new Date(Date.parse(now()) + 600000).toISOString() : null,
      reasonCode: "ADMIN_CONFIGURATION",
    });
    const originalResolve = (actor, input) => ({
      profile: "PlatformPublishingResolveV1",
      operationReference: input.operationReference,
      intentDigest: platformPublishingIntentDigest(
        parsePlatformPublishingOriginal({
          profile: "PlatformPublishingOriginalV1",
          scope: scope(actor),
          request: input,
        }),
      ),
    });
    const state = async () =>
      (
        await query(
          admin,
          `SELECT
      (SELECT count(*)::int FROM bop_publishing.platform_template_publishing_operation) operations,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY family_id),'[]'::jsonb) FROM bop_publishing.platform_template_publishing_head h) heads,
      (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record) audits,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY actor_id,purpose_code),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head h) audit_heads,
      (SELECT count(*)::int FROM bop_tenant.platform_brand_template_revision) templates,
      (SELECT count(*)::int FROM bop_tenant.platform_brand_template_operation) template_operations`,
        )
      ).rows[0];

    mark("Actual Tenant Save -> Draft -> Submit and distinct-Actor approval");
    const saved = await saveTemplate(),
      snapshot = saved.snapshot;
    assert(snapshot);
    const draftRequest = request("CreateDraft", snapshot),
      draft = await execute(author, draftRequest);
    const reviewRequest = request("SubmitReview", snapshot, draft.source),
      review = await execute(author, reviewRequest);
    const beforeSelf = await state();
    await assert.rejects(execute(author, request("Approve", snapshot, review.source)));
    assert.deepEqual(await state(), beforeSelf);
    const beforeNewDraft = await state();
    await assert.rejects(execute(author, request("CreateDraft", snapshot, null)));
    assert.deepEqual(await state(), beforeNewDraft);
    mark("Post-Submit authored edit and new Draft do not strand the original Review");
    const revised = (await saveTemplate(snapshot)).snapshot;
    assert(revised);
    mark("Actual two-Actor discovery uses latest authored labels and stable owner cursor");
    const discoverySnapshot = (
      await saveTemplate(
        null,
        {},
        {
          ...content,
          code: "ZZ_NATIVE_DISCOVERY_TEMPLATE",
          name: "Native second discovery template",
        },
      )
    ).snapshot;
    assert(discoverySnapshot);
    const beforeDiscovery = await state(),
      allocatedBeforeDiscovery = allocated;
    for (const actor of [author, reviewer]) {
      const discovered = [];
      let cursor = null,
        pages = 0;
      do {
        const page = await readTemplateList(actor, cursor);
        assert.equal(page.actorReference, actor);
        assert.equal(page.publication, "NotEvaluated");
        assert.equal(page.limit, 1);
        assert(page.items.length <= 1);
        assert(++pages <= 64);
        discovered.push(...page.items);
        if (page.hasMore) {
          assert.equal(page.items.length, 1);
          assert.deepEqual(page.nextCursor, {
            code: page.items[0].code,
            templateReference: page.items[0].templateReference,
          });
        } else assert.equal(page.nextCursor, null);
        cursor = page.nextCursor;
      } while (cursor !== null);
      assert.deepEqual(
        discovered.find((item) => item.templateReference === revised.templateReference),
        {
          templateReference: revised.templateReference,
          templateVersionReference: revised.templateVersionReference,
          revision: revised.revision,
          code: revised.content.code,
          name: revised.content.name,
          contentDigest: revised.contentDigest,
          sourceDigest: revised.sourceDigest,
          authoredByReference: author,
          recordedAt: revised.recordedAt,
        },
      );
      assert.deepEqual(
        discovered.find((item) => item.templateReference === discoverySnapshot.templateReference),
        {
          templateReference: discoverySnapshot.templateReference,
          templateVersionReference: discoverySnapshot.templateVersionReference,
          revision: 1,
          code: discoverySnapshot.content.code,
          name: discoverySnapshot.content.name,
          contentDigest: discoverySnapshot.contentDigest,
          sourceDigest: discoverySnapshot.sourceDigest,
          authoredByReference: author,
          recordedAt: discoverySnapshot.recordedAt,
        },
      );
      assert.equal(
        new Set(discovered.map((item) => item.templateReference)).size,
        discovered.length,
      );
      for (let i = 1; i < discovered.length; i++) {
        const prior = discovered[i - 1],
          current = discovered[i];
        assert(
          prior.code < current.code ||
            (prior.code === current.code && prior.templateReference < current.templateReference),
        );
      }
    }
    assert.equal(allocated, allocatedBeforeDiscovery);
    assert.deepEqual(await state(), beforeDiscovery);
    const newDraft = await execute(author, request("CreateDraft", revised, review.source));
    assert.notEqual(
      newDraft.source.command.next.lifecycleId,
      review.source.command.next.lifecycleId,
    );
    assert.equal(
      (
        await readCurrent(
          reviewer,
          snapshot.templateReference,
          review.source.command.next.lifecycleId,
        )
      ).current.command.next.state,
      "InReview",
    );
    const approved = await execute(reviewer, request("Approve", snapshot, review.source));
    const publishRequest = request("Publish", snapshot, approved.source),
      published = await execute(reviewer, publishRequest);
    const current = await readCurrent(author, snapshot.templateReference);
    assert.equal(
      current.current.command.next.lifecycleId,
      newDraft.source.command.next.lifecycleId,
    );
    assert.deepEqual(current.currentRelease, published.source);
    assert.deepEqual(
      (
        await readCurrent(
          author,
          snapshot.templateReference,
          review.source.command.next.lifecycleId,
        )
      ).current,
      published.source,
    );
    const history = await readHistory(reviewer, snapshot.templateReference);
    assert.equal(history.items.length, 5);
    assert.equal(history.items[0].command.next.state, "Published");
    const exact = await transaction(authorClient, (h) =>
      publishing(h, author).exact({
        templateReference: snapshot.templateReference,
        sequence: review.source.sequence,
      }),
    );
    assert.deepEqual(exact.source, review.source);
    mark("Actual Brand consumer reads genuine Published Platform Template material");
    brandReferences = await createBrandPlatformTemplateReferenceNative(context, { admin, now });
    await brandReferences.verifyPublished({
      snapshot,
      source: published.source,
      unpublishedVersionReference: revised.templateVersionReference,
      unpublishedFamilyVersionReference: discoverySnapshot.templateVersionReference,
    });
    mark("Original replay/lost reply recovery allocate nothing and retain immutable source");
    const beforeReplay = await state(),
      allocationBefore = allocated;
    assert.deepEqual(await execute(reviewer, publishRequest), published);
    assert.deepEqual(await resolve(reviewer, originalResolve(reviewer, publishRequest)), published);
    assert.equal(allocated, allocationBefore);
    assert.deepEqual(await state(), beforeReplay);
    await assert.rejects(
      execute(reviewer, { ...publishRequest, reasonCode: "CHANGED_ORIGINAL_REASON" }),
    );
    await assert.rejects(execute(reviewer, request("Publish", snapshot, approved.source)));
    assert.deepEqual(await state(), beforeReplay);
    mark("Absent original -> real Abandoned and late writer fence");
    const abandonedRequest = request("CreateDraft", revised, newDraft.source),
      absent = originalResolve(author, abandonedRequest);
    const abandoned = await resolve(author, absent);
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.source, null);
    const beforeAbandonedReplay = await state(),
      allocatedBeforeAbandonedReplay = allocated;
    assert.deepEqual(await resolve(author, absent), abandoned);
    await assert.rejects(execute(author, abandonedRequest));
    assert.equal(allocated, allocatedBeforeAbandonedReplay);
    assert.deepEqual(await state(), beforeAbandonedReplay);
    await assert.rejects(resolve(author, { ...absent, intentDigest: `sha256:${"c".repeat(64)}` }));
    mark("Actual persisted read Deny refuses discovery without effects");
    await provisionPolicy(reviewer, policyContent(until, false, true));
    const beforeDiscoveryDeny = await state();
    await assert.rejects(readTemplateList(reviewer));
    assert.deepEqual(await state(), beforeDiscoveryDeny);
    await provisionPolicy(reviewer);
    mark("Actual withdrawn/expired Permission and remote Actor rollback");
    await provisionPolicy(reviewer, policyContent(until, true));
    const beforeDeny = await state();
    await assert.rejects(
      execute(reviewer, request("Publish", snapshot, approved.source)),
      (error) => error.code === "PLATFORM_PERMISSION_DENIED",
    );
    assert.deepEqual(await state(), beforeDeny);
    await provisionPolicy(reviewer);
    const shortUntil = new Date(Date.parse(now()) + 2000).toISOString();
    await provisionPolicy(author, policyContent(shortUntil));
    const beforeExpiry = await state();
    await assert.rejects(
      execute(author, request("CreateDraft", revised, newDraft.source), { guardAt: shortUntil }),
    );
    assert.deepEqual(await state(), beforeExpiry);
    await provisionPolicy(author);
    const beforeWithdrawal = await state();
    await assert.rejects(
      execute(author, request("CreateDraft", revised, newDraft.source), {
        beforeGuards: () => {
          remoteEnabled = false;
        },
      }),
    );
    remoteEnabled = true;
    assert.deepEqual(await state(), beforeWithdrawal);
    await assert.rejects(
      execute(author, request("CreateDraft", revised, newDraft.source), { expireAtFinal: true }),
    );
    assert.deepEqual(await state(), beforeWithdrawal);
    mark("Raw missing, wrong and older-transaction Audit cannot commit genuine captured source");
    const capture = [],
      capturedRequest = request("CreateDraft", revised, newDraft.source);
    await assert.rejects(execute(author, capturedRequest, { failWork: true, capture }));
    assert.deepEqual(await state(), beforeWithdrawal);
    const insertion = capture.find((item) =>
        item.sql.startsWith("INSERT INTO bop_publishing.platform_template_publishing_operation"),
      ),
      advance = capture.find((item) =>
        item.sql.startsWith("SELECT bop_publishing.platform_template_publishing_head_advance"),
      );
    assert(insertion);
    assert(advance);
    const auditInput = {
      auditReference: insertion.values[11],
      actorReference: author,
      purposeCode: purpose,
      actionCode: "PLATFORM_TEMPLATE_PUBLISHING_RECORDED",
      targetType: "PlatformTemplatePublishingOperation",
      targetReference: insertion.values[0],
      operationReference: insertion.values[2],
      intentDigest: insertion.values[3],
      occurredAt: insertion.values[12],
      reasonCode: insertion.values[13],
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    };
    async function rawCaptured(mode) {
      await query(authorClient, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await query(
          authorClient,
          "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
          [author, purpose],
        );
        await query(
          authorClient,
          "SELECT bop_publishing.platform_template_publishing_operation_admit($1,$2)",
          [author, capturedRequest.operationReference],
        );
        await query(
          authorClient,
          "SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)",
          [author, null],
        );
        await query(
          authorClient,
          "SELECT bop_publishing.platform_template_publishing_family_admit($1,$2,$3)",
          [author, snapshot.templateReference, true],
        );
        await query(authorClient, insertion.sql, insertion.values);
        if (mode === "wrong")
          await appendPlatformAuditRecordInTransaction(
            { query: (sql, values) => query(authorClient, sql, values) },
            { ...auditInput, reasonCode: "WRONG_REAL_AUDIT_REASON" },
          );
        assert.equal(
          (await query(authorClient, advance.sql, advance.values)).rows[0].advanced,
          true,
        );
        await query(authorClient, "SET CONSTRAINTS ALL IMMEDIATE");
      } finally {
        await query(authorClient, "ROLLBACK");
      }
    }
    await assert.rejects(rawCaptured("none"), (error) => error.code === "23514");
    assert.deepEqual(await state(), beforeWithdrawal);
    await assert.rejects(rawCaptured("wrong"), (error) => error.code === "23514");
    assert.deepEqual(await state(), beforeWithdrawal);
    await query(authorClient, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(
        authorClient,
        "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
        [author, purpose],
      );
      await appendPlatformAuditRecordInTransaction(
        { query: (sql, values) => query(authorClient, sql, values) },
        auditInput,
      );
      await query(authorClient, "SET CONSTRAINTS ALL IMMEDIATE");
      await query(authorClient, "COMMIT");
    } catch (error) {
      await query(authorClient, "ROLLBACK");
      throw error;
    }
    const beforeOldAudit = await state();
    await assert.rejects(rawCaptured("old"), (error) => error.code === "23514");
    assert.deepEqual(await state(), beforeOldAudit);
    mark("Actual concurrent Publish serializes distinct approved cycles into unique releases");
    const secondReview = await execute(author, request("SubmitReview", revised, newDraft.source)),
      secondApproved = await execute(reviewer, request("Approve", revised, secondReview.source));
    const thirdDraft = await execute(
        author,
        request("CreateDraft", revised, secondApproved.source),
      ),
      thirdReview = await execute(author, request("SubmitReview", revised, thirdDraft.source)),
      thirdApproved = await execute(reviewer, request("Approve", revised, thirdReview.source));
    const reviewerPid = (await query(reviewerClient, "SELECT pg_backend_pid() pid")).rows[0].pid;
    const authorPid = (await query(authorClient, "SELECT pg_backend_pid() pid")).rows[0].pid;
    let enter,
      release,
      held = false;
    const entered = new Promise((resolveGate) => {
        enter = resolveGate;
      }),
      gate = new Promise((releaseGate) => {
        release = releaseGate;
      });
    const first = brandReferences
      .withWriterFence({ mode: "Current", snapshot, writerPid: authorPid }, () =>
        execute(author, request("Publish", revised, secondApproved.source), {
          afterQuery: async (sql, values) => {
            if (
              !held &&
              sql.startsWith("SELECT bop_publishing.platform_template_publishing_family_admit") &&
              values[2] === true
            ) {
              held = true;
              enter();
              await gate;
            }
          },
        }),
      )
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    let second, interleaveError;
    try {
      await Promise.race([
        entered,
        first.then((outcome) => {
          throw outcome.error ?? new Error("Publishing missed its family admission gate");
        }),
      ]);
      second = execute(reviewer, request("Publish", revised, thirdApproved.source)).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      const limit = Date.now() + 3000;
      let waiting = false;
      while (!waiting && Date.now() < limit)
        waiting = (
          await query(
            admin,
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) waiting",
            [reviewerPid],
          )
        ).rows[0].waiting;
      assert.equal(waiting, true);
    } catch (error) {
      interleaveError = error;
    } finally {
      release();
    }
    const firstOutcome = await first,
      secondOutcome = second === undefined ? null : await second;
    if (interleaveError) throw interleaveError;
    if (firstOutcome.error) throw firstOutcome.error;
    assert(secondOutcome);
    if (secondOutcome.error) throw secondOutcome.error;
    assert.equal(firstOutcome.result.source.command.release.sequence, 2);
    assert.equal(secondOutcome.result.source.command.release.sequence, 3);
    assert.equal(
      secondOutcome.result.source.command.release.previousReleaseId,
      firstOutcome.result.source.command.release.releaseId,
    );
    assert(secondOutcome.result.source.sequence > firstOutcome.result.source.sequence);
    const finalCurrent = await readCurrent(author, snapshot.templateReference);
    assert.deepEqual(finalCurrent.currentRelease, secondOutcome.result.source);
    assert.equal(
      (
        await query(
          admin,
          "SELECT count(DISTINCT receipt_text::jsonb#>>'{source,command,release,releaseId}')::int count FROM bop_publishing.platform_template_publishing_operation WHERE family_id=$1 AND operation_code='Publish'",
          [snapshot.templateReference],
        )
      ).rows[0].count,
      3,
    );
    await brandReferences.verifyReplaced({
      snapshot: revised,
      source: secondOutcome.result.source,
      previousVersionReference: snapshot.templateVersionReference,
    });
    mark("Archive removes current eligibility while retaining immutable release history");
    const archived = await brandReferences.withWriterFence(
      { mode: "List", snapshot: revised, writerPid: reviewerPid },
      () => execute(reviewer, request("Archive", revised, secondOutcome.result.source)),
    );
    assert.equal(archived.source.command.next.state, "Archived");
    assert.equal((await readCurrent(author, snapshot.templateReference)).currentRelease, null);
    const archivedHead = (
      await query(
        admin,
        "SELECT release_active,release_record_id IS NOT NULL retained FROM bop_publishing.platform_template_publishing_head WHERE family_id=$1",
        [snapshot.templateReference],
      )
    ).rows[0];
    assert.deepEqual(archivedHead, { release_active: false, retained: true });
    const historicalRelease = await transaction(authorClient, (h) =>
      publishing(h, author).exact({
        templateReference: snapshot.templateReference,
        sequence: secondOutcome.result.source.sequence,
      }),
    );
    assert.deepEqual(historicalRelease.source, secondOutcome.result.source);
    await brandReferences.verifyArchived({ snapshot: revised });
    mark("Actual ordinary Platform Template facade and HTTP admission");
    // Provider exchanges are outside this local proof. These methods must never
    // run: authorize reads the genuine persisted encrypted Sessions instead.
    const unusedProvider = () => {
      throw new Error("UNINVOKED_EXTERNAL_PROVIDER");
    };
    const authentication = new PlatformBrowserSessionService({
      configuration: sessionConfiguration,
      store: sessionStore,
      provider: {
        createAuthorizationUrl: unusedProvider,
        exchangeCode: unusedProvider,
        revokeRefreshTokens: unusedProvider,
        createLogoutUrl: unusedProvider,
      },
      hasher,
      envelopes,
      now,
      credentials: {
        generate: () => randomBytes(32).toString("base64url"),
        generateUuidV7: next,
      },
      pkce: { challenge: unusedProvider },
    });
    const facadeHosts = new WeakMap();
    let nextHttpControls = {};
    const administration = createPlatformTemplateAdministration({
      authentication,
      persistence: {
        ...sessionConfiguration,
        hasher,
        envelopes,
        now,
        currentActor(actual, actor, authenticatedAt, observedAt) {
          const h = facadeHosts.get(actual);
          assert(h, "currentActor must use the actual facade transaction");
          return h.tx.directory.currentActor(actual, actor, authenticatedAt, observedAt);
        },
        transactions: {
          async run(work) {
            const controls = nextHttpControls;
            nextHttpControls = {};
            let borrowed;
            try {
              return await transaction(
                authorClient,
                async (h) => {
                  borrowed = h.tx;
                  facadeHosts.set(h.tx, h);
                  h.tx.directory = directorySource(h);
                  return work(h.tx);
                },
                controls,
              );
            } finally {
              if (borrowed) facadeHosts.delete(borrowed);
            }
          },
        },
      },
      registerBeforeCommit(actual, guard, final) {
        const h = facadeHosts.get(actual);
        assert(h, "owner guard must retain the actual transaction until COMMIT");
        return h.registerBeforeCommit(actual, guard, final);
      },
      nextReference: next,
    });
    httpRuntime = createApiServerRuntime({
      port: 0,
      logger: createApiRuntimeLogger({ write: () => undefined }),
      platformTemplateAdministration: {
        exactOrigin: "https://platform.invalid",
        acceptedHost: "platform.invalid",
        administration,
      },
    });
    await httpRuntime.listen();
    const address = httpRuntime.server.address();
    assert(address && typeof address !== "string");
    async function http(actor, endpoint, body, csrf = csrfByActor.get(actor)) {
      const bytes = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: `/platform/templates/${endpoint}`,
            method: "POST",
            headers: {
              Host: "platform.invalid",
              Origin: "https://platform.invalid",
              "Sec-Fetch-Site": "same-origin",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bytes),
              Cookie: `${platformSessionCookie.name}=${cookies.get(actor)}`,
              "X-Bop-Csrf": csrf,
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  body: JSON.parse(text),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("NATIVE_HTTP_TIMEOUT")));
        req.end(bytes);
      });
    }
    async function success(actor, endpoint, body) {
      const result = await http(actor, endpoint, body);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      return result.body;
    }
    const actions = await success(author, "query", { action: "Actions" });
    assert.equal(actions.scope.actorReference, author);
    assert.deepEqual(
      actions.allowedActions,
      platformPermissionActions.filter(
        (action) => action !== "platform.operate" && action !== "platform.brand-template.read",
      ),
    );
    const httpSave = {
      action: "Save",
      operationReference: next(),
      templateReference: null,
      expectedHead: null,
      content: { ...content, code: "NATIVE_HTTP_PLATFORM_TEMPLATE", name: "Native HTTP template" },
    };
    mark("HTTP Save current history list and immutable original recovery");
    const savedHttp = await success(author, "command", httpSave);
    assert.equal(savedHttp.outcome, "Committed");
    const httpSnapshot = savedHttp.snapshot;
    assert(httpSnapshot);
    const httpCurrent = await success(reviewer, "query", {
      action: "Current",
      templateReference: httpSnapshot.templateReference,
    });
    assert.deepEqual(httpCurrent.current, httpSnapshot);
    const httpHistory = await success(reviewer, "query", {
      action: "History",
      templateReference: httpSnapshot.templateReference,
      beforeRevision: null,
    });
    assert.deepEqual(httpHistory.entries[0], httpSnapshot);
    const listed = await success(reviewer, "query", { action: "List", after: null, limit: 20 });
    assert(listed.items.some((item) => item.templateReference === httpSnapshot.templateReference));
    const originalHttpSave = parsePlatformBrandTemplateSave({
      profile: "PlatformBrandTemplateSaveV1",
      ...scope(author),
      operationReference: httpSave.operationReference,
      templateReference: null,
      expectedHead: null,
      content: httpSave.content,
    });
    const savedIntent = platformBrandTemplateIntentDigest(originalHttpSave, codec);
    const replayState = await state(),
      replayAllocated = allocated;
    assert.deepEqual(await success(author, "command", httpSave), savedHttp);
    assert.deepEqual(
      await success(author, "command", {
        action: "ResolveSave",
        operationReference: httpSave.operationReference,
        intentDigest: savedIntent,
      }),
      savedHttp,
    );
    assert.equal(allocated, replayAllocated);
    assert.deepEqual(await state(), replayState);
    mark("HTTP real CSRF and current Permission denial leave no artifacts");
    const deniedState = await state(),
      deniedAllocated = allocated;
    const malformedCsrf = await http(author, "command", httpSave, "malformed");
    assert.equal(malformedCsrf.status, 403);
    assert.deepEqual(malformedCsrf.body, { error: "request_denied" });
    assert.equal(allocated, deniedAllocated);
    assert.deepEqual(await state(), deniedState);
    await provisionPolicy(reviewer, policyContent(until, false, true));
    const policyDeniedState = await state(),
      policyDeniedAllocated = allocated;
    const deniedList = await http(reviewer, "query", { action: "List", after: null, limit: 20 });
    assert.equal(deniedList.status, 403);
    assert.deepEqual(deniedList.body, { error: "request_denied" });
    assert.equal(allocated, policyDeniedAllocated);
    assert.deepEqual(await state(), policyDeniedState);
    await provisionPolicy(reviewer);
    mark("HTTP genuine Submit independent Approve and Publish");
    const httpDraft = await success(author, "command", {
      action: "Publication",
      request: request("CreateDraft", httpSnapshot),
    });
    const httpSubmitRequest = request("SubmitReview", httpSnapshot, httpDraft.source);
    const httpSubmitted = await success(author, "command", {
      action: "Publication",
      request: httpSubmitRequest,
    });
    const selfReviewState = await state();
    assert.notEqual(
      (
        await http(author, "command", {
          action: "Publication",
          request: request("Approve", httpSnapshot, httpSubmitted.source),
        })
      ).status,
      200,
    );
    assert.deepEqual(await state(), selfReviewState);
    const httpApproved = await success(reviewer, "command", {
      action: "Publication",
      request: request("Approve", httpSnapshot, httpSubmitted.source),
    });
    const httpPublishRequest = request("Publish", httpSnapshot, httpApproved.source);
    const withdrawalState = await state();
    nextHttpControls = {
      beforeGuards: () => {
        remoteEnabled = false;
      },
    };
    let lateWithdrawal;
    try {
      lateWithdrawal = await http(reviewer, "command", {
        action: "Publication",
        request: httpPublishRequest,
      });
    } finally {
      remoteEnabled = true;
    }
    assert.notEqual(lateWithdrawal.status, 200);
    assert.deepEqual(await state(), withdrawalState);
    const httpPublished = await success(reviewer, "command", {
      action: "Publication",
      request: httpPublishRequest,
    });
    assert.equal(httpPublished.source.command.next.state, "Published");
    const publicationCurrent = await success(author, "query", {
      action: "PublicationCurrent",
      templateReference: httpSnapshot.templateReference,
      lifecycleReference: null,
    });
    assert.deepEqual(publicationCurrent.currentRelease, httpPublished.source);
    const publicationHistory = await success(author, "query", {
      action: "PublicationHistory",
      templateReference: httpSnapshot.templateReference,
      beforeSequence: null,
    });
    assert.deepEqual(publicationHistory.items[0], httpPublished.source);
    const publicationOriginal = originalResolve(reviewer, httpPublishRequest);
    const publicationReplayState = await state(),
      publicationReplayAllocated = allocated;
    assert.deepEqual(
      await success(reviewer, "command", {
        action: "Publication",
        request: httpPublishRequest,
      }),
      httpPublished,
    );
    assert.deepEqual(
      await success(reviewer, "command", {
        action: "ResolvePublication",
        operationReference: publicationOriginal.operationReference,
        intentDigest: publicationOriginal.intentDigest,
      }),
      httpPublished,
    );
    assert.equal(allocated, publicationReplayAllocated);
    assert.deepEqual(await state(), publicationReplayState);
    mark("HTTP absent original Abandoned prevents late Save dispatch");
    const abandonedWire = {
      ...httpSave,
      operationReference: next(),
      content: { ...httpSave.content, code: "NATIVE_HTTP_ABANDONED" },
    };
    const abandonedOriginal = parsePlatformBrandTemplateSave({
      profile: "PlatformBrandTemplateSaveV1",
      ...scope(author),
      operationReference: abandonedWire.operationReference,
      templateReference: null,
      expectedHead: null,
      content: abandonedWire.content,
    });
    const abandonedIntent = platformBrandTemplateIntentDigest(abandonedOriginal, codec);
    const httpAbandoned = await success(author, "command", {
      action: "ResolveSave",
      operationReference: abandonedWire.operationReference,
      intentDigest: abandonedIntent,
    });
    assert.equal(httpAbandoned.outcome, "Abandoned");
    const abandonedState = await state(),
      abandonedAllocated = allocated;
    const blockedSave = await http(author, "command", abandonedWire);
    assert.notEqual(blockedSave.status, 200);
    assert.equal(allocated, abandonedAllocated);
    assert.deepEqual(await state(), abandonedState);
    const protectedRows = await query(
      admin,
      "SELECT to_jsonb(r) row FROM bop_identity.platform_actor_directory_revision r WHERE actor_id=ANY($1::uuid[])",
      [[author, reviewer]],
    );
    for (const subject of subjects.values())
      assert.equal(JSON.stringify(protectedRows.rows).includes(subject), false);
    await assert.rejects(
      query(
        authorClient,
        "UPDATE bop_publishing.platform_template_publishing_operation SET reason_code='CHANGED'",
      ),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      query(authorClient, "SELECT * FROM bop_identity.platform_actor_directory_revision"),
      (error) => error.code === "42501",
    );
    // Optional continuation consumes these real immutable records while the
    // non-bypass reference function owners and original cleanup remain live.
    if (onPublished)
      await onPublished(
        Object.freeze({
          template: httpSnapshot,
          publication: httpPublished.source,
        }),
      );
  } catch (error) {
    throw new Error(
      `Platform template publishing native failed at ${stage}; SQLSTATE ${sqlState}`,
      { cause: error },
    );
  } finally {
    if (httpRuntime) await httpRuntime.shutdown("SIGTERM").catch(() => undefined);
    try {
      await brandReferences?.close();
    } catch {
      referenceCleanupFailed = true;
    }
    for (const client of clients) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
    for (const role of roles.reverse()) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.end();
  }
  if (referenceCleanupFailed) throw new Error("BRAND_TEMPLATE_REFERENCE_CLEANUP_UNAVAILABLE");
}
