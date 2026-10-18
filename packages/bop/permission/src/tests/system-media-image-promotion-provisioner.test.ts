import { describe, expect, it } from "vitest";
import {
  buildSystemMediaImagePromotionAuthorizationDecision,
  parseSystemMediaImagePromotionAuthorizationDecision,
  systemMediaImagePromotionRequiredFields,
  type SystemMediaImagePromotionAuthorizationDecision,
} from "../contracts/system-media-image-promotion-authorization.js";
import {
  createPostgresSystemMediaImagePromotionProvisioner,
  type SystemMediaImagePromotionProvisionerOptions,
} from "../infrastructure/persistence/system-media-image-promotion-provisioner.js";

const id = (n: number) => `018f4f8a-9c2d-7a11-8d01-${String(n).padStart(12, "0")}`;
// Audit validates against the real clock; the controlled business clock must
// use a past instant rather than manufacture a future Audit occurrence.
const at = "2026-10-02T12:00:00.000Z",
  deadline = "2026-10-02T12:00:05.000Z";
const configDigest = `sha256:${"a".repeat(64)}`;
const identity = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  workloadReference: id(4),
  deploymentConfigurationDigest: configDigest,
};
function decision(
  overrides: Partial<Omit<SystemMediaImagePromotionAuthorizationDecision, "digest">> = {},
) {
  return buildSystemMediaImagePromotionAuthorizationDecision({
    ...identity,
    profile: "MEDIA_IMAGE_PROMOTION_V1",
    decisionReference: id(5),
    version: 1,
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: systemMediaImagePromotionRequiredFields,
    enabled: true,
    effectiveFrom: at,
    effectiveUntil: null,
    recordedAt: at,
    auditReference: id(6),
    ...overrides,
  });
}
type Tx = Parameters<SystemMediaImagePromotionProvisionerOptions["registerBeforeCommit"]>[0];
interface Tables {
  root: null | {
    version: string;
    decision_reference: string;
    updated_at: string;
    coherent: boolean;
  };
  decisions: Map<
    string,
    {
      snapshot: SystemMediaImagePromotionAuthorizationDecision;
      correlation_reference: string;
      coherent: boolean;
    }
  >;
  audits: readonly unknown[][];
  auditHash: string | null;
}
function harness() {
  const state = {
    now: at,
    principal: {
      session_principal: "synthetic_provisioner",
      current_principal: "synthetic_provisioner",
      isolation: "read committed",
      controlled: true,
    },
    tables: { root: null, decisions: new Map(), audits: [], auditHash: null } as Tables,
    commits: 0,
    rollbacks: 0,
    runs: 0,
    registrations: 0,
    casZero: false,
    auditFailure: false,
    skipAsync: false,
    skipFinal: false,
    unknownCommit: false,
    beforeQuery: null as null | ((sql: string, tx: Tx) => Promise<void>),
    afterWork: null as null | (() => Promise<void>),
    afterAsync: null as null | (() => Promise<void>),
    onRegister: null as null | (() => Promise<void>),
    swallowWorkError: false,
  };
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const guards = new WeakMap<
    object,
    { asyncGuard: () => Promise<void>; finalAssert: () => void }[]
  >();
  const options: SystemMediaImagePromotionProvisionerOptions = {
    ...identity,
    provisioningRoleName: "synthetic_provisioner",
    clock: { now: () => state.now },
    registerBeforeCommit: async (tx, asyncGuard, finalAssert) => {
      state.registrations++;
      const list = guards.get(tx);
      if (!list) throw new Error("foreign synthetic transaction");
      list.push({ asyncGuard, finalAssert });
      await state.onRegister?.();
    },
    transactions: {
      async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
        state.runs++;
        const originalTables = structuredClone(state.tables);
        let savepoint: Tables | null = null,
          committed = false;
        const tx: Tx = {
          query: async <Row>(sql: string, values: readonly unknown[]) => {
            statements.push({ sql, values });
            await state.beforeQuery?.(sql, tx);
            let rows: unknown[] = [],
              rowCount = 1;
            if (sql.startsWith("SELECT session_user")) rows = [{ ...state.principal }];
            else if (
              sql.startsWith("SELECT set_config") ||
              sql.startsWith("SELECT pg_advisory_xact_lock")
            ) {
              /* Transaction-local scope and lock. */
            } else if (sql.startsWith("SAVEPOINT")) savepoint = structuredClone(state.tables);
            else if (sql.startsWith("ROLLBACK TO")) {
              if (!savepoint) throw new Error("missing synthetic savepoint");
              state.tables = structuredClone(savepoint);
            } else if (sql.startsWith("RELEASE")) savepoint = null;
            else if (sql.startsWith("SELECT snapshot_json snapshot")) {
              const original = state.tables.decisions.get(String(values[4]));
              if (original) rows = [structuredClone(original)];
            } else if (sql.startsWith("SELECT version::text version")) {
              if (state.tables.root) rows = [{ ...state.tables.root }];
            } else if (
              sql.startsWith(
                "INSERT INTO bop_permission.system_media_image_promotion_authorization_decision",
              )
            ) {
              const snapshot = parseSystemMediaImagePromotionAuthorizationDecision(
                JSON.parse(String(values[16])),
              );
              state.tables.decisions.set(snapshot.decisionReference, {
                snapshot,
                correlation_reference: String(values[15]),
                coherent: true,
              });
            } else if (
              sql.startsWith(
                "INSERT INTO bop_permission.system_media_image_promotion_authorization(",
              )
            ) {
              state.tables.root = {
                version: String(values[4]),
                decision_reference: String(values[5]),
                updated_at: String(values[6]),
                coherent: true,
              };
            } else if (
              sql.startsWith("UPDATE bop_permission.system_media_image_promotion_authorization SET")
            ) {
              if (state.casZero || state.tables.root?.version !== String(values[7])) rowCount = 0;
              else
                state.tables.root = {
                  version: String(values[4]),
                  decision_reference: String(values[5]),
                  updated_at: String(values[6]),
                  coherent: true,
                };
            } else if (sql.startsWith("INSERT INTO platform_audit.audit_chain_head")) {
              /* Real Audit appender initializes the chain. */
            } else if (sql.includes("FROM platform_audit.audit_chain_head")) {
              rows = [
                {
                  next_sequence: String(state.tables.audits.length + 1),
                  previous_hash: state.tables.auditHash,
                  recorded_at: state.now,
                },
              ];
            } else if (sql.startsWith("INSERT INTO platform_audit.audit_record")) {
              if (state.auditFailure) throw new Error("synthetic private Audit failure");
              state.tables.audits = [...state.tables.audits, [...values]];
              const hash = values[23];
              if (!Buffer.isBuffer(hash)) throw new Error("missing real Audit hash");
              state.tables.auditHash = hash.toString("hex");
            } else if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
              rows = [{ next_sequence: String(state.tables.audits.length + 1) }];
            } else throw new Error("unexpected synthetic query");
            // The controlled driver only fabricates SQL rows. Production parsing
            // and the public Audit validator/hash/chain appender remain real.
            return { rows: rows as readonly Row[], rowCount };
          },
        };
        guards.set(tx, []);
        try {
          let value: T;
          try {
            value = await work(tx);
          } catch (error) {
            if (!state.swallowWorkError) throw error;
            // Deliberately hostile host: swallowing work must not bypass the
            // installed poison guard. No fabricated success value is supplied.
            for (const guard of guards.get(tx) ?? []) await guard.asyncGuard();
            throw error;
          }
          await state.afterWork?.();
          if (!state.skipAsync) for (const guard of guards.get(tx) ?? []) await guard.asyncGuard();
          await state.afterAsync?.();
          if (!state.skipFinal) for (const guard of guards.get(tx) ?? []) guard.finalAssert();
          state.commits++;
          committed = true;
          if (state.unknownCommit)
            throw Object.assign(new Error("private connection lost"), {
              code: "COMMIT_OUTCOME_UNKNOWN",
            });
          return value;
        } catch (error) {
          if (!committed) {
            state.tables = originalTables;
            state.rollbacks++;
          }
          throw error;
        }
      },
    },
  };
  const store = createPostgresSystemMediaImagePromotionProvisioner(options);
  return {
    state,
    statements,
    options,
    store,
    provision(d = decision(), correlationReference = id(7)) {
      return store.provision({ decision: d, correlationReference });
    },
  };
}
const unavailable = { code: "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_UNAVAILABLE" };
const dataWrites = (h: ReturnType<typeof harness>) =>
  h.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/u.test(sql));

describe("controlled deployment Permission provisioner (no real deployment capability claimed)", () => {
  it("atomically provisions a fixed decision/root with the real Audit appender", async () => {
    const h = harness(),
      d = decision();
    expect(await h.provision(d)).toEqual(d);
    expect(h.state.commits).toBe(1);
    expect(h.state.tables.root).toMatchObject({
      version: "1",
      decision_reference: d.decisionReference,
    });
    expect(h.state.tables.decisions.size).toBe(1);
    const audit = h.state.tables.audits[0];
    expect(audit).toBeDefined();
    expect(audit?.slice(0, 8)).toEqual([
      id(6),
      id(2),
      id(3),
      "System",
      null,
      "SYSTEM_MEDIA_PROMOTION_AUTHORIZED",
      "SystemMediaImagePromotionWorkload",
      id(4),
    ]);
    expect(audit?.[13]).toBe("DEPLOYMENT");
    expect(audit?.[16]).toBe("PERMISSION_POLICY_AUDIT");
    expect(h.state.tables.auditHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(h.statements.filter(({ sql }) => sql.startsWith("SELECT session_user"))).toHaveLength(3);
  });
  it.each([
    { session_principal: "synthetic_worker" },
    { current_principal: "synthetic_worker" },
    { session_principal: "different_login", current_principal: "synthetic_provisioner" },
    { controlled: false },
    { isolation: "repeatable read" },
  ])("rejects wrong real principal/capability %j before policy or Audit writes", async (change) => {
    const h = harness();
    Object.assign(h.state.principal, change);
    await expect(h.provision()).rejects.toMatchObject(unavailable);
    expect(dataWrites(h)).toHaveLength(0);
    expect(h.state.rollbacks).toBe(1);
  });
  it("replays the exact old immutable decision despite a newer revoked root and later clock", async () => {
    const h = harness(),
      original = decision();
    await h.provision(original);
    const revoked = decision({
      decisionReference: id(15),
      version: 2,
      enabled: false,
      auditReference: id(16),
    });
    await h.provision(revoked, id(17));
    h.state.now = "2026-10-03T12:00:00.000Z";
    h.statements.length = 0;
    expect(await h.provision(original)).toEqual(original);
    expect(h.state.tables.root?.version).toBe("2");
    expect(dataWrites(h)).toHaveLength(0);
    expect(h.statements.some(({ sql }) => sql.startsWith("SELECT version::text version"))).toBe(
      false,
    );
    expect(h.state.tables.audits).toHaveLength(2);
    expect(h.state.tables.audits[1]?.[5]).toBe("SYSTEM_MEDIA_PROMOTION_REVOKED");
  });
  it("requires current principal authority for old replay and rejects changed intent/correlation", async () => {
    const h = harness();
    await h.provision();
    h.statements.length = 0;
    await expect(h.provision(decision({ enabled: false }))).rejects.toMatchObject(unavailable);
    await expect(h.provision(decision(), id(99))).rejects.toMatchObject(unavailable);
    h.state.principal.controlled = false;
    await expect(h.provision()).rejects.toMatchObject(unavailable);
    expect(dataWrites(h)).toHaveLength(0);
    expect(h.state.tables.audits).toHaveLength(1);
  });
  it.each(["tenantReference", "brandReference", "storeReference", "workloadReference"] as const)(
    "rejects mismatched %s before any SQL",
    async (field) => {
      const h = harness();
      await expect(h.provision(decision({ [field]: id(90) }))).rejects.toMatchObject(unavailable);
      expect(h.statements).toHaveLength(0);
      expect(h.state.registrations).toBe(1);
    },
  );
  it("rejects a different configuration digest instead of granting through the fixed provisioner", async () => {
    const h = harness();
    await expect(
      h.provision(decision({ deploymentConfigurationDigest: `sha256:${"b".repeat(64)}` })),
    ).rejects.toMatchObject(unavailable);
    expect(h.statements).toHaveLength(0);
  });
  it.each([
    { version: 2 },
    { recordedAt: "2026-10-02T11:59:54.999Z" },
    { recordedAt: "2026-10-02T12:00:00.001Z" },
  ])("refuses missing predecessor or stale/future new write %j", async (change) => {
    const h = harness();
    await expect(h.provision(decision(change))).rejects.toMatchObject(unavailable);
    expect(dataWrites(h)).toHaveLength(0);
  });
  it("requires the exact current root and rolls back the tentative immutable row on CAS loss", async () => {
    const h = harness();
    await h.provision();
    const original = structuredClone(h.state.tables);
    h.state.casZero = true;
    await expect(
      h.provision(
        decision({ decisionReference: id(15), version: 2, auditReference: id(16) }),
        id(17),
      ),
    ).rejects.toMatchObject(unavailable);
    expect(h.state.tables).toEqual(original);
    expect(h.statements.some(({ sql }) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
    h.state.casZero = false;
    await expect(
      h.provision(
        decision({ decisionReference: id(25), version: 3, auditReference: id(26) }),
        id(27),
      ),
    ).rejects.toMatchObject(unavailable);
    expect(h.state.tables).toEqual(original);
  });
  it("rolls back decision/root when the real Audit insert fails", async () => {
    const h = harness();
    h.state.auditFailure = true;
    await expect(h.provision()).rejects.toMatchObject(unavailable);
    expect(h.state.tables.decisions.size).toBe(0);
    expect(h.state.tables.root).toBeNull();
    expect(h.state.tables.audits).toHaveLength(0);
    expect(h.state.commits).toBe(0);
  });
  it("captures deployment identity, clock, runner and registrar before work", async () => {
    const h = harness();
    Object.defineProperty(h.options, "provisioningRoleName", { value: "changed_name" });
    h.options.clock.now = () => deadline;
    h.options.transactions.run = async () => {
      throw new Error("replacement runner");
    };
    Object.defineProperty(h.options, "registerBeforeCommit", {
      value: async () => {
        throw new Error("replacement registrar");
      },
    });
    expect(await h.provision()).toEqual(decision());
    expect(h.state.registrations).toBe(1);
  });
  it("does not renew the five-second entry deadline during registration", async () => {
    const h = harness();
    h.state.onRegister = async () => {
      h.state.now = deadline;
    };
    await expect(h.provision()).rejects.toMatchObject(unavailable);
    expect(h.statements).toHaveLength(0);
  });
  it("rejects a late principal denial and later guard expiry with full outer rollback", async () => {
    const denied = harness();
    denied.state.afterWork = async () => {
      denied.state.principal.controlled = false;
    };
    await expect(denied.provision()).rejects.toMatchObject(unavailable);
    expect(denied.state.tables.decisions.size).toBe(0);
    expect(denied.state.tables.audits).toHaveLength(0);
    const expired = harness();
    expired.state.afterAsync = async () => {
      expired.state.now = deadline;
    };
    await expect(expired.provision()).rejects.toMatchObject(unavailable);
    expect(expired.state.tables.decisions.size).toBe(0);
    expect(expired.state.tables.audits).toHaveLength(0);
  });
  it("poisons a swallowed query failure and detects query-port replacement", async () => {
    const swallowed = harness();
    swallowed.state.swallowWorkError = true;
    swallowed.state.beforeQuery = async () => {
      throw new Error("private driver details");
    };
    await expect(swallowed.provision()).rejects.toMatchObject(unavailable);
    expect(swallowed.state.commits).toBe(0);
    const replaced = harness();
    replaced.state.beforeQuery = async (_, tx) => {
      Object.defineProperty(tx, "query", { value: async () => ({ rows: [] }) });
    };
    await expect(replaced.provision()).rejects.toMatchObject(unavailable);
    expect(replaced.state.commits).toBe(0);
  });
  it.each(["skipAsync", "skipFinal"] as const)(
    "does not report success when a host omits %s",
    async (flag) => {
      const h = harness();
      h.state[flag] = true;
      await expect(h.provision()).rejects.toMatchObject(unavailable);
    },
  );
  it("reports unknown commit separately and recovers the same decision without duplicate Audit", async () => {
    const h = harness();
    h.state.unknownCommit = true;
    await expect(h.provision()).rejects.toMatchObject({
      code: "SYSTEM_MEDIA_IMAGE_PROMOTION_PROVISIONING_OUTCOME_UNKNOWN",
    });
    expect(h.state.tables.decisions.size).toBe(1);
    expect(h.state.tables.audits).toHaveLength(1);
    h.state.unknownCommit = false;
    h.statements.length = 0;
    expect(await h.provision()).toEqual(decision());
    expect(dataWrites(h)).toHaveLength(0);
    expect(h.state.tables.audits).toHaveLength(1);
  });
});
