import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresStoreSetupReferenceStore,
  type StoreSetupReferenceStoreOptions,
  type StoreSetupReferenceTransaction,
} from "../infrastructure/persistence/store-setup-reference-store.js";
import {
  parseStoreSetupReferenceSave,
  parseStoreSetupReferenceResolve,
  StoreSetupReferenceError,
  storeSetupReferenceOperationRequiredFields,
  type StoreSetupReferenceKind,
  type StoreSetupReferenceSave,
} from "../contracts/store-setup-reference.js";

// Controlled owning-port evidence; this fixture is not native IAM or SQL proof.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const origin = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
      )
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("noncanonical fixture input");
  return text;
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const address = {
  countryCode: "CA",
  regionCode: "ON",
  locality: "Synthetic locality",
  postalCode: "M1M 1M1",
  addressLines: ["Synthetic fixture address"],
};
const contact = {
  contactName: "Synthetic business contact",
  businessPhone: "+14165550123",
  website: "https://example.test/",
};
interface Database {
  versions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
type AuthorityInput = Parameters<
  StoreSetupReferenceStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[1];
type AuditInput = Parameters<StoreSetupReferenceStoreOptions["appendAudit"]>[1];
function fixture(database: Database = { versions: [], operations: [] }, actor = id(4)) {
  let now = origin,
    next = 100 + database.versions.length * 10 + database.operations.length * 10,
    allowed = true,
    lease = until,
    scopeRestored = false,
    flushDenied = false;
  const statements: string[] = [],
    locks: string[] = [],
    audits: unknown[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const fixed = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  };
  const tx: StoreSetupReferenceTransaction = {
    query: vi.fn(async (sql: string, values: readonly unknown[]) => {
      statements.push(sql);
      if (sql.includes("bop.tenant_id")) {
        scopeRestored =
          values[0] === fixed.tenantReference &&
          values[1] === fixed.brandReference &&
          values[2] === fixed.storeReference;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("transaction_isolation"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (sql.includes("pg_advisory")) {
        locks.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SET CONSTRAINTS")) {
        if (!scopeRestored || flushDenied)
          throw Object.assign(new Error("controlled constraint refusal"), { code: "23514" });
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM rms_store.store_setup_reference_version")
      ) {
        const inKind = database.versions.filter((row) => row.reference_kind === values[3]);
        const found = sql.includes("ORDER BY")
          ? inKind.slice(-1)
          : inKind.filter(
              (row) =>
                row.reference_id === values[4] &&
                (!sql.includes("AND revision=$6") ||
                  (row.revision === String(values[5]) && row.operation_id === values[6])),
            );
        return { rows: found, rowCount: found.length };
      }
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM rms_store.store_setup_reference_operation")
      ) {
        const found = database.operations.filter(
          (row) =>
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.store_id === values[2] &&
            row.operation_id === values[3],
        );
        return { rows: found, rowCount: found.length };
      }
      if (sql.startsWith("INSERT INTO rms_store.store_setup_reference_version")) {
        database.versions.push({
          reference_kind: values[3],
          reference_id: values[4],
          revision: String(values[5]),
          operation_id: values[6],
          actor_id: values[7],
          previous_reference_id: values[8],
          snapshot_json: JSON.parse(String(values[9])),
          snapshot_digest: values[10],
          created_at: values[11],
          updated_at: values[12],
        });
      }
      if (sql.startsWith("INSERT INTO rms_store.store_setup_reference_operation")) {
        if (database.operations.some((row) => row.operation_id === values[0]))
          throw Object.assign(new Error("controlled uniqueness refusal"), { code: "23505" });
        database.operations.push({
          operation_id: values[0],
          tenant_id: values[1],
          brand_id: values[2],
          store_id: values[3],
          reference_kind: values[4],
          actor_id: values[5],
          intent_digest: values[6],
          expected_reference_id: values[7],
          expected_revision: String(values[8]),
          outcome: values[9],
          result_reference_id: values[10],
          result_revision: values[11] === null ? null : String(values[11]),
          snapshot_digest: values[12],
          audit_reference: values[13],
          occurred_at: values[14],
        });
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const options: StoreSetupReferenceStoreOptions = {
    ...fixed,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: origin,
    originalValidUntil: until,
    registerBeforeCommit: (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
    authority: {
      holdUntilTransactionCompletes: vi.fn(
        async (actual: StoreSetupReferenceTransaction, input: AuthorityInput) => {
          expect(actual).toBe(tx);
          expect(input).toMatchObject({
            ...fixed,
            permission: "organization.manage",
            purposeCode: "STORE_SETUP_REFERENCE",
            requiredFields: storeSetupReferenceOperationRequiredFields,
          });
          if (!allowed)
            throw new StoreSetupReferenceError("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
          return { validUntil: lease };
        },
      ),
    },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: vi.fn(async (actual: StoreSetupReferenceTransaction, audit: AuditInput) => {
      expect(actual).toBe(tx);
      audits.push(audit);
      scopeRestored = false;
    }),
  };
  const store = createPostgresStoreSetupReferenceStore(options);
  const save = (
    operation = id(5),
    kind: StoreSetupReferenceKind = "Address",
    expectedReference: string | null = null,
    expectedRevision = 0,
  ) =>
    parseStoreSetupReferenceSave({
      profile: "StoreSetupReferenceSaveV1",
      ...fixed,
      kind,
      operationReference: operation,
      expectedReference,
      expectedRevision,
      purposeCode: "STORE_SETUP_REFERENCE",
      content: kind === "Address" ? address : contact,
    });
  const resolve = (command: StoreSetupReferenceSave) =>
    parseStoreSetupReferenceResolve({
      profile: "StoreSetupReferenceResolveV1",
      ...fixed,
      kind: command.kind,
      operationReference: command.operationReference,
      expectedReference: command.expectedReference,
      expectedRevision: command.expectedRevision,
      purposeCode: "STORE_SETUP_REFERENCE",
      intentDigest: hash(canonical(command)),
    });
  const finish = async () => {
    for (const guard of guards) await guard();
    for (const final of finals) final();
    return store.assertFinalized(tx);
  };
  return {
    store,
    options,
    tx,
    fixed,
    database,
    statements,
    locks,
    audits,
    guards,
    finals,
    save,
    resolve,
    finish,
    clock: (value: string) => {
      now = value;
    },
    withdraw: () => {
      allowed = false;
    },
    shorten: (value: string) => {
      lease = value;
    },
    clearScope: () => {
      scopeRestored = false;
    },
    denyFlush: () => {
      flushDenied = true;
    },
  };
}
const unavailable = { code: "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE" };
describe("Store setup reference owning persistence", () => {
  it("reads truthful empty current facts with Address then Contact roots and current reader", async () => {
    const f = fixture();
    const result = await f.store.readCurrent();
    expect(result).toMatchObject({
      ...f.fixed,
      address: null,
      contact: null,
      businessReferenceValidation: "NotEvaluated",
    });
    expect(f.locks).toEqual([
      `StoreSetupReferenceRoot:${id(1)}:${id(2)}:${id(3)}:Address`,
      `StoreSetupReferenceRoot:${id(1)}:${id(2)}:${id(3)}:Contact`,
    ]);
    await f.finish();
    expect(f.audits).toEqual([]);
    expect(f.statements.some((sql) => sql.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it("saves actual Address intent with new immutable reference and hash-only audit", async () => {
    const f = fixture();
    const command = f.save();
    const receipt = await f.store.save(command);
    expect(receipt).toMatchObject({
      outcome: "Committed",
      operationReference: command.operationReference,
      intentDigest: hash(canonical(command)),
      snapshot: {
        reference: id(100),
        revision: 1,
        previousReference: null,
        authoredByReference: id(4),
        content: address,
        createdAt: origin,
        updatedAt: origin,
      },
    });
    expect(f.locks[0]).toBe(`StoreSetupReferenceOperation:${command.operationReference}`);
    expect(f.locks[1]).toContain(":Address");
    expect(f.audits).toEqual([
      {
        ...f.fixed,
        kind: "Address",
        operationReference: command.operationReference,
        auditReference: id(101),
        intentDigest: receipt.intentDigest,
        purposeCode: "STORE_SETUP_REFERENCE",
        mode: "Save",
        occurredAt: origin,
      },
    ]);
    f.clearScope();
    f.guards.push(async () => {
      f.clearScope();
    });
    await f.finish();
    expect(f.database.versions).toHaveLength(1);
    expect(f.database.operations).toHaveLength(1);
    expect(f.statements.filter((sql) => sql.startsWith("SET CONSTRAINTS"))).toEqual([
      "SET CONSTRAINTS rms_store.store_setup_reference_version_coherence,rms_store.store_setup_reference_operation_coherence IMMEDIATE",
    ]);
  });
  it("a different Manager appends a new Address reference with original creation time and reads historical author", async () => {
    const first = fixture();
    const receipt = await first.store.save(first.save());
    await first.finish();
    const snapshot = receipt.snapshot;
    if (!snapshot) throw new Error("expected owning version");
    const reader = fixture(first.database, id(9));
    const view = await reader.store.readCurrent();
    expect(view.actorReference).toBe(id(9));
    expect(view.address?.authoredByReference).toBe(id(4));
    await reader.finish();
    const next = fixture(first.database, id(9));
    next.clock("2026-10-05T10:00:01.000Z");
    // Each test transaction has a distinct server reference allocator.
    next.options.references.nextReference = vi.fn((kind) =>
      kind === "Reference" ? id(200) : id(201),
    );
    const replacement = createPostgresStoreSetupReferenceStore(next.options);
    const replaced = await replacement.save(next.save(id(6), "Address", snapshot.reference, 1));
    expect(replaced.snapshot).toMatchObject({
      reference: id(200),
      previousReference: snapshot.reference,
      revision: 2,
      authoredByReference: id(9),
      createdAt: origin,
      updatedAt: "2026-10-05T10:00:01.000Z",
    });
    for (const guard of next.guards) await guard();
    for (const final of next.finals) final();
    replacement.assertFinalized(next.tx);
    expect(first.database.versions).toHaveLength(2);
    expect(first.database.versions[0]?.snapshot_json).toEqual(snapshot);
  });
  it("Contact has an independent first revision after Address and is not verification evidence", async () => {
    const first = fixture();
    await first.store.save(first.save());
    await first.finish();
    const second = fixture(first.database);
    const receipt = await second.store.save(second.save(id(7), "Contact"));
    await second.finish();
    expect(receipt.snapshot).toMatchObject({
      kind: "Contact",
      revision: 1,
      previousReference: null,
      content: contact,
    });
    expect(first.database.versions).toHaveLength(2);
  });
  it("exact replay and payload-free Resolve recover original version without new allocations or audit", async () => {
    const f = fixture(),
      command = f.save();
    const receipt = await f.store.save(command);
    await f.finish();
    for (const mode of ["Save", "Resolve"] as const) {
      const retry = fixture(f.database);
      const result =
        mode === "Save"
          ? await retry.store.save(command)
          : await retry.store.resolve(retry.resolve(command));
      await retry.finish();
      expect(result).toEqual(receipt);
      expect(retry.options.references.nextReference).not.toHaveBeenCalled();
      expect(retry.audits).toEqual([]);
      expect(retry.statements.some((sql) => sql.startsWith("SET CONSTRAINTS"))).toBe(false);
    }
    expect(f.database.versions).toHaveLength(1);
    expect(f.database.operations).toHaveLength(1);
  });
  it("original replay remains original after a later Manager revision", async () => {
    const first = fixture(),
      command = first.save();
    const receipt = await first.store.save(command);
    await first.finish();
    const snapshot = receipt.snapshot;
    if (!snapshot) throw new Error("expected version");
    const next = fixture(first.database, id(9));
    next.options.references.nextReference = vi.fn((kind) =>
      kind === "Reference" ? id(210) : id(211),
    );
    const writer = createPostgresStoreSetupReferenceStore(next.options);
    await writer.save(next.save(id(8), "Address", snapshot.reference, 1));
    for (const guard of next.guards) await guard();
    for (const final of next.finals) final();
    writer.assertFinalized(next.tx);
    const replay = fixture(first.database);
    expect(await replay.store.save(command)).toEqual(receipt);
    await replay.finish();
    expect(replay.options.references.nextReference).not.toHaveBeenCalled();
  });
  it("durable Abandoned original fences late Save and does not append a version", async () => {
    const f = fixture(),
      command = f.save();
    const abandoned = await f.store.resolve(f.resolve(command));
    f.clearScope();
    await f.finish();
    expect(abandoned).toMatchObject({ outcome: "Abandoned", snapshot: null });
    expect(f.database.versions).toEqual([]);
    const late = fixture(f.database);
    expect(await late.store.save(command)).toEqual(abandoned);
    await late.finish();
    expect(late.options.references.nextReference).not.toHaveBeenCalled();
    expect(late.audits).toEqual([]);
    expect(f.database.operations).toHaveLength(1);
    expect(f.statements.filter((sql) => sql.startsWith("SET CONSTRAINTS"))).toHaveLength(1);
  });
  it.each(["content", "kind", "pins", "digest"] as const)(
    "changed original %s is refused rather than replaced",
    async (change) => {
      const f = fixture(),
        command = f.save();
      await f.store.save(command);
      await f.finish();
      const retry = fixture(f.database);
      const input =
        change === "content"
          ? { ...command, content: { ...address, locality: "Different synthetic locality" } }
          : change === "kind"
            ? retry.save(command.operationReference, "Contact")
            : change === "pins"
              ? { ...command, expectedReference: id(100), expectedRevision: 1 }
              : { ...retry.resolve(command), intentDigest: hash("changed") };
      await expect(
        change === "digest" ? retry.store.resolve(input) : retry.store.save(input),
      ).rejects.toMatchObject({ code: "STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT" });
      expect(retry.audits).toEqual([]);
      expect(retry.options.references.nextReference).not.toHaveBeenCalled();
    },
  );
  it("another Actor cannot recover a prior Actor original, but may read its historical authored facts", async () => {
    const f = fixture(),
      command = f.save();
    await f.store.save(command);
    await f.finish();
    const other = fixture(f.database, id(9));
    await expect(
      other.store.resolve(other.resolve({ ...command, actorReference: id(9) })),
    ).rejects.toMatchObject({ code: "STORE_SETUP_REFERENCE_PERMISSION_DENIED" });
    expect(other.audits).toEqual([]);
  });
  it("stale CAS refuses before generation, audit or inserts", async () => {
    const f = fixture();
    await f.store.save(f.save());
    await f.finish();
    const stale = fixture(f.database);
    await expect(stale.store.save(stale.save(id(9)))).rejects.toMatchObject({
      code: "STORE_SETUP_REFERENCE_VERSION_CONFLICT",
    });
    expect(stale.options.references.nextReference).not.toHaveBeenCalled();
    expect(stale.audits).toEqual([]);
    expect(f.database.versions).toHaveLength(1);
  });
  it("a captured old current Address cannot survive a changed complete stored snapshot", async () => {
    const f = fixture();
    await f.store.save(f.save());
    await f.finish();
    const reader = fixture(f.database);
    await reader.store.readCurrent();
    const row = f.database.versions[0];
    if (!row) throw new Error("expected row");
    row.snapshot_digest = hash("corrupt");
    await expect(reader.finish()).rejects.toMatchObject(unavailable);
    expect(() => reader.store.assertFinalized(reader.tx)).toThrow(StoreSetupReferenceError);
  });
  it.each(["snapshot", "receipt", "operation"] as const)(
    "corrupt stored %s is dependency failure, not new caller intent",
    async (kind) => {
      const f = fixture(),
        command = f.save();
      await f.store.save(command);
      await f.finish();
      const version = f.database.versions[0],
        operation = f.database.operations[0];
      if (!version || !operation) throw new Error("expected owning records");
      if (kind === "snapshot") version.snapshot_json = {};
      else if (kind === "receipt") operation.audit_reference = "invalid";
      else version.operation_id = id(999);
      const reader = fixture(f.database);
      await expect(reader.store.resolve(reader.resolve(command))).rejects.toMatchObject(
        unavailable,
      );
      expect(reader.audits).toEqual([]);
      expect(reader.options.references.nextReference).not.toHaveBeenCalled();
    },
  );
  it("late withdrawal fails the fresh before-COMMIT guard and poisons later calls", async () => {
    const f = fixture();
    await f.store.save(f.save());
    f.withdraw();
    await expect(f.finish()).rejects.toMatchObject({
      code: "STORE_SETUP_REFERENCE_PERMISSION_DENIED",
    });
    await expect(f.store.save(f.save())).rejects.toMatchObject(unavailable);
  });
  it("returns the shortest live lease without renewing the original five seconds", async () => {
    const f = fixture();
    f.shorten("2026-10-05T10:00:02.000Z");
    const current = await f.store.readCurrent();
    expect(current.validUntil).toBe("2026-10-05T10:00:02.000Z");
    expect(await f.finish()).toBe(current.validUntil);
  });
  it.each(["expired", "backwards"] as const)(
    "%s clock refuses and never finalizes",
    async (kind) => {
      const f = fixture();
      await f.store.readCurrent();
      f.clock(kind === "expired" ? until : "2026-10-05T09:59:59.999Z");
      await expect(f.finish()).rejects.toMatchObject(unavailable);
    },
  );
  it("cannot claim finalization without both real host hooks, with another tx, or after repeated final", async () => {
    const missing = fixture();
    await missing.store.readCurrent();
    expect(() => missing.store.assertFinalized(missing.tx)).toThrow(StoreSetupReferenceError);
    const other = fixture();
    await other.store.readCurrent();
    await other.finish();
    expect(() => other.store.assertFinalized({ query: other.tx.query })).toThrow(
      StoreSetupReferenceError,
    );
    const twice = fixture();
    await twice.store.readCurrent();
    await twice.finish();
    expect(() => twice.finals[0]?.()).toThrow(StoreSetupReferenceError);
  });
  it("captured query substitution cannot be used even for historical recovery", async () => {
    const f = fixture();
    await f.store.readCurrent();
    f.tx.query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await expect(f.finish()).rejects.toMatchObject(unavailable);
  });
  it("a malformed authority proof or registration non-void result fails closed", async () => {
    const bad = fixture();
    bad.options.authority.holdUntilTransactionCompletes = vi.fn(async () => ({
      validUntil: until,
      allowed: true,
    }));
    const store = createPostgresStoreSetupReferenceStore(bad.options);
    await expect(store.readCurrent()).rejects.toMatchObject(unavailable);
    const register = fixture();
    Object.defineProperty(register.options, "registerBeforeCommit", { value: () => true });
    await expect(
      createPostgresStoreSetupReferenceStore(register.options).readCurrent(),
    ).rejects.toMatchObject(unavailable);
  });
  it("constraint failure poisons the owning operation even when a consumer catches it", async () => {
    const f = fixture();
    await f.store.resolve(f.resolve(f.save()));
    f.denyFlush();
    await expect(f.finish()).rejects.toBeInstanceOf(Error);
    expect(() => f.store.assertFinalized(f.tx)).toThrow(StoreSetupReferenceError);
    await expect(f.store.resolve(f.resolve(f.save()))).rejects.toMatchObject(unavailable);
  });
  it("audit reentry cannot dispatch another operation or release the owning barrier", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "appendAudit", {
      value: vi.fn(async () => {
        if (!owning) throw new Error("fixture not assigned");
        await expect(owning.readCurrent()).rejects.toMatchObject(unavailable);
      }),
    });
    const owning = createPostgresStoreSetupReferenceStore(f.options);
    await expect(owning.save(f.save())).rejects.toMatchObject(unavailable);
    expect(f.database.operations).toEqual([]);
  });
  it("rejects mixed ReadAll then Save on one operation source rather than invert global/root lock order", async () => {
    const f = fixture();
    await f.store.readCurrent();
    await expect(f.store.save(f.save())).rejects.toMatchObject(unavailable);
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
  });
});

async function recordedHistory(kind: StoreSetupReferenceKind = "Address") {
  const first = fixture();
  const original = await first.store.save(first.save(id(500), kind));
  await first.finish();
  const snapshot = original.snapshot;
  if (!snapshot) throw new Error("fixture immutable version absent");
  const successor = fixture(first.database, id(9));
  const replaced = await successor.store.save(
    successor.save(id(501), kind, snapshot.reference, snapshot.revision),
  );
  await successor.finish();
  return { database: first.database, snapshot, replaced };
}
describe("Store setup exact historical reference reading", () => {
  it.each(["Address", "Contact"] as const)(
    "reads exact %s bytes after a legal successor, with a different current reader",
    async (kind) => {
      const history = await recordedHistory(kind),
        reader = fixture(history.database, id(12));
      const value = await reader.store.readVersion({ kind, reference: history.snapshot.reference });
      expect(value).toEqual(history.snapshot);
      expect(value?.reference).not.toBe(history.replaced.snapshot?.reference);
      expect(value?.authoredByReference).toBe(id(4));
      await reader.finish();
      expect(reader.audits).toEqual([]);
      expect(reader.options.references.nextReference).not.toHaveBeenCalled();
      expect(reader.locks.every((lock) => lock.endsWith(":" + kind))).toBe(true);
      expect(reader.statements.some((sql) => sql.includes("ORDER BY revision"))).toBe(false);
      expect(reader.options.authority.holdUntilTransactionCompletes).toHaveBeenCalledWith(
        reader.tx,
        expect.objectContaining({
          mode: "ReadVersion",
          kind,
          actorReference: id(12),
          command: null,
        }),
      );
    },
  );
  it("returns genuine missing or wrong-kind null without substituting the current version", async () => {
    const history = await recordedHistory();
    for (const selector of [
      { kind: "Address", reference: id(999) },
      { kind: "Contact", reference: history.snapshot.reference },
    ]) {
      const reader = fixture(history.database, id(12));
      expect(await reader.store.readVersion(selector)).toBeNull();
      await reader.finish();
      expect(reader.audits).toEqual([]);
    }
  });
  it("does not invalidate an unchanged old reference when another legal successor becomes latest", async () => {
    const history = await recordedHistory(),
      reader = fixture(history.database, id(12));
    await reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference });
    const latest = history.replaced.snapshot;
    if (!latest) throw new Error("fixture latest absent");
    const writer = fixture(history.database, id(9));
    await writer.store.save(writer.save(id(502), "Address", latest.reference, latest.revision));
    await writer.finish();
    await reader.finish();
    expect(reader.database.versions).toHaveLength(3);
  });
  it("rejects visible scope corruption instead of converting it into missing", async () => {
    const history = await recordedHistory(),
      row = history.database.versions[0];
    if (!row) throw new Error("fixture version absent");
    const content = Object.getOwnPropertyDescriptor(row, "snapshot_json")?.value;
    row.snapshot_json = { ...content, tenantReference: id(999) };
    row.snapshot_digest = hash(canonical(row.snapshot_json));
    const reader = fixture(history.database, id(12));
    await expect(
      reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference }),
    ).rejects.toMatchObject(unavailable);
  });
  it("requires the real Committed operation and its unchanged author/intent proof", async () => {
    for (const mutation of ["missing", "actor", "digest"]) {
      const history = await recordedHistory(),
        row = history.database.operations[0];
      if (!row) throw new Error("fixture operation absent");
      if (mutation === "missing") history.database.operations.shift();
      else if (mutation === "actor") row.actor_id = id(999);
      else row.intent_digest = "sha256:" + "f".repeat(64);
      const reader = fixture(history.database, id(12));
      await expect(
        reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference }),
      ).rejects.toThrow(StoreSetupReferenceError);
    }
  });
  it("rechecks both selected immutable version and its actual operation at final commit", async () => {
    for (const mutation of ["version", "operation"]) {
      const history = await recordedHistory(),
        reader = fixture(history.database, id(12));
      await reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference });
      if (mutation === "version") {
        const row = history.database.versions[0];
        if (!row) throw new Error("fixture version absent");
        row.snapshot_digest = "sha256:" + "f".repeat(64);
      } else {
        const row = history.database.operations[0];
        if (!row) throw new Error("fixture operation absent");
        row.audit_reference = id(999);
      }
      await expect(reader.finish()).rejects.toThrow(StoreSetupReferenceError);
    }
  });
  it("holds current read permission and its shorter lease until commit", async () => {
    const history = await recordedHistory(),
      reader = fixture(history.database, id(12));
    reader.shorten("2026-10-05T10:00:01.000Z");
    await reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference });
    reader.withdraw();
    await expect(reader.finish()).rejects.toMatchObject({
      code: "STORE_SETUP_REFERENCE_PERMISSION_DENIED",
    });
    const expiry = fixture(history.database, id(12));
    expiry.shorten("2026-10-05T10:00:01.000Z");
    await expiry.store.readVersion({ kind: "Address", reference: history.snapshot.reference });
    expiry.clock("2026-10-05T10:00:01.000Z");
    await expect(expiry.finish()).rejects.toMatchObject(unavailable);
  });
  it("refuses changed captured reader scope after consuming the historical source", async () => {
    const history = await recordedHistory(),
      reader = fixture(history.database, id(12));
    await reader.store.readVersion({ kind: "Address", reference: history.snapshot.reference });
    Object.defineProperty(reader.options, "actorReference", { value: id(999), enumerable: true });
    await expect(reader.finish()).rejects.toMatchObject(unavailable);
  });
  it("rejects unknown fields/getters/invalid selector without allocating or reading current", async () => {
    const accessor = { reference: id(100) };
    let called = false;
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get: () => {
        called = true;
        return "Address";
      },
    });
    for (const selector of [
      { kind: "Address", reference: "not-a-reference" },
      { kind: "Other", reference: id(100) },
      { kind: "Address", reference: id(100), extra: true },
      accessor,
    ]) {
      const reader = fixture();
      await expect(reader.store.readVersion(selector)).rejects.toMatchObject({
        code: "STORE_SETUP_REFERENCE_INPUT_INVALID",
      });
      expect(reader.statements).toEqual([]);
      expect(reader.audits).toEqual([]);
      expect(reader.options.references.nextReference).not.toHaveBeenCalled();
    }
    expect(called).toBe(false);
  });
});
