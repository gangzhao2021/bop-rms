import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  LoyaltyProgramClientError,
  parseLoyaltyProgramView,
  unavailableLoyaltyProgramClient,
  type LoyaltyProgramClient,
  type LoyaltyProgramClientErrorCode,
  type LoyaltyProgramView,
} from "./loyalty-program-pages.js";
type State =
  | { readonly kind: "Loading" | LoyaltyProgramClientErrorCode }
  | { readonly kind: "Found"; readonly view: LoyaltyProgramView };
export function LoyaltyProgramState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading Brand-scoped Loyalty Programs…", "neutral"],
    PermissionDenied: ["Permission denied", "Loyalty Program access is unavailable.", "error"],
    NotFound: ["Program not found", "No Program is available in this Brand.", "neutral"],
    FeatureDisabled: ["Loyalty Programs disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh the Program before changing or publishing it.", "offline"],
    Conflict: ["Program changed", "Refresh Expected Version before retrying.", "offline"],
    Validation: [
      "Validation blocked",
      "Resolve points conservation, lifecycle or effective-version conflicts.",
      "error",
    ],
    CommandFailed: [
      "Command failed",
      "No Program Version or historical Points fact changed.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached Program rules cannot authorize mutation.", "offline"],
    Unavailable: [
      "Loyalty Programs unavailable",
      "No rule, legal expiry or benefit is inferred.",
      "error",
    ],
  };
  const item = values[state];
  return (
    <StatePanel heading={item[0]} tone={item[2]} status>
      <p>{item[1]}</p>
    </StatePanel>
  );
}
export function LoyaltyProgramList({ view }: { readonly view: LoyaltyProgramView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">LOY-PROGRAM-LIST</p>
          <h1>Loyalty Programs</h1>
          <p>
            {view.brandLabel} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayEdit ? <button disabled={readOnly}>Create Program</button> : null}
      </header>
      {readOnly ? <LoyaltyProgramState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Name / code
          <input disabled placeholder="Approved tokens" />
        </label>
        <label>
          Status / Store scope / scheduled
          <select disabled>
            <option>All Programs</option>
          </select>
        </label>
      </div>
      <div className="card-list">
        {view.rows.map((row) => (
          <article className="summary-card" key={row.programReference}>
            <p className="bop-eyebrow">
              {row.lifecycle} · v{row.currentVersion}
            </p>
            <h2>{row.name}</h2>
            <p>
              {row.programCode} · {row.scopeSummary}
            </p>
            <p>
              Effective {row.effectiveFromUtc} – {row.effectiveToUtc ?? "open"}
            </p>
            {view.permissions.mayViewRules ? (
              <p>
                {row.earnSummary} · {row.redeemSummary}
              </p>
            ) : null}
            <p>Members {row.memberCount ?? "Unavailable"}</p>
            <Link to={`/app/customers/loyalty-programs/${row.programReference}`}>Open Program</Link>
          </article>
        ))}
      </div>
    </main>
  );
}
export function LoyaltyProgramEditor({ view }: { readonly view: LoyaltyProgramView }) {
  const d = view.detail;
  if (!d) return <LoyaltyProgramState state="NotFound" />;
  const readOnly =
    view.freshness !== "Current" || view.partial || !["Draft", "Validated"].includes(d.lifecycle);
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">LOY-PROGRAM-EDITOR · {d.lifecycle}</p>
          <h1>{d.programCode}</h1>
          <p>
            v{d.versionNumber} · aggregate v{d.aggregateVersion}
          </p>
        </div>
      </header>
      {view.freshness !== "Current" || view.partial ? <LoyaltyProgramState state="Stale" /> : null}
      <section className="summary-card">
        <h2>Versioned rules</h2>
        <p>Eligibility {d.eligibility}</p>
        <p>Earn / activation {d.earnActivation}</p>
        <p>Redemption {d.redemption}</p>
        <p>Expiry {d.expiry}</p>
        <p>Refund reversal {d.refundReversal}</p>
        <p>Effective period {d.effectivePeriod}</p>
        {view.permissions.mayViewRules ? (
          <>
            <p>Tiers {d.tiers?.join(" · ") || "None"}</p>
            <p>Rewards / entitlements {d.rewards?.join(" · ") || "None"}</p>
            <p>Customer copy {d.customerCopy}</p>
          </>
        ) : null}
        <h3>Validation and simulation</h3>
        {d.validationIssues.map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
        {d.simulation ? (
          <p>
            Pending {d.simulation.earnedPending} · available {d.simulation.activatedAvailable} ·
            reserved {d.simulation.reserved} · redeemed {d.simulation.redeemed} · released{" "}
            {d.simulation.released} · reversed {d.simulation.reversedEarned} · returned{" "}
            {d.simulation.returnedRedeemed} · expired {d.simulation.expired} · ending{" "}
            {d.simulation.endingAvailable} · debt {d.simulation.pointsDebt}
          </p>
        ) : null}
        <div className="card-actions">
          {view.permissions.mayEdit ? (
            <>
              <button disabled={readOnly}>Save new Draft Version</button>
              <button disabled={readOnly}>Validate points conservation</button>
              <button disabled={readOnly}>Simulate lifecycle</button>
            </>
          ) : null}
          {view.permissions.mayApprove ? (
            <button disabled={readOnly || d.lifecycle !== "Validated"}>
              Review / publish or schedule
            </button>
          ) : null}
        </div>
        <p role="note">
          Published Versions never rewrite historical Points, Tier or Expiry facts. Points are a
          Loyalty benefit, not Payment tender; Pricing calculates monetary impact.
        </p>
      </section>
    </main>
  );
}
function Page({
  screenId,
  client,
  programReference,
}: {
  readonly screenId: LoyaltyProgramView["screenId"];
  readonly client: LoyaltyProgramClient;
  readonly programReference?: string | undefined;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .load(screenId, programReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseLoyaltyProgramView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            kind:
              error instanceof LoyaltyProgramClientError
                ? error.code
                : navigator.onLine
                  ? "Unavailable"
                  : "Offline",
          });
      });
    return () => {
      active = false;
    };
  }, [client, programReference, screenId]);
  return state.kind === "Found" ? (
    screenId === "LOY-PROGRAM-LIST" ? (
      <LoyaltyProgramList view={state.view} />
    ) : (
      <LoyaltyProgramEditor view={state.view} />
    )
  ) : (
    <LoyaltyProgramState state={state.kind} />
  );
}
export function LoyaltyProgramListPage({
  client = unavailableLoyaltyProgramClient,
}: {
  readonly client?: LoyaltyProgramClient;
}) {
  return <Page screenId="LOY-PROGRAM-LIST" client={client} />;
}
export function LoyaltyProgramEditorPage({
  client = unavailableLoyaltyProgramClient,
}: {
  readonly client?: LoyaltyProgramClient;
}) {
  const { id } = useParams();
  return <Page screenId="LOY-PROGRAM-EDITOR" client={client} programReference={id} />;
}
