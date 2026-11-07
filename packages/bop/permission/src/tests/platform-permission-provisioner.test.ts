import { describe, expect, it } from "vitest";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  verifyPlatformAuditChain,
  type PlatformAuditChainRecordV1,
} from "@bop/audit";
import {
  parsePlatformPermissionPolicy,
  parsePlatformPermissionProvisionCommand,
  type PlatformPermissionPolicy,
} from "../contracts/platform-permission.js";
import {
  createPostgresPlatformPermissionProvisioner,
  type PlatformPermissionProvisionerOptions,
} from "../infrastructure/persistence/platform-permission-provisioner.js";
import type { PlatformPermissionTransaction } from "../infrastructure/persistence/platform-permission-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  until = "2026-10-06T13:00:00.000Z";
const command = () =>
  parsePlatformPermissionProvisionCommand({
    profile: "PlatformPermissionProvisionV1",
    targetActorReference: id(1),
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    operationReference: id(2),
    expectedHead: null,
    content: {
      roleCode: "PlatformAdministrator",
      effectiveFrom: at,
      effectiveUntil: until,
      entries: [
        {
          evidenceReference: id(3),
          action: "platform.operate",
          effect: "Allow",
          effectiveFrom: at,
          effectiveUntil: until,
        },
        {
          evidenceReference: id(4),
          action: "platform.brand-template.manage",
          effect: "Allow",
          effectiveFrom: at,
          effectiveUntil: until,
        },
      ],
    },
    recordedByReference: id(5),
    approvedByReference: id(6),
    approvalEvidenceReference: id(7),
    reasonCode: "APPROVED_PROVISIONING",
  });
function fixture() {
  let time = at,
    controlled = true,
    authorityValid = true,
    auditFailure = false,
    allocated = 20,
    subject = "",
    actor = "",
    auditSequence = 1,
    previousHash: string | null = null,
    current: PlatformPermissionPolicy | null = null;
  const originals = new Map<string, PlatformPermissionPolicy>(),
    calls: { sql: string; values: readonly unknown[] }[] = [],
    auditRecords: PlatformAuditChainRecordV1[] = [];
  const tx: PlatformPermissionTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      if (sql.includes("session_user::text"))
        return {
          rows: [
            {
              session_principal: "platform_provisioner",
              current_principal: "platform_provisioner",
              isolation: "read committed",
              controlled,
            },
          ],
        };
      if (sql.includes("set_config('bop.platform_actor_id'")) {
        actor = String(values[0]);
        subject = String(values[1]);
        return { rows: [] };
      }
      if (sql.includes("set_config('bop.platform_permission_subject_id'")) {
        subject = String(values[0]);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT snapshot_text,source_digest")) {
        const p = originals.get(String(values[2]));
        return {
          rows: p ? [{ snapshot_text: canonicalizeRfc8785(p), source_digest: p.sourceDigest }] : [],
        };
      }
      if (sql.startsWith("SELECT policy_id::text")) {
        if (subject !== String(values[0])) throw new Error("PRIVATE_RLS_SUBJECT_MISMATCH");
        return {
          rows: current
            ? [
                {
                  policyReference: current.policyReference,
                  revision: current.revision,
                  sourceDigest: current.sourceDigest,
                },
              ]
            : [],
        };
      }
      if (sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_revision")) {
        const p = parsePlatformPermissionPolicy(JSON.parse(String(values[12])));
        originals.set(p.operationReference, p);
        return { rows: [{ policy_reference: p.policyReference }] };
      }
      if (
        sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_head") ||
        sql.startsWith("UPDATE bop_permission.platform_permission_policy_head")
      ) {
        current = [...originals.values()].find((p) => p.policyReference === values[3]) ?? null;
        return { rows: current ? [{ policy_reference: current.policyReference }] : [] };
      }
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head"))
        return { rows: [] };
      if (sql.includes("FROM platform_audit.platform_actor_audit_chain_head"))
        return {
          rows: [
            {
              next_sequence: String(auditSequence),
              previous_hash: previousHash,
              recorded_at: time,
            },
          ],
        };
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record")) {
        if (auditFailure) throw new Error("PRIVATE_AUDIT_FAILED");
        expect(values[1]).toBe(id(5));
        expect(actor).toBe(id(5));
        return { rows: [{ audit_reference: values[0] }] };
      }
      if (sql.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")) {
        const hash = values[2];
        if (!Buffer.isBuffer(hash)) throw new Error("fixture hash");
        previousHash = hash.toString("hex");
        return { rows: [{ next_sequence: String(++auditSequence) }] };
      }
      if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
        expect(subject).toBe(id(1));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const options: PlatformPermissionProvisionerOptions = {
    transaction: tx,
    operatorScope: {
      kind: "Platform",
      actorReference: id(5),
      purposeCode: "PLATFORM_BRAND_TEMPLATE",
    },
    provisioningRoleName: "platform_provisioner",
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    authority: {
      async hold(actual, input) {
        expect(actual).toBe(tx);
        if (!authorityValid) throw new Error("PRIVATE_APPROVAL_WITHDRAWN");
        await actual.query("SELECT set_config('bop.platform_permission_subject_id',$1,true)", [
          id(5),
        ]);
        return {
          operatorReference: id(5),
          approvedByReference: input.command.approvedByReference,
          approvalEvidenceReference: input.command.approvalEvidenceReference,
          validUntil: deadline,
        };
      },
    },
    nextReference: () => id(++allocated),
    appendAudit: async (actual, input) => {
      expect(actual).toBe(tx);
      const record = await appendPlatformAuditRecordInTransaction(actual, input);
      auditRecords.push(record);
      return record;
    },
    registerBeforeCommit: async (actual, g, f) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  };
  const create = () => createPostgresPlatformPermissionProvisioner(options);
  return {
    create,
    options,
    calls,
    auditRecords,
    tx,
    allocations: () => allocated,
    setTime: (v: string) => {
      time = v;
    },
    badRole: () => {
      controlled = false;
    },
    withdraw: () => {
      authorityValid = false;
    },
    failAudit: () => {
      auditFailure = true;
    },
    runGuard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    runFinal: () => {
      if (!final) throw new Error("missing final");
      final();
    },
    finish: async (p: ReturnType<typeof create>) => {
      if (!guard || !final) throw new Error("missing guards");
      await guard();
      final();
      p.assertFinalized();
    },
  };
}
describe("controlled Platform Permission provisioning", () => {
  it("provisions the target while auditing the distinct actual operator in the same transaction", async () => {
    const f = fixture(),
      p = f.create(),
      result = await p.provision(command());
    expect(result.actorReference).toBe(id(1));
    expect(result.recordedByReference).toBe(id(5));
    expect(f.auditRecords[0]?.content.actorReference).toBe(id(5));
    expect(verifyPlatformAuditChain(f.auditRecords)).toBe(true);
    await f.finish(p);
    expect(
      f.calls.filter((c) => c.sql.includes("set_config('bop.platform_actor_id'")),
    ).toHaveLength(2);
    const count = f.calls.length;
    f.setTime(until);
    p.assertFinalized();
    expect(f.calls).toHaveLength(count);
  });
  it("replays the exact original with no fresh reference or Audit even after later head revision", async () => {
    const f = fixture(),
      p = f.create(),
      first = await p.provision(command());
    await f.finish(p);
    const second = f.create();
    const next = parsePlatformPermissionProvisionCommand({
      ...command(),
      operationReference: id(30),
      expectedHead: {
        policyReference: first.policyReference,
        revision: first.revision,
        sourceDigest: first.sourceDigest,
      },
      content: { ...command().content, entries: [] },
    });
    await second.provision(next);
    await f.finish(second);
    const allocated = f.allocations(),
      audit = f.auditRecords.length;
    const replay = f.create();
    expect(await replay.provision(command())).toEqual(first);
    await f.finish(replay);
    expect(f.allocations()).toBe(allocated);
    expect(f.auditRecords).toHaveLength(audit);
  });
  it("arbitrates original intent and CAS before allocation, including another target", async () => {
    const f = fixture(),
      p = f.create();
    await p.provision(command());
    await f.finish(p);
    const allocated = f.allocations();
    await expect(
      f.create().provision({ ...command(), targetActorReference: id(99) }),
    ).rejects.toMatchObject({ code: "PLATFORM_PERMISSION_INTENT_CONFLICT" });
    expect(f.allocations()).toBe(allocated);
    await expect(
      f.create().provision({ ...command(), operationReference: id(31) }),
    ).rejects.toMatchObject({ code: "PLATFORM_PERMISSION_VERSION_CONFLICT" });
    expect(f.allocations()).toBe(allocated);
  });
  it("refuses an uncontrolled login role or withdrawn independent authority without inserting", async () => {
    for (const badRole of [true, false]) {
      const f = fixture();
      if (badRole) f.badRole();
      else f.withdraw();
      await expect(f.create().provision(command())).rejects.toThrow();
      expect(f.allocations()).toBe(20);
      expect(f.auditRecords).toHaveLength(0);
    }
  });
  it("requires caller rollback for Audit failure or late approval withdrawal", async () => {
    const f = fixture();
    f.failAudit();
    await expect(f.create().provision(command())).rejects.toThrow();
    expect(
      f.calls.some((c) =>
        c.sql.startsWith("INSERT INTO bop_permission.platform_permission_policy_revision"),
      ),
    ).toBe(true);
    const g = fixture(),
      p = g.create();
    await p.provision(command());
    g.withdraw();
    await expect(g.runGuard()).rejects.toThrow();
    expect(() => p.assertFinalized()).toThrow();
  });
  it("refuses final lease expiry and mutable ports instead of reporting committed", async () => {
    const f = fixture(),
      p = f.create();
    await p.provision(command());
    await f.runGuard();
    f.setTime(deadline);
    expect(() => f.runFinal()).toThrow();
    const g = fixture(),
      q = g.create();
    g.tx.query = async () => ({ rows: [] });
    await expect(q.provision(command())).rejects.toThrow();
    expect(g.calls).toHaveLength(0);
  });
});
