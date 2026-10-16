/** WP-2423: "Serve all ready items" for a round or a table (POST /merchant/dining/serve-ready). */
export const DINING_SERVE_READY_MAX_LINES = 100;
export interface DiningServeReadyLine {
  readonly orderItemReference: string;
  readonly quantity: number;
  readonly expectedItemServiceVersion: number;
}
export interface DiningServeReadyCommand {
  readonly operationReference: string;
  readonly orderReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedSessionVersion: number;
  readonly expectedTableAssignmentVersion: number;
  readonly lines: readonly DiningServeReadyLine[];
}
export type DiningServeReadyOutcome = "Served" | "AlreadyServed" | "Changed" | "Failed";
export interface DiningServeReadyResult {
  readonly served: number;
  readonly alreadyServed: number;
  readonly changed: number;
  readonly failed: number;
  readonly lines: readonly {
    readonly orderItemReference: string;
    readonly outcome: DiningServeReadyOutcome;
  }[];
}
export class DiningServeReadyClientError extends Error {
  constructor(readonly code: "PermissionDenied" | "NotAvailable" | "OutcomeUnknown") {
    super("Serving could not be confirmed");
    this.name = "DiningServeReadyClientError";
  }
}
const invalid = (): never => {
  throw new DiningServeReadyClientError("NotAvailable");
};
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const outcomes: readonly DiningServeReadyOutcome[] = [
  "Served",
  "AlreadyServed",
  "Changed",
  "Failed",
];
const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function commandSnapshot(command: DiningServeReadyCommand): DiningServeReadyCommand {
  if (
    !command ||
    typeof command !== "object" ||
    ![command.operationReference, command.orderReference].every(
      (value) => typeof value === "string" && reference.test(value),
    ) ||
    !integer(command.expectedOrderVersion, 1, 2147483646) ||
    !integer(command.expectedSessionVersion, 1, 2147483646) ||
    !integer(command.expectedTableAssignmentVersion, 1, 2147483646) ||
    !Array.isArray(command.lines) ||
    command.lines.length < 1 ||
    command.lines.length > DINING_SERVE_READY_MAX_LINES
  )
    return invalid();
  const seen = new Set<string>();
  const lines = command.lines.map((line) => {
    if (
      !line ||
      typeof line.orderItemReference !== "string" ||
      !reference.test(line.orderItemReference) ||
      seen.has(line.orderItemReference) ||
      !integer(line.quantity, 1, 999) ||
      !integer(line.expectedItemServiceVersion, 0, 2147483646)
    )
      return invalid();
    seen.add(line.orderItemReference);
    return Object.freeze({
      orderItemReference: line.orderItemReference,
      quantity: line.quantity,
      expectedItemServiceVersion: line.expectedItemServiceVersion,
    });
  });
  return Object.freeze({
    operationReference: command.operationReference,
    orderReference: command.orderReference,
    expectedOrderVersion: command.expectedOrderVersion,
    expectedSessionVersion: command.expectedSessionVersion,
    expectedTableAssignmentVersion: command.expectedTableAssignmentVersion,
    lines: Object.freeze(lines),
  });
}

function parseResult(value: unknown, snapshot: DiningServeReadyCommand): DiningServeReadyResult {
  const unknown = () => {
    throw new DiningServeReadyClientError("OutcomeUnknown");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const data = value as Record<string, unknown>;
  if (data.operationReference !== snapshot.operationReference || !Array.isArray(data.lines))
    return unknown();
  const rows = data.lines as unknown[];
  if (rows.length !== snapshot.lines.length) return unknown();
  const lines = rows.map((row, index) => {
    const line = row as Record<string, unknown> | null;
    if (
      !line ||
      typeof line !== "object" ||
      line.orderItemReference !== snapshot.lines[index]?.orderItemReference ||
      !outcomes.includes(line.outcome as DiningServeReadyOutcome)
    )
      return unknown();
    return Object.freeze({
      orderItemReference: line.orderItemReference as string,
      outcome: line.outcome as DiningServeReadyOutcome,
    });
  });
  const count = (outcome: DiningServeReadyOutcome) =>
    lines.filter((line) => line.outcome === outcome).length;
  if (
    data.served !== count("Served") ||
    data.alreadyServed !== count("AlreadyServed") ||
    data.changed !== count("Changed") ||
    data.failed !== count("Failed")
  )
    return unknown();
  return Object.freeze({
    served: count("Served"),
    alreadyServed: count("AlreadyServed"),
    changed: count("Changed"),
    failed: count("Failed"),
    lines: Object.freeze(lines),
  });
}

/**
 * One immutable request per staff intent. A lost or unknown answer is retried with the same body
 * (same operation reference), and the server replays each line's own serve operation, so nothing
 * is ever served twice.
 */
export function createDiningServeReadyClient(fetcher: typeof fetch = fetch) {
  return Object.freeze({
    prepare(command: DiningServeReadyCommand) {
      const snapshot = commandSnapshot(command);
      const body = JSON.stringify(snapshot);
      return Object.freeze({
        lineCount: snapshot.lines.length,
        async execute(csrf: string, signal?: AbortSignal): Promise<DiningServeReadyResult> {
          if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted)
            return invalid();
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          // Each line is its own transaction on the server; a full table takes a while.
          const timeout = setTimeout(abort, 120000);
          try {
            const response = await fetcher("/merchant/dining/serve-ready", {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: controller.signal,
              body,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": csrf,
              },
            });
            if (controller.signal.aborted) throw new DiningServeReadyClientError("OutcomeUnknown");
            if (response.status === 401 || response.status === 403)
              throw new DiningServeReadyClientError("PermissionDenied");
            if (response.status === 400 || response.status === 404)
              throw new DiningServeReadyClientError("NotAvailable");
            if (
              !response.ok ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
            )
              throw new DiningServeReadyClientError("OutcomeUnknown");
            const text = await response.text();
            if (controller.signal.aborted || text.length > 64000)
              throw new DiningServeReadyClientError("OutcomeUnknown");
            return parseResult(JSON.parse(text), snapshot);
          } catch (error) {
            if (error instanceof DiningServeReadyClientError) throw error;
            throw new DiningServeReadyClientError("OutcomeUnknown");
          } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  });
}
