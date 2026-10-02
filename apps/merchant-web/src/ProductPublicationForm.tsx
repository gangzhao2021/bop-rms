import { useEffect, useRef, useState } from "react";
import {
  createProductPublicationController,
  PublicationControllerError,
  type ProductPublicationController,
} from "./product-publication-controller.js";
import {
  createProductPublicationManagementClient,
  type ProductPublicationManagementView,
} from "./product-publication-management-client.js";
import {
  createProductPublicationCommandClient,
  parseProductPublicationPeriod,
  type ProductPublicationUserAction,
} from "./product-publication-command-client.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { createPublicationPendingJournal } from "./product-publication-pending-journal.js";
import type { ProductEditorView } from "./product-editor-client.js";
type View = ReturnType<ProductPublicationController["view"]>;
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
  source: ProductPublicationManagementView,
  version: string,
  action: ProductPublicationUserAction,
) {
  const row = source.versions.find((v) => v.versionReference === version);
  if (action === "Validate")
    return (
      version === source.draft.versionReference &&
      source.draft.contentStatus === "Present" &&
      (!row || row.state === "Draft")
    );
  if (!row) return false;
  if (action === "SubmitReview") return row.state === "Draft";
  if (action === "Approve" || action === "Reject") return row.state === "InReview";
  if (action === "Publish" || action === "SchedulePublish")
    return row.state === "Approved" || row.state === "InReview";
  return row.state === "Scheduled";
}
export function ProductPublicationForm({
  entry,
  productReference,
  storeReference,
  csrf,
}: {
  readonly entry: ProductEditorView | null;
  readonly productReference: string;
  readonly storeReference: string;
  readonly csrf: string;
}) {
  const controller = useRef<ProductPublicationController | null>(null),
    pending = useRef<AbortController | null>(null),
    active = useRef(true),
    summary = useRef<HTMLParagraphElement>(null),
    focusSummary = useRef(false);
  const [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [offline, setOffline] = useState(!navigator.onLine),
    [background, setBackground] = useState(document.visibilityState === "hidden");
  const [version, setVersion] = useState(""),
    [scopeProposal, setScopeProposal] = useState<"Recorded" | "Store" | "Brand">("Store"),
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
  function populate(source: ProductPublicationManagementView, nextVersion: string) {
    setVersion(nextVersion);
    const row = source.versions.find((v) => v.versionReference === nextVersion);
    setScopeProposal(row ? "Recorded" : "Store");
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
  async function run(action: "Open" | "Refresh" | "Retry" | ProductPublicationUserAction) {
    if (busy || pending.current || offline || background) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError(null);
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
        controller.current = createProductPublicationController({
          request: { ...scope, expectedAggregateVersion: entry.revision },
          currentScope: () => scope,
          currentContext: () => (active.current ? 0 : 1),
          now: Date.now,
          reads: createProductPublicationManagementClient(),
          capabilities: createStoreCapabilityClient(),
          commands: createProductPublicationCommandClient(),
          journal: createPublicationPendingJournal(scope),
        });
      }
      const current = controller.current;
      if (action === "Open" || action === "Refresh") {
        await current.refresh(csrf, abort.signal);
        const source = current.view().source;
        if (source && (!edited || !version)) populate(source, source.draft.versionReference);
      } else if (action === "Retry") {
        await current.retry(csrf, abort.signal);
        setEdited(false);
      } else {
        const source = current.view().source;
        if (!source || !allowed(source, version, action))
          throw new PublicationControllerError("Unavailable");
        const row = source.versions.find((v) => v.versionReference === version);
        const proposedScopes = publicationScopes(row);
        if (action !== "Validate" && scopeChanged(row, proposedScopes))
          throw new PublicationControllerError("Invalid");
        const effectivePeriod = period();
        await current.act(
          {
            operationReference: serviceOperationReference(),
            versionReference: version,
            action,
            scopeSet: action === "Validate" ? proposedScopes : row?.scopeSet,
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
  type Row = ProductPublicationManagementView["versions"][number];
  function publicationScopes(row: Row | undefined) {
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
    locked = busy || offline || background,
    original = view?.pendingOperation;
  const selectedRow = source?.versions.find((v) => v.versionReference === version),
    changedScope = scopeChanged(selectedRow, publicationScopes(selectedRow));
  const message = original
    ? `Original ${view?.pendingAction ?? "publication"} request is unconfirmed. Restore current access, then retry this exact request.`
    : view?.status === "NeedsRefresh"
      ? "Publication request confirmed. Refresh to read current recorded state."
      : offline
        ? "Publication offline. Connect and refresh current records."
        : background
          ? "Publication paused. Return and refresh current records."
          : error
            ? `Publication request not confirmed: ${error}. Refresh current records to recover.`
            : source
              ? `Current publication records loaded · Revision ${view?.revision}. Current validation remains incomplete.`
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
          disabled={locked || Boolean(original) || (!controller.current && !entry)}
          onClick={() => void run(controller.current ? "Refresh" : "Open")}
        >
          {controller.current ? "Refresh publication records" : "Open publication requests"}
        </button>
        {original && (
          <button type="button" disabled={locked} onClick={() => void run("Retry")}>
            Retry original publication request
          </button>
        )}
      </div>
      <p id="publication-request-result" ref={summary} tabIndex={-1} role="status">
        {message}
      </p>
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
            scope proposals · current qualification unavailable.
          </p>
          <form
            className="product-complete-draft-fields"
            onSubmit={(event) => event.preventDefault()}
            aria-label="Publication scope and effective period"
          >
            {(!selectedRow || selectedRow.state === "Draft") && (
              <label htmlFor="publication-scope">
                <span id="publication-scope-label">Publication scope</span>
                <select
                  id="publication-scope"
                  value={scopeProposal}
                  disabled={locked}
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
          <p>
            Independent approval uses the authenticated approver and current backend policy.
            Scheduled activation runs through the owning System scheduler.
          </p>
        </>
      )}
    </section>
  );
}
