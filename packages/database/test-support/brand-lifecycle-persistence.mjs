import { withBrandLifecycleHttp } from "../../../apps/api/test-support/brand-lifecycle-http.mjs";
import { createBrandLifecycleCommand } from "../../../apps/api/src/brand-lifecycle-command.ts";
import assert from "node:assert/strict";
import pg from "pg";
import {
  createBrand,
  createBrandAdministrationService,
  createPostgresBrandLifecycleStore,
  transitionBrand,
} from "../../bop/tenant/src/index.ts";
import { appendAuditRecordInTransaction, sha256Hex } from "../../bop/audit/src/index.ts";

export async function exerciseBrandLifecycle({ context, admin, role, id, at }) {
  await admin.query("GRANT SELECT,INSERT,UPDATE ON bop_tenant.brand TO " + role);
  await admin.query("GRANT SELECT,INSERT ON bop_tenant.brand_admin_operation TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  let allowed = true,
    failAudit = false,
    actualAuditFailures = 0;
  let lastFailure;
  const transactions = {
    async run(work) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        lastFailure = error;
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const makeStore = (brandReference) =>
    createPostgresBrandLifecycleStore({
      brandReference,
      transactions,
      authorize: async () => allowed,
      appendAudit: async (tx, input) => {
        await appendAuditRecordInTransaction(tx, {
          auditId: input.audit.auditReference,
          brandId: brandReference,
          actor: { type: "User", reference: input.audit.actorReference },
          actionCode: "BRAND_LIFECYCLE_CHANGED",
          targetType: "Brand",
          targetId: brandReference,
          correlationId: input.operation.operationReference,
          reasonCode: input.audit.purposeCode,
          occurredAt: input.audit.occurredAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "CONFIGURATION_AUDIT",
          retentionPolicyVersion: 1,
        });
        if (failAudit) {
          actualAuditFailures++;
          throw new Error("synthetic post-Audit failure");
        }
      },
    });
  const store = makeStore(id(100));
  const unavailable = () => {
    throw new Error("unused Brand service dependency");
  };
  const serviceFor = (repository) =>
    createBrandAdministrationService({
      authorization: { authorize: async () => allowed },
      approval: { validate: unavailable },
      publishing: { validate: unavailable },
      references: {
        validateMedia: unavailable,
        validateCatalog: unavailable,
        hashIntent: (s) => "sha256:" + sha256Hex(s),
        equals: (a, b) => a === b,
      },
      repository: {
        ...repository,
        loadStore: unavailable,
        loadLatestConfiguration: unavailable,
        loadLatestMembership: unavailable,
      },
    });
  const service = serviceFor(store);
  const input = (artifact, expectedBrandVersion, n) => ({
    operationReference: id(n),
    actorReference: id(20),
    purposeCode: "SYNTHETIC_LIFECYCLE",
    auditReference: id(n + 1000),
    expectedBrandVersion,
    occurredAt: artifact.updatedAt,
    artifact,
  });
  const draft = createBrand({
    brandReference: id(100),
    code: "LIFECYCLE",
    displayName: "Synthetic lifecycle",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const created = await service.createBrand(input(draft, 0, 101)).catch((error) => {
    throw new Error("synthetic Brand creation failed", { cause: lastFailure ?? error });
  });
  assert.equal(created.status, "Applied");
  assert.deepEqual(await store.loadBrand(id(100)), draft);
  const active = transitionBrand(draft, 1, "Active", "2026-08-15T14:01:00.000Z");
  const activation = input(active, 1, 102);
  failAudit = true;
  await assert.rejects(service.activateBrand(activation), {
    code: "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE",
  });
  assert.equal(actualAuditFailures, 1);
  assert.deepEqual(await store.loadBrand(id(100)), draft);
  assert.equal(await store.resolveOperation(id(102)), null);
  failAudit = false;
  const raced = await Promise.allSettled([
    service.activateBrand(activation),
    service.activateBrand(input(active, 1, 103)),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    raced.find((r) => r.status === "rejected").reason.code,
    "BRAND_ADMIN_VERSION_CONFLICT",
  );
  const winner = raced.find((r) => r.status === "fulfilled").value;
  assert.deepEqual(await store.loadBrand(id(100)), active);
  const archived = transitionBrand(active, 2, "Archived", "2026-08-15T14:02:00.000Z");
  await service.archiveBrand(input(archived, 2, 104));
  const original =
    winner.operation.operationReference === id(102) ? activation : input(active, 1, 103);
  assert.deepEqual(await service.activateBrand(original), {
    status: "AlreadyApplied",
    operation: winner.operation,
  });
  assert.deepEqual(await store.loadBrand(id(100)), archived);
  await assert.rejects(service.activateBrand({ ...original, purposeCode: "CHANGED" }), {
    code: "BRAND_ADMIN_IDEMPOTENCY_CONFLICT",
  });
  await assert.rejects(store.loadBrand(id(1)), { code: "BRAND_ADMIN_PERMISSION_DENIED" });
  await assert.rejects(makeStore(id(1)).resolveOperation(id(16)), {
    code: "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE",
  });
  const counts = (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM bop_tenant.brand_admin_operation WHERE brand_id=$1) operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) audits",
      [id(100)],
    )
  ).rows[0];
  assert.deepEqual(counts, { operations: 3, audits: 3 });
  allowed = false;
  await assert.rejects(store.resolveOperation(winner.operation.operationReference), {
    code: "BRAND_ADMIN_PERMISSION_DENIED",
  });
  await assert.rejects(service.activateBrand(original), { code: "BRAND_ADMIN_PERMISSION_DENIED" });
  allowed = true;
  const secondStore = makeStore(id(200));
  const secondService = serviceFor(secondStore);
  const secondDraft = createBrand({ ...draft, brandReference: id(200), code: "COMMAND_BRAND" });
  await secondService.createBrand(input(secondDraft, 0, 201));
  let now = "2026-08-15T14:03:00.000Z";
  let authorized = true;
  const command = createBrandLifecycleCommand({
    transactions,
    now: () => now,
    auditReference: (operation) => id(Number.parseInt(operation.slice(-12), 16) + 2000),
    authorize: async (_tx, request) => {
      assert.equal(request.sessionCookie, "synthetic-cookie");
      assert.equal(request.csrf, "synthetic-csrf");
      return authorized && request.brandReference === id(200)
        ? { actorReference: id(20), purposeCode: "SYNTHETIC_OWNER_ADMINISTRATION" }
        : null;
    },
  });
  const request = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      brandReference: id(200),
      action: "ActivateBrand",
      expectedBrandVersion: 1,
      operationReference: id(202),
    },
  };
  let applied;
  await withBrandLifecycleHttp(command, async (post) => {
    const response = await post(request.command);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    applied = response.body;
  });
  assert.deepEqual(applied, {
    status: "Applied",
    brandReference: id(200),
    lifecycle: "Active",
    version: 2,
  });
  now = "2026-08-15T14:04:00.000Z";
  assert.deepEqual(await command(request), { ...applied, status: "AlreadyApplied" });
  await assert.rejects(
    command({ ...request, command: { ...request.command, actorReference: id(99) } }),
    { code: "BRAND_ADMIN_INPUT_INVALID" },
  );
  await assert.rejects(
    command({ ...request, command: { ...request.command, expectedBrandVersion: 2 } }),
    { code: "BRAND_ADMIN_IDEMPOTENCY_CONFLICT" },
  );
  await command({
    ...request,
    command: {
      ...request.command,
      action: "ArchiveBrand",
      expectedBrandVersion: 2,
      operationReference: id(203),
    },
  });
  assert.deepEqual(await command(request), { ...applied, status: "AlreadyApplied" });
  assert.equal((await secondStore.loadBrand(id(200))).lifecycle, "Archived");
  const savedAudit = (
    await admin.query(
      "SELECT actor_reference,occurred_at FROM bop_tenant.brand_admin_operation WHERE brand_id=$1 AND operation_id=$2",
      [id(200), id(202)],
    )
  ).rows[0];
  assert.equal(savedAudit.actor_reference, id(20));
  assert.equal(savedAudit.occurred_at.toISOString(), "2026-08-15T14:03:00.000Z");
  await withBrandLifecycleHttp(command, async (post) => {
    assert.deepEqual(await post(request.command), {
      status: 200,
      body: { ...applied, status: "AlreadyApplied" },
    });
    for (const headers of [
      { Origin: "https://foreign.invalid" },
      { Host: "foreign.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { Cookie: "" },
      { "X-BOP-CSRF": "" },
    ])
      assert.equal((await post(request.command, headers)).status, 403);
    assert.equal(
      (await post(request.command, {}, "/merchant/organization/brands/lifecycle?brand=other"))
        .status,
      403,
    );
    assert.equal((await post({ ...request.command, actorReference: id(99) })).status, 400);
    assert.equal((await post({ ...request.command, expectedBrandVersion: 2 })).status, 409);
    authorized = false;
    assert.deepEqual(await post(request.command), {
      status: 403,
      body: { error: "request_denied" },
    });
  });
  authorized = false;
  await assert.rejects(command(request), { code: "BRAND_ADMIN_PERMISSION_DENIED" });
}
