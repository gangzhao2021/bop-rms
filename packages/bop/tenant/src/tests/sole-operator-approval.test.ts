import { describe, expect, it } from "vitest";
import {
  evaluateSoleOperatorApproval,
  parseSoleOperatorPermissionCode,
  parseSoleOperatorSettingReason,
} from "../contracts/sole-operator-approval.js";
import {
  createPostgresSoleOperatorSettingStore,
  createSoleOperatorApprovalSource,
  type SoleOperatorSettingAudit,
} from "../infrastructure/persistence/sole-operator-setting-store.js";

const id = (n: number) => "0190a7c6-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, owner, mia] = [1, 2, 3, 4].map(id) as [string, string, string, string];

describe("WP-2423 Q19 sole operator decision", () => {
  it("is in effect only when On and the actor is the one and only holder", () => {
    const evaluate = (setting: "On" | "Off" | null, holders: string[]) =>
      evaluateSoleOperatorApproval({ setting, holderReferences: holders, actorReference: owner });
    expect(evaluate("On", [owner])).toEqual({ status: "Effective", otherHolderReferences: [] });
    expect(evaluate("On", [owner, owner])).toEqual({
      status: "Effective",
      otherHolderReferences: [],
    });
    expect(evaluate("On", [owner, mia])).toEqual({
      status: "OtherApprovers",
      otherHolderReferences: [mia],
    });
    // The actor must hold the permission themself.
    expect(evaluate("On", []).status).toBe("OtherApprovers");
    expect(evaluate("On", [mia]).status).toBe("OtherApprovers");
    expect(evaluate("Off", [owner]).status).toBe("NotSet");
    expect(evaluate(null, [owner]).status).toBe("NotSet");
    expect(() => evaluate("On", ["not-a-reference"])).toThrow("SOLE_OPERATOR_INPUT_INVALID");
  });
  it("covers brand-internal gates only and binds reasons to the state", () => {
    expect(parseSoleOperatorPermissionCode("payment.refund.approve")).toBe(
      "payment.refund.approve",
    );
    // Owner decision 2026-10-16: Store configuration approval (Store setup step 8) is a gate.
    expect(parseSoleOperatorPermissionCode("store.service.approve")).toBe("store.service.approve");
    // ... and so is receipt template approval (Owner access to the Store, WP-2423).
    expect(parseSoleOperatorPermissionCode("organization.manage")).toBe("organization.manage");
    for (const code of [
      "publishing.release.publish",
      "publishing.review.approve",
      "store.service.publish",
      "identity.role.approve",
      "x",
    ])
      expect(() => parseSoleOperatorPermissionCode(code)).toThrow();
    expect(parseSoleOperatorSettingReason("On", "OWNER_RUNS_STORE_ALONE")).toBe(
      "OWNER_RUNS_STORE_ALONE",
    );
    expect(() => parseSoleOperatorSettingReason("On", "OWNER_CHOICE")).toThrow();
    expect(() => parseSoleOperatorSettingReason("Off", "OWNER_RUNS_STORE_ALONE")).toThrow();
  });
});

/** A scripted transaction: answers the store's statements in order and records them. */
function scripted(latest: Record<string, unknown> | null, now: string) {
  const statements: string[] = [];
  return {
    statements,
    tx: {
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes("clock_timestamp")) return { rows: [{ now }], rowCount: 1 };
        if (sql.includes("operation_id=$2")) return { rows: [], rowCount: 0 };
        if (sql.includes("ORDER BY version DESC"))
          return { rows: latest === null ? [] : [latest], rowCount: latest === null ? 0 : 1 };
        if (sql.startsWith("INSERT")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: null };
      },
    },
  };
}
const now = "2026-10-13T12:00:00.000Z";
function command(overrides: Record<string, unknown> = {}) {
  return {
    tenantReference: tenant,
    brandReference: brand,
    actorReference: owner,
    settingReference: id(10),
    operationReference: id(11),
    auditReference: id(12),
    state: "On" as const,
    reasonCode: "OWNER_RUNS_STORE_ALONE",
    expectedVersion: 0,
    actorMfaAt: "2026-10-13T11:50:00.000Z" as string | null,
    ...overrides,
  };
}
describe("WP-2423 Q19 sole operator setting store", () => {
  const audits: SoleOperatorSettingAudit[] = [];
  const store = (allowed = true) =>
    createPostgresSoleOperatorSettingStore({
      authorize: async () => allowed,
      appendAudit: async (_tx, record) => {
        audits.push(record);
      },
      retentionPolicyCode: "SECURITY_AUDIT",
      retentionPolicyVersion: 1,
    });
  it("records an On change with its Audit under a recent second factor", async () => {
    const { tx, statements } = scripted(null, now);
    const result = await store()(tx, command());
    expect(result.status).toBe("Created");
    expect(result.record).toMatchObject({ version: 1, state: "On" });
    expect(statements.some((sql) => sql.startsWith("INSERT"))).toBe(true);
    expect(audits.at(-1)).toMatchObject({
      actionCode: "ORGANIZATION_SOLE_OPERATOR_ENABLED",
      beforeSummary: { state: "NotSet" },
      afterSummary: { state: "On", version: 1 },
      reasonCode: "OWNER_RUNS_STORE_ALONE",
      dataClassification: "Internal",
    });
  });
  it("refuses a non-owner, a stale or missing second factor, a stale version and no change", async () => {
    await expect(store(false)(scripted(null, now).tx, command())).rejects.toThrow(
      "SOLE_OPERATOR_DENIED",
    );
    for (const actorMfaAt of [null, "2026-10-13T11:44:59.999Z", "2026-10-13T12:00:00.001Z"])
      await expect(store()(scripted(null, now).tx, command({ actorMfaAt }))).rejects.toThrow(
        "SOLE_OPERATOR_NEEDS_REVERIFICATION",
      );
    const latest = {
      setting: id(20),
      tenant,
      version: "1",
      state: "On",
      reason_code: "OWNER_RUNS_STORE_ALONE",
      actor: owner,
      actor_mfa_at: now,
      recorded_at: now,
      operation: id(21),
      audit: id(22),
    };
    await expect(store()(scripted(latest, now).tx, command())).rejects.toThrow(
      "SOLE_OPERATOR_VERSION_CONFLICT",
    );
    await expect(
      store()(scripted(latest, now).tx, command({ expectedVersion: 1 })),
    ).rejects.toThrow("SOLE_OPERATOR_NO_CHANGE");
    await expect(
      store()(
        scripted(latest, now).tx,
        command({ state: "Off", reasonCode: "OWNER_RUNS_STORE_ALONE" }),
      ),
    ).rejects.toThrow("SOLE_OPERATOR_INPUT_INVALID");
  });
});

describe("WP-2423 Q19 soleOperatorApproval public read", () => {
  it("counts holders only when the setting is On and refuses platform permission codes", async () => {
    let holderReads = 0;
    const read = (state: "On" | "Off" | null, holders: string[]) =>
      createSoleOperatorApprovalSource({
        setting: async () =>
          ({ state, version: state === null ? 0 : 1, latest: null, history: [] }) as never,
        holders: async () => {
          holderReads++;
          return holders;
        },
      });
    const query = {
      tenantReference: tenant,
      brandReference: brand,
      storeReference: id(5),
      permissionCode: "payment.refund.approve",
      actorReference: owner,
      observedAt: now,
    };
    const tx = { query: async () => ({ rows: [] }) };
    expect((await read("Off", [owner])(tx, query)).status).toBe("NotSet");
    expect(holderReads).toBe(0);
    expect((await read("On", [owner])(tx, query)).status).toBe("Effective");
    expect(await read("On", [owner, mia])(tx, query)).toMatchObject({
      status: "OtherApprovers",
      otherHolderReferences: [mia],
      settingVersion: 1,
    });
    await expect(
      read("On", [owner])(tx, { ...query, permissionCode: "publishing.release.publish" }),
    ).rejects.toThrow("SOLE_OPERATOR_INPUT_INVALID");
  });
});
