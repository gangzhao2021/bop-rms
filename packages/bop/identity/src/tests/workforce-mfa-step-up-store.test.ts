import { expect, it } from "vitest";
import {
  createPostgresLatestWorkforceStepUpSource,
  createPostgresWorkforceMfaStepUpStore,
  resolveRecentWorkforceMfaAt,
} from "../infrastructure/persistence/workforce-mfa-step-up-store.js";

const id = (n: number) => "01909975-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-10-12T15:00:00.000Z";
function fixture(
  options: {
    history?: { outcome: string; attempted_at: Date }[];
    insertError?: { code: string };
  } = {},
) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("clock_timestamp") && !sql.includes("audit_chain_head"))
        return { rows: [{ now: new Date(now) }] };
      if (sql.startsWith("SELECT outcome")) return { rows: options.history ?? [] };
      if (sql.startsWith("INSERT INTO bop_identity") && values[7] === "Verified") {
        if (options.insertError) throw Object.assign(new Error("x"), options.insertError);
      }
      if (sql.includes("audit_chain_head") && sql.includes("FOR UPDATE"))
        return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: now }] };
      if (sql.includes("UPDATE platform_audit.audit_chain_head"))
        return { rows: [{ next_sequence: "2" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { tx, calls };
}
const command = (code: unknown = "123456") => ({
  brandReference: id(1),
  storeReference: id(2),
  actorReference: id(3),
  sessionReference: id(4),
  stepUpReference: id(5),
  auditReference: id(6),
  purposeCode: "PAYMENT_REFUND_AUTHORIZATION",
  code,
});
const store = (
  verify: (input: { code: string }) => Promise<{ timeStep: number } | null>,
  authorize = async () => true,
) =>
  createPostgresWorkforceMfaStepUpStore({
    method: "InternalTestTotp",
    verify,
    authorize,
    retentionPolicyCode: "SECURITY_AUDIT",
    retentionPolicyVersion: 1,
  });
const inserted = (calls: { sql: string; values: readonly unknown[] }[]) =>
  calls.filter((call) => call.sql.startsWith("INSERT INTO bop_identity.workforce_mfa_step_up"));

it("records a verified step-up with its time step, never the code, and reports 15 minutes", async () => {
  const f = fixture();
  const seen: string[] = [];
  const result = await store(async ({ code }) => {
    seen.push(code);
    return { timeStep: 58_666_666 };
  })(f.tx, command());
  expect(result).toEqual({
    status: "Verified",
    stepUpReference: id(5),
    verifiedAt: now,
    validUntil: "2026-10-12T15:15:00.000Z",
  });
  expect(seen).toEqual(["123456"]);
  const rows = inserted(f.calls);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.values.slice(5, 10)).toEqual([
    "InternalTestTotp",
    "PAYMENT_REFUND_AUTHORIZATION",
    "Verified",
    null,
    58_666_666,
  ]);
  expect(JSON.stringify(f.calls)).not.toContain("123456");
  expect(f.calls.some((call) => call.sql.includes("pg_advisory_xact_lock"))).toBe(true);
});
it("records a mismatch and a malformed code as rejected without calling the verifier twice", async () => {
  for (const code of ["000000", "12ab56", 123456]) {
    const f = fixture();
    let called = 0;
    const result = await store(async () => {
      called++;
      return null;
    })(f.tx, command(code));
    expect(result).toEqual({ status: "Rejected", reason: "CodeMismatch" });
    expect(called).toBe(code === "000000" ? 1 : 0);
    expect(inserted(f.calls)[0]?.values[7]).toBe("Rejected");
    expect(inserted(f.calls)[0]?.values[9]).toBeNull();
  }
});
it("refuses a code whose time step was already used (single-use index)", async () => {
  const f = fixture({ insertError: { code: "23505" } });
  const result = await store(async () => ({ timeStep: 7 }))(f.tx, command());
  expect(result).toEqual({ status: "Rejected", reason: "CodeReused" });
  expect(
    f.calls.some((call) => call.sql === "ROLLBACK TO SAVEPOINT workforce_mfa_step_up_accept"),
  ).toBe(true);
  expect(inserted(f.calls).map((call) => call.values[8])).toEqual([null, "CodeReused"]);
});
it("locks further tries after five failures since the last success within 15 minutes", async () => {
  const failed = (minutesAgo: number) => ({
    outcome: "Rejected",
    attempted_at: new Date(Date.parse(now) - minutesAgo * 60_000),
  });
  const f = fixture({ history: [1, 2, 3, 4, 5].map(failed) });
  let called = false;
  const result = await store(async () => {
    called = true;
    return { timeStep: 1 };
  })(f.tx, command());
  expect(result).toEqual({ status: "Locked", retryAfterSeconds: 600 });
  expect(called).toBe(false);
  expect(inserted(f.calls)).toHaveLength(0);
  const reset = fixture({
    history: [failed(1), failed(2), { outcome: "Verified", attempted_at: new Date(now) }].concat(
      [3, 4, 5].map(failed),
    ),
  });
  expect((await store(async () => ({ timeStep: 1 }))(reset.tx, command())).status).toBe("Verified");
});
it("fails closed when not authorized or the verifier is not set up for the actor", async () => {
  await expect(
    store(
      async () => ({ timeStep: 1 }),
      async () => false,
    )(fixture().tx, command()),
  ).rejects.toThrow("WORKFORCE_STEP_UP_DENIED");
  await expect(
    store(async () => {
      throw new Error("NOT_PROVISIONED");
    })(fixture().tx, command()),
  ).rejects.toThrow("WORKFORCE_STEP_UP_UNAVAILABLE");
  await expect(
    store(async () => ({ timeStep: 1 }))(fixture().tx, { ...command(), purposeCode: "bad" }),
  ).rejects.toThrow("WORKFORCE_STEP_UP_DENIED");
});
it("reads the latest verified step-up and combines it with enrollment", async () => {
  const tx = {
    query: async (sql: string) =>
      sql.includes("max(attempted_at)")
        ? { rows: [{ verified_at: new Date("2026-10-12T14:55:00.000Z") }] }
        : { rows: [] },
  };
  const latest = await createPostgresLatestWorkforceStepUpSource({ authorize: async () => true })(
    tx,
    { brandReference: id(1), storeReference: id(2), actorReference: id(3), observedAt: now },
  );
  expect(latest).toBe("2026-10-12T14:55:00.000Z");
  const base = { status: "TotpVerified", verifiedAt: "2026-01-01T00:00:00.000Z", resetAt: null };
  expect(resolveRecentWorkforceMfaAt({ ...base, latestStepUpAt: latest })).toBe(latest);
  expect(resolveRecentWorkforceMfaAt({ ...base, latestStepUpAt: null })).toBe(base.verifiedAt);
  expect(
    resolveRecentWorkforceMfaAt({ ...base, status: "ResetRequired", latestStepUpAt: latest }),
  ).toBeNull();
  expect(
    resolveRecentWorkforceMfaAt({
      ...base,
      resetAt: "2026-10-12T14:58:00.000Z",
      latestStepUpAt: latest,
    }),
  ).toBe(base.verifiedAt);
});
