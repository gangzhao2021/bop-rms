import { listSeparator, t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { KitchenWorkClientError, createKitchenWorkClient } from "./kitchen-work-client.js";
import {
  kitchenStepMaxLines,
  prepareKitchenStep,
  type KitchenStepKind,
  type KitchenStepLineResult,
  type KitchenStepReply,
} from "./kitchen-step-client.js";
import { createKitchenStepQueue, type KitchenTap } from "./kitchen-step-queue.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { KitchenBoardItem, KitchenBoardView } from "./kitchen-board.js";
import { browserOffline } from "./stale-read.js";

/** One line the cook tapped: a dish on the screen, or one chosen dish of a combo. */
export interface KitchenStepTarget {
  /** The key this line has on the screen (work item, or work item and chosen dish). */
  readonly lineKey: string;
  readonly item: KitchenBoardItem;
  /** The chosen dishes this tap finishes; null: the whole work item. */
  readonly optionReferences: readonly string[] | null;
}

/** What the board says about steps, in one line each, newest first. */
export interface KitchenStepNotice {
  readonly id: number;
  readonly tone: "Done" | "Problem";
  readonly text: string;
  /** When it was said (this page's clock), so the board says the newest thing first. */
  readonly at: number;
}
/** Confirmed steps show at once; a problem stays long enough to read it. */
export const kitchenNoticeDoneMs = 6_000;
export const kitchenNoticeProblemMs = 30_000;

/** A step the server confirmed, kept until the queue projection shows it. */
export interface KitchenConfirmedStep {
  readonly workItemReference: string;
  readonly ticketReference: string;
  readonly result: KitchenStepLineResult;
}

function behind(item: KitchenBoardItem, step: KitchenConfirmedStep): boolean {
  const execution = item.execution;
  const { result } = step;
  if (!execution || result.ticketVersion === null || result.workItemVersion === null) return false;
  return (
    BigInt(execution.ticketVersion) < BigInt(result.ticketVersion) ||
    BigInt(execution.workItemVersion) < BigInt(result.workItemVersion) ||
    // A combo's dish is its own fact: the work item's versions need not move.
    (result.dishesDone ?? []).some((option) =>
      (item.comboParts ?? []).some((part) => part.optionReference === option && !part.done),
    )
  );
}

/**
 * WP-2423: the board shows a kitchen step as soon as the server confirms it, instead of waiting for
 * the queue projection (which a background worker updates, and which can lag or stop). Only what
 * the server's result states is applied, and only while the projection is older than that result;
 * once the projection reaches the confirmed versions it is the source again.
 */
export function applyConfirmedKitchenSteps(
  view: KitchenBoardView,
  steps: readonly KitchenConfirmedStep[],
): KitchenBoardView {
  const pending = steps.filter((step) =>
    view.items.some(
      (item) => item.workItemReference === step.workItemReference && behind(item, step),
    ),
  );
  if (pending.length === 0) return view;
  const items = view.items.map((item) => {
    const execution = item.execution;
    const own = pending.find((step) => step.workItemReference === item.workItemReference);
    if (!execution || !own) return item;
    const { result } = own;
    return Object.freeze({
      ...item,
      status: result.workItemStatus ?? item.status,
      completedQuantity: result.completedQuantity ?? item.completedQuantity,
      ...(item.comboParts === undefined || result.dishesDone === null
        ? {}
        : {
            comboParts: Object.freeze(
              item.comboParts.map((part) =>
                result.dishesDone?.includes(part.optionReference) && !part.done
                  ? Object.freeze({ ...part, done: true })
                  : part,
              ),
            ),
          }),
      execution: Object.freeze({
        ...execution,
        ticketVersion: result.ticketVersion ?? execution.ticketVersion,
        workItemVersion: result.workItemVersion ?? execution.workItemVersion,
        acceptedAt: result.acceptedAt ?? execution.acceptedAt,
        readyAt: result.readyAt ?? execution.readyAt,
      }),
    });
  });
  return Object.freeze({ ...view, items: Object.freeze(items) });
}

/**
 * The name of what a tap took: a combo's chosen dishes by their own names (Chinese first), so one
 * dish done on a combo's card never reads as the whole combo done; otherwise the line's name.
 */
export function kitchenTargetName(target: KitchenStepTarget): string {
  const parts = target.item.comboParts;
  const chosen = target.optionReferences;
  if (parts === undefined || chosen === null) return target.item.displayName;
  const names = parts
    .filter((part) => chosen.includes(part.optionReference))
    .map((part) => part.nameZh || part.name);
  return names.length === 0 ? target.item.displayName : names.join(listSeparator());
}

/** What the cook just did, in their words ("Order 6 · Latte done."); null when nothing changed. */
export function kitchenStepText(
  orderLabel: string,
  displayName: string,
  result: Pick<KitchenStepLineResult, "outcome">,
): string | null {
  switch (result.outcome) {
    case "Started":
      return t("{orderLabel} · {displayName} started.", { orderLabel, displayName });
    case "Finished":
      return t("{orderLabel} · {displayName} done.", { orderLabel, displayName });
    case "DishDone":
      return t("{orderLabel} · {displayName} done.", { orderLabel, displayName });
    default:
      return null;
  }
}

/** Why a line of a tap was left out: what happened to it and that nothing was recorded for it. */
export function kitchenRefusalText(
  displayName: string,
  reason: KitchenStepLineResult["refusedReason"],
): string {
  switch (reason) {
    case "Cancelled":
      return t("{displayName} was cancelled, so nothing was recorded for it.", { displayName });
    case "Closed":
      return t("{displayName}: its ticket was closed, so nothing was recorded.", { displayName });
    case "Held":
      return t("{displayName} is on hold, so nothing was recorded for it.", { displayName });
    case "Blocked":
      return t("{displayName} needs its allergens checked before cooking. Nothing was recorded.", {
        displayName,
      });
    case "OrderChanged":
      return t(
        "{displayName}: the order changed, so nothing was recorded. Check with the server.",
        {
          displayName,
        },
      );
    default:
      return t("{displayName} is no longer on this ticket. Nothing was recorded.", {
        displayName,
      });
  }
}

/**
 * DEC-KITCHEN-ONE-TAP: the board's steps. A tap is one immutable body; the queue holds it, sends it
 * and retries it. Taps live here and never in browser storage: a tablet that dies during a hold
 * loses the tap and the ticket is still on the board, which is the safe side.
 */
export function useKitchenActions(input: {
  csrf: string | undefined;
  storeReference: string | undefined;
  view: KitchenBoardView | null;
  /** The last read failed: nothing is sent until a fresh read succeeds. */
  stale: boolean;
}) {
  const [taps, setTaps] = useState<readonly KitchenTap<KitchenStepTarget>[]>([]);
  const [confirmed, setConfirmed] = useState<readonly KitchenConfirmedStep[]>([]);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const [notices, setNotices] = useState<readonly KitchenStepNotice[]>([]);
  const [readyBusy, setReadyBusy] = useState(false);
  const noticeId = useRef(0);
  const authority = Boolean(
    input.csrf &&
    input.storeReference &&
    !input.stale &&
    input.view?.freshnessStatus === "Fresh" &&
    input.view.operatorStatus === "Named",
  );
  // Read inside timers: the render that scheduled a send may be long past when it fires.
  const latest = useRef({ authority, csrf: input.csrf, view: input.view });
  latest.current = { authority, csrf: input.csrf, view: input.view };
  const say = (tone: KitchenStepNotice["tone"], text: string) => {
    noticeId.current += 1;
    const id = noticeId.current;
    const at = performance.now();
    setNotices((current) => [{ id, tone, text, at }, ...current].slice(0, 6));
    if (typeof window !== "undefined")
      window.setTimeout(
        () => setNotices((current) => current.filter((notice) => notice.id !== id)),
        tone === "Done" ? kitchenNoticeDoneMs : kitchenNoticeProblemMs,
      );
  };
  const sayRef = useRef(say);
  sayRef.current = say;
  const queueRef = useRef<ReturnType<typeof createKitchenStepQueue<KitchenStepTarget>> | null>(
    null,
  );
  const bodies = useRef(new Map<number, ReturnType<typeof prepareKitchenStep>>());
  useEffect(() => {
    const controller = new AbortController();
    const queue = createKitchenStepQueue<KitchenStepTarget>({
      authority: () => latest.current.authority && !browserOffline(),
      send: async (tap) => {
        const csrf = latest.current.csrf;
        const body = bodies.current.get(tap.id);
        if (csrf === undefined || body === undefined) throw new Error("KITCHEN_STEP_UNAVAILABLE");
        return body.execute(csrf, controller.signal);
      },
      onChange: setTaps,
      onConfirmed: (tap, reply: KitchenStepReply) => {
        bodies.current.delete(tap.id);
        const lines = reply.lines;
        setConfirmed((steps) => {
          const others = steps.filter(
            (step) => !lines.some((line) => line.workItemReference === step.workItemReference),
          );
          return [
            ...others,
            ...lines
              .filter((line) => line.ticketVersion !== null)
              .map((line) => ({
                workItemReference: line.workItemReference,
                ticketReference: line.ticketReference,
                result: line,
              })),
          ];
        });
        setConfirmedCount((count) => count + 1);
        const nameOf = (workItemReference: string) =>
          tap.targets.find((target) => target.item.workItemReference === workItemReference)?.item;
        const orderLabel = (item: KitchenBoardItem | undefined) =>
          item?.orderLabel ? kitchenOrderLabelText(item) : "";
        for (const line of lines) {
          const item = nameOf(line.workItemReference);
          const target = tap.targets.find(
            (candidate) => candidate.item.workItemReference === line.workItemReference,
          );
          const name = target === undefined ? "" : kitchenTargetName(target);
          if (line.outcome === "Refused")
            sayRef.current("Problem", kitchenRefusalText(name, line.refusedReason));
          else if (line.outcome === "NotAttempted")
            sayRef.current(
              "Problem",
              t("{displayName} was not recorded. Tap it again.", { displayName: name }),
            );
          else {
            const text = kitchenStepText(orderLabel(item), name, line);
            if (text !== null) sayRef.current("Done", text);
          }
        }
      },
      onRefused: (tap, code) => {
        bodies.current.delete(tap.id);
        sayRef.current(
          "Problem",
          code === "PermissionDenied"
            ? t(
                "Your current permission or Store scope no longer allows this action. Refresh before continuing.",
              )
            : t("The action was not accepted. Refresh and review the current work item."),
        );
      },
      onNotSent: (unsent) => {
        for (const tap of unsent) bodies.current.delete(tap.id);
        sayRef.current(
          "Problem",
          t("The board lost touch. That step was not recorded. Tap it again."),
        );
      },
    });
    queueRef.current = queue;
    return () => {
      controller.abort();
      queue.dispose();
      queueRef.current = null;
    };
  }, []);
  // The connection or authority going sends every unsent tap back to the cook at once.
  useEffect(() => {
    if (!authority) queueRef.current?.authorityLost();
  }, [authority]);
  // A confirmed step is dropped once the projection shows it (or no longer lists the work).
  useEffect(() => {
    const view = input.view;
    if (!view || confirmed.length === 0) return;
    const still = confirmed.filter((step) =>
      view.items.some(
        (item) => item.workItemReference === step.workItemReference && behind(item, step),
      ),
    );
    if (still.length !== confirmed.length) setConfirmed(still);
  }, [input.view, confirmed]);
  const view = useMemo(
    () => (input.view ? applyConfirmedKitchenSteps(input.view, confirmed) : null),
    [input.view, confirmed],
  );
  const pendingLines = useMemo(() => {
    const lines = new Map<string, KitchenTap<KitchenStepTarget>>();
    for (const tap of taps) for (const target of tap.targets) lines.set(target.lineKey, tap);
    return lines;
  }, [taps]);
  return {
    /** Whether a step can be tapped at all right now. */
    blocked: !authority || readyBusy,
    /** The board as the server last confirmed it: the projection plus confirmed steps it lacks. */
    view,
    taps,
    /** Each line a tap holds, by its key on the screen. */
    pendingLines,
    notices,
    /** Goes up with each confirmed tap, so the board reads again at once. */
    confirmedCount,
    /** Confirmed steps the projection has not shown yet. */
    awaitingProjection: confirmed.length > 0,
    /**
     * One tap. Each line's own step is recorded; a set larger than one body is split, in order, and
     * each part keeps the same hold.
     */
    step(targets: readonly KitchenStepTarget[], step: KitchenStepKind) {
      const queue = queueRef.current;
      const storeReference = input.storeReference;
      if (!authority || browserOffline() || !queue || !storeReference) return;
      const open = targets.filter((target) => !pendingLines.has(target.lineKey));
      for (let start = 0; start < open.length; start += kitchenStepMaxLines) {
        const part = open.slice(start, start + kitchenStepMaxLines);
        const body = prepareKitchenStep({
          step,
          storeReference,
          correlationReference: serviceOperationReference(),
          lines: mergeTargets(part),
        });
        const id = queue.tap(step, part);
        bodies.current.set(id, body);
      }
    },
    /** Within the hold: nothing was sent, so nothing is recorded and nobody is told anything. */
    undo(ids: readonly number[]) {
      for (const id of ids) {
        if (queueRef.current?.undo(id) === true) bodies.current.delete(id);
      }
    },
    retry(ids: readonly number[]) {
      for (const id of ids) queueRef.current?.retry(id);
    },
    dismiss(ids: readonly number[]) {
      for (const id of ids) {
        queueRef.current?.dismiss(id);
        bodies.current.delete(id);
      }
    },
    readyBusy,
    /** Expo Enabled only: an order item marked ready, one after another, with its versions. */
    markReady(items: readonly KitchenBoardItem[]) {
      const storeReference = input.storeReference;
      const csrf = input.csrf;
      if (!authority || readyBusy || !storeReference || !csrf) return;
      setReadyBusy(true);
      void (async () => {
        const versions = new Map<string, string>();
        try {
          for (const original of items) {
            const execution = original.execution;
            const confirmedVersion = versions.get(original.ticketReference);
            const item =
              execution &&
              confirmedVersion !== undefined &&
              BigInt(confirmedVersion) > BigInt(execution.ticketVersion)
                ? Object.freeze({
                    ...original,
                    execution: Object.freeze({ ...execution, ticketVersion: confirmedVersion }),
                  })
                : original;
            const result = await createKitchenWorkClient()
              .prepare({
                action: "MarkKitchenOrderItemReady",
                item,
                storeReference,
                idempotencyKey: serviceOperationReference(),
                correlationReference: serviceOperationReference(),
              })
              .execute(csrf);
            versions.set(item.ticketReference, result.ticketVersion);
            setConfirmed((steps) => [
              ...steps.filter((step) => step.workItemReference !== item.workItemReference),
              {
                workItemReference: item.workItemReference,
                ticketReference: item.ticketReference,
                result: {
                  workItemReference: item.workItemReference,
                  orderItemReference: item.execution?.orderItemReference ?? "",
                  ticketReference: item.ticketReference,
                  outcome: "AlreadyFinished",
                  refusedReason: null,
                  ticketVersion: result.ticketVersion,
                  workItemVersion: result.workItemVersion,
                  workItemStatus: result.workItemStatus,
                  completedQuantity: result.completedQuantity,
                  requiredQuantity: item.requiredQuantity,
                  acceptedAt: item.execution?.acceptedAt ?? null,
                  readyAt: result.occurredAt,
                  dishesDone: null,
                },
              },
            ]);
            setConfirmedCount((count) => count + 1);
            sayRef.current(
              "Done",
              t("{orderLabel} · {displayName} ready.", {
                orderLabel: kitchenOrderLabelText(item),
                displayName: item.displayName,
              }),
            );
          }
        } catch (error) {
          const busy =
            error instanceof KitchenWorkClientError &&
            (error.code === "Busy" || error.code === "Conflict" || error.code === "OutcomeUnknown");
          sayRef.current(
            "Problem",
            busy
              ? t("The kitchen system was busy for a moment and nothing was changed. Try again.")
              : t("The action was not accepted. Refresh and review the current work item."),
          );
        } finally {
          setReadyBusy(false);
        }
      })();
    },
  };
}

function kitchenOrderLabelText(item: KitchenBoardItem): string {
  const label = item.orderLabel;
  return label ? t("Order {orderNumber}", { orderNumber: label.orderNumber }) : "";
}

/** Dish lines of one combo become one line of the body, naming each chosen dish. */
function mergeTargets(targets: readonly KitchenStepTarget[]) {
  const lines = new Map<
    string,
    {
      idempotencyKey: string;
      ticketReference: string;
      workItemReference: string;
      orderItemReference: string;
      optionReferences: string[] | null;
    }
  >();
  for (const target of targets) {
    const { item } = target;
    const existing = lines.get(item.workItemReference);
    if (existing) {
      existing.optionReferences =
        existing.optionReferences === null || target.optionReferences === null
          ? null
          : [...existing.optionReferences, ...target.optionReferences];
      continue;
    }
    lines.set(item.workItemReference, {
      idempotencyKey: serviceOperationReference(),
      ticketReference: item.ticketReference,
      workItemReference: item.workItemReference,
      orderItemReference: item.execution?.orderItemReference ?? "",
      optionReferences: target.optionReferences === null ? null : [...target.optionReferences],
    });
  }
  return [...lines.values()];
}
