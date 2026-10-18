import { useEffect, useId, useRef, useState } from "react";
import { StatePanel } from "@bop-rms/ui";
import { kitchenOrderText, type KitchenBoardItem } from "./kitchen-board.js";
import {
  createKitchenReworkClient,
  kitchenReworkBadge,
  KitchenReworkClientError,
  kitchenReworkNotReadyWindowMs,
  kitchenReworkReasonLabels,
  type KitchenReworkBoard,
  type KitchenReworkCommandBody,
  type KitchenReworkReason,
  type KitchenReworkView,
} from "./kitchen-rework-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { earlierDayText, fromEarlierKitchenDay } from "./KitchenEarlierDays.js";

type CommandState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Submitting"; readonly body: KitchenReworkCommandBody }
  | { readonly kind: "Unknown"; readonly body: KitchenReworkCommandBody }
  | { readonly kind: "Confirmed"; readonly body: KitchenReworkCommandBody }
  | {
      readonly kind: "Rejected";
      readonly body: KitchenReworkCommandBody;
      readonly code: KitchenReworkClientError["code"];
    };

/**
 * WP-2423 Q26: remakes read with the board (same revision) and their commands. A source without
 * remakes hides them; a failed read keeps the last remakes and says so.
 */
export function useKitchenRework(input: {
  readonly csrf: string | undefined;
  readonly storeReference: string | undefined;
  readonly revision: number;
  readonly onChanged: () => void;
}) {
  const [board, setBoard] = useState<KitchenReworkBoard | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [offered, setOffered] = useState(true);
  const [state, setState] = useState<CommandState>({ kind: "Idle" });
  const inFlight = useRef(false);
  const { csrf, storeReference, revision, onChanged } = input;
  useEffect(() => {
    if (!csrf || !storeReference || !offered) return;
    let current = true;
    createKitchenReworkClient({ csrf, storeReference })
      .load()
      .then(
        (next) => {
          if (!current) return;
          setBoard(next);
          setReadFailed(false);
        },
        (error: unknown) => {
          if (!current) return;
          if (error instanceof KitchenReworkClientError && error.code === "NotOffered") {
            setOffered(false);
            setBoard(null);
          } else if (error instanceof KitchenReworkClientError && error.code === "PermissionDenied")
            setBoard(null);
          else setReadFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [csrf, storeReference, revision, offered]);
  async function run(body: KitchenReworkCommandBody) {
    if (inFlight.current || !csrf || !storeReference) return;
    inFlight.current = true;
    setState({ kind: "Submitting", body });
    try {
      await createKitchenReworkClient({ csrf, storeReference }).execute(body);
      setState({ kind: "Confirmed", body });
      onChanged();
    } catch (error) {
      const code = error instanceof KitchenReworkClientError ? error.code : "OutcomeUnknown";
      setState(
        code === "OutcomeUnknown" ? { kind: "Unknown", body } : { kind: "Rejected", body, code },
      );
      if (code !== "OutcomeUnknown") onChanged();
    } finally {
      inFlight.current = false;
    }
  }
  return {
    board: offered ? board : null,
    readFailed: offered && readFailed,
    state,
    busy: state.kind === "Submitting",
    create(item: KitchenBoardItem, choice: RemakeChoice) {
      void run({
        action: "CreateKitchenRework",
        idempotencyKey: serviceOperationReference(),
        originalWorkItemReference: item.workItemReference,
        reasonCode: choice.reason,
        note: choice.note,
        quantity: choice.quantity,
        correlationReference: serviceOperationReference(),
      });
    },
    advance(rework: KitchenReworkView) {
      if (rework.status === "Completed") return;
      void run({
        action: rework.status === "Queued" ? "StartKitchenRework" : "CompleteKitchenRework",
        idempotencyKey: serviceOperationReference(),
        reworkReference: rework.reworkReference,
        expectedVersion: rework.version,
        correlationReference: serviceOperationReference(),
      });
    },
    retry() {
      if (state.kind === "Unknown") void run(state.body);
    },
    dismiss() {
      if (state.kind !== "Submitting") setState({ kind: "Idle" });
    },
  };
}

export interface RemakeChoice {
  readonly reason: KitchenReworkReason;
  readonly note: string | null;
  readonly quantity: number;
}

/** Remakes are offered for dishes of the last 12 hours, never an earlier day's lingering ticket. */
export const kitchenRemakeOfferedMs = 12 * 60 * 60 * 1000;
export function remakeOffered(item: KitchenBoardItem, observedAt: string): boolean {
  return (
    item.status === "Completed" &&
    Date.parse(observedAt) - Date.parse(item.createdAt) <= kitchenRemakeOfferedMs
  );
}

/** "Not ready yet" is offered only while the mistake can still be corrected (two minutes). */
export function notReadyOffered(item: KitchenBoardItem, observedAt: string): boolean {
  const readyAt = item.execution?.readyAt ?? null;
  if (readyAt === null) return true;
  return Date.parse(observedAt) - Date.parse(readyAt) <= kitchenReworkNotReadyWindowMs;
}

export function KitchenReworkStatus({
  rework,
}: {
  readonly rework: ReturnType<typeof useKitchenRework>;
}) {
  const { state } = rework;
  if (state.kind === "Idle") return null;
  const creating = state.body.action === "CreateKitchenRework";
  const heading =
    state.kind === "Submitting"
      ? creating
        ? "Sending remake"
        : "Updating remake"
      : state.kind === "Unknown"
        ? "Remake result unknown"
        : state.kind === "Confirmed"
          ? creating
            ? "Remake sent to the kitchen"
            : "Remake updated"
          : "Remake not recorded";
  const text =
    state.kind === "Submitting"
      ? "Please wait."
      : state.kind === "Unknown"
        ? "The answer was lost. Retry the same remake; it will not be sent twice."
        : state.kind === "Confirmed"
          ? creating && state.body.reasonCode === "NOT_READY"
            ? "The dish is back in progress. Nothing was recorded as waste."
            : creating
              ? "The first dish is recorded as waste. The guest is not charged again."
              : "The board now shows the remake's current state."
          : state.code === "WindowClosed"
            ? state.body.action === "CreateKitchenRework" && state.body.reasonCode === "NOT_READY"
              ? "More than two minutes have passed since it was marked done. Choose another reason to remake it."
              : "This dish was finished too long ago to remake. Close the old order instead."
            : state.code === "PermissionDenied"
              ? "Your role does not allow remakes. Ask a manager or kitchen lead."
              : state.code === "Conflict"
                ? "The remake changed on another screen. The board has been refreshed."
                : "The dish is not finished, or it was already remade too many times. The board has been refreshed.";
  return (
    <div className="kitchen-rework-status" data-kind={state.kind}>
      <StatePanel heading={heading} tone={state.kind === "Rejected" ? "error" : "neutral"} status>
        <p>{text}</p>
        {state.kind === "Unknown" ? (
          <button type="button" onClick={rework.retry}>
            Retry same remake
          </button>
        ) : null}
        {state.kind === "Confirmed" || state.kind === "Rejected" ? (
          <button type="button" onClick={rework.dismiss}>
            Dismiss
          </button>
        ) : null}
      </StatePanel>
    </div>
  );
}

function orderText(label: KitchenReworkView["orderLabel"]): string {
  return kitchenOrderText(label);
}

/** Open remakes first in their own lane, clearly marked; finished ones stay out of the way. */
export function KitchenRemakeLane({
  items,
  readOnly,
  onAdvance,
  today,
}: {
  readonly items: readonly KitchenReworkView[];
  /** The Store's current business day: a remake for an earlier day's order says its day. */
  readonly today?: string | null | undefined;
  readonly readOnly: boolean;
  readonly onAdvance: (rework: KitchenReworkView) => void;
}) {
  const open = items.filter((item) => item.status !== "Completed");
  if (open.length === 0) return null;
  return (
    <section className="kitchen-station-lane kitchen-remake-lane" aria-label="Remakes">
      <header className="kitchen-station-lane__heading">
        <h3>Remakes</h3>
        <span aria-label={`${open.length} open remakes`}>{open.length}</span>
      </header>
      <div className="kitchen-station-lane__items">
        {open.map((rework) => (
          <article
            key={rework.reworkReference}
            className="kitchen-work-item kitchen-work-item--remake"
            data-status={rework.status}
          >
            <p className="kitchen-remake-badge">{kitchenReworkBadge(rework.reasonCode)}</p>
            <h4 className="kitchen-order-group__label">
              {orderText(rework.orderLabel)}
              {fromEarlierKitchenDay(rework, today) && rework.businessDate
                ? ` · ${earlierDayText(rework.businessDate)}`
                : ""}
            </h4>
            <div className="kitchen-work-item__summary">
              <h3>{rework.displayName}</h3>
            </div>
            <div className="kitchen-work-item__state">
              <strong data-status={rework.status}>
                {rework.status === "In Progress" ? "In progress" : rework.status}
              </strong>
            </div>
            <div className="kitchen-work-item__facts">
              <dl className="kitchen-work-item__quantity">
                <dt>Quantity</dt>
                <dd>{rework.quantity}</dd>
              </dl>
              {rework.selectedOptions.length > 0 ? (
                <ul className="kitchen-work-item__options" aria-label="Modifiers">
                  {rework.selectedOptions.map((option, index) => (
                    <li key={`${option.displayName}:${index}`}>
                      {option.quantity > 1
                        ? `${option.displayName} × ${option.quantity}`
                        : option.displayName}
                    </li>
                  ))}
                </ul>
              ) : null}
              {rework.customerNote ? (
                <p className="kitchen-work-item__note">
                  <span>Note:</span> {rework.customerNote}
                </p>
              ) : null}
              {rework.note ? (
                <p className="kitchen-work-item__note kitchen-remake-note">
                  <span>Why:</span> {rework.note}
                </p>
              ) : null}
            </div>
            <div className="kitchen-work-item__actions">
              <button type="button" disabled={readOnly} onClick={() => onAdvance(rework)}>
                {rework.status === "Queued" ? "Start remake" : "Remake done"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * The remake form: why, how many, and a short note. The first dish is recorded as waste unless it
 * was only marked done too early; the guest is never charged again.
 */
export function KitchenRemakeDialog({
  item,
  observedAt,
  onSubmit,
  onClose,
}: {
  readonly item: KitchenBoardItem | null;
  readonly observedAt: string;
  readonly onSubmit: (item: KitchenBoardItem, choice: RemakeChoice) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState<KitchenReworkReason | null>(null);
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState(1);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (item && !element.open) {
      setReason(null);
      setNote("");
      setQuantity(item.requiredQuantity);
      element.showModal();
    } else if (!item && element.open) element.close();
  }, [item]);
  const reasons = (
    ["WRONG_ITEM", "DROPPED", "CUSTOMER_RETURNED", "QUALITY_ISSUE", "NOT_READY", "OTHER"] as const
  ).filter(
    (value) => value !== "NOT_READY" || (item !== null && notReadyOffered(item, observedAt)),
  );
  const trimmed = note.trim();
  const valid =
    reason !== null &&
    trimmed.length <= 200 &&
    (reason !== "OTHER" || trimmed.length > 0) &&
    quantity >= 1 &&
    item !== null &&
    quantity <= item.requiredQuantity;
  return (
    <dialog
      ref={dialog}
      className="kitchen-remake-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
    >
      {item ? (
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || reason === null) return;
            onSubmit(item, {
              reason,
              note: trimmed.length === 0 ? null : trimmed,
              quantity: reason === "NOT_READY" ? item.requiredQuantity : quantity,
            });
            dialog.current?.close();
          }}
        >
          <h2 id={titleId}>Remake {item.displayName}</h2>
          <fieldset>
            <legend>Why does it need to be made again?</legend>
            {reasons.map((value) => (
              <label key={value} className="kitchen-remake-dialog__reason">
                <input
                  type="radio"
                  name="reason"
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                />
                <span>{kitchenReworkReasonLabels[value]}</span>
              </label>
            ))}
          </fieldset>
          {item.requiredQuantity > 1 && reason !== "NOT_READY" ? (
            <label className="kitchen-remake-dialog__field">
              <span>How many to remake (of {item.requiredQuantity})</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={item.requiredQuantity}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.currentTarget.value))}
              />
            </label>
          ) : null}
          <label className="kitchen-remake-dialog__field">
            <span>
              {reason === "OTHER" ? "What happened (required)" : "Note for the kitchen (optional)"}
            </span>
            <textarea
              rows={2}
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <p className="kitchen-remake-dialog__effect">
            {reason === "NOT_READY"
              ? "The dish goes back to in progress on this board. Nothing is recorded as waste."
              : "The first dish's ingredients are recorded as waste. The guest is not charged again, and the order is not shown as served twice."}
          </p>
          <div className="kitchen-remake-dialog__actions">
            <button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" disabled={!valid}>
              {reason === "NOT_READY" ? "Put back in progress" : "Send remake"}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/** Finished dishes of the last two hours, newest first (at most 12): the Recently finished list. */
export function recentlyFinishedKitchenItems(
  items: readonly KitchenBoardItem[],
  observedAt: string,
): KitchenBoardItem[] {
  const now = Date.parse(observedAt);
  return items
    .filter((item) => item.status === "Completed" && item.execution?.readyAt)
    .filter((item) => now - Date.parse(item.execution?.readyAt ?? "") <= 2 * 60 * 60 * 1000)
    .sort((a, b) => (b.execution?.readyAt ?? "").localeCompare(a.execution?.readyAt ?? ""))
    .slice(0, 12);
}

/** Finished dishes of the last two hours, newest first, so a returned dish can be remade. */
export function KitchenRecentlyFinished({
  items,
  reworks,
  observedAt,
  readOnly,
  onRemake,
  orderLabel,
}: {
  readonly items: readonly KitchenBoardItem[];
  readonly reworks: readonly KitchenReworkView[];
  readonly observedAt: string;
  readonly readOnly: boolean;
  readonly onRemake: (item: KitchenBoardItem) => void;
  readonly orderLabel: (item: KitchenBoardItem) => string;
}) {
  const finished = recentlyFinishedKitchenItems(items, observedAt);
  if (finished.length === 0) return null;
  const remade = (item: KitchenBoardItem) =>
    reworks.filter((rework) => rework.originalWorkItemReference === item.workItemReference).length;
  return (
    <details className="kitchen-recent-finished">
      <summary>Recently finished · {finished.length}</summary>
      <ul>
        {finished.map((item) => (
          <li key={item.workItemReference}>
            <span className="kitchen-recent-finished__name">
              <strong>{item.displayName}</strong>
              <span>
                {orderLabel(item)} · {item.requiredQuantity} ×
                {remade(item) > 0 ? ` · Remade ${remade(item)}×` : ""}
              </span>
            </span>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => onRemake(item)}
              aria-label={`Remake ${item.displayName}, ${orderLabel(item)}`}
            >
              Remake
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
