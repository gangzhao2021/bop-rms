import { useEffect, useMemo, useRef, useState } from "react";
import {
  createProductPublicationValidationReportClientV2,
  assertProductPublicationValidationReportSelection,
  ProductPublicationValidationReportClientError,
  type ProductPublicationValidationReportRequestV2,
  type ProductPublicationValidationReportViewV2,
} from "./product-publication-validation-report-client-v2.js";
import type { ProductPublicationManagementViewV2 } from "./product-publication-management-client-v2.js";
export interface ProductPublicationWarningConfirmation {
  readonly report: ProductPublicationValidationReportViewV2;
  readonly reasonCode: string;
  readonly confirmed: true;
}
type Observation = Awaited<
  ReturnType<ReturnType<typeof createProductPublicationValidationReportClientV2>["load"]>
>;
type State =
  | { kind: "Ready" | "Snapshot"; observation: Observation }
  | { kind: "Idle" | "Loading" | ProductPublicationValidationReportClientError["code"] };
const copy: Record<Exclude<State["kind"], "Ready" | "Snapshot">, string> = {
  Idle: "Load the selected version’s recorded validation report.",
  Loading: "Loading validation report…",
  Invalid:
    "The validation report request is invalid. Refresh publication records before trying again.",
  Denied: "Validation report access denied. Restore current access before reading this report.",
  FeatureDisabled: "Validation report is unavailable while this capability is disabled.",
  Unavailable: "Validation report unavailable. No checks or findings have been assumed.",
  Stale: "The report read expired before it completed. Refresh to try again.",
  ScopeChanged:
    "The selected scope or version changed. Refresh publication records before reading the report.",
};
const labels = {
  ApprovalPolicy: "Approval policy",
  ChangeImpact: "Change impact",
  DefaultLocaleName: "Default locale name",
  EffectivePeriod: "Effective period",
  HardErrorsCleared: "Blocking errors cleared",
  InternalCode: "Internal code",
  MediaReady: "Media readiness",
  OptionSelection: "Option selection",
  PublishableSku: "Publishable SKU",
  TaxResolution: "Tax classification",
  UniqueScope: "Unique publication scope",
  VariantMapping: "Variant mapping",
};
const findingDescriptions: Readonly<Record<string, string>> = {
  REQUIRED_PRICING_REFERENCE_MISSING: "This SKU has no recorded price configuration.",
  REQUIRED_RECIPE_REFERENCE_MISSING: "This SKU has no recorded recipe configuration.",
  REQUIRED_INVENTORY_REFERENCE_MISSING: "This SKU has no recorded inventory configuration.",
  REQUIRED_MENU_REFERENCE_MISSING: "This SKU has no recorded menu configuration.",
};
export function ProductPublicationValidationReport({
  request,
  publication,
  csrf,
  paused,
  unsaved,
  onAcknowledge,
}: {
  readonly request: ProductPublicationValidationReportRequestV2 | null;
  readonly publication: ProductPublicationManagementViewV2["versions"][number] | null;
  readonly csrf: string;
  readonly paused: boolean;
  readonly unsaved: boolean;
  readonly onAcknowledge: (confirmation: ProductPublicationWarningConfirmation) => Promise<void>;
}) {
  const client = useMemo(() => createProductPublicationValidationReportClientV2(), []),
    pending = useRef<AbortController | null>(null),
    active = useRef(true),
    summary = useRef<HTMLParagraphElement>(null),
    focusSummary = useRef(false);
  const [state, setState] = useState<State>({ kind: "Idle" }),
    [shown, setShown] = useState(20),
    [reasonCode, setReasonCode] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (paused) {
      pending.current?.abort();
      pending.current = null;
      setState({ kind: "Idle" });
      setShown(20);
      setReasonCode("");
      setConfirmed(false);
    }
  }, [paused]);
  const deadline = state.kind === "Ready" ? state.observation.validUntil : null;
  useEffect(() => {
    if (!deadline) return;
    const timer = setTimeout(
      () => {
        if (active.current)
          setState((current) =>
            current.kind === "Ready" && current.observation.validUntil === deadline
              ? { kind: "Snapshot", observation: current.observation }
              : current,
          );
      },
      Math.max(0, Date.parse(deadline) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline]);
  useEffect(() => {
    if (focusSummary.current && state.kind !== "Loading") {
      focusSummary.current = false;
      summary.current?.focus();
    }
  }, [state.kind]);
  async function load() {
    if (!request || paused || pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    focusSummary.current = true;
    setState({ kind: "Loading" });
    setShown(20);
    setReasonCode("");
    setConfirmed(false);
    try {
      const observation = await client.load({ request, csrf }, abort.signal);
      await assertProductPublicationValidationReportSelection(observation.view, publication);
      if (Date.now() >= Date.parse(observation.validUntil))
        throw new ProductPublicationValidationReportClientError("Stale");
      if (active.current && !abort.signal.aborted && pending.current === abort)
        setState({ kind: "Ready", observation });
    } catch (error) {
      if (active.current && !abort.signal.aborted && pending.current === abort)
        setState({
          kind:
            error instanceof ProductPublicationValidationReportClientError
              ? error.code
              : "Unavailable",
        });
    } finally {
      if (pending.current === abort) pending.current = null;
    }
  }
  const observation =
      !paused && (state.kind === "Ready" || state.kind === "Snapshot") ? state.observation : null,
    view = observation?.view,
    report = view?.report,
    staleSnapshot =
      observation !== null &&
      (state.kind === "Snapshot" || Date.now() >= Date.parse(observation.validUntil)),
    status = paused
      ? "Report reading is paused while the page is unavailable or another request needs attention."
      : !request
        ? "Load publication records and select a version before reading its report."
        : state.kind === "Ready" || state.kind === "Snapshot"
          ? staleSnapshot
            ? "Recorded snapshot — current access and source status are stale. This previously authorized report remains visible; refresh to check current access and records. Every publication action requires fresh server validation."
            : "Validation report read completed. Recorded results are historical evidence; every publication action still requires current server validation."
          : copy[state.kind];
  const findings = report?.details.coverage === "Complete" ? report.details.findings : [];
  const warnings = report?.validation.checks.filter((check) => check.outcome === "Warning") ?? [],
    hardErrors = report?.validation.checks.some((check) => check.outcome === "HardError") ?? false,
    canConfirm = Boolean(
      report &&
      report.details.coverage === "Complete" &&
      report.warningBindingDigest !== null &&
      warnings.length > 0 &&
      !hardErrors &&
      view?.applicability === "CurrentDraftContent",
    ),
    validReason = /^[A-Z][A-Z0-9_-]{0,63}$/u.test(reasonCode);
  return (
    <section
      className="product-validation-report"
      aria-labelledby="product-validation-report-title"
      style={{ overflowWrap: "anywhere" }}
    >
      <h4 id="product-validation-report-title">Validation report</h4>
      <button
        type="button"
        disabled={!request || paused || state.kind === "Loading"}
        onClick={() => void load()}
      >
        {state.kind === "Idle" ? "Load validation report" : "Refresh validation report"}
      </button>
      <p ref={summary} tabIndex={-1} role="status">
        {status}
      </p>
      {view && (
        <>
          <p>
            Selected version · publication revision {view.publicationVersion} · Product revision{" "}
            {view.aggregateVersion}. Read observed{" "}
            <time dateTime={view.observedAt}>{view.observedAt}</time>.
          </p>
          {view.status === "NotValidated" ? (
            <p>At read time, this Draft had not been validated. No report was recorded.</p>
          ) : view.status === "NotRecorded" ? (
            <p>
              No validation report was recorded for this legacy publication revision. Missing
              evidence is not a successful check.
            </p>
          ) : null}
          {view.applicability === "CurrentDraftContent" && (
            <p>
              At read time, the report matched the saved Draft content and configuration. This does
              not establish current publication eligibility.
            </p>
          )}
          {view.applicability === "ChangedDraftContent" && (
            <p>
              At read time, the saved Draft had changed since this report. Validate the updated
              Draft before relying on new results.
            </p>
          )}
          {view.applicability === "HistoricalVersion" && (
            <p>
              At read time, this report belonged to a historical version, not the current Draft.
            </p>
          )}
          {unsaved && (
            <p>Unsaved scope or period proposals are not included in this recorded report.</p>
          )}
          {publication && (
            <details>
              <summary>Recorded scope and effective period</summary>
              <ul>
                {publication.scopeSet.map((scope, index) => (
                  <li key={index}>
                    {scope.level}
                    {scope.reference === view.storeReference
                      ? " · selected Store"
                      : scope.reference
                        ? " · recorded reference"
                        : ""}
                    ; channels: {scope.channelCodes.join(", ") || "all recorded channels"}; order
                    types: {scope.orderTypeCodes.join(", ") || "all recorded order types"}.
                  </li>
                ))}
              </ul>
              <p>
                {publication.effectivePeriod.timeZone} · from{" "}
                {publication.effectivePeriod.effectiveFrom.instant}
                {publication.effectivePeriod.effectiveUntil
                  ? ` until ${publication.effectivePeriod.effectiveUntil.instant}`
                  : " · no end recorded"}
                .
              </p>
            </details>
          )}
          {report && (
            <>
              <p>
                Recorded after {report.publicationAction} at{" "}
                <time dateTime={report.recordedAt}>{report.recordedAt}</time>. Policy version{" "}
                {report.binding.policyVersion} ·{" "}
                {report.validation.approvalPolicy === "Required"
                  ? "independent approval required"
                  : "approval not required by the recorded policy"}
                .
              </p>
              <p>
                Historical checks observed {report.validation.checkedAt}; original evidence deadline{" "}
                {report.validation.validUntil}. This deadline describes the recorded check, not the
                current read.
              </p>
              <ul aria-label="Recorded validation checks">
                {report.validation.checks.map((check) => (
                  <li key={check.code}>
                    <strong>{labels[check.code]}</strong> ({check.code}):{" "}
                    {check.outcome === "Pending"
                      ? "Pending approval"
                      : check.outcome === "HardError"
                        ? "Blocking error"
                        : check.outcome}
                    .
                  </li>
                ))}
              </ul>
              {report.details.coverage === "ChecksOnly" ? (
                <p>
                  Only check results were recorded. Detailed findings and impact evidence were not
                  recorded.
                </p>
              ) : (
                <>
                  <p>
                    Detailed findings recorded: {findings.length}.{" "}
                    {findings.length === 0
                      ? "No findings were recorded in this report."
                      : `Showing ${Math.min(shown, findings.length)} of ${findings.length}.`}
                  </p>
                  <ol aria-label="Recorded validation findings">
                    {findings.slice(0, shown).map((finding, index) => (
                      <li key={index}>
                        <strong>
                          {finding.outcome === "HardError" ? "Blocking error" : "Warning"}
                        </strong>{" "}
                        · {labels[finding.checkCode]} ({finding.checkCode}) · {finding.ruleCode} ·{" "}
                        {finding.reasonCode}
                        {findingDescriptions[finding.reasonCode] && (
                          <p>{findingDescriptions[finding.reasonCode]}</p>
                        )}
                        {finding.subjectReference !== null && (
                          <p>
                            Affected reference: <span>{finding.subjectReference}</span>
                          </p>
                        )}
                        {finding.references.length > 0 && (
                          <details>
                            <summary>Related references ({finding.references.length})</summary>
                            <ul>
                              {finding.references.map((reference, i) => (
                                <li key={i}>
                                  {reference.sourceCode} ·{" "}
                                  <span style={{ overflowWrap: "anywhere" }}>
                                    {reference.resourceReference}
                                  </span>
                                  {reference.versionReference ? (
                                    <>
                                      {" "}
                                      · version{" "}
                                      <span style={{ overflowWrap: "anywhere" }}>
                                        {reference.versionReference}
                                      </span>
                                    </>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                  {shown < findings.length && (
                    <button type="button" onClick={() => setShown((value) => value + 20)}>
                      Show more recorded findings
                    </button>
                  )}
                </>
              )}
              {warnings.length > 0 &&
                (canConfirm ? (
                  <fieldset
                    className="product-complete-draft-fields"
                    style={{ minWidth: 0 }}
                    aria-describedby="publication-warning-confirmation-help"
                    disabled={paused || unsaved}
                  >
                    <legend>Confirm recorded warnings</legend>
                    <p id="publication-warning-confirmation-help">
                      Confirmation records your acceptance of these warnings and affected
                      references. The server checks current access, saved content, references and
                      policy when you confirm. Publication and independent approval still require
                      their own requests.
                    </p>
                    <ul aria-label="Warnings to confirm">
                      {warnings.map((check) => (
                        <li key={check.code}>
                          {labels[check.code]} ({check.code})
                        </li>
                      ))}
                    </ul>
                    {staleSnapshot && (
                      <p>
                        This report remains available for review. Confirmation obtains fresh server
                        checks; the read deadline is not a time limit for your decision.
                      </p>
                    )}
                    {unsaved && (
                      <p>
                        Validate your unsaved scope or period proposal before confirming its
                        warnings.
                      </p>
                    )}
                    <label htmlFor="publication-warning-reason">
                      Confirmation reason code (required)
                    </label>
                    <input
                      id="publication-warning-reason"
                      value={reasonCode}
                      required
                      maxLength={64}
                      pattern="[A-Z][A-Z0-9_-]{0,63}"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="publication-warning-reason-help"
                      aria-invalid={reasonCode !== "" && !validReason}
                      onChange={(event) => {
                        setReasonCode(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                    <p id="publication-warning-reason-help">
                      Use 1–64 uppercase letters, numbers, underscores or hyphens, beginning with a
                      letter.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      I have reviewed these recorded warnings and affected references and confirm my
                      acceptance.
                    </label>
                    <button
                      type="button"
                      disabled={paused || unsaved || !validReason || !confirmed}
                      onClick={() => {
                        if (view && canConfirm && validReason && confirmed && !paused && !unsaved)
                          void onAcknowledge({ report: view, reasonCode, confirmed: true });
                      }}
                    >
                      Confirm warnings
                    </button>
                  </fieldset>
                ) : (
                  <p>
                    {hardErrors
                      ? "Blocking errors must be resolved before warnings can be confirmed."
                      : report.details.coverage !== "Complete"
                        ? "Warning confirmation requires the complete recorded findings and reference evidence."
                        : view?.applicability === "HistoricalVersion"
                          ? "This historical version can be read, but confirmation requires the current Draft."
                          : "Validate the changed Draft before confirming its warnings."}
                  </p>
                ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
