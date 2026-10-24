import { systemText, t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createTaskInboxClient,
  TaskInboxClientError,
  type TaskInboxClientErrorCode,
} from "./task-inbox-client.js";
import { parseTaskInboxView, type TaskInboxView } from "./task-inbox-state.js";

type PageState =
  | {
      readonly kind:
        "Loading" | "PermissionDenied" | "NotFound" | "FeatureDisabled" | "Unavailable";
    }
  | { readonly kind: "Ready"; readonly view: TaskInboxView }
  | { readonly kind: "Offline"; readonly view: TaskInboxView | null };

const client = createTaskInboxClient();

function errorCode(error: unknown): TaskInboxClientErrorCode {
  return error instanceof TaskInboxClientError ? error.code : "Unavailable";
}

export function TaskInboxStatePanel({ state }: { readonly state: PageState["kind"] }) {
  const values: Record<
    PageState["kind"],
    readonly [string, string, "neutral" | "error" | "offline"]
  > = {
    Loading: [
      t("Loading Task Inbox"),
      t("Loading the authorized Task queue for this Store…"),
      "neutral",
    ],
    PermissionDenied: [noAccessHeading, pageAccessDeniedText, "error"],
    NotFound: [
      t("Task Inbox unavailable"),
      t("The requested Task Inbox route was not found."),
      "neutral",
    ],
    FeatureDisabled: [
      t("Task Inbox unavailable"),
      t("The authorized Task queue is not enabled for this Store."),
      "neutral",
    ],
    Unavailable: [
      t("Task Inbox unavailable"),
      t("No Task, SLA, or source outcome is inferred from an unavailable read."),
      "error",
    ],
    Offline: [
      t("Offline read-only"),
      t("No cached Task data is available. Reconnect to load the authorized queue."),
      "offline",
    ],
    Ready: [t("Task Inbox"), "", "neutral"],
  };
  const [heading, description, tone] = values[state];
  if (state === "Ready") return null;
  return (
    <StatePanel heading={heading} tone={tone} status>
      <p>{description}</p>
      <Link to="/app">{t("Return to workspace")}</Link>
    </StatePanel>
  );
}

function taskCodeLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function TaskInboxEntry({
  item,
  position,
  storeLabel,
}: {
  readonly item: TaskInboxView["items"][number];
  readonly position: number;
  readonly storeLabel: string;
}) {
  return (
    <article className="task-inbox-card" aria-labelledby={`task-heading-${position}`}>
      <header className="task-inbox-card__header">
        <div>
          <p className="bop-eyebrow">{taskCodeLabel(item.taskType)}</p>
          <h3 id={`task-heading-${position}`}>
            {systemText(item.severity)} · {item.priority}
          </h3>
        </div>
        <span className="task-inbox-status" data-status={item.status}>
          {systemText(item.status)}
        </span>
      </header>
      <dl className="task-inbox-facts">
        <div>
          <dt>{t("Owner")}</dt>
          <dd>
            {item.ownerStatus === "ClaimedByYou"
              ? t("Claimed by you")
              : item.ownerStatus === "ClaimedByStaff"
                ? t("Claimed by another staff member")
                : t("Unclaimed")}
          </dd>
        </div>
        <div>
          <dt>{t("Scope")}</dt>
          <dd>{storeLabel}</dd>
        </div>
        <div>
          <dt>{t("Due")}</dt>
          <dd>
            <time dateTime={item.dueAt}>{item.dueAt}</time>
          </dd>
        </div>
        <div>
          <dt>{t("SLA")}</dt>
          <dd>{t("Policy unavailable")}</dd>
        </div>
        <div>
          <dt>{t("Source")}</dt>
          <dd>
            {t("{sourceType} · Display-safe reference unavailable", {
              sourceType: taskCodeLabel(item.sourceType),
            })}
          </dd>
        </div>
      </dl>
      <div className="task-inbox-card__actions">
        <button type="button" disabled aria-describedby="task-inbox-action-boundary">
          {t("Claim")}
        </button>
        <button type="button" disabled aria-describedby="task-inbox-action-boundary">
          {t("Assign")}
        </button>
        <button type="button" disabled aria-describedby="task-inbox-action-boundary">
          {t("Acknowledge")}
        </button>
        <button type="button" disabled aria-describedby="task-inbox-action-boundary">
          {t("Open source")}
        </button>
      </div>
    </article>
  );
}

export function TaskInboxScreen({
  state,
  onRefresh,
  onNext,
  online,
}: {
  readonly state: PageState;
  readonly onRefresh: () => void;
  readonly onNext: () => void;
  readonly online: boolean;
}) {
  const view = state.kind === "Ready" || state.kind === "Offline" ? state.view : null;
  const readOnly = state.kind !== "Ready";
  return (
    <AppFrame title={t("Tasks")} description="">
      <section className="task-inbox" aria-labelledby="task-inbox-heading">
        <header className="task-inbox-heading">
          <div>
            <p className="bop-eyebrow">{t("Tasks")}</p>
            <h2 id="task-inbox-heading">{view?.storeLabel ?? t("Task Inbox")}</h2>
            <p>
              {t(
                "Task and source facts are scoped to the current Store; internal references are hidden.",
              )}
            </p>
          </div>
          <div className="task-inbox-toolbar">
            <button
              type="button"
              onClick={onRefresh}
              disabled={!online || state.kind === "Loading"}
            >
              {t("Refresh")}
            </button>
            <Link to="/app">{t("Workspace overview")}</Link>
          </div>
        </header>

        {state.kind !== "Ready" && view === null ? (
          <TaskInboxStatePanel state={state.kind} />
        ) : null}

        {view ? (
          <>
            {state.kind === "Offline" ? (
              <StatePanel heading={t("Offline read-only")} tone="offline" status>
                <p>
                  {t(
                    "The last authorized page remains visible for reference. Task actions are disabled.",
                  )}
                </p>
              </StatePanel>
            ) : null}
            {readOnly && state.kind === "Loading" ? <TaskInboxStatePanel state="Loading" /> : null}
            <section className="task-inbox-limits" aria-labelledby="task-inbox-limits-heading">
              <h3 id="task-inbox-limits-heading">{t("Available query coverage")}</h3>
              <p>
                {t(
                  "This page shows one authorized Store queue, up to 50 records at a time. Filtering controls are unavailable here. An empty page does not establish source-workflow finality.",
                )}
              </p>
            </section>
            <section aria-labelledby="task-inbox-records-heading">
              <div className="task-inbox-records-heading">
                <div>
                  <h3 id="task-inbox-records-heading">{t("Task records")}</h3>
                  <p>
                    {t("{length} records on this page · observed {observedAt}", {
                      length: view.items.length,
                      observedAt: view.observedAt,
                    })}
                  </p>
                </div>
              </div>
              {view.items.length === 0 ? (
                <StatePanel heading={t("No Task records returned on this page")} status>
                  <p>
                    {t(
                      "The authorized query returned no visible Task records. No business outcome is inferred.",
                    )}
                  </p>
                </StatePanel>
              ) : (
                <div className="task-inbox-list">
                  {view.items.map((item, position) => (
                    <TaskInboxEntry
                      key={item.taskReference}
                      item={item}
                      position={position}
                      storeLabel={view.storeLabel}
                    />
                  ))}
                </div>
              )}
            </section>
            <aside className="task-inbox-actions-note" id="task-inbox-action-boundary">
              <h3>{t("Task actions unavailable")}</h3>
              <p>
                {t(
                  "Claim requires a current eligible Queue member and an authorized write endpoint. Assignment, acknowledgement, source navigation, and resolution require their own approved commands and source permissions. No Task or source state was changed.",
                )}
              </p>
            </aside>
            <div className="task-inbox-pagination">
              <button
                type="button"
                onClick={onNext}
                disabled={!online || readOnly || view.nextAfterTaskReference === null}
              >
                {t("Load next page")}
              </button>
              {view.nextAfterTaskReference === null ? (
                <span>{t("No continuation was returned for this page.")}</span>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </AppFrame>
  );
}

export function TaskInboxPage() {
  const currentRequest = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const lastView = useRef<TaskInboxView | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [state, setState] = useState<PageState>({ kind: "Loading" });

  const load = useCallback(
    async (afterTaskReference: string | null) => {
      const version = ++requestVersion.current;
      currentRequest.current?.abort();
      if (!online) {
        setState({ kind: "Offline", view: lastView.current });
        return;
      }
      const request = new AbortController();
      currentRequest.current = request;
      setState({ kind: "Loading" });
      try {
        const view = parseTaskInboxView(await client.load(afterTaskReference, request.signal));
        if (version !== requestVersion.current || request.signal.aborted) return;
        if (
          afterTaskReference !== null &&
          ((view.nextAfterTaskReference !== null &&
            view.nextAfterTaskReference <= afterTaskReference) ||
            view.items.some((item) => item.taskReference <= afterTaskReference))
        )
          throw new Error("TASK_INBOX_INVALID");
        lastView.current = view;
        setState({ kind: "Ready", view });
      } catch (error) {
        if (version === requestVersion.current && !request.signal.aborted) {
          lastView.current = null;
          setState({ kind: errorCode(error) });
        }
      }
    },
    [online],
  );

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => {
      setOnline(false);
      requestVersion.current++;
      currentRequest.current?.abort();
      setState({ kind: "Offline", view: lastView.current });
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      requestVersion.current++;
      currentRequest.current?.abort();
      lastView.current = null;
    };
  }, []);

  useEffect(() => {
    if (online) void load(null);
    else setState({ kind: "Offline", view: lastView.current });
  }, [load, online]);

  return (
    <TaskInboxScreen
      state={state}
      onRefresh={() => void load(null)}
      onNext={() => {
        if (state.kind === "Ready" && state.view.nextAfterTaskReference !== null)
          void load(state.view.nextAfterTaskReference);
      }}
      online={online}
    />
  );
}
