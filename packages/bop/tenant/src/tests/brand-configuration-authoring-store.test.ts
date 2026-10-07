import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresBrandConfigurationAuthoringStore,
  type BrandConfigurationAuthoringStoreOptions,
  type BrandConfigurationAuthoringTransaction,
} from "../infrastructure/persistence/brand-configuration-authoring-store.js";
import { createBrandConfigurationVersion } from "../contracts/brand-administration.js";
import { parseBrandConfigurationCommand } from "../contracts/brand-configuration-operation.js";
const id = (n: number) => `01902503-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
      )
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Invalid controlled canonical input");
  return text;
}
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const fields = () => ({
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(4),
  platformTemplateReference: id(5),
  overrideAllowedFieldCodes: [],
  hardRequirementFieldCodes: [],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
});
const request = (patch: Record<string, unknown> = {}) =>
  parseBrandConfigurationCommand({
    profile: "TenantBrandConfigurationCommandV1",
    ...scope,
    command: "SaveConfigurationDraft",
    operationReference: id(10),
    expectedBrandVersion: 1,
    expectedHead: null,
    configuration: fields(),
    reviewValidUntil: null,
    purposeCode: "BRAND_CONFIGURATION",
    ...patch,
  });
interface Database {
  revisions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  legacy: Record<string, unknown>[];
  lifecycle?: string;
}
function fixture(
  database: Database = { revisions: [], operations: [], legacy: [] },
  actorReference = id(3),
) {
  const fixed = { ...scope, actorReference };
  let now = at,
    next = 100 + database.revisions.length * 10 + database.operations.length * 10,
    denied = false,
    lease = until,
    clockUnavailable = false;
  const guards: { guard: () => Promise<void>; final: () => void }[] = [],
    events: string[] = [],
    audits: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    if (
      sql.startsWith("SELECT set_config") ||
      sql.startsWith("SELECT pg_advisory") ||
      sql.startsWith("LOCK TABLE") ||
      sql.startsWith("SET CONSTRAINTS")
    )
      return { rows: [] };
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("FROM bop_tenant.brand WHERE"))
      return {
        rows: [
          {
            brand_id: id(2),
            lifecycle: database.lifecycle ?? "Active",
            version: "1",
            updated_at: at,
            precise: true,
          },
        ],
      };
    return dispatch(sql, values);
  });
  function dispatch(sql: string, values: readonly unknown[]): unknown {
    if (sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_revision")) {
      events.push("revision");
      const keys = [
        "tenant_id",
        "brand_id",
        "revision",
        "brand_version",
        "configuration_version_id",
        "configuration_version",
        "command_type",
        "operation_id",
        "actor_id",
        "audit_id",
        "content_digest",
        "source_digest",
        "snapshot_json",
        "created_at",
        "recorded_at",
      ];
      const row: Record<string, unknown> = {
        data_classification: "ConfigurationMetadata",
        precise: true,
      };
      keys.forEach((key, index) => {
        row[key] = ["revision", "brand_version", "configuration_version"].includes(key)
          ? String(values[index])
          : key === "snapshot_json"
            ? JSON.parse(String(values[index]))
            : values[index];
      });
      database.revisions.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_operation")) {
      events.push("terminal");
      const keys = [
        "operation_id",
        "tenant_id",
        "brand_id",
        "actor_id",
        "command_type",
        "expected_brand_version",
        "expected_revision",
        "expected_configuration_version_id",
        "expected_source_digest",
        "intent_digest",
        "outcome",
        "result_revision",
        "result_configuration_version_id",
        "result_source_digest",
        "command_json",
        "receipt_json",
        "audit_id",
        "occurred_at",
      ];
      const row: Record<string, unknown> = {
        data_classification: "ConfigurationMetadata",
        precise: true,
      };
      keys.forEach((key, index) => {
        row[key] = ["expected_brand_version", "expected_revision", "result_revision"].includes(key)
          ? values[index] === null
            ? null
            : String(values[index])
          : ["command_json", "receipt_json"].includes(key)
            ? values[index] === null
              ? null
              : JSON.parse(String(values[index]))
            : values[index];
      });
      if (database.operations.some((row) => row.operation_id === values[0]))
        throw new Error("Controlled global terminal collision");
      database.operations.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO bop_tenant.brand_configuration_version")) {
      events.push("published");
      const keys = [
        "configuration_version_id",
        "brand_id",
        "configuration_version",
        "lifecycle",
        "default_locale",
        "supported_locales",
        "media_theme_reference",
        "catalog_source_reference",
        "platform_template_reference",
        "override_allowed_field_codes",
        "hard_requirement_field_codes",
        "effective_from",
        "effective_until",
        "supersedes_version_reference",
        "reason_code",
        "authored_by_reference",
        "approved_by_reference",
        "approval_evidence_reference",
        "publication_reference",
        "created_at",
        "updated_at",
        "data_classification",
      ];
      const row: Record<string, unknown> = { precise: true };
      keys.forEach((key, index) => {
        row[key] = key === "configuration_version" ? String(values[index]) : values[index];
      });
      database.legacy.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM bop_tenant.brand_configuration_authoring_operation"))
      return {
        rows: database.operations.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.operation_id === values[2],
        ),
      };
    if (sql.includes("FROM bop_tenant.brand_configuration_authoring_revision")) {
      let found = database.revisions.filter(
        (row) => row.tenant_id === values[0] && row.brand_id === values[1],
      );
      if (sql.includes("AND operation_id="))
        found = found.filter(
          (row) => row.revision === String(values[2]) && row.operation_id === values[3],
        );
      else if (sql.includes("LIMIT 3"))
        found = found.filter(
          (row) => values[2] === null || Number(row.revision) < Number(values[2]),
        );
      found.sort((a, b) => Number(b.revision) - Number(a.revision));
      return { rows: found.slice(0, sql.includes("LIMIT 3") ? 3 : 1) };
    }
    if (sql.includes("FROM bop_tenant.brand_configuration_version")) {
      let found = database.legacy.filter((row) => row.brand_id === values[0]);
      if (sql.includes("AND configuration_version_id="))
        found = found.filter((row) => row.configuration_version_id === values[1]);
      found.sort((a, b) => Number(b.configuration_version) - Number(a.configuration_version));
      return { rows: found.slice(0, 1) };
    }
    throw new Error(`Unexpected controlled query ${sql.slice(0, 90)} ${values.length}`);
  }
  const hold = vi.fn(
    async (
      actual: BrandConfigurationAuthoringTransaction,
      input: Parameters<
        BrandConfigurationAuthoringStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1],
    ) => {
      expect(actual).toBe(tx);
      expect(input.permission).toBe("organization.manage");
      expect(input.purposeCode).toBe("BRAND_CONFIGURATION");
      if (denied) throw new Error("Controlled authority denied");
      return { validUntil: lease };
    },
  );
  const prepare = vi.fn<BrandConfigurationAuthoringStoreOptions["prepareFresh"]>(
    async (actual, input) => {
      expect(actual).toBe(tx);
      events.push("prepare");
      if (input.command.command === "SaveConfigurationDraft")
        return {
          configuration: input.configuration,
          submittedByReference: null,
          publishing: null,
          occurredAt: now,
        };
      const current = input.current;
      if (!current) throw new Error("Missing controlled current");
      const action = input.command.command;
      const publishing = {
        familyReference: current.publishing?.familyReference ?? id(201),
        lifecycleReference: current.publishing?.lifecycleReference ?? id(202),
        lifecycleVersion: (current.publishing?.lifecycleVersion ?? 1) + 1,
        mutationOperationReference: input.command.operationReference,
        validationEvidenceReference: current.publishing?.validationEvidenceReference ?? id(203),
        approvalEvidenceReference:
          action === "SubmitConfiguration"
            ? null
            : (current.publishing?.approvalEvidenceReference ?? id(204)),
        publicationReference: action === "PublishConfiguration" ? id(205) : null,
      };
      return {
        configuration: createBrandConfigurationVersion({
          ...input.configuration,
          lifecycle:
            action === "SubmitConfiguration"
              ? "PendingApproval"
              : action === "ApproveConfiguration"
                ? "Approved"
                : "Published",
          updatedAt: now,
          approvedByReference:
            action === "SubmitConfiguration"
              ? null
              : (input.configuration.approvedByReference ?? actorReference),
          approvalEvidenceReference: publishing.approvalEvidenceReference,
          publicationReference: publishing.publicationReference,
        }),
        submittedByReference:
          action === "SubmitConfiguration" ? actorReference : current.submittedByReference,
        publishing,
        occurredAt: now,
      };
    },
  );
  const tx: BrandConfigurationAuthoringTransaction = { query };
  const options: BrandConfigurationAuthoringStoreOptions = {
    ...fixed,
    transaction: tx,
    clock: {
      now: () => {
        if (clockUnavailable) throw new Error("Controlled clock unavailable after COMMIT");
        return now;
      },
    },
    originalObservedAt: at,
    originalValidUntil: until,
    registerBeforeCommit: async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
    authority: { holdUntilTransactionCompletes: hold },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      audits.push(input);
      events.push("audit");
    },
    prepareFresh: prepare,
  };
  const source = createPostgresBrandConfigurationAuthoringStore(options);
  return {
    source,
    options,
    tx,
    query,
    prepare,
    hold,
    database,
    events,
    audits,
    guards,
    setNow: (value: string) => {
      now = value;
    },
    throwClock: () => {
      clockUnavailable = true;
    },
    deny: () => {
      denied = true;
    },
    shorten: (value: string) => {
      lease = value;
    },
    finish: async () => {
      for (const entry of guards) await entry.guard();
      for (const entry of guards) entry.final();
      return source.assertFinalized();
    },
  };
}
const original = (
  receipt: Awaited<
    ReturnType<ReturnType<typeof createPostgresBrandConfigurationAuthoringStore>["execute"]>
  >,
) => ({
  profile: "TenantBrandConfigurationResolveV1",
  tenantReference: receipt.tenantReference,
  brandReference: receipt.brandReference,
  actorReference: receipt.actorReference,
  command: receipt.command,
  operationReference: receipt.operationReference,
  expectedBrandVersion: receipt.expectedBrandVersion,
  expectedHead: receipt.expectedHead,
  purposeCode: receipt.purposeCode,
  intentDigest: receipt.intentDigest,
});
const stage = (
  receipt: Awaited<
    ReturnType<ReturnType<typeof createPostgresBrandConfigurationAuthoringStore>["execute"]>
  >,
  command: string,
  operation: number,
  actor = id(3),
) => {
  const snapshot = receipt.snapshot;
  if (!snapshot) throw new Error("Missing controlled snapshot");
  return request({
    actorReference: actor,
    command,
    reviewValidUntil: command === "SubmitConfiguration" ? "2026-10-06T11:00:00.000Z" : null,
    operationReference: id(operation),
    configuration: null,
    expectedHead: {
      revision: snapshot.revision,
      configurationVersionReference: snapshot.configuration.configurationVersionReference,
      sourceDigest: snapshot.sourceDigest,
    },
  });
};
function legacy(version = 7, reference = id(77)) {
  const configuration = createBrandConfigurationVersion({
    configurationVersionReference: reference,
    brandReference: id(2),
    configurationVersion: version,
    lifecycle: "Published",
    ...fields(),
    supersedesVersionReference: id(76),
    authoredByReference: id(70),
    approvedByReference: id(71),
    approvalEvidenceReference: id(72),
    publicationReference: id(73),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  return {
    configuration_version_id: configuration.configurationVersionReference,
    brand_id: configuration.brandReference,
    configuration_version: String(configuration.configurationVersion),
    lifecycle: configuration.lifecycle,
    default_locale: configuration.defaultLocale,
    supported_locales: configuration.supportedLocales,
    media_theme_reference: configuration.mediaThemeReference,
    catalog_source_reference: configuration.catalogSourceReference,
    platform_template_reference: configuration.platformTemplateReference,
    override_allowed_field_codes: configuration.overrideAllowedFieldCodes,
    hard_requirement_field_codes: configuration.hardRequirementFieldCodes,
    effective_from: configuration.effectiveFrom,
    effective_until: configuration.effectiveUntil,
    supersedes_version_reference: configuration.supersedesVersionReference,
    reason_code: configuration.reasonCode,
    authored_by_reference: configuration.authoredByReference,
    approved_by_reference: configuration.approvedByReference,
    approval_evidence_reference: configuration.approvalEvidenceReference,
    publication_reference: configuration.publicationReference,
    created_at: configuration.createdAt,
    updated_at: configuration.updatedAt,
    data_classification: configuration.dataClassification,
    precise: true,
  };
}
describe("held Brand configuration authoring owner (controlled Core boundary, not native qualification)", () => {
  it("arbitrates original then head before allocations and real preparation", async () => {
    const f = fixture();
    const result = await f.source.execute(request());
    expect(result.snapshot?.configuration.configurationVersion).toBe(1);
    expect(f.events).toEqual(["prepare", "audit", "revision", "terminal"]);
    expect(f.database.legacy).toHaveLength(0);
    const sql = f.query.mock.calls.map((call) => call[0]);
    expect(
      sql.findIndex((text) => text.includes("brand_configuration_authoring_operation WHERE")),
    ).toBeLessThan(sql.findIndex((text) => text.includes("ORDER BY revision DESC")));
    expect(sql.findIndex((text) => text.includes("BrandConfigurationOriginal"))).toBe(-1);
    const locks = f.query.mock.calls.filter((call) => call[0].includes("pg_advisory"));
    expect(locks[0]?.[1]).toEqual([`BrandConfigurationOriginal:${id(10)}`]);
    expect(locks[1]?.[1]).toEqual([`BrandConfigurationSource:${id(1)}:${id(2)}`]);
    await f.finish();
  });
  it("replays and resolves exact stored result without preparing or allocating again", async () => {
    const first = fixture(),
      result = await first.source.execute(request());
    await first.finish();
    const again = fixture(first.database);
    expect(await again.source.execute(request())).toEqual(result);
    expect(again.prepare).not.toHaveBeenCalled();
    expect(again.options.references.nextReference).not.toHaveBeenCalled();
    expect(again.audits).toHaveLength(0);
    await again.finish();
    const recovered = fixture(first.database);
    expect(await recovered.source.resolve(original(result))).toEqual(result);
    await recovered.finish();
  });
  it("creates true durable Abandoned and refuses a late writer producer", async () => {
    const f = fixture();
    const command = request();
    const cursor = {
      ...original({
        profile: "TenantBrandConfigurationOperationV1",
        ...scope,
        command: command.command,
        operationReference: command.operationReference,
        expectedBrandVersion: 1,
        expectedHead: null,
        purposeCode: "BRAND_CONFIGURATION",
        intentDigest: hash(canonical(command)),
        originalCommand: null,
        outcome: "Abandoned",
        snapshot: null,
        auditReference: id(50),
        occurredAt: at,
        dataClassification: "ConfigurationMetadata",
      }),
    };
    const result = await f.source.resolve(cursor);
    expect(result.outcome).toBe("Abandoned");
    expect(f.database.revisions).toHaveLength(0);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(1);
    await f.finish();
    const later = fixture(f.database);
    expect(await later.source.execute(command)).toEqual(result);
    expect(later.prepare).not.toHaveBeenCalled();
    await later.finish();
  });
  it("binds original Actor and intent despite same operation id", async () => {
    const f = fixture();
    const saved = await f.source.execute(request());
    await f.finish();
    const changed = fixture(f.database);
    await expect(
      changed.source.execute(request({ configuration: { ...fields(), reasonCode: "CHANGED" } })),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT" });
    const foreign = fixture(f.database, id(90));
    await expect(
      foreign.source.resolve({ ...original(saved), actorReference: id(90) }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_PERMISSION_DENIED" });
  });
  it("rejects head CAS before preparation or IDs", async () => {
    const f = fixture();
    const saved = await f.source.execute(request());
    await f.finish();
    const changed = fixture(f.database);
    await expect(
      changed.source.execute(request({ operationReference: id(20) })),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
    expect(changed.prepare).not.toHaveBeenCalled();
    expect(changed.options.references.nextReference).not.toHaveBeenCalled();
    const stale = fixture(f.database);
    await expect(
      stale.source.execute({
        ...stage(saved, "SubmitConfiguration", 21),
        expectedHead: {
          revision: 1,
          configurationVersionReference: id(999),
          sourceDigest: saved.snapshot?.sourceDigest,
        },
      }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
  });
  it("records independent approval and actual published envelope only at Publish", async () => {
    const draft = fixture(),
      saved = await draft.source.execute(request());
    await draft.finish();
    const submit = fixture(draft.database),
      submitted = await submit.source.execute(stage(saved, "SubmitConfiguration", 30));
    await submit.finish();
    expect(submit.database.legacy).toHaveLength(0);
    const same = fixture(draft.database);
    await expect(
      same.source.execute(stage(submitted, "ApproveConfiguration", 31)),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_PERMISSION_DENIED" });
    const approve = fixture(draft.database, id(90)),
      approved = await approve.source.execute(stage(submitted, "ApproveConfiguration", 32, id(90)));
    await approve.finish();
    const publish = fixture(draft.database, id(90)),
      published = await publish.source.execute(stage(approved, "PublishConfiguration", 33, id(90)));
    expect(published.snapshot?.configuration.lifecycle).toBe("Published");
    expect(published.snapshot?.configuration.configurationVersionReference).toBe(
      saved.snapshot?.configuration.configurationVersionReference,
    );
    expect(publish.database.legacy).toHaveLength(1);
    expect(publish.events).toContain("published");
    await publish.finish();
  });
  it("rejects submitter self approval even when author differs", async () => {
    const f = fixture(),
      saved = await f.source.execute(request());
    await f.finish();
    const submit = fixture(f.database, id(80)),
      submitted = await submit.source.execute(stage(saved, "SubmitConfiguration", 40, id(80)));
    await submit.finish();
    const bad = fixture(f.database, id(80));
    await expect(
      bad.source.execute(stage(submitted, "ApproveConfiguration", 41, id(80))),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_PERMISSION_DENIED" });
    expect(bad.prepare).not.toHaveBeenCalled();
  });
  it("rejects prepared semantic or Core lineage drift before owning append", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(async (_tx, input) => ({
      configuration: {
        ...input.configuration,
        defaultLocale: "fr-CA",
        supportedLocales: ["fr-CA"],
      },
      submittedByReference: null,
      publishing: null,
      occurredAt: at,
    }));
    await expect(f.source.execute(request())).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_VERSION_CONFLICT",
    });
    expect(f.audits).toHaveLength(0);
    expect(f.database.revisions).toHaveLength(0);
  });
  it("allows current/history reader different from original author and paginates exact two", async () => {
    const f = fixture(),
      saved = await f.source.execute(request());
    await f.finish();
    const sub = fixture(f.database),
      submitted = await sub.source.execute(stage(saved, "SubmitConfiguration", 50));
    await sub.finish();
    const app = fixture(f.database, id(90));
    await app.source.execute(stage(submitted, "ApproveConfiguration", 51, id(90)));
    await app.finish();
    const reader = fixture(f.database, id(91));
    const current = await reader.source.readCurrent();
    expect(current.actorReference).toBe(id(91));
    expect(current.current?.actorReference).toBe(id(90));
    const page = await reader.source.readHistory({ beforeRevision: null });
    expect(page.entries.map((entry) => entry.revision)).toEqual([3, 2]);
    expect(page.nextBeforeRevision).toBe(2);
    const next = await reader.source.readHistory({ beforeRevision: 2 });
    expect(next.entries.map((entry) => entry.revision)).toEqual([1]);
    expect(next.nextBeforeRevision).toBeNull();
    await reader.finish();
  });
  it("refuses malformed source hashes and raw submillisecond timestamps", async () => {
    const f = fixture();
    await f.source.execute(request());
    await f.finish();
    const row = f.database.revisions[0];
    if (!row) throw new Error("Missing controlled row");
    row.precise = false;
    const reader = fixture(f.database);
    await expect(reader.source.readCurrent()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("retains shortest real authority lease and rejects late withdrawal", async () => {
    const f = fixture();
    f.shorten("2026-10-06T10:00:01.000Z");
    await f.source.execute(request());
    expect(await f.finish()).toBe("2026-10-06T10:00:01.000Z");
    const late = fixture();
    await late.source.execute(request());
    late.deny();
    await expect(late.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(() => late.source.assertFinalized()).toThrow();
  });
  it("poisons clock regression, expiry, captured port replacement and premature final", async () => {
    const f = fixture();
    await f.source.readCurrent();
    f.setNow(until);
    await expect(f.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    const changed = fixture();
    await changed.source.readCurrent();
    changed.options.clock.now = () => at;
    await expect(changed.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    const premature = fixture();
    await premature.source.readCurrent();
    expect(() => premature.guards[0]?.final()).toThrow();
  });
  it("keeps the postCOMMIT assertion pure after final seal when the clock expires or throws", async () => {
    const f = fixture();
    await f.source.readCurrent();
    await f.finish();
    const queries = f.query.mock.calls.length,
      admissions = f.hold.mock.calls.length;
    f.setNow(until);
    expect(f.source.assertFinalized()).toBe(until);
    f.throwClock();
    expect(f.source.assertFinalized()).toBe(until);
    expect(f.query).toHaveBeenCalledTimes(queries);
    expect(f.hold).toHaveBeenCalledTimes(admissions);
  });
  it("retains the last original lease seal before COMMIT and rejects poisoned protocol state", async () => {
    const late = fixture();
    await late.source.readCurrent();
    for (const entry of late.guards) await entry.guard();
    late.setNow(until);
    expect(() => late.guards[0]?.final()).toThrowError(
      expect.objectContaining({
        code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      }),
    );
    expect(() => late.source.assertFinalized()).toThrow();
    const poisoned = fixture();
    await poisoned.source.readCurrent();
    await poisoned.finish();
    await expect(poisoned.source.readCurrent()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(() => poisoned.source.assertFinalized()).toThrow();
  });
  it("compares retained page and head in final guard", async () => {
    const f = fixture();
    await f.source.execute(request());
    await f.finish();
    const reader = fixture(f.database);
    await reader.source.readCurrent();
    const row = f.database.revisions[0];
    if (!row) throw new Error("Missing row");
    row.source_digest = "sha256:" + "0".repeat(64);
    await expect(reader.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("requires strict single execution", async () => {
    const f = fixture();
    let entered = false;
    f.prepare.mockImplementationOnce(async () => {
      entered = true;
      await f.source.readCurrent();
      throw new Error("Unexpected after reentry");
    });
    await expect(f.source.execute(request())).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(entered).toBe(true);
    expect(f.audits).toHaveLength(0);
  });
});

describe("actual legacy owning basis", () => {
  it("continues genuine legacy v7 as v8 without fabricating governance history", async () => {
    const db: Database = { revisions: [], operations: [], legacy: [legacy()] };
    const f = fixture(db);
    const result = await f.source.execute(request());
    expect(result.snapshot?.revision).toBe(1);
    expect(result.snapshot?.configuration.configurationVersion).toBe(8);
    expect(result.snapshot?.configuration.supersedesVersionReference).toBe(id(77));
    expect(db.legacy).toHaveLength(1);
    expect(db.legacy[0]?.configuration_version).toBe("7");
    await f.finish();
  });
  it("refuses a newer legacy basis than retained governance before allocation", async () => {
    const f = fixture();
    const result = await f.source.execute(request());
    await f.finish();
    f.database.legacy.push(legacy());
    const replacement = fixture(f.database);
    const head = result.snapshot;
    if (!head) throw new Error("Missing head");
    await expect(
      replacement.source.execute(
        request({
          operationReference: id(61),
          expectedHead: {
            revision: head.revision,
            configurationVersionReference: head.configuration.configurationVersionReference,
            sourceDigest: head.sourceDigest,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
    expect(replacement.prepare).not.toHaveBeenCalled();
    expect(replacement.options.references.nextReference).not.toHaveBeenCalled();
  });
  it("rejects final drift of the exact legacy max basis", async () => {
    const f = fixture({ revisions: [], operations: [], legacy: [legacy()] });
    await f.source.execute(request());
    f.database.legacy.push(legacy(9, id(79)));
    await expect(f.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_VERSION_CONFLICT",
    });
  });
});

describe("existing Brand lifecycle admission", () => {
  it.each(["Draft", "Suspended"])("keeps nonArchived %s Brand Save usable", async (lifecycle) => {
    const f = fixture({ revisions: [], operations: [], legacy: [], lifecycle });
    expect((await f.source.execute(request())).outcome).toBe("Committed");
    await f.finish();
  });
  it("refuses fresh Archived Save before IDs or preparation", async () => {
    const f = fixture({ revisions: [], operations: [], legacy: [], lifecycle: "Archived" });
    await expect(f.source.execute(request())).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_VERSION_CONFLICT",
    });
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
describe("bounded counterfeit sources and callback drift", () => {
  it("rejects malformed terminal instead of accepting the revision alone", async () => {
    const f = fixture();
    await f.source.execute(request());
    await f.finish();
    const row = f.database.operations[0];
    if (!row) throw new Error("Missing terminal");
    row.command_json = null;
    const reader = fixture(f.database, id(90));
    await expect(reader.source.readCurrent()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects prepared getters without executing them", async () => {
    const f = fixture();
    let reads = 0;
    f.prepare.mockImplementationOnce(async (_tx, input) => {
      const packet = {
        configuration: input.configuration,
        submittedByReference: null,
        publishing: null,
        occurredAt: at,
      };
      Object.defineProperty(packet, "occurredAt", {
        enumerable: true,
        get() {
          reads++;
          return at;
        },
      });
      return packet;
    });
    await expect(f.source.execute(request())).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(reads).toBe(0);
    expect(f.audits).toHaveLength(0);
  });
  it("detects captured query replacement during fresh preparation", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(async (_tx, input) => {
      f.tx.query = async () => ({ rows: [] });
      return {
        configuration: input.configuration,
        submittedByReference: null,
        publishing: null,
        occurredAt: at,
      };
    });
    await expect(f.source.execute(request())).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.audits).toHaveLength(0);
  });
  it("refuses two different owning identities at the same configuration version", async () => {
    const f = fixture({ revisions: [], operations: [], legacy: [legacy()] });
    const result = await f.source.execute(request());
    await f.finish();
    f.database.legacy.push(legacy(8, id(88)));
    const head = result.snapshot;
    if (!head) throw new Error("Missing head");
    const next = fixture(f.database);
    await expect(
      next.source.execute(
        request({
          operationReference: id(89),
          expectedHead: {
            revision: head.revision,
            configurationVersionReference: head.configuration.configurationVersionReference,
            sourceDigest: head.sourceDigest,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
    expect(next.options.references.nextReference).not.toHaveBeenCalled();
  });
});

describe("real advancing preparation time", () => {
  it("preserves allocated configuration creation time while recording after actual awaited preparation", async () => {
    const f = fixture();
    const later = "2026-10-06T10:00:01.000Z";
    f.prepare.mockImplementationOnce(async (_tx, input) => {
      expect(input.configuration.createdAt).toBe(at);
      f.setNow(later);
      return {
        configuration: createBrandConfigurationVersion({
          ...input.configuration,
          updatedAt: later,
        }),
        submittedByReference: null,
        publishing: null,
        occurredAt: later,
      };
    });
    const receipt = await f.source.execute(request());
    expect(receipt.snapshot?.configuration.createdAt).toBe(at);
    expect(receipt.snapshot?.configuration.updatedAt).toBe(later);
    expect(receipt.snapshot?.createdAt).toBe(later);
    expect(receipt.snapshot?.recordedAt).toBe(later);
    await f.finish();
  });
});

describe("explicit finite business review bounds", () => {
  it("accepts a future caller intent bound independent of the authorization lease", async () => {
    const f = fixture(),
      saved = await f.source.execute(request());
    await f.finish();
    const submit = fixture(f.database);
    const command = stage(saved, "SubmitConfiguration", 801);
    const result = await submit.source.execute(command);
    expect(result.originalCommand?.reviewValidUntil).toBe("2026-10-06T11:00:00.000Z");
    expect(await submit.finish()).toBe(until);
  });
  it.each([at, "2026-10-06T09:00:00.000Z"])(
    "refuses expired bound %s before preparation",
    async (reviewValidUntil) => {
      const f = fixture(),
        saved = await f.source.execute(request());
      await f.finish();
      const submit = fixture(f.database);
      await expect(
        submit.source.execute({ ...stage(saved, "SubmitConfiguration", 802), reviewValidUntil }),
      ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
      expect(submit.prepare).not.toHaveBeenCalled();
      expect(submit.options.references.nextReference).not.toHaveBeenCalled();
    },
  );
  it("clamps the requested business bound to the actual configuration effective end", async () => {
    const f = fixture(),
      saved = await f.source.execute(
        request({ configuration: { ...fields(), effectiveUntil: "2026-10-06T10:00:10.000Z" } }),
      );
    await f.finish();
    const invalid = fixture(f.database);
    await expect(
      invalid.source.execute({
        ...stage(saved, "SubmitConfiguration", 803),
        reviewValidUntil: "2026-10-06T10:00:10.001Z",
      }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
    expect(invalid.prepare).not.toHaveBeenCalled();
    const valid = fixture(f.database);
    const result = await valid.source.execute({
      ...stage(saved, "SubmitConfiguration", 804),
      reviewValidUntil: "2026-10-06T10:00:10.000Z",
    });
    expect(result.outcome).toBe("Committed");
    await valid.finish();
  });
  it("rejects expiry during awaited preparation and in the final host guard", async () => {
    const f = fixture(),
      saved = await f.source.execute(request());
    await f.finish();
    const submit = fixture(f.database),
      command = {
        ...stage(saved, "SubmitConfiguration", 805),
        reviewValidUntil: "2026-10-06T10:00:02.000Z",
      };
    const result = await submit.source.execute(command);
    expect(result.outcome).toBe("Committed");
    submit.setNow(command.reviewValidUntil);
    await expect(submit.finish()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_VERSION_CONFLICT",
    });
    const newSave = fixture();
    const newDraft = await newSave.source.execute(request());
    await newSave.finish();
    const callback = fixture(newSave.database);
    const ordinary = callback.prepare.getMockImplementation();
    if (!ordinary) throw new Error("Missing controlled preparation");
    callback.prepare.mockImplementationOnce(async (tx, input) => {
      const result = await ordinary(tx, input);
      callback.setNow("2026-10-06T10:00:02.000Z");
      return result;
    });
    await expect(
      callback.source.execute({
        ...stage(newDraft, "SubmitConfiguration", 806),
        reviewValidUntil: "2026-10-06T10:00:02.000Z",
      }),
    ).rejects.toMatchObject({ code: "BRAND_CONFIGURATION_VERSION_CONFLICT" });
    expect(callback.audits).toHaveLength(0);
  });
  it("replays the exact committed Submit after business expiry without renewing or preparing", async () => {
    const f = fixture(),
      saved = await f.source.execute(request());
    await f.finish();
    const submit = fixture(f.database),
      command = {
        ...stage(saved, "SubmitConfiguration", 807),
        reviewValidUntil: "2026-10-06T10:00:02.000Z",
      };
    const receipt = await submit.source.execute(command);
    await submit.finish();
    const replay = fixture(f.database);
    replay.setNow("2026-10-06T10:00:03.000Z");
    expect(await replay.source.execute(command)).toEqual(receipt);
    expect(replay.prepare).not.toHaveBeenCalled();
    expect(replay.options.references.nextReference).not.toHaveBeenCalled();
    await replay.finish();
    const resolve = fixture(f.database);
    resolve.setNow("2026-10-06T10:00:03.000Z");
    expect(await resolve.source.resolve(original(receipt))).toEqual(receipt);
    await resolve.finish();
  });
});
