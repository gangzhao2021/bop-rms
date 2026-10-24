import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import {
  createDiningServeReadyClient,
  DINING_SERVE_READY_MAX_LINES,
  DiningServeReadyClientError,
  type DiningServeReadyResult,
} from "./dining-serve-ready-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { servableQuantity, type DiningProgress } from "./dining-progress-client.js";

type Item = DiningProgress["items"][number];
type Operation = ReturnType<ReturnType<typeof createDiningServeReadyClient>["prepare"]>;

/** Items staff can hand over now: kitchen-ready with something left to serve, at an open table. */
export function readyToServe(view: DiningProgress, batchSequence?: number): readonly Item[] {
  if (view.sessionPhase !== "Active" || view.closureStatus !== "Open") return [];
  return view.items.filter(
    (item) =>
      item.phase === "Ready" &&
      // WP-2423 (2026-10-18): a portion the kitchen is remaking is not ready to serve.
      servableQuantity(item) >= 1 &&
      (batchSequence === undefined || item.batchSequence === batchSequence),
  );
}

/** "Small (8 oz) · Extra shot × 2", as the order detail writes a line's options. */
export function optionsText(item: Item): string {
  return (item.details?.options ?? [])
    .map((option) => (option.quantity > 1 ? `${option.name} × ${option.quantity}` : option.name))
    .join(" · ");
}

export interface ServeLine {
  readonly key: string;
  readonly quantity: number;
  readonly name: string;
  readonly options: string;
  readonly note: string | null;
  readonly round: number;
}

/**
 * WP-2423 (v15 2026-10-16): what the confirmation lists. Lines that are the same dish with the
 * same options and no note are one line ("10 × Flat White"); a line with a note ("Cup 3") stays on
 * its own with that note, so staff can match each one at the table. A line whose options could not
 * be read is never merged with another.
 */
export function serveLines(lines: readonly Item[], byRound: boolean): readonly ServeLine[] {
  const result: ServeLine[] = [];
  const grouped = new Map<string, number>();
  for (const item of lines) {
    const options = optionsText(item);
    const note = item.details?.customerNote ?? null;
    const line = {
      key: item.orderItemReference,
      quantity: servableQuantity(item),
      name: item.displayName,
      options,
      note,
      round: item.batchSequence,
    };
    if (item.details === undefined || note !== null) {
      result.push(line);
      continue;
    }
    const same = JSON.stringify([item.displayName, options, byRound ? item.batchSequence : 0]);
    const at = grouped.get(same);
    const existing = at === undefined ? undefined : result[at];
    if (existing === undefined) {
      grouped.set(same, result.length);
      result.push(line);
    } else if (at !== undefined)
      result[at] = { ...existing, quantity: existing.quantity + servableQuantity(item) };
  }
  return result;
}

const refusal = {
  Denied: t(
    "Nothing was marked served. Your access may have changed; check serving progress and try again.",
  ),
  NotAvailable: t(
    "Nothing was marked served. This table has changed; check serving progress and try again.",
  ),
} as const;
const items = (count: number) => (count === 1 ? t("1 item") : t("{count} items", { count: count }));

/** The result in staff words: what was served and what still needs a look. */
export function serveReadySummary(result: DiningServeReadyResult): string {
  const parts: string[] = [];
  const notServed = result.changed + result.failed;
  if (result.served > 0)
    parts.push(
      notServed === 0 && result.alreadyServed === 0
        ? t("All {served} marked served.", { served: items(result.served) })
        : t("{served} served.", { served: result.served }),
    );
  if (result.alreadyServed > 0)
    parts.push(
      t("{alreadyServed} {value} already marked served by someone else.", {
        alreadyServed: result.alreadyServed,
        value: result.alreadyServed === 1 ? "was" : "were",
      }),
    );
  if (result.changed > 0)
    parts.push(
      t(
        "{changed} could not be served because {value} changed (cancelled, partly served or the table moved). Check {value2} and try again.",
        {
          changed: result.changed,
          value: result.changed === 1 ? "it" : "they",
          value2: result.changed === 1 ? "it" : "them",
        },
      ),
    );
  if (result.failed > 0)
    parts.push(
      t("{failed} could not be served right now. {value} still ready; try again.", {
        failed: result.failed,
        value: result.failed === 1 ? "It is" : "They are",
      }),
    );
  return parts.join(" ");
}

/**
 * WP-2423: one confirmation marks every ready item of a round (or of the whole table) served. The
 * server serves each line with the ordinary serve command; a lost answer is retried with the same
 * request, which never serves anything twice.
 */
export function DiningServeReadyAction({
  view,
  ready,
  scope,
  csrf,
  locked,
  onBusy,
  onDone,
  fetcher,
}: {
  readonly view: DiningProgress;
  /** The ready items this action covers (see `readyToServe`). */
  readonly ready: readonly Item[];
  /** "round 2" or "table" — how staff recognise what is served. */
  readonly scope:
    { readonly kind: "Round"; readonly sequence: number } | { readonly kind: "Table" };
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  /** Served (fully or partly): the summary to show while the progress is reread. */
  readonly onDone: (summary: string) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<Operation | null>(null),
    pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied" | "NotAvailable">(
    "Idle",
  );
  useEffect(() => () => pending.current?.abort(), []);
  if (ready.length < 2) return null;
  const lines = ready.slice(0, DINING_SERVE_READY_MAX_LINES);
  const where =
    scope.kind === "Round"
      ? t("round {sequence} at table {tableLabel}", {
          sequence: scope.sequence,
          tableLabel: view.tableLabel,
        })
      : t("table {tableLabel}", { tableLabel: view.tableLabel });
  const label =
    ready.length > lines.length
      ? t("Serve the first {length} of {length2} ready items", {
          length: lines.length,
          length2: ready.length,
        })
      : t("Serve all {length} ready items", { length: ready.length });
  const buttonLabel =
    scope.kind === "Round"
      ? t("{label} in round {sequence}", { label: label, sequence: scope.sequence })
      : label;
  const titleId = "serve-ready-" + (scope.kind === "Round" ? "round-" + scope.sequence : "table");
  const submit = async () => {
    if (pending.current || (!operation.current && locked)) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onBusy(true);
    try {
      operation.current ??= createDiningServeReadyClient(fetcher).prepare({
        operationReference: serviceOperationReference(),
        orderReference: view.orderReference,
        expectedOrderVersion: view.orderVersion,
        expectedSessionVersion: view.sessionVersion,
        expectedTableAssignmentVersion: view.tableAssignmentVersion,
        lines: lines.map((item) => ({
          orderItemReference: item.orderItemReference,
          quantity: servableQuantity(item),
          expectedItemServiceVersion: item.itemServiceVersion,
        })),
      });
      const result = await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        dialog.current?.close();
        onBusy(false);
        onDone(serveReadySummary(result));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code =
          error instanceof DiningServeReadyClientError ? error.code : ("OutcomeUnknown" as const);
        setState(
          code === "OutcomeUnknown"
            ? "Unknown"
            : code === "PermissionDenied"
              ? "Denied"
              : "NotAvailable",
        );
        if (code !== "OutcomeUnknown") onBusy(false);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const retrying = state === "Unknown";
  return (
    <div className="card-actions dining-serve-ready">
      <button
        type="button"
        disabled={locked && !retrying}
        onClick={() => dialog.current?.showModal()}
      >
        {retrying ? t("Check serving result") : buttonLabel}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (state === "Submitting") event.preventDefault();
        }}
        onClose={() => {
          // Nothing was served: reread the table so staff see what changed.
          if (state === "Denied" || state === "NotAvailable") onDone(refusal[state]);
        }}
      >
        <h2 id={titleId}>
          {t("Mark {length} served for {where}?", { length: items(lines.length), where: where })}
        </h2>
        <p>
          {t("Each item is marked served in full. Only confirm once they are all on the table.")}
        </p>
        <ul className="dining-serve-ready-lines">
          {serveLines(lines, scope.kind === "Table").map((line) => (
            <li key={line.key}>
              {line.quantity} × {line.name}
              {scope.kind === "Table" ? t(" · round {round}", { round: line.round }) : ""}
              {line.options ? <span className="order-line-options">{line.options}</span> : null}
              {line.note !== null ? (
                <span className="order-line-note">{t("Note: {note}", { note: line.note })}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {ready.length > lines.length ? (
          <p>
            {t("The other {value} ready items stay as they are; serve them next.", {
              value: ready.length - lines.length,
            })}
          </p>
        ) : null}
        <div className="card-actions">
          {state === "Denied" || state === "NotAvailable" ? null : (
            <button
              type="button"
              disabled={state === "Submitting" || (!retrying && locked)}
              onClick={() => void submit()}
            >
              {retrying
                ? t("Retry the same request")
                : state === "Submitting"
                  ? t("Marking served…")
                  : t("Mark {length} served", { length: items(lines.length) })}
            </button>
          )}
          <button
            type="button"
            disabled={state === "Submitting"}
            onClick={() => dialog.current?.close()}
          >
            {state === "Denied" || state === "NotAvailable" ? t("Close") : t("Not yet")}
          </button>
        </div>
        <p role="status">
          {state === "Submitting"
            ? t("Marking {length} served. This can take a little while for a full table.", {
                length: items(lines.length),
              })
            : state === "Unknown"
              ? t(
                  "We could not confirm the result. Retry the same request: anything already marked served will not be marked twice.",
                )
              : state === "Denied" || state === "NotAvailable"
                ? refusal[state]
                : null}
        </p>
      </dialog>
    </div>
  );
}

/** The table action (when ready items span rounds) and one action per round with 2+ ready. */
export function DiningServeReadyActions({
  view,
  csrf,
  locked,
  onBusy,
  onDone,
  fetcher,
}: {
  readonly view: DiningProgress;
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  readonly onDone: (summary: string) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const all = readyToServe(view);
  if (all.length < 2) return null;
  const rounds = [...new Set(all.map((item) => item.batchSequence))].sort((a, b) => a - b);
  const common = { view, csrf, locked, onBusy, onDone, fetcher };
  return (
    <div aria-label={t("Serve ready items")} role="group">
      {rounds.length > 1 ? (
        <DiningServeReadyAction {...common} ready={all} scope={{ kind: "Table" }} />
      ) : null}
      {rounds.map((sequence) => (
        <DiningServeReadyAction
          key={sequence}
          {...common}
          ready={readyToServe(view, sequence)}
          scope={{ kind: "Round", sequence }}
        />
      ))}
    </div>
  );
}
