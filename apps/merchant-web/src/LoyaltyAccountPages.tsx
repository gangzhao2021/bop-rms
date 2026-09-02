import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  LoyaltyAccountClientError,
  parseLoyaltyAccountView,
  parsePointsReviewView,
  unavailableLoyaltyAccountClient,
  type LoyaltyAccountClient,
  type LoyaltyAccountClientErrorCode,
  type LoyaltyAccountView,
  type PointsReviewView,
} from "./loyalty-account-pages.js";
type State =
  | { readonly kind: "Loading" | LoyaltyAccountClientErrorCode }
  | { readonly kind: "Account"; readonly view: LoyaltyAccountView }
  | { readonly kind: "Review"; readonly view: PointsReviewView };
export function LoyaltyAccountState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Account" | "Review">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading immutable Loyalty facts…", "neutral"],
    PermissionDenied: ["Permission denied", "Loyalty facts are unavailable.", "error"],
    NotFound: ["Account not found", "No Account is available in this Brand.", "neutral"],
    FeatureDisabled: ["Loyalty Account disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh source facts before an action.", "offline"],
    Conflict: ["Account changed", "Refresh Expected Version before retrying.", "offline"],
    Validation: ["Action blocked", "Resolve reservation, source or correction evidence.", "error"],
    CommandFailed: ["Command failed", "No balance or historical fact was edited.", "error"],
    Offline: ["Offline read-only", "Cached balances cannot authorize mutation.", "offline"],
    Unavailable: ["Loyalty unavailable", "No Points or Provider fact is inferred.", "error"],
  };
  const v = values[state];
  return (
    <StatePanel heading={v[0]} tone={v[2]} status>
      <p>{v[1]}</p>
    </StatePanel>
  );
}
export function LoyaltyAccountDetail({ view }: { readonly view: LoyaltyAccountView }) {
  const a = view.account;
  if (!a) return <LoyaltyAccountState state="NotFound" />;
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">LOY-ACCOUNT-DETAIL · {a.status}</p>
          <h1>Loyalty Account</h1>
          <p>
            {view.brandLabel} · v{a.aggregateVersion}
          </p>
        </div>
      </header>
      {readOnly ? <LoyaltyAccountState state="Stale" /> : null}
      <section className="summary-card">
        <h2>Derived balances</h2>
        <p>
          Available {a.availablePoints} · reserved {a.reservedPoints} · pending {a.pendingPoints} ·
          expiring {a.expiringPoints}
        </p>
        <p>
          Lifetime earned {a.lifetimeEarnedPoints} · Points Debt {a.pointsDebt}
        </p>
        <p>
          Program {a.programReference} · tier {a.tierCode ?? "None"}
        </p>
        <p>
          Rewards {a.rewardReferences.length} · linked allocations{" "}
          {a.linkedAllocationReferences.length}
        </p>
        <h3>Reservations</h3>
        {a.reservations.map((r) => (
          <p key={r.reservationReference}>
            {r.status} · {r.points} · {r.targetReference} · expires {r.expiresAt}
          </p>
        ))}
        {view.permissions.mayViewLedger ? (
          <>
            <h3>Append-only ledger</h3>
            {a.ledger?.map((t) => (
              <p key={t.transactionReference}>
                {t.type} · {t.points} · source {t.sourceReference}
              </p>
            ))}
          </>
        ) : null}
        <div className="card-actions">
          {view.permissions.mayOperate ? (
            <>
              <button disabled={readOnly}>Suspend / reactivate</button>
              <button disabled={readOnly}>Release invalid reservation</button>
              <button disabled={readOnly}>Close after impact check</button>
            </>
          ) : null}
          {view.permissions.mayCorrect ? (
            <button disabled={readOnly}>Authorized correction from linked transaction</button>
          ) : null}
        </div>
        <p role="note">
          Balances are ledger projections and cannot be edited. Points are not Payment tender;
          corrections append Reverse or Adjust and never rewrite source transactions.
        </p>
      </section>
    </main>
  );
}
export function PointsReview({ view }: { readonly view: PointsReviewView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">LOY-POINTS-REVIEW</p>
          <h1>Points exceptions</h1>
          <p>
            {view.brandLabel} · {view.freshness}
          </p>
        </div>
      </header>
      {readOnly ? <LoyaltyAccountState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Account / Order ref
          <input disabled placeholder="Exact reference" />
        </label>
        <label>
          Type / status / program / owner / overdue
          <select disabled>
            <option>All exceptions</option>
          </select>
        </label>
      </div>
      <div className="card-list">
        {view.rows.map((x) => (
          <article className="summary-card" key={x.exceptionReference}>
            <p className="bop-eyebrow">
              {x.type} · {x.status}
            </p>
            <p>
              Account {x.accountReference} · source {x.sourceReference}
            </p>
            <p>
              Owner {x.ownerReference ?? "Unassigned"} · due {x.dueAt}
            </p>
            <div className="card-actions">
              {view.permissions.mayReview ? (
                <>
                  <button disabled={readOnly || x.status !== "Open"}>Acknowledge</button>
                  <button disabled={readOnly || x.status === "Resolved"}>
                    Recalculate from source
                  </button>
                  <button disabled={readOnly || x.status !== "Acknowledged"}>Resolve</button>
                </>
              ) : null}
              {view.permissions.mayCorrect ? (
                <button disabled={readOnly || x.status !== "Acknowledged"}>
                  Append authorized correction
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
function Page({
  mode,
  client,
  reference,
}: {
  readonly mode: "Account" | "Review";
  readonly client: LoyaltyAccountClient;
  readonly reference?: string | undefined;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load(mode === "Account" ? "LOY-ACCOUNT-DETAIL" : "LOY-POINTS-REVIEW", reference)
      .then((v) => {
        if (active)
          setState(
            mode === "Account"
              ? { kind: "Account", view: parseLoyaltyAccountView(v) }
              : { kind: "Review", view: parsePointsReviewView(v) },
          );
      })
      .catch((e: unknown) => {
        if (active)
          setState({
            kind:
              e instanceof LoyaltyAccountClientError
                ? e.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Offline",
          });
      });
    return () => {
      active = false;
    };
  }, [client, mode, reference]);
  return state.kind === "Account" ? (
    <LoyaltyAccountDetail view={state.view} />
  ) : state.kind === "Review" ? (
    <PointsReview view={state.view} />
  ) : (
    <LoyaltyAccountState state={state.kind} />
  );
}
export function LoyaltyAccountDetailPage({
  client = unavailableLoyaltyAccountClient,
}: {
  readonly client?: LoyaltyAccountClient;
}) {
  const { id } = useParams();
  return <Page mode="Account" client={client} reference={id} />;
}
export function PointsReviewPage({
  client = unavailableLoyaltyAccountClient,
}: {
  readonly client?: LoyaltyAccountClient;
}) {
  return <Page mode="Review" client={client} />;
}
