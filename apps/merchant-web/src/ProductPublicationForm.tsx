import {
  ProductPublicationValidationReport,
  type ProductPublicationWarningConfirmation,
} from "./ProductPublicationValidationReport.js";
import type { ProductPublicationValidationReportRequestV2 } from "./product-publication-validation-report-client-v2.js";
import { createProductPublicationCommandClientV2 } from "./product-publication-command-client-v2.js";
import { createProductPublicationWarningAcknowledgementClient } from "./product-publication-warning-acknowledgement-client.js";
import { createProductPublicationResolutionClient } from "./product-publication-resolution-client.js";
import { useEffect, useRef, useState } from "react";
import {
  createProductPublicationControllerV2,
  PublicationControllerError,
  type ProductPublicationControllerV2,
} from "./product-publication-controller-v2.js";
import {
  createProductPublicationManagementClientV2,
  type ProductPublicationManagementViewV2,
} from "./product-publication-management-client-v2.js";
import {
  createProductPublicationCommandClient as createLegacyPublicationCommandClient,
  parseProductPublicationPeriod,
  type ProductPublicationUserAction,
} from "./product-publication-command-client.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { createPublicationPendingJournalV2 } from "./product-publication-pending-journal-v2.js";
import type { ProductEditorView } from "./product-editor-client.js";
type View = ReturnType<ProductPublicationControllerV2["view"]>;
const titles: Record<ProductPublicationUserAction, string> = {
  Validate: "Validate publication",
  SubmitReview: "Submit publication review",
  Approve: "Request independent approval",
  Reject: "Reject publication review",
  Publish: "Publish now",
  SchedulePublish: "Schedule publication",
  ReschedulePublish: "Reschedule publication",
  CancelScheduledPublish: "Cancel scheduled publication",
};
function allowed(
  source: ProductPublicationManagementViewV2,
  version: string,
  action: ProductPublicationUserAction,
) {
  const row = source.versions.find((v) => v.versionReference === version);
  if (row && row.profile === null) return false;
  if (action === "Validate")
    return (
      version === source.draft.versionReference &&
      source.draft.contentStatus === "Present" &&
      (!row || row.state === "Draft")
    );
  if (!row) return false;
  if (action === "SubmitReview")
    return (
      row.state === "Draft" &&
      (row.validationDecision === "Pass" || row.validationDecision === "ApprovalPending")
    );
  if (action === "Reject") return row.state === "InReview";
  if (action === "Approve")
    return (
      row.state === "InReview" &&
      row.approvalPolicy === "Required" &&
      ["ApprovalPending", "Pass"].includes(row.validationDecision)
    );
  if (action === "Publish" || action === "SchedulePublish")
    return (
      row.validationDecision === "Pass" &&
      (row.state === "Approved" ||
        (row.state === "InReview" && row.approvalPolicy === "NotRequired"))
    );
  return (
    row.state === "Scheduled" &&
    (action === "CancelScheduledPublish" || row.approvalPolicy === "NotRequired")
  );
}
export function ProductPublicationForm({
  entry,
  productReference,
  storeReference,
  csrf,
  blocked = false,
  onBlockedChange,
  onConfirmed,
  onResolved,
  onManagement,
}: {
  readonly entry: ProductEditorView | null;
  readonly productReference: string;
  readonly storeReference: string;
  readonly csrf: string;
  readonly blocked?: boolean;
  readonly onBlockedChange?: (blocked: boolean) => void;
  readonly onConfirmed?: (aggregateVersion: number, receiptAggregateVersion: number) => void;
  readonly onResolved?: (currentAggregateVersion: number) => void;
  readonly onManagement?: (view: ProductPublicationManagementViewV2 | null) => void;
}) {
  const controller = useRef<ProductPublicationControllerV2 | null>(null),
    pending = useRef<AbortController | null>(null),
    active = useRef(true),
    summary = useRef<HTMLParagraphElement>(null),
    focusSummary = useRef(false),
    automaticOpenEntry = useRef<string | null>(null);
  const [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirmedRevision, setConfirmedRevision] = useState<number | null>(null),
    [resolvedOutcome, setResolvedOutcome] = useState<"Committed" | "Abandoned" | null>(null),
    [confirmedAcknowledgement, setConfirmedAcknowledgement] = useState<{
      readonly aggregateVersion: number;
      readonly reasonCode: string;
      readonly warningCodes: readonly string[];
    } | null>(null),
    [offline, setOffline] = useState(!navigator.onLine),
    [background, setBackground] = useState(document.visibilityState === "hidden");
  const [reportSelection, setReportSelection] = useState<{
    request: ProductPublicationValidationReportRequestV2;
    publication: ProductPublicationManagementViewV2["versions"][number] | null;
  } | null>(null);
  const [version, setVersion] = useState(""),
    [scopeProposal, setScopeProposal] = useState<"Recorded" | "Store" | "Brand">("Store"),
    [replacement, setReplacement] = useState("None"),
    [zone, setZone] = useState(""),
    [from, setFrom] = useState(""),
    [fromOffset, setFromOffset] = useState(""),
    [until, setUntil] = useState(""),
    [untilOffset, setUntilOffset] = useState(""),
    [edited, setEdited] = useState(false);
  useEffect(() => {
    active.current = true;
    const network = () => {
      setOffline(!navigator.onLine);
      if (!navigator.onLine) {
        pending.current?.abort();
        controller.current?.hide();
        if (controller.current) setView(controller.current.view());
      }
    };
    const visibility = () => {
      setBackground(document.visibilityState === "hidden");
      if (document.visibilityState === "hidden") {
        pending.current?.abort();
        controller.current?.hide();
        if (controller.current) setView(controller.current.view());
      }
    };
    window.addEventListener("offline", network);
    window.addEventListener("online", network);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active.current = false;
      pending.current?.abort();
      window.removeEventListener("offline", network);
      window.removeEventListener("online", network);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!view?.validUntil) return;
    const timer = setTimeout(
      () => {
        if (active.current && controller.current) setView(controller.current.view());
      },
      Math.max(0, Date.parse(view.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view?.validUntil]);
  useEffect(() => {
    if (focusSummary.current && !busy) {
      focusSummary.current = false;
      summary.current?.focus();
    }
  }, [busy, view]);
  useEffect(() => {
    if (!view?.pendingOperation && !busy && !edited) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, edited, view?.pendingOperation]);
  useEffect(() => {
    onManagement?.(view?.source ?? null);
  }, [view?.source, onManagement]);
  useEffect(() => {
    onBlockedChange?.(
      busy || !view?.originalRecoveryChecked || Boolean(view?.pendingOperation) || edited,
    );
  }, [busy, view?.originalRecoveryChecked, view?.pendingOperation, edited, onBlockedChange]);
  useEffect(() => {
    if (!entry || busy || view?.pendingOperation) return;
    if (controller.current && entry.revision > controller.current.view().revision) {
      controller.current.hide();
      controller.current = null;
      setView(null);
      setReportSelection(null);
      setEdited(false);
      setReplacement("None");
    }
    if (!controller.current) {
      const observation = JSON.stringify([
        productReference,
        storeReference,
        csrf,
        entry.revision,
        entry.observedAt,
        entry.validUntil,
      ]);
      if (automaticOpenEntry.current === observation) return;
      automaticOpenEntry.current = observation;
      void run("Open");
    }
  }, [entry, busy, view?.pendingOperation, productReference, storeReference, csrf]);
  function selectReport(source: ProductPublicationManagementViewV2, nextVersion: string) {
    const row = source.versions.find((v) => v.versionReference === nextVersion);
    if (!row && nextVersion !== source.draft.versionReference) {
      setReportSelection(null);
      return;
    }
    setReportSelection({
      request: {
        tenantReference: source.tenantReference,
        brandReference: source.brandReference,
        storeReference: source.storeReference,
        productReference: source.productReference,
        versionReference: nextVersion,
        expectedAggregateVersion: source.revision,
        expectedPublicationVersion: row?.publicationVersion ?? 0,
      },
      publication: row ?? null,
    });
  }
  function populate(source: ProductPublicationManagementViewV2, nextVersion: string) {
    setVersion(nextVersion);
    selectReport(source, nextVersion);
    const row = source.versions.find((v) => v.versionReference === nextVersion);
    setScopeProposal(row ? "Recorded" : "Store");
    setReplacement(
      row?.replacementIntent?.mode === "PermanentSelectorRetirement"
        ? row.replacementIntent.digest
        : "None",
    );
    const period = row?.effectivePeriod;
    setZone(period?.timeZone ?? "");
    setFrom(period?.effectiveFrom.localDateTime ?? "");
    setFromOffset(period ? String(period.effectiveFrom.utcOffsetMinutes) : "");
    setUntil(period?.effectiveUntil?.localDateTime ?? "");
    setUntilOffset(period?.effectiveUntil ? String(period.effectiveUntil.utcOffsetMinutes) : "");
    setEdited(false);
  }
  function period() {
    const boundary = (local: string, offsetText: string) => {
      if (!/^-?(?:0|[1-9][0-9]{0,3})$/u.test(offsetText))
        throw new PublicationControllerError("Invalid");
      const offset = Number(offsetText);
      let normalized = local;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(local)) normalized += ":00.000";
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(local)) normalized += ".000";
      else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,2}$/u.test(local))
        normalized = local.padEnd(23, "0");
      const date = new Date(Date.parse(normalized + "Z") - offset * 60000);
      if (!Number.isFinite(date.getTime())) throw new PublicationControllerError("Invalid");
      return { instant: date.toISOString(), localDateTime: normalized, utcOffsetMinutes: offset };
    };
    return parseProductPublicationPeriod({
      timeZone: zone,
      effectiveFrom: boundary(from, fromOffset),
      effectiveUntil: until === "" ? null : boundary(until, untilOffset),
    });
  }
  async function run(
    action:
      | "Open"
      | "Refresh"
      | "Retry"
      | "Resolve"
      | "AcknowledgeWarnings"
      | ProductPublicationUserAction,
    confirmation?: ProductPublicationWarningConfirmation,
  ) {
    if (
      busy ||
      pending.current ||
      offline ||
      background ||
      (blocked &&
        action !== "Retry" &&
        action !== "Resolve" &&
        action !== "Open" &&
        action !== "Refresh")
    )
      return;
    if (action === "AcknowledgeWarnings" && (edited || !confirmation)) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError(null);
    setConfirmedRevision(null);
    if (action !== "Open" && action !== "Refresh") setResolvedOutcome(null);
    if (action !== "Open" && action !== "Refresh") setConfirmedAcknowledgement(null);
    focusSummary.current = true;
    try {
      if (!controller.current) {
        if (
          !entry ||
          Date.now() < Date.parse(entry.observedAt) ||
          Date.now() >= Date.parse(entry.validUntil)
        )
          throw new PublicationControllerError("Stale");
        const gate = await createStoreCapabilityClient().load(
          { scope: { storeReference }, capabilityKey: "catalog.cat_product_edit", csrf },
          abort.signal,
        );
        if (!active.current || abort.signal.aborted) return;
        const scope = {
          tenantReference: entry.tenantReference,
          brandReference: gate.brandReference,
          storeReference,
          productReference,
        };
        controller.current = createProductPublicationControllerV2({
          request: { ...scope, expectedAggregateVersion: entry.revision },
          currentScope: () => scope,
          currentContext: () => (active.current ? 0 : 1),
          now: Date.now,
          reads: createProductPublicationManagementClientV2(),
          capabilities: createStoreCapabilityClient(),
          commands: createProductPublicationCommandClientV2(),
          acknowledgements: createProductPublicationWarningAcknowledgementClient(),
          legacyCommands: createLegacyPublicationCommandClient(),
          resolutions: createProductPublicationResolutionClient(),
          journal: createPublicationPendingJournalV2(scope),
        });
      }
      const current = controller.current;
      if (action === "Open" || action === "Refresh") {
        await current.refresh(csrf, abort.signal);
        const source = current.view().source;
        if (source) {
          if (!edited || !version) {
            const selected =
              version &&
              (version === source.draft.versionReference ||
                source.versions.some((row) => row.versionReference === version))
                ? version
                : source.draft.versionReference;
            populate(source, selected);
          } else selectReport(source, version);
        }
      } else if (action === "Resolve") {
        const resolution = await current.resolveOriginal(csrf, abort.signal);
        setResolvedOutcome(resolution.outcome);
        setEdited(false);
        setReportSelection(null);
        onResolved?.(resolution.currentAggregateVersion);
        await current.refresh(csrf, abort.signal);
        const next = current.view().source;
        if (next) populate(next, next.draft.versionReference);
      } else if (action === "Retry") {
        const receipt = await current.retry(csrf, abort.signal);
        setReportSelection(null);
        if (
          "profile" in receipt &&
          receipt.profile === "CatalogProductPublicationWarningAcknowledgementResultV1"
        ) {
          setConfirmedAcknowledgement(receipt);
        } else {
          setEdited(false);
          setConfirmedRevision(receipt.aggregateVersion);
          onConfirmed?.(
            Math.max(receipt.aggregateVersion, current.view().revision),
            receipt.aggregateVersion,
          );
        }
        await current.refresh(csrf, abort.signal);
        const next = current.view().source;
        if (next) populate(next, next.draft.versionReference);
      } else if (action === "AcknowledgeWarnings") {
        if (!confirmation || edited || confirmation.confirmed !== true)
          throw new PublicationControllerError("Invalid");
        const receipt = await current.acknowledge(
          {
            operationReference: serviceOperationReference(),
            report: confirmation.report,
            reasonCode: confirmation.reasonCode,
            occurredAt: new Date().toISOString(),
            confirmed: true,
          },
          csrf,
          abort.signal,
        );
        setConfirmedAcknowledgement(receipt);
        setReportSelection(null);
        await current.refresh(csrf, abort.signal);
        const next = current.view().source;
        if (next) populate(next, confirmation.report.versionReference);
      } else {
        const source = current.view().source;
        if (!source || !allowed(source, version, action))
          throw new PublicationControllerError("Unavailable");
        const row = source.versions.find((v) => v.versionReference === version);
        const proposedScopes = publicationScopes(row);
        if (action !== "Validate" && scopeChanged(row, proposedScopes))
          throw new PublicationControllerError("Invalid");
        const effectivePeriod = period();
        const receipt = await current.act(
          {
            operationReference: serviceOperationReference(),
            versionReference: version,
            action,
            scopeSet: action === "Validate" ? proposedScopes : row?.scopeSet,
            replacementIntent:
              action !== "Validate"
                ? row?.replacementIntent
                : replacement === "None"
                  ? source.noReplacementIntent
                  : source.replacementTargets.find(
                      (t) => t.replacementIntent.digest === replacement,
                    )?.replacementIntent,
            effectivePeriod,
            scheduleReference:
              action === "SchedulePublish"
                ? serviceOperationReference()
                : action === "ReschedulePublish" || action === "CancelScheduledPublish"
                  ? (row?.scheduleReference ?? null)
                  : null,
            successorDraftVersionReference:
              action === "Publish" ? serviceOperationReference() : null,
            occurredAt: new Date().toISOString(),
            reasonCode: "USER_REQUEST",
          },
          csrf,
          abort.signal,
        );
        setEdited(false);
        setConfirmedRevision(receipt.aggregateVersion);
        setReportSelection(null);
        onConfirmed?.(
          Math.max(receipt.aggregateVersion, current.view().revision),
          receipt.aggregateVersion,
        );
        await current.refresh(csrf, abort.signal);
        const next = current.view().source;
        if (next) populate(next, next.draft.versionReference);
      }
    } catch (value) {
      if (active.current)
        setError(value instanceof PublicationControllerError ? value.code : "Invalid");
    } finally {
      if (active.current) {
        if (controller.current) setView(controller.current.view());
        setBusy(false);
      }
      pending.current = null;
    }
  }
  type Row = ProductPublicationManagementViewV2["versions"][number];
  function publicationScopes(row: Row | undefined) {
    const target = view?.source?.replacementTargets.find(
      (t) => t.replacementIntent.digest === replacement,
    );
    if ((!row || row.state === "Draft") && target) return [target.selector];
    // Frozen versions and the default recorded proposal preserve every tuple/filter.
    if (row && (row.state !== "Draft" || scopeProposal === "Recorded")) return row.scopeSet;
    return [
      {
        level: scopeProposal === "Brand" ? "Brand" : "Store",
        reference: scopeProposal === "Brand" ? null : storeReference,
        channelCodes: [],
        orderTypeCodes: [],
      },
    ];
  }
  function scopeChanged(row: Row | undefined, proposed: ReturnType<typeof publicationScopes>) {
    return Boolean(row && JSON.stringify(row.scopeSet) !== JSON.stringify(proposed));
  }
  const source = !offline && !background ? view?.source : null,
    locked = busy || offline || background || blocked,
    original = view?.pendingOperation;
  const selectedRow = source?.versions.find((v) => v.versionReference === version),
    changedScope =
      scopeChanged(selectedRow, publicationScopes(selectedRow)) ||
      Boolean(
        selectedRow &&
        (selectedRow.replacementIntent?.digest ?? "None") !==
          (replacement === "None" ? source?.noReplacementIntent.digest : replacement),
      );
  const message = original
    ? view?.pending?.kind === "WarningAcknowledgementV1"
      ? "Original warning confirmation request is unconfirmed. Restore current access, then retry this exact request."
      : `Original ${view?.pendingAction ?? "publication"} request is unconfirmed. Restore current access, then retry this exact request.`
    : resolvedOutcome !== null
      ? `${resolvedOutcome === "Committed" ? "The original request was already committed." : "The original request was not applied and is now permanently stopped."} ${source ? "Current records loaded. You may prepare a new request." : "Refresh current records before preparing a new request."}`
      : confirmedAcknowledgement !== null
        ? `Warning confirmation recorded for Product revision ${confirmedAcknowledgement.aggregateVersion}. ${
            source
              ? `Current publication records loaded · Revision ${view?.revision}. Validate again to obtain current results before another publication request.`
              : `Current records unavailable${error ? `: ${error}` : ""}. Refresh publication records to continue.`
          }`
        : confirmedRevision !== null && (error || !source)
          ? `Publication confirmed at revision ${confirmedRevision}. ${offline ? "Current records are unavailable while offline." : background ? "Current records are paused while this page is hidden." : `Current records unavailable${error ? `: ${error}` : ""}. Refresh publication records to continue.`}`
          : view?.status === "NeedsRefresh"
            ? "Publication request confirmed. Refresh to read current recorded state."
            : offline
              ? "Publication offline. Connect and refresh current records."
              : background
                ? "Publication paused. Return and refresh current records."
                : error
                  ? `Publication request not confirmed: ${error}. Refresh current records to recover.`
                  : source
                    ? `Current publication records loaded · Revision ${view?.revision}. Recorded state is shown; each action requires current server validation.`
                    : view?.error
                      ? `Current publication records unavailable: ${view.error}. Refresh before any new request.`
                      : "Load current publication records before preparing a request.";
  return (
    <section
      className="product-complete-draft product-publication"
      aria-labelledby="product-publication-title"
    >
      <h3 id="product-publication-title">Publication requests</h3>
      <p>
        Current server permissions, validation, topology and policy govern every request. Recorded
        approval or scheduling is not current sale eligibility.
      </p>
      <div className="product-content-actions">
        <button
          type="button"
          disabled={
            busy || offline || background || Boolean(original) || (!controller.current && !entry)
          }
          onClick={() => void run(controller.current ? "Refresh" : "Open")}
        >
          {controller.current ? "Refresh publication records" : "Open publication requests"}
        </button>
        {original && (
          <>
            <button type="button" disabled={locked} onClick={() => void run("Retry")}>
              {view?.pending?.kind === "WarningAcknowledgementV1"
                ? "Retry original warning confirmation"
                : "Retry original publication request"}
            </button>
            <button
              type="button"
              disabled={locked}
              aria-describedby="publication-resolution-help"
              onClick={() => void run("Resolve")}
            >
              Check result and stop retrying
            </button>
          </>
        )}
      </div>
      {original && (
        <p id="publication-resolution-help">
          If the original request committed, its result is kept. Otherwise the server permanently
          stops that request, including any delayed retry. Current access is required.
        </p>
      )}
      <p id="publication-request-result" ref={summary} tabIndex={-1} role="status">
        {message}
      </p>
      {view?.pending?.kind === "WarningAcknowledgementV1" && (
        <dl aria-label="Original warning confirmation" style={{ overflowWrap: "anywhere" }}>
          <dt>Version</dt>
          <dd>{view.pending.versionReference}</dd>
          <dt>Recorded report operation</dt>
          <dd>{view.pending.reportOperationReference}</dd>
          <dt>Warnings</dt>
          <dd>{view.pending.warningCodes.join(", ")}</dd>
          <dt>Reason code</dt>
          <dd>{view.pending.reasonCode}</dd>
          <dt>Original request time</dt>
          <dd>
            <time dateTime={view.pending.occurredAt}>{view.pending.occurredAt}</time>
          </dd>
        </dl>
      )}
      {confirmedAcknowledgement !== null && (
        <p>
          Confirmed warnings: {confirmedAcknowledgement.warningCodes.join(", ")}. Reason code:{" "}
          {confirmedAcknowledgement.reasonCode}.
        </p>
      )}
      {source && !original && (
        <>
          <label htmlFor="publication-version">Publication version</label>
          <select
            id="publication-version"
            value={version}
            disabled={locked}
            onChange={(event) => populate(source, event.target.value)}
          >
            <option value={source.draft.versionReference}>Current Draft</option>
            {source.versions
              .filter((v) => v.versionReference !== source.draft.versionReference)
              .map((v, i) => (
                <option key={v.versionReference} value={v.versionReference}>
                  Recorded version {i + 1} · {v.state} · revision {v.publicationVersion}
                </option>
              ))}
          </select>
          <p>
            Recorded state:{" "}
            {source.versions.find((v) => v.versionReference === version)?.state ??
              "No publication yet"}{" "}
            · {source.versions.find((v) => v.versionReference === version)?.scopeSet.length ?? 1}{" "}
            scope proposals · validation {selectedRow?.validationDecision ?? "Not evaluated"}.
          </p>
          <form
            className="product-complete-draft-fields"
            onSubmit={(event) => event.preventDefault()}
            aria-label="Publication scope and effective period"
          >
            {(!selectedRow || selectedRow.state === "Draft") && (
              <label htmlFor="publication-replacement">
                Replacement
                <select
                  id="publication-replacement"
                  value={replacement}
                  disabled={locked}
                  onChange={(event) => {
                    setReplacement(event.target.value);
                    setEdited(true);
                  }}
                >
                  <option value="None">No replacement</option>
                  {source.replacementTargets.map((target, index) => (
                    <option
                      key={target.replacementIntent.digest}
                      value={target.replacementIntent.digest}
                    >
                      Replace current Store coverage {index + 1} ·{" "}
                      {target.selector.channelCodes.length} channel filters ·{" "}
                      {target.selector.orderTypeCodes.length} order-type filters
                    </option>
                  ))}
                  {selectedRow?.replacementIntent?.mode === "PermanentSelectorRetirement" &&
                    !source.replacementTargets.some(
                      (t) => t.replacementIntent.digest === selectedRow.replacementIntent?.digest,
                    ) && (
                      <option value={selectedRow.replacementIntent.digest}>
                        Recorded replacement target (no longer current)
                      </option>
                    )}
                </select>
                <span>
                  Replacement permanently retires only the selected Store coverage. It does not
                  return when the new publication expires.
                </span>
              </label>
            )}
            {(!selectedRow || selectedRow.state === "Draft") && (
              <label htmlFor="publication-scope">
                <span id="publication-scope-label">Publication scope</span>
                <select
                  id="publication-scope"
                  value={scopeProposal}
                  disabled={locked || replacement !== "None"}
                  aria-labelledby="publication-scope-label"
                  aria-describedby="publication-scope-help publication-request-result"
                  onChange={(event) => {
                    setScopeProposal(event.target.value as "Recorded" | "Store" | "Brand");
                    setEdited(true);
                    setError(null);
                  }}
                >
                  {selectedRow && <option value="Recorded">Recorded scope (unchanged)</option>}
                  <option value="Store">Current store</option>
                  <option value="Brand">Entire brand</option>
                </select>
              </label>
            )}
            <p id="publication-scope-help">
              {selectedRow
                ? `Recorded scope: ${selectedRow.scopeSet.map((scope) => `${scope.level} (${scope.channelCodes.length} channel filters, ${scope.orderTypeCodes.length} order-type filters)`).join("; ")}.`
                : `Initial proposal: ${scopeProposal === "Brand" ? "entire brand" : "current store"}.`}{" "}
              {changedScope
                ? "Scope proposal changed. Validate and refresh before submitting review."
                : "Current backend permissions and topology must admit the requested scope."}
            </p>
            <p id="publication-period-help">
              Enter the IANA time zone, local time and explicit UTC offset in minutes. End time is
              exclusive.
            </p>
            {[
              ["publication-zone", "Time zone", zone, setZone, "text"],
              ["publication-from", "Effective from local time", from, setFrom, "datetime-local"],
              [
                "publication-from-offset",
                "Effective from UTC offset minutes",
                fromOffset,
                setFromOffset,
                "text",
              ],
              [
                "publication-until",
                "Effective until local time (optional)",
                until,
                setUntil,
                "datetime-local",
              ],
              [
                "publication-until-offset",
                "Effective until UTC offset minutes",
                untilOffset,
                setUntilOffset,
                "text",
              ],
            ].map(([id, label, value, set, type]) => (
              <label key={id as string} htmlFor={id as string}>
                {label as string}
                <input
                  id={id as string}
                  type={type as string}
                  step={type === "datetime-local" ? "0.001" : undefined}
                  value={value as string}
                  disabled={locked}
                  aria-describedby="publication-period-help publication-request-result"
                  aria-invalid={error === "Invalid"}
                  onChange={(event) => {
                    (set as (v: string) => void)(event.target.value);
                    setEdited(true);
                    setError(null);
                  }}
                />
              </label>
            ))}
          </form>
          <div className="product-content-actions" aria-label="Publication request actions">
            {(Object.keys(titles) as ProductPublicationUserAction[])
              .filter((action) => allowed(source, version, action))
              .map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={locked || (action !== "Validate" && changedScope)}
                  onClick={() => void run(action)}
                >
                  {titles[action]}
                </button>
              ))}
          </div>
          {selectedRow?.profile === null && (
            <p>
              This legacy recorded version cannot start a new V2 request. Existing original requests
              remain recoverable.
            </p>
          )}
          {selectedRow?.state === "Scheduled" && selectedRow.approvalPolicy === "Required" && (
            <p>
              To change the schedule, cancel it, validate the new period, submit review and obtain a
              new independent approval.
            </p>
          )}
          <p>
            Independent approval uses the authenticated approver and current backend policy.
            Scheduled activation runs through the owning System scheduler.
          </p>
        </>
      )}
      <ProductPublicationValidationReport
        key={JSON.stringify([reportSelection?.request ?? null, csrf])}
        request={reportSelection?.request ?? null}
        publication={reportSelection?.publication ?? null}
        csrf={csrf}
        paused={locked || Boolean(original) || !view?.originalRecoveryChecked}
        unsaved={edited}
        onAcknowledge={(confirmation) => run("AcknowledgeWarnings", confirmation)}
      />
    </section>
  );
}
