import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresDigitalReceiptTemplateArtifactStore,
  type DigitalReceiptTemplateArtifactStoreOptions,
  type DigitalReceiptTemplateArtifactTransaction,
} from "../infrastructure/persistence/digital-receipt-template-artifact-store.js";
import {
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactResolve,
  digitalReceiptTemplateArtifactRequiredFields,
  type DigitalReceiptTemplateArtifactKind,
  type DigitalReceiptTemplateArtifactSave,
} from "../contracts/digital-receipt-template-artifact.js";
import {
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
} from "../contracts/digital-receipt-template.js";
// Controlled owning SQL/authority, not actual PostgreSQL/IAM or professional receipt review.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
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
  if (text === undefined) throw new Error("noncanonical fixture");
  return text;
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const content = (kind: DigitalReceiptTemplateArtifactKind) =>
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
      };
interface DB {
  versions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
type HoldInput = Parameters<
  DigitalReceiptTemplateArtifactStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[1];
type AuditInput = Parameters<DigitalReceiptTemplateArtifactStoreOptions["appendAudit"]>[1];
function fixture(db: DB = { versions: [], operations: [] }, actor = id(4)) {
  let now = at,
    next = 100 + db.versions.length * 10 + db.operations.length * 10,
    allowed = true,
    lease = until,
    scoped = false,
    flushDenied = false;
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  };
  const sql: string[] = [],
    locks: string[] = [],
    holds: HoldInput[] = [],
    audits: AuditInput[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const tx: DigitalReceiptTemplateArtifactTransaction = {
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
          throw Object.assign(new Error("controlled constraint"), { code: "23514" });
        return { rows: [], rowCount: 0 };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_device.digital_receipt_template_artifact_version")
      ) {
        let found = db.versions.filter((row) => row.artifact_kind === values[3]);
        if (statement.includes("ORDER BY")) found = found.slice(-1);
        else
          found = found.filter(
            (row) =>
              row.artifact_id === values[4] &&
              (values[5] === undefined || row.revision === String(values[5])) &&
              (values[6] === undefined || row.operation_id === values[6]),
          );
        return { rows: found, rowCount: found.length };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_device.digital_receipt_template_artifact_operation")
      ) {
        const found = db.operations.filter(
          (row) =>
            row.operation_id === values[3] &&
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.store_id === values[2],
        );
        return { rows: found, rowCount: found.length };
      }
      if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_artifact_version"))
        db.versions.push({
          artifact_kind: values[3],
          artifact_id: values[4],
          revision: String(values[5]),
          operation_id: values[6],
          actor_id: values[7],
          previous_artifact_id: values[8],
          snapshot_json: JSON.parse(String(values[9])),
          snapshot_digest: values[10],
          created_at: values[11],
          updated_at: values[12],
        });
      if (
        statement.startsWith("INSERT INTO rms_device.digital_receipt_template_artifact_operation")
      ) {
        if (db.operations.some((row) => row.operation_id === values[0]))
          throw new Error("duplicate original");
        db.operations.push({
          operation_id: values[0],
          tenant_id: values[1],
          brand_id: values[2],
          store_id: values[3],
          artifact_kind: values[4],
          actor_id: values[5],
          intent_digest: values[6],
          expected_artifact_id: values[7],
          expected_revision: String(values[8]),
          outcome: values[9],
          result_artifact_id: values[10],
          result_revision: values[11] === null ? null : String(values[11]),
          snapshot_digest: values[12],
          audit_reference: values[13],
          occurred_at: values[14],
        });
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const options: DigitalReceiptTemplateArtifactStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: at,
    originalValidUntil: until,
    registerBeforeCommit: (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
    authority: {
      holdUntilTransactionCompletes: vi.fn(async (actual, input: HoldInput) => {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          ...scope,
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          requiredFields: digitalReceiptTemplateArtifactRequiredFields,
        });
        expect(input.permission).toBe(
          input.mode === "ReadAll" || input.mode === "ReadVersion"
            ? "organization.manage"
            : "integration.manage",
        );
        holds.push(input);
        if (!allowed) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        return { validUntil: lease };
      }),
    },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: vi.fn(async (actual, input: AuditInput) => {
      expect(actual).toBe(tx);
      audits.push(input);
      scoped = false;
    }),
  };
  const store = createPostgresDigitalReceiptTemplateArtifactStore(options);
  const save = (
    kind: DigitalReceiptTemplateArtifactKind = "Layout",
    op = id(5),
    ref: string | null = null,
    rev = 0,
  ) =>
    parseDigitalReceiptTemplateArtifactSave({
      profile: "DigitalReceiptTemplateArtifactSaveV1",
      ...scope,
      artifactKind: kind,
      operationReference: op,
      expectedArtifactReference: ref,
      expectedRevision: rev,
      content: content(kind),
      purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
    });
  const resolve = (c: DigitalReceiptTemplateArtifactSave) =>
    parseDigitalReceiptTemplateArtifactResolve({
      profile: "DigitalReceiptTemplateArtifactResolveV1",
      ...scope,
      artifactKind: c.artifactKind,
      operationReference: c.operationReference,
      expectedArtifactReference: c.expectedArtifactReference,
      expectedRevision: c.expectedRevision,
      intentDigest: hash(canonical(c)),
      purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
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
    db,
    sql,
    locks,
    holds,
    audits,
    guards,
    finals,
    save,
    resolve,
    finish,
    clock: (v: string) => {
      now = v;
    },
    withdraw: () => {
      allowed = false;
    },
    shorten: (v: string) => {
      lease = v;
    },
    denyFlush: () => {
      flushDenied = true;
    },
    clearScope: () => {
      scoped = false;
    },
  };
}
const unavailable = { code: "RECEIPT_TEMPLATE_UNAVAILABLE" };
describe("Digital receipt artifact immutable owning source", () => {
  it("actual empty roster locks Layout then Compliance and claims only NotEvaluated", async () => {
    const f = fixture(),
      view = await f.store.readCurrent();
    expect(view).toMatchObject({
      ...f.scope,
      layout: null,
      compliance: null,
      sourceQualification: "NotEvaluated",
    });
    expect(f.locks).toEqual([
      `ReceiptTemplateArtifactRoot:${id(1)}:${id(2)}:${id(3)}:Layout`,
      `ReceiptTemplateArtifactRoot:${id(1)}:${id(2)}:${id(3)}:Compliance`,
    ]);
    expect(
      f.holds.every((h) => h.artifactKind === null && h.targetArtifactReference === null),
    ).toBe(true);
    await f.finish();
    expect(f.audits).toEqual([]);
    expect(f.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it.each(["Layout", "Compliance"] as const)(
    "saves actual %s with original fence, hash-only Audit and scoped own constraints",
    async (kind) => {
      const f = fixture(),
        c = f.save(kind),
        receipt = await f.store.save(c);
      expect(receipt).toMatchObject({
        outcome: "Committed",
        artifactKind: kind,
        intentDigest: hash(canonical(c)),
        snapshot: {
          artifactReference: id(100),
          revision: 1,
          previousArtifactReference: null,
          content: content(kind),
        },
      });
      expect(f.locks.slice(0, 2)).toEqual([
        `ReceiptTemplateArtifactOperation:${c.operationReference}`,
        `ReceiptTemplateArtifactRoot:${id(1)}:${id(2)}:${id(3)}:${kind}`,
      ]);
      expect(f.audits).toEqual([
        {
          ...f.scope,
          artifactKind: kind,
          operationReference: c.operationReference,
          auditReference: id(101),
          intentDigest: receipt.intentDigest,
          purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
          mode: "Save",
          occurredAt: at,
        },
      ]);
      f.guards.push(async () => {
        f.clearScope();
      });
      await f.finish();
      expect(f.sql.filter((s) => s.startsWith("SET CONSTRAINTS"))).toEqual([
        "SET CONSTRAINTS rms_device.digital_receipt_template_artifact_version_coherence,rms_device.digital_receipt_template_artifact_operation_coherence IMMEDIATE",
      ]);
    },
  );
  it("new Manager successor preserves root creation while exact older artifact remains selectable", async () => {
    const first = fixture(),
      old = await first.store.save(first.save());
    await first.finish();
    if (!old.snapshot) throw new Error("expected snapshot");
    const next = fixture(first.db, id(9));
    next.clock("2026-10-05T10:00:01.000Z");
    const updated = await next.store.save(
      next.save("Layout", id(6), old.snapshot.artifactReference, 1),
    );
    await next.finish();
    expect(updated.snapshot).toMatchObject({
      previousArtifactReference: old.snapshot.artifactReference,
      revision: 2,
      authoredByReference: id(9),
      createdAt: at,
      updatedAt: "2026-10-05T10:00:01.000Z",
    });
    const exact = fixture(first.db, id(9));
    expect(
      await exact.store.readVersion({
        artifactKind: "Layout",
        artifactReference: old.snapshot.artifactReference,
      }),
    ).toEqual(old.snapshot);
    expect(
      exact.holds.every(
        (h) =>
          h.artifactKind === "Layout" &&
          h.targetArtifactReference === old.snapshot?.artifactReference,
      ),
    ).toBe(true);
    await exact.finish();
  });
  it("original Save and Resolve replay exact old receipt after successor without allocations or flush", async () => {
    const f = fixture(),
      c = f.save(),
      receipt = await f.store.save(c);
    await f.finish();
    if (!receipt.snapshot) throw new Error("snapshot missing");
    const newer = fixture(f.db);
    await newer.store.save(newer.save("Layout", id(6), receipt.snapshot.artifactReference, 1));
    await newer.finish();
    for (const mode of ["Save", "Resolve"]) {
      const retry = fixture(f.db);
      expect(
        mode === "Save" ? await retry.store.save(c) : await retry.store.resolve(retry.resolve(c)),
      ).toEqual(receipt);
      await retry.finish();
      expect(retry.audits).toEqual([]);
      expect(retry.options.references.nextReference).not.toHaveBeenCalled();
      expect(retry.sql.some((s) => s.startsWith("SET CONSTRAINTS"))).toBe(false);
    }
  });
  it("absent Resolve durably Abandons and late Save never creates artifact", async () => {
    const f = fixture(),
      c = f.save("Compliance"),
      receipt = await f.store.resolve(f.resolve(c));
    await f.finish();
    expect(receipt).toMatchObject({ outcome: "Abandoned", snapshot: null });
    expect(f.db.versions).toEqual([]);
    const late = fixture(f.db);
    expect(await late.store.save(c)).toEqual(receipt);
    await late.finish();
    expect(late.audits).toEqual([]);
    expect(late.options.references.nextReference).not.toHaveBeenCalled();
  });
  it.each(["kind", "pins", "digest"])(
    "changed original %s cannot replace terminal",
    async (field) => {
      const f = fixture(),
        c = f.save();
      await f.store.save(c);
      await f.finish();
      const retry = fixture(f.db),
        changed =
          field === "kind"
            ? retry.save("Compliance")
            : field === "pins"
              ? retry.save("Layout", c.operationReference, id(100), 1)
              : { ...retry.resolve(c), intentDigest: hash("changed") };
      await expect(
        field === "digest" ? retry.store.resolve(changed) : retry.store.save(changed),
      ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
      expect(retry.audits).toEqual([]);
    },
  );
  it("foreign scope and original Actor denied without new Audit/allocation", async () => {
    const f = fixture();
    await expect(f.store.save({ ...f.save(), storeReference: id(99) })).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
    });
    expect(f.sql).toEqual([]);
    const first = fixture(),
      c = first.save();
    await first.store.save(c);
    await first.finish();
    const actor = fixture(first.db, id(9));
    await expect(actor.store.resolve(actor.resolve(c))).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
    });
    expect(actor.audits).toEqual([]);
  });
  it("stale CAS has no allocation or Audit", async () => {
    const f = fixture();
    await f.store.save(f.save());
    await f.finish();
    const stale = fixture(f.db);
    await expect(stale.store.save(stale.save("Layout", id(6)))).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_CONFLICT",
    });
    expect(stale.options.references.nextReference).not.toHaveBeenCalled();
    expect(stale.audits).toEqual([]);
  });
  it("unknown exact kind/reference is truthful absence, with no latest fallback", async () => {
    const f = fixture();
    await f.store.save(f.save());
    await f.finish();
    const missing = fixture(f.db);
    expect(
      await missing.store.readVersion({ artifactKind: "Compliance", artifactReference: id(100) }),
    ).toBeNull();
    await missing.finish();
    expect(missing.audits).toEqual([]);
  });
  it("late permission withdrawal and shorter actual lease cannot finalize", async () => {
    const f = fixture();
    await f.store.save(f.save());
    f.withdraw();
    await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_PERMISSION_DENIED" });
    expect(() => f.store.assertFinalized(f.tx)).toThrow();
    const short = fixture();
    short.shorten("2026-10-05T10:00:02.000Z");
    expect((await short.store.readCurrent()).validUntil).toBe("2026-10-05T10:00:02.000Z");
    short.clock("2026-10-05T10:00:02.000Z");
    await expect(short.finish()).rejects.toMatchObject(unavailable);
  });
  it("current absence changes fail final guard", async () => {
    const f = fixture();
    await f.store.readCurrent();
    const other = fixture(f.db);
    await other.store.save(other.save());
    await other.finish();
    await expect(f.finish()).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
  });
  it.each(["content", "operation", "receipt"])(
    "corrupt immutable %s refuses recovery",
    async (field) => {
      const f = fixture(),
        c = f.save();
      await f.store.save(c);
      await f.finish();
      const row = f.db.versions[0],
        op = f.db.operations[0];
      if (!row || !op) throw new Error("records missing");
      if (field === "content") row.snapshot_json = {};
      else if (field === "operation") row.operation_id = id(99);
      else op.audit_reference = "bad";
      const retry = fixture(f.db);
      await expect(retry.store.resolve(retry.resolve(c))).rejects.toMatchObject(unavailable);
    },
  );
  it("named constraint refusal poisons source without granting finalization", async () => {
    const f = fixture();
    await f.store.resolve(f.resolve(f.save()));
    f.denyFlush();
    await expect(f.finish()).rejects.toMatchObject(unavailable);
    expect(() => f.store.assertFinalized(f.tx)).toThrow();
  });
  it("query port drift, nonvoid register and malformed proof fail closed", async () => {
    const f = fixture();
    await f.store.readCurrent();
    f.tx.query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    await expect(f.finish()).rejects.toMatchObject(unavailable);
    const register = fixture();
    Object.defineProperty(register.options, "registerBeforeCommit", { value: () => true });
    await expect(
      createPostgresDigitalReceiptTemplateArtifactStore(register.options).readCurrent(),
    ).rejects.toMatchObject(unavailable);
    const proof = fixture();
    proof.options.authority.holdUntilTransactionCompletes = vi.fn(async () => ({
      validUntil: until,
      allowed: true,
    }));
    await expect(
      createPostgresDigitalReceiptTemplateArtifactStore(proof.options).readCurrent(),
    ).rejects.toMatchObject(unavailable);
  });
  it("mode switch and historical retargeting cannot invert root/original locks", async () => {
    const f = fixture();
    await f.store.readCurrent();
    await expect(f.store.save(f.save())).rejects.toMatchObject(unavailable);
    const exact = fixture();
    await exact.store.readVersion({ artifactKind: "Layout", artifactReference: id(80) });
    await expect(
      exact.store.readVersion({ artifactKind: "Compliance", artifactReference: id(81) }),
    ).rejects.toMatchObject(unavailable);
  });
  it("missing/double hooks and wrong outer transaction cannot produce final source", async () => {
    const f = fixture();
    await f.store.readCurrent();
    expect(() => f.store.assertFinalized(f.tx)).toThrow();
    const done = fixture();
    await done.store.readCurrent();
    await done.finish();
    expect(() => done.store.assertFinalized({ query: done.tx.query })).toThrow();
    const twice = fixture();
    await twice.store.readCurrent();
    await twice.finish();
    expect(() => twice.finals[0]?.()).toThrow();
  });
  it("Audit reentry poisons before terminal append", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "appendAudit", {
      value: async () => {
        await expect(owning.readCurrent()).rejects.toMatchObject(unavailable);
      },
    });
    const owning = createPostgresDigitalReceiptTemplateArtifactStore(f.options);
    await expect(owning.save(f.save())).rejects.toMatchObject(unavailable);
    expect(f.db.operations).toEqual([]);
  });
});
