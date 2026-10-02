import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useState, type ReactNode } from "react";
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
    <CommunicationHistoryFrame>
      <section className="communication-history-page">
        <CommunicationHistoryHeading context={`${view.brandLabel} · delivery evidence`} />
        {readOnly ? <CommunicationState state="Stale" /> : null}
        <CommunicationHistoryFilters />
        <section aria-labelledby="communication-records-title">
          <header className="communication-records-heading">
            <h2 id="communication-records-title">Delivery evidence</h2>
            <span>{view.rows.length} records</span>
          </header>
          {view.rows.length === 0 ? (
            <StatePanel heading="No communication history records" status>
              <p>The authorized history projection returned no records for this scope.</p>
            </StatePanel>
          ) : (
            <CommunicationHistoryRecords view={view} readOnly={readOnly} />
          )}
        </section>
        <CommunicationHistoryBoundary />
      </section>
    </CommunicationHistoryFrame>
  );
}

function CommunicationHistoryFrame({ children }: { readonly children: ReactNode }) {
  return (
    <AppFrame className="comms-history-shell" title="CUSTOMERS" description="">
      {children}
    </AppFrame>
  );
}

function CommunicationHistoryHeading({ context }: { readonly context: string }) {
  return (
    <header className="communication-history-heading">
      <div>
        <p className="bop-eyebrow">COMMS-HISTORY · PHASE CROSS-PHASE</p>
        <h2>Communication history</h2>
        <p>{context}</p>
      </div>
      <span>Source values unavailable</span>
    </header>
  );
}

function CommunicationHistoryFilters() {
  return (
    <fieldset className="communication-history-filters" disabled aria-labelledby="history-filters">
      <legend id="history-filters">Filters</legend>
      <label>
        Source / permitted recipient
        <input placeholder="Unavailable" />
      </label>
      <label>
        Classification
        <select defaultValue="Unavailable">
          <option>Unavailable</option>
        </select>
      </label>
      <label>
        Channel
        <select defaultValue="Unavailable">
          <option>Unavailable</option>
        </select>
      </label>
      <label>
        Provider state
        <select defaultValue="Unavailable">
          <option>Unavailable</option>
        </select>
      </label>
      <label>
        Date range
        <input placeholder="Unavailable" />
      </label>
      <label>
        Suppression
        <select defaultValue="Unavailable">
          <option>Unavailable</option>
        </select>
      </label>
      <p>Filters are unavailable until the authorized history projection is connected.</p>
    </fieldset>
  );
}

function CommunicationHistoryBoundary() {
  return (
    <>
      <aside className="communication-history-actions" aria-labelledby="history-actions-title">
        <h3 id="history-actions-title">History actions unavailable</h3>
        <p>
          Evidence viewing needs an authorized row. Resend is limited to eligible Operational
          messages; suppression requires its verified process. No commands are connected.
        </p>
      </aside>
      <p className="communication-history-privacy">
        Recipients remain masked by default. Exact-recipient search requires separate permission;
        opaque source and template references are not displayed.
      </p>
    </>
  );
}

function CommunicationHistoryRecords({
  view,
  readOnly,
}: {
  readonly view: CommunicationHistoryView;
  readonly readOnly: boolean;
}) {
  return (
    <div className="communication-history-table-wrap">
      <table className="communication-history-table">
        <thead>
          <tr>
            <th scope="col">Classification / channel</th>
            <th scope="col">Recipient</th>
            <th scope="col">Source / time</th>
            <th scope="col">Template version</th>
            <th scope="col">Provider state</th>
            <th scope="col">Suppression</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.requestReference}>
              <td data-label="Classification / channel">
                {row.classification} · {row.channel}
              </td>
              <td data-label="Recipient">{row.recipientMasked}</td>
              <td data-label="Source / time">
                <span>Source reference unavailable</span>
                <time dateTime={row.attemptedAt ?? undefined}>
                  {row.attemptedAt
                    ? formatCommunicationTime(row.attemptedAt)
                    : "No attempt recorded"}
                </time>
              </td>
              <td data-label="Template version">Version {row.templateVersion}</td>
              <td data-label="Provider state">{row.providerState}</td>
              <td data-label="Suppression">{row.suppressed ? "Suppressed" : "Not suppressed"}</td>
              <td data-label="Actions">
                <div
                  className="communication-history-row-actions"
                  aria-describedby="communication-actions-unavailable"
                >
                  {view.permissions.mayResendOperational && row.classification === "Operational" ? (
                    <button disabled aria-describedby="communication-actions-unavailable">
                      Resend operational
                    </button>
                  ) : null}
                  {view.permissions.mayManageSuppression ? (
                    <button disabled aria-describedby="communication-actions-unavailable">
                      Manage suppression
                    </button>
                  ) : null}
                  {!view.permissions.mayResendOperational &&
                  !view.permissions.mayManageSuppression ? (
                    <span>Unavailable</span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="communication-history-record-cards">
        {view.rows.map((row) => (
          <article className="communication-history-record" key={row.requestReference}>
            <h3>
              {row.classification} · {row.channel}
            </h3>
            <dl>
              <div>
                <dt>Recipient</dt>
                <dd>{row.recipientMasked}</dd>
              </div>
              <div>
                <dt>Source / time</dt>
                <dd>
                  Source reference unavailable ·{" "}
                  {row.attemptedAt
                    ? formatCommunicationTime(row.attemptedAt)
                    : "No attempt recorded"}
                </dd>
              </div>
              <div>
                <dt>Template version</dt>
                <dd>Version {row.templateVersion}</dd>
              </div>
              <div>
                <dt>Provider state</dt>
                <dd>{row.providerState}</dd>
              </div>
              <div>
                <dt>Suppression</dt>
                <dd>{row.suppressed ? "Suppressed" : "Not suppressed"}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <p id="communication-actions-unavailable" role="note">
        Communication commands are not connected. This view is read-only; no resend, suppression,
        template, or Provider action will be performed here.
      </p>
      {readOnly ? (
        <p className="communication-history-read-only">
          Actions also require a current, complete projection.
        </p>
      ) : null}
    </div>
  );
}

export function CommunicationHistoryUnavailable({
  state,
}: {
  readonly state: Exclude<State["kind"], "History" | "Templates">;
}) {
  return (
    <CommunicationHistoryFrame>
      <section className="communication-history-page">
        <CommunicationHistoryHeading context="Operational and marketing delivery evidence · authorized source values unavailable" />
        <div className="communication-history-state">
          <CommunicationState state={state} />
        </div>
        <CommunicationHistoryFilters />
        <section aria-labelledby="communication-records-title">
          <header className="communication-records-heading">
            <h2 id="communication-records-title">Delivery evidence</h2>
            <span>Source unavailable</span>
          </header>
          <div className="communication-history-empty">
            <h3>History unavailable</h3>
            <p>
              No authorized records are available to display. No sample recipients, templates or
              Provider outcomes are shown.
            </p>
          </div>
        </section>
        <CommunicationHistoryBoundary />
      </section>
    </CommunicationHistoryFrame>
  );
}

function formatCommunicationTime(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
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
      <p id="communication-actions-unavailable" role="note">
        Communication commands are not connected. This view is read-only; no resend, suppression,
        template, or Provider action will be performed here.
      </p>
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
                <button disabled aria-describedby="communication-actions-unavailable">
                  Create immutable draft
                </button>
              ) : null}
              {view.permissions.mayTest ? (
                <button disabled aria-describedby="communication-actions-unavailable">
                  Send test to approved sink
                </button>
              ) : null}
              {view.permissions.mayApprove ? (
                <button disabled aria-describedby="communication-actions-unavailable">
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
  ) : mode === "History" ? (
    <CommunicationHistoryUnavailable state={state.kind} />
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
