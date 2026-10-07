import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { appendPlatformAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createPostgresPlatformBrowserSessionStore,
  createPostgresCurrentPlatformBrowserSessionSource,
} from "../../bop/identity/src/index.ts";
import { createPostgresPlatformActorDirectorySource } from "../../bop/identity/src/infrastructure/persistence/platform-actor-directory-store.ts";
import { createPostgresPlatformActorDirectoryProvisioner } from "../../bop/identity/src/infrastructure/persistence/platform-actor-directory-provisioner.ts";

const id = (n) => `01902627-0030-7000-8000-${n.toString(16).padStart(12, "0")}`;
const headOf = (revision) => ({
  revisionReference: revision.revisionReference,
  version: revision.version,
  sourceDigest: revision.sourceDigest,
});

/** Actual minimum-role directory/Audit/Session persistence. Remote account status
 * and independent deployment approval are controlled InternalTest ports. The
 * caller supplies its genuine existing AES-GCM/HMAC ports, not Provider proof. */
export async function verifyPlatformActorDirectoryPersistence(context, { now, hasher, envelopes }) {
  const admin = new pg.Client(context.clientConfig),
    clients = [],
    roles = [],
    runtimeRole = `platform_directory_rt_${context.runId}`,
    importRole = `platform_directory_import_${context.runId}`,
    sessionRole = `platform_directory_session_${context.runId}`;
  const configuration = {
      environment: "synthetic",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic1",
      clientIds: ["syntheticplatform"],
    },
    actor = id(1),
    operator = id(2),
    approver = id(3),
    subject = "opaque-local-native-subject";
  let allocation = 1000,
    auditCalls = 0,
    remoteEnabled = true,
    remoteOverride = null,
    stage = "Setup",
    sqlState = "none";
  const query = async (client, sql, values = []) => {
    try {
      return await client.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  await admin.connect();
  try {
    for (const role of [runtimeRole, importRole, sessionRole]) {
      assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
      const password = randomBytes(32).toString("hex");
      await query(
        admin,
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      roles.push(role);
      await query(
        admin,
        `GRANT USAGE ON SCHEMA bop_identity,platform_audit,platform_helpers TO ${role}`,
      );
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),bop_identity.platform_actor_directory_import_capable() TO ${role}`,
      );
      if (role === importRole) {
        await query(
          admin,
          `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
        );
        await query(
          admin,
          `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
        );
      }
      const client = new pg.Client({ ...context.clientConfig, user: role, password });
      await client.connect();
      clients.push(client);
    }
    const [runtime, importer, sessionWriter] = clients;
    for (const role of [runtimeRole, sessionRole])
      await query(
        admin,
        `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_read(uuid,text,text,text) TO ${role}`,
      );
    await query(
      admin,
      `GRANT SELECT,UPDATE(session_id) ON bop_identity.authentication_session TO ${runtimeRole}`,
    );
    // The existing Session creation kernel's global table LOCK requires table
    // UPDATE. Isolate that writer privilege from the current-read role.
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session TO ${sessionRole}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT ON bop_identity.platform_actor_directory_revision TO ${importRole}`,
    );
    await query(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON bop_identity.platform_actor_directory_head TO ${importRole}`,
    );
    await query(
      admin,
      `GRANT SELECT,UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.authentication_session TO ${importRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_identity.platform_actor_directory_import_admit(uuid,uuid,uuid) TO ${importRole}`,
    );
    await query(
      admin,
      `GRANT EXECUTE ON FUNCTION platform_audit.matches_platform_actor_directory_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) TO ${importRole}`,
    );
    const acl = (
      await query(
        admin,
        `SELECT r.rolsuper,r.rolbypassrls,
      has_table_privilege($1,'bop_identity.platform_actor_directory_head','SELECT') directory_read,
      has_table_privilege($1,'bop_identity.platform_actor_directory_revision','INSERT') directory_insert,
      has_table_privilege($1,'bop_identity.authentication_session','UPDATE') session_update,
      has_table_privilege($1,'platform_audit.platform_actor_audit_record','INSERT') audit_insert
      FROM pg_roles r WHERE r.rolname=$1`,
        [runtimeRole],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      rolsuper: false,
      rolbypassrls: false,
      directory_read: false,
      directory_insert: false,
      session_update: false,
      audit_insert: false,
    });
    async function transaction(client, work, controls = {}) {
      const observedAt = now(),
        validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
        guards = [],
        finals = [],
        owners = [];
      let active = true,
        expired = false;
      const tx = {
        query: async (sql, values) => {
          assert(active);
          controls.capture?.push({ sql, values: [...values] });
          return query(client, sql, values);
        },
      };
      const h = {
        tx,
        clock: { now: () => (expired ? validUntil : now()) },
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
        await controls.beforeGuards?.();
        assert(guards.length > 0);
        for (const guard of guards) await guard();
        await query(client, "SET CONSTRAINTS ALL IMMEDIATE");
        if (controls.expireAtFinal) expired = true;
        for (const final of finals) final();
        active = false;
        await query(client, "COMMIT");
        expired = true;
        for (const owner of owners) owner.assertFinalized();
        return result;
      } catch (error) {
        active = false;
        await query(client, "ROLLBACK");
        throw error;
      }
    }
    const remote = async (input) => ({
      ...input,
      status: remoteEnabled ? "Enabled" : "Disabled",
      validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
      ...remoteOverride,
    });
    const ownerOptions = (h) => ({
      transaction: h.tx,
      configuration,
      clock: h.clock,
      originalObservedAt: h.originalObservedAt,
      originalValidUntil: h.originalValidUntil,
      registerBeforeCommit: h.registerBeforeCommit,
      hasher,
      envelopes,
      readCurrentProviderSubject: remote,
    });
    const sourceFor = (h) => h.retain(createPostgresPlatformActorDirectorySource(ownerOptions(h)));
    const command = (
      operation,
      operationReference,
      previous = null,
      actorReference = actor,
      opaque = subject,
    ) => ({
      profile: "PlatformActorDirectoryCommandV1",
      operation,
      operationReference,
      actorReference,
      expectedHead: previous === null ? null : headOf(previous),
      subject: operation === "ImportActive" ? opaque : null,
      recordedByReference: operator,
      approvedByReference: approver,
      approvalReference: id(10),
      reasonCode: "CONTROLLED_APPROVED_DIRECTORY",
    });
    async function provision(input, controls = {}) {
      return transaction(
        importer,
        async (h) => {
          const owner = h.retain(
            createPostgresPlatformActorDirectoryProvisioner({
              ...ownerOptions(h),
              operatorReference: operator,
              provisioningRoleName: importRole,
              authority: {
                async hold(actual, request) {
                  assert.equal(actual, h.tx);
                  return {
                    operatorReference: operator,
                    approvedByReference: request.command.approvedByReference,
                    approvalReference: request.command.approvalReference,
                    validUntil: h.originalValidUntil,
                  };
                },
              },
              nextReference: (kind) => controls.references?.[kind] ?? id(++allocation),
              appendAudit: async (actual, input) => {
                assert.equal(actual, h.tx);
                auditCalls++;
                if (controls.audit === "none") return undefined;
                if (controls.audit === "old") return controls.oldAudit;
                return appendPlatformAuditRecordInTransaction(
                  actual,
                  controls.audit === "wrong"
                    ? { ...input, reasonCode: "CONTROLLED_WRONG_AUDIT" }
                    : input,
                );
              },
            }),
          );
          return owner.provision(input);
        },
        controls,
      );
    }
    const resolve = (opaque = subject, controls = {}) =>
      transaction(
        runtime,
        async (h) =>
          sourceFor(h).resolveVerifiedSubject({
            issuer: configuration.issuer,
            clientId: configuration.clientIds[0],
            subject: opaque,
            authenticatedAt: h.originalObservedAt,
            observedAt: h.originalObservedAt,
          }),
        controls,
      );
    const state = async () =>
      (
        await query(
          admin,
          `SELECT
      (SELECT count(*)::int FROM bop_identity.platform_actor_directory_revision) revisions,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.actor_id),'[]'::jsonb) FROM bop_identity.platform_actor_directory_head h) heads,
      (SELECT count(*)::int FROM platform_audit.platform_actor_audit_record) audits,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.actor_id,h.purpose_code),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head h) audit_heads,
      (SELECT count(*)::int FROM bop_identity.authentication_session WHERE actor_id=$1) sessions`,
          [actor],
        )
      ).rows[0];
    mark("Unknown subject");
    await assert.rejects(resolve(), (error) => error.code === "PLATFORM_ACTOR_DIRECTORY_DENIED");
    mark("Approved import and immutable original replay");
    const imported = await provision(command("ImportActive", id(20)));
    assert.equal(imported.actorReference, actor);
    const beforeReplay = await state(),
      beforeAllocation = allocation,
      beforeAudit = auditCalls;
    assert.deepEqual(await provision(command("ImportActive", id(20))), imported);
    assert.deepEqual(await state(), beforeReplay);
    assert.equal(allocation, beforeAllocation);
    assert.equal(auditCalls, beforeAudit);
    await assert.rejects(
      provision(command("ImportActive", id(20), null, actor, "changed-opaque-subject")),
      (error) => error.code === "PLATFORM_ACTOR_DIRECTORY_INTENT_CONFLICT",
    );
    await assert.rejects(
      provision(command("ImportActive", id(21))),
      (error) => error.code === "PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT",
    );
    mark("Real opaque subject mapping and protected database representation");
    const actual = await resolve();
    assert.equal(actual.actorReference, actor);
    assert.equal(actual.verificationLevel, "SingleFactor");
    assert.equal(actual.recentMfaAt, null);
    await assert.rejects(resolve("another-unknown-opaque-subject"));
    for (const mismatch of [
      { subject: "another-opaque-provider-subject" },
      { issuer: "https://foreign.invalid/" },
    ]) {
      remoteOverride = mismatch;
      await assert.rejects(resolve());
    }
    remoteOverride = null;
    await assert.rejects(
      transaction(runtime, async (h) =>
        sourceFor(h).resolveVerifiedSubject({
          issuer: configuration.issuer,
          clientId: "anotherclient",
          subject,
          authenticatedAt: h.originalObservedAt,
          observedAt: h.originalObservedAt,
        }),
      ),
    );
    const protectedRows = await query(
      admin,
      "SELECT to_jsonb(r) row FROM bop_identity.platform_actor_directory_revision r",
    );
    assert.equal(JSON.stringify(protectedRows.rows).includes(subject), false);
    mark("Runtime table read exclusion");
    await assert.rejects(
      query(runtime, "SELECT * FROM bop_identity.platform_actor_directory_head"),
      (error) => error.code === "42501",
    );
    await query(runtime, "BEGIN");
    try {
      await query(
        runtime,
        "SELECT set_config('bop.platform_directory_environment',$1,true),set_config('bop.platform_directory_issuer',$2,true),set_config('bop.platform_directory_actor_id',$3,true)",
        [configuration.environment, configuration.issuer, id(99)],
      );
      await assert.rejects(
        query(runtime, "SELECT * FROM bop_identity.platform_actor_directory_read($1,$2,$3,$4)", [
          actor,
          null,
          configuration.issuer,
          configuration.environment,
        ]),
        (error) => error.code === "23514",
      );
    } finally {
      await query(runtime, "ROLLBACK");
    }
    await assert.rejects(
      query(
        importer,
        "UPDATE bop_identity.platform_actor_directory_revision SET status='Disabled' WHERE actor_id=$1",
        [actor],
      ),
      (error) => error.code === "42501",
    );
    mark("Final remote withdrawal and original lease expiry");
    const beforeRefusal = await state();
    await assert.rejects(
      resolve(subject, {
        beforeGuards: () => {
          remoteEnabled = false;
        },
      }),
    );
    remoteEnabled = true;
    await assert.rejects(resolve(subject, { expireAtFinal: true }));
    assert.deepEqual(await state(), beforeRefusal);
    mark("No or wrong actual Audit rolls back the revision and head");
    const fenceCommand = command("ImportActive", id(31), null, id(30), "opaque-native-audit-fence"),
      capture = [];
    await assert.rejects(provision(fenceCommand, { audit: "none", capture }));
    assert.deepEqual(await state(), beforeRefusal);
    await assert.rejects(provision(fenceCommand, { audit: "wrong" }));
    assert.deepEqual(await state(), beforeRefusal);
    const insert = capture.find((c) =>
      c.sql.startsWith("INSERT INTO bop_identity.platform_actor_directory_revision"),
    );
    assert(insert);
    const oldAuditInput = {
      auditReference: insert.values[12],
      actorReference: operator,
      purposeCode: "PLATFORM_ACTOR_DIRECTORY",
      actionCode: "PLATFORM_ACTOR_DIRECTORY_CHANGED",
      targetType: "PlatformActorDirectoryRevision",
      targetReference: insert.values[2],
      operationReference: insert.values[10],
      intentDigest: insert.values[11],
      occurredAt: insert.values[13],
      reasonCode: fenceCommand.reasonCode,
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    };
    // Genuine matching Audit, committed in a different top transaction. It must
    // not authenticate a later directory revision even with the exact tuple.
    await query(importer, "BEGIN ISOLATION LEVEL READ COMMITTED");
    let oldAudit;
    try {
      await query(
        importer,
        "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
        [operator, "PLATFORM_ACTOR_DIRECTORY"],
      );
      oldAudit = await appendPlatformAuditRecordInTransaction(
        { query: (sql, values) => query(importer, sql, values) },
        oldAuditInput,
      );
      await query(importer, "SET CONSTRAINTS ALL IMMEDIATE");
      await query(importer, "COMMIT");
    } catch (error) {
      await query(importer, "ROLLBACK");
      throw error;
    }
    const beforeOldAuditRefusal = await state();
    await assert.rejects(
      provision(fenceCommand, {
        audit: "old",
        oldAudit,
        references: { Revision: insert.values[2], Audit: insert.values[12] },
      }),
    );
    assert.deepEqual(await state(), beforeOldAuditRefusal);

    const sessionConfiguration = {
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientIds[0],
      redirectUri: "https://platform.invalid/platform/auth/callback",
      allowedPostLoginPaths: ["/platform/tenants"],
    };
    let afterCreateLock = null;
    const sessions = createPostgresPlatformBrowserSessionStore({
      ...sessionConfiguration,
      hasher,
      envelopes,
      now,
      transactions: {
        run: async (work) =>
          transaction(sessionWriter, async (h) => {
            const directory = sourceFor(h);
            h.tx.directory = directory;
            return work(h.tx);
          }),
      },
      currentActor: async (tx, ref, authenticatedAt, observedAt) => {
        await afterCreateLock?.(tx);
        return tx.directory.currentActor(tx, ref, authenticatedAt, observedAt);
      },
    });
    const currentSession = (cookie) =>
      transaction(runtime, async (h) => {
        const directory = sourceFor(h),
          read = createPostgresCurrentPlatformBrowserSessionSource({
            ...sessionConfiguration,
            hasher,
            envelopes,
            now,
            currentActor: (actual, ref, authenticatedAt, observedAt) =>
              directory.currentActor(actual, ref, authenticatedAt, observedAt),
          });
        return read(h.tx, cookie);
      });
    async function createSession() {
      const actual = await resolve(),
        sessionReference = id(++allocation),
        credential = randomBytes(32).toString("base64url"),
        csrf = randomBytes(32).toString("base64url"),
        authenticatedAt = actual.authenticatedAt;
      // Controlled TOTP evidence is only the pre-existing native fixture input;
      // the Actor itself must resolve from the real directory on create/current.
      const encryptedSecrets = await envelopes.encrypt(
        JSON.stringify({
          profile: "PlatformBrowserSessionV1",
          issuer: configuration.issuer,
          clientId: configuration.clientIds[0],
          tokenBundle: "synthetic-directory-native-refresh-bundle",
          csrf,
          mfa: {
            sessionReference,
            actorReference: actor,
            method: "Totp",
            evidenceReference: id(++allocation),
            authorizationTransactionReference: id(++allocation),
            authenticatedAt,
            verifiedAt: authenticatedAt,
            validUntil: new Date(Date.parse(authenticatedAt) + 900_000).toISOString(),
          },
        }),
        `${configuration.environment}:platform-session:${sessionReference}:${actor}`,
      );
      const record = await sessions.createSession({
        sessionReference,
        actor: actual,
        policyCode: "Privileged",
        sessionSelectorHash: hasher.hash(credential),
        csrfSelectorHash: hasher.hash(csrf),
        encryptedSecrets,
        observedAt: now(),
      });
      return { record, credential };
    }
    mark("Actual Session creation and current read through the real directory");
    const first = await createSession();
    assert.equal((await currentSession(first.credential)).session.actor.actorReference, actor);
    const sessionBeforeRollback = await state();
    await assert.rejects(provision(command("Disable", id(40), imported), { audit: "none" }));
    assert.deepEqual(await state(), sessionBeforeRollback);
    assert.equal((await currentSession(first.credential)).session.status, "Active");
    mark("Disable and Restore do not revive revoked Sessions");
    const disabled = await provision(command("Disable", id(41), imported));
    assert.equal(disabled.status, "Disabled");
    assert.equal(
      (
        await query(
          admin,
          "SELECT status FROM bop_identity.authentication_session WHERE session_id=$1",
          [first.record.session.sessionReference],
        )
      ).rows[0].status,
      "Revoked",
    );
    await assert.rejects(resolve());
    await assert.rejects(currentSession(first.credential));
    remoteEnabled = false;
    const beforeUnavailableRestore = await state();
    await assert.rejects(provision(command("Restore", id(42), disabled)));
    assert.deepEqual(await state(), beforeUnavailableRestore);
    remoteEnabled = true;
    const restored = await provision(command("Restore", id(42), disabled));
    assert.equal(restored.status, "Active");
    await assert.rejects(currentSession(first.credential));
    const second = await createSession();
    assert.equal((await currentSession(second.credential)).session.status, "Active");
    mark("Suspend and Restore also preserve old revocations");
    const suspended = await provision(command("Suspend", id(43), restored));
    assert.equal(suspended.status, "Suspended");
    await assert.rejects(currentSession(second.credential));
    const finalRestore = await provision(command("Restore", id(44), suspended));
    await assert.rejects(currentSession(first.credential));
    await assert.rejects(currentSession(second.credential));
    assert.equal((await resolve()).actorReference, actor);
    mark("Actual concurrent Create and Disable share the Session-first lock order");
    const writerPid = (await query(sessionWriter, "SELECT pg_backend_pid() pid")).rows[0].pid,
      importerPid = (await query(importer, "SELECT pg_backend_pid() pid")).rows[0].pid;
    let enter, release;
    const entered = new Promise((resolve) => {
        enter = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    afterCreateLock = async () => {
      const lock = (
        await query(
          admin,
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1
        AND relation='bop_identity.authentication_session'::regclass AND mode='ShareRowExclusiveLock' AND granted) held`,
          [writerPid],
        )
      ).rows[0];
      assert.equal(lock.held, true);
      enter();
      await gate;
    };
    const creating = createSession().then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    let disabling, interleaveError;
    try {
      await Promise.race([
        entered,
        creating.then((outcome) => {
          throw outcome.error ?? new Error("Session creation skipped its actual lock gate");
        }),
      ]);
      disabling = provision(command("Disable", id(45), finalRestore)).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      // Observe the real blocked lock request. No elapsed sleep is treated as
      // evidence that the competing transaction reached its admission fence.
      const limit = Date.now() + 3000;
      let waiting = false;
      while (!waiting && Date.now() < limit) {
        waiting = (
          await query(
            admin,
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1
          AND relation='bop_identity.authentication_session'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted) waiting`,
            [importerPid],
          )
        ).rows[0].waiting;
      }
      assert.equal(waiting, true);
    } catch (error) {
      interleaveError = error;
    } finally {
      release();
      afterCreateLock = null;
    }
    const createdOutcome = await creating;
    const disabledOutcome = disabling === undefined ? null : await disabling;
    if (interleaveError) throw interleaveError;
    if (createdOutcome.error) throw createdOutcome.error;
    assert(disabledOutcome);
    if (disabledOutcome.error) throw disabledOutcome.error;
    assert.equal(disabledOutcome.result.status, "Disabled");
    assert.equal(
      (
        await query(
          admin,
          "SELECT count(*)::int count FROM bop_identity.authentication_session WHERE actor_id=$1 AND status='Active'",
          [actor],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(currentSession(createdOutcome.result.credential));
  } catch (error) {
    throw new Error(`Platform actor directory native failed at ${stage}; SQLSTATE ${sqlState}`, {
      cause: error,
    });
  } finally {
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
}
