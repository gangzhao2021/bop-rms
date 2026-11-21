import { describe, expect, it } from "vitest";
import {
  appendPlatformAuditRecordInTransaction,
  verifyPlatformAuditChain,
  type AppendPlatformAuditRecordInput,
  type AuditTransaction,
} from "../index.js";
const id = (n: number) => `018f2000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";
const input: AppendPlatformAuditRecordInput = {
  auditReference: id(1),
  actorReference: id(2),
  purposeCode: "PLATFORM_BRAND_TEMPLATE",
  actionCode: "PLATFORM_BRAND_TEMPLATE_SAVED",
  targetType: "PlatformBrandTemplate",
  targetReference: id(3),
  operationReference: id(4),
  intentDigest: `sha256:${"a".repeat(64)}`,
  occurredAt: at,
  reasonCode: "ADMIN_CONFIGURATION",
  retentionPolicyCode: "CONFIGURATION_AUDIT",
  retentionPolicyVersion: 1,
};
function transaction(
  options: {
    failStep?: number;
    nextSequence?: string;
    wrongInsert?: boolean;
    wrongAdvance?: boolean;
  } = {},
) {
  let sequence = options.nextSequence ?? "1",
    previous: string | null = null;
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: AuditTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (calls.length === options.failStep) throw new Error("PRIVATE_DATABASE_FAILURE");
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head"))
        return { rows: [] };
      if (sql.includes("FOR UPDATE"))
        return { rows: [{ next_sequence: sequence, previous_hash: previous, recorded_at: at }] };
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record"))
        return { rows: [{ audit_reference: options.wrongInsert ? id(9) : values[0] }] };
      if (sql.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")) {
        const hash = values[2];
        if (!Buffer.isBuffer(hash)) throw new Error("Invalid fixture hash");
        previous = hash.toString("hex");
        sequence = String(Number(sequence) + 1);
        return { rows: options.wrongAdvance ? [] : [{ next_sequence: sequence }] };
      }
      throw new Error("Unexpected SQL");
    },
  };
  return { tx, calls };
}
describe("transactional Platform Audit append", () => {
  it("initializes, locks, appends and CAS advances using the caller transaction", async () => {
    const fixture = transaction();
    const first = await appendPlatformAuditRecordInTransaction(fixture.tx, input);
    const second = await appendPlatformAuditRecordInTransaction(fixture.tx, {
      ...input,
      auditReference: id(5),
    });
    expect(verifyPlatformAuditChain([first, second])).toBe(true);
    expect(fixture.calls).toHaveLength(8);
    expect(fixture.calls[0]?.values).toEqual([input.actorReference, input.purposeCode]);
    expect(fixture.calls[1]?.sql).toContain("FOR UPDATE");
    expect(fixture.calls[2]?.values[7]).toEqual(Buffer.from(input.intentDigest.slice(7), "hex"));
    expect(fixture.calls[3]?.values[3]).toBe(1);
    expect(fixture.calls[3]?.values[4]).toBeNull();
    expect(fixture.calls[7]?.values[4]).toEqual(Buffer.from(first.recordHash, "hex"));
    expect(Object.isFrozen(second.content)).toBe(true);
    expect(
      fixture.calls.every(({ sql }) => !/\b(?:COMMIT|BEGIN|ROLLBACK|set_config)\b/iu.test(sql)),
    ).toBe(true);
  });
  it("rejects invalid closed input before touching persistence", async () => {
    const fixture = transaction();
    await expect(
      appendPlatformAuditRecordInTransaction(fixture.tx, {
        ...input,
        targetReference: null,
      } as unknown as AppendPlatformAuditRecordInput),
    ).rejects.toMatchObject({ code: "PLATFORM_AUDIT_INPUT_INVALID" });
    expect(fixture.calls).toHaveLength(0);
  });
  it("requires caller rollback after every failed allocation, append or head advance", async () => {
    for (const failStep of [1, 2, 3, 4]) {
      const fixture = transaction({ failStep });
      await expect(appendPlatformAuditRecordInTransaction(fixture.tx, input)).rejects.toMatchObject(
        {
          code: "PLATFORM_AUDIT_PERSISTENCE_FAILED",
          message: "Platform Audit persistence invariant failed",
        },
      );
      expect(fixture.calls).toHaveLength(failStep);
    }
  });
  it.each([1, 2, 3, 4])(
    "rejects query drift at SQL return boundary %i without entering another transaction",
    async (replaceAfter) => {
      const fixture = transaction();
      const foreign = transaction();
      const originalQuery = fixture.tx.query;
      fixture.tx.query = async function (
        this: AuditTransaction,
        sql: string,
        values: readonly unknown[],
      ) {
        expect(this).toBe(fixture.tx);
        const result = await originalQuery.call(this, sql, values);
        if (fixture.calls.length === replaceAfter)
          fixture.tx.query = foreign.tx.query.bind(foreign.tx);
        return result;
      };
      await expect(appendPlatformAuditRecordInTransaction(fixture.tx, input)).rejects.toMatchObject(
        { code: "PLATFORM_AUDIT_PERSISTENCE_FAILED" },
      );
      expect(fixture.calls).toHaveLength(replaceAfter);
      expect(foreign.calls).toHaveLength(0);
      expect(fixture.calls.some(({ sql }) => /\b(?:COMMIT|ROLLBACK)\b/iu.test(sql))).toBe(false);
    },
  );
  it("refuses malformed heads, different inserted identity or failed CAS without a receipt", async () => {
    for (const options of [
      { nextSequence: "9007199254740991" },
      { nextSequence: "2" },
      { nextSequence: "1.0" },
      { wrongInsert: true },
      { wrongAdvance: true },
    ]) {
      const fixture = transaction(options);
      await expect(appendPlatformAuditRecordInTransaction(fixture.tx, input)).rejects.toMatchObject(
        { code: "PLATFORM_AUDIT_PERSISTENCE_FAILED" },
      );
    }
  });
  it("uses the genuine operation as the Abandoned target without allocating a template", async () => {
    const fixture = transaction();
    const record = await appendPlatformAuditRecordInTransaction(fixture.tx, {
      ...input,
      targetType: "PlatformBrandTemplateOperation",
      targetReference: input.operationReference,
      actionCode: "PLATFORM_BRAND_TEMPLATE_ABANDONED",
    });
    expect(record.content.targetReference).toBe(input.operationReference);
    expect(fixture.calls[2]?.values[5]).toBe(input.operationReference);
  });
});
