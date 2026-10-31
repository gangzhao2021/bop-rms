import { useEffect, useMemo, useRef, useState } from "react";
import {
  createOptionSetCurrentPublicationClient,
  OptionSetCurrentPublicationClientError,
  type OptionSetCurrentPublicationView,
} from "./option-set-current-publication-client.js";
import type { OptionSetAuthoringScope } from "./option-set-authoring-client.js";
import { OptionSetHistoryValues } from "./OptionSetHistoryPanel.js";
export interface OptionSetCurrentPublicationPanelProps {
  readonly optionSetReference: string;
  readonly scope: OptionSetAuthoringScope;
  readonly csrf: string;
  readonly refreshKey: string | number;
  readonly expectedAggregateVersion?: number | null;
  readonly client?: ReturnType<typeof createOptionSetCurrentPublicationClient>;
}
const messages: Record<OptionSetCurrentPublicationClientError["code"], string> = {
  Invalid: "The current publication response could not be verified. Retry the read.",
  Denied: "You do not have permission to read the current publication.",
  FeatureDisabled: "Current publication reads are disabled for this Store.",
  Conflict: "The Option Set changed. Refresh the current publication.",
  Stale: "The current publication read expired. Refresh to read it again.",
  Unavailable: "Current publication is unavailable or you are offline. Retry the read.",
  ScopeChanged:
    "Your identity or selected scope changed. Read the current publication in the current scope.",
};
export function OptionSetCurrentPublicationViewContent({
  view,
}: {
  readonly view: OptionSetCurrentPublicationView;
}) {
  if (view.publicationState === "Absent")
    return <p>No release has been recorded for this Option Set.</p>;
  if (view.publicationState === "NotCurrentlyPublished")
    return (
      <>
        <p>
          This Option Set is not currently Published. Historical releases remain available in the
          publication timeline.
        </p>
        <details>
          <summary>Last recorded release</summary>
          <OptionSetHistoryValues
            value={{
              currentLifecycleReference: view.currentLifecycleReference,
              lastReleaseReference: view.lastReleaseReference,
            }}
          />
        </details>
      </>
    );
  if (!view.release || !view.published)
    return <p role="alert">The current publication response could not be verified.</p>;
  return (
    <>
      <h3>Current Published version</h3>
      <p>
        This read shows the current recorded release. The editable Draft is separate. Reference
        eligibility and sale availability are not evaluated by this read.
      </p>
      <dl>
        <div>
          <dt>Released at (UTC)</dt>
          <dd>
            <time dateTime={view.release.releasedAt}>{view.release.releasedAt}</time>
          </dd>
        </div>
        <div>
          <dt>Release sequence</dt>
          <dd>{view.release.releaseSequence}</dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>
            {view.release.approvalDisposition === "Approved"
              ? "Independently approved"
              : "Approval waived by the recorded policy"}
          </dd>
        </div>
        <div>
          <dt>Mechanical rule assessment</dt>
          <dd>
            {view.published.rules.status}
            {view.published.rules.reason ? ` — ${view.published.rules.reason}` : ""}
          </dd>
        </div>
      </dl>
      <details>
        <summary>Recorded release and source provenance</summary>
        <OptionSetHistoryValues
          value={{
            release: view.release,
            currentAggregateVersion: view.currentAggregateVersion,
            sourceDigest: view.published.sourceDigest,
            contentDigest: view.published.contentDigest,
            configurationDigest: view.published.configurationDigest,
            sourceRecords: view.published.sourceRecords,
            graphDigest: view.published.graphDigest,
            sourceAuthority: view.published.sourceAuthority,
            observedAt: view.observedAt,
            validUntil: view.validUntil,
          }}
        />
      </details>
      <section aria-label="Current Published content">
        <OptionSetHistoryValues value={view.published.content} />
      </section>
    </>
  );
}
export function OptionSetCurrentPublicationPanel({
  optionSetReference,
  scope,
  csrf,
  refreshKey,
  expectedAggregateVersion = null,
  client: provided,
}: OptionSetCurrentPublicationPanelProps) {
  const client = useMemo(() => provided ?? createOptionSetCurrentPublicationClient(), [provided]);
  const [retry, setRetry] = useState(0);
  const identity = JSON.stringify([
    scope.tenantReference,
    scope.brandReference,
    scope.storeReference,
    scope.actorReference,
    csrf,
    optionSetReference,
    refreshKey,
    expectedAggregateVersion,
    retry,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [state, setState] = useState<{
    identity: string;
    loading: boolean;
    view: OptionSetCurrentPublicationView | null;
    error: string | null;
  }>({ identity, loading: true, view: null, error: null });
  useEffect(() => {
    const controller = new AbortController(),
      epoch = identity;
    setState({ identity: epoch, loading: true, view: null, error: null });
    void client
      .load({
        command: { optionSetReference, expectedAggregateVersion },
        expectedScope: {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          actorReference: scope.actorReference,
        },
        csrf,
        signal: controller.signal,
      })
      .then((view) => {
        if (!controller.signal.aborted && currentIdentity.current === epoch)
          setState({ identity: epoch, loading: false, view, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && currentIdentity.current === epoch)
          setState({
            identity: epoch,
            loading: false,
            view: null,
            error:
              error instanceof OptionSetCurrentPublicationClientError
                ? messages[error.code]
                : messages.Unavailable,
          });
      });
    return () => controller.abort();
  }, [
    identity,
    client,
    optionSetReference,
    expectedAggregateVersion,
    csrf,
    scope.tenantReference,
    scope.brandReference,
    scope.storeReference,
    scope.actorReference,
  ]);
  const active = state.identity === identity ? state : null,
    loading = !active || active.loading;
  return (
    <section
      aria-label="Current Option Set publication"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>Current publication</h2>
      <button type="button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>
        Refresh current publication
      </button>
      <div aria-live="polite" aria-busy={loading}>
        {loading ? (
          <p>Loading current publication…</p>
        ) : active?.error ? (
          <p role="alert">{active.error}</p>
        ) : active?.view ? (
          <OptionSetCurrentPublicationViewContent view={active.view} />
        ) : (
          <p role="alert">Current publication is unavailable. Retry the read.</p>
        )}
      </div>
    </section>
  );
}
