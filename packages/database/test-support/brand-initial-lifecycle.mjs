import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

/** Reuses actual initialized Brand, two persisted Workforce Sessions and IAM.
 * Only outbound Provider transport/clock are the parent InternalTest boundaries.
 * There is no new success row, grant, selection or optional-source qualification. */
export async function exerciseInitialBrandLifecycle(
  f,
  { send, brandReference, merchantRole, sessions, participantState, allocationCount },
) {
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].actorReference, sessions[1].actorReference);
  assert.notEqual(sessions[0].sessionReference, sessions[1].sessionReference);
  f.mark("Ordinary Brand lifecycle minimum role");
  await f.admin.query(
    `GRANT UPDATE(lifecycle,version,updated_at) ON bop_tenant.brand TO ${merchantRole}`,
  );
  await f.admin.query(`GRANT SELECT,INSERT ON bop_tenant.brand_admin_operation TO ${merchantRole}`);
  assert.deepEqual(
    (
      await f.admin.query(
        "SELECT has_column_privilege($1,'bop_tenant.brand','code','UPDATE') metadata_write,has_table_privilege($1,'bop_tenant.brand','INSERT') create_brand,has_table_privilege($1,'bop_tenant.brand_admin_operation','UPDATE') history_write,has_table_privilege($1,'bop_membership.membership','INSERT') member_write,has_table_privilege($1,'bop_permission.permission_grant','INSERT') grants_write",
        [merchantRole],
      )
    ).rows[0],
    {
      metadata_write: false,
      create_brand: false,
      history_write: false,
      member_write: false,
      grants_write: false,
    },
  );
  const prefix = "/merchant/organization/brands",
    op = (n) => `01903200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const command = (action, version, n) => ({
    brandReference,
    action,
    expectedBrandVersion: version,
    operationReference: op(n),
  });
  const execute = (session, body) =>
    send(`${prefix}/lifecycle`, {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body,
    });
  const counts = async () =>
    (
      await f.admin.query(
        `SELECT
    (SELECT lifecycle FROM bop_tenant.brand WHERE brand_id=$1) lifecycle,
    (SELECT version::int FROM bop_tenant.brand WHERE brand_id=$1) version,
    (SELECT count(*)::int FROM bop_tenant.brand_admin_operation WHERE brand_id=$1) originals,
    (SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audits,
    (SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_revision WHERE brand_id=$1) configurations,
    (SELECT count(*)::int FROM bop_membership.membership WHERE brand_id=$1) memberships,
    (SELECT count(*)::int FROM bop_permission.permission_grant WHERE brand_id=$1) grants`,
        [brandReference],
      )
    ).rows[0];
  const receipt = (response, session, request, status) => {
    assert.equal(response.status, 200, "ACTUAL_BRAND_LIFECYCLE_HTTP_REQUIRED");
    const body = JSON.parse(response.body);
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "profile",
        "actorReference",
        "brandReference",
        "action",
        "operationReference",
        "expectedBrandVersion",
        "status",
        "lifecycle",
        "version",
        "occurredAt",
      ].sort(),
    );
    assert.equal(body.profile, "MerchantBrandLifecycleReceiptV1");
    assert.equal(body.actorReference, session.actorReference);
    for (const key of Object.keys(request)) assert.equal(body[key], request[key]);
    assert.equal(body.status, status);
    assert.equal(body.version, request.expectedBrandVersion + 1);
    assert.equal(body.lifecycle, request.action === "ActivateBrand" ? "Active" : "Archived");
    assert.equal(new Date(body.occurredAt).toISOString(), body.occurredAt);
    return body;
  };
  const current = async (lifecycle, version) => {
    for (const session of sessions) {
      const detail = await send(`${prefix}/session`, { cookie: session.cookie });
      assert.equal(detail.status, 200);
      const workspace = JSON.parse(detail.body).workspace;
      assert.equal(workspace.selectedScope.actorReference, session.actorReference);
      assert.equal(workspace.brand.lifecycle, lifecycle);
      assert.equal(workspace.brand.version, version);
      const bootstrap = await send(`${prefix}/discovery/session`, { cookie: session.cookie });
      assert.equal(bootstrap.status, 200);
      assert.equal(JSON.parse(bootstrap.body).selectedBrandReference, brandReference);
      const page = await send(`${prefix}/discovery/list`, {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: { afterBrandReference: null },
      });
      assert.equal(page.status, 200);
      const item = JSON.parse(page.body).items.find(
        (item) => item.brandReference === brandReference,
      );
      assert(item);
      assert.equal(item.lifecycle, lifecycle);
      assert.equal(item.version, version);
    }
  };
  const before = await counts();
  assert.equal(before.lifecycle, "Draft");
  assert.equal(before.version, 1);
  await current("Draft", 1);
  const previous = f.state.afterQuery;
  try {
    f.mark("Late actual SDK withdrawal after owning Brand UPDATE rolls back all artifacts");
    let updated = false;
    const disabledBefore = participantState.disabledMemberCalls;
    f.state.afterQuery = async (input) => {
      if (previous) await previous(input);
      if (input.sql.startsWith("UPDATE bop_tenant.brand SET lifecycle=")) {
        updated = true;
        participantState.membersEnabled = false;
      }
    };
    const refused = await execute(sessions[0], command("ActivateBrand", 1, 1));
    assert.notEqual(refused.status, 200);
    assert.equal(updated, true);
    assert(participantState.disabledMemberCalls > disabledBefore);
    assert.deepEqual(await counts(), before);
  } finally {
    f.state.afterQuery = previous;
    participantState.membersEnabled = true;
  }

  f.mark("Concurrent genuine administrators serialize activation under owning Brand admission");
  let enteredResolve,
    releaseResolve,
    firstPid,
    paused = false;
  const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    }),
    release = new Promise((resolve) => {
      releaseResolve = resolve;
    });
  const requests = [command("ActivateBrand", 1, 2), command("ActivateBrand", 1, 3)];
  let first, second, gateError;
  try {
    f.state.afterQuery = async (input) => {
      if (previous) await previous(input);
      if (!paused && input.sql.startsWith("UPDATE bop_tenant.brand SET lifecycle=")) {
        paused = true;
        firstPid = input.client.processID;
        enteredResolve();
        await release;
      }
    };
    first = execute(sessions[0], requests[0]);
    await Promise.race([
      entered,
      first.then(() => {
        throw new Error("LIFECYCLE_CONCURRENCY_GATE_NOT_REACHED");
      }),
      wait(1800).then(() => {
        throw new Error("LIFECYCLE_CONCURRENCY_GATE_TIMEOUT");
      }),
    ]);
    second = execute(sessions[1], requests[1]);
    let blocked = false;
    for (let i = 0; i < 20 && !blocked; i++) {
      blocked = (
        await f.admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))) blocked",
          [merchantRole, firstPid],
        )
      ).rows[0].blocked;
      if (!blocked) await wait(25);
    }
    assert.equal(blocked, true, "ACTUAL_LIFECYCLE_LOCK_CONTENTION_REQUIRED");
  } catch (error) {
    gateError = error;
  } finally {
    releaseResolve();
    f.state.afterQuery = previous;
  }
  // Both requests are always joined before proceeding or exposing cleanup.
  const outcomes = await Promise.allSettled([first, second].filter((value) => value !== undefined));
  if (gateError) throw gateError;
  assert.equal(outcomes.length, 2);
  const results = outcomes.map((value) => {
    if (value.status !== "fulfilled") throw value.reason;
    return value.value;
  });
  const activated = receipt(results[0], sessions[0], requests[0], "Applied");
  assert.equal(results[1].status, 409);
  const afterActive = await counts();
  assert.deepEqual(afterActive, {
    ...before,
    lifecycle: "Active",
    version: 2,
    originals: before.originals + 1,
    audits: before.audits + 1,
  });
  await current("Active", 2);
  f.mark("Stale CAS has a confirmed refusal and no new lifecycle artifacts");
  const stale = await execute(sessions[1], command("ArchiveBrand", 1, 4));
  assert.equal(stale.status, 409);
  assert.deepEqual(await counts(), afterActive);
  f.mark("Actual Archive preserves administrative reads and immutable activation result");
  const archiveRequest = command("ArchiveBrand", 2, 5),
    archived = receipt(
      await execute(sessions[1], archiveRequest),
      sessions[1],
      archiveRequest,
      "Applied",
    );
  assert.equal(archived.version, 3);
  const afterArchive = await counts();
  assert.deepEqual(afterArchive, {
    ...afterActive,
    lifecycle: "Archived",
    version: 3,
    originals: before.originals + 2,
    audits: before.audits + 2,
  });
  await current("Archived", 3);
  const allocations = allocationCount();
  const replay = receipt(
    await execute(sessions[0], requests[0]),
    sessions[0],
    requests[0],
    "AlreadyApplied",
  );
  assert.deepEqual({ ...replay, status: "Applied" }, activated);
  assert.equal(allocationCount(), allocations);
  assert.deepEqual(await counts(), afterArchive);
  assert.notEqual((await execute(sessions[1], requests[0])).status, 200);
  assert.deepEqual(await counts(), afterArchive);
  assert.notEqual(
    (
      await execute(sessions[0], {
        ...requests[0],
        action: "ArchiveBrand",
        expectedBrandVersion: 2,
      })
    ).status,
    200,
  );
  assert.deepEqual(await counts(), afterArchive);
  const saved = (
    await f.admin.query(
      "SELECT actor_reference,purpose_code,command_type,brand_version::int,artifact_snapshot_json FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2",
      [brandReference, requests[0].operationReference],
    )
  ).rows[0];
  assert.equal(saved.actor_reference, sessions[0].actorReference);
  assert.equal(saved.purpose_code, "BRAND_ADMINISTRATION");
  assert.equal(saved.command_type, "ActivateBrand");
  assert.equal(saved.brand_version, 2);
  assert.equal(saved.artifact_snapshot_json.lifecycle, "Active");
}
