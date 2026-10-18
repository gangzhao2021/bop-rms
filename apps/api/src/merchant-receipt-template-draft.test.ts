import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import {
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateArtifactVersion,
  type DigitalReceiptTemplateDraftReceipt,
} from "@rms/printing-device";
import { createMerchantReceiptTemplateDraft } from "./merchant-receipt-template-draft.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn(), audit: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  scope4 = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
interface DB {
  versions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
const fields = () => ({
  locale: "en-CA",
  layoutDefinitionReference: id(6),
  complianceRuleReference: id(7),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
const body = (op = 10, prior?: DigitalReceiptTemplateDraftReceipt) => ({
  command: "SaveDraft",
  operationReference: id(op),
  templateReference: prior?.snapshot?.content.templateReference ?? null,
  expectedVersionReference: prior?.snapshot?.content.versionReference ?? null,
  expectedRevision: prior?.snapshot?.revision ?? 0,
  fields: fields(),
});
beforeEach(() => vi.resetAllMocks());
// Actual Device owning factories/parsers and actual transaction coordinator;
// controlled SQL/Session scope/Audit append boundary, not native IAM or PG.
function fixture(db: DB = { versions: [], operations: [] }, actor = id(4)) {
  const events: string[] = [],
    sql: string[] = [],
    artifactQueries: string[] = [],
    audits: unknown[] = [],
    state = {
      clock: at,
      clockHook: () => undefined,
      allowed: true,
      editingAllowed: true,
      integrationDenied: false,
      until,
      editingUntil: until,
      late: "" as "" | "org" | "edit" | "clock" | "port",
      artifactMissing: false,
    };
  const scope = {
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    actorReference: actor,
    sessionReference: id(5),
    store: { storeReference: id(3) },
    allowed: vi.fn(async () => state.allowed),
    authorizationValidUntil: () => state.until,
  };
  const edit = {
    ...scope,
    allowed: vi.fn(async () => state.editingAllowed),
    authorizationValidUntil: () => state.editingUntil,
  };
  mocks.scope.mockImplementation(async (_tx, _cookie, action, session) => {
    if (session !== undefined) expect(session).toBe(id(5));
    events.push(action);
    if (action === "organization.manage") return scope;
    expect(action).toBe("integration.manage");
    if (state.integrationDenied) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    return edit;
  });
  mocks.audit.mockImplementation(async (actual, input) => {
    expect(actual).toBeDefined();
    validateAuditRecord(input, Date.parse(state.clock));
    audits.push(input);
    events.push("audit");
  });
  let latestReads = 0,
    next = 100 + db.versions.length * 10 + db.operations.length * 10;
  const query = vi.fn(async (statement: string, v: readonly unknown[]) => {
    sql.push(statement);
    if (statement.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed" }], rowCount: 1 };
    if (statement.includes("FROM rms_device.digital_receipt_template_version")) {
      events.push("published sequence");
      return { rows: [], rowCount: 0 };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_artifact_version")) {
      const kind = v[3] === "Layout" ? "Layout" : "Compliance",
        reference = String(v[4]);
      artifactQueries.push(kind + ":" + reference);
      if (state.artifactMissing) return { rows: [], rowCount: 0 };
      const snapshot = parseDigitalReceiptTemplateArtifactVersion({
        profile: "DigitalReceiptTemplateArtifactV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        artifactKind: kind,
        artifactReference: reference,
        revision: 1,
        authoredByReference: id(90),
        previousArtifactReference: null,
        content:
          kind === "Layout"
            ? {
                profile: "AccessibleDigitalReceiptLayoutV1",
                dataContractVersion: 1,
                renderEngineVersion: 1,
                outputProfile: "AccessibleDigitalReceipt",
                requiredFields: [...digitalReceiptRequiredFields],
              }
            : {
                profile: "DigitalReceiptRequiredFieldRuleV1",
                dataContractVersion: 1,
                requiredFields: [...digitalReceiptRequiredFields],
                professionalReviewStatus: "NotEvaluated",
                legalConclusion: "NotEvaluated",
              },
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      return {
        rows: [
          {
            artifact_kind: kind,
            artifact_id: reference,
            revision: "1",
            operation_id: id(91),
            actor_id: id(90),
            previous_artifact_id: null,
            snapshot_json: snapshot,
            snapshot_digest: hash(snapshot),
            created_at: at,
            updated_at: at,
          },
        ],
        rowCount: 1,
      };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_draft_revision")) {
      if (statement.includes("DISTINCT ON (template_id)")) {
        const heads = new Map<string, Record<string, unknown>>();
        for (const row of db.versions) {
          const key = String(row.template_id),
            prior = heads.get(key);
          if (!prior || Number(row.revision) > Number(prior.revision)) heads.set(key, row);
        }
        const page = [...heads.values()]
          .filter((row) => v[3] === null || String(row.template_id) > String(v[3]))
          .sort((a, b) => String(a.template_id).localeCompare(String(b.template_id)))
          .slice(0, 21);
        return { rows: page, rowCount: page.length };
      }
      let rows = db.versions;
      if (statement.includes("ORDER BY")) {
        latestReads++;
        if (latestReads === 2) {
          if (state.late === "org") state.allowed = false;
          if (state.late === "edit") state.editingAllowed = false;
          if (state.late === "clock") state.clock = until;
          if (state.late === "port") edit.allowed = vi.fn(async () => true);
        }
        rows = rows.filter((r) => r.template_id === v[3]).slice(-1);
      } else if (statement.includes("AND template_id"))
        rows = rows.filter((r) => r.template_id === v[3] && r.version_id === v[4]);
      else
        rows = rows.filter(
          (r) => r.version_id === v[3] && r.revision === String(v[4]) && r.operation_id === v[5],
        );
      return { rows, rowCount: rows.length };
    }
    if (statement.includes("FROM rms_device.digital_receipt_template_draft_operation")) {
      const rows = db.operations.filter(
        (r) =>
          r.tenant_id === v[0] &&
          r.brand_id === v[1] &&
          r.store_id === v[2] &&
          r.operation_id === v[3],
      );
      return { rows, rowCount: rows.length };
    }
    if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_draft_revision"))
      db.versions.push({
        template_id: v[3],
        family_id: v[4],
        version_id: v[5],
        revision: String(v[6]),
        publication_version_number: String(v[7]),
        operation_id: v[8],
        actor_id: v[9],
        previous_version_id: v[10],
        content_digest: v[11],
        snapshot_json: JSON.parse(String(v[12])),
        snapshot_digest: v[13],
        created_at: v[14],
        updated_at: v[15],
      });
    if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_draft_operation"))
      db.operations.push({
        operation_id: v[0],
        tenant_id: v[1],
        brand_id: v[2],
        store_id: v[3],
        actor_id: v[4],
        template_id: v[5],
        intent_digest: v[6],
        expected_version_id: v[7],
        expected_revision: String(v[8]),
        outcome: v[9],
        result_version_id: v[10],
        result_revision: v[11] === null ? null : String(v[11]),
        snapshot_digest: v[12],
        audit_reference: v[13],
        occurred_at: v[14],
      });
    return { rows: [], rowCount: 1 };
  });
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    const versions = [...db.versions],
      operations = [...db.operations],
      auditCount = audits.length;
    events.push("begin");
    try {
      const r = await work({ query });
      events.push("commit");
      return r;
    } catch (e) {
      db.versions = versions;
      db.operations = operations;
      audits.splice(auditCount);
      events.push("rollback");
      throw e;
    }
  });
  const options = {
    persistence: {
      now: () => {
        state.clockHook();
        return state.clock;
      },
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => undefined,
      validateAssociation: async () => true,
    },
    authentication: { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    nextReference: vi.fn(() => id(next++)),
  };
  const service = createMerchantReceiptTemplateDraft(
    options as unknown as Parameters<typeof createMerchantReceiptTemplateDraft>[0],
  );
  return { service, options, state, db, sql, events, artifactQueries, audits, scope, edit };
}
const write = (
  f: ReturnType<typeof fixture>,
  command: unknown = body(),
  expectedScope: unknown = scope4,
) => f.service.write({ sessionCookie: "synthetic", csrf: "synthetic", expectedScope, command });
const read = (f: ReturnType<typeof fixture>, templateReference: string | null = null) =>
  f.service.read({ sessionCookie: "synthetic", expectedStoreReference: id(3), templateReference });
it("reads genuine empty current without edit permission, allocation or artifacts", async () => {
  const f = fixture();
  f.state.integrationDenied = true;
  expect(await read(f)).toMatchObject({
    templateReference: null,
    snapshot: null,
    sourceQualification: "NotEvaluated",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.artifactQueries).toEqual([]);
  expect(f.events).not.toContain("integration.manage");
});
it("fresh save allocates actual template/family/version and acquires exact historical artifacts under the real owner", async () => {
  const f = fixture(),
    r = await write(f);
  expect(r.outcome).toBe("Committed");
  expect(r.templateReference).toBeNull();
  expect(r.snapshot).toMatchObject({
    revision: 1,
    authoredByReference: id(4),
    content: {
      versionNumber: 1,
      versionCode: "RECEIPT_1",
      layoutDefinitionReference: id(6),
      complianceRuleReference: id(7),
    },
  });
  expect(r.snapshot?.familyReference).not.toBe(r.snapshot?.content.templateReference);
  expect(f.artifactQueries.slice(0, 2)).toEqual(["Layout:" + id(6), "Compliance:" + id(7)]);
  expect(f.artifactQueries.filter((q) => q.startsWith("Layout"))).toHaveLength(3);
  expect(f.audits).toHaveLength(1);
  expect(f.audits[0]).toMatchObject({
    actionCode: "RECEIPT_TEMPLATE_DRAFT_SAVED",
    afterSummary: { intentDigest: r.intentDigest },
  });
  expect(JSON.stringify(f.audits)).not.toContain("layoutDefinitionReference");
  expect(f.events.at(-1)).toBe("commit");
});
it("repeated Draft edit keeps publication number and stable family but has new version/author", async () => {
  const f = fixture(),
    r = await write(f);
  const edit = fixture(f.db, id(12));
  edit.state.clock = "2026-10-05T10:00:01.000Z";
  const result = await write(edit, body(11, r), { ...scope4, actorReference: id(12) });
  expect(result.snapshot).toMatchObject({
    revision: 2,
    familyReference: r.snapshot?.familyReference,
    createdAt: at,
    authoredByReference: id(12),
    previousVersionReference: r.snapshot?.content.versionReference,
    content: { versionNumber: 1 },
  });
  expect(result.snapshot?.content.versionReference).not.toBe(r.snapshot?.content.versionReference);
});
it("stored original retry and Resolve bypass today's artifact/counter qualification and allocation", async () => {
  const f = fixture(),
    command = body(),
    r = await write(f, command);
  for (const mode of ["retry", "resolve"]) {
    const fresh = fixture(f.db);
    fresh.state.artifactMissing = true;
    const request =
      mode === "retry"
        ? command
        : {
            command: "ResolveOriginal",
            operationReference: command.operationReference,
            templateReference: null,
            expectedVersionReference: null,
            expectedRevision: 0,
            intentDigest: r.intentDigest,
          };
    expect(await write(fresh, request)).toEqual(r);
    expect(fresh.artifactQueries).toEqual([]);
    expect(fresh.events).not.toContain("published sequence");
    expect(fresh.options.nextReference).not.toHaveBeenCalled();
    expect(fresh.audits).toEqual([]);
  }
});
it("genuine absence durably abandons and later Save preserves terminal without content or artifacts", async () => {
  const f = fixture(),
    command = body(),
    intentDigest = hash({
      profile: "DigitalReceiptTemplateDraftSaveV1",
      ...scope4,
      operationReference: command.operationReference,
      templateReference: null,
      expectedVersionReference: null,
      expectedRevision: 0,
      fields: command.fields,
      purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
    });
  const r = await write(f, {
    command: "ResolveOriginal",
    operationReference: command.operationReference,
    templateReference: null,
    expectedVersionReference: null,
    expectedRevision: 0,
    intentDigest,
  });
  expect(r.outcome).toBe("Abandoned");
  expect(r.snapshot).toBeNull();
  expect(f.db.versions).toEqual([]);
  expect(f.audits[0]).toMatchObject({
    afterSummary: { intentDigest },
    actionCode: "RECEIPT_TEMPLATE_DRAFT_ORIGINAL_ABANDONED",
  });
  const late = fixture(f.db);
  expect(await write(late, command)).toEqual(r);
  expect(late.options.nextReference).not.toHaveBeenCalled();
});
it("public Current preserves historical writer separately from current reader", async () => {
  const f = fixture(),
    r = await write(f);
  const reader = fixture(f.db, id(12));
  const view = await read(reader, r.snapshot?.content.templateReference ?? null);
  expect(view.actorReference).toBe(id(12));
  expect(view.snapshot?.authoredByReference).toBe(id(4));
  expect(reader.artifactQueries).toEqual([]);
});
it.each(["SaveDraft", "ResolveOriginal"])(
  "missing integration scope denies %s before allocation",
  async (mode) => {
    const f = fixture();
    f.state.integrationDenied = true;
    const command =
      mode === "SaveDraft"
        ? body()
        : {
            command: mode,
            operationReference: id(10),
            templateReference: null,
            expectedVersionReference: null,
            expectedRevision: 0,
            intentDigest: "sha256:" + "a".repeat(64),
          };
    await expect(write(f, command)).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
    });
    expect(f.options.nextReference).not.toHaveBeenCalled();
    expect(f.db.operations).toEqual([]);
  },
);
it.each(["org", "edit", "clock", "port"] as const)(
  "late %s failure rolls back versions, terminal and Audit",
  async (late) => {
    const f = fixture();
    f.state.late = late;
    await expect(write(f)).rejects.toMatchObject({
      code:
        late === "org" || late === "edit"
          ? "RECEIPT_TEMPLATE_PERMISSION_DENIED"
          : "RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    expect(f.db.versions).toEqual([]);
    expect(f.db.operations).toEqual([]);
    expect(f.audits).toEqual([]);
    expect(f.events.at(-1)).toBe("rollback");
  },
);
it("clamps current source to the actual organization lease", async () => {
  const f = fixture();
  f.state.until = "2026-10-05T10:00:01.000Z";
  expect((await read(f)).validUntil).toBe(f.state.until);
});
it("wrong actual four-scope and malformed closed body fail without allocation", async () => {
  const f = fixture();
  await expect(write(f, body(), { ...scope4, actorReference: id(50) })).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  await expect(write(f, { ...body(), publishedAt: at })).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_INPUT_INVALID",
  });
});
it("detaches browser fields before authentication and rejects auth port drift", async () => {
  const f = fixture(),
    command = body();
  f.options.authentication.authorize.mockImplementation(async () => {
    command.fields.locale = "fr-CA";
    return { sessionReference: id(5) };
  });
  expect((await write(f, command)).snapshot?.content.locale).toBe("en-CA");
  const drift = fixture();
  drift.options.nextReference = vi.fn(() => id(60));
  await expect(write(drift)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
});
it("expired integration lease refuses a new save before server identity allocation", async () => {
  const f = fixture();
  f.state.editingUntil = at;
  await expect(write(f)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.db.versions).toEqual([]);
  expect(f.db.operations).toEqual([]);
});

it("ordinary roster uses organization scope only and discovers saved template after a different-reader reload", async () => {
  const writer = fixture(),
    saved = await write(writer);
  const reader = fixture(writer.db, id(12));
  reader.state.integrationDenied = true;
  const result = await reader.service.list({
    sessionCookie: "synthetic",
    expectedStoreReference: id(3),
    afterTemplate: null,
  });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toEqual(saved.snapshot);
  expect(result.actorReference).toBe(id(12));
  expect(reader.options.nextReference).not.toHaveBeenCalled();
  expect(reader.artifactQueries).toEqual([]);
  expect(reader.events).not.toContain("integration.manage");
  expect(reader.audits).toEqual([]);
  const after = fixture(writer.db);
  expect(
    (
      await after.service.list({
        sessionCookie: "synthetic",
        expectedStoreReference: id(3),
        afterTemplate: saved.snapshot?.content.templateReference ?? null,
      })
    ).entries,
  ).toEqual([]);
});
it("roster rejects missing/invalid explicit cursor, foreign Store, and later denied permission", async () => {
  const invalid = fixture();
  await expect(
    invalid.service.list({
      sessionCookie: "synthetic",
      expectedStoreReference: id(3),
      afterTemplate: "invalid",
    }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_INPUT_INVALID" });
  const foreign = fixture();
  await expect(
    foreign.service.list({
      sessionCookie: "synthetic",
      expectedStoreReference: id(50),
      afterTemplate: null,
    }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
  const denied = fixture();
  denied.state.allowed = false;
  await expect(
    denied.service.list({
      sessionCookie: "synthetic",
      expectedStoreReference: id(3),
      afterTemplate: null,
    }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
});

it.each(["OrganizationActor", "EditingSession"] as const)(
  "rejects %s mutation in the last real allowed callback and rolls back all artifacts",
  async (mode) => {
    const baseline = fixture();
    await write(baseline);
    const count =
      mode === "OrganizationActor"
        ? baseline.scope.allowed.mock.calls.length
        : baseline.edit.allowed.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    const f = fixture(),
      allowed = mode === "OrganizationActor" ? f.scope.allowed : f.edit.allowed;
    let calls = 0;
    allowed.mockImplementation(async () => {
      if (++calls === count) {
        if (mode === "OrganizationActor") f.scope.actorReference = id(90);
        else f.edit.sessionReference = id(90);
      }
      return true;
    });
    await expect(write(f)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
    expect(calls).toBe(count);
    expect(f.db.versions).toEqual([]);
    expect(f.db.operations).toEqual([]);
    expect(f.audits).toEqual([]);
    expect(f.events.at(-1)).toBe("rollback");
  },
);
it.each(["OrganizationStore", "EditingContext"] as const)(
  "rejects %s mutation in the final lease getter without extending the original deadline",
  async (mode) => {
    const baseline = fixture(),
      lease = vi.fn(() => until);
    if (mode === "OrganizationStore") baseline.scope.authorizationValidUntil = lease;
    else baseline.edit.authorizationValidUntil = lease;
    await write(baseline);
    const count = lease.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    const f = fixture();
    let calls = 0;
    const late = () => {
      if (++calls === count) {
        if (mode === "OrganizationStore")
          f.scope.store = { ...f.scope.store, storeReference: id(90) };
        else f.edit.context = { ...f.edit.context };
      }
      return until;
    };
    if (mode === "OrganizationStore") f.scope.authorizationValidUntil = late;
    else f.edit.authorizationValidUntil = late;
    await expect(write(f)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
    expect(calls).toBe(count);
    expect(f.db.versions).toEqual([]);
    expect(f.db.operations).toEqual([]);
    expect(f.audits).toEqual([]);
    expect(f.events.at(-1)).toBe("rollback");
  },
);
it("checks the actual scope after the clock callback following the last lease observation", async () => {
  const baseline = fixture(),
    lease = vi.fn(() => until);
  baseline.scope.authorizationValidUntil = lease;
  await write(baseline);
  const count = lease.mock.calls.length,
    f = fixture();
  let calls = 0,
    armed = false;
  f.scope.authorizationValidUntil = () => {
    if (++calls === count) armed = true;
    return until;
  };
  f.state.clockHook = () => {
    if (armed) {
      armed = false;
      f.scope.context = { ...f.scope.context };
    }
    return undefined;
  };
  await expect(write(f)).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(calls).toBe(count);
  expect(f.db.versions).toEqual([]);
  expect(f.db.operations).toEqual([]);
  expect(f.audits).toEqual([]);
  expect(f.events.at(-1)).toBe("rollback");
});
