import { describe, expect, it } from "vitest";
import {
  createBrand,
  parseCanonicalInstant,
  transitionBrand,
  type Brand,
} from "../domain/brand-store.js";
import { parseBrandAdministrationReference } from "../contracts/brand-administration.js";
import type {
  BrandAdministrationOperation,
  BrandAdministrationPorts,
} from "../application/ports/brand-administration-ports.js";
import {
  createPostgresBrandInitialCreationStore,
  createPostgresBrandLifecycleAdministrationStore,
  createPostgresBrandLifecycleStore,
  type BrandInitialCreationBinding,
  type BrandInitialCreationStoreOptions,
  type BrandLifecycleTransaction,
} from "../infrastructure/persistence/brand-lifecycle-store.js";

const id = (n: number) =>
  parseBrandAdministrationReference(`019d1000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = parseCanonicalInstant("2026-10-06T10:00:00.000Z"),
  later = parseCanonicalInstant("2026-10-06T10:01:00.000Z");
const draft = createBrand({
  brandReference: id(1),
  code: "INITIAL",
  displayName: "Controlled initial Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Draft",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const binding: BrandInitialCreationBinding = {
  operationReference: id(2),
  intentDigest: `sha256:${"a".repeat(64)}`,
  actorReference: id(3),
  auditReference: id(4),
};
type Commit = Parameters<BrandAdministrationPorts["repository"]["commit"]>[0];
function command(
  artifact = draft,
  kind: BrandAdministrationOperation["command"] = "CreateBrand",
  operationReference = id(2),
): Commit {
  return {
    operation: {
      command: kind,
      operationReference,
      brandReference: artifact.brandReference,
      intentDigest: binding.intentDigest,
      brandVersion: artifact.version,
      artifact,
    },
    expectedBrandVersion: artifact.version - 1,
    audit: {
      actorReference: id(3),
      purposeCode: "BRAND_INITIAL_PROVISIONING",
      auditReference: id(4),
      occurredAt: artifact.updatedAt,
    },
  };
}
function stored(input = command()): Record<string, unknown> {
  return {
    operation_id: input.operation.operationReference,
    brand_id: input.operation.brandReference,
    command_type: input.operation.command,
    intent_digest: input.operation.intentDigest,
    brand_version: String(input.operation.brandVersion),
    actor_reference: input.audit.actorReference,
    purpose_code: input.audit.purposeCode,
    audit_reference: input.audit.auditReference,
    occurred_at: input.audit.occurredAt,
    data_classification: "ConfigurationMetadata",
    artifact_snapshot_json: input.operation.artifact,
    precise: true,
  };
}
// Controlled SQL transport exercises both owning facades. Actual PostgreSQL,
// cross-owner rollback and minimum-role evidence belong to the native journey.
function fixture() {
  let current: Brand | null = null;
  const originals = new Map<string, Record<string, unknown>>(),
    calls: string[] = [],
    lockKeys: unknown[] = [],
    audits: Commit[] = [];
  const control = {
    allow: true,
    auditFailure: false,
    afterAudit: (): void => undefined,
    beforeAuthorize: (): void => undefined,
    response: (_sql: string, value: unknown): unknown => value,
  };
  const tx: BrandLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) lockKeys.push(values[0]);
      let rows: readonly unknown[] = [],
        rowCount: number | null = 0;
      if (sql.includes("FROM bop_tenant.brand_admin_operation")) {
        const row = originals.get(String(values[1]));
        rows = row ? [row] : [];
      } else if (sql.includes("FROM bop_tenant.brand WHERE")) {
        rows = current
          ? [
              {
                brand_id: current.brandReference,
                code: current.code,
                display_name: current.displayName,
                default_locale: current.defaultLocale,
                currency_code: current.currencyCode,
                lifecycle: current.lifecycle,
                version: String(current.version),
                created_at: sql.includes("AS precise")
                  ? current.createdAt
                  : new Date(current.createdAt),
                updated_at: sql.includes("AS precise")
                  ? current.updatedAt
                  : new Date(current.updatedAt),
                ...(sql.includes("AS precise") ? { precise: true } : {}),
              },
            ]
          : [];
      } else if (sql.startsWith("INSERT INTO bop_tenant.brand(")) {
        current = createBrand({
          brandReference: values[0],
          code: values[1],
          displayName: values[2],
          defaultLocale: values[3],
          currencyCode: values[4],
          lifecycle: values[5],
          version: values[6],
          createdAt: values[7],
          updatedAt: values[8],
        });
        rowCount = 1;
      } else if (sql.startsWith("UPDATE bop_tenant.brand SET")) {
        if (current?.version === values[1]) {
          current = createBrand({
            ...current,
            lifecycle: values[2],
            version: values[3],
            updatedAt: values[4],
          });
          rowCount = 1;
        }
      } else if (sql.startsWith("INSERT INTO bop_tenant.brand_admin_operation")) {
        originals.set(String(values[0]), {
          operation_id: values[0],
          brand_id: values[1],
          command_type: values[2],
          intent_digest: values[3],
          brand_version: String(values[4]),
          actor_reference: values[5],
          purpose_code: values[6],
          audit_reference: values[7],
          occurred_at: values[8],
          data_classification: "ConfigurationMetadata",
          artifact_snapshot_json: JSON.parse(String(values[9])),
          precise: true,
        });
        rowCount = 1;
      } else if (
        !sql.includes("set_config") &&
        !sql.includes("pg_advisory_xact_lock") &&
        !sql.startsWith("SAVEPOINT") &&
        !sql.startsWith("RELEASE SAVEPOINT") &&
        !sql.startsWith("ROLLBACK TO SAVEPOINT")
      ) {
        throw new Error("Unexpected controlled lifecycle SQL");
      }
      return control.response(sql, { rows, rowCount }) as {
        rows: readonly Row[];
        rowCount: number | null;
      };
    },
  };
  const options: BrandInitialCreationStoreOptions = {
    brandReference: String(draft.brandReference),
    binding: { ...binding },
    transactions: {
      async run(work) {
        const oldCurrent = current,
          oldOriginals = new Map(originals),
          oldAuditCount = audits.length;
        try {
          return await work(tx);
        } catch (error) {
          current = oldCurrent;
          originals.clear();
          for (const [id, row] of oldOriginals) originals.set(id, row);
          audits.length = oldAuditCount;
          throw error;
        }
      },
    },
    authorize: async (actual) => {
      expect(actual).toBe(tx);
      control.beforeAuthorize();
      return control.allow;
    },
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      audits.push(input);
      control.afterAudit();
      if (control.auditFailure) throw new Error("Controlled Audit failure");
    },
  };
  return {
    options,
    tx,
    originals,
    calls,
    lockKeys,
    audits,
    control,
    initial: () => createPostgresBrandInitialCreationStore(options),
    generic: () => createPostgresBrandLifecycleStore(options),
    administration: (actorReference: string = id(3)) =>
      createPostgresBrandLifecycleAdministrationStore({
        ...options,
        binding: { actorReference, purposeCode: "BRAND_ADMINISTRATION" },
      }),
    current: () => current,
    setCurrent: (value: Brand) => {
      current = value;
    },
  };
}
describe("initial Brand creation receipt facade", () => {
  it("creates only the bound Draft-v1 and reobserves its complete immutable receipt", async () => {
    const f = fixture(),
      store = f.initial(),
      input = command();
    expect(await store.resolveOperation(id(2))).toBeNull();
    expect(await store.commit(input)).toEqual(input.operation);
    expect(f.current()).toEqual(draft);
    expect(f.audits).toEqual([input]);
    expect(f.originals.get(id(2))).toEqual(stored());
    expect(
      f.calls.filter((sql) => sql.includes("FROM bop_tenant.brand_admin_operation")),
    ).toHaveLength(3);
    expect(
      f.calls.some((sql) => sql.includes("occurred_at=date_trunc('milliseconds',occurred_at)")),
    ).toBe(true);
  });
  it("returns the exact original after the current Brand changes without another insert or Audit", async () => {
    const f = fixture(),
      store = f.initial(),
      input = command();
    await store.commit(input);
    f.setCurrent(transitionBrand(draft, draft.version, "Active", later));
    expect(await store.loadBrand(draft.brandReference)).toEqual(f.current());
    expect(await store.resolveOperation(id(2))).toEqual(input.operation);
    expect(await store.commit(input)).toEqual(input.operation);
    expect(f.audits).toHaveLength(1);
    expect(f.originals.size).toBe(1);
    expect(f.calls.filter((sql) => sql.startsWith("INSERT INTO bop_tenant.brand("))).toHaveLength(
      1,
    );
  });
  it.each([
    ["actor_reference", id(20)],
    ["purpose_code", "ORDINARY_BRAND_ADMINISTRATION"],
    ["audit_reference", id(20)],
    ["intent_digest", `sha256:${"b".repeat(64)}`],
    ["command_type", "ActivateBrand"],
    ["operation_id", id(20)],
    ["brand_id", id(20)],
    ["brand_version", "2"],
    ["data_classification", "Internal"],
    ["precise", false],
    ["occurred_at", later],
  ])("refuses corrupted or foreign stored %s on resolve and replay", async (field, value) => {
    const f = fixture();
    f.originals.set(id(2), { ...stored(), [String(field)]: value });
    const store = f.initial();
    await expect(store.resolveOperation(id(2))).rejects.toThrow();
    await expect(store.commit(command())).rejects.toThrow();
    expect(f.audits).toEqual([]);
    expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });
  it.each(["null", "Active", "differentBrand", "version", "differentTimes"])(
    "rejects an inconsistent immutable artifact: %s",
    async (kind) => {
      const f = fixture();
      const artifact =
        kind === "null"
          ? null
          : {
              ...draft,
              ...(kind === "Active" ? { lifecycle: "Active" } : {}),
              ...(kind === "differentBrand" ? { brandReference: id(20) } : {}),
              ...(kind === "version" ? { version: 2 } : {}),
              ...(kind === "differentTimes" ? { updatedAt: later } : {}),
            };
      f.originals.set(id(2), { ...stored(), artifact_snapshot_json: artifact });
      await expect(f.initial().resolveOperation(id(2))).rejects.toThrow();
      expect(f.audits).toEqual([]);
    },
  );
  it("rejects a different requested operation before reading any original", async () => {
    const f = fixture();
    await expect(f.initial().resolveOperation(id(20))).rejects.toMatchObject({
      code: "BRAND_ADMIN_IDEMPOTENCY_CONFLICT",
    });
    expect(f.calls.some((sql) => sql.includes("brand_admin_operation"))).toBe(false);
  });
  it.each([
    "command",
    "expectedVersion",
    "operation",
    "digest",
    "actor",
    "purpose",
    "audit",
    "lifecycle",
    "version",
    "createdAt",
    "extra",
    "getter",
  ])("rejects invalid initial commit %s before transaction writes", async (kind) => {
    const f = fixture(),
      input = command();
    let invoked = false;
    const raw =
      kind === "command"
        ? { ...input, operation: { ...input.operation, command: "ArchiveBrand" } }
        : kind === "expectedVersion"
          ? { ...input, expectedBrandVersion: 1 }
          : kind === "operation"
            ? { ...input, operation: { ...input.operation, operationReference: id(20) } }
            : kind === "digest"
              ? {
                  ...input,
                  operation: { ...input.operation, intentDigest: `sha256:${"b".repeat(64)}` },
                }
              : kind === "actor"
                ? { ...input, audit: { ...input.audit, actorReference: id(20) } }
                : kind === "purpose"
                  ? { ...input, audit: { ...input.audit, purposeCode: "OTHER" } }
                  : kind === "audit"
                    ? { ...input, audit: { ...input.audit, auditReference: id(20) } }
                    : kind === "lifecycle"
                      ? {
                          ...input,
                          operation: {
                            ...input.operation,
                            artifact: { ...draft, lifecycle: "Active" },
                          },
                        }
                      : kind === "version"
                        ? {
                            ...input,
                            operation: {
                              ...input.operation,
                              brandVersion: 2,
                              artifact: { ...draft, version: 2 },
                            },
                          }
                        : kind === "createdAt"
                          ? {
                              ...input,
                              operation: {
                                ...input.operation,
                                artifact: { ...draft, updatedAt: later },
                              },
                              audit: { ...input.audit, occurredAt: later },
                            }
                          : kind === "extra"
                            ? { ...input, permission: "Allow" }
                            : Object.defineProperty({ ...input }, "audit", {
                                enumerable: true,
                                get() {
                                  invoked = true;
                                  return input.audit;
                                },
                              });
    await expect(f.initial().commit(raw as Commit)).rejects.toThrow();
    expect(invoked).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.current()).toBeNull();
  });
  it.each(["extra", "getter", "digest", "reference"])(
    "rejects invalid closed binding %s",
    (kind) => {
      const f = fixture();
      let invoked = false;
      const value =
        kind === "extra"
          ? { ...binding, purposeCode: "OTHER" }
          : kind === "digest"
            ? { ...binding, intentDigest: "unbound" }
            : kind === "reference"
              ? { ...binding, actorReference: "invalid" }
              : Object.defineProperty({ ...binding }, "actorReference", {
                  enumerable: true,
                  get() {
                    invoked = true;
                    return id(3);
                  },
                });
      expect(() =>
        createPostgresBrandInitialCreationStore({ ...f.options, binding: value }),
      ).toThrow();
      expect(invoked).toBe(false);
      expect(f.calls).toEqual([]);
    },
  );
  it("captures the closed binding so later caller mutation cannot substitute another original", async () => {
    const f = fixture(),
      store = f.initial();
    Object.assign(f.options.binding, {
      operationReference: id(20),
      actorReference: id(21),
      intentDigest: `sha256:${"b".repeat(64)}`,
    });
    await store.commit(command());
    expect(await store.resolveOperation(id(2))).toEqual(command().operation);
  });
  it.each(["actor_reference", "audit_reference", "purpose_code"])(
    "rereads %s after real append port completion before accepting commit",
    async (field) => {
      const f = fixture();
      f.control.afterAudit = () => {
        const row = f.originals.get(id(2));
        if (!row) throw new Error("Missing controlled original");
        row[field] = field === "purpose_code" ? "OTHER" : id(20);
      };
      await expect(f.initial().commit(command())).rejects.toThrow();
      expect(f.current()).toBeNull();
      expect(f.originals.size).toBe(0);
      expect(f.audits).toEqual([]);
    },
  );
  it.each(["getter", "sparse", "extra", "multiple"])(
    "refuses malformed stored row transport %s without invoking getters",
    async (kind) => {
      const f = fixture();
      f.originals.set(id(2), stored());
      let invoked = false;
      f.control.response = (sql, value) => {
        if (!sql.includes("FROM bop_tenant.brand_admin_operation")) return value;
        if (kind === "getter")
          return Object.defineProperty({}, "rows", {
            get() {
              invoked = true;
              return [stored()];
            },
          });
        if (kind === "sparse") return { rows: new Array(1) };
        if (kind === "multiple") return { rows: [stored(), stored()] };
        return { rows: [{ ...stored(), allow: true }] };
      };
      await expect(f.initial().resolveOperation(id(2))).rejects.toThrow();
      expect(invoked).toBe(false);
    },
  );
});
describe("unchanged generic Brand lifecycle kernel", () => {
  it("retains Create/Activate/Archive and exact original replay with ordinary purposes", async () => {
    const f = fixture(),
      store = f.generic();
    const first = command();
    const ordinary = { ...first, audit: { ...first.audit, purposeCode: "ORDINARY_LIFECYCLE" } };
    await store.commit(ordinary);
    const active = transitionBrand(draft, draft.version, "Active", later);
    await store.commit(command(active, "ActivateBrand", id(5)));
    const archived = transitionBrand(
      active,
      active.version,
      "Archived",
      "2026-10-06T10:02:00.000Z",
    );
    await store.commit(command(archived, "ArchiveBrand", id(6)));
    expect(await store.loadBrand(draft.brandReference)).toEqual(archived);
    expect(await store.resolveOperation(id(2))).toEqual(first.operation);
    expect(await store.commit(ordinary)).toEqual(first.operation);
    expect(f.audits).toHaveLength(3);
    expect(f.originals.size).toBe(3);
    expect(f.calls.some((sql) => sql.includes("occurred_at=date_trunc"))).toBe(false);
  });
  it.each(["denied", "audit", "lateDenied", "CAS", "intent"])(
    "retains generic %s refusal and transaction rollback",
    async (kind) => {
      const f = fixture(),
        store = f.generic();
      if (kind === "denied") f.control.allow = false;
      if (kind === "audit") f.control.auditFailure = true;
      if (kind === "lateDenied")
        f.control.afterAudit = () => {
          f.control.allow = false;
        };
      if (kind === "CAS" || kind === "intent") await store.commit(command());
      const input =
        kind === "CAS"
          ? { ...command(), operation: { ...command().operation, operationReference: id(20) } }
          : kind === "intent"
            ? {
                ...command(),
                operation: { ...command().operation, intentDigest: `sha256:${"b".repeat(64)}` },
              }
            : command();
      await expect(store.commit(input)).rejects.toThrow();
      expect(f.audits).toHaveLength(kind === "CAS" || kind === "intent" ? 1 : 0);
      expect(f.current()).toEqual(kind === "CAS" || kind === "intent" ? draft : null);
    },
  );
});

function administrativeCommand(
  artifact = transitionBrand(draft, draft.version, "Active", later),
  kind: "ActivateBrand" | "ArchiveBrand" = "ActivateBrand",
  operationReference = id(5),
): Commit {
  const input = command(artifact, kind, operationReference);
  return {
    ...input,
    audit: {
      ...input.audit,
      purposeCode: "BRAND_ADMINISTRATION",
      auditReference: kind === "ActivateBrand" ? id(51) : id(52),
    },
  };
}
describe("ordinary lifecycle administration facade", () => {
  it("returns exact immutable receipt metadata and preserves original Activate after Archive", async () => {
    const f = fixture();
    f.setCurrent(draft);
    const store = f.administration(),
      activate = administrativeCommand();
    expect(await store.resolveRecordedOperation(id(5))).toBeNull();
    expect(await store.commit(activate)).toEqual(activate.operation);
    const recorded = {
      operation: activate.operation,
      actorReference: id(3),
      purposeCode: "BRAND_ADMINISTRATION",
      auditReference: id(51),
      occurredAt: later,
    };
    expect(await store.resolveRecordedOperation(id(5))).toEqual(recorded);
    const active = createBrand(activate.operation.artifact),
      archived = transitionBrand(active, active.version, "Archived", "2026-10-06T10:02:00.000Z");
    await store.commit(administrativeCommand(archived, "ArchiveBrand", id(6)));
    expect(await store.loadBrand(draft.brandReference)).toEqual(archived);
    expect(await store.resolveOperation(id(5))).toEqual(activate.operation);
    expect(await store.resolveRecordedOperation(id(5))).toEqual(recorded);
    const writes = f.audits.length;
    expect(await store.commit(activate)).toEqual(activate.operation);
    expect(f.audits).toHaveLength(writes);
  });
  it("does not permit CreateBrand, other Actor or purpose and checks exact version before SQL", async () => {
    for (const input of [
      command(),
      {
        ...administrativeCommand(),
        audit: { ...administrativeCommand().audit, actorReference: id(9) },
      },
      {
        ...administrativeCommand(),
        audit: { ...administrativeCommand().audit, purposeCode: "OTHER" },
      },
      { ...administrativeCommand(), expectedBrandVersion: 0 },
    ]) {
      const f = fixture();
      f.setCurrent(draft);
      await expect(f.administration().commit(input)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
      expect(f.audits).toHaveLength(0);
    }
  });
  it("rejects another Actor's committed original and changed Audit identity without another write", async () => {
    const f = fixture();
    f.setCurrent(draft);
    const input = administrativeCommand();
    await f.administration().commit(input);
    await expect(f.administration(id(9)).resolveRecordedOperation(id(5))).rejects.toThrow();
    await expect(f.administration(id(9)).resolveOperation(id(5))).rejects.toThrow();
    await expect(
      f.administration().commit({ ...input, audit: { ...input.audit, auditReference: id(90) } }),
    ).rejects.toThrow();
    expect(f.audits).toHaveLength(1);
  });
  it.each([
    "purpose",
    "Brand",
    "operation",
    "precision",
    "classification",
    "version",
    "snapshot",
    "time",
  ])("rejects a valid original corrupted at %s binding", async (leaf) => {
    const f = fixture();
    f.setCurrent(draft);
    await f.administration().commit(administrativeCommand());
    const row = f.originals.get(id(5));
    if (!row) throw new Error("missing genuine original");
    if (leaf === "purpose") row.purpose_code = "OTHER";
    if (leaf === "Brand") row.brand_id = id(9);
    if (leaf === "operation") row.operation_id = id(9);
    if (leaf === "precision") row.precise = false;
    if (leaf === "classification") row.data_classification = "Other";
    if (leaf === "version") row.brand_version = "02";
    if (leaf === "snapshot")
      row.artifact_snapshot_json = { ...createBrand(row.artifact_snapshot_json), version: 3 };
    if (leaf === "time") row.occurred_at = at;
    await expect(f.administration().resolveRecordedOperation(id(5))).rejects.toThrow();
  });
  it("rejects sparse rows/accessors without invoking them and refuses imprecise current timestamps", async () => {
    for (const leaf of ["sparse", "getter", "current"]) {
      const f = fixture();
      f.setCurrent(draft);
      let invoked = false;
      f.control.response = (sql, value) => {
        if (leaf === "current" && sql.includes("FROM bop_tenant.brand WHERE"))
          return {
            rows: [
              {
                brand_id: draft.brandReference,
                code: draft.code,
                display_name: draft.displayName,
                default_locale: draft.defaultLocale,
                currency_code: draft.currencyCode,
                lifecycle: draft.lifecycle,
                version: "1",
                created_at: at,
                updated_at: at,
                precise: false,
              },
            ],
            rowCount: 1,
          };
        if (!sql.includes("FROM bop_tenant.brand_admin_operation")) return value;
        if (leaf === "sparse") return { rows: new Array(1) };
        if (leaf === "getter")
          return Object.defineProperty({}, "rows", {
            enumerable: true,
            get() {
              invoked = true;
              return [];
            },
          });
        return value;
      };
      if (leaf === "current")
        await expect(f.administration().loadBrand(draft.brandReference)).rejects.toThrow();
      else await expect(f.administration().resolveRecordedOperation(id(5))).rejects.toThrow();
      expect(invoked).toBe(false);
    }
  });
  it("rolls back the owning update/original/Audit when post-transition authority is withdrawn", async () => {
    const f = fixture();
    f.setCurrent(draft);
    f.control.afterAudit = () => {
      f.control.allow = false;
    };
    await expect(f.administration().commit(administrativeCommand())).rejects.toThrow();
    expect(f.current()).toEqual(draft);
    expect(f.originals.size).toBe(0);
    expect(f.audits).toHaveLength(0);
  });
});

it("ordinary admission takes operation then Brand serialization before any actual IAM callback", async () => {
  for (const method of ["commit", "resolve", "recorded", "load"]) {
    const f = fixture();
    f.setCurrent(draft);
    let calls = 0;
    f.control.beforeAuthorize = () => {
      if (calls++ !== 0) return;
      const locks = f.calls.filter((sql) => sql.includes("pg_advisory_xact_lock"));
      expect(locks).toHaveLength(method === "load" ? 1 : 2);
      expect(f.lockKeys).toEqual(
        method === "load"
          ? ["Brand:" + draft.brandReference]
          : [
              "BrandOperation:" + draft.brandReference + ":" + id(5),
              "Brand:" + draft.brandReference,
            ],
      );
      expect(f.calls.some((sql) => sql.includes("FROM bop_tenant.brand WHERE"))).toBe(false);
      expect(f.calls.some((sql) => sql.includes("FROM bop_tenant.brand_admin_operation"))).toBe(
        false,
      );
    };
    const store = f.administration();
    if (method === "commit") await store.commit(administrativeCommand());
    if (method === "resolve") await store.resolveOperation(id(5));
    if (method === "recorded") await store.resolveRecordedOperation(id(5));
    if (method === "load") await store.loadBrand(draft.brandReference);
    expect(calls).toBeGreaterThan(0);
  }
});
