import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceDashboardPageError,
  parseComplianceDashboardView,
  unavailableComplianceDashboardClient,
  type ComplianceDashboardClient,
  type ComplianceDashboardErrorCode,
  type ComplianceDashboardView,
} from "./compliance-dashboard-page.js";
type State =
  | { readonly kind: "Loading" | ComplianceDashboardErrorCode }
  | { readonly kind: "Found"; readonly view: ComplianceDashboardView };
export function ComplianceDashboardState({
  state,
}: {
  readonly state: Exclude<State["kind"], "Found">;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: [
      "Loading Compliance Dashboard",
      "Loading authorized operational compliance summaries…",
      "neutral",
    ],
    PermissionDenied: [
      "Permission denied",
      "Compliance or Store Manager access is required.",
      "error",
    ],
    Stale: [
      "Projection stale",
      "Source owners have not published a current compliance summary.",
      "offline",
    ],
    Offline: [
      "Offline read-only",
      "Compliance source status cannot be revalidated offline.",
      "offline",
    ],
    Unavailable: [
      "Compliance Dashboard unavailable",
      "No case, severity, deadline, or evidence state is inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
const label = (value: string) => value.replace(/([a-z])([A-Z])/gu, "$1 $2");
export function ComplianceDashboardList({ view }: { readonly view: ComplianceDashboardView }) {
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-DASHBOARD · Compliance</p>
          <h1>Compliance Dashboard</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Compliance dashboard filters">
        <label>
          Store / scope
          <input value={view.scope.storeReference ?? view.scope.brandReference} readOnly />
        </label>
        <label>
          Case type
          <input value={view.filter.caseTypeCode ?? "All"} readOnly />
        </label>
        <label>
          Severity
          <input
            value={
              view.filter.severity === "ImmediateDanger"
                ? "Immediate Danger"
                : (view.filter.severity ?? "All")
            }
            readOnly
          />
        </label>
        <label>
          Due / overdue
          <input value={view.filter.dueDisposition ?? "All"} readOnly />
        </label>
      </form>
      {view.freshness === "Stale" ? (
        <StatePanel heading="Stale compliance projection" tone="offline" status>
          <p>Review only; owning source status may have changed.</p>
        </StatePanel>
      ) : null}
      {view.completeness === "Partial" ? (
        <StatePanel heading="Partial source coverage" tone="offline" status>
          <p>Missing owners are shown as unavailable, never inferred as compliant.</p>
        </StatePanel>
      ) : null}
      {view.signals.length === 0 ? (
        <StatePanel heading="No matching compliance signals" tone="neutral" status>
          <p>No authorized source summaries match this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Compliance signals">
          {view.signals.map((signal) => (
            <article className="summary-card" key={signal.signalReference}>
              <p className="bop-eyebrow">
                {label(signal.kind)} · {signal.caseTypeCode}
              </p>
              <h2>
                {signal.severity === "ImmediateDanger" ? "Immediate Danger" : signal.severity}
              </h2>
              <p>
                {signal.dueDisposition}
                {signal.dueAt === null ? "" : ` · due ${signal.dueAt}`}
              </p>
              <p>
                Evidence {signal.evidencePresentCount} / {signal.evidenceRequiredCount} ·{" "}
                {signal.evidenceComplete ? "complete" : "incomplete"}
              </p>
              <p>
                Owning {label(signal.owningKind)} {signal.owningReference}
              </p>
              <div className="card-actions">
                <button type="button">
                  Open owning {signal.owningKind === "ComplianceCase" ? "case" : "record"}
                </button>
                <button
                  type="button"
                  aria-pressed={acknowledged.has(signal.signalReference)}
                  onClick={() =>
                    setAcknowledged((current) => new Set(current).add(signal.signalReference))
                  }
                >
                  {acknowledged.has(signal.signalReference)
                    ? "Navigation alert acknowledged"
                    : "Acknowledge navigation alert"}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        This rebuildable dashboard never edits owning cases, records, Product, Inventory, Employee,
        Device, Order, or source evidence.
      </p>
    </main>
  );
}
export function ComplianceDashboardPage({
  client = unavailableComplianceDashboardClient,
}: {
  readonly client?: ComplianceDashboardClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) {
          const view = parseComplianceDashboardView(value);
          setState({ kind: view.freshness === "Stale" ? "Stale" : "Found", view } as State);
        }
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceDashboardPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <ComplianceDashboardList view={state.view} />
  ) : (
    <ComplianceDashboardState state={state.kind} />
  );
}
