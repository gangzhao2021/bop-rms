import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresDigitalReceiptTemplateSubmitStore,
  digitalReceiptTemplateSubmitRequiredFields,
  type DigitalReceiptTemplateSubmitStoreOptions,
  type DigitalReceiptTemplateSubmitTransaction,
} from "../infrastructure/persistence/digital-receipt-template-submit-store.js";
import {
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitReceipt,
  type DigitalReceiptTemplateSubmitReceipt,
} from "../contracts/digital-receipt-template-submit.js";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "../contracts/digital-receipt-template-submission.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const command = () =>
  parseDigitalReceiptTemplateSubmit({
    profile: "DigitalReceiptTemplateSubmitV1",
    ...scope,
    operationReference: id(5),
    templateReference: id(6),
    expectedVersionReference: id(7),
    expectedRevision: 2,
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
  });
const resolveCommand = () => ({
  ...command(),
  profile: "DigitalReceiptTemplateSubmitResolveV1",
  intentDigest: hash(command()),
});
const submission = () =>
  parseDigitalReceiptTemplateSubmission({
    profile: "DigitalReceiptTemplateSubmissionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(6),
    familyReference: id(8),
    versionReference: id(7),
    draftRevision: 2,
    contentDigest: "sha256:" + "a".repeat(64),
    authoredByReference: id(9),
    submittedByReference: id(4),
    operationReference: id(5),
    reviewLifecycleReference: id(10),
    reviewVersion: 2,
    validationEvidenceReference: id(11),
    checkedAt: at,
    validationValidUntil: "2026-10-05T10:01:00.000Z",
    submittedAt: at,
    auditReference: id(12),
    dataClassification: "Internal",
  });
function database() {
  return {
    receipt: null as DigitalReceiptTemplateSubmitReceipt | null,
    submission: null as DigitalReceiptTemplateSubmission | null,
    corruptReceipt: false,
    corruptSubmission: false,
    hiddenCollision: false,
  };
}
function receiptRow(value: DigitalReceiptTemplateSubmitReceipt) {
  return {
    operation_id: value.operationReference,
    tenant_id: value.tenantReference,
    brand_id: value.brandReference,
    store_id: value.storeReference,
    actor_id: value.actorReference,
    template_id: value.templateReference,
    expected_version_id: value.expectedVersionReference,
    expected_revision: String(value.expectedRevision),
    intent_digest: value.intentDigest,
    outcome: value.outcome,
    result_review_lifecycle_id: value.submission?.reviewLifecycleReference ?? null,
    result_review_version: value.submission ? String(value.submission.reviewVersion) : null,
    submission_digest: value.submission ? hash(value.submission) : null,
    audit_reference: value.auditReference,
    occurred_at: value.occurredAt,
    receipt_json: value,
    receipt_digest: hash(value),
  };
}
/** Controlled owning SQL transport; real factory, parsers, canonical intent and all mandatory hooks execute. */
function fixture(db = database(), origin = at, end = until) {
  let now = origin,
    lease = end,
    deny = false,
    persistSubmission = true,
    isolation = "read committed";
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    audit: unknown[] = [],
    lockKeys: unknown[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("set_config('lock_timeout'")) {
      expect(Number(values[0])).toBeGreaterThan(0);
      expect(Number(values[0])).toBeLessThanOrEqual(5000);
      return { rows: [] };
    }
    if (sql.includes("set_config('bop.tenant_id'")) {
      expect(values).toEqual([id(1), id(2), id(3)]);
      return { rows: [] };
    }
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation }] };
    if (sql.includes("pg_advisory_xact_lock")) {
      lockKeys.push(values[0]);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT") && sql.includes("digital_receipt_template_submit_operation")) {
      const row = db.receipt ? receiptRow(db.receipt) : null;
      return {
        rows: row
          ? [
              {
                ...row,
                receipt_digest: db.corruptReceipt ? "sha256:" + "f".repeat(64) : row.receipt_digest,
              },
            ]
          : [],
      };
    }
    if (sql.startsWith("INSERT INTO rms_device.digital_receipt_template_submission")) {
      expect(values).toHaveLength(20);
      const value = parseDigitalReceiptTemplateSubmission(JSON.parse(String(values[18])));
      expect(values[19]).toBe(hash(value));
      db.submission = value;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT record_json,record_digest"))
      return {
        rows: db.submission
          ? [
              {
                record_json: db.submission,
                record_digest: db.corruptSubmission
                  ? "sha256:" + "f".repeat(64)
                  : hash(db.submission),
              },
            ]
          : [],
      };
    if (sql.startsWith("INSERT INTO rms_device.digital_receipt_template_submit_operation")) {
      if (db.hiddenCollision)
        throw Object.assign(new Error("controlled collision"), { code: "23505" });
      expect(db.receipt).toBeNull();
      expect(values).toHaveLength(17);
      const value = parseDigitalReceiptTemplateSubmitReceipt(JSON.parse(String(values[15])));
      expect(values[16]).toBe(hash(value));
      expect(values[12]).toBe(value.submission ? hash(value.submission) : null);
      db.receipt = value;
      return { rowCount: 1, rows: [] };
    }
    throw new Error("unexpected controlled owner query");
  });
  const tx: DigitalReceiptTemplateSubmitTransaction = { query };
  const hold = vi.fn(
    async (
      actual: DigitalReceiptTemplateSubmitTransaction,
      input: Parameters<
        DigitalReceiptTemplateSubmitStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1],
    ) => {
      expect(actual).toBe(tx);
      expect(input).toEqual(
        expect.objectContaining({
          ...scope,
          permission: "publishing.review.submit",
          purposeCode: "RECEIPT_TEMPLATE_REVIEW",
          requiredFields: digitalReceiptTemplateSubmitRequiredFields,
        }),
      );
      if (deny) throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      return { validUntil: lease };
    },
  );
  const submit = vi.fn(
    async (actual: DigitalReceiptTemplateSubmitTransaction, input: ReturnType<typeof command>) => {
      expect(actual).toBe(tx);
      expect(input).toEqual(command());
      const value = submission();
      if (persistSubmission)
        await actual.query(
          "INSERT INTO rms_device.digital_receipt_template_submission(tenant_id,brand_id,store_id,template_id,family_id,version_id,draft_revision,content_digest,authored_by_id,submitted_by_id,operation_id,review_lifecycle_id,review_version,validation_evidence_id,checked_at,validation_valid_until,submitted_at,audit_reference,data_classification,record_json,record_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'Internal',$19::jsonb,$20)",
          [
            value.tenantReference,
            value.brandReference,
            value.storeReference,
            value.templateReference,
            value.familyReference,
            value.versionReference,
            value.draftRevision,
            value.contentDigest,
            value.authoredByReference,
            value.submittedByReference,
            value.operationReference,
            value.reviewLifecycleReference,
            value.reviewVersion,
            value.validationEvidenceReference,
            value.checkedAt,
            value.validationValidUntil,
            value.submittedAt,
            value.auditReference,
            canonicalizeRfc8785(value),
            hash(value),
          ],
        );
      return value;
    },
  );
  const append = vi.fn(
    async (
      actual: DigitalReceiptTemplateSubmitTransaction,
      input: Parameters<DigitalReceiptTemplateSubmitStoreOptions["appendAbandonedIntent"]>[1],
    ) => {
      expect(actual).toBe(tx);
      expect(input.command).toEqual(resolveCommand());
      expect(input.intentDigest).toBe(hash(command()));
      audit.push(input);
      return { auditReference: id(13), occurredAt: input.occurredAt };
    },
  );
  const register = vi.fn(
    async (
      actual: DigitalReceiptTemplateSubmitTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
  );
  const options: DigitalReceiptTemplateSubmitStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: origin,
    originalValidUntil: end,
    references: {
      canonicalize: canonicalizeRfc8785,
      hashIntent: (text) => "sha256:" + sha256Hex(text),
    },
    registerBeforeCommit: register,
    authority: { holdUntilTransactionCompletes: hold },
    submitReview: submit,
    appendAbandonedIntent: append,
  };
  const owner = createPostgresDigitalReceiptTemplateSubmitStore(options);
  const finalize = async () => {
    for (const guard of guards) await guard();
    for (const final of finals) final();
    return owner.assertFinalized(tx);
  };
  return {
    db,
    owner,
    options,
    tx,
    query,
    hold,
    submit,
    append,
    register,
    guards,
    finals,
    audit,
    lockKeys,
    finalize,
    setNow: (value: string) => {
      now = value;
    },
    setLease: (value: string) => {
      lease = value;
    },
    deny: () => {
      deny = true;
    },
    unpersisted: () => {
      persistSubmission = false;
    },
    isolation: (v: string) => {
      isolation = v;
    },
  };
}
const required = <T>(list: readonly T[], index = 0): T => {
  const value = list[index];
  if (value === undefined) throw new Error("required controlled hook missing");
  return value;
};
it("persists actual Submission and one terminal receipt in the identical transaction without another Audit", async () => {
  const f = fixture(),
    result = await f.owner.submit(command());
  expect(result.outcome).toBe("Committed");
  expect(result.submission).toEqual(f.db.submission);
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.append).not.toHaveBeenCalled();
  expect(f.audit).toEqual([]);
  expect(f.lockKeys.slice(0, 2)).toEqual([
    `ReceiptTemplateSubmitOperation:${id(5)}`,
    `ReceiptTemplate:${id(2)}:${id(3)}:${id(6)}`,
  ]);
  expect(await f.finalize()).toBe(until);
  expect(f.hold).toHaveBeenCalledTimes(4);
});
it("recovers original Submit and Resolve after business evidence expiry using fresh current IAM only", async () => {
  const first = fixture();
  const original = await first.owner.submit(command());
  await first.finalize();
  for (const mode of ["submit", "resolve"] as const) {
    const f = fixture(first.db, "2026-10-05T10:02:00.000Z", "2026-10-05T10:02:05.000Z");
    expect(
      await (mode === "submit" ? f.owner.submit(command()) : f.owner.resolve(resolveCommand())),
    ).toEqual(original);
    await f.finalize();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  }
});
it("durably resolves genuine absence using same-transaction intent Audit, then refuses a late Submit producer", async () => {
  const first = fixture(),
    receipt = await first.owner.resolve(resolveCommand());
  expect(receipt.outcome).toBe("Abandoned");
  expect(receipt.submission).toBeNull();
  expect(first.append).toHaveBeenCalledTimes(1);
  expect(first.audit).toHaveLength(1);
  await first.finalize();
  const late = fixture(first.db);
  expect(await late.owner.submit(command())).toEqual(receipt);
  await late.finalize();
  expect(late.submit).not.toHaveBeenCalled();
  expect(late.append).not.toHaveBeenCalled();
});
it("retains isolated legacy 006 provenance without backfilling a terminal or allocating new Audit", async () => {
  const db = database();
  db.submission = submission();
  const f = fixture(db),
    result = await f.owner.submit(command());
  expect(result.submission).toEqual(db.submission);
  expect(db.receipt).toBeNull();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.append).not.toHaveBeenCalled();
  await f.finalize();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("refuses an unpersisted positive producer packet and poisons swallowed failure before commit", async () => {
  const f = fixture();
  f.unpersisted();
  await expect(f.owner.submit(command())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.db.receipt).toBeNull();
  await expect(required(f.guards)()).rejects.toThrow();
  expect(() => required(f.finals)()).toThrow();
});
it.each([
  { expectedRevision: 3 },
  { expectedVersionReference: id(30) },
  { templateReference: id(31) },
])("rejects changed original pins %j", async (change) => {
  const original = fixture();
  await original.owner.submit(command());
  await original.finalize();
  const f = fixture(original.db);
  await expect(f.owner.submit({ ...command(), ...change })).rejects.toThrow(
    "RECEIPT_TEMPLATE_CONFLICT",
  );
  expect(f.submit).not.toHaveBeenCalled();
});
it("rejects changed Actor and original digest before any producer", async () => {
  const f = fixture();
  await expect(f.owner.submit({ ...command(), actorReference: id(30) })).rejects.toThrow(
    "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  );
  expect(f.submit).not.toHaveBeenCalled();
  const g = fixture();
  await expect(
    g.owner.resolve({ ...resolveCommand(), intentDigest: "sha256:" + "f".repeat(64) }),
  ).rejects.toThrow("RECEIPT_TEMPLATE_CONFLICT");
  expect(g.append).not.toHaveBeenCalled();
});
it("checks genuine IAM on replay and again in the async final guard", async () => {
  const original = fixture();
  await original.owner.submit(command());
  await original.finalize();
  const replay = fixture(original.db);
  replay.deny();
  await expect(replay.owner.submit(command())).rejects.toThrow(
    "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  );
  const f = fixture();
  await f.owner.submit(command());
  f.deny();
  await expect(required(f.guards)()).rejects.toThrow("RECEIPT_TEMPLATE_PERMISSION_DENIED");
  expect(() => required(f.finals)()).toThrow();
});
it("reinstates the exact owning scope after every authority checkpoint", async () => {
  const f = fixture();
  await f.owner.submit(command());
  await f.finalize();
  const calls = f.query.mock.calls;
  expect(
    calls.filter(([sql]) => sql.includes("set_config('bop.tenant_id'")).length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    calls
      .filter(([sql]) => sql.includes("set_config('bop.tenant_id'"))
      .every(
        ([, values]) => canonicalizeRfc8785(values) === canonicalizeRfc8785([id(1), id(2), id(3)]),
      ),
  ).toBe(true);
});
it("requires both exact-once hooks before final assertion, rejecting repeats and late clock expiry", async () => {
  const f = fixture();
  await f.owner.submit(command());
  expect(() => f.owner.assertFinalized(f.tx)).toThrow();
  const g = fixture();
  await g.owner.submit(command());
  await required(g.guards)();
  required(g.finals)();
  expect(() => required(g.finals)()).toThrow();
  const h = fixture();
  await h.owner.submit(command());
  await required(h.guards)();
  h.setNow(until);
  expect(() => required(h.finals)()).toThrow();
});
it("rejects original shorter lease and clock rollback without renewed time", async () => {
  const f = fixture();
  f.setLease("2026-10-05T10:00:01.000Z");
  await f.owner.submit(command());
  f.setNow("2026-10-05T10:00:01.000Z");
  await expect(required(f.guards)()).rejects.toThrow();
  const g = fixture();
  g.setNow("2026-10-05T09:59:59.999Z");
  await expect(g.owner.submit(command())).rejects.toThrow();
  expect(g.submit).not.toHaveBeenCalled();
});
it("rejects captured query or authority object drift and immutable receipt tampering", async () => {
  const f = fixture();
  await f.owner.submit(command());
  f.tx.query = async () => ({ rows: [] });
  await expect(required(f.guards)()).rejects.toThrow();
  const g = fixture();
  await g.owner.submit(command());
  Object.defineProperty(g.options, "authority", {
    value: { ...g.options.authority },
    enumerable: true,
  });
  await expect(required(g.guards)()).rejects.toThrow();
  const h = fixture();
  await h.owner.submit(command());
  h.db.corruptReceipt = true;
  await expect(required(h.guards)()).rejects.toThrow();
});
it("refuses changed submission digest in original replay and final provenance checks", async () => {
  const f = fixture();
  await f.owner.submit(command());
  f.db.corruptSubmission = true;
  await expect(required(f.guards)()).rejects.toThrow();
  const g = fixture(f.db);
  await expect(g.owner.submit(command())).rejects.toThrow();
  expect(g.submit).not.toHaveBeenCalled();
});
it("rejects reentry during a producer and preserves poison even if the producer swallows it", async () => {
  const f = fixture();
  f.submit.mockImplementationOnce(async () => {
    await expect(f.owner.submit(command())).rejects.toThrow();
    return submission();
  });
  await expect(f.owner.submit(command())).rejects.toThrow();
  expect(f.db.receipt).toBeNull();
  await expect(required(f.guards)()).rejects.toThrow();
});
it("does not report Abandoned when a hidden global operation collides on the real INSERT", async () => {
  const f = fixture();
  f.db.hiddenCollision = true;
  await expect(f.owner.resolve(resolveCommand())).rejects.toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  expect(f.db.receipt).toBeNull();
  await expect(required(f.guards)()).rejects.toThrow();
});
it("rejects malformed/accessor input, unsupported isolation and non-void hook registration", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(6));
  await expect(
    f.owner.submit(
      Object.defineProperty({ ...command() }, "templateReference", {
        enumerable: true,
        get: getter,
      }),
    ),
  ).rejects.toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
  const g = fixture();
  g.isolation("repeatable read");
  await expect(g.owner.submit(command())).rejects.toThrow();
  expect(g.submit).not.toHaveBeenCalled();
  const h = fixture();
  Object.defineProperty(h.options, "registerBeforeCommit", {
    value: async () => true,
    enumerable: true,
  });
  const owner = createPostgresDigitalReceiptTemplateSubmitStore(h.options);
  await expect(owner.submit(command())).rejects.toThrow();
  expect(h.query).not.toHaveBeenCalled();
});
it("rejects a foreign transaction at final assertion and receipt drift after a passed async guard", async () => {
  const f = fixture();
  await f.owner.submit(command());
  await required(f.guards)();
  required(f.finals)();
  expect(() => f.owner.assertFinalized({ query: f.query })).toThrow();
  const g = fixture();
  await g.owner.submit(command());
  await required(g.guards)();
  Object.defineProperty(g.options.clock, "now", { value: () => at });
  expect(() => required(g.finals)()).toThrow();
});
