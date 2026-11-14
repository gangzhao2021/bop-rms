import assert from "node:assert/strict";
import pg from "pg";
import { setTimeout, clearTimeout } from "node:timers";
import {
  createPostgresOptionSetPublicationOperationStore,
  createPostgresPublishingMutationStore,
  parsePublishingOptionSetPublicationOperation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingInstant,
} from "../../bop/publishing/src/index.ts";
const id = (n) => "01902421-7900-7000-8000-" + n.toString(16).padStart(12, "0");
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic publication recovery wait timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const settled = (work) =>
  work().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
/** Controlled synthetic User/current permission and validation inputs, NOT real IAM,
 * Catalog qualification or delayed qualified Publish evidence. Actual Publishing
 * owner SQL, terminal identity, Audit, forced RLS, original guards and contention
 * execute against an isolated database. No successful terminal is simulated. */
export async function exerciseOptionSetPublicationResolution(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_pub_recovery_" + context.runId;
  assert.match(role, /^wp2421_pub_recovery_[a-f0-9]+$/u);
  await admin.connect();
  const tenant = id(1),
    brand = id(2),
    store = id(3),
    actor = id(4),
    otherActor = id(5),
    otherStore = id(6);
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: brand,
    storeReference: null,
  });
  const hash = parsePublishingDigest("sha256:" + "a".repeat(64));
  let sequence = 100,
    allowed = true,
    createdRole = false,
    phase = "Setup",
    afterWork = null,
    capture = null;
  const guards = new WeakMap(),
    active = new Set(),
    reference = () => id(++sequence),
    now = () => new Date().toISOString();
  const command = () =>
    parsePublishingOptionSetPublicationOperation({
      profile: "PublishingOptionSetPublicationOperationV1",
      tenantReference: tenant,
      brandReference: brand,
      selectedStoreReference: store,
      actorReference: actor,
      reasonCode: "AUTHORIZED_OPERATION",
      action: "SubmitReview",
      operationReference: reference(),
      optionSetReference: reference(),
      versionReference: reference(),
      expectedAggregateVersion: 1,
      sourceDigest: hash,
      contentDigest: hash,
      configurationDigest: hash,
      expectedReview: null,
      expectedLifecycle: null,
    });
  const audit = (operation, actionCode, targetType, targetId, occurredAt, who = actor) => ({
    auditId: reference(),
    brandId: brand,
    actor: { type: "User", reference: who },
    actionCode,
    targetType,
    targetId,
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: operation,
    occurredAt,
    sourceChannel: "API",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
  const register = async (tx, guard, finalAssert) => {
    const entries = guards.get(tx);
    assert(entries);
    entries.push({ guard, finalAssert });
  };
  const source = (who = actor, selectedStore = store) =>
    createPostgresOptionSetPublicationOperationStore({
      tenantReference: tenant,
      brandReference: brand,
      selectedStoreReference: selectedStore,
      actorReference: who,
      optionSetPolicyFamilyReference: id(7),
      clock: { now },
      originalValidUntil: new Date(Date.now() + 5000).toISOString(),
      registerBeforeCommit: register,
      audit: {
        create: ({ command, observedAt }) =>
          audit(
            command.operationReference,
            "PUBLISHING_OPTION_SET_OPERATION_ABANDONED",
            "PublishingOptionSetOperation",
            command.operationReference,
            observedAt,
            who,
          ),
      },
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert(guards.has(tx));
          assert.equal(input.command.tenantReference, tenant);
          assert.equal(input.command.brandReference, brand);
          assert.equal(input.command.selectedStoreReference, selectedStore);
          assert.equal(input.command.actorReference, who);
          assert.equal(input.permission, "catalog.manage");
          assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION_OPERATION");
          assert.equal(input.actorKind, "User");
          assert(input.requiredFields.includes("originalCommand"));
          assert(input.requiredPermissions.includes("catalog.option_set.read"));
          if (!allowed) throw new Error("CONTROLLED_CURRENT_PERMISSION_WITHDRAWN");
          return { validUntil: input.validUntil };
        },
      },
    });
  const transact = async (work) => {
    const client = new pg.Client({
      ...context.clientConfig,
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
    });
    await client.connect();
    active.add(client.processID);
    if (capture) capture.pids.push(client.processID);
    let tx,
      sqlState = null;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL ROLE " + role);
      await client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
      tx = {
        async query(sql, values = []) {
          try {
            return await client.query(sql, [...values]);
          } catch (error) {
            sqlState = /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : null;
            throw error;
          }
        },
      };
      const entries = [];
      guards.set(tx, entries);
      const result = await work(tx);
      if (afterWork) {
        const hook = afterWork;
        afterWork = null;
        await hook();
      }
      for (const entry of entries) await entry.guard();
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const entry of entries) entry.finalAssert();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (sqlState !== null)
        throw new Error(
          "PUBLICATION_RECOVERY_SQL_FAILURE phase=" + phase + " sqlstate=" + sqlState,
          { cause: error },
        );
      throw error;
    } finally {
      if (tx) guards.delete(tx);
      active.delete(client.processID);
      await client.end();
    }
  };
  const counts = async () =>
    (
      await admin.query(
        `SELECT
    (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2) mutations,
    (SELECT count(*)::int FROM bop_publishing.option_set_publication_operation WHERE tenant_id=$1 AND brand_id=$2) terminal,
    (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$2) audit`,
        [tenant, brand],
      )
    ).rows[0];
  const write = async (c) =>
    transact(async (tx) => {
      const owner = source(),
        original = await owner.inspectOriginalOperation(tx, c);
      if (original.outcome === "Committed") return original;
      if (original.outcome === "Abandoned") {
        // Actual owner itself refuses a writer after terminal inspection.
        await owner.withOriginalOperation(tx, c, async () => {
          throw new Error("Unreachable late writer callback");
        });
        throw new Error("Unexpected abandoned writer admission");
      }
      return owner.withOriginalOperation(tx, c, async (original) => {
        assert.equal(original.outcome, "Absent");
        const observedAt = parsePublishingInstant(now()),
          lifecycle = parsePublishingReference(reference()),
          draftOperation = parsePublishingReference(reference());
        const draft = createPublishingLifecycleRecord({
          lifecycleId: lifecycle,
          familyReference: parsePublishingReference(c.optionSetReference),
          configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
          purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
          snapshotReference: parsePublishingReference(c.versionReference),
          snapshotDigest: hash,
          scope,
          version: parsePublishingVersion(1),
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: observedAt,
          changedAt: observedAt,
        });
        const base = {
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          approvalEvidence: null,
        };
        await original.createDraft({
          ...base,
          operation: "CreateDraft",
          expectedVersion: parsePublishingVersion(1),
          idempotencyKey: draftOperation,
          current: null,
          next: draft,
          validationEvidence: null,
          audit: audit(
            draftOperation,
            "PUBLISHING_DRAFT_CREATED",
            "PublishingLifecycle",
            lifecycle,
            observedAt,
          ),
        });
        const checkedAt = parsePublishingInstant(now()),
          evidence = createPublishingValidationEvidence({
            evidenceReference: parsePublishingReference(reference()),
            snapshotReference: draft.snapshotReference,
            snapshotDigest: hash,
            scope,
            result: "Pass",
            checkedAt,
            validUntil: parsePublishingInstant(
              new Date(Date.parse(observedAt) + 5000).toISOString(),
            ),
            checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
          });
        const next = createPublishingLifecycleRecord({
          ...draft,
          version: parsePublishingVersion(2),
          state: "InReview",
          validationEvidenceReference: evidence.evidenceReference,
          changedAt: checkedAt,
        });
        const result = await original.commit({
          ...base,
          operation: "SubmitReview",
          expectedVersion: parsePublishingVersion(1),
          idempotencyKey: parsePublishingReference(c.operationReference),
          current: draft,
          next,
          validationEvidence: evidence,
          audit: audit(
            c.operationReference,
            "PUBLISHING_REVIEW_SUBMITTED",
            "PublishingLifecycle",
            lifecycle,
            checkedAt,
          ),
        });
        return {
          outcome: "FreshCommitted",
          auditReference: result.auditReference,
          lifecycleReference: lifecycle,
        };
      });
    });
  const inspect = (c, who = actor, selectedStore = store) =>
    transact((tx) => source(who, selectedStore).inspectOriginalOperation(tx, c));
  const resolve = (c) => transact((tx) => source().resolveOperation(tx, c));
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA bop_publishing,platform_audit,platform_helpers TO " + role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),bop_publishing.option_set_publication_operation_available(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON bop_publishing.option_set_publication_operation,platform_audit.audit_record TO " +
        role,
    );
    phase = "FirstSubmit";
    const c = command(),
      baseline = await counts(),
      result = await write(c),
      persisted = await counts();
    assert.equal(result.outcome, "FreshCommitted");
    assert.deepEqual(persisted, {
      mutations: baseline.mutations + 2,
      terminal: baseline.terminal + 1,
      audit: baseline.audit + 2,
    });
    phase = "OriginalReplay";
    const allocated = sequence,
      replay = await write(c);
    assert.equal(replay.outcome, "Committed");
    assert.equal(replay.auditReference, result.auditReference);
    assert.equal(replay.mutation.idempotencyKey, c.operationReference);
    assert.equal(replay.mutation.operation, "SubmitReview");
    assert.equal(replay.mutation.next.lifecycleId, result.lifecycleReference);
    assert.equal(sequence, allocated);
    assert.deepEqual(await counts(), persisted);
    phase = "LostReplyResolve";
    const discarded = command();
    await write(discarded);
    const beforeResolve = await counts(),
      resolveAllocations = sequence,
      recovered = await resolve(discarded);
    assert.equal(recovered.outcome, "Committed");
    assert.equal(recovered.mutation.idempotencyKey, discarded.operationReference);
    assert.equal(sequence, resolveAllocations);
    assert.deepEqual(await counts(), beforeResolve);
    phase = "IdentityRefusals";
    const beforeDenial = await counts();
    await assert.rejects(inspect({ ...c, expectedAggregateVersion: 2 }));
    await assert.rejects(inspect({ ...c, actorReference: otherActor }, otherActor));
    await assert.rejects(inspect({ ...c, selectedStoreReference: otherStore }, actor, otherStore));
    assert.deepEqual(await counts(), beforeDenial);
    phase = "DurableAbandonment";
    const abandonedCommand = command(),
      preAbandon = await counts(),
      abandoned = await resolve(abandonedCommand);
    assert.equal(abandoned.outcome, "Abandoned");
    assert.deepEqual(await counts(), {
      mutations: preAbandon.mutations,
      terminal: preAbandon.terminal + 1,
      audit: preAbandon.audit + 1,
    });
    const abandonedCounts = await counts(),
      noNewIds = sequence;
    assert.deepEqual(await resolve(abandonedCommand), abandoned);
    assert.equal(sequence, noNewIds);
    await assert.rejects(write(abandonedCommand));
    assert.deepEqual(await counts(), abandonedCounts);
    phase = "SqlLateWriterFence";
    await assert.rejects(
      transact(async (tx) => {
        const observedAt = parsePublishingInstant(now()),
          lifecycle = parsePublishingReference(reference());
        const next = createPublishingLifecycleRecord({
          lifecycleId: lifecycle,
          familyReference: parsePublishingReference(abandonedCommand.optionSetReference),
          configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
          purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
          snapshotReference: parsePublishingReference(abandonedCommand.versionReference),
          snapshotDigest: hash,
          scope,
          version: parsePublishingVersion(1),
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: observedAt,
          changedAt: observedAt,
        });
        // A legacy public owning writer is used only to prove the SQL fence itself;
        // ordinary runtime writers cannot choose this identity-free route.
        const legacy = createPostgresPublishingMutationStore(
          { run: (work) => work(tx) },
          tenant,
          scope,
        );
        return legacy.commit({
          operation: "CreateDraft",
          expectedVersion: parsePublishingVersion(1),
          idempotencyKey: parsePublishingReference(abandonedCommand.operationReference),
          current: null,
          next,
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: null,
          audit: audit(
            abandonedCommand.operationReference,
            "PUBLISHING_DRAFT_CREATED",
            "PublishingLifecycle",
            lifecycle,
            observedAt,
          ),
        });
      }),
      /sqlstate=23514/u,
    );
    assert.deepEqual(await counts(), abandonedCounts);
    phase = "LateAuthorityRollback";
    const rollbackCommand = command(),
      preRollback = await counts();
    afterWork = async () => {
      allowed = false;
    };
    await assert.rejects(write(rollbackCommand));
    allowed = true;
    assert.deepEqual(await counts(), preRollback);
    assert.equal((await inspect(rollbackCommand)).outcome, "Absent");
    // Each transaction below uses a fresh source and real clock. The bounded wait
    // observes actual backend lock contention, then releases before the 5s lease.
    for (const writerFirst of [true, false]) {
      phase = writerFirst ? "WriterWinsFence" : "AbandonmentWinsFence";
      const raced = command(),
        before = await counts(),
        held = Promise.withResolvers(),
        release = Promise.withResolvers(),
        race = { pids: [] };
      let first, second;
      capture = race;
      afterWork = async () => {
        held.resolve();
        await bounded(release.promise);
      };
      try {
        first = settled(writerFirst ? () => write(raced) : () => resolve(raced));
        await bounded(held.promise);
        second = settled(writerFirst ? () => resolve(raced) : () => write(raced));
        let blocked = false;
        const stop = Date.now() + 3000;
        while (Date.now() < stop && !blocked) {
          const observation = await admin.query(
            "SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",
            [race.pids[1] ?? 0],
          );
          const row = observation.rows[0];
          blocked = row?.wait_event_type === "Lock" && row.blockers.includes(race.pids[0]);
        }
        assert.equal(blocked, true, "Actual original operation fence must block contender");
        release.resolve();
        const winner = await bounded(first),
          contender = await bounded(second);
        if (winner.error) throw winner.error;
        if (writerFirst) {
          if (contender.error) throw contender.error;
          assert.equal(contender.value.outcome, "Committed");
          assert.equal(contender.value.auditReference, winner.value.auditReference);
          assert.deepEqual(await counts(), {
            mutations: before.mutations + 2,
            terminal: before.terminal + 1,
            audit: before.audit + 2,
          });
        } else {
          assert.equal(winner.value.outcome, "Abandoned");
          assert(contender.error);
          assert.deepEqual(await counts(), {
            mutations: before.mutations,
            terminal: before.terminal + 1,
            audit: before.audit + 1,
          });
        }
      } finally {
        release.resolve();
        try {
          await bounded(Promise.all([first, second].filter(Boolean)));
        } catch {
          for (const pid of race.pids)
            if (active.has(pid)) await admin.query("SELECT pg_terminate_backend($1)", [pid]);
          await bounded(Promise.all([first, second].filter(Boolean)));
        }
        capture = null;
        afterWork = null;
      }
    }
    phase = "RlsRead";
    await transact(async (tx) => {
      await tx.query("SELECT set_config('bop.store_id',$1,true)", [otherStore]);
      const rows = await tx.query(
        "SELECT operation_id FROM bop_publishing.option_set_publication_operation WHERE tenant_id=$1 AND brand_id=$2",
        [tenant, brand],
      );
      assert.equal(rows.rows.length, 0);
    });
  } catch (error) {
    if (
      /^PUBLICATION_RECOVERY_SQL_FAILURE phase=[A-Za-z]+ sqlstate=[0-9A-Z]{5}$/u.test(
        error?.message ?? "",
      )
    )
      throw error;
    throw new Error("PUBLICATION_RECOVERY_NATIVE_FAILED phase=" + phase, { cause: error });
  } finally {
    allowed = true;
    afterWork = null;
    try {
      for (const pid of [...active]) await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      try {
        if (createdRole) {
          await admin.query("DROP OWNED BY " + role);
          await admin.query("DROP ROLE " + role);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
