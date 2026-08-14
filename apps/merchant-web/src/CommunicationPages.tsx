import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import {
  CommunicationClientError,
  parseCommunicationHistoryView,
  parseCommunicationTemplateView,
  unavailableCommunicationClient,
  type CommunicationClient,
  type CommunicationClientErrorCode,
  type CommunicationHistoryView,
  type CommunicationTemplateView,
} from "./communication-pages.js";
type State =
  | { readonly kind: "Loading" | CommunicationClientErrorCode }
  | { readonly kind: "History"; readonly view: CommunicationHistoryView }
  | { readonly kind: "Templates"; readonly view: CommunicationTemplateView };
export function CommunicationState({
  state,
}: {
  readonly state: Exclude<State["kind"], "History" | "Templates">;
}) {
  const map: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading communication evidence…", "neutral"],
    PermissionDenied: ["Permission denied", "Communication evidence is unavailable.", "error"],
    NotFound: ["Not found", "No communication record is available.", "neutral"],
    FeatureDisabled: ["Communication disabled", "This capability is unavailable.", "neutral"],
    Stale: ["Projection stale", "Refresh before any action.", "offline"],
    Conflict: ["Record changed", "Refresh Expected Version.", "offline"],
    Validation: ["Action blocked", "Eligibility or approval evidence is missing.", "error"],
    CommandFailed: ["Command failed", "No attempt or Template Version was overwritten.", "error"],
    Offline: ["Offline read-only", "Cached history cannot authorize resend.", "offline"],
    Unavailable: ["Communication unavailable", "No Provider outcome is inferred.", "error"],
  };
  const v = map[state];
  return (
    <StatePanel heading={v[0]} tone={v[2]} status>
      <p>{v[1]}</p>
    </StatePanel>
  );
}
export function CommunicationHistory({ view }: { readonly view: CommunicationHistoryView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">COMMS-HISTORY</p>
          <h1>Communication history</h1>
          <p>{view.brandLabel} · immutable delivery evidence</p>
        </div>
      </header>
      {readOnly ? <CommunicationState state="Stale" /> : null}
      <div className="list-filters">
        <label>
          Source ref / exact authorized recipient
          <input disabled placeholder="Exact reference only" />
        </label>
        <label>
          Type / channel / state / date
          <select disabled>
            <option>All communications</option>
          </select>
        </label>
      </div>
      <div className="card-list">
        {view.rows.map((row) => (
          <article className="summary-card" key={row.requestReference}>
            <p className="bop-eyebrow">
              {row.classification} · {row.channel} · {row.providerState}
            </p>
            <p>
              {row.recipientMasked} · source {row.sourceReference}
            </p>
            <p>
              Template {row.templateReference} v{row.templateVersion} ·{" "}
              {row.suppressed ? "Suppressed" : "Clear"}
            </p>
            <div className="card-actions">
              {view.permissions.mayResendOperational && row.classification === "Operational" ? (
                <button
                  disabled={
                    readOnly || !["Unknown", "Rejected", "DeadLettered"].includes(row.providerState)
                  }
                >
                  Resend eligible operational notification
                </button>
              ) : null}
              {view.permissions.mayManageSuppression ? (
                <button disabled={readOnly}>Verified suppress / unsuppress</button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
export function CommunicationTemplates({ view }: { readonly view: CommunicationTemplateView }) {
  const readOnly = view.freshness !== "Current" || view.partial;
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h1>Communication templates</h1>
          <p>{view.brandLabel} · escaped preview · tracking prohibited</p>
        </div>
      </header>
      {readOnly ? <CommunicationState state="Stale" /> : null}
      <div className="card-list">
        {view.templates.map((t) => (
          <article className="summary-card" key={t.templateReference}>
            <p className="bop-eyebrow">
              {t.templateKey} · {t.current?.status ?? "No version"}
            </p>
            <h2>{t.displayName}</h2>
            {t.current ? (
              <p>
                {t.current.purpose} · {t.current.locale} · {t.current.channel} · version{" "}
                {t.current.sequence}
              </p>
            ) : null}
            <p>Required variables {t.current?.requiredVariables.join(", ") ?? "None"}</p>
            <div className="card-actions">
              {view.permissions.mayEdit ? (
                <button disabled={readOnly}>Create immutable draft</button>
              ) : null}
              {view.permissions.mayTest ? (
                <button disabled={readOnly}>Send test to approved sink</button>
              ) : null}
              {view.permissions.mayApprove ? (
                <button disabled={readOnly || t.current?.status !== "InReview"}>
                  Review / publish
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
  readonly mode: "History" | "Templates";
  readonly client: CommunicationClient;
  readonly reference?: string | undefined;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    const screen =
      mode === "History"
        ? "COMMS-HISTORY"
        : reference
          ? "COMMS-TEMPLATE-EDITOR"
          : "COMMS-TEMPLATE-LIST";
    void client
      .load(screen, reference)
      .then((v) => {
        if (active)
          setState(
            mode === "History"
              ? { kind: "History", view: parseCommunicationHistoryView(v) }
              : { kind: "Templates", view: parseCommunicationTemplateView(v) },
          );
      })
      .catch((e: unknown) => {
        if (active)
          setState({
            kind:
              e instanceof CommunicationClientError
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
  return state.kind === "History" ? (
    <CommunicationHistory view={state.view} />
  ) : state.kind === "Templates" ? (
    <CommunicationTemplates view={state.view} />
  ) : (
    <CommunicationState state={state.kind} />
  );
}
export function CommunicationHistoryPage({
  client = unavailableCommunicationClient,
}: {
  readonly client?: CommunicationClient;
}) {
  return <Page mode="History" client={client} />;
}
export function CommunicationTemplatePage({
  client = unavailableCommunicationClient,
}: {
  readonly client?: CommunicationClient;
}) {
  const { id } = useParams();
  return <Page mode="Templates" client={client} reference={id} />;
}
