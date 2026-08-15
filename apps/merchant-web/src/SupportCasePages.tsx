import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState } from "react";
import {
  parseSupportCasePageView,
  SupportCasePageError,
  unavailableSupportCasePageClient,
  type SupportCasePageClient,
  type SupportCasePageErrorCode,
  type SupportCasePageView,
} from "./support-case-pages.js";
type State =
  | { readonly kind: "Loading" | SupportCasePageErrorCode }
  | { readonly kind: "Found"; readonly view: SupportCasePageView };
function Status({ kind }: { readonly kind: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: "Loading purpose-bound Support Cases…",
    PermissionDenied: "Authorized Support or Approver permission is required.",
    PurposeRequired: "Select a declared support purpose and exact Case.",
    MfaRequired: "Recent TOTP MFA is required for diagnostic approval.",
    Stale: "The projection is stale. Refresh before acting.",
    Conflict: "The Case version changed. Refresh before acting.",
    Offline: "Offline read-only. Diagnostic actions are disabled.",
    Unavailable: "Support Case metadata is unavailable.",
  } as const;
  return (
    <StatePanel
      heading={kind === "Loading" ? "Loading Support Cases" : "Support Cases unavailable"}
      tone={kind === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{copy[kind]}</p>
    </StatePanel>
  );
}
function Screen({ view }: { readonly view: SupportCasePageView }) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("All"),
    [caseType, setCaseType] = useState("All"),
    [owner, setOwner] = useState("All"),
    [due, setDue] = useState("All"),
    cases = useMemo(
      () =>
        view.cases.filter(
          (item) =>
            (status === "All" || item.status === status) &&
            (caseType === "All" || item.caseType === caseType) &&
            (owner === "All" || (item.assignedRole ?? "Unassigned") === owner) &&
            (due === "All" ||
              (due === "Due" && Date.parse(item.dueAt) <= Date.parse(view.sourceAsOf)) ||
              (due === "Upcoming" && Date.parse(item.dueAt) > Date.parse(view.sourceAsOf))) &&
            `${item.caseCode} ${item.tenant} ${item.store ?? ""}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
        ),
      [caseType, due, owner, query, status, view.cases, view.sourceAsOf],
    ),
    caseTypes = useMemo(() => [...new Set(view.cases.map((item) => item.caseType))], [view.cases]),
    owners = useMemo(
      () => [...new Set(view.cases.map((item) => item.assignedRole ?? "Unassigned"))],
      [view.cases],
    ),
    writable = view.freshness === "Fresh" && view.completeness === "Complete";
  return (
    <AppFrame
      title="Support cases"
      description={`${view.screenId} · ${view.environment} · ${view.freshness}`}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId}</p>
          <h2>Purpose-bound diagnostic access</h2>
          <p>
            <strong>Production access warning.</strong> Actor {view.actor} · purpose {view.purpose}{" "}
            · recent MFA {view.recentMfa ? "verified" : "required"}. Impersonation is prohibited.
          </p>
        </div>
        <button disabled={!view.mayCreate || !writable}>Create case</button>
      </header>
      <div className="list-filters" role="search">
        <label>
          Case, Tenant, or Store
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
            <option>All</option>
            <option>Open</option>
            <option>Assigned</option>
            <option>AccessPendingApproval</option>
            <option>AccessGranted</option>
            <option>Revoked</option>
            <option>Closed</option>
          </select>
        </label>
        <label>
          Type
          <select value={caseType} onChange={(event) => setCaseType(event.currentTarget.value)}>
            <option>All</option>
            {caseTypes.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Owner role
          <select value={owner} onChange={(event) => setOwner(event.currentTarget.value)}>
            <option>All</option>
            {owners.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Due
          <select value={due} onChange={(event) => setDue(event.currentTarget.value)}>
            <option>All</option>
            <option>Due</option>
            <option>Upcoming</option>
          </select>
        </label>
      </div>
      {cases.length === 0 ? (
        <StatePanel heading="No matching Support Cases" status>
          <p>Change the safe filters.</p>
        </StatePanel>
      ) : (
        cases.map((item) => (
          <StatePanel
            key={item.caseReference}
            heading={item.caseCode}
            tone={item.status === "AccessGranted" ? "offline" : "neutral"}
          >
            <p>
              <strong>{item.status}</strong> · {item.tenant} · {item.store ?? "Tenant scope"}
            </p>
            <p>
              {item.caseType} · purpose {item.purpose} · requester{" "}
              {item.requesterVerified ? "verified" : "not verified"}
            </p>
            <p>
              Assigned role {item.assignedRole ?? "Unassigned"} · due {item.dueAt} · access expiry{" "}
              {item.accessExpiresAt ?? "No active grant"}
            </p>
            <p>
              {item.actionCount} minimized action records · {item.evidenceReferences.length}{" "}
              evidence references
            </p>
            <div className="button-row">
              <button disabled={!item.mayAssign || !writable}>Assign</button>
              <button
                disabled={!item.mayGrant || !writable || !view.recentMfa}
                title="Fresh independent approval and recent MFA required"
              >
                Grant 15-minute access
              </button>
              <button disabled={!item.mayRecordAction || !writable}>Record safe action</button>
              <button disabled={!item.mayRevoke || !writable}>Revoke</button>
              <button disabled={!item.mayClose || !writable}>Close</button>
            </div>
          </StatePanel>
        ))
      )}
    </AppFrame>
  );
}
export function SupportCasePage({
  client = unavailableSupportCasePageClient,
}: {
  readonly client?: SupportCasePageClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client
      .loadCases()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseSupportCasePageView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof SupportCasePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? <Screen view={state.view} /> : <Status kind={state.kind} />;
}
