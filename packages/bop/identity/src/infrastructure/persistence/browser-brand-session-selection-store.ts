import {
  assertSessionUsable,
  createAuthenticationSession,
  type AuthenticationSession,
} from "../../contracts/authentication-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../../contracts/identity-actor.js";
import type { OidcAuthorizationTransaction } from "./oidc-authorization-store.js";

export interface BrowserBrandSessionSelection {
  readonly brandReference: string;
}
const denied = (): never => {
  throw new Error("BROWSER_BRAND_SESSION_SELECTION_DENIED");
};
function one(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return denied();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return denied();
  if (d.value.length === 0) return null;
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row)) return denied();
  return row.value as Record<string, unknown>;
}
function session(input: AuthenticationSession, at: string) {
  const { policy: rawPolicy, ...fields } = readClosedRecord(input, [
    "sessionReference",
    "actor",
    "status",
    "policy",
    "version",
    "authenticatedAt",
    "createdAt",
    "lastSeenAt",
    "idleExpiresAt",
    "absoluteExpiresAt",
    "rotatedFromSessionReference",
    "revocationReason",
    "revokedAt",
  ]);
  const policy = readClosedRecord(rawPolicy, [
    "code",
    "maxActiveSessions",
    "idleTimeoutMinutes",
    "absoluteTimeoutMinutes",
  ]);
  const result = createAuthenticationSession({
    ...fields,
    policyCode: policy.code,
    maxActiveSessions: policy.maxActiveSessions,
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
  });
  assertSessionUsable(result, at);
  if (
    result.actor.actorType !== "User" ||
    result.actor.accountKind !== "Workforce" ||
    result.actor.status !== "Active" ||
    result.actor.actorReference === null ||
    result.actor.authenticationMethod !== "Oidc" ||
    result.createdAt > at ||
    result.lastSeenAt > at
  )
    return denied();
  return result;
}
const projection = `session_id,actor_id,brand_id,
  to_char(selected_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS selected_at,
  selected_at=date_trunc('milliseconds',selected_at) AS precise`;

/** Identity owns only a persisted current-session choice. The API must resolve
 * actual current Brand/Membership/IAM before writing and after reading it. */
export function createPostgresBrowserBrandSessionSelectionStore() {
  const poisoned = new WeakSet<OidcAuthorizationTransaction>();
  const active = new WeakSet<OidcAuthorizationTransaction>();
  const queries = new WeakMap<
    OidcAuthorizationTransaction,
    OidcAuthorizationTransaction["query"]
  >();
  async function run(
    tx: OidcAuthorizationTransaction,
    input: AuthenticationSession,
    now: string,
    requested?: BrowserBrandSessionSelection,
  ): Promise<BrowserBrandSessionSelection | null> {
    if (active.has(tx)) {
      poisoned.add(tx);
      return denied();
    }
    active.add(tx);
    const original = queries.get(tx) ?? tx.query;
    queries.set(tx, original);
    const check = () => {
      if (poisoned.has(tx) || tx.query !== original || typeof original !== "function")
        return denied();
    };
    const query = async (sql: string, values: readonly unknown[]) => {
      check();
      const result = await original.call(tx, sql, values);
      check();
      return result;
    };
    try {
      const at = parseCanonicalInstant(now),
        current = session(input, at);
      const target =
        requested === undefined
          ? undefined
          : parseOpaqueUuidV7(
              readClosedRecord(requested, ["brandReference"]).brandReference,
              "ACTOR_REFERENCE_INVALID",
            );
      const expected = {
        session_id: current.sessionReference,
        actor_id: current.actor.actorReference,
        status: current.status,
        policy_code: current.policy.code,
        version: current.version,
        authenticated_at: current.authenticatedAt,
        created_at: current.createdAt,
        last_seen_at: current.lastSeenAt,
        idle_expires_at: current.idleExpiresAt,
        absolute_expires_at: current.absoluteExpiresAt,
        rotated_from_session_id: current.rotatedFromSessionReference,
        revocation_reason: current.revocationReason,
        revoked_at: current.revokedAt,
      };
      const timestampColumns = [
        "authenticated_at",
        "created_at",
        "last_seen_at",
        "idle_expires_at",
        "absolute_expires_at",
        "revoked_at",
      ];
      const stored = readClosedRecord(
        one(
          await query(
            `SELECT session_id,actor_id,status,policy_code,version,rotated_from_session_id,revocation_reason,
          ${timestampColumns.map((name) => `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${name}`).join(",")},
          ${timestampColumns.map((name) => `(${name} IS NULL OR ${name}=date_trunc('milliseconds',${name}))`).join(" AND ")} AS precise
          FROM bop_identity.authentication_session WHERE session_id=$1 AND actor_id=$2 FOR SHARE`,
            [current.sessionReference, current.actor.actorReference],
          ),
        ),
        [...Object.keys(expected), "precise"],
      );
      if (
        stored.precise !== true ||
        Object.entries(expected).some(([key, value]) => stored[key] !== value)
      )
        return denied();
      const prior = readClosedRecord(
        one(
          await query(
            "SELECT current_setting('bop.identity_session_id',true) AS session_scope,current_setting('bop.identity_actor_id',true) AS actor_scope",
            [],
          ),
        ),
        ["session_scope", "actor_scope"],
      );
      if (
        ![prior.session_scope, prior.actor_scope].every((v) => v === null || typeof v === "string")
      )
        return denied();
      await query(
        "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
        [current.sessionReference, current.actor.actorReference],
      );
      try {
        if (target !== undefined)
          await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "bop.identity.brand-session-selection:" + current.sessionReference,
          ]);
        const read = async () => {
          const value = one(
            await query(
              `SELECT ${projection} FROM bop_identity.browser_brand_session_selection WHERE session_id=$1 AND actor_id=$2 FOR SHARE`,
              [current.sessionReference, current.actor.actorReference],
            ),
          );
          if (value === null) return null;
          const r = readClosedRecord(value, [
            "session_id",
            "actor_id",
            "brand_id",
            "selected_at",
            "precise",
          ]);
          const selectedAt = parseCanonicalInstant(r.selected_at);
          if (
            r.session_id !== current.sessionReference ||
            r.actor_id !== current.actor.actorReference ||
            r.precise !== true ||
            selectedAt < current.createdAt ||
            selectedAt > at
          )
            return denied();
          return Object.freeze({
            brandReference: String(parseOpaqueUuidV7(r.brand_id, "ACTOR_REFERENCE_INVALID")),
          });
        };
        const before = await read();
        if (target === undefined) return before;
        if (before === null)
          await query(
            "INSERT INTO bop_identity.browser_brand_session_selection(session_id,actor_id,brand_id,selected_at) VALUES($1,$2,$3,$4)",
            [current.sessionReference, current.actor.actorReference, target, at],
          );
        const after = await read();
        if (after?.brandReference !== target) return denied();
        return after;
      } finally {
        await query(
          "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
          [prior.session_scope ?? "", prior.actor_scope ?? ""],
        );
      }
    } catch {
      poisoned.add(tx);
      return denied();
    } finally {
      active.delete(tx);
    }
  }
  return Object.freeze({
    read: (tx: OidcAuthorizationTransaction, current: AuthenticationSession, now: string) =>
      run(tx, current, now),
    async write(
      tx: OidcAuthorizationTransaction,
      current: AuthenticationSession,
      input: BrowserBrandSessionSelection,
      now: string,
    ) {
      const selected = await run(tx, current, now, input);
      return selected ?? denied();
    },
  });
}
