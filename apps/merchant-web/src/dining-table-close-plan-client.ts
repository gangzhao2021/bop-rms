import { t } from "./i18n/i18n.js";
/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT (WP-2423): the rounds still open at a table whose guests left, what
 * closing each does and what it refunds, read from the server (owner facts), and the existing staff
 * cancellations that resolve them (reason GUEST_LEFT). Codes stay server-owned; the dialog words them.
 */
import { serviceOperationReference } from "./service-control-client.js";

export class TableClosePlanError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotFound" | "Unavailable") {
    super(t("Table close plan unavailable"));
  }
}
const fail = (): never => {
  throw new TableClosePlanError("Unavailable");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const minor = /^(0|[1-9][0-9]{0,17})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const tableCloseRoundStates = [
  "NotPaid",
  "PaymentInProgress",
  "PaidNotSent",
  "AlreadyRefunded",
  "NotStarted",
  "PartlyStarted",
  "BeingMade",
  // v15 2026-10-28: rounds of a table that pays at the end (no payment of their own).
  "OnTableBill",
  "PaidWithTable",
  "RefundOnCardMachine",
  "Refunding",
] as const;
export type TableCloseRoundState = (typeof tableCloseRoundStates)[number];

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const reference = (value: unknown) =>
  typeof value === "string" && ref.test(value) ? value : fail();
const count = (value: unknown, max = 100_000) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : fail();
const amount = (value: unknown) =>
  typeof value === "string" && minor.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" && instantPattern.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : fail();

export function parseTableClosePlan(value: unknown, expected: { order: string; session: string }) {
  const raw = exact(value, [
    "orderReference",
    "diningSessionReference",
    "orderVersion",
    "observedAt",
    "rounds",
    "totals",
    "closeBlockers",
  ]);
  if (
    reference(raw.orderReference) !== expected.order ||
    reference(raw.diningSessionReference) !== expected.session ||
    !Array.isArray(raw.rounds) ||
    raw.rounds.length > 10_000
  )
    return fail();
  const orderVersion = count(raw.orderVersion, 2147483647);
  if (orderVersion < 1) return fail();
  const seen = new Set<string>();
  const rounds = raw.rounds.map((value: unknown) => {
    const round = exact(value, [
      "orderBatchReference",
      "sequence",
      "state",
      "openItemCount",
      "startedItemCount",
      "readyItemCount",
      "cancellableItemReferences",
      "refund",
      "cancelsAt",
    ]);
    const batch = reference(round.orderBatchReference);
    if (seen.has(batch)) return fail();
    seen.add(batch);
    const state = tableCloseRoundStates.includes(round.state as TableCloseRoundState)
      ? (round.state as TableCloseRoundState)
      : fail();
    let refund: null | { method: "Online" | "CardMachine"; amountMinor: string } = null;
    if (round.refund !== null) {
      const r = exact(round.refund, ["method", "amountMinor"]);
      if (r.method !== "Online" && r.method !== "CardMachine") return fail();
      refund = Object.freeze({ method: r.method, amountMinor: amount(r.amountMinor) });
    }
    if (!Array.isArray(round.cancellableItemReferences)) return fail();
    const cancellable = round.cancellableItemReferences.map(reference);
    const needsRefund = ["PaidNotSent", "AlreadyRefunded", "NotStarted", "RefundOnCardMachine"];
    if (
      needsRefund.includes(state) !== (refund !== null) ||
      (state === "PartlyStarted") !== cancellable.length > 0
    )
      return fail();
    const openItemCount = count(round.openItemCount),
      startedItemCount = count(round.startedItemCount),
      readyItemCount = count(round.readyItemCount);
    if (startedItemCount > openItemCount || readyItemCount > startedItemCount) return fail();
    return Object.freeze({
      orderBatchReference: batch,
      sequence: count(round.sequence, 2147483647),
      state,
      openItemCount,
      startedItemCount,
      readyItemCount,
      cancellableItemReferences: Object.freeze(cancellable),
      refund,
      cancelsAt: round.cancelsAt === null ? null : instant(round.cancelsAt),
    });
  });
  const totals = exact(raw.totals, ["onlineMinor", "cardMachineMinor"]);
  if (!Array.isArray(raw.closeBlockers) || raw.closeBlockers.length > 32) return fail();
  const closeBlockers = raw.closeBlockers.map((code: unknown) =>
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : fail(),
  );
  return Object.freeze({
    orderReference: expected.order,
    diningSessionReference: expected.session,
    orderVersion,
    observedAt: instant(raw.observedAt),
    rounds: Object.freeze(rounds),
    totals: Object.freeze({
      onlineMinor: amount(totals.onlineMinor),
      cardMachineMinor: amount(totals.cardMachineMinor),
    }),
    /** WP-2423 (B759): what still stops the Order closing (server codes; empty: it can close). */
    closeBlockers: Object.freeze(closeBlockers),
  });
}
export type TableClosePlan = ReturnType<typeof parseTableClosePlan>;
export type TableCloseRound = TableClosePlan["rounds"][number];

/** A round the confirmation resolves with a staff cancellation (whole round or its lines). */
export const resolvesOnConfirm = (round: TableCloseRound) =>
  // WP-2423 abandoned payment: an unpaid round (never paid, or paying never finished) is cancelled
  // with the unpaid round cancellation; nothing is refunded.
  round.state === "NotPaid" ||
  round.state === "PaymentInProgress" ||
  round.state === "PaidNotSent" ||
  round.state === "AlreadyRefunded" ||
  round.state === "NotStarted" ||
  round.state === "PartlyStarted";

async function post(
  fetcher: typeof fetch,
  path: string,
  csrf: string,
  body: unknown,
  signal?: AbortSignal,
) {
  return fetcher(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-BOP-CSRF": csrf,
    },
    body: JSON.stringify(body),
  });
}
async function errorCode(response: Response) {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/** One round's cancellation; one operation per intent so an unknown result is retried safely. */
export type RoundResolutionOutcome =
  "Done" | "Changed" | "Refused" | "Denied" | "FullSignInRequired" | "Unknown";

export function createTableClosePlanClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    async load(
      input: { orderReference: string; diningSessionReference: string },
      csrf: string,
      signal?: AbortSignal,
    ) {
      reference(input.orderReference);
      reference(input.diningSessionReference);
      let response: Response;
      try {
        response = await post(fetcher, "/merchant/dining/table-close-plan", csrf, input, signal);
      } catch {
        return fail();
      }
      if (response.status === 401 || response.status === 403)
        throw new TableClosePlanError("PermissionDenied");
      if (response.status === 404) throw new TableClosePlanError("NotFound");
      if (!response.ok) return fail();
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return fail();
      }
      return parseTableClosePlan(body, {
        order: input.orderReference,
        session: input.diningSessionReference,
      });
    },
    /**
     * Cancel one round (or its lines not started) with the reason "Guests left". The server checks
     * permission, eligibility, the kitchen and the refund again; the same operation is resent after
     * an unknown result.
     */
    async resolve(
      plan: Pick<TableClosePlan, "orderReference" | "orderVersion">,
      round: TableCloseRound,
      operationReference: string,
      csrf: string,
    ): Promise<RoundResolutionOutcome> {
      if (!resolvesOnConfirm(round)) return "Refused";
      const items = round.state === "PartlyStarted";
      const unpaid = round.state === "NotPaid" || round.state === "PaymentInProgress";
      let response: Response;
      try {
        response = unpaid
          ? await post(fetcher, "/merchant/orders/cancel-unpaid-round", csrf, {
              orderReference: plan.orderReference,
              orderBatchReference: round.orderBatchReference,
              operationReference,
            })
          : await post(
              fetcher,
              items ? "/merchant/orders/cancel-items" : "/merchant/orders/cancel",
              csrf,
              {
                orderReference: plan.orderReference,
                orderBatchReference: round.orderBatchReference,
                ...(items ? { orderItemReferences: [...round.cancellableItemReferences] } : {}),
                expectedOrderVersion: plan.orderVersion,
                operationReference,
                reasonCode: "GUEST_LEFT",
              },
            );
      } catch {
        return "Unknown";
      }
      if (response.ok) return "Done";
      const code = await errorCode(response);
      if (code === "full_sign_in_required") return "FullSignInRequired";
      if (response.status === 401 || response.status === 403) return "Denied";
      if (response.status === 409 && code === "order_version_conflict") return "Changed";
      // The guest's payment went through, or is still being confirmed: re-read the plan.
      if (
        response.status === 409 &&
        (code === "unpaid_round_paid" || code === "unpaid_round_payment_in_progress")
      )
        return "Changed";
      if (response.status === 409 || response.status === 400 || response.status === 404)
        return "Refused";
      return "Unknown";
    },
    /** What cancelling a round's lines not started refunds (the item cancellation's own preview). */
    async previewItems(
      plan: Pick<TableClosePlan, "orderReference" | "orderVersion">,
      round: TableCloseRound,
      csrf: string,
    ): Promise<string | null> {
      if (round.state !== "PartlyStarted") return null;
      try {
        const response = await post(fetcher, "/merchant/orders/cancel-items/preview", csrf, {
          orderReference: plan.orderReference,
          orderBatchReference: round.orderBatchReference,
          orderItemReferences: [...round.cancellableItemReferences],
          expectedOrderVersion: plan.orderVersion,
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { refund?: { amountMinor?: unknown } } | null;
        const value = body?.refund?.amountMinor;
        return typeof value === "string" && minor.test(value) ? value : null;
      } catch {
        return null;
      }
    },
    newOperation: () => serviceOperationReference(),
  });
}
