import { expect, it } from "vitest";
import {
  createAuthenticationSession,
  createIdentityActor,
  createPostgresBrowserBrandSessionSelectionStore,
  type OidcAuthorizationTransaction,
} from "../index.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z",
  now = "2026-09-10T10:01:00.000Z";
const session = createAuthenticationSession({
  sessionReference: id(1),
  actor: createIdentityActor({
    actorType: "User",
    actorReference: id(2),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  }),
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: at,
  createdAt: at,
  lastSeenAt: at,
  idleExpiresAt: "2026-09-10T10:30:00.000Z",
  absoluteExpiresAt: "2026-09-10T22:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
function fixture() {
  const stored: Record<string, unknown> = {
    session_id: session.sessionReference,
    actor_id: session.actor.actorReference,
    status: session.status,
    policy_code: session.policy.code,
    version: session.version,
    authenticated_at: session.authenticatedAt,
    created_at: session.createdAt,
    last_seen_at: session.lastSeenAt,
    idle_expires_at: session.idleExpiresAt,
    absolute_expires_at: session.absoluteExpiresAt,
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    precise: true,
  };
  const state = { row: null as Record<string, unknown> | null, stored, inserts: 0, fail: false };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: OidcAuthorizationTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (state.fail) throw new Error("synthetic internal detail");
      if (sql.includes("FROM bop_identity.authentication_session")) return { rows: [stored] };
      if (sql.startsWith("SELECT current_setting"))
        return { rows: [{ session_scope: "", actor_scope: "" }] };
      if (sql.startsWith("INSERT")) {
        state.inserts++;
        state.row = {
          session_id: values[0],
          actor_id: values[1],
          brand_id: values[2],
          selected_at: values[3],
          precise: true,
        };
      }
      return {
        rows:
          sql.includes("FROM bop_identity.browser_brand_session_selection") && state.row
            ? [state.row]
            : [],
      };
    },
  };
  const source = createPostgresBrowserBrandSessionSelectionStore();
  return {
    state,
    calls,
    tx,
    source,
    write: () => source.write(tx, session, { brandReference: id(3) }, now),
    read: () => source.read(tx, session, now),
  };
}
it("persists a Brand-only choice for the actual session and restores pre-Tenant scope", async () => {
  const f = fixture();
  expect(await f.read()).toBeNull();
  expect(await f.write()).toEqual({ brandReference: id(3) });
  expect(await f.write()).toEqual({ brandReference: id(3) });
  expect(f.state.inserts).toBe(1);
  expect(f.calls.at(-1)?.values).toEqual(["", ""]);
  expect(f.calls.some((c) => c.values.includes(id(1)) && c.values.includes(id(2)))).toBe(true);
  expect(f.calls.every((c) => !c.sql.includes("tenant_id") && !c.sql.includes("store_id"))).toBe(
    true,
  );
});
it.each(["brand_id", "actor_id", "session_id", "selected_at", "precise"])(
  "refuses corrupt selection %s",
  async (field) => {
    const f = fixture();
    await f.write();
    if (!f.state.row) throw new Error("fixture");
    f.state.row[field] =
      field === "selected_at"
        ? "2026-09-10T10:01:00.000001Z"
        : field === "precise"
          ? false
          : id(99);
    await expect(field === "brand_id" ? f.write() : f.read()).rejects.toThrow(
      "BROWSER_BRAND_SESSION_SELECTION_DENIED",
    );
  },
);
it("rejects replacement rather than rebinding a genuine session", async () => {
  const f = fixture();
  await f.write();
  await expect(f.source.write(f.tx, session, { brandReference: id(4) }, now)).rejects.toThrow();
  expect(f.state.inserts).toBe(1);
});
it.each(["2026-09-10T09:59:59.999Z", "2026-09-10T10:01:00.001Z"])(
  "refuses selection time outside the session observation: %s",
  async (selectedAt) => {
    const f = fixture();
    await f.write();
    if (!f.state.row) throw new Error("fixture");
    f.state.row.selected_at = selectedAt;
    await expect(f.read()).rejects.toThrow();
  },
);
it("rejects an expired session before any query and poisons SQL failures", async () => {
  const f = fixture();
  await expect(f.source.read(f.tx, session, session.idleExpiresAt)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.state.fail = true;
  await expect(g.read()).rejects.toThrow("BROWSER_BRAND_SESSION_SELECTION_DENIED");
  g.state.fail = false;
  await expect(g.read()).rejects.toThrow();
  expect(g.calls).toHaveLength(1);
});
it("rejects query replacement during selection and never invokes the replacement", async () => {
  const f = fixture(),
    original = f.tx.query;
  let replacements = 0;
  f.tx.query = async (sql, values) => {
    const result = await original(sql, values);
    f.tx.query = async () => {
      replacements++;
      return { rows: [] };
    };
    return result;
  };
  await expect(f.read()).rejects.toThrow();
  expect(replacements).toBe(0);
});
it("rejects actual stored Session revocation even when the supplied session remains Active", async () => {
  const f = fixture();
  await f.write();
  f.state.stored.status = "Revoked";
  await expect(f.read()).rejects.toThrow();
});
