import { useEffect, useMemo, useRef, useState } from "react";
import { createOptionSetPublicationRecovery } from "./option-set-publication-recovery.js";
import {
  OptionSetPublicationClientError,
  type OptionSetPublicationScope,
  type OptionSetPublicationAction,
  type OptionSetPublicationReport,
} from "./option-set-publication-client.js";
import { serviceOperationReference } from "./service-control-client.js";
export interface OptionSetPublicationPanelProps {
  readonly optionSetReference: string;
  readonly savedAggregateVersion: number | null;
  readonly scope: OptionSetPublicationScope;
  readonly csrf: string;
  readonly blocked: boolean;
  readonly unsavedChanges?: boolean;
  readonly onPendingChange: (blocked: boolean) => void;
  readonly onCurrentRefresh: () => Promise<void>;
}
export function OptionSetPublicationPanel(props: OptionSetPublicationPanelProps) {
  const identity = useRef({
    set: props.optionSetReference,
    brand: props.scope.brandReference,
    store: props.scope.storeReference,
    csrf: props.csrf,
    epoch: 0,
  });
  if (
    identity.current.set !== props.optionSetReference ||
    identity.current.brand !== props.scope.brandReference ||
    identity.current.store !== props.scope.storeReference ||
    identity.current.csrf !== props.csrf
  )
    identity.current = {
      set: props.optionSetReference,
      brand: props.scope.brandReference,
      store: props.scope.storeReference,
      csrf: props.csrf,
      epoch: identity.current.epoch + 1,
    };
  const epoch = identity.current.epoch,
    refresh = useRef(props.onCurrentRefresh),
    pending = useRef(props.onPendingChange);
  refresh.current = props.onCurrentRefresh;
  pending.current = props.onPendingChange;
  const manager = useMemo(
    () =>
      createOptionSetPublicationRecovery({
        optionSetReference: props.optionSetReference,
        currentContext: () => identity.current.epoch,
        refreshCurrent: () => refresh.current(),
      }),
    [props.optionSetReference, epoch],
  );
  const [busy, setBusy] = useState(true),
    [loadedEpoch, setLoadedEpoch] = useState(-1),
    [revision, setRevision] = useState(0),
    [message, setMessage] = useState("Loading publication context and durable original…"),
    [report, setReport] = useState<OptionSetPublicationReport | null>(null),
    [confirmed, setConfirmed] = useState(false),
    abort = useRef<AbortController | null>(null);
  const valid = (signal: AbortSignal) => identity.current.epoch === epoch && !signal.aborted,
    status = manager.view(),
    locked =
      busy ||
      loadedEpoch !== epoch ||
      !status.checked ||
      status.pending ||
      status.cleanupFailed ||
      status.authoringPending;
  useEffect(() => {
    pending.current(true);
    setBusy(true);
    setLoadedEpoch(-1);
    setReport(null);
    setConfirmed(false);
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    void (async () => {
      try {
        await manager.inspect(props.scope, props.csrf, controller.signal);
        if (!valid(controller.signal)) return;
        setLoadedEpoch(epoch);
        setMessage(
          manager.view().pending
            ? "Original publication pending. Resolve its outcome before any new operation."
            : "Current saved Draft and recorded Review observed. Each action will recheck current permissions and sources.",
        );
      } catch (e) {
        if (valid(controller.signal))
          setMessage(
            e instanceof OptionSetPublicationClientError
              ? e.code + ": publication context unavailable."
              : "Unavailable: publication context unavailable.",
          );
      } finally {
        if (valid(controller.signal)) {
          setBusy(false);
          setRevision((v) => v + 1);
          pending.current(
            !manager.view().checked || manager.view().pending || manager.view().cleanupFailed,
          );
        }
      }
    })();
    return () => controller.abort();
  }, [manager, props.scope.brandReference, props.scope.storeReference, props.csrf, epoch]);
  async function run(
    action: "Refresh" | "Validate" | "Retry" | "Resolve" | OptionSetPublicationAction,
  ) {
    if (busy || (loadedEpoch !== epoch && action !== "Refresh")) return;
    if (
      (action === "Validate" ||
        action === "SubmitReview" ||
        action === "Approve" ||
        action === "Publish") &&
      (props.blocked || locked || !props.savedAggregateVersion)
    )
      return;
    if ((action === "SubmitReview" || action === "Approve" || action === "Publish") && !confirmed)
      return;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    pending.current(true);
    setMessage("Checking actual current authority and original operation…");
    try {
      if (action === "Refresh") {
        await manager.inspect(props.scope, props.csrf, controller.signal);
        if (!valid(controller.signal)) return;
        setLoadedEpoch(epoch);
        setReport(null);
        setMessage(
          manager.view().pending
            ? "Original publication still pending. Explicit recovery is required."
            : "Current publication context refreshed.",
        );
      } else if (action === "Validate") {
        if (!props.savedAggregateVersion) return;
        const result = await manager.validate(
          props.savedAggregateVersion,
          props.scope,
          props.csrf,
          controller.signal,
        );
        if (!valid(controller.signal)) return;
        setReport(result);
        setMessage(
          "Actual source validation: " +
            result.decision +
            ". Independent approval and sale eligibility are not evaluated.",
        );
      } else {
        const result =
          action === "Retry"
            ? await manager.retry(props.scope, props.csrf, controller.signal)
            : action === "Resolve"
              ? await manager.resolve(props.scope, props.csrf, controller.signal)
              : await manager.write(
                  action,
                  serviceOperationReference(),
                  props.savedAggregateVersion ?? 0,
                  props.scope,
                  props.csrf,
                  controller.signal,
                );
        if (!valid(controller.signal)) return;
        setReport(null);
        setConfirmed(false);
        setMessage(
          result.receipt.outcome === "Committed"
            ? "Original " +
                result.receipt.action +
                " committed at " +
                result.receipt.recordedAt +
                " UTC; actual current Draft and Review refreshed."
            : "Original operation permanently abandoned; actual current context refreshed.",
        );
      }
    } catch (e) {
      if (valid(controller.signal))
        setMessage(
          e instanceof OptionSetPublicationClientError
            ? e.code +
                (e.attemptCode ? " / " + e.attemptCode : "") +
                ": request not confirmed. Retain the original operation and explicitly resolve it."
            : "Unavailable: retain the original operation and explicitly resolve it.",
        );
    } finally {
      if (valid(controller.signal)) {
        setBusy(false);
        setRevision((v) => v + 1);
        pending.current(
          !manager.view().checked || manager.view().pending || manager.view().cleanupFailed,
        );
      }
    }
  }
  void revision;
  const review = status.context?.review,
    state = review?.kind === "Recorded" ? review.lifecycle.state : null;
  return (
    <section aria-label="Option Set publication" aria-busy={busy}>
      <h2>Validate, review and publish saved Draft</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {status.context && (
        <p>
          Current Draft root {status.context.draft.expectedAggregateVersion}.{" "}
          {review?.kind === "Recorded"
            ? "Recorded Publishing lifecycle: " + state + "."
            : "No Review recorded for this current Draft."}{" "}
          This observation does not grant future commands.
        </p>
      )}
      {(props.blocked || status.authoringPending) && (
        <p>
          Save or discard unsaved changes and resolve the original Draft save before publication.
        </p>
      )}
      <p>
        Source validation is evaluated only on request. Independent approval and sale eligibility
        remain not evaluated by this panel. Current Draft after Publish is a successor; it is not
        the Published frozen version. Open current detail for recorded history, version comparison
        and current Published content.
      </p>
      <button type="button" disabled={busy} onClick={() => void run("Refresh")}>
        Refresh publication context
      </button>
      {status.pending ? (
        <div aria-label="Original publication recovery">
          <p>Durable original blocks editing and replacement operations, including after reload.</p>
          <button
            type="button"
            disabled={busy || props.unsavedChanges}
            onClick={() => void run("Resolve")}
          >
            Resolve original publication
          </button>
          <button
            type="button"
            disabled={busy || props.blocked || !status.canRetry}
            onClick={() => void run("Retry")}
          >
            Retry exact original publication
          </button>
          {status.cleanupFailed && <p>Durable cleanup failed. The original remains locked.</p>}
        </div>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || props.blocked}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I have reviewed the saved Draft and confirm the selected action
          </label>
          <div>
            <button
              type="button"
              disabled={locked || props.blocked || !props.savedAggregateVersion}
              onClick={() => void run("Validate")}
            >
              Validate saved Draft
            </button>
            <button
              type="button"
              disabled={
                locked || props.blocked || !confirmed || review?.kind !== "AbsentForCurrentDraft"
              }
              onClick={() => void run("SubmitReview")}
            >
              Submit saved Draft for review
            </button>
            <button
              type="button"
              disabled={
                locked ||
                props.blocked ||
                !confirmed ||
                state !== "InReview" ||
                (review?.kind === "Recorded" &&
                  review.submittedActorReference === status.scope?.actorReference)
              }
              onClick={() => void run("Approve")}
            >
              Approve as independent actor
            </button>
            <button
              type="button"
              disabled={
                locked ||
                props.blocked ||
                !confirmed ||
                !["InReview", "Approved"].includes(state ?? "")
              }
              onClick={() => void run("Publish")}
            >
              Publish saved Draft
            </button>
          </div>
          <p>
            Approval requires a different authorized signed-in actor. Publish uses actual current
            policy and server qualification, including any permitted policy waiver.
          </p>
        </>
      )}
      {loadedEpoch === epoch && report && (
        <div aria-label="Actual publication validation">
          <h3>Validation: {report.decision}</h3>
          <p>
            Observed {report.observedAt} UTC. Requested activation {report.qualifiedActivationAt}{" "}
            UTC.
          </p>
          <ul>
            {report.checks.map((c) => (
              <li key={c.code}>
                {c.code}: {c.outcome}
              </li>
            ))}
          </ul>
          {report.findings.length > 0 && (
            <ul>
              {report.findings.map((f, i) => (
                <li key={i}>
                  {f.checkCode}: {f.ruleCode} · {f.outcome}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
