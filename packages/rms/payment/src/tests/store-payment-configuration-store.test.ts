import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresStorePaymentConfigurationStore,
  type StorePaymentConfigurationStoreOptions,
  type StorePaymentConfigurationTransaction,
} from "../infrastructure/persistence/store-payment-configuration-store.js";
import {
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationResolve,
  StorePaymentConfigurationError,
  storePaymentConfigurationRequiredFields,
  type StorePaymentConfigurationSave,
} from "../contracts/store-payment-configuration.js";

// Controlled owning transactions/authority only, not Provider or native IAM proof.
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
const content = {
  customerOnlineCardEnabled: false,
  staffTerminalCardPresentEnabled: false,
  staffTerminalInteracEnabled: false,
};
interface Database {
  versions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
type AuthorityInput = Parameters<
  StorePaymentConfigurationStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[1];
type AuditInput = Parameters<StorePaymentConfigurationStoreOptions["appendAudit"]>[1];
function fixture(database: Database = { versions: [], operations: [] }, actor = id(4)) {
  let now = origin,
    next = 100 + database.versions.length * 10 + database.operations.length * 10,
    allowed = true,
    lease = until,
    scoped = false,
    flushDenied = false;
  const sql: string[] = [],
    locks: string[] = [],
    audits: AuditInput[] = [],
    holds: AuthorityInput[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  };
  const tx: StorePaymentConfigurationTransaction = {
    query: vi.fn(async (statement: string, values: readonly unknown[]) => {
      sql.push(statement);
      if (statement.includes("bop.tenant_id")) {
        scoped =
          values[0] === scope.tenantReference &&
          values[1] === scope.brandReference &&
          values[2] === scope.storeReference;
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes("transaction_isolation"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (statement.includes("pg_advisory")) {
        locks.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (statement.startsWith("SET CONSTRAINTS")) {
        if (!scoped || flushDenied)
          throw Object.assign(new Error("controlled constraint failure"), { code: "23514" });
        return { rows: [], rowCount: 0 };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_payment.store_payment_configuration_version")
      ) {
        const found = statement.includes("ORDER BY")
          ? database.versions.slice(-1)
          : database.versions.filter((row) => row.configuration_id === values[3]);
        return { rows: found, rowCount: found.length };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_payment.store_payment_configuration_operation")
      ) {
        const found = database.operations.filter(
          (row) =>
            row.operation_id === values[3] &&
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.store_id === values[2],
        );
        return { rows: found, rowCount: found.length };
      }
      if (statement.startsWith("INSERT INTO rms_payment.store_payment_configuration_version")) {
        database.versions.push({
          configuration_id: values[3],
          revision: String(values[4]),
          operation_id: values[5],
          actor_id: values[6],
          previous_configuration_id: values[7],
          snapshot_json: JSON.parse(String(values[8])),
          snapshot_digest: values[9],
          created_at: values[10],
          updated_at: values[11],
        });
      }
      if (statement.startsWith("INSERT INTO rms_payment.store_payment_configuration_operation")) {
        if (database.operations.some((row) => row.operation_id === values[0]))
          throw Object.assign(new Error("controlled uniqueness refusal"), { code: "23505" });
        database.operations.push({
          operation_id: values[0],
          tenant_id: values[1],
          brand_id: values[2],
          store_id: values[3],
          actor_id: values[4],
          intent_digest: values[5],
          expected_configuration_id: values[6],
          expected_revision: String(values[7]),
          outcome: values[8],
          result_configuration_id: values[9],
          result_revision: values[10] === null ? null : String(values[10]),
          snapshot_digest: values[11],
          audit_reference: values[12],
          occurred_at: values[13],
        });
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const options: StorePaymentConfigurationStoreOptions = {
    ...scope,
    currencyCode: "CAD",
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
        async (actual: StorePaymentConfigurationTransaction, input: AuthorityInput) => {
          expect(actual).toBe(tx);
          expect(input).toMatchObject({
            ...scope,
            currencyCode: "CAD",
            permission: "organization.manage",
            purposeCode: "STORE_PAYMENT_CONFIGURATION",
            requiredFields: storePaymentConfigurationRequiredFields,
          });
          holds.push(input);
          if (!allowed)
            throw new StorePaymentConfigurationError(
              "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
            );
          return { validUntil: lease };
        },
      ),
    },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: vi.fn(async (actual: StorePaymentConfigurationTransaction, input: AuditInput) => {
      expect(actual).toBe(tx);
      audits.push(input);
      scoped = false;
    }),
  };
  const store = createPostgresStorePaymentConfigurationStore(options);
  const save = (
    op = id(5),
    expectedConfigurationReference: string | null = null,
    expectedRevision = 0,
  ) =>
    parseStorePaymentConfigurationSave({
      profile: "StorePaymentConfigurationSaveV1",
      ...scope,
      operationReference: op,
      expectedConfigurationReference,
      expectedRevision,
      content,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    });
  const resolve = (command: StorePaymentConfigurationSave) =>
    parseStorePaymentConfigurationResolve({
      profile: "StorePaymentConfigurationResolveV1",
      ...scope,
      operationReference: command.operationReference,
      expectedConfigurationReference: command.expectedConfigurationReference,
      expectedRevision: command.expectedRevision,
      intentDigest: hash(canonical(command)),
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    });
  const finish = async () => {
    for (const guard of guards) await guard();
    for (const final of finals) final();
    return store.assertFinalized(tx);
  };
  return {
    store,
    options,
    scope,
    tx,
    database,
    sql,
    locks,
    audits,
    holds,
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
      scoped = false;
    },
    denyFlush: () => {
      flushDenied = true;
    },
  };
}
const unavailable = { code: "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE" };
describe("Store Payment Configuration owning immutable source", () => {
  it("returns actual empty current rules without inventing Provider readiness", async () => {
    const f = fixture(),
      view = await f.store.readCurrent();
    expect(view).toMatchObject({ ...f.scope, snapshot: null, providerReadiness: "NotEvaluated" });
    expect(
      f.holds.every(
        (h) => h.mode === "ReadCurrent" && h.configurationReference === null && h.command === null,
      ),
    ).toBe(true);
    await f.finish();
    expect(f.audits).toEqual([]);
    expect(f.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it("saves all disabled explicit rules as a real version and hash-only Audit without Provider qualification", async () => {
    const f = fixture(),
      command = f.save(),
      receipt = await f.store.save(command);
    expect(receipt).toMatchObject({
      outcome: "Committed",
      operationReference: command.operationReference,
      intentDigest: hash(canonical(command)),
      snapshot: {
        configurationReference: id(100),
        revision: 1,
        previousConfigurationReference: null,
        authoredByReference: id(4),
        currencyCode: "CAD",
        content,
        createdAt: origin,
        updatedAt: origin,
      },
    });
    expect(f.locks.slice(0, 2)).toEqual([
      `StorePaymentConfigurationOperation:${command.operationReference}`,
      `StorePaymentConfigurationRoot:${id(1)}:${id(2)}:${id(3)}`,
    ]);
    expect(f.audits).toEqual([
      {
        ...f.scope,
        operationReference: command.operationReference,
        auditReference: id(101),
        intentDigest: receipt.intentDigest,
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
        mode: "Save",
        occurredAt: origin,
      },
    ]);
    f.guards.push(async () => {
      f.clearScope();
    });
    await f.finish();
    expect(f.sql.filter((s) => s.startsWith("SET CONSTRAINTS"))).toEqual([
      "SET CONSTRAINTS rms_payment.store_payment_configuration_version_coherence,rms_payment.store_payment_configuration_operation_coherence IMMEDIATE",
    ]);
  });
  it("another Manager writes successor UUID with exact parent, preserving original creation and historical binding", async () => {
    const first = fixture(),
      original = await first.store.save(first.save());
    await first.finish();
    const prior = original.snapshot;
    if (!prior) throw new Error("expected version");
    const next = fixture(first.database, id(9));
    next.clock("2026-10-05T10:00:01.000Z");
    const successor = await next.store.save({
      ...next.save(id(6), prior.configurationReference, 1),
      content: { ...content, customerOnlineCardEnabled: true },
    });
    await next.finish();
    expect(successor.snapshot).toMatchObject({
      revision: 2,
      authoredByReference: id(9),
      previousConfigurationReference: prior.configurationReference,
      createdAt: origin,
      updatedAt: "2026-10-05T10:00:01.000Z",
      content: { ...content, customerOnlineCardEnabled: true },
    });
    expect(successor.snapshot?.configurationReference).not.toBe(prior.configurationReference);
    const exact = fixture(first.database, id(9));
    expect(await exact.store.readVersion(prior.configurationReference)).toEqual(prior);
    await exact.finish();
    expect(
      exact.holds.every(
        (h) =>
          h.mode === "ReadVersion" &&
          h.configurationReference === prior.configurationReference &&
          h.command === null,
      ),
    ).toBe(true);
    const current = fixture(first.database, id(9));
    current.clock("2026-10-05T10:00:01.000Z");
    const view = await current.store.readCurrent();
    expect(view.actorReference).toBe(id(9));
    expect(view.snapshot).toEqual(successor.snapshot);
    expect(view.providerReadiness).toBe("NotEvaluated");
    await current.finish();
    expect(first.database.versions[0]?.snapshot_json).toEqual(prior);
  });
  it("exact original replay/Resolve retain original version after successor and never allocate or Audit again", async () => {
    const first = fixture(),
      command = first.save(),
      receipt = await first.store.save(command);
    await first.finish();
    const prior = receipt.snapshot;
    if (!prior) throw new Error("expected version");
    const next = fixture(first.database);
    await next.store.save(next.save(id(6), prior.configurationReference, 1));
    await next.finish();
    for (const mode of ["Save", "Resolve"] as const) {
      const retry = fixture(first.database);
      expect(
        mode === "Save"
          ? await retry.store.save(command)
          : await retry.store.resolve(retry.resolve(command)),
      ).toEqual(receipt);
      await retry.finish();
      expect(retry.options.references.nextReference).not.toHaveBeenCalled();
      expect(retry.audits).toEqual([]);
      expect(retry.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
    }
    expect(first.database.versions).toHaveLength(2);
    expect(first.database.operations).toHaveLength(2);
  });
  it("absent Resolve durably Abandons and late Save returns that exact terminal without a version", async () => {
    const f = fixture(),
      command = f.save(),
      receipt = await f.store.resolve(f.resolve(command));
    await f.finish();
    expect(receipt).toMatchObject({ outcome: "Abandoned", snapshot: null });
    expect(f.database.versions).toEqual([]);
    expect(f.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(true);
    const late = fixture(f.database);
    expect(await late.store.save(command)).toEqual(receipt);
    await late.finish();
    expect(late.audits).toEqual([]);
    expect(late.options.references.nextReference).not.toHaveBeenCalled();
    expect(late.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it.each(["content", "pins", "digest"] as const)(
    "changed original %s never replaces a terminal",
    async (change) => {
      const first = fixture(),
        command = first.save();
      await first.store.save(command);
      await first.finish();
      const retry = fixture(first.database),
        input =
          change === "content"
            ? { ...command, content: { ...content, staffTerminalInteracEnabled: true } }
            : change === "pins"
              ? { ...command, expectedConfigurationReference: id(100), expectedRevision: 1 }
              : { ...retry.resolve(command), intentDigest: hash("changed") };
      await expect(
        change === "digest" ? retry.store.resolve(input) : retry.store.save(input),
      ).rejects.toMatchObject({ code: "STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT" });
      expect(retry.audits).toEqual([]);
      expect(retry.options.references.nextReference).not.toHaveBeenCalled();
    },
  );
  it("another current Actor cannot recover an old Actor operation", async () => {
    const first = fixture(),
      command = first.save();
    await first.store.save(command);
    await first.finish();
    const other = fixture(first.database, id(9));
    await expect(
      other.store.resolve(other.resolve({ ...command, actorReference: id(9) })),
    ).rejects.toMatchObject({ code: "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED" });
    expect(other.audits).toEqual([]);
  });
  it("foreign command scope fails before owning queries, allocation and Audit", async () => {
    const f = fixture();
    await expect(f.store.save({ ...f.save(), storeReference: id(99) })).rejects.toMatchObject({
      code: "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
    });
    expect(f.sql).toEqual([]);
    expect(f.audits).toEqual([]);
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
  });
  it("CAS stale fails before allocation/Audit", async () => {
    const first = fixture();
    await first.store.save(first.save());
    await first.finish();
    const stale = fixture(first.database);
    await expect(stale.store.save(stale.save(id(6)))).rejects.toMatchObject({
      code: "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT",
    });
    expect(stale.audits).toEqual([]);
    expect(stale.options.references.nextReference).not.toHaveBeenCalled();
  });
  it("unknown exact historical reference remains absence, not current fallback", async () => {
    const first = fixture();
    await first.store.save(first.save());
    await first.finish();
    const absent = fixture(first.database);
    expect(await absent.store.readVersion(id(999))).toBeNull();
    await absent.finish();
    expect(absent.audits).toEqual([]);
  });
  it("current roster drift fails final guard, while unchanged historical binding remains fixed", async () => {
    const f = fixture();
    await f.store.readCurrent();
    const foreign = fixture(f.database);
    await foreign.store.save(foreign.save());
    await foreign.finish();
    await expect(f.finish()).rejects.toMatchObject({
      code: "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT",
    });
  });
  it.each(["content", "operation", "receipt"] as const)(
    "corrupt stored %s refuses recovery",
    async (kind) => {
      const f = fixture(),
        command = f.save();
      await f.store.save(command);
      await f.finish();
      const version = f.database.versions[0],
        operation = f.database.operations[0];
      if (!version || !operation) throw new Error("expected records");
      if (kind === "content") version.snapshot_json = {};
      else if (kind === "operation") version.operation_id = id(999);
      else operation.audit_reference = "invalid";
      const retry = fixture(f.database);
      await expect(retry.store.resolve(retry.resolve(command))).rejects.toMatchObject(unavailable);
      expect(retry.audits).toEqual([]);
    },
  );
  it("late authority withdrawal fails before-COMMIT and poisons swallowed failures", async () => {
    const f = fixture();
    await f.store.save(f.save());
    f.withdraw();
    await expect(f.finish()).rejects.toMatchObject({
      code: "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED",
    });
    expect(() => f.store.assertFinalized(f.tx)).toThrow(StorePaymentConfigurationError);
    await expect(f.store.save(f.save())).rejects.toMatchObject(unavailable);
  });
  it("short live source expiry remains shorter than original five seconds", async () => {
    const f = fixture();
    f.shorten("2026-10-05T10:00:02.000Z");
    expect((await f.store.readCurrent()).validUntil).toBe("2026-10-05T10:00:02.000Z");
    expect(await f.finish()).toBe("2026-10-05T10:00:02.000Z");
  });
  it.each(["expired", "backwards"] as const)("%s clock blocks finalization", async (kind) => {
    const f = fixture();
    await f.store.readCurrent();
    f.clock(kind === "expired" ? until : "2026-10-05T09:59:59.999Z");
    await expect(f.finish()).rejects.toMatchObject(unavailable);
  });
  it("guard skip, wrong tx or final reentry never produces finalized source", async () => {
    const missing = fixture();
    await missing.store.readCurrent();
    expect(() => missing.store.assertFinalized(missing.tx)).toThrow(StorePaymentConfigurationError);
    const other = fixture();
    await other.store.readCurrent();
    await other.finish();
    expect(() => other.store.assertFinalized({ query: other.tx.query })).toThrow(
      StorePaymentConfigurationError,
    );
    const twice = fixture();
    await twice.store.readCurrent();
    await twice.finish();
    expect(() => twice.finals[0]?.()).toThrow(StorePaymentConfigurationError);
  });
  it("query and currency substitution cannot alter the captured actual source", async () => {
    const query = fixture();
    await query.store.readCurrent();
    query.tx.query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await expect(query.finish()).rejects.toMatchObject(unavailable);
    const currency = fixture();
    await currency.store.readCurrent();
    Object.defineProperty(currency.options, "currencyCode", { value: "USD" });
    await expect(currency.finish()).rejects.toMatchObject(unavailable);
  });
  it("non-void registration and incomplete authority refuse owning reads", async () => {
    const registration = fixture();
    Object.defineProperty(registration.options, "registerBeforeCommit", { value: () => true });
    await expect(
      createPostgresStorePaymentConfigurationStore(registration.options).readCurrent(),
    ).rejects.toMatchObject(unavailable);
    const authority = fixture();
    authority.options.authority.holdUntilTransactionCompletes = vi.fn(async () => ({
      validUntil: until,
      allowed: true,
    }));
    await expect(
      createPostgresStorePaymentConfigurationStore(authority.options).readCurrent(),
    ).rejects.toMatchObject(unavailable);
  });
  it("own named constraint refusal is bounded and cannot be swallowed to finalize", async () => {
    const f = fixture();
    await f.store.resolve(f.resolve(f.save()));
    f.denyFlush();
    await expect(f.finish()).rejects.toMatchObject(unavailable);
    expect(() => f.store.assertFinalized(f.tx)).toThrow(StorePaymentConfigurationError);
  });
  it("Audit reentry poisons operation before terminal insert", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "appendAudit", {
      value: async () => {
        await expect(owning.readCurrent()).rejects.toMatchObject(unavailable);
      },
    });
    const owning = createPostgresStorePaymentConfigurationStore(f.options);
    await expect(owning.save(f.save())).rejects.toMatchObject(unavailable);
    expect(f.database.operations).toEqual([]);
  });
  it("ReadCurrent cannot switch to Save and exact ReadVersion cannot retarget another reference", async () => {
    const f = fixture();
    await f.store.readCurrent();
    await expect(f.store.save(f.save())).rejects.toMatchObject(unavailable);
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
    const exact = fixture();
    await exact.store.readVersion(id(8));
    await expect(exact.store.readVersion(id(9))).rejects.toMatchObject(unavailable);
  });
});
