import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { StatePanel } from "@bop-rms/ui";
import type { KitchenBoardItem } from "./kitchen-board.js";
import {
  createKitchenStaleCloseClient,
  KitchenStaleCloseClientError,
  kitchenStaleCloseReasonLabels,
  type KitchenStaleCloseBody,
  type KitchenStaleCloseReason,
} from "./kitchen-stale-close-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { businessDateText } from "./StoreBusinessDay.js";

/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS: order numbers restart every business day, so a ticket left
 * open from an earlier day looks like today's ticket with the same number. Such tickets are kept
 * apart, labelled with their day, guarded before any kitchen step, and closed by a manager.
 */
export function fromEarlierKitchenDay(
  item: Pick<KitchenBoardItem, "businessDate">,
  today: string | null | undefined,
): boolean {
  return Boolean(item.businessDate && today && item.businessDate < today);
}

/** "8 min", "2 h 5 min", "1 day", "5 days" for how long work has been waiting. */
export function kitchenWaitText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
  }
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? "1 day" : `${days} days`;
}

/** "From Fri, Oct 9" for an earlier business day's ticket. */
export function earlierDayText(businessDate: string): string {
  return "From " + businessDateText(businessDate);
}

export interface EarlierDayTicket {
  readonly ticketReference: string;
  readonly orderLabel: string;
  readonly businessDate: string;
  readonly ticketVersion: string | null;
  readonly createdAt: string;
  readonly items: readonly KitchenBoardItem[];
}

/** Earlier business days' tickets with open work, oldest first. */
export function earlierDayTickets(
  items: readonly KitchenBoardItem[],
  today: string | null | undefined,
  orderLabel: (item: KitchenBoardItem) => string,
): readonly EarlierDayTicket[] {
  const tickets = new Map<string, KitchenBoardItem[]>();
  for (const item of items) {
    if (!fromEarlierKitchenDay(item, today)) continue;
    const group = tickets.get(item.ticketReference);
    if (group) group.push(item);
    else tickets.set(item.ticketReference, [item]);
  }
  return [...tickets.entries()]
    .map(([ticketReference, group]) => {
      const first = group[0] as KitchenBoardItem;
      const versions = group.flatMap((item) =>
        item.execution ? [BigInt(item.execution.ticketVersion)] : [],
      );
      return {
        ticketReference,
        orderLabel: orderLabel(first),
        businessDate: first.businessDate as string,
        ticketVersion:
          versions.length === group.length && versions.length > 0
            ? versions.reduce((a, b) => (a > b ? a : b)).toString()
            : null,
        createdAt: group.map((item) => item.createdAt).sort()[0] as string,
        items: group,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

type CloseState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Submitting"; readonly body: KitchenStaleCloseBody }
  | { readonly kind: "Unknown"; readonly body: KitchenStaleCloseBody }
  | { readonly kind: "Confirmed"; readonly body: KitchenStaleCloseBody }
  | {
      readonly kind: "Rejected";
      readonly body: KitchenStaleCloseBody;
      readonly code: KitchenStaleCloseClientError["code"];
    };

/** The manager's close, with "result unknown → retry the same close" recovery. */
export function useKitchenStaleClose(input: {
  readonly csrf: string | undefined;
  readonly onChanged: () => void;
}) {
  const [state, setState] = useState<CloseState>({ kind: "Idle" });
  const inFlight = useRef(false);
  const { csrf, onChanged } = input;
  async function run(body: KitchenStaleCloseBody) {
    if (inFlight.current || !csrf) return;
    inFlight.current = true;
    setState({ kind: "Submitting", body });
    try {
      await createKitchenStaleCloseClient({ csrf }).close(body);
      setState({ kind: "Confirmed", body });
      onChanged();
    } catch (error) {
      const code =
        error instanceof KitchenStaleCloseClientError ? error.code : ("OutcomeUnknown" as const);
      setState(
        code === "OutcomeUnknown" ? { kind: "Unknown", body } : { kind: "Rejected", body, code },
      );
      if (code !== "OutcomeUnknown") onChanged();
    } finally {
      inFlight.current = false;
    }
  }
  return {
    state,
    busy: state.kind === "Submitting",
    close(ticket: EarlierDayTicket, reason: KitchenStaleCloseReason) {
      if (ticket.ticketVersion === null) return;
      void run({
        idempotencyKey: serviceOperationReference(),
        ticketReference: ticket.ticketReference,
        expectedTicketVersion: ticket.ticketVersion,
        reasonCode: reason,
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

export function KitchenStaleCloseStatus({
  close,
}: {
  readonly close: ReturnType<typeof useKitchenStaleClose>;
}) {
  const { state } = close;
  if (state.kind === "Idle") return null;
  const heading =
    state.kind === "Submitting"
      ? "Closing ticket"
      : state.kind === "Unknown"
        ? "Close result unknown"
        : state.kind === "Confirmed"
          ? "Ticket closed"
          : "Ticket not closed";
  const text =
    state.kind === "Submitting"
      ? "Please wait."
      : state.kind === "Unknown"
        ? "The answer was lost. Retry the same close; it will not be recorded twice."
        : state.kind === "Confirmed"
          ? state.body.reasonCode === "ALREADY_SERVED"
            ? "It has left the kitchen board. Its ingredients are recorded as used. The order and its payment are unchanged."
            : "It has left the kitchen board. Nothing is recorded as used. The order and its payment are unchanged — cancel or refund it in Orders if the guest should get money back."
          : state.code === "PermissionDenied"
            ? "Only a manager can close an earlier day's ticket."
            : state.code === "NotEarlierDay"
              ? "This ticket belongs to today's business day. Finish it on the board instead."
              : state.code === "NothingOpen"
                ? "Nothing on this ticket is still open. The board has been refreshed."
                : "The ticket changed on another screen. The board has been refreshed — check it again.";
  return (
    <div className="kitchen-rework-status kitchen-stale-close-status" data-kind={state.kind}>
      <StatePanel heading={heading} tone={state.kind === "Rejected" ? "error" : "neutral"} status>
        <p>{text}</p>
        {state.kind === "Unknown" ? (
          <button type="button" onClick={close.retry}>
            Retry same close
          </button>
        ) : null}
        {state.kind === "Confirmed" || state.kind === "Rejected" ? (
          <button type="button" onClick={close.dismiss}>
            Dismiss
          </button>
        ) : null}
      </StatePanel>
    </div>
  );
}

/** The manager's close: why, and what it does (and does not) do to the order and its money. */
export function KitchenCloseTicketDialog({
  ticket,
  onSubmit,
  onClose,
}: {
  readonly ticket: EarlierDayTicket | null;
  readonly onSubmit: (ticket: EarlierDayTicket, reason: KitchenStaleCloseReason) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState<KitchenStaleCloseReason | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (ticket && !element.open) {
      setReason(null);
      element.showModal();
    } else if (!ticket && element.open) element.close();
  }, [ticket]);
  const day = ticket ? businessDateText(ticket.businessDate) : "";
  return (
    <dialog
      ref={dialog}
      className="kitchen-remake-dialog kitchen-close-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
    >
      {ticket ? (
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason === null) return;
            onSubmit(ticket, reason);
            dialog.current?.close();
          }}
        >
          <h2 id={titleId}>
            Close {ticket.orderLabel} from {day}?
          </h2>
          <p>
            Use this for a ticket that was dealt with in real life but never cleared from this
            screen. The kitchen&apos;s record stays in the history.
          </p>
          <fieldset>
            <legend>What happened to it?</legend>
            {(["ALREADY_SERVED", "CANCELLED_ELSEWHERE", "NOT_MADE_ABANDONED"] as const).map(
              (value) => (
                <label key={value} className="kitchen-remake-dialog__reason">
                  <input
                    type="radio"
                    name="close-reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                  />
                  <span>{kitchenStaleCloseReasonLabels[value]}</span>
                </label>
              ),
            )}
          </fieldset>
          {reason ? (
            <p className="kitchen-remake-dialog__effect">
              {reason === "ALREADY_SERVED"
                ? "The food was made, so its ingredients are recorded as used."
                : "Nothing is recorded as used. Stock held for this order stays held until the order is cancelled in Orders."}
            </p>
          ) : null}
          <p className="kitchen-close-dialog__money" role="note">
            Closing the ticket does not refund or cancel the order. If the guest paid and did not
            get their food, cancel or refund {ticket.orderLabel.split(" · ")[0]} from {day} in{" "}
            <Link to="/operations/orders">Orders</Link>.
          </p>
          <div className="kitchen-remake-dialog__actions">
            <button type="button" onClick={() => dialog.current?.close()}>
              Keep open
            </button>
            <button type="submit" disabled={reason === null}>
              Close ticket
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/** "This ticket is from Fri, Oct 9 — continue?" before any kitchen step on an earlier day's work. */
export function KitchenEarlierDayConfirm({
  request,
  onCancel,
}: {
  readonly request: {
    readonly businessDate: string;
    readonly orderLabel: string;
    readonly actionLabel: string;
    readonly proceed: () => void;
  } | null;
  readonly onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const proceeded = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (request && !element.open) {
      proceeded.current = false;
      element.showModal();
    } else if (!request && element.open) element.close();
  }, [request]);
  const day = request ? businessDateText(request.businessDate) : "";
  return (
    <dialog
      ref={dialog}
      className="kitchen-remake-dialog kitchen-earlier-confirm"
      aria-labelledby={titleId}
      onClose={() => {
        if (!proceeded.current) onCancel();
      }}
    >
      {request ? (
        <div>
          <h2 id={titleId}>This ticket is from {day} — continue?</h2>
          <p>
            Order numbers restart every business day. {request.orderLabel.split(" · ")[0]} from{" "}
            {day} is not today&apos;s order with the same number. Check it is the right ticket
            before you {request.actionLabel.toLocaleLowerCase()}.
          </p>
          <div className="kitchen-remake-dialog__actions">
            <button type="button" autoFocus onClick={() => dialog.current?.close()}>
              Go back
            </button>
            <button
              type="button"
              onClick={() => {
                proceeded.current = true;
                dialog.current?.close();
                request.proceed();
                onCancel();
              }}
            >
              Continue — {request.actionLabel}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
