import { expect, it } from "vitest";
import {
  createIdentityActor,
  createPostgresCurrentBrowserSessionSource,
  parseSelectorHash,
} from "../index.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
function fixture() {
  const row: Record<string, unknown> = {
    session_id: id(2),
    actor_id: id(1),
    policy_code: "WorkforceStandard",
    status: "Active",
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-09-10T10:30:00.000Z"),
    absolute_expires_at: new Date("2026-09-10T22:00:00.000Z"),
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    version: 1,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let current = actor;
  let disabled = false;
  let records = [row];
  const read = createPostgresCurrentBrowserSessionSource({
    now: () => "2026-09-10T10:10:00.000Z",
    hasher: { hash: () => parseSelectorHash("a".repeat(64)), equals: (a, b) => a === b },
    currentActor: async () => {
      if (disabled) throw new Error("synthetic inactive actor");
      return current;
    },
  });
  const tx = {
    async query(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      return { rows: records };
    },
  };
  return {
    row,
    calls,
    disableActor: () => {
      disabled = true;
    },
    read: (cookie: unknown = "x".repeat(43)) => read(tx, cookie),
    setActor: (value: typeof actor) => {
      current = value;
    },
    setRows: (value: typeof records) => {
      records = value;
    },
  };
}
it("resolves only session fields through hashed credential and a row fence", async () => {
  const f = fixture();
  expect((await f.read()).sessionReference).toBe(id(2));
  expect(f.calls[0]?.values).toEqual(["a".repeat(64)]);
  expect(f.calls[0]?.sql).toContain("FOR SHARE");
  expect(f.calls[0]?.sql).not.toMatch(/encrypted_secret|csrf_selector_hash|SELECT [*]/u);
});
it("rejects malformed credentials before SQL", async () => {
  const f = fixture();
  await expect(f.read("private-canary")).rejects.toThrow("request denied");
  expect(f.calls).toHaveLength(0);
});
it.each(["missing", "duplicate"])("rejects %s session records", async (kind) => {
  const f = fixture();
  f.setRows(kind === "missing" ? [] : [f.row, f.row]);
  await expect(f.read()).rejects.toThrow();
});
it.each(["Revoked", "Expired"])("rejects %s sessions", async (status) => {
  const f = fixture();
  f.row.status = status;
  if (status === "Revoked") {
    f.row.revocation_reason = "Logout";
    f.row.revoked_at = new Date(at);
  }
  await expect(f.read()).rejects.toThrow();
});
it("rejects actor binding mismatch", async () => {
  const f = fixture();
  f.setActor(createIdentityActor({ ...actor, actorReference: id(3) }));
  await expect(f.read()).rejects.toThrow();
});
it("rejects disabled identity despite an active session", async () => {
  const f = fixture();
  f.disableActor();
  await expect(f.read()).rejects.toThrow();
});
it("rejects future interactive activity", async () => {
  const f = fixture();
  f.row.last_seen_at = new Date("2026-09-10T10:20:00.000Z");
  f.row.idle_expires_at = new Date("2026-09-10T10:50:00.000Z");
  await expect(f.read()).rejects.toThrow();
});
