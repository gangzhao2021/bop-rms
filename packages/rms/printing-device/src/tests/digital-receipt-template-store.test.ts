// Actual Device parser, publication store and Audit writer with controlled SQL;
// this is component transaction evidence, not native IAM or Publishing qualification.
import { expect, it, vi } from "vitest";
import {
  createPostgresDigitalReceiptTemplateStore,
  type ReceiptTemplateTransaction,
} from "../infrastructure/persistence/digital-receipt-template-store.js";
import {
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateVersion,
} from "../contracts/digital-receipt-template.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T10:00:00.000Z";
function input(number = 1) {
  const version = parseDigitalReceiptTemplateVersion({
    templateReference: id(1),
    versionReference: id(100 + number),
    versionNumber: number,
    versionCode: `RECEIPT_${number}`,
    brandReference: id(3),
    storeReference: id(4),
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(5),
    complianceRuleReference: id(6),
    requiredFields: [...digitalReceiptRequiredFields],
    publicationReference: id(200 + number),
    publishedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
  });
  return {
    version,
    operationReference: id(300 + number),
    publicationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(version)),
    audit: {
      auditId: id(400 + number),
      brandId: id(3),
      storeId: id(4),
      actor: { type: "System" },
      actionCode: "RECEIPT_TEMPLATE_PUBLISH",
      targetType: "DigitalReceiptTemplate",
      targetId: version.versionReference,
      reasonCode: "SYNTHETIC_TEMPLATE_PUBLICATION",
      correlationId: id(300 + number),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  };
}
function fixture() {
  const database = {
    versions: [] as Record<string, unknown>[],
    audits: [] as (readonly unknown[])[],
    sequence: 1,
    hash: null as string | null,
    outer: [] as string[],
  };
  const controls = { failAudit: false },
    sql: string[] = [];
  let savepoint: typeof database | undefined;
  const copy = () => ({
    ...database,
    versions: [...database.versions],
    audits: [...database.audits],
    outer: [...database.outer],
  });
  const query = vi.fn<ReceiptTemplateTransaction["query"]>(async (statement, values) => {
    sql.push(statement);
    if (statement.startsWith("SAVEPOINT")) {
      savepoint = copy();
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("ROLLBACK TO")) {
      if (!savepoint) throw new Error("fixture savepoint missing");
      Object.assign(database, savepoint);
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("RELEASE SAVEPOINT")) {
      savepoint = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("SELECT set_config") || statement.startsWith("SELECT pg_advisory"))
      return { rows: [], rowCount: 1 };
    if (statement.startsWith("SELECT version_json")) {
      const rows = database.versions.filter((row) => row.operation_id === values[2]);
      return { rows, rowCount: rows.length };
    }
    if (statement.startsWith("SELECT version_id")) {
      const rows = database.versions.filter((row) => row.template_id === values[2]);
      return { rows, rowCount: rows.length };
    }
    if (statement.startsWith("INSERT INTO rms_device.digital_receipt_template_version")) {
      database.versions.push({
        version_id: values[0],
        brand_id: values[1],
        store_id: values[2],
        template_id: values[3],
        version_number: String(values[4]),
        version_code: values[5],
        operation_id: values[6],
        audit_id: values[7],
        publication_id: values[8],
        publication_digest: values[9],
        published_at: values[10],
        version_json: JSON.parse(String(values[11])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO platform_audit.audit_chain_head"))
      return { rows: [], rowCount: 1 };
    if (statement.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(database.sequence),
            previous_hash: database.hash,
            recorded_at: at,
          },
        ],
        rowCount: 1,
      };
    if (statement.startsWith("INSERT INTO platform_audit.audit_record")) {
      if (controls.failAudit) throw new Error("controlled Audit insertion failure");
      database.audits.push(values);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("UPDATE platform_audit.audit_chain_head")) {
      database.sequence++;
      database.hash = Buffer.isBuffer(values[2]) ? values[2].toString("hex") : null;
      return { rows: [{ next_sequence: String(database.sequence) }], rowCount: 1 };
    }
    throw new Error("unexpected controlled owning query");
  });
  const tx: ReceiptTemplateTransaction = { query };
  type Options = Parameters<typeof createPostgresDigitalReceiptTemplateStore>[0];
  const authorize = vi.fn<Options["authorize"]>(async () => true),
    proof = vi.fn<Options["validatePublication"]>(async () => true),
    current = vi.fn<Options["isCurrentPublication"]>(async () => false);
  const options = {
    brandReference: id(3),
    storeReference: id(4),
    authorize,
    validatePublication: proof,
    isCurrentPublication: current,
  };
  const store = createPostgresDigitalReceiptTemplateStore(options);
  const run = async <T>(work: () => Promise<T>) => {
    const original = copy();
    try {
      return await work();
    } catch (error) {
      Object.assign(database, original);
      throw error;
    }
  };
  return { database, controls, sql, tx, query, authorize, proof, current, options, store, run };
}
it("held append uses actual Audit and publication validation without any internal SAVEPOINT", async () => {
  const f = fixture(),
    candidate = input(),
    result = await f.run(() => f.store.appendPublishedInTransaction(f.tx, candidate));
  expect(result).toEqual({ status: "Created", version: candidate.version });
  expect(f.database.versions).toHaveLength(1);
  expect(f.database.audits).toHaveLength(1);
  expect(f.proof).toHaveBeenCalledWith(f.tx, candidate.version, candidate.publicationDigest);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.sql.some((sql) => /SAVEPOINT|ROLLBACK|COMMIT/u.test(sql))).toBe(false);
});
it("Audit insertion failure rolls back the whole outer unit, and swallowed failure cannot reuse this transaction", async () => {
  const f = fixture();
  f.controls.failAudit = true;
  await expect(
    f.run(async () => {
      f.database.outer.push("controlled earlier outer effect");
      return f.store.appendPublishedInTransaction(f.tx, input());
    }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(f.database.versions).toEqual([]);
  expect(f.database.audits).toEqual([]);
  expect(f.database.outer).toEqual([]);
  expect(f.database.sequence).toBe(1);
  const calls = f.query.mock.calls.length;
  f.controls.failAudit = false;
  await expect(f.store.appendPublishedInTransaction(f.tx, input())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_UNAVAILABLE",
  });
  expect(f.query).toHaveBeenCalledTimes(calls);
  expect(f.sql.some((sql) => /SAVEPOINT/u.test(sql))).toBe(false);
});
it("legacy append retains its local SAVEPOINT rollback and can continue on the same transaction", async () => {
  const f = fixture();
  f.controls.failAudit = true;
  await expect(f.store.appendPublished(f.tx, input())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_UNAVAILABLE",
  });
  expect(f.database.versions).toEqual([]);
  expect(f.sql).toContain("SAVEPOINT receipt_template_publish");
  expect(f.sql).toContain("ROLLBACK TO SAVEPOINT receipt_template_publish");
  expect(f.sql).toContain("RELEASE SAVEPOINT receipt_template_publish");
  f.controls.failAudit = false;
  expect((await f.store.appendPublished(f.tx, input())).status).toBe("Created");
});
it("exact original replay creates no Audit or new version and skips today's publication validation", async () => {
  const f = fixture(),
    candidate = input();
  await f.store.appendPublishedInTransaction(f.tx, candidate);
  f.proof.mockResolvedValue(false);
  expect((await f.store.appendPublishedInTransaction(f.tx, candidate)).status).toBe("Existing");
  expect(f.proof).toHaveBeenCalledTimes(1);
  expect(f.database.versions).toHaveLength(1);
  expect(f.database.audits).toHaveLength(1);
  await expect(
    f.store.appendPublishedInTransaction(f.tx, {
      ...candidate,
      publicationDigest: `sha256:${"f".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_CONFLICT" });
});
it("sequence conflict is finite and does not write a version or Audit", async () => {
  const f = fixture();
  await expect(f.store.appendPublishedInTransaction(f.tx, input(2))).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_CONFLICT",
  });
  expect(f.database.versions).toEqual([]);
  expect(f.database.audits).toEqual([]);
  expect(f.proof).not.toHaveBeenCalled();
});
it("missing public publication proof and late permission withdrawal both refuse before insertion", async () => {
  const missing = fixture();
  missing.proof.mockResolvedValue(false);
  await expect(
    missing.store.appendPublishedInTransaction(missing.tx, input()),
  ).rejects.toMatchObject({ code: "RECEIPT_TEMPLATE_UNAVAILABLE" });
  expect(missing.database.versions).toEqual([]);
  const late = fixture();
  late.authorize
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  await expect(late.store.appendPublishedInTransaction(late.tx, input())).rejects.toMatchObject({
    code: "RECEIPT_TEMPLATE_PERMISSION_DENIED",
  });
  expect(late.database.versions).toEqual([]);
  expect(late.database.audits).toEqual([]);
});
it.each(["authorize", "proof", "query"] as const)(
  "held append captures %s port identity through awaited owner callbacks",
  async (mode) => {
    const f = fixture();
    f.authorize.mockImplementationOnce(async () => {
      if (mode === "authorize")
        f.options.authorize = vi.fn<
          Parameters<typeof createPostgresDigitalReceiptTemplateStore>[0]["authorize"]
        >(async () => true);
      if (mode === "proof")
        f.options.validatePublication = vi.fn<
          Parameters<typeof createPostgresDigitalReceiptTemplateStore>[0]["validatePublication"]
        >(async () => true);
      if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      return true;
    });
    await expect(f.store.appendPublishedInTransaction(f.tx, input())).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    expect(f.database.versions).toEqual([]);
    expect(f.database.audits).toEqual([]);
    expect(f.query).not.toHaveBeenCalled();
  },
);
it("rejects foreign Store and mismatched Audit correlation without owner writes", async () => {
  for (const alter of ["Store", "Audit"]) {
    const f = fixture(),
      candidate = input(),
      packet =
        alter === "Store"
          ? { ...candidate, version: { ...candidate.version, storeReference: id(99) } }
          : { ...candidate, audit: { ...candidate.audit, correlationId: id(99) } };
    await expect(f.store.appendPublishedInTransaction(f.tx, packet)).rejects.toMatchObject({
      code: "RECEIPT_TEMPLATE_UNAVAILABLE",
    });
    expect(f.query).not.toHaveBeenCalled();
  }
});
