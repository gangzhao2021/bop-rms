import { roundCashTotal } from "@rms/payment";
import {
  CardMachinePaymentCommandError,
  parseCardMachinePaymentCommand,
  type CardMachinePaymentCommandErrorCode,
  type CardMachinePaymentResult,
} from "./merchant-card-machine-payment.js";

/**
 * WP-2423 (DEC-PAPER-ORDER-PAID-AT-SEND): a paper order taken during an outage was already paid
 * then (on the card machine or in cash). It is a sale that happened, so it is never left as an
 * order "to charge" that its payment window could release: the counter (or table) send carries how
 * it was paid, and the server records that payment with the order in the same request. The order
 * command itself is unchanged (a retry of the same order operation returns the same order), and the
 * payment is its own operation (a retry records it once).
 */
export interface PaperOrderPayment {
  readonly operationReference: string;
  readonly tender: "CardMachine" | "Cash";
  readonly slipReference: string | null;
  readonly takenAt: string;
  /**
   * DEC-PAPER-SEND-IDEMPOTENT (b11 review): staff confirmed that this slip, already recorded with
   * another order, also paid this one or is another slip with the same reference. Null otherwise.
   */
  readonly slipConfirmation: "SameSlipAlsoPaysThisOrder" | "DifferentSlipSameReference" | null;
}

/** The HTTP error code of each card-machine payment refusal (shared with its own route). */
export const cardMachinePaymentHttpErrors: Readonly<
  Record<CardMachinePaymentCommandErrorCode, readonly [number, string]>
> = Object.freeze({
  CARD_MACHINE_INPUT_INVALID: [400, "card_machine_input_invalid"],
  CARD_MACHINE_PERMISSION_DENIED: [403, "card_machine_permission_denied"],
  CARD_MACHINE_NOT_FOUND: [404, "counter_order_not_found"],
  CARD_MACHINE_NOT_PAYABLE: [409, "order_not_payable"],
  CARD_MACHINE_AMOUNT_CHANGED: [409, "amount_changed"],
  CARD_MACHINE_PAYMENT_WINDOW_CLOSED: [409, "payment_window_closed"],
  CARD_MACHINE_ALREADY_PAID: [409, "already_paid"],
  CARD_MACHINE_IDEMPOTENCY_CONFLICT: [409, "card_machine_conflict"],
  CARD_MACHINE_TAKEN_BEFORE_RECORDS: [409, "taken_before_records"],
  CARD_MACHINE_CASH_TENDER_SHORT: [409, "cash_tender_short"],
  CARD_MACHINE_SLIP_ALREADY_RECORDED: [409, "slip_already_recorded"],
  CARD_MACHINE_UNAVAILABLE: [503, "card_machine_payment_unavailable"],
} as const);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Splits the paper payment off a counter order or table round body. Null when the body is not
 * valid for it: a paper order (`recordedAfterOutage: true`) must say how it was paid, and only a
 * paper order may. `cashAllowed` is false for a table round (a table's cash is taken at checkout).
 * `required` is false for a table round too: a table that pays at the end has nothing to pay now
 * (the server decides), so its paper round may come without one.
 */
export function splitPaperOrderPayment(
  body: unknown,
  options: { readonly cashAllowed: boolean; readonly required: boolean },
): { readonly command: unknown; readonly payment: PaperOrderPayment | null } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { command: body, payment: null };
  const { paperPayment, ...command } = body as Record<string, unknown>;
  const paper = (body as Record<string, unknown>).recordedAfterOutage === true;
  if (paperPayment === undefined)
    return paper && options.required ? null : { command: body, payment: null };
  if (!paper) return null;
  if (paperPayment === null || typeof paperPayment !== "object" || Array.isArray(paperPayment))
    return null;
  const raw = paperPayment as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  const confirmed = keys === "operationReference,slipConfirmation,slipReference,takenAt,tender";
  if (keys !== "operationReference,slipReference,takenAt,tender" && !confirmed) return null;
  if (raw.tender !== "CardMachine" && (raw.tender !== "Cash" || !options.cashAllowed)) return null;
  if (typeof raw.operationReference !== "string" || !uuid.test(raw.operationReference)) return null;
  if (raw.tender === "Cash" && raw.slipReference !== null) return null;
  // The same checks the payment record makes (slip shape, an instant), before anything is placed.
  try {
    parseCardMachinePaymentCommand({
      operationReference: raw.operationReference,
      orderReference: raw.operationReference,
      orderBatchReference: raw.operationReference,
      expectedTotalMinor: "1",
      slipReference: raw.slipReference,
      takenAt: raw.takenAt,
      ...(confirmed && raw.tender === "CardMachine"
        ? { slipConfirmation: raw.slipConfirmation }
        : {}),
    });
  } catch {
    return null;
  }
  if (confirmed && raw.tender !== "CardMachine") return null;
  if (typeof raw.takenAt !== "string") return null;
  return {
    command,
    payment: Object.freeze({
      operationReference: raw.operationReference,
      tender: raw.tender,
      slipReference: raw.slipReference as string | null,
      takenAt: raw.takenAt,
      slipConfirmation: confirmed
        ? (raw.slipConfirmation as NonNullable<PaperOrderPayment["slipConfirmation"]>)
        : null,
    }),
  };
}

/** The card-machine payment command for the paper order just placed: its server total, as paid. */
export function paperOrderPaymentCommand(
  placed: {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly totalMinor: string;
  },
  payment: PaperOrderPayment,
) {
  return {
    operationReference: payment.operationReference,
    orderReference: placed.orderReference,
    orderBatchReference: placed.orderBatchReference,
    expectedTotalMinor: placed.totalMinor,
    slipReference: payment.tender === "Cash" ? null : payment.slipReference,
    takenAt: payment.takenAt,
    ...(payment.slipConfirmation === null || payment.tender === "Cash"
      ? {}
      : { slipConfirmation: payment.slipConfirmation }),
    // Paid in cash during the outage: the cash total was taken and any change given then.
    ...(payment.tender === "Cash"
      ? { tenderedMinor: roundCashTotal(BigInt(placed.totalMinor)).roundedMinor.toString() }
      : {}),
  };
}

export type PaperOrderPaymentAnswer =
  | {
      readonly payment: {
        readonly status: CardMachinePaymentResult["status"];
        readonly amountMinor: string;
        readonly recordingReason: CardMachinePaymentResult["recordingReason"];
        readonly takenAt: string;
        readonly recordedAt: string;
        readonly cash?: NonNullable<CardMachinePaymentResult["cash"]>;
        readonly acceptance: "Accepted" | "NotAccepted";
      };
    }
  | {
      readonly paymentError: string;
      readonly paymentTotalMinor?: string;
      /** slip_already_recorded: the order the slip is recorded with. */
      readonly paymentSlipOrderNumber?: string;
    };

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: how long the send waits before recording a paper payment again
 * after the system failed to (a brief database hiccup), in the same request. The same payment
 * operation is sent each time, so it is recorded once.
 */
export const paperPaymentRetryDelaysMs: readonly number[] = Object.freeze([300, 1_200]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Records the paper order's payment with the order. The order is placed either way, so a refusal
 * or failure here is part of the answer (the page then shows the payment step to record it again),
 * never an error of the order. A failure of the system itself (not a refusal) is tried again
 * twice in the same request before it is answered, so a brief outage rarely leaves a placed paper
 * sale without its payment.
 */
export async function recordPaperOrderPayment(
  record: (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }) => Promise<CardMachinePaymentResult & { readonly acceptance?: "Accepted" | "NotAccepted" }>,
  auth: { sessionCookie: unknown; csrf: unknown },
  placed: {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly totalMinor: string;
  },
  payment: PaperOrderPayment,
  onUnexpected?: (error: unknown) => void,
  retry: { readonly delaysMs: readonly number[]; wait(ms: number): Promise<void> } = {
    delaysMs: paperPaymentRetryDelaysMs,
    wait: sleep,
  },
): Promise<PaperOrderPaymentAnswer> {
  const command = paperOrderPaymentCommand(placed, payment);
  const failedOnly = (error: unknown) =>
    !(error instanceof CardMachinePaymentCommandError) || error.code === "CARD_MACHINE_UNAVAILABLE";
  const attempt = async (index: number): Promise<Awaited<ReturnType<typeof record>>> => {
    try {
      return await record({ ...auth, command });
    } catch (error) {
      const delay = retry.delaysMs[index];
      if (delay === undefined || !failedOnly(error)) throw error;
      await retry.wait(delay);
      return attempt(index + 1);
    }
  };
  try {
    const result = await attempt(0);
    return {
      payment: {
        status: result.status,
        amountMinor: result.amountMinor,
        recordingReason: result.recordingReason,
        takenAt: result.takenAt,
        recordedAt: result.recordedAt,
        ...(result.cash == null ? {} : { cash: result.cash }),
        acceptance: result.acceptance ?? "NotAccepted",
      },
    };
  } catch (error) {
    if (error instanceof CardMachinePaymentCommandError) {
      const [, code] = cardMachinePaymentHttpErrors[error.code];
      if (error.code === "CARD_MACHINE_SLIP_ALREADY_RECORDED" && error.slipOrderNumber !== null)
        return { paymentError: code, paymentSlipOrderNumber: error.slipOrderNumber };
      return error.code === "CARD_MACHINE_AMOUNT_CHANGED" && error.totalMinor !== null
        ? { paymentError: code, paymentTotalMinor: error.totalMinor }
        : { paymentError: code };
    }
    try {
      onUnexpected?.(error);
    } catch {
      // Reporting never changes the answer.
    }
    return { paymentError: "card_machine_payment_unavailable" };
  }
}

/**
 * The answer to a paper order whose paid-at time was refused before it was placed (nothing was
 * placed or recorded), or null when the error is not that check's. `route` names the order route
 * (its permission and outage codes). A time after the server's now (a device clock ahead) or
 * outside the back-entry window, and a time before the Store's records begin, are refusals staff
 * correct in the paid-at field; an outage of the check is the route's own "unavailable" (send
 * again), never a refusal of the person.
 */
export function paperPaidAtRefusalBody(error: unknown, code: string): Record<string, string> {
  return error instanceof CardMachinePaymentCommandError &&
    error.code === "CARD_MACHINE_SLIP_ALREADY_RECORDED" &&
    error.slipOrderNumber !== null
    ? { error: code, orderNumber: error.slipOrderNumber }
    : { error: code };
}

export function paperPaidAtRefusal(
  error: unknown,
  route: "counter_order" | "staff_round",
): readonly [number, string] | null {
  if (!(error instanceof CardMachinePaymentCommandError)) return null;
  switch (error.code) {
    case "CARD_MACHINE_TAKEN_BEFORE_RECORDS":
      return [409, "taken_before_records"];
    // DEC-PAPER-SEND-IDEMPOTENT (b11): the slip is recorded with another paper order already.
    case "CARD_MACHINE_SLIP_ALREADY_RECORDED":
      return [409, "slip_already_recorded"];
    case "CARD_MACHINE_INPUT_INVALID":
      return [409, "paper_paid_at_out_of_range"];
    case "CARD_MACHINE_PERMISSION_DENIED":
      return [403, route + "_permission_denied"];
    default:
      return [503, route + "_unavailable"];
  }
}
