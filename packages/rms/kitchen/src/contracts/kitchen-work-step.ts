import {
  KitchenWorkLifecycleError,
  kitchenWorkLifecycleProjectionName,
} from "./kitchen-work-lifecycle.js";

/**
 * DEC-KITCHEN-ONE-TAP: what one tap on the kitchen board asks for. The browser sends no expected
 * versions: each step follows the current state under the ticket's row lock, so a retry of the same
 * body records nothing twice and two screens on one ticket never get a conflict. Accept, Start and
 * Complete stay real recorded operations of the operator who tapped.
 */
export const kitchenWorkStepKinds = ["Start", "Finish"] as const;
export type KitchenWorkStepKind = (typeof kitchenWorkStepKinds)[number];

/** A tap's lines: at most this many in one body (the browser splits a larger set). */
export const kitchenWorkStepMaxLines = 50;
/**
 * The server records at most this many lines of one ticket in one transaction: the Store-wide audit
 * chain head stays locked from the first recorded fact to the commit, and every other Store command
 * (payments, acceptance, serving, other tablets) waits behind it with a two second lock timeout.
 * Measured in kitchen-work-step-acceptance: a chunk of 8 from Queued holds it well under 500 ms.
 */
export const kitchenWorkStepChunkLines = 8;
/**
 * DEC-KITCHEN-ONE-TAP: what the live board carries. Every unfinished ticket up to this limit, oldest
 * first (the board says when more wait); finished tickets newest first within these bounds, for
 * Recently finished and Remake. A finished ticket beyond them is no longer offered a Remake on the
 * board, although its 12-hour window may still run: a remake is asked for within minutes.
 */
export const kitchenBoardOpenTicketLimit = 100;
export const kitchenBoardFinishedTickets = 60;
export const kitchenBoardFinishedDishes = 100;
/** A chosen-dish list on one line (the kitchen read's own limit for one combo). */
export const kitchenWorkStepMaxOptions = 20;

export type KitchenWorkStepOutcome =
  | "Started"
  | "AlreadyStarted"
  | "Finished"
  | "AlreadyFinished"
  /** Some chosen dishes of a combo are done; the combo still waits for the others. */
  | "DishDone"
  | "Refused"
  /** An earlier chunk of this tap failed; the same body resumes safely. */
  | "NotAttempted";
export type KitchenWorkStepRefusal =
  | "Cancelled"
  | "Closed"
  | "Held"
  /** The Start admission (allergen check) blocks it: make sure before cooking. */
  | "Blocked"
  | "NotFound"
  /** The Order moved on since this work was issued (the issued source no longer holds). */
  | "OrderChanged";

export interface KitchenWorkStepLine {
  readonly idempotencyKey: string;
  readonly ticketReference: string;
  readonly workItemReference: string;
  readonly orderItemReference: string;
  /** The chosen dishes of a combo this tap finishes; null: the whole work item. */
  readonly optionReferences: readonly string[] | null;
}
export interface KitchenWorkStepBody {
  readonly step: KitchenWorkStepKind;
  readonly storeReference: string;
  readonly correlationReference: string;
  readonly lines: readonly KitchenWorkStepLine[];
}
export interface KitchenWorkStepLineResult {
  readonly workItemReference: string;
  readonly orderItemReference: string;
  readonly ticketReference: string;
  readonly outcome: KitchenWorkStepOutcome;
  readonly refusedReason: KitchenWorkStepRefusal | null;
  /** The state this line is in now; null when it could not be read (not found, not attempted). */
  readonly ticketVersion: string | null;
  readonly workItemVersion: string | null;
  readonly workItemStatus: "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled" | null;
  readonly completedQuantity: number | null;
  readonly requiredQuantity: number | null;
  readonly acceptedAt: string | null;
  readonly readyAt: string | null;
  /** A combo's chosen dishes the kitchen has finished so far; null for an ordinary dish. */
  readonly dishesDone: readonly string[] | null;
}
export interface KitchenWorkStepReply {
  readonly projectionName: typeof kitchenWorkLifecycleProjectionName;
  readonly projectionPending: true;
  readonly occurredAt: string;
  readonly lines: readonly KitchenWorkStepLineResult[];
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function invalid(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_INPUT_INVALID");
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) return invalid();
  return value;
}
function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(String(key))))
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result[field] = descriptor.value;
  }
  return result;
}
function parseLine(value: unknown, step: KitchenWorkStepKind): KitchenWorkStepLine {
  const raw = closed(value, [
    "idempotencyKey",
    "ticketReference",
    "workItemReference",
    "orderItemReference",
    "optionReferences",
  ]);
  let options: readonly string[] | null = null;
  if (raw.optionReferences !== null) {
    // Start applies to a whole work item; only Finish names chosen dishes.
    if (
      step !== "Finish" ||
      !Array.isArray(raw.optionReferences) ||
      raw.optionReferences.length < 1 ||
      raw.optionReferences.length > kitchenWorkStepMaxOptions
    )
      return invalid();
    options = Object.freeze(raw.optionReferences.map(reference));
    if (new Set(options).size !== options.length) return invalid();
  }
  return Object.freeze({
    idempotencyKey: reference(raw.idempotencyKey),
    ticketReference: reference(raw.ticketReference),
    workItemReference: reference(raw.workItemReference),
    orderItemReference: reference(raw.orderItemReference),
    optionReferences: options,
  });
}

/** The closed body of one tap; one line per work item. */
export function parseKitchenWorkStepBody(value: unknown): KitchenWorkStepBody {
  const raw = closed(value, ["step", "storeReference", "correlationReference", "lines"]);
  const step = raw.step;
  if (step !== "Start" && step !== "Finish") return invalid();
  if (
    !Array.isArray(raw.lines) ||
    raw.lines.length < 1 ||
    raw.lines.length > kitchenWorkStepMaxLines
  )
    return invalid();
  const lines = Object.freeze(raw.lines.map((line: unknown) => parseLine(line, step)));
  if (
    new Set(lines.map((line) => line.workItemReference)).size !== lines.length ||
    new Set(lines.map((line) => line.idempotencyKey)).size !== lines.length
  )
    return invalid();
  return Object.freeze({
    step,
    storeReference: reference(raw.storeReference),
    correlationReference: reference(raw.correlationReference),
    lines,
  });
}

/** The tap's lines in chunks: one ticket per chunk, in the tap's order of first mention. */
export function chunkKitchenWorkStepLines(
  lines: readonly KitchenWorkStepLine[],
  size: number = kitchenWorkStepChunkLines,
): readonly (readonly KitchenWorkStepLine[])[] {
  const byTicket = new Map<string, KitchenWorkStepLine[]>();
  for (const line of lines) {
    const group = byTicket.get(line.ticketReference);
    if (group) group.push(line);
    else byTicket.set(line.ticketReference, [line]);
  }
  const chunks: (readonly KitchenWorkStepLine[])[] = [];
  for (const group of byTicket.values())
    for (let start = 0; start < group.length; start += size)
      chunks.push(Object.freeze(group.slice(start, start + size)));
  return Object.freeze(chunks);
}

/** A line nothing was done for, because an earlier chunk of the tap failed. */
export function kitchenWorkStepNotAttempted(line: KitchenWorkStepLine): KitchenWorkStepLineResult {
  return Object.freeze({
    workItemReference: line.workItemReference,
    orderItemReference: line.orderItemReference,
    ticketReference: line.ticketReference,
    outcome: "NotAttempted",
    refusedReason: null,
    ticketVersion: null,
    workItemVersion: null,
    workItemStatus: null,
    completedQuantity: null,
    requiredQuantity: null,
    acceptedAt: null,
    readyAt: null,
    dishesDone: null,
  });
}
