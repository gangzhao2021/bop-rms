import { needsFullSignIn } from "./full-sign-in.js";
import { OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import {
  OrdinaryRefundExecutionError,
  type RefundReconciliationCommand,
  type RefundSendCommand,
} from "./ordinary-refund-execution-client.js";
import {
  OrdinaryRefundPreparationClientError,
  type OrdinaryRefundPreparationCommand,
} from "./ordinary-refund-preparation-client.js";

/**
 * WP-2423 item 6: one staff confirmation runs an online refund that needs no approval from start
 * to finish — record the request, prepare each payment's refund, send it to the card provider,
 * then check its answer — over the existing owner commands. Every command keeps the references
 * it was first given, so a retry after any failure resumes at the step reached and the server
 * replays (never repeats) what already happened. A refund that needs an owner's approval stops
 * after the request: the approval sends it. A card-machine refund stops after the request too:
 * staff refund it on the machine and record that.
 */
export type RefundRunStep = "Request" | "Prepare" | "Send" | "Check";

/** What the recorded request says (the existing request command's confirmed result). */
export interface RefundRunRequest {
  readonly requestReference: string;
  readonly operationReference: string;
  readonly paymentAttemptReferences: readonly string[];
  readonly approvalRequired: boolean | null;
}

/** One payment's refund leg: its stable command references and how far it got. */
interface Leg {
  readonly paymentAttemptReference: string;
  readonly approvalReference: string | null;
  readonly operationReference: string;
  readonly prepareAuditReference: string;
  readonly dispatchReference: string;
  readonly dispatchAuditReference: string;
  readonly observationReference: string;
  readonly observationAuditReference: string;
  prepared: boolean;
  sent: boolean;
  checked: boolean;
}

export interface RefundRunPorts<R extends RefundRunRequest> {
  /** Record the request (absent when it is already recorded). Retried with the same command. */
  readonly request?: (signal: AbortSignal) => Promise<R>;
  readonly prepare: (
    command: OrdinaryRefundPreparationCommand,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly send: (command: RefundSendCommand, signal: AbortSignal) => Promise<unknown>;
  readonly check: (command: RefundReconciliationCommand, signal: AbortSignal) => Promise<unknown>;
  /** The request's current payment states (the request status read). */
  readonly status: (
    requestOperationReference: string,
    signal: AbortSignal,
  ) => Promise<readonly { readonly paymentAttemptReference: string; readonly state: string }[]>;
}

export type RefundRunOutcome<R extends RefundRunRequest> =
  | { readonly kind: "AwaitingApproval"; readonly request: R | null }
  | { readonly kind: "RecordedOnly"; readonly request: R | null }
  | { readonly kind: "Refunded"; readonly request: R | null }
  | { readonly kind: "WaitingForAnswer"; readonly request: R | null };

export class RefundRunError extends Error {
  constructor(
    readonly step: RefundRunStep,
    override readonly cause: unknown,
  ) {
    super("Refund step did not finish");
    this.name = "RefundRunError";
  }
}

export interface RefundRunOptions<R extends RefundRunRequest> {
  readonly orderReference: string;
  readonly newReference: () => string;
  readonly ports: RefundRunPorts<R>;
  /** False for a card-machine refund: it is refunded on the machine, never sent from here. */
  readonly sendAfterRequest: boolean;
  /** A request recorded earlier, with the payments still to send (skips the Request step). */
  readonly recorded?: {
    readonly requestReference: string;
    readonly operationReference: string;
    readonly legs: readonly {
      readonly paymentAttemptReference: string;
      /** The prepared operation, when the leg was already prepared (null: prepare it). */
      readonly preparedOperationReference: string | null;
      readonly approvalReference: string | null;
    }[];
  };
}

export function createRefundRun<R extends RefundRunRequest>(options: RefundRunOptions<R>) {
  const { orderReference, newReference, ports } = options;
  let request: R | null = null;
  let requestReference = options.recorded?.requestReference ?? null;
  let requestOperationReference = options.recorded?.operationReference ?? null;
  let stopAfterRequest: "AwaitingApproval" | "RecordedOnly" | null = null;
  let legs: Leg[] | null = null;
  let finished: RefundRunOutcome<R> | null = null;
  let running = false;
  // A send was attempted: from here the card provider may have the refund.
  let sendAttempted = false;
  const leg = (
    paymentAttemptReference: string,
    approvalReference: string | null,
    preparedOperationReference: string | null,
  ): Leg => ({
    paymentAttemptReference,
    approvalReference,
    operationReference: preparedOperationReference ?? newReference(),
    prepareAuditReference: newReference(),
    dispatchReference: newReference(),
    dispatchAuditReference: newReference(),
    observationReference: newReference(),
    observationAuditReference: newReference(),
    prepared: preparedOperationReference !== null,
    sent: false,
    checked: false,
  });
  if (options.recorded)
    legs = options.recorded.legs.map((value) =>
      leg(value.paymentAttemptReference, value.approvalReference, value.preparedOperationReference),
    );
  const requestPort = ports.request;
  if (!options.recorded && !requestPort) throw new Error("REFUND_RUN_REQUEST_MISSING");
  const step = async <T>(name: RefundRunStep, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new RefundRunError(name, error);
    }
  };
  /** Where a retry would resume (null: nothing is left to do). */
  const resumeStep = (): RefundRunStep | null => {
    if (finished) return null;
    if (legs === null) return "Request";
    if (legs.some((value) => !value.prepared)) return "Prepare";
    if (legs.some((value) => !value.sent)) return "Send";
    return "Check";
  };
  return Object.freeze({
    resumeStep,
    /** True once a send was attempted: the card provider may have this refund. */
    get mayHaveSent() {
      return sendAttempted;
    },
    get requestReference() {
      return requestReference;
    },
    async run(
      signal: AbortSignal,
      onStep: (step: RefundRunStep) => void = () => undefined,
    ): Promise<RefundRunOutcome<R>> {
      if (finished) return finished;
      if (running) throw new Error("REFUND_RUN_BUSY");
      running = true;
      try {
        if (legs === null) {
          if (!requestPort) throw new Error("REFUND_RUN_REQUEST_MISSING");
          onStep("Request");
          const recorded = await step("Request", () => requestPort(signal));
          request = recorded;
          requestReference = recorded.requestReference;
          requestOperationReference = recorded.operationReference;
          stopAfterRequest =
            recorded.approvalRequired === true
              ? "AwaitingApproval"
              : options.sendAfterRequest
                ? null
                : "RecordedOnly";
          legs = recorded.paymentAttemptReferences.map((reference) => leg(reference, null, null));
        }
        if (stopAfterRequest) return (finished = { kind: stopAfterRequest, request });
        const currentRequest = requestReference,
          currentOperation = requestOperationReference;
        if (currentRequest === null || currentOperation === null)
          throw new Error("REFUND_RUN_REQUEST_MISSING");
        for (const value of legs) {
          if (value.prepared) continue;
          onStep("Prepare");
          await step("Prepare", () =>
            ports.prepare(
              {
                orderReference,
                requestReference: currentRequest,
                paymentAttemptReference: value.paymentAttemptReference,
                operationReference: value.operationReference,
                auditReference: value.prepareAuditReference,
                approvalReference: value.approvalReference,
              },
              signal,
            ),
          );
          value.prepared = true;
        }
        for (const value of legs) {
          if (value.sent) continue;
          onStep("Send");
          sendAttempted = true;
          await step("Send", () =>
            ports.send(
              {
                operationReference: value.operationReference,
                orderReference,
                requestReference: currentRequest,
                dispatchReference: value.dispatchReference,
                auditReference: value.dispatchAuditReference,
                approvalReference: value.approvalReference,
              },
              signal,
            ),
          );
          value.sent = true;
        }
        onStep("Check");
        for (const value of legs) {
          if (value.checked) continue;
          await step("Check", () =>
            ports.check(
              {
                orderReference,
                operationReference: value.operationReference,
                observationReference: value.observationReference,
                auditReference: value.observationAuditReference,
              },
              signal,
            ),
          );
          value.checked = true;
        }
        const states = await step("Check", () => ports.status(currentOperation, signal));
        const ours = new Set(legs.map((value) => value.paymentAttemptReference));
        const relevant = states.filter((value) => ours.has(value.paymentAttemptReference));
        const refunded =
          relevant.length === ours.size && relevant.every((value) => value.state === "Confirmed");
        // The answer may still come later: the run is finished either way (nothing more to send).
        return (finished = { kind: refunded ? "Refunded" : "WaitingForAnswer", request });
      } finally {
        running = false;
      }
    },
  });
}
export type RefundRun<R extends RefundRunRequest> = ReturnType<typeof createRefundRun<R>>;

/** What staff see while a step runs. */
export function refundRunProgressText(step: RefundRunStep): string {
  return step === "Request" || step === "Prepare"
    ? "Recording refund…"
    : step === "Send"
      ? "Sending to the card provider…"
      : "Checking the card provider's answer…";
}

/** The retry button for a run that stopped at this step. */
export function refundRunRetryLabel(step: RefundRunStep): string {
  return step === "Request"
    ? "Retry same refund request"
    : step === "Check"
      ? "Check the card provider's answer again"
      : "Continue sending this refund";
}

/** Whether the failed step may have had an effect the server has not confirmed. */
export function refundRunUncertain(error: RefundRunError): boolean {
  const cause = error.cause;
  if (needsFullSignIn(cause)) return false;
  if (cause instanceof OrdinaryRefundClientError) return cause.code === "OutcomeUnknown";
  if (cause instanceof OrdinaryRefundPreparationClientError) return cause.code === "OutcomeUnknown";
  if (cause instanceof OrdinaryRefundExecutionError) return cause.code === "OutcomeUnknown";
  return true;
}

/**
 * What happened when a step after the request did not finish, in staff language. The request
 * step keeps the wizard's own messages (its form is still on screen).
 */
export function refundRunFailureText(error: RefundRunError): string {
  const cause = error.cause;
  if (needsFullSignIn(cause))
    return error.step === "Check"
      ? "The refund was sent. Confirm your sign-in, then check the card provider's answer again."
      : "Confirm your sign-in, then continue sending this refund. Nothing was sent twice.";
  const uncertain = refundRunUncertain(error);
  const code =
    cause instanceof OrdinaryRefundPreparationClientError ||
    cause instanceof OrdinaryRefundExecutionError ||
    cause instanceof OrdinaryRefundClientError
      ? cause.code
      : "OutcomeUnknown";
  if (error.step === "Check")
    return "The refund was sent to the card provider, but its answer could not be checked yet. The amount stays set aside until it answers. Check again.";
  if (error.step === "Prepare")
    return uncertain
      ? "The refund request is recorded, but getting it ready to send was not confirmed. Nothing has been sent to the card provider. Continue sending this refund: it is never sent twice."
      : code === "PermissionDenied" || code === "Denied"
        ? "The refund request is recorded but was not sent: your permissions do not allow sending refunds, or this refund needs an owner's approval. Ask a manager to check it."
        : code === "Conflict"
          ? "The refund request is recorded but was not sent: it changed on another screen. Check the request's status below before sending."
          : "The refund request is recorded but was not sent: sending refunds is not set up for this store. Contact the pilot operator.";
  if (error.step === "Send")
    return uncertain
      ? "It is not confirmed that the card provider received this refund. Continue sending this refund: the same refund is reused and the customer is never refunded twice."
      : code === "PermissionDenied" || code === "Denied"
        ? "The refund was not sent: your session or permissions no longer allow sending refunds. Sign in again, then continue."
        : "The refund was not sent: sending refunds is not set up for this store. Contact the pilot operator.";
  return uncertain
    ? "The refund request result is unknown. Retry the same request; do not start another refund."
    : "The refund request was not recorded.";
}
