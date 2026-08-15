import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  ComplianceMonitoringPageError,
  parseCleaningLogView,
  parseTemperatureLogView,
  unavailableComplianceMonitoringClient,
  type CleaningLogView,
  type ComplianceMonitoringClient,
  type ComplianceMonitoringPageErrorCode,
  type TemperatureLogView,
} from "./compliance-monitoring-pages.js";
type PageState<T> =
  | { readonly kind: "Loading" | ComplianceMonitoringPageErrorCode }
  | { readonly kind: "Found"; readonly view: T };
export function ComplianceMonitoringState({
  state,
}: {
  readonly state: "Loading" | ComplianceMonitoringPageErrorCode;
}) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Compliance monitoring", "Loading authorized records…", "neutral"],
    PermissionDenied: ["Permission denied", "Monitoring access is required.", "error"],
    NotFound: ["Record not found", "No authorized monitoring record exists.", "neutral"],
    Stale: ["Monitoring projection stale", "Refresh source records before acting.", "offline"],
    Conflict: ["Record changed", "Refresh the append-only sequence before acting.", "offline"],
    CommandFailed: [
      "Action failed",
      "No Reading, Excursion, or Cleaning fact was recorded.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached records cannot authorize actions.", "offline"],
    Unavailable: [
      "Monitoring unavailable",
      "No temperature, completion, or verification state is inferred.",
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
export function TemperatureLog({ view }: { readonly view: TemperatureLogView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-TEMP-LOG · Operations Compliance</p>
          <h1>Temperature Log</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayRecordManual ? (
          <button>Record controlled manual reading</button>
        ) : null}
      </header>
      <form className="list-filters" aria-label="Temperature filters">
        <label>
          Scope
          <input value={view.filters.targetReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Device
          <input value={view.filters.deviceReference ?? "All"} readOnly />
        </label>
        <label>
          Range result
          <input value={view.filters.thresholdResult ?? "All"} readOnly />
        </label>
        <label>
          Source
          <input value={view.filters.method ?? "All"} readOnly />
        </label>
        <label>
          Unverified
          <input value={view.filters.unverifiedOnly ? "Only" : "Include"} readOnly />
        </label>
      </form>
      {view.readings.length === 0 ? (
        <StatePanel heading="No Temperature Readings" tone="neutral" status>
          <p>No authorized Reading matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Temperature readings">
          {view.readings.map((item) => (
            <article className="summary-card" key={item.readingReference}>
              <p className="bop-eyebrow">
                {item.targetCode} · {label(item.method)}
              </p>
              <h2>{label(item.thresholdResult)}</h2>
              <p>
                {item.measurementTypeCode} · {item.value ?? "No measured value"}{" "}
                {item.value === null ? "" : item.unitCode}
              </p>
              <p>
                Measured {item.measuredAt} · captured {item.capturedAt}
              </p>
              <p>
                Operator {item.operatorReference} · device {item.deviceReference ?? "None"} ·
                calibration {item.calibrationReference ?? "None"}
              </p>
              <p>
                Policy {item.policyVersionReference}
                {item.correctionOfReadingReference
                  ? ` · correction of ${item.correctionOfReadingReference}`
                  : ""}
              </p>
              {item.excursion ? (
                <>
                  <p>
                    {item.excursion.severity} Excursion · {label(item.excursion.status)}
                  </p>
                  <p>
                    Owning-Domain containment {item.excursion.containmentReference ?? "Pending"} ·
                    disposition {item.excursion.dispositionReference ?? "Not confirmed"}
                  </p>
                  <div className="card-actions">
                    {view.permissions.mayAcknowledgeExcursion ? (
                      <button>Acknowledge Excursion</button>
                    ) : null}
                    {view.permissions.mayOpenIncident ? <button>Open incident</button> : null}
                    {view.permissions.mayCreateCorrectiveAction ? (
                      <button>Create Corrective Action</button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Missing or Device Fault records never imply normal or abnormal. Inventory owns Hold,
        release, disposal, Recall, and Stock Ledger outcomes.
      </p>
    </main>
  );
}
export function CleaningLog({ view }: { readonly view: CleaningLogView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CMP-CLEANING · Operations Compliance</p>
          <h1>Cleaning and Sanitation</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
      </header>
      <form className="list-filters" aria-label="Cleaning filters">
        <label>
          Area or equipment
          <input value={view.filters.targetReference ?? "All authorized"} readOnly />
        </label>
        <label>
          Status
          <input value={view.filters.status ?? "All"} readOnly />
        </label>
        <label>
          Assignee
          <input value={view.filters.assigneeReference ?? "All"} readOnly />
        </label>
        <label>
          Due
          <input value={view.filters.dueDisposition ?? "All"} readOnly />
        </label>
        <label>
          Missed
          <input value={view.filters.missedOnly ? "Only" : "Include"} readOnly />
        </label>
      </form>
      {view.records.length === 0 ? (
        <StatePanel heading="No Cleaning Records" tone="neutral" status>
          <p>No authorized task matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Cleaning records">
          {view.records.map((item) => (
            <article className="summary-card" key={item.cleaningReference}>
              <p className="bop-eyebrow">
                {item.targetCode} · {item.severity}
              </p>
              <h2>{label(item.status)}</h2>
              <p>
                Task {item.taskReference} · schedule {item.scheduleReference}
              </p>
              <p>
                Procedure {item.procedureVersionReference} · assignee {item.assigneeReference}
              </p>
              <p>
                Due {item.dueAt} ({item.dueTimezone}) · completed {item.completedAt ?? "No"}
              </p>
              <p>
                Method {item.methodCode} · chemical control {label(item.chemicalResult)} · Evidence
                refs {item.evidenceReferenceCount}
              </p>
              <p>
                Verification {label(item.verificationResult)} · verifier{" "}
                {item.verifierReference ?? "None"}
              </p>
              {item.safetyReviewReference ? (
                <p>Safety Review {item.safetyReviewReference}</p>
              ) : null}
              <div className="card-actions">
                {view.permissions.mayComplete && item.status === "InProgress" ? (
                  <button>Complete with Evidence reference</button>
                ) : null}
                {view.permissions.mayReportCannotComplete &&
                ["Scheduled", "InProgress"].includes(item.status) ? (
                  <button>Report cannot complete</button>
                ) : null}
                {view.permissions.mayVerify && item.status === "Completed" ? (
                  <button>Verify independently</button>
                ) : null}
                {view.permissions.mayEscalateMissed && item.missed ? (
                  <button>Escalate missed task</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Records append; checkboxes never overwrite history. Chemical instructions and raw Evidence
        are outside this screen.
      </p>
    </main>
  );
}
function usePage<T>(
  client: ComplianceMonitoringClient,
  parse: (value: unknown) => T,
): PageState<T> {
  const [state, setState] = useState<PageState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      },
      (error: unknown) => {
        if (active)
          setState({
            kind: error instanceof ComplianceMonitoringPageError ? error.code : "Unavailable",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, parse]);
  return state;
}
export function TemperatureLogPage({
  client = unavailableComplianceMonitoringClient,
}: {
  readonly client?: ComplianceMonitoringClient;
}) {
  const state = usePage(client, parseTemperatureLogView);
  return state.kind === "Found" ? (
    <TemperatureLog view={state.view} />
  ) : (
    <ComplianceMonitoringState state={state.kind} />
  );
}
export function CleaningLogPage({
  client = unavailableComplianceMonitoringClient,
}: {
  readonly client?: ComplianceMonitoringClient;
}) {
  const state = usePage(client, parseCleaningLogView);
  return state.kind === "Found" ? (
    <CleaningLog view={state.view} />
  ) : (
    <ComplianceMonitoringState state={state.kind} />
  );
}
