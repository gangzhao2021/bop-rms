import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  verifyPlatformAuditChain,
} from "../../bop/audit/src/index.ts";
import {
  createPostgresPlatformPermissionProvisioner,
  createPostgresPlatformPermissionSource,
  parsePlatformPermissionProvisionCommand,
  platformPermissionActions,
} from "../../bop/permission/src/index.ts";
import {
  createPostgresPlatformBrandTemplateStore,
  parsePlatformBrandTemplateSave,
  platformBrandTemplateRequiredFields,
} from "../../bop/tenant/src/index.ts";

const id = (n) => `01902627-0020-7000-8000-${n.toString(16).padStart(12, "0")}`;
const purposeCode = "PLATFORM_BRAND_TEMPLATE";
const hash = (value) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const headOf = (policy) =>
  policy === null
    ? null
    : {
        policyReference: policy.policyReference,
        revision: policy.revision,
        sourceDigest: policy.sourceDigest,
      };
const denied = (error) => error?.code === "PLATFORM_PERMISSION_DENIED";

/** Reuses the host's actual encrypted, newly authenticated Platform Session.
 * Only provisioning approval and its named operator/approver are controlled
 * InternalTest facts. Permission, Template and Audit use actual PostgreSQL owners. */
export async function verifyPlatformPermissionPersistence(
  context,
  { actorReference, now, currentIdentity },
) {
  const admin = new pg.Client(context.clientConfig),
    runtimeRole = `platform_permission_rt_${context.runId}`,
    provisionRole = `platform_permission_import_${context.runId}`;
  for (const role of [runtimeRole, provisionRole]) assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
  const operator = id(1),
    approver = id(2),
    otherSubject = id(3);
  assert.notEqual(operator, actorReference);
  let allocated = 1000,
    auditCalls = 0,
    stage = "Setup",
    sqlState = "none";
  const clients = [],
    roles = [];
  const mark = (name) => {
    stage = name;
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
  await admin.connect();
  try {
    for (const role of [runtimeRole, provisionRole]) {
      // Random isolated-run login credentials stay in memory and are never logged.
      const password = randomBytes(32).toString("hex");
      await query(
        admin,
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      roles.push(role);
      await query(
        admin,
        `GRANT USAGE ON SCHEMA bop_permission,platform_audit,platform_helpers TO ${role}`,
      );
      await query(admin, `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
      await query(
        admin,
        `GRANT SELECT ON bop_permission.platform_permission_policy_head,bop_permission.platform_permission_policy_revision TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_import_capable() TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
      );
      await query(
        admin,
        `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
      );
      const client = new pg.Client({ ...context.clientConfig, user: role, password });
      await client.connect();
      clients.push(client);
    }
    const [runtime, provision] = clients;
    await query(admin, `GRANT USAGE ON SCHEMA bop_identity,bop_tenant TO ${runtimeRole}`);
    // Identity's existing SELECT FOR SHARE requires UPDATE on at least one
    // column. Only session_id is admitted; status/actor/secret writes are denied.
    await query(
      admin,
      `GRANT SELECT,UPDATE(session_id) ON bop_identity.authentication_session TO ${runtimeRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_policy_hold(uuid,text) TO ${runtimeRole}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT ON bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation TO ${runtimeRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_tenant.platform_brand_template_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ${runtimeRole}`,
    );
    await query(
      admin,
      `GRANT INSERT ON bop_permission.platform_permission_policy_revision TO ${provisionRole}`,
    );
    await query(
      admin,
      `GRANT INSERT,UPDATE ON bop_permission.platform_permission_policy_head TO ${provisionRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_permission.platform_permission_import_admit(uuid,uuid,uuid) TO ${provisionRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION platform_audit.matches_platform_permission_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${provisionRole}`,
    );
    const state = async () =>
      (
        await query(
          admin,
          `SELECT
      (SELECT count(*)::int FROM bop_permission.platform_permission_policy_revision) policies,
      (SELECT coalesce(jsonb_agg(jsonb_build_array(actor_id,current_revision,policy_id,source_digest) ORDER BY actor_id),'[]'::jsonb) FROM bop_permission.platform_permission_policy_head) heads,
      (SELECT count(*)::int FROM bop_tenant.platform_brand_template_revision) templates,
      (SELECT count(*)::int FROM bop_tenant.platform_brand_template_operation) operations,
      (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record) audits,
      (SELECT coalesce(jsonb_agg(jsonb_build_array(actor_id,purpose_code,next_sequence,encode(last_record_hash,'hex')) ORDER BY actor_id,purpose_code),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head) audit_heads,
      (SELECT count(*)::int FROM bop_tenant.brand) brands`,
        )
      ).rows[0];
    const observed = now(),
      effectiveFrom = new Date(Date.parse(observed) - 1000).toISOString(),
      effectiveUntil = new Date(Date.parse(observed) + 3_600_000).toISOString();
    assert(
      Date.parse(observed) <=
        Date.parse((await query(admin, "SELECT clock_timestamp() at")).rows[0].at),
    );
    const content = (actions, roleCode = "PlatformAdministrator", denyAction = null) => ({
      roleCode,
      effectiveFrom,
      effectiveUntil,
      entries: [
        ...actions.map((action, index) => ({
          evidenceReference: id(100 + index),
          action,
          effect: "Allow",
          effectiveFrom,
          effectiveUntil,
        })),
        ...(denyAction
          ? [
              {
                evidenceReference: id(150),
                action: denyAction,
                effect: "Deny",
                effectiveFrom,
                effectiveUntil,
              },
            ]
          : []),
      ],
    });
    const command = (operation, prior, contents, target = actorReference) =>
      parsePlatformPermissionProvisionCommand({
        profile: "PlatformPermissionProvisionV1",
        targetActorReference: target,
        purposeCode,
        operationReference: id(operation),
        expectedHead: headOf(prior),
        content: contents,
        recordedByReference: operator,
        approvedByReference: approver,
        approvalEvidenceReference: id(200),
        reasonCode: "CONTROLLED_APPROVED_PROVISIONING",
      });
    async function transaction(client, work, controls = {}) {
      const startedAt = now(),
        validUntil = new Date(Date.parse(startedAt) + 5000).toISOString();
      let expired = false,
        active = true;
      const guards = [],
        finals = [],
        finalized = [];
      const tx = {
        query: async (sql, values) => {
          assert.equal(active, true);
          if (
            sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_revision") ||
            sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_head") ||
            sql.startsWith("UPDATE bop_permission.platform_permission_policy_head")
          )
            controls.capture?.push({ sql, values: [...values] });
          return query(client, sql, values);
        },
      };
      const host = {
        tx,
        clock: { now: () => (expired ? validUntil : now()) },
        originalObservedAt: startedAt,
        originalValidUntil: validUntil,
        registerBeforeCommit: async (actual, guard, final) => {
          assert.equal(actual, tx);
          guards.push(guard);
          finals.push(final);
        },
        retain: (owner) => {
          finalized.push(() => owner.assertFinalized());
          return owner;
        },
      };
      await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        if (controls.lockTimeout) await query(client, "SET LOCAL lock_timeout='100ms'");
        const result = await work(host);
        if (controls.failWork) throw new Error("CONTROLLED_NATIVE_ROLLBACK");
        await controls.beforeGuards?.();
        if (controls.expireAtGuard) expired = true;
        assert(guards.length > 0);
        for (const guard of guards) await guard();
        await query(client, "SET CONSTRAINTS ALL IMMEDIATE");
        if (controls.expireAtFinal) expired = true;
        for (const final of finals) final();
        active = false;
        await query(client, "COMMIT");
        expired = true;
        for (const assertFinalized of finalized) assertFinalized();
        return result;
      } catch (error) {
        active = false;
        await query(client, "ROLLBACK");
        throw error;
      }
    }
    async function provisionPolicy(input, controls = {}) {
      let approval = true;
      const result = await transaction(
        provision,
        async (h) => {
          const source = h.retain(
            createPostgresPlatformPermissionProvisioner({
              transaction: h.tx,
              operatorScope: { kind: "Platform", actorReference: operator, purposeCode },
              provisioningRoleName: provisionRole,
              clock: h.clock,
              originalObservedAt: h.originalObservedAt,
              originalValidUntil: h.originalValidUntil,
              authority: {
                async hold(actual, request) {
                  assert.equal(actual, h.tx);
                  assert.equal(request.scope.actorReference, operator);
                  assert.equal(request.command.recordedByReference, operator);
                  assert.equal(request.command.approvedByReference, approver);
                  if (!approval) throw new Error("CONTROLLED_APPROVAL_WITHDRAWAL");
                  // A real authority holder may restore its operator context. The
                  // importer must rebind target subject while preserving Audit actor.
                  await actual.query(
                    "SELECT set_config('bop.platform_permission_subject_id',$1,true)",
                    [operator],
                  );
                  return {
                    operatorReference: operator,
                    approvedByReference: approver,
                    approvalEvidenceReference: request.command.approvalEvidenceReference,
                    validUntil: request.validUntil,
                  };
                },
              },
              nextReference: (kind) => {
                assert(["Policy", "Audit"].includes(kind));
                return id(allocated++);
              },
              appendAudit: async (actual, input) => {
                assert.equal(actual, h.tx);
                assert.equal(input.actorReference, operator);
                controls.auditInputs?.push(input);
                const record = await appendPlatformAuditRecordInTransaction(actual, input);
                auditCalls++;
                if (controls.failAudit) throw new Error("CONTROLLED_AUDIT_FAILURE");
                return record;
              },
              registerBeforeCommit: h.registerBeforeCommit,
            }),
          );
          return source.provision(input);
        },
        {
          ...controls,
          beforeGuards: async () => {
            if (controls.withdrawApproval) approval = false;
            await controls.beforeGuards?.();
          },
        },
      );
      return result;
    }
    const scope = { kind: "Platform", actorReference, purposeCode };
    function permission(h) {
      const options = {
        transaction: h.tx,
        scope,
        clock: h.clock,
        originalObservedAt: h.originalObservedAt,
        originalValidUntil: h.originalValidUntil,
        currentIdentity: async (actual) => {
          assert.equal(actual, h.tx);
          const packet = await currentIdentity(actual);
          assert.equal(packet.session.actor.actorReference, actorReference);
          return packet;
        },
        registerBeforeCommit: h.registerBeforeCommit,
      };
      return { source: h.retain(createPostgresPlatformPermissionSource(options)), options };
    }
    const authorize = (actions) =>
      transaction(runtime, async (h) => {
        const { source } = permission(h),
          answers = [];
        for (const action of actions) answers.push(await source.authorize({ action }));
        return answers;
      });
    mark("MinimumRoleAdmission");
    for (const [client, role, importer] of [
      [runtime, runtimeRole, false],
      [provision, provisionRole, true],
    ]) {
      const principal = (
        await query(
          client,
          "SELECT session_user::text login,current_user::text current,bop_permission.platform_permission_import_capable() controlled",
        )
      ).rows[0];
      assert.deepEqual(principal, { login: role, current: role, controlled: importer });
      const flags = (
        await query(
          admin,
          "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=$1",
          [role],
        )
      ).rows[0];
      assert(Object.values(flags).every((value) => value === false));
      for (const table of [
        "bop_permission.platform_permission_policy_revision",
        "platform_audit.platform_actor_audit_record",
      ])
        for (const right of ["UPDATE", "DELETE", "TRUNCATE"])
          assert.equal(
            (
              await query(admin, "SELECT has_table_privilege($1,$2,$3) allowed", [
                role,
                table,
                right,
              ])
            ).rows[0].allowed,
            false,
          );
    }
    for (const column of ["status", "actor_id", "encrypted_secret"])
      assert.equal(
        (
          await query(
            admin,
            "SELECT has_column_privilege($1,'bop_identity.authentication_session',$2,'UPDATE') allowed",
            [runtimeRole, column],
          )
        ).rows[0].allowed,
        false,
      );
    for (const table of [
      "bop_permission.platform_permission_policy_head",
      "bop_permission.platform_permission_policy_revision",
    ])
      for (const right of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
        assert.equal(
          (
            await query(admin, "SELECT has_table_privilege($1,$2,$3) allowed", [
              runtimeRole,
              table,
              right,
            ])
          ).rows[0].allowed,
          false,
        );
    for (const right of ["DELETE", "TRUNCATE"])
      assert.equal(
        (
          await query(
            admin,
            "SELECT has_table_privilege($1,'bop_permission.platform_permission_policy_head',$2) allowed",
            [provisionRole, right],
          )
        ).rows[0].allowed,
        false,
      );
    for (const right of ["INSERT", "DELETE", "TRUNCATE"])
      assert.equal(
        (
          await query(
            admin,
            "SELECT has_table_privilege($1,'bop_identity.authentication_session',$2) allowed",
            [runtimeRole, right],
          )
        ).rows[0].allowed,
        false,
      );
    assert.equal((await state()).brands, 0);
    mark("AbsentPolicyAndExplicitGrantCombination");
    await assert.rejects(authorize(["platform.brand-template.manage"]), denied);
    const original = command(10, null, content(["platform.operate"]));
    let policy = await provisionPolicy(original);
    await assert.rejects(authorize(["platform.brand-template.manage"]), denied);
    policy = await provisionPolicy(
      command(11, policy, content(["platform.brand-template.manage"])),
    );
    await assert.rejects(authorize(["platform.brand-template.manage"]), denied);
    mark("SupportAndActiveDeny");
    policy = await provisionPolicy(
      command(
        12,
        policy,
        content(["platform.operate", "platform.brand-template.read"], "PlatformSupport"),
      ),
    );
    assert.equal(
      (await authorize(["platform.brand-template.read"]))[0].action,
      "platform.brand-template.read",
    );
    await assert.rejects(authorize(["platform.brand-template.manage"]), denied);
    policy = await provisionPolicy(
      command(
        13,
        policy,
        content(
          ["platform.operate", "platform.brand-template.read", "platform.brand-template.manage"],
          "PlatformAdministrator",
          "platform.brand-template.manage",
        ),
      ),
    );
    await assert.rejects(authorize(["platform.brand-template.manage"]), denied);
    policy = await provisionPolicy(command(14, policy, content(platformPermissionActions)));
    const allowed = await authorize(platformPermissionActions);
    assert.deepEqual(
      allowed.map((a) => a.action),
      platformPermissionActions,
    );
    assert(
      allowed.every(
        (a) =>
          a.scope.actorReference === actorReference && a.policyReference === policy.policyReference,
      ),
    );
    mark("OriginalReplayAndIntentCas");
    const stable = await state(),
      allocations = allocated,
      audits = auditCalls;
    assert.equal(
      (await provisionPolicy(original)).policyReference,
      (
        await query(
          admin,
          "SELECT policy_id::text id FROM bop_permission.platform_permission_policy_revision WHERE actor_id=$1 AND revision=1",
          [actorReference],
        )
      ).rows[0].id,
    );
    assert.equal(allocated, allocations);
    assert.equal(auditCalls, audits);
    assert.deepEqual(await state(), stable);
    await assert.rejects(provisionPolicy({ ...original, targetActorReference: otherSubject }), {
      code: "PLATFORM_PERMISSION_INTENT_CONFLICT",
    });
    await assert.rejects(provisionPolicy(command(15, null, content(platformPermissionActions))), {
      code: "PLATFORM_PERMISSION_VERSION_CONFLICT",
    });
    assert.equal(allocated, allocations);
    assert.deepEqual(await state(), stable);
    mark("SubjectGucSpoof");
    await query(runtime, "BEGIN");
    try {
      await query(
        runtime,
        "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_permission_subject_id',$2,true),set_config('bop.platform_purpose',$3,true)",
        [otherSubject, actorReference, purposeCode],
      );
      assert.equal(
        (
          await query(
            runtime,
            "SELECT count(*)::int n FROM bop_permission.platform_permission_policy_head",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await query(
            runtime,
            "SELECT count(*)::int n FROM bop_permission.platform_permission_policy_revision",
          )
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        query(runtime, "SELECT bop_permission.platform_permission_policy_hold($1,$2)", [
          actorReference,
          purposeCode,
        ]),
        { code: "23514" },
      );
    } finally {
      await query(runtime, "ROLLBACK");
    }
    await assert.rejects(
      transaction(runtime, async (h) => {
        const { options } = permission(h);
        const foreign = createPostgresPlatformPermissionSource({
          ...options,
          scope: { ...scope, actorReference: otherSubject },
        });
        await foreign.authorize({ action: "platform.brand-template.manage" });
      }),
      denied,
    );
    const templateContent = {
      code: "NATIVE_PERMISSION_TEMPLATE",
      name: "Controlled Platform template",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA"],
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: ["SECURITY.REAUTH"],
      effectiveFrom,
      effectiveUntil: null,
      reasonCode: "ADMIN_CONFIGURATION",
    };
    const templateCommand = (operation, code) =>
      parsePlatformBrandTemplateSave({
        profile: "PlatformBrandTemplateSaveV1",
        ...scope,
        operationReference: id(operation),
        templateReference: null,
        expectedHead: null,
        content: { ...templateContent, code },
      });
    async function saveTemplate(input, controls = {}) {
      return transaction(
        runtime,
        async (h) => {
          const p = permission(h),
            store = h.retain(
              createPostgresPlatformBrandTemplateStore({
                ...scope,
                transaction: h.tx,
                clock: h.clock,
                originalObservedAt: h.originalObservedAt,
                originalValidUntil: h.originalValidUntil,
                references: {
                  canonicalize: canonicalizeRfc8785,
                  hashIntent: (value) =>
                    "sha256:" + createHash("sha256").update(value).digest("hex"),
                  nextReference: () => id(allocated++),
                },
                authority: {
                  async holdUntilTransactionCompletes(actual, request) {
                    assert.equal(actual, h.tx);
                    assert.equal(request.actorReference, actorReference);
                    assert.equal(request.purposeCode, purposeCode);
                    assert.deepEqual(request.requiredFields, platformBrandTemplateRequiredFields);
                    const result = await p.source.authorize({ action: request.permission });
                    return { validUntil: result.validUntil };
                  },
                },
                appendAudit: async (actual, input) => {
                  assert.equal(actual, h.tx);
                  await appendPlatformAuditRecordInTransaction(actual, {
                    auditReference: input.auditReference,
                    actorReference,
                    purposeCode,
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
                  if (controls.failAudit) throw new Error("CONTROLLED_TEMPLATE_AUDIT_FAILURE");
                },
                registerBeforeCommit: h.registerBeforeCommit,
              }),
            );
          const result = await store.save(input);
          if (controls.changeIdentityPort)
            p.options.currentIdentity = async (tx) => currentIdentity(tx);
          await controls.afterSave?.();
          return result;
        },
        controls,
      );
    }
    mark("ActualTemplateSaveAndPermissionFence");
    const actualTemplate = templateCommand(30, "NATIVE_PERMISSION_TEMPLATE");
    const saved = await saveTemplate(actualTemplate, {
      afterSave: async () => {
        // A genuine policy withdrawal cannot overtake an already-held head SHARE lock.
        await assert.rejects(
          provisionPolicy(command(16, policy, content([])), { lockTimeout: true }),
        );
        assert.equal(sqlState, "55P03");
      },
    });
    assert.equal(saved.outcome, "Committed");
    assert.equal(saved.snapshot.authoredByReference, actorReference);
    const afterSave = await state();
    assert.deepEqual(await saveTemplate(actualTemplate), saved);
    assert.deepEqual(await state(), afterSave);
    policy = await provisionPolicy(
      command(
        17,
        policy,
        content(platformPermissionActions, "PlatformAdministrator", "platform.operate"),
      ),
    );
    const denyState = await state();
    await assert.rejects(saveTemplate(templateCommand(31, "DENIED_TEMPLATE")));
    assert.deepEqual(await state(), denyState);
    policy = await provisionPolicy(command(18, policy, content(platformPermissionActions)));
    for (const [name, controls] of [
      ["ProvisionApprovalWithdrawal", { withdrawApproval: true }],
      ["ProvisionAuditRollback", { failAudit: true }],
      ["ProvisionOriginalLease", { expireAtFinal: true }],
    ]) {
      mark(name);
      const before = await state();
      await assert.rejects(provisionPolicy(command(20, policy, content([])), controls));
      assert.deepEqual(await state(), before);
    }
    for (const [name, controls] of [
      ["TemplateSourcePortWithdrawal", { changeIdentityPort: true }],
      ["TemplateAuditRollback", { failAudit: true }],
      ["TemplateOriginalGuardLease", { expireAtGuard: true }],
      ["TemplateOriginalFinalLease", { expireAtFinal: true }],
    ]) {
      mark(name);
      const before = await state();
      await assert.rejects(saveTemplate(templateCommand(32, "ROLLBACK_TEMPLATE"), controls));
      assert.deepEqual(await state(), before);
    }
    mark("LatePolicyReadPrivilegeWithdrawal");
    const beforeRevocation = await state();
    try {
      await assert.rejects(
        saveTemplate(templateCommand(33, "WITHDRAWN_POLICY_TEMPLATE"), {
          beforeGuards: () =>
            query(
              admin,
              `REVOKE SELECT ON bop_permission.platform_permission_policy_revision FROM ${runtimeRole}`,
            ),
        }),
      );
      assert.equal(sqlState, "42501");
    } finally {
      await query(
        admin,
        `GRANT SELECT ON bop_permission.platform_permission_policy_revision TO ${runtimeRole}`,
      );
    }
    assert.deepEqual(await state(), beforeRevocation);
    mark("CaptureGenuinePolicyForSqlNegatives");
    const captured = [],
      auditInputs = [],
      rawCommand = command(40, policy, content(platformPermissionActions));
    await assert.rejects(
      provisionPolicy(rawCommand, { capture: captured, auditInputs, failWork: true }),
      /CONTROLLED_NATIVE_ROLLBACK/u,
    );
    const revision = captured.find((r) =>
        r.sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_revision"),
      ),
      head = captured.find((r) =>
        r.sql.startsWith("UPDATE bop_permission.platform_permission_policy_head"),
      );
    assert(revision);
    assert(head);
    assert.equal(auditInputs.length, 1);
    async function rawPolicy(work, writeRows = true) {
      await query(provision, "BEGIN ISOLATION LEVEL READ COMMITTED");
      const tx = { query: (sql, values) => query(provision, sql, values) };
      try {
        await tx.query(
          "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_permission_subject_id',$2,true),set_config('bop.platform_purpose',$3,true)",
          [operator, actorReference, purposeCode],
        );
        await tx.query("SELECT bop_permission.platform_permission_import_admit($1,$2,$3)", [
          operator,
          actorReference,
          rawCommand.operationReference,
        ]);
        await work(tx);
        if (writeRows) {
          await tx.query(revision.sql, revision.values);
          await tx.query(head.sql, head.values);
        }
        await query(provision, "SET CONSTRAINTS ALL IMMEDIATE");
        await query(provision, "COMMIT");
      } catch (error) {
        await query(provision, "ROLLBACK");
        throw error;
      }
    }
    mark("JsonNullPolicyRefusal");
    const beforeRaw = await state();
    for (const corrupt of [
      (snapshot) => {
        snapshot.profile = null;
      },
      (snapshot) => {
        snapshot.classification = null;
      },
      (snapshot) => {
        snapshot.recordedByReference = null;
      },
      (snapshot) => {
        snapshot.content.roleCode = null;
      },
      (snapshot) => {
        snapshot.content.entries[0].effect = null;
      },
    ]) {
      const values = [...revision.values],
        snapshot = JSON.parse(values[12]);
      corrupt(snapshot);
      // Keep original-command content and both hashes coherent so malformed
      // scalar types are refused by SQL, not an unrelated content mismatch.
      snapshot.originalCommand.content = globalThis.structuredClone(snapshot.content);
      snapshot.intentDigest = hash(snapshot.originalCommand);
      values[8] = snapshot.intentDigest;
      const { sourceDigest, ...body } = snapshot;
      void sourceDigest;
      snapshot.sourceDigest = hash(body);
      values[11] = snapshot.sourceDigest;
      values[12] = canonicalizeRfc8785(snapshot);
      await assert.rejects(
        rawPolicy((tx) => tx.query(revision.sql, values), false),
        { code: "23514" },
      );
      assert.deepEqual(await state(), beforeRaw);
    }
    mark("MissingAndWrongAuditCannotCommitPolicy");
    await assert.rejects(
      rawPolicy(async () => undefined),
      { code: "23514" },
    );
    assert.deepEqual(await state(), beforeRaw);
    await assert.rejects(
      rawPolicy((tx) =>
        appendPlatformAuditRecordInTransaction(tx, { ...auditInputs[0], targetReference: id(999) }),
      ),
      { code: "23514" },
    );
    assert.deepEqual(await state(), beforeRaw);
    mark("OlderTransactionAuditCannotCommitPolicy");
    // A separately committed, valid Audit record is deliberately insufficient:
    // policy admission requires its exact record in this writer transaction.
    await rawPolicy((tx) => appendPlatformAuditRecordInTransaction(tx, auditInputs[0]), false);
    const withOldAudit = await state();
    await assert.rejects(
      rawPolicy(async () => undefined),
      { code: "23514" },
    );
    assert.deepEqual(await state(), withOldAudit);
    mark("AppendOnlyHistoryAndHeadCoherence");
    for (const sql of [
      "UPDATE bop_permission.platform_permission_policy_revision SET recorded_by=recorded_by",
      "DELETE FROM bop_permission.platform_permission_policy_head",
    ])
      await assert.rejects(query(admin, sql), { code: "23514" });
    await assert.rejects(
      query(admin, "TRUNCATE bop_permission.platform_permission_policy_revision CASCADE"),
      { code: "23514" },
    );
    await assert.rejects(
      rawPolicy(
        (tx) =>
          tx.query(
            "UPDATE bop_permission.platform_permission_policy_head SET current_revision=current_revision+1 WHERE actor_id=$1 AND purpose_code=$2",
            [actorReference, purposeCode],
          ),
        false,
      ),
      { code: "23514" },
    );
    for (const column of ["status", "actor_id", "encrypted_secret"])
      await assert.rejects(
        query(runtime, `UPDATE bop_identity.authentication_session SET ${column}=${column}`),
        { code: "42501" },
      );
    assert.deepEqual(await state(), withOldAudit);
    mark("ActualOperatorAndTemplateAuditIntegrity");
    const records = (
      await query(
        admin,
        "SELECT audit_id,actor_id,purpose_code,action_code,target_type,target_id,operation_id,encode(intent_digest,'hex') intent_digest,occurred_at,reason_code,retention_policy_code,retention_policy_version,chain_profile,chain_sequence::text sequence,CASE WHEN previous_record_hash IS NULL THEN NULL ELSE encode(previous_record_hash,'hex') END previous_hash,encode(record_hash,'hex') record_hash,recorded_at FROM platform_audit.platform_actor_audit_record WHERE actor_id=ANY($1::uuid[]) ORDER BY actor_id,purpose_code,chain_sequence",
        [[operator, actorReference]],
      )
    ).rows;
    for (const actorId of [operator, actorReference]) {
      const chain = records
        .filter((r) => r.actor_id === actorId)
        .map((r) => ({
          profile: r.chain_profile,
          sequence: Number(r.sequence),
          previousHash: r.previous_hash,
          recordHash: r.record_hash,
          recordedAt: r.recorded_at.toISOString(),
          content: {
            auditReference: r.audit_id,
            actorReference: r.actor_id,
            purposeCode: r.purpose_code,
            actionCode: r.action_code,
            targetType: r.target_type,
            targetReference: r.target_id,
            operationReference: r.operation_id,
            intentDigest: "sha256:" + r.intent_digest,
            occurredAt: r.occurred_at.toISOString(),
            reasonCode: r.reason_code,
            retentionPolicyCode: r.retention_policy_code,
            retentionPolicyVersion: r.retention_policy_version,
          },
        }));
      assert(chain.length > 0);
      assert.equal(verifyPlatformAuditChain(chain), true);
      const actualHead = (
        await query(
          admin,
          "SELECT next_sequence::text next_sequence,encode(last_record_hash,'hex') last_hash FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$1 AND purpose_code=$2",
          [actorId, purposeCode],
        )
      ).rows[0];
      assert.equal(actualHead.next_sequence, String(chain.length + 1));
      assert.equal(actualHead.last_hash, chain.at(-1).recordHash);
    }
    const links = (
      await query(
        admin,
        "SELECT r.actor_id::text subject,r.recorded_by::text operator,a.actor_id::text audited_operator FROM bop_permission.platform_permission_policy_revision r JOIN platform_audit.platform_actor_audit_record a ON a.audit_id=r.audit_id ORDER BY r.revision",
      )
    ).rows;
    assert(links.length > 0);
    assert(
      links.every(
        (r) =>
          r.subject === actorReference &&
          r.operator === operator &&
          r.audited_operator === operator,
      ),
    );
    assert.equal((await state()).brands, 0);
  } catch (error) {
    throw new Error(
      `PLATFORM_PERMISSION_NATIVE_FAILED stage=${stage} SQLSTATE=${sqlState} class=${error?.code === "ERR_ASSERTION" ? "Assertion" : "Refusal"}`,
      { cause: error },
    );
  } finally {
    for (const client of clients) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
    for (const role of roles.reverse()) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
