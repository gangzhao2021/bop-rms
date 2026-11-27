import { describe, expect, it } from "vitest";
import {
  decideRoleAssignment,
  storeActionCandidates,
} from "../infrastructure/persistence/role-assignment-store.js";

const id = (n: number) => "01909a0e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const brand = id(1),
  store = id(2),
  owner = id(3),
  sam = id(4),
  mia = id(5);
const at = "2026-11-06T10:00:00.000Z";

function recording(rows: (sql: string) => readonly Record<string, unknown>[] = () => []) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    tx: {
      query: async (sql: string, values: readonly unknown[]) => {
        calls.push({ sql, values });
        return { rows: rows(sql) };
      },
    },
  };
}

describe("storeActionCandidates (WP-2423 M07)", () => {
  it("reads only allowing evidence at the Brand or this Store, with the policy packet's scope", async () => {
    const { calls, tx } = recording((sql) =>
      sql.startsWith("SELECT DISTINCT") ? [{ actor: mia }, { actor: owner }, { actor: mia }] : [],
    );
    expect(
      await storeActionCandidates(tx, {
        brandReference: brand,
        storeReference: store,
        action: "identity.role.approve",
        at,
      }),
    ).toEqual([owner, mia].sort());
    expect(calls[0]).toEqual({
      sql: expect.stringContaining("set_config('bop.store_id'"),
      values: [brand, store],
    });
    const read = calls[1] as { sql: string; values: readonly unknown[] };
    expect(read.values).toEqual([brand, store, "identity.role.approve", at]);
    const sql = read.sql.replace(/\s+/gu, " ");
    // Assignment, role and grant each at the Brand (no Store) or this Store; role to grant on the
    // same Brand; Active and in window at the observed time.
    for (const alias of ["a", "r", "g", "o"])
      expect(sql).toContain(`(${alias}.store_id IS NULL OR ${alias}.store_id=$2::uuid)`);
    for (const alias of ["a", "r", "g", "o"])
      expect(sql).toContain(
        `${alias}.lifecycle='Active' AND ${alias}.effective_from<=$4::timestamptz AND (${alias}.effective_until IS NULL OR ${alias}.effective_until>$4::timestamptz)`,
      );
    expect(sql).toContain("g.role_id=r.role_id AND g.brand_id=r.brand_id");
    expect(sql).toContain("r.role_id=a.role_id AND r.brand_id=a.brand_id");
    expect(sql).toContain("d.action_code=$3");
    // Allow overrides only; a Deny override never adds anyone (evaluation applies it later).
    expect(sql).toContain("o.effect='Allow'");
    expect(sql).not.toContain("'Deny'");
    expect(sql).toMatch(/LIMIT 1001$/u);
  });

  it("refuses more than 1000 candidates", async () => {
    const { tx } = recording((sql) =>
      sql.startsWith("SELECT DISTINCT")
        ? Array.from({ length: 1001 }, (_, n) => ({ actor: id(0x100 + n) }))
        : [],
    );
    await expect(
      storeActionCandidates(tx, {
        brandReference: brand,
        storeReference: store,
        action: "identity.role.approve",
        at,
      }),
    ).rejects.toThrow("STORE_ACTION_CANDIDATES_UNAVAILABLE");
  });
});

describe("decideRoleAssignment sole operator (WP-2423 M07)", () => {
  it("confirms the gate for the change's own subject, after the policy fence", async () => {
    const { calls, tx } = recording((sql) =>
      sql.includes("FROM bop_permission.role_assignment_change WHERE")
        ? [
            {
              kind: "Assign",
              role: id(9),
              assignment: id(10),
              actor: sam,
              membership: id(11),
              store_assignment: id(12),
              requested_by: owner,
            },
          ]
        : [],
    );
    const seen: { subjectReference: string; fenced: boolean }[] = [];
    await expect(
      decideRoleAssignment(
        tx,
        {
          brandReference: brand,
          storeReference: store,
          changeReference: id(13),
          decision: "Approved",
          decidedBy: owner,
          at,
          auditReference: id(14),
          snapshotReference: id(15),
          soleOperator: {
            confirm: async (change) => {
              seen.push({
                subjectReference: change.subjectReference,
                fenced: calls.some((call) =>
                  String(call.values[0]).startsWith("PermissionPolicyFence:"),
                ),
              });
              throw new Error("STOP_AFTER_CONFIRM");
            },
          },
        },
        async () => true,
      ),
    ).rejects.toThrow("STOP_AFTER_CONFIRM");
    expect(seen).toEqual([{ subjectReference: sam, fenced: true }]);
  });
});
