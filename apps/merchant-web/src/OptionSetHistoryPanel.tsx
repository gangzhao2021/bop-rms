import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createOptionSetHistoryClient,
  OptionSetHistoryClientError,
  optionSetHistorySelectorFromEntry,
  isOptionSetHistoryListResult,
  isOptionSetHistorySelectedResult,
  isOptionSetHistoryPublishingResult,
  isOptionSetHistoryComparisonResult,
  type OptionSetPublishingHistoryView,
  type OptionSetHistoryComparisonView,
  type OptionSetHistoryEntry,
  type OptionSetHistoryListView,
  type OptionSetHistoryPacket,
  type OptionSetHistorySelectedView,
  type OptionSetHistoryView,
} from "./option-set-history-client.js";
import {
  parseOptionSetEditorContent,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";

export interface OptionSetHistoryPanelProps {
  readonly optionSetReference: string;
  readonly scope: OptionSetAuthoringScope;
  readonly csrf: string;
  readonly refreshKey: string | number;
}

const labels: Readonly<Record<string, string>> = {
  sourceAggregate: "Option Set",
  internalCode: "Code",
  lifecycle: "Lifecycle",
  aggregateVersion: "Source revision",
  draft: "Version content",
  versionReference: "Version reference",
  defaultLocale: "Default language",
  localizedNames: "Names",
  localizedDescriptions: "Descriptions",
  displayStyle: "Display style",
  minimumSelection: "Minimum selections",
  maximumSelection: "Maximum selections",
  allowRepeatedOption: "Repeated selections allowed",
  perOptionMaximumQuantity: "Maximum quantity per Option",
  maximumTotalQuantity: "Maximum total quantity",
  options: "Options",
  stableCode: "Option code",
  optionDetails: "Option references, quantities and media",
  conditionalRules: "Conditional rules",
  conflictRules: "Conflict rules",
  scopeSet: "Scope",
  effectivePeriod: "Effective period",
  triggeredOptionSetReference: "Triggered Option Set",
  triggeredOptionSetVersionReference: "Pinned triggered version",
  conflictOptionReferences: "Conflicting Options",
  defaultEligible: "Default eligible",
  sortOrder: "Order",
  whenAllSelected: "When all selected",
  requiredOptionReferences: "Required Options",
  forbiddenTogether: "Forbidden together",
  occurredAt: "Occurred at",
  recordedAt: "Recorded at",
  operation: "Operation",
  actorKind: "Actor kind",
  actorReference: "Actor reference",
  fromState: "Previous state",
  toState: "Resulting state",
  releaseReference: "Release reference",
  releaseSequence: "Release sequence",
  reasonCode: "Reason",
  fields: "Changed fields",
  left: "Left",
  right: "Right",
  businessContentChanged: "Business content changed",
};

/** Read-only rendering of values already validated by the owning browser client. */
export function OptionSetHistoryValues({ value }: { readonly value: unknown }): ReactNode {
  if (value === null) return <span>None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" || typeof value === "number") return <span>{String(value)}</span>;
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span>None recorded</span>
    ) : (
      <ol>
        {value.map((item, index) => (
          <li key={index}>
            <OptionSetHistoryValues value={item} />
          </li>
        ))}
      </ol>
    );
  if (value && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key} style={{ minWidth: 0 }}>
            <dt>{labels[key] ?? key.replace(/([a-z])([A-Z])/gu, "$1 $2")}</dt>
            <dd style={{ marginInlineStart: "1rem", overflowWrap: "anywhere" }}>
              <OptionSetHistoryValues value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>Unavailable</span>;
}

function selectable(entry: OptionSetHistoryEntry) {
  return entry.availability === "Complete" && entry.kind !== "OperationOnly";
}
function entryKey(entry: OptionSetHistoryEntry) {
  return `${entry.kind}:${entry.resultAggregateVersion}:${entry.operationReference}`;
}
function message(error: unknown) {
  if (!(error instanceof OptionSetHistoryClientError))
    return "History is unavailable. Retry the read.";
  const text: Record<OptionSetHistoryClientError["code"], string> = {
    Invalid: "The history response could not be verified. Refresh history.",
    Denied: "You do not have permission to read this history.",
    FeatureDisabled: "History is disabled for this Store.",
    Conflict: "The recorded source changed. Refresh history.",
    Stale: "The history read expired or the current revision changed. Refresh history.",
    Unavailable: "History is unavailable. Retry the read.",
    ScopeChanged: "Your identity or selected scope changed. Refresh history in the current scope.",
  };
  return text[error.code];
}

export function OptionSetHistoryRecordedContent({
  view,
}: {
  readonly view: OptionSetHistorySelectedView;
}) {
  const content =
    view.profile === "CatalogOptionSetHistoricalFrozenV1" && "editorContent" in view.content
      ? view.content.editorContent
      : view.content;
  const editor = parseOptionSetEditorContent(content);
  return (
    <section aria-label="Recorded version content">
      <h3>
        {view.profile === "CatalogOptionSetHistoricalFrozenV1"
          ? "Recorded Frozen content"
          : "Recorded Draft content"}
      </h3>
      <p>
        This is an immutable recorded version. Reference eligibility is not evaluated by this
        history read. Frozen content alone does not establish a Published release.
      </p>
      <details>
        <summary>Original source and version</summary>
        <OptionSetHistoryValues
          value={{
            ...view.originalTuple,
            sourceDigest: view.sourceDigest,
            contentDigest: view.contentDigest,
            configurationDigest: view.configurationDigest,
            ...(view.recordDigest ? { recordDigest: view.recordDigest } : {}),
          }}
        />
      </details>
      <OptionSetHistoryValues value={editor} />
    </section>
  );
}

function comparedSource(value: unknown) {
  if (!value || typeof value !== "object" || !("view" in value)) return null;
  const view = value.view;
  if (!view || typeof view !== "object" || !("originalTuple" in view)) return null;
  return {
    originalTuple: view.originalTuple,
    ...("sourceDigest" in view ? { sourceDigest: view.sourceDigest } : {}),
    ...("contentDigest" in view ? { contentDigest: view.contentDigest } : {}),
    ...("configurationDigest" in view ? { configurationDigest: view.configurationDigest } : {}),
  };
}
export function OptionSetHistoryComparison({ view }: { readonly view: OptionSetHistoryView }) {
  return (
    <section aria-label="Recorded content comparison">
      <p>
        Comparison describes recorded business content; it does not assess reference eligibility or
        current publication status.
      </p>
      <details>
        <summary>Compared version sources</summary>
        <OptionSetHistoryValues
          value={{
            left: "left" in view ? comparedSource(view.left) : null,
            right: "right" in view ? comparedSource(view.right) : null,
          }}
        />
      </details>
      <OptionSetHistoryValues value={"comparison" in view ? view.comparison : null} />
    </section>
  );
}

interface PanelState {
  readonly identity: string;
  readonly rosters: readonly OptionSetHistoryListView[];
  readonly timeline: readonly OptionSetPublishingHistoryView[];
  readonly selected: OptionSetHistorySelectedView | null;
  readonly comparison: OptionSetHistoryComparisonView | null;
  readonly left: string;
  readonly right: string;
  readonly errors: Readonly<Partial<Record<"List" | "Publishing" | "Content" | "Compare", string>>>;
}
const empty = (identity: string): PanelState => ({
  identity,
  rosters: [],
  timeline: [],
  selected: null,
  comparison: null,
  left: "",
  right: "",
  errors: {},
});

export function OptionSetHistoryPanel({
  optionSetReference,
  scope,
  csrf,
  refreshKey,
}: OptionSetHistoryPanelProps) {
  const identity = JSON.stringify([
    optionSetReference,
    scope.tenantReference,
    scope.brandReference,
    scope.storeReference,
    scope.actorReference,
    csrf,
    refreshKey,
  ]);
  const epoch = useRef({ identity, sequence: 0, controllers: new Set<AbortController>() });
  if (epoch.current.identity !== identity) {
    for (const controller of epoch.current.controllers) controller.abort();
    epoch.current = { identity, sequence: epoch.current.sequence + 1, controllers: new Set() };
  }
  const [client] = useState(() => createOptionSetHistoryClient());
  const [state, setState] = useState(() => empty(identity));
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const active = state.identity === identity ? state : empty(identity);
  const requests = useRef(new Map<string, number>());

  async function load(
    packet: OptionSetHistoryPacket,
    channel: "List" | "Publishing" | "Content" | "Compare",
    append = false,
  ) {
    const captured = epoch.current,
      controller = new AbortController(),
      request = (requests.current.get(channel) ?? 0) + 1;
    requests.current.set(channel, request);
    captured.controllers.add(controller);
    const valid = () =>
      epoch.current === captured &&
      !controller.signal.aborted &&
      requests.current.get(channel) === request;
    setBusy((previous) => new Set([...previous, channel]));
    setState((previous) => ({
      ...(previous.identity === identity ? previous : empty(identity)),
      errors: { ...(previous.identity === identity ? previous.errors : {}), [channel]: undefined },
      ...(channel === "Content" ? { selected: null } : {}),
      ...(channel === "Compare" ? { comparison: null } : {}),
    }));
    try {
      const result = await client.load({
        packet,
        expectedScope: Object.freeze({ ...scope }),
        csrf,
        signal: controller.signal,
        rosters: active.rosters,
      });
      if (!valid()) return;
      setState((previous) => {
        if (previous.identity !== identity) return previous;
        if (channel === "List" && isOptionSetHistoryListResult(result))
          return {
            ...previous,
            rosters: append ? [...previous.rosters, result.view] : [result.view],
          };
        if (channel === "Publishing" && isOptionSetHistoryPublishingResult(result))
          return {
            ...previous,
            timeline: append ? [...previous.timeline, result.view] : [result.view],
          };
        if (channel === "Content" && isOptionSetHistorySelectedResult(result))
          return { ...previous, selected: result.view };
        if (channel === "Compare" && isOptionSetHistoryComparisonResult(result))
          return { ...previous, comparison: result.view };
        return {
          ...previous,
          errors: { ...previous.errors, [channel]: "The requested history view is unavailable." },
        };
      });
    } catch (error) {
      if (
        valid() &&
        error instanceof OptionSetHistoryClientError &&
        error.code === "ScopeChanged"
      ) {
        for (const pending of captured.controllers) pending.abort();
        epoch.current = { identity, sequence: captured.sequence + 1, controllers: new Set() };
        setBusy(new Set());
        setState({ ...empty(identity), errors: { [channel]: message(error) } });
        return;
      }
      if (valid() && channel === "List") {
        for (const dependent of ["Content", "Compare"])
          requests.current.set(dependent, (requests.current.get(dependent) ?? 0) + 1);
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete("Content");
          next.delete("Compare");
          return next;
        });
      }
      if (valid())
        setState((previous) => {
          if (previous.identity !== identity) return previous;
          const next = {
            ...previous,
            ...(channel === "List"
              ? { rosters: [], selected: null, comparison: null, left: "", right: "" }
              : {}),
            ...(channel === "Publishing" ? { timeline: [] } : {}),
          };
          return { ...next, errors: { ...next.errors, [channel]: message(error) } };
        });
    } finally {
      captured.controllers.delete(controller);
      if (valid())
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(channel);
          return next;
        });
    }
  }
  function refresh() {
    for (const controller of epoch.current.controllers) controller.abort();
    epoch.current = { identity, sequence: epoch.current.sequence + 1, controllers: new Set() };
    setState(empty(identity));
    setBusy(new Set());
    void load(
      {
        action: "List",
        command: { optionSetReference, expectedAggregateVersion: null, before: null, limit: 20 },
      },
      "List",
    );
    void load(
      { action: "Publishing", command: { optionSetReference, before: null, limit: 20 } },
      "Publishing",
    );
  }
  const refreshEffect = useRef(refresh);
  refreshEffect.current = refresh;
  useEffect(() => {
    refreshEffect.current();
    return () => {
      for (const controller of epoch.current.controllers) controller.abort();
    };
  }, [identity]);
  const entries = active.rosters.flatMap((page) => page.entries),
    lastRoster = active.rosters.at(-1);
  const lastTimeline = active.timeline.at(-1);
  const nextTimeline = lastTimeline?.nextBefore ?? null;
  const find = (key: string) => entries.find((entry) => entryKey(entry) === key);
  function compare() {
    const left = find(active.left),
      right = find(active.right);
    if (!left || !right || !selectable(left) || !selectable(right)) return;
    void load(
      {
        action: "Compare",
        command: {
          left: optionSetHistorySelectorFromEntry(optionSetReference, left),
          right: optionSetHistorySelectorFromEntry(optionSetReference, right),
        },
      },
      "Compare",
    );
  }
  return (
    <section
      className="product-content-sections"
      aria-label="Option Set history and comparison"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <section>
        <h2>History and comparison</h2>
        <p>
          Read recorded versions and publication events. These reads do not change the current
          editing version or publish content.
        </p>
        <button type="button" onClick={refresh}>
          Refresh history
        </button>
        <div role="status" aria-live="polite">
          {state.identity === identity && busy.size > 0 ? "Loading history…" : ""}
        </div>
        {Object.entries(active.errors).map(([channel, error]) =>
          error ? (
            <p key={channel} role="alert">
              {channel}: {error}
            </p>
          ) : null,
        )}
        <h3>Recorded versions</h3>
        {entries.length === 0 && !busy.has("List") && !active.errors.List ? (
          <p>No recorded versions have been loaded.</p>
        ) : null}
        <ol>
          {entries.map((entry) => (
            <li key={entryKey(entry)}>
              <p>
                Revision {entry.resultAggregateVersion} ·{" "}
                {entry.kind === "FrozenSeal"
                  ? "Recorded Frozen"
                  : entry.kind === "DraftSnapshot"
                    ? "Recorded Draft"
                    : "Legacy operation"}{" "}
                · {entry.action} · <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
              </p>
              {selectable(entry) ? (
                <button
                  type="button"
                  disabled={busy.has("Content")}
                  onClick={() => {
                    const selector = optionSetHistorySelectorFromEntry(optionSetReference, entry);
                    void load(
                      { action: selector.kind, command: { ...selector.command } },
                      "Content",
                    );
                  }}
                >
                  Read revision {entry.resultAggregateVersion}{" "}
                  {entry.kind === "FrozenSeal" ? "Frozen" : "Draft"}
                </button>
              ) : (
                <p>Legacy content is unavailable and cannot be selected or compared.</p>
              )}
            </li>
          ))}
        </ol>
        {lastRoster?.nextBefore ? (
          <button
            type="button"
            disabled={busy.has("List")}
            onClick={() =>
              void load(
                {
                  action: "List",
                  command: {
                    optionSetReference,
                    expectedAggregateVersion: lastRoster.currentAggregateVersion,
                    before: lastRoster.nextBefore,
                    limit: 20,
                  },
                },
                "List",
                true,
              )
            }
          >
            Load older versions
          </button>
        ) : null}
        {active.errors.List ? (
          <button type="button" onClick={refresh}>
            Retry history
          </button>
        ) : null}
        {active.selected ? <OptionSetHistoryRecordedContent view={active.selected} /> : null}
        <h3>Compare recorded content</h3>
        {(["left", "right"] as const).map((side) => (
          <label key={side} style={{ display: "block" }}>
            {side === "left" ? "Left version" : "Right version"}
            <select
              style={{ maxWidth: "100%", width: "100%" }}
              value={active[side]}
              onChange={(event) => {
                const value = event.target.value;
                requests.current.set("Compare", (requests.current.get("Compare") ?? 0) + 1);
                setBusy((previous) => {
                  const next = new Set(previous);
                  next.delete("Compare");
                  return next;
                });
                setState((previous) =>
                  previous.identity === identity
                    ? { ...previous, [side]: value, comparison: null }
                    : previous,
                );
              }}
            >
              <option value="">Select a recorded version</option>
              {entries.filter(selectable).map((entry) => (
                <option key={entryKey(entry)} value={entryKey(entry)}>
                  Revision {entry.resultAggregateVersion} ·{" "}
                  {entry.kind === "FrozenSeal" ? "Frozen" : "Draft"} · {entry.occurredAt}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          disabled={!active.left || !active.right || busy.has("Compare")}
          onClick={compare}
        >
          Compare selected versions
        </button>
        {active.comparison ? <OptionSetHistoryComparison view={active.comparison} /> : null}
        <h3>Publication timeline</h3>
        <p>Actual recorded Publishing events are separate from Frozen version records.</p>
        {active.timeline.map((page, index) => (
          <OptionSetHistoryValues key={index} value={page.entries} />
        ))}
        {nextTimeline ? (
          <button
            type="button"
            disabled={busy.has("Publishing")}
            onClick={() =>
              void load(
                {
                  action: "Publishing",
                  command: { optionSetReference, before: nextTimeline, limit: 20 },
                },
                "Publishing",
                true,
              )
            }
          >
            Load older publication events
          </button>
        ) : null}
        {active.errors.Publishing ? (
          <button
            type="button"
            onClick={() =>
              void load(
                { action: "Publishing", command: { optionSetReference, before: null, limit: 20 } },
                "Publishing",
              )
            }
          >
            Retry publication timeline
          </button>
        ) : null}
      </section>
    </section>
  );
}
