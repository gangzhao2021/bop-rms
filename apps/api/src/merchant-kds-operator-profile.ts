/** IDR-0039 least-privilege named KDS Operator profile: whatever the Actor's roles allow,
 * a NamedKdsOperator Session can only enter the workspace and operate the Kitchen (WP-2423 Q26:
 * including a remake; DEC-KITCHEN-STALE-TICKETS: a manager signed in at the kitchen screen closing
 * an earlier day's ticket; WP-2423 Q17: marking an item sold out for today and bringing today's
 * mark back, without the manager-level availability permission — the Actor's roles must still
 * allow each).
 *
 * One definition for every scope that authorizes a merchant Session (Store, Brand and current
 * Brand), so the limit cannot drift between them (Owner approval 2026-10-14: "批准收紧").
 */
export const kdsOperatorProfileActions: ReadonlySet<string> = new Set([
  "merchant.access",
  "kitchen.operate",
  "kitchen.work_item.rework",
  "kitchen.ticket.close_stale",
  "catalog.sku.sold_out.mark",
]);

const kdsOperatorPolicyCode = "NamedKdsOperator";

function policyCodeOf(session: unknown): unknown {
  if (!session || typeof session !== "object") return undefined;
  const policy: unknown = (session as { readonly policy?: unknown }).policy;
  if (!policy || typeof policy !== "object") return undefined;
  return (policy as { readonly code?: unknown }).code;
}

/** True when the Session was started as a kitchen display. */
export function isKdsOperatorSession(session: unknown): boolean {
  return policyCodeOf(session) === kdsOperatorPolicyCode;
}

/** Whether the Session's sign-in kind permits the action at all; the Actor's roles still decide. */
export function kdsOperatorProfileAllows(session: unknown, action: string): boolean {
  return !isKdsOperatorSession(session) || kdsOperatorProfileActions.has(action);
}

interface DecisionLike {
  readonly effect: string;
  readonly reason: string;
  readonly source: string;
  readonly action: string;
  readonly audit: object;
}

/** A Policy decision limited to the Session's profile (`allows`, from kdsOperatorProfileAllows):
 * an Allow outside a kitchen display's profile becomes a default Deny (same action, scope and
 * policy snapshot). */
export function limitDecisionToProfile<D extends DecisionLike>(
  allows: (action: string) => boolean,
  decision: D,
): D {
  if (decision.effect !== "Allow" || allows(decision.action)) return decision;
  return Object.freeze({
    ...decision,
    effect: "Deny",
    reason: "DEFAULT_DENY",
    source: "DefaultDeny",
    audit: Object.freeze({ effect: "Deny", reason: "DEFAULT_DENY", source: "DefaultDeny" }),
  });
}
