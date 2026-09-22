import {
  assertSessionUsable,
  createAuthenticationSession,
  type AuthenticationSession,
} from "../../contracts/authentication-session.js";
import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../../contracts/identity-actor.js";
import type { OidcAuthorizationTransaction } from "./oidc-authorization-store.js";
export interface BrowserSessionSelection {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
const denied = (): never => {
  throw new Error("BROWSER_SESSION_SELECTION_DENIED");
};
function selection(input: BrowserSessionSelection): BrowserSessionSelection {
  return Object.freeze({
    tenantReference: parseOpaqueUuidV7(input.tenantReference, "ACTOR_REFERENCE_INVALID"),
    brandReference: parseOpaqueUuidV7(input.brandReference, "ACTOR_REFERENCE_INVALID"),
    storeReference: parseOpaqueUuidV7(input.storeReference, "ACTOR_REFERENCE_INVALID"),
  });
}
function current(input: AuthenticationSession, at: string) {
  const s = createAuthenticationSession({
    ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "policy")),
    policyCode: input.policy.code,
    maxActiveSessions: input.policy.maxActiveSessions,
    idleTimeoutMinutes: input.policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: input.policy.absoluteTimeoutMinutes,
  });
  assertSessionUsable(s, at);
  if (
    s.actor.actorType !== "User" ||
    s.actor.accountKind !== "Workforce" ||
    s.actor.actorReference === null
  )
    return denied();
  return s;
}
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (!result || typeof result !== "object") return denied();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1) return denied();
  return d.value;
}

// These identifiers come from the validated session, never request body scope.
// Restore the prior transaction context so a later owner operation cannot inherit it.
async function withSessionScope<T>(
  tx: OidcAuthorizationTransaction,
  session: AuthenticationSession,
  work: () => Promise<T>,
): Promise<T> {
  const prior = rows(
    await tx.query(
      "SELECT current_setting('bop.identity_session_id',true) AS session_scope,current_setting('bop.identity_actor_id',true) AS actor_scope",
      [],
    ),
  )[0];
  if (
    !prior ||
    ![prior.session_scope, prior.actor_scope].every(
      (value) => value === null || typeof value === "string",
    )
  )
    return denied();
  try {
    await tx.query(
      "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
      [session.sessionReference, session.actor.actorReference],
    );
    return await work();
  } finally {
    await tx.query(
      "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
      [prior.session_scope ?? "", prior.actor_scope ?? ""],
    );
  }
}

/** Transaction-bound trusted selection, not permission evidence.
 * validate must fence current Tenant/Brand/Store association through public owners. */
export function createPostgresBrowserSessionSelectionStore(options: {
  validate(
    tx: OidcAuthorizationTransaction,
    session: AuthenticationSession,
    scope: BrowserSessionSelection,
    observedAt: string,
  ): Promise<boolean>;
}) {
  return Object.freeze({
    async read(tx: OidcAuthorizationTransaction, session: AuthenticationSession, now: string) {
      try {
        const observedAt = parseCanonicalInstant(now),
          s = current(session, observedAt);
        return await withSessionScope(tx, s, async () => {
          const row = rows(
            await tx.query(
              "SELECT tenant_id,brand_id,store_id,selected_at FROM bop_identity.browser_session_selection WHERE session_id=$1 AND actor_id=$2",
              [s.sessionReference, s.actor.actorReference],
            ),
          )[0];
          if (!row) return null;
          if (
            !(row.selected_at instanceof Date) ||
            !Number.isFinite(row.selected_at.getTime()) ||
            row.selected_at.toISOString() > observedAt ||
            row.selected_at.toISOString() < s.createdAt
          )
            return denied();
          const scope = selection({
            tenantReference: row.tenant_id,
            brandReference: row.brand_id,
            storeReference: row.store_id,
          } as BrowserSessionSelection);
          if (!(await options.validate(tx, s, scope, observedAt))) return denied();
          return scope;
        });
      } catch {
        return denied();
      }
    },
    async write(
      tx: OidcAuthorizationTransaction,
      session: AuthenticationSession,
      input: BrowserSessionSelection,
      now: string,
    ) {
      try {
        const observedAt = parseCanonicalInstant(now),
          s = current(session, observedAt),
          scope = selection(input);
        return await withSessionScope(tx, s, async () => {
          if (!(await options.validate(tx, s, scope, observedAt))) return denied();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "bop.identity.session-selection:" + s.sessionReference,
          ]);
          const existing = rows(
            await tx.query(
              "SELECT tenant_id,brand_id,store_id FROM bop_identity.browser_session_selection WHERE session_id=$1 AND actor_id=$2",
              [s.sessionReference, s.actor.actorReference],
            ),
          )[0];
          if (!existing) {
            await tx.query(
              "INSERT INTO bop_identity.browser_session_selection (session_id,actor_id,tenant_id,brand_id,store_id,selected_at) VALUES ($1,$2,$3,$4,$5,$6)",
              [
                s.sessionReference,
                s.actor.actorReference,
                scope.tenantReference,
                scope.brandReference,
                scope.storeReference,
                observedAt,
              ],
            );
          }
          const row = rows(
            await tx.query(
              "SELECT tenant_id,brand_id,store_id FROM bop_identity.browser_session_selection WHERE session_id=$1 AND actor_id=$2",
              [s.sessionReference, s.actor.actorReference],
            ),
          )[0];
          if (
            !row ||
            row.tenant_id !== scope.tenantReference ||
            row.brand_id !== scope.brandReference ||
            row.store_id !== scope.storeReference
          )
            return denied();
          if (!(await options.validate(tx, s, scope, observedAt))) return denied();
          return scope;
        });
      } catch {
        return denied();
      }
    },
  });
}
