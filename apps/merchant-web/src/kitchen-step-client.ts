import { t } from "./i18n/i18n.js";
import { parseKitchenRouteReference } from "./kitchen-board.js";

/**
 * DEC-KITCHEN-ONE-TAP: one tap on the kitchen board as one immutable body. The body names what the
 * cook tapped and no versions: the server follows current state, so sending the same body again
 * (a lost answer, a busy server) records nothing twice.
 */
export type KitchenStepKind = "Start" | "Finish";
export type KitchenStepOutcome =
  | "Started"
  | "AlreadyStarted"
  | "Finished"
  | "AlreadyFinished"
  | "DishDone"
  | "Refused"
  | "NotAttempted";
export type KitchenStepRefusal =
  "Cancelled" | "Closed" | "Held" | "Blocked" | "NotFound" | "OrderChanged";
export interface KitchenStepLineInput {
  readonly ticketReference: string;
  readonly workItemReference: string;
  readonly orderItemReference: string;
  /** A combo's chosen dishes this tap finishes; null: the whole work item. */
  readonly optionReferences: readonly string[] | null;
}
export interface KitchenStepLineResult {
  readonly workItemReference: string;
  readonly orderItemReference: string;
  readonly ticketReference: string;
  readonly outcome: KitchenStepOutcome;
  readonly refusedReason: KitchenStepRefusal | null;
  readonly ticketVersion: string | null;
  readonly workItemVersion: string | null;
  readonly workItemStatus: "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled" | null;
  readonly completedQuantity: number | null;
  readonly requiredQuantity: number | null;
  readonly acceptedAt: string | null;
  readonly readyAt: string | null;
  readonly dishesDone: readonly string[] | null;
}
export interface KitchenStepReply {
  readonly occurredAt: string;
  readonly lines: readonly KitchenStepLineResult[];
}
/** One tap's lines in one body (the server's own limit). */
export const kitchenStepMaxLines = 50;
const replyMaxLength = 131_072;

export class KitchenStepClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      /** The body itself was refused; sending it again cannot help. */
      | "Invalid"
      /** The server was busy or the tablet saw a changing ticket; nothing was recorded. */
      | "Busy"
      /** The answer was lost: it may or may not have been recorded. */
      | "OutcomeUnknown",
  ) {
    super(t("Kitchen action could not be confirmed"));
    this.name = "KitchenStepClientError";
  }
}
const fail = (code: KitchenStepClientError["code"]): never => {
  throw new KitchenStepClientError(code);
};
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION = /^[1-9][0-9]{0,18}$/u;
const instantOrNull = (value: unknown) =>
  value === null || (typeof value === "string" && INSTANT.test(value));
const versionOrNull = (value: unknown) =>
  value === null || (typeof value === "string" && VERSION.test(value));
const quantityOrNull = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

function parseLine(raw: unknown, sent: KitchenStepLineInput): KitchenStepLineResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("OutcomeUnknown");
  const line = raw as Record<string, unknown>;
  if (
    line.workItemReference !== sent.workItemReference ||
    line.orderItemReference !== sent.orderItemReference ||
    line.ticketReference !== sent.ticketReference ||
    ![
      "Started",
      "AlreadyStarted",
      "Finished",
      "AlreadyFinished",
      "DishDone",
      "Refused",
      "NotAttempted",
    ].includes(String(line.outcome)) ||
    (line.refusedReason !== null &&
      !["Cancelled", "Closed", "Held", "Blocked", "NotFound", "OrderChanged"].includes(
        String(line.refusedReason),
      )) ||
    !versionOrNull(line.ticketVersion) ||
    !versionOrNull(line.workItemVersion) ||
    (line.workItemStatus !== null &&
      !["Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(
        String(line.workItemStatus),
      )) ||
    !quantityOrNull(line.completedQuantity) ||
    !quantityOrNull(line.requiredQuantity) ||
    !instantOrNull(line.acceptedAt) ||
    !instantOrNull(line.readyAt) ||
    (line.dishesDone !== null &&
      (!Array.isArray(line.dishesDone) ||
        line.dishesDone.some((option) => typeof option !== "string")))
  )
    return fail("OutcomeUnknown");
  return Object.freeze({
    workItemReference: sent.workItemReference,
    orderItemReference: sent.orderItemReference,
    ticketReference: sent.ticketReference,
    outcome: line.outcome as KitchenStepOutcome,
    refusedReason: line.refusedReason as KitchenStepRefusal | null,
    ticketVersion: line.ticketVersion as string | null,
    workItemVersion: line.workItemVersion as string | null,
    workItemStatus: line.workItemStatus as KitchenStepLineResult["workItemStatus"],
    completedQuantity: line.completedQuantity as number | null,
    requiredQuantity: line.requiredQuantity as number | null,
    acceptedAt: line.acceptedAt as string | null,
    readyAt: line.readyAt as string | null,
    dishesDone: line.dishesDone as readonly string[] | null,
  });
}

export function prepareKitchenStep(
  input: {
    readonly step: KitchenStepKind;
    readonly storeReference: string;
    readonly correlationReference: string;
    readonly lines: readonly (KitchenStepLineInput & { readonly idempotencyKey: string })[];
  },
  fetcher: typeof fetch = fetch,
) {
  if (input.lines.length < 1 || input.lines.length > kitchenStepMaxLines) return fail("Invalid");
  const lines = input.lines.map((line) => ({
    idempotencyKey: parseKitchenRouteReference(line.idempotencyKey),
    ticketReference: parseKitchenRouteReference(line.ticketReference),
    workItemReference: parseKitchenRouteReference(line.workItemReference),
    orderItemReference: parseKitchenRouteReference(line.orderItemReference),
    optionReferences:
      line.optionReferences === null
        ? null
        : line.optionReferences.map((option) => parseKitchenRouteReference(option)),
  }));
  const body = JSON.stringify({
    step: input.step,
    storeReference: parseKitchenRouteReference(input.storeReference),
    correlationReference: parseKitchenRouteReference(input.correlationReference),
    lines,
  });
  return Object.freeze({
    body,
    async execute(csrf: string, signal?: AbortSignal): Promise<KitchenStepReply> {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted) return fail("Invalid");
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 30_000);
      try {
        const response = await fetcher("/merchant/kitchen/step", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": csrf,
          },
          body,
        });
        if (controller.signal.aborted) return fail("OutcomeUnknown");
        if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
        // A closed refusal of this body: sending the same bytes again cannot help.
        if (response.status === 400 || response.status === 404 || response.status === 413)
          return fail("Invalid");
        // Nothing was recorded; each step follows current state, so the same body is safe again.
        if (response.status === 409 || response.status === 422 || response.status === 503)
          return fail("Busy");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.startsWith("application/json")
        )
          return fail("OutcomeUnknown");
        const text = await response.text();
        if (text.length > replyMaxLength) return fail("OutcomeUnknown");
        const reply = JSON.parse(text) as Record<string, unknown> | null;
        if (
          reply === null ||
          typeof reply !== "object" ||
          reply.projectionName !== "kitchen_work_queue_v1" ||
          reply.projectionPending !== true ||
          typeof reply.occurredAt !== "string" ||
          !INSTANT.test(reply.occurredAt) ||
          !Array.isArray(reply.lines) ||
          reply.lines.length !== lines.length
        )
          return fail("OutcomeUnknown");
        return Object.freeze({
          occurredAt: reply.occurredAt,
          lines: Object.freeze(
            lines.map((line, index) =>
              parseLine((reply.lines as unknown[])[index], line as KitchenStepLineInput),
            ),
          ),
        });
      } catch (error) {
        if (error instanceof KitchenStepClientError) throw error;
        return fail("OutcomeUnknown");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
